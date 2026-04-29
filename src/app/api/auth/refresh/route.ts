import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

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

async function clearAuthCookies(response: NextResponse) {
  const {
    refreshCookieName,
    accessCookieName,
    csrfCookieName,
    clearCookieOptions,
  } = await import('@/lib/cookie');

  response.cookies.set({ name: refreshCookieName, value: '', ...clearCookieOptions() });
  response.cookies.set({ name: accessCookieName, value: '', ...clearCookieOptions() });
  response.cookies.set({ name: csrfCookieName, value: '', ...clearCookieOptions() });
}

export async function POST(request: Request) {
  try {
    // Enforce IP-level rate limit for refresh attempts
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:refresh', limit: 30, windowSeconds: 600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (refresh):', e);
    }
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get('sb-refresh-token')?.value;

    if (!refreshToken) {
      return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
    }

    const sessionService = await import('@/features/auth/services/session');
    const session = await sessionService.findSessionByRefreshHash(refreshToken);
    if (!session) {
      await logAudit({ action: 'refresh', outcome: 'failure', detail: 'session_not_found' });
      return NextResponse.json({ error: 'Invalid refresh token' }, { status: 401 });
    }

    const oldTokenJti = parseJwtJti(refreshToken);
    const jtiMismatch = Boolean(session.current_jti && oldTokenJti && session.current_jti !== oldTokenJti);
    const replayDetected = (await sessionService.isReplay(session, refreshToken)) || jtiMismatch;

    if (replayDetected) {
      await sessionService.revokeAllSessionsForUser(session.user_id);
      await logAudit({
        action: 'refresh',
        actor_id: session.user_id,
        outcome: 'failure',
        detail: jtiMismatch ? 'refresh_replay_jti_mismatch' : 'refresh_replay_detected',
      });

      const denied = NextResponse.json({ error: 'Refresh token replay detected' }, { status: 401 });
      await clearAuthCookies(denied);
      return denied;
    }

    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    // Exchange refresh token for new session
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);

    const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const failedText = await tokenRes.text();
      console.error('Token refresh failed:', failedText);
      await logAudit({
        action: 'refresh',
        actor_id: session.user_id,
        outcome: 'failure',
        detail: 'supabase_refresh_failed',
        metadata: { status: tokenRes.status },
      });
      return NextResponse.json({ error: 'Failed to refresh token' }, { status: 401 });
    }

    const tokenData = await tokenRes.json();
    const newAccessToken = tokenData.access_token;
    const newRefreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in; // seconds
    const user = tokenData.user;
    const newTokenJti = parseJwtJti(newRefreshToken);

    // Set new refresh cookie
    const res = NextResponse.json({ access_token: newAccessToken, user }, { status: 200 });

    // Use cookie helpers and update CSRF
    const {
      refreshCookieName,
      accessCookieName,
      cookieOptionsForRefresh,
      cookieOptionsForAccess,
      csrfCookieName,
      cookieOptionsForCsrf,
    } = await import('@/lib/cookie');
    res.cookies.set({ name: accessCookieName, value: newAccessToken ?? '', ...cookieOptionsForAccess(expiresIn || 15 * 60) });
    res.cookies.set({ name: refreshCookieName, value: newRefreshToken ?? '', ...cookieOptionsForRefresh(REFRESH_TOKEN_MAX_AGE) });

    const { tokenHashSha256 } = await import('@/lib/hash');
    const { generateCsrfToken } = await import('@/lib/csrf');

    const newCsrfToken = generateCsrfToken();
    res.cookies.set({ name: csrfCookieName, value: newCsrfToken, ...cookieOptionsForCsrf(REFRESH_TOKEN_MAX_AGE) });

    // Update sessions table: revoke old session row(s) and insert new one
    try {
      const service = await createServiceRoleClient();
      const oldHash = await tokenHashSha256(refreshToken ?? '');
      await service
        .from('sessions')
        .update({
          revoked_at: new Date().toISOString(),
          previous_refresh_token_hash: oldHash,
          last_seen_at: new Date().toISOString(),
        })
        .eq('id', session.id);

      const newHash = await tokenHashSha256(newRefreshToken ?? '');
      const csrfHash = await tokenHashSha256(newCsrfToken);
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

      await service.from('sessions').insert([
        {
          user_id: session.user_id || user?.id,
          refresh_token_hash: newHash,
          previous_refresh_token_hash: oldHash,
          current_jti: newTokenJti,
          quarantined: false,
          csrf_token_hash: csrfHash,
          expires_at: expiresAt,
          last_seen_at: new Date().toISOString(),
        },
      ]);

      await logAudit({
        action: 'refresh',
        actor_id: session.user_id,
        outcome: 'success',
      });
    } catch (dbErr) {
      console.error('Session DB update error during refresh:', dbErr);
      await logAudit({
        action: 'refresh',
        actor_id: session.user_id,
        outcome: 'error',
        detail: String(dbErr),
      });
    }

    return res;
  } catch (err) {
    console.error('Refresh handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
