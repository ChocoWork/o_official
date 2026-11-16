import { defaultStaffPasskeySettings } from '@/lib/auth/staff-passkey-defaults';

/** 店員のログインの最長の秒数。DB の設定の行と同じ値（初めの値の1か所から取る。ADR-0463）。 */
export const STAFF_MAX_SESSION_SECONDS: number = defaultStaffPasskeySettings().staffMaxSessionSeconds;

/** 管理の入口に要る認めたパスキーの本数。DB の設定の行と同じ値（初めの値の1か所から取る。ADR-0463）。 */
export const STAFF_MIN_APPROVED_PASSKEYS: number = defaultStaffPasskeySettings().minApprovedPasskeys;

export type StaffEntryResult =
  | { ok: true }
  | { ok: false; reason: 'no_passkey' | 'passkey_expired' | 'passkeys_insufficient' };

/**
 * 管理の入口の3つの条件（パスキー・24時間以内・認めたパスキー2本以上）を判定する。
 *
 * @impl IMPL-AUTH-245
 * @design DD-AUTH-047
 * @remarks `amr` の `passkey` の `timestamp`（整数の数）の最新で時刻を見る。`aal` は見ない（パスキーは aal1 のまま）。
 * `approvedCount` は呼び手が DB でその場で数えた値で、JWT の印 `staff_passkeys_ok` は使わない（SEC-AUTH-039）。
 * DB の関数 `private.staff_passkey_amr_ok`・`staff_passkey_count_ok` と同じ判定にする。
 * 今の秒は切り捨てる（SQL と同じ）。本数が整数でない・負・NaN・無限大・文字列なら閉じる側（`passkeys_insufficient`）に倒す。
 */
export function evaluateStaffEntry(
  claims: { amr?: unknown; [key: string]: unknown } | null | undefined,
  approvedCount: number,
  nowSeconds: number,
): StaffEntryResult {
  const amr = claims?.amr;
  let latest: number | null = null;
  if (Array.isArray(amr)) {
    for (const element of amr) {
      if (typeof element !== 'object' || element === null) continue;
      const { method, timestamp } = element as { method?: unknown; timestamp?: unknown };
      if (method !== 'passkey' || typeof timestamp !== 'number' || !Number.isInteger(timestamp)) continue;
      if (latest === null || timestamp > latest) latest = timestamp;
    }
  }
  if (latest === null) return { ok: false, reason: 'no_passkey' };
  const age = Math.floor(nowSeconds) - latest;
  if (age < 0 || age > STAFF_MAX_SESSION_SECONDS) return { ok: false, reason: 'passkey_expired' };
  if (!Number.isInteger(approvedCount) || approvedCount < STAFF_MIN_APPROVED_PASSKEYS) return { ok: false, reason: 'passkeys_insufficient' };
  return { ok: true };
}
