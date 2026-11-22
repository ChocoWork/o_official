import 'server-only';

import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { approvedCount, isStaff } from '@/lib/auth/passkey-approval-rpc';
import { endAuthSessionById } from '@/lib/auth/passkey-auth-session-end';
import { STAFF_MIN_APPROVED_PASSKEYS, evaluateStaffEntry } from '@/lib/auth/staff-passkey';
import { checkStaffIdle, staffIdleDeps } from '@/lib/auth/staff-passkey-idle';

export type StaffPasskeyPageAccess =
  | { ok: true; userId: string; approvedCount: number }
  | { ok: false; redirectTo: string }
  | { ok: false; unavailable: true };

const LOGIN = '/login';
const LOGIN_IDLE = '/login?reason=idle';
const LOGIN_STAFF_REQUIRED = '/login?reason=staff_required';

/**
 * 店員のパスキー管理ページ `/admin/passkeys` を開いてよいセッションかを、サーバーで確かめる。
 *
 * @impl IMPL-AUTH-383
 * @design DD-AUTH-082
 * @remarks 求めるのは ①有効な店員の役割 ②`amr` のパスキーが24時間以内 ③無操作1時間以内（時刻を進めない `peek`。開き直すだけでは延びない）。
 * **認めた鍵が2本以上かは求めない**（1本の店員が「もう1本」を足しに来るため。0本の人は招待の窓の道でここへ来ない）。
 * 外れたら `/login`（`reason` つき）で、1本の店員はここへ着く（ログインの後の行き先が送る）ので、ここから別の行き先へ戻さない。
 * 無操作・24時間の超過は GoTrue のセッションも終わらせる。確かめの失敗（DB が読めない）は `unavailable` で、`/login` へは送らず終わらせもしない。
 */
export async function requireStaffPasskeyPage(): Promise<StaffPasskeyPageAccess> {
  const verified = await verifyAccessToken();
  if (!verified.ok) return { ok: false, redirectTo: LOGIN };
  const userId = verified.claims.sub;
  const sessionId = verified.claims.session_id;
  if (!userId || !sessionId) return { ok: false, redirectTo: LOGIN };

  const liveness = await checkAuthSessionLiveness(sessionId, true);
  if (liveness === 'unavailable') return { ok: false, unavailable: true };
  if (liveness !== 'active') return { ok: false, redirectTo: LOGIN };

  const staff = await isStaff(userId);
  if (!staff.ok) return { ok: false, unavailable: true };
  if (!staff.value) return { ok: false, redirectTo: LOGIN_STAFF_REQUIRED };

  // 本数は求めない（下限の本数を渡して、パスキーの印と24時間だけを見る）。
  const entry = evaluateStaffEntry(verified.claims, STAFF_MIN_APPROVED_PASSKEYS, Date.now() / 1000);
  if (!entry.ok) {
    if (entry.reason === 'passkey_expired') {
      await endAuthSessionById(sessionId);
      return { ok: false, redirectTo: LOGIN_IDLE };
    }
    return { ok: false, redirectTo: LOGIN_STAFF_REQUIRED };
  }

  const idle = await checkStaffIdle(staffIdleDeps, sessionId, userId, 'peek');
  if (idle === 'error') return { ok: false, unavailable: true };
  if (idle === 'idle') {
    await endAuthSessionById(sessionId);
    return { ok: false, redirectTo: LOGIN_IDLE };
  }

  const counted = await approvedCount(userId);
  if (!counted.ok) return { ok: false, unavailable: true };
  return { ok: true, userId, approvedCount: counted.value };
}
