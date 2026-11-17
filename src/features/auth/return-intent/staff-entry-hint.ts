import { approvedCountHint, evaluateStaffEntry } from '@/lib/auth/staff-passkey';

/**
 * トークンの claims から、店員がパスキーの入口の条件を満たすかのヒント（`staffEntryOk`）を出す。
 *
 * @impl IMPL-AUTH-273
 * @design DD-AUTH-054
 * @remarks `/api/auth/me` の `mfaVerified` と同じ判定（`evaluateStaffEntry(claims, approvedCountHint(claims), now)`）。
 * 行き先を決めるだけで、権限の判定ではない（権限は管理の窓口と RLS が DB で数えて止める。SEC-AUTH-043）。
 * 型の合わない値（文字列の時刻・文字列 `"true"`・欠けた `amr`）は偽（閉じる側）。
 */
export function staffEntryOkFromClaims(
  claims: { amr?: unknown; staff_passkeys_ok?: unknown; [key: string]: unknown } | null | undefined,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  return evaluateStaffEntry(claims, approvedCountHint(claims), nowSeconds).ok;
}
