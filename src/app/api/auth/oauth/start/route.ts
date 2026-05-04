import { NextResponse } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { getRequestOrigin, sanitizeRedirectPath } from '@/lib/redirect';
import { logAudit } from '@/lib/audit';

const PROVIDERS = new Set(['google']);
const DEFAULT_REDIRECT_PATH = '/auth/verified';

const StartQuerySchema = z.object({
  provider: z.string().min(1),
  redirect_to: z.string().optional(),
});

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
      const rl = await enforceRateLimit({ request, endpoint: 'auth:oauth:start', limit: 50, windowSeconds: 600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (oauth start):', e);
    }

    const url = new URL(request.url);
    const parsed = StartQuerySchema.safeParse({
      provider: url.searchParams.get('provider'),
      redirect_to: url.searchParams.get('redirect_to') || undefined,
    });

    if (!parsed.success) {
      await logAudit({ action: 'auth.oauth.start', outcome: 'failure', detail: 'invalid_query' });
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }

    const provider = parsed.data.provider;
    if (!PROVIDERS.has(provider)) {
      await logAudit({ action: 'auth.oauth.start', outcome: 'failure', detail: 'unsupported_provider', metadata: { provider } });
      return NextResponse.json({ error: 'Unsupported provider' }, { status: 400 });
    }

    const redirectPath = sanitizeRedirectPath(parsed.data.redirect_to, DEFAULT_REDIRECT_PATH);

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      await logAudit({ action: 'auth.oauth.start', outcome: 'error', detail: 'missing_supabase_env' });
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    const callbackUrl = new URL('/api/auth/oauth/callback', origin);
    callbackUrl.searchParams.set('next', redirectPath);

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

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callbackUrl.toString(),
        queryParams: {
          prompt: 'select_account',
        },
      },
    });

    if (error || !data?.url) {
      console.error('OAuth start error (signInWithOAuth):', error);
      await logAudit({ action: 'auth.oauth.start', outcome: 'failure', detail: 'oauth_authorize_url_generation_failed' });
      return NextResponse.json({ error: 'OAuth start failed' }, { status: 502 });
    }

    const res = NextResponse.redirect(data.url, { status: 302 });
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    for (const cookie of cookiesToSet) {
      res.cookies.set(cookie.name, cookie.value, cookie.options);
    }

    await logAudit({ action: 'auth.oauth.start', outcome: 'success', metadata: { provider, redirect_to: redirectPath } });
    return res;
  } catch (err) {
    console.error('OAuth start error:', err);
    await logAudit({ action: 'auth.oauth.start', outcome: 'error', detail: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
