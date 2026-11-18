import { createServiceRoleClient } from '@/lib/supabase/server';
import { readAuthSessionId } from '@/lib/auth/app-session';

/**
 * GoTrue のセッションを終わらせる（`revoke_auth_session`）。失敗しても例外にせず、結果だけ返す（呼び手は断る側に倒す）。
 *
 * @impl IMPL-AUTH-366
 * @design DD-AUTH-078
 * @remarks `accessToken` は、自分が今 GoTrue から受け取ったものだけを渡す（リクエスト由来の値は渡さない）。session_id が読めなければ false。
 * パスキーのログインの終わりと、招待のリンクの受け口が使う。
 */
export async function endAuthSession(accessToken: string): Promise<boolean> {
  const sessionId = readAuthSessionId(accessToken);
  if (!sessionId) return false;
  try {
    const service = await createServiceRoleClient();
    const { error } = await service.rpc('revoke_auth_session', { p_session_id: sessionId });
    return !error;
  } catch {
    return false;
  }
}
