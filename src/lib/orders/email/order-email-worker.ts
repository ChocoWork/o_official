import { createServiceRoleClient } from '@/lib/supabase/server';
import { loadDeliveryEmailMaterial } from '@/lib/orders/email/order-email-delivery-material';
import { loadOrderStatusEmailUrl } from '@/lib/orders/status/status-email';
import { recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import {
  composeOrderEmail,
  loadOrderEmailMaterial,
  loadRequestEmailMaterial,
  type OrderEmailMaterial,
} from '@/lib/orders/email/order-email-compose';
import {
  checkOrderEmailSendConfig,
  isLocalOrderEmailDatabase,
  sendOrderEmailMessage,
  shopAlertRecipient,
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
import {
  isRequestEmailKind,
  isDeliveryEmailKind,
  isShopEmailKind,
  type OrderEmailPauseReason,
  type OrderEmailSkipReason,
  type RequestEmailKind,
} from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの worker（グループ D 設計書 4 章）。
 * 1行ずつ担当の印を付けて取り出し、取りやめを判定し、最初の時だけ中身を作って控えてから送る。
 * 毎分の定期処理（Stripe の知らせの worker の続き）と、行を書いた窓口の after() から動く。
 */
export const ORDER_EMAIL_WORKER_BUDGET_MS = 10_000;
export const ORDER_EMAIL_LEASE_SECONDS = 300;

export type OrderEmailWorkerDeps = {
  store: OrderEmailStore;
  /**
   * 発送のメールの行は行の発送の番号で発送の材料を、返金のお知らせと支払い済みのキャンセルのお知らせの行は行の返金の番号で
   * 返金の材料を、返品のメールの行は行の返品・受け取りの番号で返品の材料を読む。ほかの種類は null
   * （グループ E-1 設計書 8-1、グループ E-2 設計書 8-6、グループ E-3 設計書 9 章）
   */
  loadMaterial: (
    orderId: string,
    fulfillmentId: string | null,
    refundId: string | null,
    returnId: string | null,
    returnReceiptId: string | null,
  ) => Promise<OrderEmailMaterial | null>;
  /**
   * 申し込みのメール6種類（返品の申し込み3つ・キャンセルの申し込み3つ）の行は、行の返品の番号かキャンセルの申し込みの番号で
   * 申し込みの材料を読む。ほかの種類は loadMaterial（グループ E-3 段2 計画 P12。返品の受付のお知らせと番号の組が同じなので、種類で読み分ける）
   */
  loadRequestMaterial: (
    orderId: string,
    kind: RequestEmailKind,
    returnId: string | null,
    cancelRequestId: string | null,
  ) => Promise<OrderEmailMaterial | null>;
  /** 店あてのメール（返金待ち・返品の申し込み・キャンセルの申し込み）の送り先（SHOP_ALERT_EMAIL）。無ければ null */
  shopRecipient: () => string | null;
  /** 配送メールは保存済み本文があっても必ず現在の版と状態を読む */
  loadDeliveryMaterial?: (claim: ClaimedOrderEmail) => Promise<OrderEmailMaterial | null>;
  /** 新しいお客様向け本文の「ご注文の状況はこちら」のURL。作れなければ null、DB の失敗は例外（E-5 P21） */
  loadStatusUrl: (orderId: string) => Promise<string | null>;
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

/**
 * メールの送り先。店あて（返金待ち・返品の申し込み・キャンセルの申し込みの店への知らせ）は店のアドレス（SHOP_ALERT_EMAIL）、ほかはお客様の宛先（注文の配送先のメール）。
 * 前後の空白を除き、無い・空白だけなら null。店への知らせは、お客様の宛先が空でも送る（お客様に送るメールではないため）
 */
export function recipientFor(
  claim: Pick<ClaimedOrderEmail, 'kind'>,
  material: OrderEmailMaterial,
  shopRecipient: string | null,
): string | null {
  const address = isShopEmailKind(claim.kind) ? shopRecipient : material.order.shipping_email;
  return address?.trim() || null;
}

/** 送る前に取りやめにする理由（設計書 4-1）。送ってよければ null */
export function skipReasonFor(
  claim: Pick<ClaimedOrderEmail, 'kind' | 'trackingVersion'>,
  material: OrderEmailMaterial,
  shopRecipient: string | null = null,
): OrderEmailSkipReason | null {
  if (isDeliveryEmailKind(claim.kind) && material.delivery) {
    const delivery = material.delivery;
    if (delivery.cancelled) return 'fulfillment_cancelled';
    // 発送の更新は直した事実を知らせるので、旧版でも送る。
    if (claim.kind !== 'shipping_update' && claim.trackingVersion !== delivery.currentTrackingVersion) return 'superseded';
    if (claim.kind === 'out_for_delivery' && delivery.deliveryStatus === 'delivered') return 'superseded';
  }
  if (!recipientFor(claim, material, shopRecipient)) return 'no_recipient';
  if (claim.kind === 'awaiting_payment' && material.order.status !== 'pending') return 'superseded';
  if (claim.kind === 'payment_expired' && (material.order.status === 'paid' || material.order.status === 'shipped')) {
    return 'superseded';
  }
  // 発送を取り消した後は、その発送のメールを送らない。送る前・やり直し待ちの行は取消の時に DB が取りやめるので、
  // ここで見るのは、取消の時に送っている途中だった行。控えた中身がある行も送らない（グループ E-1 設計書 7-3）
  if (claim.kind === 'shipped' && material.fulfillment?.cancelled) return 'fulfillment_cancelled';
  // 店への知らせ（返金待ち）は、予定を書いてから送るまでの間に店長が「額を決めて返金する」を済ませて、返金待ちの品が無くなったら、
  // もう知らせる事が無いので取りやめる。受け取りの材料そのものが無い時は、ここでは取りやめず、本文を作る所で材料の不足になる。
  // 理由は superseded（DB の skip_order_email が、返金待ちが0の返品の、店への知らせの行にだけ受ける）
  const receipt = material.orderReturn?.receipt;
  if (claim.kind === 'return_refund_pending_shop' && receipt && (receipt.pendingRefund?.items.length ?? 0) === 0) {
    return 'superseded';
  }
  // 返金のお知らせ・支払い済みのキャンセルのお知らせは、Stripe が返金を受け付けた時に予定が書かれ、送るのは後になる。
  // その間に返金が失敗・エラーになったら、お金が戻らないのに「返金します」と送ることになるので送らない（設計書 8-1・8-2）。
  // 返金の材料は返金の番号がある行（この2種類）だけが持つ。お客様への連絡は、店への要対応「返金の失敗」が受け持つ。
  // 理由は superseded（DB の skip_order_email が、返金が失敗・エラーの行にだけ受ける）
  if (material.refund && (material.refund.status === 'failed' || material.refund.status === 'error')) return 'superseded';
  // 申し込みのメール6種類（返品の申し込み・キャンセルの申し込み。グループ E-3 段2 計画 P12）は、注文がどの状態でも取りやめにしない。
  // 受けた事実・お断りした事実を、その時のまま伝えるメールで、後から状況が変わっても中身が変わらない。取りやめは宛先が無い時だけ（上の判定）
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
    // 配送3種類は現在の発送と版を読み直す。申し込み6種類は専用の記録、ほかは既存の材料を読む。
    material = isDeliveryEmailKind(claim.kind)
      ? await deps.loadDeliveryMaterial?.(claim) ?? null
      : isRequestEmailKind(claim.kind)
        ? await deps.loadRequestMaterial(claim.orderId, claim.kind, claim.returnId, claim.cancelRequestId)
        : await deps.loadMaterial(claim.orderId, claim.fulfillmentId, claim.refundId, claim.returnId, claim.returnReceiptId);
  } catch {
    return recordFailure(deps, claim, { category: 'transient', code: 'db_unavailable', retryAfterSeconds: null });
  }
  if (!material || (isDeliveryEmailKind(claim.kind) && !material.delivery)) {
    // 注文・明細のほか、発送のメールの発送の記録・返金のお知らせの返金の記録・返品のメールの返品の記録が無い時もここに入る
    // （グループ E-2 設計書 8-6、グループ E-3 設計書 9 章）。配送メールの材料不足は再試行し、既存DBの上限でdeadにする。
    return recordFailure(deps, claim, { category: isDeliveryEmailKind(claim.kind) ? 'transient' : 'permanent', code: 'source_missing', retryAfterSeconds: null });
  }

  const shopRecipient = deps.shopRecipient();
  const skip = skipReasonFor(claim, material, shopRecipient);
  if (skip) {
    if (skip === 'no_recipient' && isShopEmailKind(claim.kind)) {
      // 今の店への知らせと同じく、宛先の設定が無いことだけをログに出す（値は出さない）
      console.warn('[order-email-worker] SHOP_ALERT_EMAIL is not configured', claim.id);
    }
    try {
      await skipOrderEmail(deps.store, claim, skip);
    } catch (error) {
      console.error('[order-email-worker] failed to record skip', claim.id, skip, ...errorDetails(error));
    }
    return 'skipped';
  }

  let content = claim.subject !== null && claim.bodyText !== null ? { subject: claim.subject, text: claim.bodyText } : null;
  if (!content) {
    // 状況のリンクは、送ると決まった新しいお客様向けの本文を作る時だけ用意する（E-5 計画 P21）。
    // 保存済みの本文・店向けのメール・取りやめの行のためには用意せず、保存済みの本文を作り直さない。
    // URL が作れなければ（null）composer が作らず、下の材料不足（source_missing）に入る。DB の失敗は一時的な失敗としてやり直す
    let composeMaterial = material;
    if (!isShopEmailKind(claim.kind)) {
      try {
        composeMaterial = { ...material, orderStatusUrl: await deps.loadStatusUrl(claim.orderId) };
      } catch {
        return recordFailure(deps, claim, { category: 'transient', code: 'db_unavailable', retryAfterSeconds: null });
      }
    }
    const composed = composeOrderEmail(composeMaterial, {
      kind: claim.kind,
      variant: claim.variant,
      paymentExpiredSent: claim.paymentExpiredSent,
    });
    if (!composed) {
      return recordFailure(deps, claim, { category: isDeliveryEmailKind(claim.kind) ? 'transient' : 'permanent', code: 'source_missing', retryAfterSeconds: null });
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
    // 宛先が無ければ上の skipReasonFor で取りやめになっているので、ここでは必ずある
    to: recipientFor(claim, material, shopRecipient) as string,
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

/**
 * 本物の依存で1回動かし、最後の成功を記録する（取り出しに失敗したときだけ失敗）。
 * 止める環境（環境の門）では DB に触れず、最後の成功も書かない。本番の記録を、開発や preview が上書きして、
 * 止まった worker の知らせを隠さないため。
 */
export async function runOrderEmailWorker(options: { budgetMs?: number } = {}): Promise<OrderEmailWorkerResult> {
  const disabledReason = orderEmailWorkerDisabledReason();
  if (disabledReason) {
    console.warn('[order-email-worker] skipped', disabledReason);
    return { sent: 0, skipped: 0, failed: 0, stoppedBy: 'disabled' };
  }
  const client = await createServiceRoleClient();
  const store = client as unknown as OrderEmailStore & OpsStore;
  const result = await processOrderEmails({
    store,
    loadMaterial: (orderId, fulfillmentId, refundId, returnId, returnReceiptId) =>
      loadOrderEmailMaterial(client, orderId, fulfillmentId, refundId, returnId, returnReceiptId),
    loadRequestMaterial: (orderId, kind, returnId, cancelRequestId) =>
      loadRequestEmailMaterial(client, orderId, { kind, returnId, cancelRequestId }),
    loadDeliveryMaterial: (claim) => loadDeliveryEmailMaterial(client, claim),
    // 状況のリンクの準備は同じ service_role の client で行う
    loadStatusUrl: (orderId) => loadOrderStatusEmailUrl(client, orderId),
    shopRecipient: () => shopAlertRecipient(),
    send: (message) => sendOrderEmailMessage(message),
    checkConfig: () => checkOrderEmailSendConfig(),
    now: () => Date.now(),
    budgetMs: options.budgetMs ?? ORDER_EMAIL_WORKER_BUDGET_MS,
  });

  const claimFailed = result.stoppedBy === 'claim_error';
  try {
    await recordHeartbeat(store, 'order_email_worker', !claimFailed, claimFailed ? 'db_unavailable' : null);
  } catch (error) {
    // 記録できなくても結果は変えない。記録が古くなれば、点検が worker の停止として知らせる
    console.error('[order-email-worker] failed to record heartbeat', ...errorDetails(error));
  }
  return result;
}
