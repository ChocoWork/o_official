import { createServiceRoleClient } from '@/lib/supabase/server';
import { tokenHashSha256 } from '@/lib/hash';

export type Session = {
  id: string;
  user_id: string;
  refresh_token_hash?: string;
  current_jti?: string;
  previous_refresh_token_hash?: string | null;
  quarantined?: boolean;
};

// Accepts either a raw refresh token or a precomputed sha256 hash. Returns session or null.
export async function findSessionByRefreshHash(hashOrToken: string): Promise<Session | null> {
  const service = await createServiceRoleClient();
  const isLikelyHash = /^[0-9a-f]{64}$/i.test(hashOrToken);
  const lookup = isLikelyHash ? hashOrToken : tokenHashSha256(hashOrToken);

  const { data, error } = await service
    .from('sessions')
    .select('id, user_id, refresh_token_hash, current_jti, previous_refresh_token_hash, quarantined')
    .eq('refresh_token_hash', lookup)
    .maybeSingle();

  if (error) {
    console.error('findSessionByRefreshHash DB error:', error);
    return null;
  }

  if (!data) return null;
  return {
    id: data.id,
    user_id: data.user_id,
    refresh_token_hash: data.refresh_token_hash,
    current_jti: data.current_jti,
    previous_refresh_token_hash: data.previous_refresh_token_hash ?? null,
    quarantined: data.quarantined ?? false,
  };
}

export async function rotateJtiAndSave(sessionId: string, newJti: string): Promise<{ newJti: string }> {
  const service = await createServiceRoleClient();
  const { error } = await service.from('sessions').update({ current_jti: newJti, last_seen_at: new Date().toISOString() }).eq('id', sessionId);
  if (error) {
    console.error('rotateJtiAndSave DB error:', error);
    throw error;
  }
  return { newJti };
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  const service = await createServiceRoleClient();
  const { error } = await service.from('sessions').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId);
  if (error) {
    console.error('revokeAllSessionsForUser DB error:', error);
    throw error;
  }
}

// Basic replay detection: if the provided token matches the session.previous_refresh_token_hash,
// treat as replay. Also treat sessions marked `quarantined` as replay/suspicious.
export async function isReplay(session: Session, token: string): Promise<boolean> {
  if (!session) return false;
  if (session.quarantined) return true;
  const tokenHash = tokenHashSha256(token);
  if (session.previous_refresh_token_hash && session.previous_refresh_token_hash === tokenHash) return true;
  return false;
}
