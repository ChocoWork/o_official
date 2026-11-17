/**
 * ログイン後の行き先の取得（src/features/auth/passkey/post-login.ts）。
 * 旧 `VerifyOtpClient` の同名の関数と同じ規則。段4で旧と一緒に重複が消える。
 *
 * @packageDocumentation
 */
import { sanitizeReturnPath } from '@/features/auth/return-intent/return-path';

const MFA_PATH = '/auth/verified';

type PostLoginResponse = { redirectTo?: string; needsMfa?: boolean };

/**
 * `POST /api/auth/post-login` を呼び、行き先を返す。401 は `/login`、失敗・読めない本文・`needsMfa` は `/auth/verified`、それ以外は `sanitizeReturnPath`。
 *
 * @impl IMPL-AUTH-305
 * @design DD-AUTH-060
 */
export async function resolvePostLoginPath(
  fetchApp: typeof fetch = fetch,
  origin: string = window.location.origin,
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
      return MFA_PATH;
    }
    const body = (await response.json().catch(() => null)) as PostLoginResponse | null;
    if (body === null || body.needsMfa === true) return MFA_PATH;
    return sanitizeReturnPath(body.redirectTo, '/', { origin });
  } catch {
    return MFA_PATH;
  }
}
