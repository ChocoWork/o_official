import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * フックに更新を拒否された店員のセッションを終わらせる。前の `public.sessions` の行を失効し、結び付いた GoTrue の session を消す。
 *
 * @impl IMPL-AUTH-279
 * @design DD-AUTH-058
 * @remarks 行の失効と GoTrue の session の削除（RPC `revoke_auth_session`）は、片方が落ちても両方試す。落ちた物があれば false を返す（呼び手は Cookie を消して 401 を返し、監査に end_failed を残す）。
 * 行（auth_session_id を知る唯一の手掛かり）が無ければ終わらせる対象が分からないので false。`auth_session_id` が無い行は RPC を呼ばず、行の失効だけで true（ADR-0466）。
 */
export async function endRejectedStaffSession(
  session: { id?: string; auth_session_id?: string | null } | null,
): Promise<boolean> {
  if (!session?.id) return false;
  let ok = true;
  try {
    const service = await createServiceRoleClient();
    const { error: revokeError } = await service
      .from('sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', session.id);
    if (revokeError) ok = false;
    if (session.auth_session_id) {
      const { error: rpcError } = await service.rpc('revoke_auth_session', {
        p_session_id: session.auth_session_id,
      });
      if (rpcError) ok = false;
    }
  } catch {
    ok = false;
  }
  return ok;
}
