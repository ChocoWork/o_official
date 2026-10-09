import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  composeOrderEmail,
  loadOrderEmailMaterial,
  type OrderEmailMaterial,
} from '@/lib/orders/email/order-email-compose';
import {
  checkOrderEmailSendConfig,
  isLocalOrderEmailDatabase,
  sendOrderEmailMessage,
  type OrderEmailMessage,
  type OrderEmailSendFailure,
  type OrderEmailSendOutcome,
} from '@/lib/orders/email/order-email-sender';
import {
  claimOrderEmail,
  completeOrderEmail,
  failOrderEmail,
  pauseOrderEmailSending,
  saveOrderEmailContent,
  skipOrderEmail,
  OrderEmailStoreError,
  type ClaimedOrderEmail,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import type { OrderEmailPauseReason, OrderEmailSkipReason } from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの worker（グループ D 設計書 4 章）。
 * 1行ずつ担当の印を付けて取り出し、取りやめを判定し、最初の時だけ中身を作って控えてから送る。
 * 毎分の定期処理（Stripe の知らせの worker の続き）と、行を書いた窓口の after() から動く。
 */
export const ORDER_EMAIL_WORKER_BUDGET_MS = 10_000;
export const ORDER_EMAIL_LEASE_SECONDS = 300;

export type OrderEmailWorkerDeps = {
  store: OrderEmailStore;
  loadMaterial: (orderId: string) => Promise<OrderEmailMaterial | null>;
  send: (message: OrderEmailMessage) => Promise<OrderEmailSendOutcome>;
  checkConfig: () => OrderEmailPauseReason | null;
  now: () => number;
  budgetMs: number;
};

export type OrderEmailWorkerResult = {
  sent: number;
  skipped: number;
  failed: number;
  stoppedBy: 'empty' | 'budget' | 'paused' | 'claim_error' | 'disabled';
};

export type OrderEmailWorkerEnv = {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
};

/**
 * worker を動かさない環境なら理由を返す。送る予定の表と一時停止は DB 全体で1つなので、
 * 本番の DB の行をほかの環境が取り出したり、一時停止を書いたりしないようにする。
 * - Vercel の preview・development の公開（VERCEL_ENV が production でない）
 * - 普段の開発（next dev）で、DB が手元の Supabase でない時（送り手が必ず手元のメール受けになり、お客様に届かないまま送信済みになる）
 */
export function orderEmailWorkerDisabledReason(
  env: OrderEmailWorkerEnv = process.env,
): 'non_production_deployment' | 'development_shared_database' | null {
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'production') return 'non_production_deployment';
  if (env.NODE_ENV === 'development' && !isLocalOrderEmailDatabase(env)) return 'development_shared_database';
  return null;
}

type DeliverOutcome = 'sent' | 'skipped' | 'failed' | 'paused';

/** DB の断りは短い記号だけを足す。例外の文や DB の詳しい説明はログに出さない。 */
function errorDetails(error: unknown): string[] {
  const name = error instanceof Error ? error.name : 'UnknownError';
  return error instanceof OrderEmailStoreError && error.code ? [name, error.code] : [name];
}

/** 送る前に取りやめにする理由（設計書 4-1）。送ってよければ null */
export function skipReasonFor(
  claim: Pick<ClaimedOrderEmail, 'kind'>,
  material: OrderEmailMaterial,
): OrderEmailSkipReason | null {
  if (!material.order.shipping_email?.trim()) return 'no_recipient';
  if (claim.kind === 'awaiting_payment' && material.order.status !== 'pending') return 'superseded';
  if (claim.kind === 'payment_expired' && (material.order.status === 'paid' || material.order.status === 'shipped')) {
    return 'superseded';
  }
  return null;
}

async function recordFailure(
  deps: OrderEmailWorkerDeps,
  claim: ClaimedOrderEmail,
  failure: OrderEmailSendFailure,
): Promise<DeliverOutcome> {
  try {
    await failOrderEmail(deps.store, claim, failure);
  } catch (error) {
    // 記録できなくても、担当の期限が切れた後に1回の失敗として数え直される
    console.error('[order-email-worker] failed to record failure', claim.id, failure.code, ...errorDetails(error));
  }
  return failure.category === 'config' ? 'paused' : 'failed';
}

async function deliver(deps: OrderEmailWorkerDeps, claim: ClaimedOrderEmail): Promise<DeliverOutcome> {
  let material: OrderEmailMaterial | null;
  try {
    material = await deps.loadMaterial(claim.orderId);
  } catch {
    return recordFailure(deps, claim, { category: 'transient', code: 'db_unavailable', retryAfterSeconds: null });
  }
  if (!material) {
    return recordFailure(deps, claim, { category: 'permanent', code: 'source_missing', retryAfterSeconds: null });
  }

  const skip = skipReasonFor(claim, material);
  if (skip) {
    try {
      await skipOrderEmail(deps.store, claim, skip);
    } catch (error) {
      console.error('[order-email-worker] failed to record skip', claim.id, skip, ...errorDetails(error));
    }
    return 'skipped';
  }

  let content = claim.subject !== null && claim.bodyText !== null ? { subject: claim.subject, text: claim.bodyText } : null;
  if (!content) {
    const composed = composeOrderEmail(material, {
      kind: claim.kind,
      variant: claim.variant,
      paymentExpiredSent: claim.paymentExpiredSent,
    });
    if (!composed) {
      return recordFailure(deps, claim, { category: 'permanent', code: 'source_missing', retryAfterSeconds: null });
    }
    // 控えられないまま送ると、やり直しの中身が変わって重複防止キーが使えなくなる。送らずにやり直す
    let saved: boolean;
    try {
      saved = await saveOrderEmailContent(deps.store, claim, composed);
    } catch {
      return recordFailure(deps, claim, { category: 'transient', code: 'db_unavailable', retryAfterSeconds: null });
    }
    if (!saved) {
      // 担当の期限が切れて、別の worker が取り直した。こちらは送らない
      console.warn('[order-email-worker] lease lost', claim.id);
      return 'failed';
    }
    content = composed;
  }

  const outcome = await deps.send({
    to: (material.order.shipping_email as string).trim(),
    subject: content.subject,
    text: content.text,
    idempotencyKey: `order-email/${claim.id}`,
  });
  if (!outcome.ok) {
    return recordFailure(deps, claim, outcome.failure);
  }

  try {
    const completed = await completeOrderEmail(deps.store, claim, outcome.providerMessageId);
    if (!completed) console.warn('[order-email-worker] lease lost', claim.id);
  } catch (error) {
    // 送れている。担当の期限の後に同じ中身・同じ鍵で送り直し、Resend が2通目を送らずに受け付けを返す
    console.error('[order-email-worker] failed to record sent', claim.id, ...errorDetails(error));
  }
  return 'sent';
}

export async function processOrderEmails(deps: OrderEmailWorkerDeps): Promise<OrderEmailWorkerResult> {
  const startedAt = deps.now();
  const result: OrderEmailWorkerResult = { sent: 0, skipped: 0, failed: 0, stoppedBy: 'budget' };

  const configError = deps.checkConfig();
  if (configError) {
    try {
      await pauseOrderEmailSending(deps.store, configError);
    } catch (error) {
      console.error('[order-email-worker] failed to pause sending', configError, ...errorDetails(error));
    }
    return { ...result, stoppedBy: 'paused' };
  }

  while (deps.now() - startedAt < deps.budgetMs) {
    let claim: ClaimedOrderEmail | null;
    try {
      claim = await claimOrderEmail(deps.store, ORDER_EMAIL_LEASE_SECONDS);
    } catch (error) {
      console.error('[order-email-worker] claim failed', ...errorDetails(error));
      return { ...result, stoppedBy: 'claim_error' };
    }
    if (!claim) return { ...result, stoppedBy: 'empty' };

    const outcome = await deliver(deps, claim);
    if (outcome === 'sent') result.sent += 1;
    else if (outcome === 'skipped') result.skipped += 1;
    else result.failed += 1;
    if (outcome === 'paused') return { ...result, stoppedBy: 'paused' };
  }

  return result;
}

/** 本物の依存で1回動かす */
export async function runOrderEmailWorker(options: { budgetMs?: number } = {}): Promise<OrderEmailWorkerResult> {
  const disabledReason = orderEmailWorkerDisabledReason();
  if (disabledReason) {
    console.warn('[order-email-worker] skipped', disabledReason);
    return { sent: 0, skipped: 0, failed: 0, stoppedBy: 'disabled' };
  }
  const client = await createServiceRoleClient();
  return processOrderEmails({
    store: client as unknown as OrderEmailStore,
    loadMaterial: (orderId) => loadOrderEmailMaterial(client, orderId),
    send: (message) => sendOrderEmailMessage(message),
    checkConfig: () => checkOrderEmailSendConfig(),
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? ORDER_EMAIL_WORKER_BUDGET_MS,
  });
}
