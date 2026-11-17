import { createHash } from 'node:crypto';
import {
  claimPasskeyNotification,
  completePasskeyNotification,
  failPasskeyNotification,
  passkeyNotificationRecipients,
  skipPasskeyNotification,
  type ClaimedPasskeyNotification,
  type PasskeyNotificationRecipient,
} from '@/lib/auth/passkey-notification-store';
import { composePasskeyNotification } from '@/lib/auth/passkey-notification-compose';
import type { RpcResult } from '@/lib/auth/passkey-approval-rpc';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { checkSiteUrlForEmail } from '@/lib/site-url-guard';
import { getOrderEmailSendState, type OrderEmailStore } from '@/lib/orders/email/order-email-store';
import { orderEmailWorkerDisabledReason } from '@/lib/orders/email/order-email-worker';
import {
  checkOrderEmailSendConfig,
  sendOrderEmailMessage,
  type OrderEmailMessage,
  type OrderEmailSendOutcome,
} from '@/lib/orders/email/order-email-sender';

/**
 * パスキーの知らせの worker。行を1つずつ取り出し、宛先ごとに文面を作って、注文のメールの送り手で送る。
 * 毎分の定期処理（`process-stripe-webhooks`）の中の1段として動く。ログに宛先のアドレス・本文・鍵の名前を出さない。
 */
export const PASSKEY_NOTIFICATION_BUDGET_MS = 3_000;
export const PASSKEY_NOTIFICATION_MAX_ROWS = 20;
export const PASSKEY_NOTIFICATION_LEASE_SECONDS = 300;
/** DB が `dead` にする試行の回数（`fail_passkey_notification` と同じ） */
const MAX_ATTEMPTS = 9;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

export type PasskeyNotificationWorkerDeps = {
  claim: (leaseSeconds: number) => Promise<RpcResult<ClaimedPasskeyNotification | null>>;
  recipients: (id: string) => Promise<RpcResult<PasskeyNotificationRecipient[]>>;
  complete: (id: string, leaseToken: string) => Promise<RpcResult<boolean>>;
  fail: (id: string, leaseToken: string, errorCode: string, retryAfterSeconds: number, countAttempt?: boolean) => Promise<RpcResult<boolean>>;
  skip: (id: string, leaseToken: string, reason: string) => Promise<RpcResult<boolean>>;
  send: (message: OrderEmailMessage) => Promise<OrderEmailSendOutcome>;
  /**
   * 注文のメールの送信の一時停止（上限・鍵・送り元の失敗で止めた。共有）の間なら true。読めなければ false。
   * 注文のメールの取り出しが毎分、次に試す時刻を先へ進めるので、時刻は見ない。止まっている間は、この worker が自分で1行だけ試す。
   */
  sendPaused: () => Promise<boolean>;
  disabledReason: () => string | null;
  checkConfig: () => string | null;
  /** メールに入れるお問い合わせの住所。サイトの住所が使えなければ null */
  contactUrl: () => string | null;
  now: () => number;
};

export type PasskeyNotificationWorkerResult = {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  skipped: number;
  stopped: 'idle' | 'budget' | 'config' | 'disabled' | 'claim_error';
};

const realDeps: PasskeyNotificationWorkerDeps = {
  claim: claimPasskeyNotification,
  recipients: passkeyNotificationRecipients,
  complete: completePasskeyNotification,
  fail: failPasskeyNotification,
  skip: skipPasskeyNotification,
  send: (message) => sendOrderEmailMessage(message),
  sendPaused: async () => {
    try {
      const store = (await createServiceRoleClient()) as unknown as OrderEmailStore;
      const state = await getOrderEmailSendState(store);
      return state.paused;
    } catch {
      return false;
    }
  },
  disabledReason: () => orderEmailWorkerDisabledReason(),
  checkConfig: () => checkOrderEmailSendConfig(),
  contactUrl: () => {
    const site = checkSiteUrlForEmail();
    return site.ok ? `${site.origin.replace(/\/+$/, '')}/contact` : null;
  },
  now: () => Date.now(),
};

/**
 * 宛先ごとの重複防止の鍵。行ごと・宛先ごとに固定なので、再試行しても同じ宛先に2通目が出ない（Resend の24時間の中）。
 *
 * @impl IMPL-AUTH-337
 * @design DD-AUTH-067
 */
export function passkeyNotificationIdempotencyKey(id: string, email: string): string {
  const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
  return `passkey-notification/${id}/${digest}`;
}

function safeCode(code: string): string {
  return ERROR_CODE_PATTERN.test(code) ? code : 'send_failed';
}

type RowOutcome = 'sent' | 'retried' | 'dead' | 'skipped' | 'config';

/**
 * 1行を送る。宛先を1つずつ送り、一時的な失敗があれば残りも試してから `fail`、恒久の失敗の宛先は飛ばす。
 * 担当の印が合わない（期限切れで別の担当が取り直した）時は、DB が行を変えず、呼び手は次へ進む。
 */
async function deliverRow(
  deps: PasskeyNotificationWorkerDeps,
  claim: ClaimedPasskeyNotification,
  contactUrl: string,
  deadline: number,
): Promise<RowOutcome> {
  const failRow = async (code: string, retryAfterSeconds: number): Promise<RowOutcome> => {
    await deps.fail(claim.id, claim.leaseToken, safeCode(code), retryAfterSeconds);
    return claim.attempts >= MAX_ATTEMPTS ? 'dead' : 'retried';
  };

  const listed = await deps.recipients(claim.id);
  if (!listed.ok) return failRow('db_unavailable', 0);
  if (listed.value.length === 0) {
    await deps.skip(claim.id, claim.leaseToken, 'no_recipient');
    return 'skipped';
  }

  let delivered = 0;
  let firstTransientCode: string | null = null;
  let maxRetryAfter = 0;
  for (const recipient of listed.value) {
    if (deps.now() >= deadline) return failRow(firstTransientCode ?? 'budget_exceeded', maxRetryAfter);
    let message: OrderEmailMessage;
    try {
      const { subject, text } = composePasskeyNotification({
        kind: claim.kind,
        audience: recipient.audience,
        friendlyName: claim.friendlyName,
        occurredAt: new Date(claim.occurredAt),
        subjectEmail: claim.subjectEmail,
        contactUrl,
      });
      message = {
        to: recipient.email,
        subject,
        text,
        idempotencyKey: passkeyNotificationIdempotencyKey(claim.id, recipient.email),
      };
    } catch {
      return failRow('compose_error', 0);
    }
    const outcome = await deps.send(message);
    if (outcome.ok) {
      delivered += 1;
      continue;
    }
    const { category, code, retryAfterSeconds } = outcome.failure;
    if (category === 'config') {
      // 注文のメールと同じ: この行の失敗として数えず（attempts を戻す）。共有の送信の一時停止は、DB の関数が同じ取引で書く
      await deps.fail(claim.id, claim.leaseToken, safeCode(code), retryAfterSeconds ?? 900, false);
      return 'config';
    }
    if (category === 'permanent') continue;
    firstTransientCode ??= code;
    maxRetryAfter = Math.max(maxRetryAfter, retryAfterSeconds ?? 0);
  }

  if (firstTransientCode !== null) return failRow(firstTransientCode, maxRetryAfter);
  if (delivered === 0) {
    // 1通も送れず、全部が恒久の失敗: 送れたことにしない（complete は共有の送信の一時停止を解くため）
    await deps.skip(claim.id, claim.leaseToken, 'all_recipients_permanent');
    return 'skipped';
  }
  const completed = await deps.complete(claim.id, claim.leaseToken);
  if (!completed.ok || !completed.value) console.warn('[passkey-notification-worker] lease lost or complete failed', claim.id);
  return 'sent';
}

/**
 * 知らせの worker を1回動かす。止める環境・設定が無い時は何も取らない。予算か最大行数で止まる。例外は握る。
 *
 * @impl IMPL-AUTH-338
 * @design DD-AUTH-067
 */
export async function runPasskeyNotificationWorker(
  options: { budgetMs?: number; maxRows?: number; deps?: Partial<PasskeyNotificationWorkerDeps> } = {},
): Promise<PasskeyNotificationWorkerResult> {
  const deps: PasskeyNotificationWorkerDeps = { ...realDeps, ...options.deps };
  const budgetMs = options.budgetMs ?? PASSKEY_NOTIFICATION_BUDGET_MS;
  const maxRows = options.maxRows ?? PASSKEY_NOTIFICATION_MAX_ROWS;
  const result: PasskeyNotificationWorkerResult = { claimed: 0, sent: 0, retried: 0, dead: 0, skipped: 0, stopped: 'budget' };

  const disabled = deps.disabledReason();
  if (disabled) {
    console.warn('[passkey-notification-worker] skipped', disabled);
    return { ...result, stopped: 'disabled' };
  }
  const contactUrl = deps.contactUrl();
  if (deps.checkConfig() !== null || contactUrl === null) {
    console.warn('[passkey-notification-worker] send config is not ready');
    return { ...result, stopped: 'config' };
  }

  // 共有の一時停止の間は、注文のメールの試しの時刻に関わらず、1回に1行だけ試す（間は、失敗した行の次の時刻が決める）。送れれば DB が一時停止を解く
  const rowLimit = (await deps.sendPaused()) ? Math.min(maxRows, 1) : maxRows;

  const deadline = deps.now() + budgetMs;
  while (result.claimed < rowLimit && deps.now() < deadline) {
    const claimed = await deps.claim(PASSKEY_NOTIFICATION_LEASE_SECONDS).catch(() => ({ ok: false as const }));
    if (!claimed.ok) return { ...result, stopped: 'claim_error' };
    if (claimed.value === null) return { ...result, stopped: 'idle' };
    result.claimed += 1;

    let outcome: RowOutcome;
    try {
      outcome = await deliverRow(deps, claimed.value, contactUrl, deadline);
    } catch {
      // 記録できなくても、担当の期限が切れた後に取り直される
      console.error('[passkey-notification-worker] row failed unexpectedly', claimed.value.id);
      continue;
    }
    if (outcome === 'config') return { ...result, stopped: 'config' };
    if (outcome === 'sent') result.sent += 1;
    else if (outcome === 'retried') result.retried += 1;
    else if (outcome === 'dead') result.dead += 1;
    else result.skipped += 1;
  }
  return result;
}
