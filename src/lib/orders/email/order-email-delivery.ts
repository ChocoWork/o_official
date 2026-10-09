import { randomInt } from 'node:crypto';
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
/** 見回り1回に使う時間。毎分の worker の maxDuration（60秒）の中で、点検の後に動くので短くする */
export const DELIVERY_CHECK_BUDGET_MS = 8_000;
/** Resend の API の回数の制限（既定で毎秒2回。お客様へのメールの送信と共有）を超えないよう、読む間を空ける */
export const DELIVERY_CHECK_READ_INTERVAL_MS = 1_000;
/** 1件の読み取りを待つ時間。返事が来なければ、その回の見回りをそこでやめる */
export const DELIVERY_CHECK_READ_TIMEOUT_MS = 5_000;

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
  // 開封とクリックは届いた後にしか起きない。開封の追跡が有効な時、見回りの前に開かれたメールを「状態なし」のまま読み直し続けないため
  ['opened', 'delivered'],
  ['clicked', 'delivered'],
]);

const KEY_ERRORS = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'suspended_api_key']);

// 少し待てば読める見込みの失敗。application_error は SDK が通信の失敗を返す時の名前
const RETRYABLE_ERRORS = new Set(['rate_limit_exceeded', 'application_error', 'internal_server_error']);

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

/**
 * 読み取りの結果。失敗は3つに分ける。
 * - configError: 鍵の問題。全部のメールに効くので、その回をやめて設定の問題として記録する
 * - retryable: 少し待てば読める見込みの失敗（回数の制限・Resend 側の不調・通信・時間切れ）。その回をやめ、次の1時間に回す
 * - どちらでもない: そのメールだけの失敗（not_found など）。次のメールへ進む
 */
export type LastEventResult =
  | { ok: true; status: OrderEmailDeliveryStatus | null }
  | { ok: false; configError: boolean; retryable: boolean };
export type LastEventReader = (providerMessageId: string) => Promise<LastEventResult>;

function classifyReadError(error: { name?: string | null; statusCode?: number | null }): { configError: boolean; retryable: boolean } {
  const name = error.name ?? '';
  if (KEY_ERRORS.has(name)) return { configError: true, retryable: false };
  const status = error.statusCode ?? null;
  // statusCode が無い失敗は、SDK が通信の失敗を返したもの。429 は名前が違っても回数の制限として扱う
  return { configError: false, retryable: RETRYABLE_ERRORS.has(name) || status === null || status === 429 || status >= 500 };
}

/**
 * 1件の読み取りを打ち切る（order-email-sender.ts の送信の打ち切りと同じ形）。通信自体は中断できない。
 * race が遅れて返る成功・失敗も受け取るので、打ち切った後の失敗が unhandled rejection にならない。
 */
async function withinReadTimeout<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('delivery check read timeout')), DELIVERY_CHECK_READ_TIMEOUT_MS);
    });
    return await Promise.race([read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resend の API でメールの最後の状態を読む。送信専用の鍵では読めない（restricted_api_key） */
export function createResendLastEventReader(apiKey: string): LastEventReader {
  const resend = new Resend(apiKey);
  return async (providerMessageId) => {
    try {
      const { data, error } = await withinReadTimeout(() => resend.emails.get(providerMessageId));
      if (error) return { ok: false, ...classifyReadError(error) };
      return { ok: true, status: LAST_EVENTS.get(data?.last_event ?? '') ?? null };
    } catch {
      // 通信の例外と時間切れ。例外の文はログにも結果にも残さない
      return { ok: false, configError: false, retryable: true };
    }
  };
}

/**
 * 古い順の先頭で状態の決まらないメールが、毎回の時間の上限を占めないようにする。
 * 守りの点検が Math.random を弱い乱数として止めるので、混ぜるだけでも node:crypto の randomInt を使う
 */
function shuffleEmails<T>(emails: T[]): T[] {
  const shuffled = [...emails];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

/**
 * 状態の決まっていないメールの最後の状態を Resend で読み、分かった状態を記録する（設計書 6-4）。
 * 全体の時間（budgetMs）と読む間隔（DELIVERY_CHECK_READ_INTERVAL_MS）に上限を付け、Resend の回数の制限を使い切らない。
 * 少し待てば読める見込みの失敗はその回をやめて次の1時間に回し、そのメールだけの失敗は次へ進む。
 * 古い順で取った対象を読む前に混ぜ、先頭の状態が決まらなくても後ろを読む機会を作る。
 * stoppedEarly は、全部を読み終える前にやめたこと（時間切れ・少し待てば読める見込みの失敗・鍵の問題）。
 */
export async function checkOrderEmailDeliveries(deps: {
  store: OrderEmailStore;
  readLastEvent: LastEventReader;
  now: () => Date;
  limit: number;
  budgetMs: number;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  shuffle?: (emails: Array<{ id: string; providerMessageId: string }>) => Array<{ id: string; providerMessageId: string }>;
}): Promise<{ checked: number; updated: number; failed: number; configError: boolean; stoppedEarly: boolean }> {
  const result = { checked: 0, updated: 0, failed: 0, configError: false, stoppedEarly: false };
  const startedAt = deps.nowMs();
  const emails = (deps.shuffle ?? shuffleEmails)(await listOrderEmailsAwaitingDelivery(deps.store, deps.limit));
  for (const [index, email] of emails.entries()) {
    // 2件目からは間を空ける。待った時間も予算に入る
    if (index > 0) await deps.sleep(DELIVERY_CHECK_READ_INTERVAL_MS);
    if (deps.nowMs() - startedAt >= deps.budgetMs) {
      result.stoppedEarly = true;
      break;
    }
    const read = await deps.readLastEvent(email.providerMessageId);
    if (!read.ok) {
      if (read.configError) return { ...result, configError: true, stoppedEarly: true };
      result.failed += 1;
      if (read.retryable) {
        result.stoppedEarly = true;
        break;
      }
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
 * 毎分の worker の最後から呼ぶ。送り手が Resend の時だけ、最後に動いてから1時間たっていれば動く（本計画 P13）。
 * 毎分の起動は maxDuration（60秒）の中で動くので、店への知らせの点検の後に置き、全体の時間・読む間隔・1件の待ち時間に上限を付ける。
 * 動き始めに最後の記録を書く。途中で打ち切られても、次の分にやり直さない（1時間に1回のまま）。
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

  // この回を始めたことを、読む前に記録する。書けない時は DB が使えないので、読まずにやめる（次の分にやり直す）
  try {
    await recordHeartbeat(store, 'order_email_delivery_check', true, null);
  } catch (error) {
    console.warn('[order-email-delivery] failed to start', error instanceof Error ? error.name : 'UnknownError');
    return 'failed';
  }

  try {
    const result = await checkOrderEmailDeliveries({
      store,
      readLastEvent: options.readLastEvent ?? createResendLastEventReader(apiKey),
      now,
      limit: DELIVERY_CHECK_LIMIT,
      budgetMs: DELIVERY_CHECK_BUDGET_MS,
      nowMs: () => Date.now(),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    });
    // 件数と印だけ。メールの番号・宛先・例外の文は出さない
    console.info('[order-email-delivery] checked', result.checked, result.updated, result.failed, result.stoppedEarly ? 'stopped_early' : 'complete');
    if (result.configError) {
      await recordHeartbeat(store, 'order_email_delivery_check', false, 'config_api_key');
      return 'failed';
    }
    // 読めた件数が0で失敗が1件以上なら、失敗の種類を問わず provider_unavailable を記録する。一部でも読めていれば始めの記録のままにする
    if (result.checked === 0 && result.failed > 0) {
      await recordHeartbeat(store, 'order_email_delivery_check', false, 'provider_unavailable');
      return 'failed';
    }
    return 'done';
  } catch {
    await recordHeartbeat(store, 'order_email_delivery_check', false, 'db_unavailable').catch(() => undefined);
    return 'failed';
  }
}
