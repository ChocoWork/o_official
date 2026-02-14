import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getRequestOrigin, sanitizeRedirectPath } from '@/lib/redirect';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';

const DEFAULT_REDIRECT_PATH = '/auth/verified';

const CallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
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
      state: url.searchParams.get('state'),
    });

    if (!parsed.success) {
      await logAudit({ action: 'auth.oauth.callback', outcome: 'failure', detail: 'missing_code_or_state' });
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }

    const { code, state } = parsed.data;

    const service = await createServiceRoleClient();

    const { data: reqRow, error: reqErr } = await service
      .from('oauth_requests')
      .select('*')
      .eq('state', state)
      .gte('expires_at', new Date().toISOString())
      .is('used_at', null)
      .maybeSingle();

    if (reqErr) {
      console.error('oauth_requests lookup error:', reqErr);
      await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: 'state_lookup_failed' });
      return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
    }

    if (!reqRow) {
      await logAudit({ action: 'auth.oauth.callback', outcome: 'failure', detail: 'invalid_or_expired_state' });
      return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
    }

    // One-time use
    await service.from('oauth_requests').update({ used_at: new Date().toISOString() }).eq('id', reqRow.id);

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: 'missing_supabase_env' });
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    const tokenUrl = new URL('/auth/v1/token', supabaseUrl);
    tokenUrl.searchParams.set('grant_type', 'pkce');

    const tokenResp = await fetch(tokenUrl.toString(), {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: reqRow.code_verifier,
      }),
    });

    if (!tokenResp.ok) {
      const text = await tokenResp.text().catch(() => '');
      console.error('token exchange failed:', tokenResp.status, text);
      await logAudit({ action: 'auth.oauth.callback', outcome: 'failure', detail: 'token_exchange_failed', metadata: { status: tokenResp.status } });
      return NextResponse.json({ error: 'OAuth exchange failed' }, { status: 502 });
    }

    const tokenJson: unknown = await tokenResp.json();
    const tokenParsed = TokenResponseSchema.safeParse(tokenJson);
    if (!tokenParsed.success) {
      console.error('token response parse failed', tokenParsed.error);
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

    const user = tokenParsed.data.user;

    // NOTE: 既存メール衝突時の「リンク提案」は別途実装（今回はサーバ側で制御しない）
    const redirectPath = sanitizeRedirectPath(reqRow.redirect_to, DEFAULT_REDIRECT_PATH);

    const res = NextResponse.redirect(new URL(redirectPath, origin), { status: 303 });
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');

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
