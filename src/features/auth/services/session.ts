import { createServiceRoleClient } from '@/lib/supabase/server';
import { tokenHashSha256 } from '@/lib/hash';

export type Session = {
  id: string;
  user_id: string;
  refresh_token_hash?: string;
  current_jti?: string;
  previous_refresh_token_hash?: string | null;
  quarantined?: boolean;
  revoked_at?: string | null;
};

// Accepts either a raw refresh token or a precomputed sha256 hash. Returns session or null.
export async function findSessionByRefreshHash(hashOrToken: string): Promise<Session | null> {
  const service = await createServiceRoleClient();
  const isLikelyHash = /^[0-9a-f]{64}$/i.test(hashOrToken);
  const lookup = isLikelyHash ? hashOrToken : await tokenHashSha256(hashOrToken);

  const { data, error } = await service
    .from('sessions')
    .select('id, user_id, refresh_token_hash, current_jti, previous_refresh_token_hash, quarantined, revoked_at')
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
    revoked_at: data.revoked_at ?? null,
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
  const { error } = await service
    .from('sessions')
    .update({ revoked_at: new Date().toISOString(), quarantined: true })
    .eq('user_id', userId)
    .is('revoked_at', null);
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
  if (session.revoked_at) return true;
  const tokenHash = await tokenHashSha256(token);
  if (session.previous_refresh_token_hash && session.previous_refresh_token_hash === tokenHash) return true;
  return false;
}

export const REFRESH_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;

type CookieWriter = {
  cookies: { set(cookie: { name: string; value: string } & Record<string, unknown>): unknown };
};

export type IssuedSession = {
  accessToken: string | null | undefined;
  refreshToken: string | null | undefined;
  expiresIn?: number | null;
  userId: string;
  /** 差し替え対象の既存セッション行。無ければ新規発行として扱う。 */
  previousSessionId?: string | null;
  previousRefreshToken?: string | null;
};

function parseJwtJti(token: string | null | undefined): string | null {
  if (!token) return null;
  const segments = token.split('.');
  if (segments.length !== 3) return null;

  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as { jti?: unknown };
    return typeof payload.jti === 'string' ? payload.jti : null;
  } catch {
    return null;
  }
}

/**
 * 新しく発行されたセッションを Cookie と sessions テーブルへ反映する。
 * トークンを差し替える経路（refresh / MFA 昇格）は必ずここを通し、
 * Cookie・CSRF・セッション行の更新手順が経路ごとにずれないようにする。
 */
export async function persistNewSession(response: CookieWriter, issued: IssuedSession): Promise<void> {
  const {
    refreshCookieName,
    accessCookieName,
    csrfCookieName,
    cookieOptionsForAccess,
    cookieOptionsForRefresh,
    cookieOptionsForCsrf,
  } = await import('@/lib/cookie');
  const { generateCsrfToken } = await import('@/lib/csrf');

  const accessMaxAge = issued.expiresIn || DEFAULT_ACCESS_TOKEN_MAX_AGE_SECONDS;
  const csrfToken = generateCsrfToken();

  response.cookies.set({ name: accessCookieName, value: issued.accessToken ?? '', ...cookieOptionsForAccess(accessMaxAge) });
  response.cookies.set({ name: refreshCookieName, value: issued.refreshToken ?? '', ...cookieOptionsForRefresh(REFRESH_TOKEN_MAX_AGE_SECONDS) });
  response.cookies.set({ name: csrfCookieName, value: csrfToken, ...cookieOptionsForCsrf(REFRESH_TOKEN_MAX_AGE_SECONDS) });

  const service = await createServiceRoleClient();
  const previousHash = issued.previousRefreshToken ? await tokenHashSha256(issued.previousRefreshToken) : null;

  if (issued.previousSessionId) {
    await service
      .from('sessions')
      .update({
        revoked_at: new Date().toISOString(),
        previous_refresh_token_hash: previousHash,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', issued.previousSessionId);
  }

  await service.from('sessions').insert([
    {
      user_id: issued.userId,
      refresh_token_hash: await tokenHashSha256(issued.refreshToken ?? ''),
      previous_refresh_token_hash: previousHash,
      current_jti: parseJwtJti(issued.refreshToken),
      quarantined: false,
      csrf_token_hash: await tokenHashSha256(csrfToken),
      expires_at: issued.expiresIn ? new Date(Date.now() + issued.expiresIn * 1000).toISOString() : null,
      last_seen_at: new Date().toISOString(),
    },
  ]);
}
