/**
 * Google のログインの開始の窓口（src/app/api/auth/oauth/start/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-165
 * @design DD-AUTH-020
 * @remarks PKCE の検証の値はライブラリが Cookie に溜めるため、応答に付け直す。
 * ログインの後の戻り先は POST の本文の next だけを確かめて控え、番号は Cookie だけで渡す（Supabase へ渡す戻りの URL にも本文にも載せない）。GET は控えを作らず、残っている古い控えの Cookie を消す。
 * POST は 303 で外へ移さず 200 の { url } を返す。proxy の CSP が form-action 'self' で、フォームの送信に続く外部へのリダイレクトを止めるため。
 */
import { NextResponse } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { getRequestOrigin } from '@/lib/redirect';
import { applyReturnIntentCookie, issueReturnIntent } from '@/features/auth/return-intent/return-intent-service';
import { logAudit } from '@/lib/audit';

const PROVIDERS = new Set(['google']);

const StartQuerySchema = z.object({
  provider: z.string().min(1),
});

// next は型や長さでログインを止めない（検査は issueReturnIntent の確かめが行い、外れたら控えを作らず Cookie を消す）。
const StartBodySchema = z.object({
  provider: z.string().min(1),
  next: z.unknown().optional(),
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

async function enforceStartRateLimit(request: Request): Promise<Response | undefined> {
  try {
    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rl = await enforceRateLimit({ request, endpoint: 'auth:oauth:start', limit: 50, windowSeconds: 600 });
    if (rl) return rl;
  } catch (e) {
    console.error('Rate limit middleware error (oauth start):', e);
  }
  return undefined;
}

type StartOutcome =
  | { ok: true; url: string; apply: (res: NextResponse) => void }
  | { ok: false; response: NextResponse };

/** GET と POST で共通の中身。Google の URL を作り、PKCE の Cookie と戻り先の控えの動作を応答に当てる関数を返す。 */
async function startOAuth(request: Request, input: { provider: string; next: unknown }): Promise<StartOutcome> {
  const origin = getRequestOrigin(request);
  const { provider } = input;

  if (!PROVIDERS.has(provider)) {
    await logAudit({ action: 'auth.oauth.start', outcome: 'failure', detail: 'unsupported_provider', metadata: { provider } });
    return { ok: false, response: NextResponse.json({ error: 'Unsupported provider' }, { status: 400 }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    await logAudit({ action: 'auth.oauth.start', outcome: 'error', detail: 'missing_supabase_env' });
    return { ok: false, response: NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 }) };
  }

  // 戻りの URL に道筋も番号も載せない（Supabase の許可する戻り先の一致も短くなる）。
  const callbackUrl = new URL('/api/auth/oauth/callback', origin);

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
    return { ok: false, response: NextResponse.json({ error: 'OAuth start failed' }, { status: 502 }) };
  }

  // Google の URL を作れた後で控える。失敗しても Google のログインは止めず、古い Cookie は消す側へ倒れる。
  const { action: returnIntentAction } = await issueReturnIntent({ rawNext: input.next, purpose: 'login' });

  return {
    ok: true,
    url: data.url,
    apply(res) {
      res.headers.set('Cache-Control', 'no-store');
      res.headers.set('Referrer-Policy', 'no-referrer');
      for (const cookie of cookiesToSet) {
        res.cookies.set(cookie.name, cookie.value, cookie.options);
      }
      applyReturnIntentCookie(res, returnIntentAction);
    },
  };
}

export async function GET(request: Request) {
  try {
    const limited = await enforceStartRateLimit(request);
    if (limited) return limited;

    const url = new URL(request.url);
    const parsed = StartQuerySchema.safeParse({ provider: url.searchParams.get('provider') });

    if (!parsed.success) {
      await logAudit({ action: 'auth.oauth.start', outcome: 'failure', detail: 'invalid_query' });
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }

    // GET は戻り先を作らない（redirect_to / next は読まない）。残っている古い控えの Cookie は消す。
    const started = await startOAuth(request, { provider: parsed.data.provider, next: undefined });
    if (!started.ok) return started.response;

    const res = NextResponse.redirect(started.url, { status: 302 });
    started.apply(res);

    await logAudit({ action: 'auth.oauth.start', outcome: 'success', metadata: { provider: parsed.data.provider } });
    return res;
  } catch (err) {
    console.error('OAuth start error:', err);
    await logAudit({ action: 'auth.oauth.start', outcome: 'error', detail: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const limited = await enforceStartRateLimit(request);
    if (limited) return limited;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      await logAudit({ action: 'auth.oauth.start', outcome: 'failure', detail: 'invalid_body' });
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }

    const parsed = StartBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      await logAudit({ action: 'auth.oauth.start', outcome: 'failure', detail: 'invalid_body' });
      return NextResponse.json({ error: 'Bad Request' }, { status: 400 });
    }

    const started = await startOAuth(request, { provider: parsed.data.provider, next: parsed.data.next });
    if (!started.ok) return started.response;

    // リダイレクトにせず URL を本文で返す。端末が自分で移る（CSP の form-action 'self' を避ける）。
    const res = NextResponse.json({ url: started.url }, { status: 200 });
    started.apply(res);

    await logAudit({ action: 'auth.oauth.start', outcome: 'success', metadata: { provider: parsed.data.provider } });
    return res;
  } catch (err) {
    console.error('OAuth start error:', err);
    await logAudit({ action: 'auth.oauth.start', outcome: 'error', detail: String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
