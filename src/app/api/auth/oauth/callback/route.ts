/**
 * Google のログインの戻りの窓口（src/app/api/auth/oauth/callback/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-166
 * @design DD-AUTH-021
 * @remarks 交換の相手になる PKCE の検証の値は、開始の窓口が Cookie に溜めているので要求から読み直す。
 * 戻り先は URL から読まず、保存の成功の後に Cookie の控えを使い切って 303 の行き先を差し替える（保存の失敗で戻り先だけが焼けるのを防ぐ）。
 * 管理の役割は交換直後が aal1 なので、必ず TOTP の画面へ送り、控えは使い切らない。
 * 保存に失敗しても交換は済んでライブラリが Cookie を溜めているため、それを付けた応答を返して利用者を行き止まりにせず、失敗は監査に残す。
 */
import { NextResponse } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { getRequestOrigin } from '@/lib/redirect';
import {
  applyReturnIntentCookie,
  resolveReturnDestination,
} from '@/features/auth/return-intent/return-intent-service';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

type UserRole = 'admin' | 'supporter' | 'user';

const isUserRole = (role: unknown): role is UserRole => role === 'admin' || role === 'supporter' || role === 'user';

const CallbackQuerySchema = z.object({
  code: z.string().min(1),
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
    const rl = await enforceRateLimit({ request, endpoint: 'auth:oauth:callback', limit: 50, windowSeconds: 600 });
    if (rl) return rl;

    const url = new URL(request.url);
    const parsed = CallbackQuerySchema.safeParse({
      code: url.searchParams.get('code'),
    });

    if (!parsed.success) {
      await logAudit({ action: 'auth.oauth.callback', outcome: 'failure', detail: 'missing_code' });
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }

    const { code } = parsed.data;

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

    const role = isUserRole(user.app_metadata?.role) ? user.app_metadata.role : 'user';
    const isPrivileged = role === 'admin' || role === 'supporter';
    // 保存が成功するまで戻り先は使い切らないので、応答は既定の行き先で先に作る。
    const defaultPath = isPrivileged ? '/auth/verified' : '/';

    const res = NextResponse.redirect(new URL(defaultPath, origin), { status: 303 });
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('Referrer-Policy', 'no-referrer');
    for (const cookie of cookiesToSet) {
      res.cookies.set(cookie.name, cookie.value, cookie.options);
    }

    try {
      const { persistSessionAndCookies } = await import('@/features/auth/services/register');
      // ゲストのカートとお気に入りの印を、ログインの保存の後で会員の分へ合わせるために渡す。
      const { readGuestShoppingTokens } = await import('@/features/cart/services/guest-shopping-token');
      const persisted = await persistSessionAndCookies(res, sessionLike, user, readGuestShoppingTokens(request.headers.get('cookie')));
      if (!persisted?.ok) {
        await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: `session_persist_failed: ${persisted?.error || 'unknown'}`, resource_id: user.id });
        return res;
      }
    } catch (e) {
      console.error('persistSessionAndCookies failed:', e);
      await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: String(e), resource_id: user.id });
      return res;
    }

    // 交換直後は Google のログインなので aal1。特権は必ず 2 段目の画面へ送り、控えはそこでの完了まで使い切らない。
    const resolved = await resolveReturnDestination({
      cookieHeader: request.headers.get('cookie'),
      purpose: 'login',
      viewer: { id: user.id, role, aal: 'aal1' },
    });
    res.headers.set('location', new URL(resolved.path, origin).toString());
    applyReturnIntentCookie(res, resolved.action);

    await logAudit({ action: 'auth.oauth.callback', outcome: 'success', actor_email: user.email ?? null, resource_id: user.id });
    return res;
  } catch (err) {
    console.error('OAuth callback error:', err);
    await logAudit({ action: 'auth.oauth.callback', outcome: 'error', detail: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
