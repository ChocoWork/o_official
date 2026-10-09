import { Resend } from 'resend';
import { resolveMailProvider } from '@/lib/mail';
import { readHeartbeats, recordHeartbeat, type OpsStore } from '@/lib/ops/ops-store';
import {
  listOrderEmailsAwaitingDelivery,
  recordOrderEmailDelivery,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import type { OrderEmailDeliveryStatus } from '@/lib/orders/email/order-email-types';
import { orderEmailWorkerDisabledReason } from '@/lib/orders/email/order-email-worker';

/**
 * 注文のメールの配達の状態（グループ D 設計書 6 章）。
 * Resend の知らせ（Webhook）を読み取り、受け口の登録前や長い停止の取りこぼしを1時間ごとの見回りで拾う。
 */
export const MAX_DELIVERY_WEBHOOK_BYTES = 64 * 1024;
export const DELIVERY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const DELIVERY_CHECK_LIMIT = 50;

// Object の名前（constructor など）を種類と取り違えないよう Map で持つ
const EVENT_TYPES = new Map<string, OrderEmailDeliveryStatus>([
  ['email.delivered', 'delivered'],
  ['email.delivery_delayed', 'delayed'],
  ['email.bounced', 'bounced'],
  ['email.complained', 'complained'],
  ['email.suppressed', 'suppressed'],
  ['email.failed', 'failed'],
]);

const LAST_EVENTS = new Map<string, OrderEmailDeliveryStatus>([
  ['delivered', 'delivered'],
  ['delivery_delayed', 'delayed'],
  ['bounced', 'bounced'],
  ['complained', 'complained'],
  ['suppressed', 'suppressed'],
  ['failed', 'failed'],
]);

const KEY_ERRORS = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'suspended_api_key']);

export type ParsedDeliveryEvent =
  | { kind: 'delivery'; status: OrderEmailDeliveryStatus; providerMessageId: string; eventAt: Date }
  | { kind: 'ignored' }
  | { kind: 'invalid' };

/** Resend の知らせの本文を読む。時刻は知らせの created_at（順番が前後しても新しい方を残すため） */
export function parseDeliveryEvent(payload: unknown): ParsedDeliveryEvent {
  if (!payload || typeof payload !== 'object') return { kind: 'invalid' };
  const { type, created_at: createdAt, data } = payload as { type?: unknown; created_at?: unknown; data?: unknown };
  if (typeof type !== 'string') return { kind: 'invalid' };
  const status = EVENT_TYPES.get(type);
  if (!status) return { kind: 'ignored' };

  const emailId = data && typeof data === 'object' ? (data as { email_id?: unknown }).email_id : undefined;
  if (typeof emailId !== 'string' || emailId.length < 1 || emailId.length > 200) return { kind: 'invalid' };
  const eventAt = typeof createdAt === 'string' ? new Date(createdAt) : null;
  if (!eventAt || Number.isNaN(eventAt.getTime())) return { kind: 'invalid' };

  return { kind: 'delivery', status, providerMessageId: emailId, eventAt };
}

export type LastEventResult = { ok: true; status: OrderEmailDeliveryStatus | null } | { ok: false; configError: boolean };
export type LastEventReader = (providerMessageId: string) => Promise<LastEventResult>;

/** Resend の API でメールの最後の状態を読む。送信専用の鍵では読めない（restricted_api_key） */
export function createResendLastEventReader(apiKey: string): LastEventReader {
  const resend = new Resend(apiKey);
  return async (providerMessageId) => {
    try {
      const { data, error } = await resend.emails.get(providerMessageId);
      if (error) return { ok: false, configError: KEY_ERRORS.has(error.name) };
      return { ok: true, status: LAST_EVENTS.get(data?.last_event ?? '') ?? null };
    } catch {
      return { ok: false, configError: false };
    }
  };
}

export async function checkOrderEmailDeliveries(deps: {
  store: OrderEmailStore;
  readLastEvent: LastEventReader;
  now: () => Date;
  limit: number;
}): Promise<{ checked: number; updated: number; failed: number; configError: boolean }> {
  const result = { checked: 0, updated: 0, failed: 0, configError: false };
  for (const email of await listOrderEmailsAwaitingDelivery(deps.store, deps.limit)) {
    const read = await deps.readLastEvent(email.providerMessageId);
    if (!read.ok) {
      if (read.configError) return { ...result, configError: true };
      result.failed += 1;
      continue;
    }
    result.checked += 1;
    if (!read.status) continue;
    // 見回りの時刻で記録する。これより古い知らせが後から届いても、記録を戻さない
    const recorded = await recordOrderEmailDelivery(deps.store, {
      svixId: null,
      providerMessageId: email.providerMessageId,
      status: read.status,
      eventAt: deps.now(),
    });
    if (recorded === 'updated') result.updated += 1;
  }
  return result;
}

/**
 * 毎分の worker から呼ぶ。送り手が Resend の時だけ、最後に動いてから1時間たっていれば動く（本計画 P13）。
 * 注文のメールの worker と同じ環境の門を最初に通す。止める環境（Vercel の preview、本番の DB につないだ next dev）では、
 * DB にも Resend にも触れず、最後の記録も書かない。本番の記録を、開発や preview が上書きしないため。
 */
export async function runOrderEmailDeliveryCheckIfDue(
  store: OpsStore & OrderEmailStore,
  options: { env?: Record<string, string | undefined>; now?: () => Date; readLastEvent?: LastEventReader } = {},
): Promise<'skipped' | 'not_due' | 'done' | 'failed'> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  const disabledReason = orderEmailWorkerDisabledReason(env);
  if (disabledReason) {
    console.warn('[order-email-delivery] skipped', disabledReason);
    return 'skipped';
  }

  let provider: string;
  try {
    provider = resolveMailProvider(env);
  } catch {
    return 'skipped';
  }
  const apiKey = env.RESEND_API_KEY?.trim();
  if (provider !== 'resend' || !apiKey) return 'skipped';

  const job = (await readHeartbeats(store)).order_email_delivery_check;
  const lastRunAt = Math.max(job?.lastSucceededAt?.getTime() ?? 0, job?.lastFailedAt?.getTime() ?? 0);
  if (lastRunAt > 0 && now().getTime() - lastRunAt < DELIVERY_CHECK_INTERVAL_MS) return 'not_due';

  try {
    const result = await checkOrderEmailDeliveries({
      store,
      readLastEvent: options.readLastEvent ?? createResendLastEventReader(apiKey),
      now,
      limit: DELIVERY_CHECK_LIMIT,
    });
    await recordHeartbeat(store, 'order_email_delivery_check', !result.configError, result.configError ? 'config_api_key' : null);
    return result.configError ? 'failed' : 'done';
  } catch {
    await recordHeartbeat(store, 'order_email_delivery_check', false, 'db_unavailable').catch(() => undefined);
    return 'failed';
  }
}
