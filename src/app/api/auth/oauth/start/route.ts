import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { getRequestOrigin, sanitizeRedirectPath } from '@/lib/redirect';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';

const PROVIDERS = new Set(['google']);
const DEFAULT_REDIRECT_PATH = '/auth/verified';
const STATE_TTL_SECONDS = 10 * 60; // 10 minutes

function base64UrlEncode(input: Buffer) {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sha256Base64Url(input: string) {
  const digest = crypto.createHash('sha256').update(input).digest();
  return base64UrlEncode(digest);
}

const StartQuerySchema = z.object({
  provider: z.string().min(1),
  redirect_to: z.string().optional(),
});

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

    // PKCE
    const state = base64UrlEncode(crypto.randomBytes(32));
    const codeVerifier = base64UrlEncode(crypto.randomBytes(48));
    const codeChallenge = sha256Base64Url(codeVerifier);

    const clientIpHeader = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

    const expiresAt = new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString();

    const service = await createServiceRoleClient();
    await service.from('oauth_requests').insert([
      {
        provider,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        code_verifier: codeVerifier,
        redirect_to: redirectPath,
        client_ip: clientIpHeader,
        expires_at: expiresAt,
      },
    ]);

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      await logAudit({ action: 'auth.oauth.start', outcome: 'error', detail: 'missing_supabase_env' });
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    const callbackUrl = new URL('/api/auth/oauth/callback', origin);

    const authorizeUrl = new URL('/auth/v1/authorize', supabaseUrl);
    authorizeUrl.searchParams.set('provider', provider);
    authorizeUrl.searchParams.set('redirect_to', callbackUrl.toString());
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);

    const res = NextResponse.redirect(authorizeUrl, { status: 302 });
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');

    await logAudit({ action: 'auth.oauth.start', outcome: 'success', metadata: { provider, redirect_to: redirectPath } });
    return res;
  } catch (err) {
    console.error('OAuth start error:', err);
    await logAudit({ action: 'auth.oauth.start', outcome: 'error', detail: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
