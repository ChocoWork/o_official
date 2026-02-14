import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient, createClient } from '@/lib/supabase/server';
import { getRequestOrigin, sanitizeRedirectPath } from '@/lib/redirect';
import { logAudit } from '@/lib/audit';
import { RegisterRequestSchema } from '@/features/auth/schemas/register';
import { formatZodError } from '@/features/auth/schemas/common';



export async function POST(request: Request) {
  try {
    // Enforce rate limit for admin register calls
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:register', limit: 20, windowSeconds: 3600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (register):', e);
    }

    // 管理者用ヘッダが渡されている場合のみ管理者チェックを行う。
    // ADMIN_API_KEY が未設定でも、ヘッダ無しのリクエストはパブリックサインアップとして処理する。
    const adminApiKey = process.env.ADMIN_API_KEY;
    const provided = request.headers.get('x-admin-token') || request.headers.get('authorization')?.replace(/^Bearer\s+/, '');

    // If the client provided an admin token, validate it against server config.
    if (provided) {
      if (!adminApiKey) {
        console.error('ADMIN_API_KEY is not configured but admin token provided');
        return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
      }
      if (provided !== adminApiKey) {
        await logAudit({ action: 'register', actor_email: null, outcome: 'unauthorized', detail: 'Missing or invalid admin token' });
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const body = await request.json();
    const parsed = RegisterRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    const { email, password, display_name } = parsed.data;
    const redirectPath = sanitizeRedirectPath(parsed.data.redirect_to ?? parsed.data.emailRedirectTo, '/auth/verified');

    // If admin token provided, use existing admin-create path (already implemented)
    if (provided && provided === adminApiKey) {
      const supabase = await createServiceRoleClient();
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        user_metadata: { display_name },
      });

      if (error) {
        console.error('Supabase createUser error:', error);
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('duplicate')) {
          await logAudit({ action: 'register', actor_email: email, outcome: 'conflict', detail: error.message });
          return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
        }

        await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: error.message });
        return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
      }

      await logAudit({ action: 'register', actor_email: email, outcome: 'success', resource_id: data.user?.id });
      return NextResponse.json({ id: data.user?.id, email: data.user?.email }, { status: 201 });
    }

    // Public signup flow
    try {
      // factor pre-check into helper for clarity
      async function preCheckExistingUser(emailToCheck: string): Promise<{ found: boolean; detail?: string }> {
        try {
          const service = await createServiceRoleClient();

          if (service?.auth?.admin?.getUserByEmail) {
            const maybe = await service.auth.admin.getUserByEmail(emailToCheck);
            if (maybe?.data?.user) return { found: true, detail: 'email already exists (pre-check getUserByEmail)' };
            return { found: false };
          }

          if (service?.auth?.admin?.listUsers) {
            try {
              const listed = await service.auth.admin.listUsers({ per_page: 100 });
              if (listed?.data?.users) {
                const found = listed.data.users.find((u: any) => String(u.email).toLowerCase() === String(emailToCheck).toLowerCase());
                if (found) return { found: true, detail: 'email already exists (pre-check listUsers)' };
              }
            } catch (e) {
              console.warn('listUsers pre-check failed, will try HTTP admin API fallback', e);
            }
          }

          // HTTP fallback to admin REST endpoint
          try {
            const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
            const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
            if (supabaseUrl && serviceKey) {
              const url = new URL('/auth/v1/admin/users', supabaseUrl).toString();
              const q = `${url}?email=${encodeURIComponent(emailToCheck)}`;
              const r = await fetch(q, {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${serviceKey}`,
                  apikey: serviceKey,
                  Accept: 'application/json',
                },
              });

              if (r.ok) {
                const body = await r.json();
                const foundUser = Array.isArray(body) ? body.find((u: any) => String(u.email).toLowerCase() === String(emailToCheck).toLowerCase()) : (body?.email ? body : null);
                if (foundUser) return { found: true, detail: 'email already exists (admin HTTP pre-check)' };
              } else if (r.status !== 404) {
                console.warn('Admin HTTP pre-check returned non-ok status', r.status, await r.text());
              }
            }
          } catch (httpErr) {
            console.warn('Admin HTTP pre-check failed, continuing to signUp', httpErr);
          }
        } catch (e) {
          console.warn('Service-role existence pre-check failed, continuing to signUp', e);
        }

        return { found: false };
      }

      const pre = await preCheckExistingUser(email);
      if (pre.found) {
        await logAudit({ action: 'register', actor_email: email, outcome: 'conflict', detail: pre.detail });
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
      }

      const { verifyTurnstile } = await import('@/lib/turnstile');
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
      const turnstile = await verifyTurnstile(parsed.data.turnstileToken, ip);
      if (!turnstile.ok) {
        await logAudit({ action: 'register', actor_email: email, outcome: 'failure', detail: turnstile.error || 'turnstile_failed' });
        return NextResponse.json({ error: 'Bot detection failed' }, { status: 403 });
      }

      const client = await createClient();
      const origin = getRequestOrigin(request);
      const confirmUrl = new URL('/api/auth/confirm', origin);
      confirmUrl.searchParams.set('redirect_to', redirectPath);

      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: display_name ? { display_name } : undefined,
          emailRedirectTo: confirmUrl.toString(),
        },
      });

      if (error) {
        console.error('Public signUp error:', error);
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('duplicate')) {
          await logAudit({ action: 'register', actor_email: email, outcome: 'conflict', detail: error.message });
          return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
        }
        await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: error.message });
        return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
      }

      // If signup returned a session (auto signed-in), persist session and set cookies
      if (data.session) {
        const res = NextResponse.json({ access_token: data.session.access_token, user: data.user }, { status: 201 });
        try {
          const { persistSessionAndCookies } = await import('@/features/auth/services/register');
          const result = await persistSessionAndCookies(res, data.session, data.user);
          if (!result?.ok) {
            console.error('persistSessionAndCookies failed:', result.error);
            // Clear cookies to avoid inconsistent client state
            try {
              const {
                refreshCookieName,
                accessCookieName,
                cookieOptionsForRefresh,
                cookieOptionsForAccess,
                csrfCookieName,
                cookieOptionsForCsrf,
              } = await import('@/lib/cookie');
              res.cookies.set({ name: accessCookieName, value: '', ...cookieOptionsForAccess(0) });
              res.cookies.set({ name: refreshCookieName, value: '', ...cookieOptionsForRefresh(0) });
              res.cookies.set({ name: csrfCookieName, value: '', ...cookieOptionsForCsrf(0) });
            } catch (clearErr) {
              console.error('Failed to clear cookies after persistence failure:', clearErr);
            }
            await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: `session_persist_failed: ${result.error}`, resource_id: data.user?.id });
            return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
          }
        } catch (e) {
          console.error('Failed to persist session after signUp:', e);
          try {
            const {
              refreshCookieName,
              accessCookieName,
              cookieOptionsForRefresh,
              cookieOptionsForAccess,
              csrfCookieName,
              cookieOptionsForCsrf,
            } = await import('@/lib/cookie');
            res.cookies.set({ name: accessCookieName, value: '', ...cookieOptionsForAccess(0) });
            res.cookies.set({ name: refreshCookieName, value: '', ...cookieOptionsForRefresh(0) });
            res.cookies.set({ name: csrfCookieName, value: '', ...cookieOptionsForCsrf(0) });
          } catch (clearErr) {
            console.error('Failed to clear cookies after persistence unexpected error:', clearErr);
          }
          await logAudit({ action: 'register', actor_email: email, outcome: 'error', detail: String(e), resource_id: data.user?.id });
          return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
        }

        await logAudit({ action: 'register', actor_email: email, outcome: 'success', resource_id: data.user?.id });
        return res;
      }

      // If no session (email confirmation flows), return Accepted
      await logAudit({ action: 'register', actor_email: email, outcome: 'created_needs_confirmation' });
      return NextResponse.json({ message: 'Confirmation email sent' }, { status: 202 });
    } catch (e) {
      console.error('Public register flow error:', e);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  } catch (err) {
    console.error('Register handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
