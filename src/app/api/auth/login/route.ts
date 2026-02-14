import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { LoginRequestSchema } from '@/features/auth/schemas/login';
import { formatZodError } from '@/features/auth/schemas/common';

const ACCESS_TOKEN_MAX_AGE = 15 * 60; // 15 minutes
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

export async function POST(request: Request) {
  try {
    // Enforce IP-level rate limit for login attempts
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:login', limit: 50, windowSeconds: 600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (login):', e);
    }
    const body = await request.json();
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    // Account-based rate limit (by email)
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rlAccount = await enforceRateLimit({ request, endpoint: 'auth:login', limit: 5, windowSeconds: 600, subject: parsed.data.email });
      if (rlAccount) return rlAccount;
    } catch (e) {
      console.error('Rate limit middleware error (login-account):', e);
    }

    const { email, password } = parsed.data;

    const supabase = await createClient();

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'failure', detail: error?.message || 'invalid credentials' });
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const session = data.session;

    // Return access token in JSON; set refresh token only as HttpOnly cookie
    const res = NextResponse.json({ access_token: session.access_token, user: data.user }, { status: 200 });

    // set refresh cookie using helpers
    // Synchronously set cookies and persist session info (tests expect DB call to have happened)
    try {
      const {
        refreshCookieName,
        accessCookieName,
        cookieOptionsForRefresh,
        cookieOptionsForAccess,
        csrfCookieName,
        cookieOptionsForCsrf,
      } = await import('@/lib/cookie');

      res.cookies.set({ name: accessCookieName, value: session.access_token ?? '', ...cookieOptionsForAccess(ACCESS_TOKEN_MAX_AGE) });
      res.cookies.set({ name: refreshCookieName, value: session.refresh_token ?? '', ...cookieOptionsForRefresh(REFRESH_TOKEN_MAX_AGE) });

      // Generate CSRF token and set non-httpOnly cookie; persist its hash alongside session
      const { generateCsrfToken } = await import('@/lib/csrf');
      const { tokenHashSha256 } = await import('@/lib/hash');
      const csrfToken = generateCsrfToken();
      res.cookies.set({ name: csrfCookieName, value: csrfToken, ...cookieOptionsForCsrf(REFRESH_TOKEN_MAX_AGE) });

      // Persist hashed refresh & csrf token into sessions table using service role client
      const service = (await import('@/lib/supabase/server')).createServiceRoleClient();
      const refreshToken = session.refresh_token ?? '';
      const refreshHash = tokenHashSha256(refreshToken);
      const csrfHash = tokenHashSha256(csrfToken);

      const expiresAt = session.expires_at ? new Date(session.expires_at).toISOString() : null;

      await service.from('sessions').insert([
        {
          user_id: data.user?.id,
          refresh_token_hash: refreshHash,
          csrf_token_hash: csrfHash,
          expires_at: expiresAt,
          last_seen_at: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      console.error('Failed to set cookies/persist session:', e);
    }

    await logAudit({ action: 'login', actor_email: email, outcome: 'success', resource_id: data.user?.id });

    return res;
  } catch (err) {
    console.error('Login handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
