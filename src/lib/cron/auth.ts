import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 定期処理の入口の合言葉の確かめ方（設計書 2026-10-05 グループ B の 4-3。X-4）。
 * 合言葉を SHA-256 にしてから timingSafeEqual で比べる（長さの違いも時間に出ない）。
 */
export const MIN_CRON_SECRET_LENGTH = 32;

export type CronAuthFailure =
  | 'CRON_SECRET is not configured'
  | 'CRON_SECRET is shorter than 32 characters'
  | 'Missing Authorization header'
  | 'Authorization header does not match CRON_SECRET';

export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: CronAuthFailure; misconfigured: boolean };

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Bearer の合言葉が一致するか。合言葉の長さは問わない（法令アーカイブの入口も使う）。 */
export function authorizeCronBearer(
  authorization: string | null,
  configuredSecret: string | undefined,
): boolean {
  if (!configuredSecret) return false;
  return timingSafeEqual(digest(`Bearer ${configuredSecret}`), digest(authorization ?? ''));
}

function checkCronRequest(request: Request, configuredSecret: string | undefined): CronAuthResult {
  if (!configuredSecret) {
    return { ok: false, reason: 'CRON_SECRET is not configured', misconfigured: true };
  }
  if (configuredSecret.length < MIN_CRON_SECRET_LENGTH) {
    return { ok: false, reason: 'CRON_SECRET is shorter than 32 characters', misconfigured: true };
  }
  const header = request.headers.get('authorization');
  if (!header) {
    return { ok: false, reason: 'Missing Authorization header', misconfigured: false };
  }
  if (!authorizeCronBearer(header, configuredSecret)) {
    return { ok: false, reason: 'Authorization header does not match CRON_SECRET', misconfigured: false };
  }
  return { ok: true };
}

/**
 * CRON_SECRET で守る定期処理の入口の確かめ方。32文字未満は設定の誤りとして断る。
 * 断ったときはログに1行だけ出す（ヘッダーの値は出さない）。
 */
export function authorizeCronRequest(
  request: Request,
  endpoint: string,
  configuredSecret: string | undefined = process.env.CRON_SECRET,
): CronAuthResult {
  const result = checkCronRequest(request, configuredSecret);
  if (!result.ok) console.warn(`[cron] ${endpoint} unauthorized`, result.reason);
  return result;
}
