import 'server-only';

import { checkAuthSessionLiveness, verifyAccessToken } from '@/lib/auth/authenticate';
import { approvedCount, windowIsOpen } from '@/lib/auth/passkey-approval-rpc';

/** 窓の免除の本数（`min_approved_passkeys`）。画面は、この本数までの段を出す。 */
const WINDOW_KEYS = 2;

export type StaffRegisterAccess = { ok: true; registered: number } | { ok: false };

/**
 * 登録の画面 `/staff/register` を開いてよいセッションかを、サーバーで確かめる。
 *
 * @impl IMPL-AUTH-378
 * @design DD-AUTH-080
 * @remarks Cookie の署名済みトークン → アプリに結び付いた生きたセッション（`checkAuthSessionLiveness(session_id, true)`）→
 * このセッションに結んだ窓が開いているか（`passkey_window_is_open`）、の順。読めない・閉じているはすべて `{ ok: false }`（閉じる側。
 * 呼び手は `/login` へ送る）。通れば認めた鍵の本数（最大2）を返し、画面は再読み込みでも続きから出せる。
 */
export async function readStaffRegisterAccess(): Promise<StaffRegisterAccess> {
  const verified = await verifyAccessToken();
  if (!verified.ok) return { ok: false };
  const userId = verified.claims.sub;
  const sessionId = verified.claims.session_id;
  if (!userId || !sessionId) return { ok: false };

  if ((await checkAuthSessionLiveness(sessionId, true)) !== 'active') return { ok: false };

  const [opened, counted] = await Promise.all([windowIsOpen(userId, sessionId), approvedCount(userId)]);
  if (!opened.ok || !opened.value || !counted.ok) return { ok: false };
  return { ok: true, registered: Math.min(counted.value, WINDOW_KEYS) };
}
