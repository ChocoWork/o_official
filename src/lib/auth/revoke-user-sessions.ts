import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * 利用者の自前の sessions を失効し、Auth 側の session を消す。
 * どちらかの error があれば固定の文のメッセージで throw する（Supabase の誤りの本文は console.error に code だけ残す）。
 */
export async function revokeAllSessionsForUser(userId: string): Promise<{ authSessionsDeleted: number }> {
  const service = await createServiceRoleClient();

  const { error: appError } = await service
    .from('sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (appError) {
    console.error('revokeAllSessionsForUser: app session update failed', { code: (appError as { code?: string }).code });
    throw new Error('app_session_revocation_failed');
  }

  const { data, error: authError } = await service.rpc('revoke_auth_sessions_for_user', { p_user_id: userId });
  if (authError) {
    console.error('revokeAllSessionsForUser: auth session revocation failed', { code: (authError as { code?: string }).code });
    throw new Error('auth_session_revocation_failed');
  }

  return { authSessionsDeleted: Number(data ?? 0) };
}
