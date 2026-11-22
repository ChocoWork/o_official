/**
 * ログイン後の行き先の取得（src/features/auth/passkey/post-login.ts）。
 * 旧 `VerifyOtpClient` の同名の関数と同じ規則。段4で旧と一緒に重複が消える。
 *
 * @packageDocumentation
 */
import { sanitizeReturnPath } from '@/features/auth/return-intent/return-path';
import { loadStaffPasskeys } from '@/features/auth/staff/staff-passkey-status';

/** 認めた鍵が1本の店員を、もう1本を足す画面へ送る先。 */
const STAFF_ONE_MORE_KEY_PATH = '/admin/passkeys?more=1';
/** 入口の条件に足りない店員（鍵が1本でない）の行き先。画面の文は既存の固定の文。 */
const STAFF_PASSKEY_REQUIRED_PATH = '/login?error=staff_passkey_required';

type PostLoginResponse = { redirectTo?: string; needsMfa?: boolean };

/**
 * `POST /api/auth/post-login` を呼び、行き先を返す。401・失敗・読めない本文は `/login`、`needsMfa`（店員が入口の条件に足りない）は認めた鍵が1本なら
 * `/admin/passkeys?more=1`、それ以外は `/login?error=staff_passkey_required`、そうでなければ `sanitizeReturnPath`。
 *
 * @impl IMPL-AUTH-305
 * @design DD-AUTH-060
 */
export async function resolvePostLoginPath(
  fetchApp: typeof fetch = fetch,
  origin: string = window.location.origin,
  loadStaff: typeof loadStaffPasskeys = loadStaffPasskeys,
): Promise<string> {
  try {
    const response = await fetchApp('/api/auth/post-login', {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
    });
    // no-store の応答は本文を読まないと Chrome が通信中のままにする（E2E の networkidle が来ない）。読まない道では捨てる。
    if (response.status === 401) {
      await response.arrayBuffer().catch(() => undefined);
      return '/login';
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      return '/login';
    }
    const body = (await response.json().catch(() => null)) as PostLoginResponse | null;
    if (body === null) return '/login';
    if (body.needsMfa === true) {
      const status = await loadStaff();
      return status.ok && status.isStaff && status.approvedCount === 1 ? STAFF_ONE_MORE_KEY_PATH : STAFF_PASSKEY_REQUIRED_PATH;
    }
    return sanitizeReturnPath(body.redirectTo, '/', { origin });
  } catch {
    return '/login';
  }
}
