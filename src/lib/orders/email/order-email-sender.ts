import { Resend } from 'resend';
import { resolveMailProvider, type MailProvider } from '@/lib/mail';
import { sendMail as sendLocalMail } from '@/lib/mail/adapters/local';
import type {
  OrderEmailErrorCode,
  OrderEmailFailureCategory,
  OrderEmailPauseReason,
} from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールを送る（グループ D 設計書 4-4）。
 * Resend へは行の番号から作った重複防止キーを付ける（同じキーの送り直しは、24時間のうちは2通目にならない）。
 * 重複防止キーの無い送り手（SES）では送らない（OWASP Fail Securely）。E2E と開発は手元のメール受け（local）へ送る。
 */
export type OrderEmailMessage = { to: string; subject: string; text: string; idempotencyKey: string };

export type OrderEmailSendFailure = {
  category: OrderEmailFailureCategory;
  code: OrderEmailErrorCode;
  retryAfterSeconds: number | null;
};

export type OrderEmailSendOutcome =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; failure: OrderEmailSendFailure };

type Env = Record<string, string | undefined>;

/**
 * 返事のない送信で worker と後続の点検を止めないため、1回の待機を8秒で打ち切る。
 * Resend に届いていても、やり直しは同じ order-email/<行の ID> の鍵なので2通目にならない。
 * 前の要求がまだ処理中なら concurrent_idempotent_requests として一時的な失敗に分ける。
 */
export const ORDER_EMAIL_SEND_TIMEOUT_MS = 8_000;

const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

const CONFIG_KEY_ERRORS = new Set(['missing_api_key', 'invalid_api_key', 'restricted_api_key', 'suspended_api_key']);

const PERMANENT_ERRORS = new Set([
  'missing_required_field',
  'invalid_parameter',
  'invalid_attachment',
  'invalid_idempotency_key',
  'invalid_region',
  'invalid_access',
  'not_found',
  'method_not_allowed',
  'security_error',
]);

function providerOf(env: Env): MailProvider | null {
  try {
    return resolveMailProvider(env);
  } catch {
    return null;
  }
}

function failure(
  category: OrderEmailFailureCategory,
  code: OrderEmailErrorCode,
  retryAfterSeconds: number | null = null,
): OrderEmailSendFailure {
  return { category, code, retryAfterSeconds };
}

/** service_role の接続先と同じ順で読み、住所が無い・読めない場合は共有の DB として扱う。 */
export function isLocalOrderEmailDatabase(
  env: { SUPABASE_URL?: string; NEXT_PUBLIC_SUPABASE_URL?: string },
): boolean {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return false;
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 送れる設定か（設計書 4-4・本計画 P8）。送れなければ止める理由を返す */
export function checkOrderEmailSendConfig(env: Env = process.env): OrderEmailPauseReason | null {
  const provider = providerOf(env);
  if (provider !== 'resend' && provider !== 'local') return 'config_provider';
  // 共有の DB の行を手元へ送信済みにしてしまう設定は、送る前に全体を一時停止する。
  if (provider === 'local' && !isLocalOrderEmailDatabase(env)) return 'config_provider';
  if (!env.MAIL_FROM_ADDRESS?.trim()) return 'config_provider';
  if (provider === 'resend' && !env.RESEND_API_KEY?.trim()) return 'config_api_key';
  return null;
}

/** 待つ時間の指示（秒）。大文字小文字を問わず読み、1日で打ち切る */
export function parseRetryAfter(headers: Record<string, string> | null | undefined): number | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
  const seconds = key ? Number.parseInt(headers[key], 10) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/** Resend の断りを、やり直す・止める・やり直さないに分ける（設計書 4-4） */
export function classifyResendError(
  error: { name?: string | null; statusCode?: number | null },
  headers?: Record<string, string> | null,
): OrderEmailSendFailure {
  const name = error.name ?? '';
  const status = error.statusCode ?? null;
  const retryAfter = parseRetryAfter(headers);

  switch (name) {
    case 'rate_limit_exceeded':
      return failure('transient', 'rate_limited', retryAfter);
    case 'daily_quota_exceeded':
      return failure('config', 'quota_daily');
    case 'monthly_quota_exceeded':
      return failure('config', 'quota_monthly');
    case 'invalid_from_address':
      return failure('config', 'config_sender_domain');
    case 'invalid_idempotent_request':
      return failure('permanent', 'idempotency_conflict');
    case 'concurrent_idempotent_requests':
      return failure('transient', 'provider_unavailable', retryAfter);
    case 'validation_error':
      // 403 は送信元のドメインが確かめられていない（全部のメールに効く）。それ以外はこのメールの形の問題
      return status === 403 ? failure('config', 'config_sender_domain') : failure('permanent', 'invalid_message');
    case 'application_error':
    case 'internal_server_error':
      // SDK は通信の失敗を statusCode の無い application_error にして返す
      return status === null ? failure('transient', 'network_error') : failure('transient', 'provider_unavailable', retryAfter);
  }

  if (CONFIG_KEY_ERRORS.has(name)) return failure('config', 'config_api_key');
  if (PERMANENT_ERRORS.has(name)) return failure('permanent', 'invalid_message');
  if (status !== null && (status === 429 || status >= 500)) return failure('transient', 'provider_unavailable', retryAfter);
  return failure('transient', 'unexpected_error', retryAfter);
}

/** 通信自体は中断できない。race が遅れて返る成功・失敗も受け取り、打ち切り後は結果を使わない。 */
async function withinSendTimeout<T>(send: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('order email send timeout')), ORDER_EMAIL_SEND_TIMEOUT_MS);
    });
    return await Promise.race([send(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 1通送る。例外は投げず、結果を返す */
export async function sendOrderEmailMessage(message: OrderEmailMessage, env: Env = process.env): Promise<OrderEmailSendOutcome> {
  const configError = checkOrderEmailSendConfig(env);
  if (configError) {
    return { ok: false, failure: failure('config', configError) };
  }

  if (providerOf(env) === 'local') {
    try {
      await withinSendTimeout(() => sendLocalMail({ to: message.to, subject: message.subject, text: message.text, from: env.MAIL_FROM_ADDRESS }));
      return { ok: true, providerMessageId: null };
    } catch {
      return { ok: false, failure: failure('transient', 'network_error') };
    }
  }

  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const response = await withinSendTimeout(() => resend.emails.send(
      { from: env.MAIL_FROM_ADDRESS as string, to: message.to, subject: message.subject, text: message.text },
      { idempotencyKey: message.idempotencyKey },
    ));
    if (response.error) {
      return { ok: false, failure: classifyResendError(response.error, response.headers) };
    }
    return { ok: true, providerMessageId: response.data?.id ?? null };
  } catch {
    return { ok: false, failure: failure('transient', 'network_error') };
  }
}
