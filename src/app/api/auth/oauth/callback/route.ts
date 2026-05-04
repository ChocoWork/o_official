import { NextResponse } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { getRequestOrigin, sanitizeRedirectPath } from '@/lib/redirect';
import { logAudit } from '@/lib/audit';

const DEFAULT_REDIRECT_PATH = '/auth/verified';

const CallbackQuerySchema = z.object({
  code: z.string().min(1),
  next: z.string().optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().optional(),
  expires_at: z.number().optional(),
  token_type: z.string().optional(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email().optional().nullable(),
  }).passthrough(),
}).passthrough();

function parseRequestCookies(cookieHeader: string | null): Array<{ name: string; value: string }> {
  if (!cookieHeader) {
    return [];
  }

  return cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) {
        return null;
      }

      const name = entry.slice(0, separatorIndex);
      const rawValue = entry.slice(separatorIndex + 1);

      try {
        return { name, value: decodeURIComponent(rawValue) };
      } catch {
        return { name, value: rawValue };
      }
    })
    .filter((cookie): cookie is { name: string; value: string } => cookie !== null);
}

export async function GET(request: Request) {
  const origin = getRequestOrigin(request);

  try {
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:oauth:callback', limit: 50, windowSeconds: 600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (oauth callback):', e);
    }

    const url = new URL(request.url);
    const parsed = CallbackQuerySchema.safeParse({
      code: url.searchParams.get('code'),
      next: url.searchParams.get('next') || undefined,
    });

    if (!parsed.success) {
      await logAudit({ action: 'auth.oauth.callback', outcome: 'failure', detail: 'missing_code' });
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }

    const { code, next } = parsed.data;

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: 'missing_supabase_env' });
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    const cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }> = [];
    const supabase = createServerClient(supabaseUrl, anonKey, {
      auth: {
        flowType: 'pkce',
        detectSessionInUrl: false,
      },
      cookies: {
        getAll() {
          return parseRequestCookies(request.headers.get('cookie'));
        },
        setAll(nextCookies) {
          cookiesToSet.push(...nextCookies);
        },
      },
    });

    const exchangeResult = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeResult.error || !exchangeResult.data.session || !exchangeResult.data.user) {
      console.error('token exchange failed:', exchangeResult.error);
      await logAudit({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'token_exchange_failed',
        metadata: {
          error: exchangeResult.error?.message ?? null,
        },
      });
      return NextResponse.json({ error: 'OAuth exchange failed' }, { status: 502 });
    }

    const session = exchangeResult.data.session;
    const user = exchangeResult.data.user;
    const tokenParsed = TokenResponseSchema.safeParse({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      token_type: session.token_type,
      user,
    });
    if (!tokenParsed.success) {
      console.error('session response parse failed', tokenParsed.error);
      await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: 'invalid_token_response_shape' });
      return NextResponse.json({ error: 'OAuth exchange failed' }, { status: 502 });
    }

    const sessionLike = {
      access_token: tokenParsed.data.access_token,
      refresh_token: tokenParsed.data.refresh_token,
      expires_in: tokenParsed.data.expires_in,
      expires_at: tokenParsed.data.expires_at,
      token_type: tokenParsed.data.token_type,
    };

    const redirectPath = sanitizeRedirectPath(next, DEFAULT_REDIRECT_PATH);

    const res = NextResponse.redirect(new URL(redirectPath, origin), { status: 303 });
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    for (const cookie of cookiesToSet) {
      res.cookies.set(cookie.name, cookie.value, cookie.options);
    }

    try {
      const { persistSessionAndCookies } = await import('@/features/auth/services/register');
      const persisted = await persistSessionAndCookies(res, sessionLike, user);
      if (!persisted?.ok) {
        await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: `session_persist_failed: ${persisted?.error || 'unknown'}`, resource_id: user.id });
        return res;
      }
    } catch (e) {
      console.error('persistSessionAndCookies failed:', e);
      await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: String(e), resource_id: user.id });
      return res;
    }

    await logAudit({ action: 'auth.oauth.callback', outcome: 'success', actor_email: user.email ?? null, resource_id: user.id });
    return res;
  } catch (err) {
    console.error('OAuth callback error:', err);
    await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
