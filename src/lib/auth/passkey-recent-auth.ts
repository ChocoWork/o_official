import { STAFF_CLOCK_SKEW_SECONDS, STAFF_MIN_APPROVED_PASSKEYS } from '@/lib/auth/staff-passkey';

/** 店員が5分以内のパスキーでの入り直しで登録できる秒数（設計 5-5）。 */
export const STAFF_REAUTH_SECONDS = 300;
/** お客さんがパスキーかメールのコードで入った後、登録できる秒数（設計 5-5）。 */
export const CUSTOMER_REAUTH_SECONDS = 600;

export type RegistrationMode = 'window' | 'reauth' | 'customer';

export type RegistrationAccess =
  | { ok: true; mode: RegistrationMode }
  | { ok: false; reason: 'window_closed' | 'reauth_required' };

/** `amr` の中で、指定の方法の整数の時刻の最新を返す。配列でない・形が違う要素は無いものとして扱う（`evaluateStaffEntry` と同じ読み方）。 */
function latestAmrTimestamp(amr: unknown, methods: readonly string[]): number | null {
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const element of amr) {
    if (typeof element !== 'object' || element === null) continue;
    const { method, timestamp } = element as { method?: unknown; timestamp?: unknown };
    if (typeof method !== 'string' || !methods.includes(method)) continue;
    if (typeof timestamp !== 'number' || !Number.isInteger(timestamp)) continue;
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest;
}

function isRecent(latest: number | null, nowSeconds: number, maxAgeSeconds: number): boolean {
  if (latest === null) return false;
  const age = Math.floor(nowSeconds) - latest;
  return age >= -STAFF_CLOCK_SKEW_SECONDS && age <= maxAgeSeconds;
}

/**
 * パスキーの登録を、今この人に許すかを判定する（純粋）。窓口は始めと終わりの両方で、呼ばれるたびに呼び直す（設計 6-2）。
 *
 * @impl IMPL-AUTH-275
 * @design DD-AUTH-056
 * @remarks 店員: 認めた鍵が1本以上あり、5分以内のパスキーでの入り直しなら `reauth`（本数の上限を掛けない。0本・数が不明の店員は窓だけ）。そうでなく、登録の窓が開いていて、
 * かつ認めた鍵が `STAFF_MIN_APPROVED_PASSKEYS`（2）未満の間だけ `window`（窓の免除は最初の2本まで）。`approvedCount` が整数でない値は、窓を認めない（閉じる側）。
 * どちらでもない時: パスキーの入り直しが古い店員、窓が開いていても認めた鍵が2本以上（または数が不明）の店員は `reauth_required`、
 * パスキーの印が無く窓も閉じている店員（メールのコードだけのセッションなど）は `window_closed`。
 * お客さん: 10分以内のパスキーかメールのコード（`otp`）なら `customer`。外れたら `reauth_required`。Google（`oauth`）は含めない。
 * 今の秒は切り捨てる。未来の時刻は60秒までの時計のずれとして通す。
 */
export function evaluateRegistrationAccess(input: {
  claims: { amr?: unknown } | null;
  isStaff: boolean;
  windowOpen: boolean;
  approvedCount: number;
  nowSeconds: number;
}): RegistrationAccess {
  const { claims, isStaff, windowOpen, approvedCount, nowSeconds } = input;
  const amr = claims?.amr;

  if (!isStaff) {
    const latest = latestAmrTimestamp(amr, ['passkey', 'otp']);
    return isRecent(latest, nowSeconds, CUSTOMER_REAUTH_SECONDS)
      ? { ok: true, mode: 'customer' }
      : { ok: false, reason: 'reauth_required' };
  }

  const latestPasskey = latestAmrTimestamp(amr, ['passkey']);
  // 入り直しで鍵を足せるのは、認めた鍵を既に1本以上持つ店員だけ（0本・不明は窓だけ。設計 6-2）。
  const hasApprovedKey = Number.isInteger(approvedCount) && approvedCount >= 1;
  if (hasApprovedKey && isRecent(latestPasskey, nowSeconds, STAFF_REAUTH_SECONDS)) return { ok: true, mode: 'reauth' };

  const hasRoom = Number.isInteger(approvedCount) && approvedCount < STAFF_MIN_APPROVED_PASSKEYS;
  if (windowOpen === true && hasRoom) return { ok: true, mode: 'window' };

  if (latestPasskey !== null || windowOpen === true) return { ok: false, reason: 'reauth_required' };
  return { ok: false, reason: 'window_closed' };
}
