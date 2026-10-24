import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import LoginModal from '@/components/LoginModal';
import RegisterModal from '@/components/RegisterModal';
import { LoginProvider } from '@/contexts/LoginContext';
import { GET as oauthStart } from '@/app/api/auth/oauth/start/route';
import { GET as oauthCallback } from '@/app/api/auth/oauth/callback/route';

/**
 * Google のログインの道（FLOW-AUTH-002）。ボタンの押下から、開始の窓口、戻りの窓口、最後の行き先までを
 * 画面の部品・LoginProvider・2つの窓口の本物でつなぐ。差し替えるのは Supabase の SSR クライアント
 * （PKCE の検証の値を Cookie に溜め、戻りで読めなければ交換を失敗させる偽物）、Next の応答、監査、
 * 回数制限、セッションの保存、ブラウザの移動だけ。
 */

type FakeResponse = {
  status: number;
  body?: unknown;
  headers: { get: (name: string) => string | null; set: (name: string, value: string) => void };
  cookies: { jar: Map<string, { value: string; options?: unknown }>; set: (name: string, value: string, options?: unknown) => void };
  json: () => Promise<unknown>;
};

const mockState = {
  role: 'user' as 'admin' | 'supporter' | 'user' | undefined,
  authorizeError: false,
  exchangeError: false,
  rateLimited: false as false | 'reply' | 'throw',
};

const mockNavigate = jest.fn();
const mockReplace = jest.fn();
const mockSignOut = jest.fn();
const mockPersist = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
const mockCreateServerClient = jest.fn();

jest.mock('next/server', () => {
  const build = (status: number, body?: unknown): FakeResponse => {
    const headers = new Map<string, string>();
    const jar = new Map<string, { value: string; options?: unknown }>();
    return {
      status,
      body,
      headers: {
        get: (name) => headers.get(name.toLowerCase()) ?? null,
        set: (name, value) => {
          headers.set(name.toLowerCase(), value);
        },
      },
      cookies: {
        jar,
        set: (name, value, options) => {
          jar.set(name, { value, options });
        },
      },
      json: async () => body,
    };
  };
  return {
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => build(init?.status ?? 200, body),
      redirect: (url: URL, init?: { status?: number }) => {
        const res = build(init?.status ?? 302);
        res.headers.set('location', url.toString());
        return res;
      },
    },
  };
});
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: async () => {
    if (mockState.rateLimited === 'throw') throw new Error('rate limit store down');
    return mockState.rateLimited === 'reply' ? { status: 429, rateLimited: true } : undefined;
  },
}));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => mockPersist(...args),
}));
jest.mock('@/lib/supabase/client', () => ({ supabase: { auth: { signOut: (...a: unknown[]) => mockSignOut(...a) } } }));
jest.mock('@/lib/browser-location', () => ({ navigateBrowser: (...args: unknown[]) => mockNavigate(...args) }));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => mockReplace(...args) }),
}));
jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});
jest.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

const ORIGIN = 'http://localhost:3000';
const PKCE_COOKIE = 'sb-pkce-code-verifier';

type CookieAdapter = {
  getAll: () => Array<{ name: string; value: string }>;
  setAll: (cookies: Array<{ name: string; value: string; options?: unknown }>) => void;
};

// 開始で検証の値を Cookie に溜め、戻りでその Cookie が付いていなければ交換を断る。
mockCreateServerClient.mockImplementation((_url: string, _key: string, options: { cookies: CookieAdapter }) => ({
  auth: {
    signInWithOAuth: async ({ options: oauth }: { options: { redirectTo: string; queryParams: Record<string, string> } }) => {
      if (mockState.authorizeError) return { data: { url: null }, error: new Error('authorize failed') };
      options.cookies.setAll([{ name: PKCE_COOKIE, value: 'verifier-1', options: { httpOnly: true } }]);
      const authorize = new URL('https://accounts.example.test/authorize');
      authorize.searchParams.set('redirect_to', oauth.redirectTo);
      authorize.searchParams.set('prompt', oauth.queryParams.prompt);
      return { data: { url: authorize.toString() }, error: null };
    },
    exchangeCodeForSession: async (code: string) => {
      const verifier = options.cookies.getAll().find((c) => c.name === PKCE_COOKIE);
      if (mockState.exchangeError || !verifier || code !== 'good-code') {
        return { data: { session: null, user: null }, error: new Error('exchange failed') };
      }
      return {
        data: {
          session: {
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            expires_at: 1_900_000_000,
            token_type: 'bearer',
          },
          user: {
            id: 'user-1',
            email: 'member@example.com',
            app_metadata: mockState.role ? { role: mockState.role } : {},
          },
        },
        error: null,
      };
    },
  },
}));

// 最初の me の取得が描画の後に返るので、act の中で待ち切ってから返す。
async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(<LoginProvider>{ui}</LoginProvider>);
  });
}

function asFake(res: Response): FakeResponse {
  return res as unknown as FakeResponse;
}

function startUrl(redirectTo?: string) {
  const url = new URL('/api/auth/oauth/start', ORIGIN);
  url.searchParams.set('provider', 'google');
  if (redirectTo !== undefined) url.searchParams.set('redirect_to', redirectTo);
  return url.toString();
}

async function start(redirectTo?: string) {
  return asFake(await oauthStart(new Request(startUrl(redirectTo))));
}

function pkceCookieHeader(started: FakeResponse) {
  return Array.from(started.cookies.jar.entries())
    .map(([name, { value }]) => `${name}=${value}`)
    .join('; ');
}

// Google が戻してくる形を作る。戻り先は開始の窓口が Google へ渡した値をそのまま使う。
async function comeBack(started: FakeResponse, code = 'good-code', withCookie = true) {
  const authorize = new URL(started.headers.get('location') as string);
  const callback = new URL(authorize.searchParams.get('redirect_to') as string);
  callback.searchParams.set('code', code);
  const headers: Record<string, string> = withCookie ? { cookie: pkceCookieHeader(started) } : {};
  return asFake(await oauthCallback(new Request(callback.toString(), { headers })));
}

function locationPath(res: FakeResponse) {
  const location = res.headers.get('location');
  return location ? new URL(location).pathname + new URL(location).search : null;
}

describe('Google のログインの画面遷移', () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { ...env };

  beforeEach(() => {
    jest.clearAllMocks();
    mockState.role = 'user';
    mockState.authorizeError = false;
    mockState.exchangeError = false;
    mockState.rateLimited = false;
    mockPersist.mockImplementation(async (res: FakeResponse) => {
      res.cookies.set('sb-access-token', 'access-1', { httpOnly: true });
      return { ok: true };
    });
    env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.test';
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    delete env.SUPABASE_URL;
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ authenticated: false }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    env.NEXT_PUBLIC_SUPABASE_URL = saved.NEXT_PUBLIC_SUPABASE_URL;
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    env.SUPABASE_URL = saved.SUPABASE_URL;
  });

  describe('画面から開始の窓口へ', () => {
    test('FLOW-AUTH-002 ログインの画面の Google のボタンは窓口の開始へ移る', async () => {
      await mount(<LoginModal open={true} />);

      fireEvent.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/api/auth/oauth/start?provider=google&redirect_to=%2Fauth%2Fverified');
    });

    test('FLOW-AUTH-002 会員登録の画面の Google のボタンも同じ窓口の開始へ移る', async () => {
      await mount(<RegisterModal />);

      fireEvent.click(screen.getByRole('button', { name: /Googleで登録/ }));

      expect(mockNavigate).toHaveBeenCalledWith('/api/auth/oauth/start?provider=google&redirect_to=%2Fauth%2Fverified');
    });

    test('FLOW-AUTH-002 画面はパスワードの窓口を呼ばず、認証コードの画面へも移らない', async () => {
      await mount(<LoginModal open={true} />);

      fireEvent.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

      const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
      expect(urls).not.toContain('/api/auth/login');
      expect(urls).not.toContain('/api/auth/otp/verify');
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('開始の窓口', () => {
    test('FLOW-AUTH-002 Google の同意の画面へ 302 で送り、毎回アカウントを選ばせる', async () => {
      const res = await start('/auth/verified');

      expect(res.status).toBe(302);
      const authorize = new URL(res.headers.get('location') as string);
      expect(authorize.origin).toBe('https://accounts.example.test');
      expect(authorize.searchParams.get('prompt')).toBe('select_account');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    });

    test('FLOW-AUTH-002 PKCE の検証の値を窓口の Cookie に持たせ、戻り先は窓口の戻りにする', async () => {
      const res = await start('/auth/verified');

      expect(res.cookies.jar.get(PKCE_COOKIE)).toEqual({ value: 'verifier-1', options: { httpOnly: true } });
      const callback = new URL(new URL(res.headers.get('location') as string).searchParams.get('redirect_to') as string);
      expect(callback.origin + callback.pathname).toBe(`${ORIGIN}/api/auth/oauth/callback`);
      expect(callback.searchParams.get('next')).toBe('/auth/verified');
    });

    test.each([
      ['外の住所', 'https://evil.example/steal'],
      ['2本のスラッシュ', '//evil.example'],
      ['バックスラッシュ', '/\\evil.example'],
      ['道の形でない文字', 'account'],
    ])('FLOW-AUTH-002 送り先に%sを渡すと既定の /auth/verified に替える', async (_label, redirectTo) => {
      const res = await start(redirectTo);

      const callback = new URL(new URL(res.headers.get('location') as string).searchParams.get('redirect_to') as string);
      expect(callback.searchParams.get('next')).toBe('/auth/verified');
    });

    test('FLOW-AUTH-002 内部の道の送り先はそのまま戻りへ運ぶ', async () => {
      const res = await start('/account/orders');

      const callback = new URL(new URL(res.headers.get('location') as string).searchParams.get('redirect_to') as string);
      expect(callback.searchParams.get('next')).toBe('/account/orders');
    });

    test('FLOW-AUTH-002 送り先を渡さなければ既定の /auth/verified にする', async () => {
      const res = await start();

      const callback = new URL(new URL(res.headers.get('location') as string).searchParams.get('redirect_to') as string);
      expect(callback.searchParams.get('next')).toBe('/auth/verified');
    });

    test('FLOW-AUTH-002 対応しない供給元は画面へ戻さず 400 の JSON を返す', async () => {
      const res = asFake(await oauthStart(new Request(`${ORIGIN}/api/auth/oauth/start?provider=github`)));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Unsupported provider' });
      expect(res.headers.get('location')).toBeNull();
    });

    test('FLOW-AUTH-002 供給元が無ければ 400 を返す', async () => {
      const res = asFake(await oauthStart(new Request(`${ORIGIN}/api/auth/oauth/start`)));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Bad Request' });
    });

    test('FLOW-AUTH-002 同意の画面の住所を作れなければ 502 の JSON を返す', async () => {
      mockState.authorizeError = true;
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await start('/auth/verified');

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'OAuth start failed' });
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 Supabase の設定が無ければ 500 の JSON を返す', async () => {
      delete env.NEXT_PUBLIC_SUPABASE_URL;

      const res = await start('/auth/verified');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Server misconfiguration' });
    });

    test('FLOW-AUTH-002 回数制限に当たったら、その応答をそのまま返す', async () => {
      mockState.rateLimited = 'reply';

      const res = await start('/auth/verified');

      expect(res.status).toBe(429);
      expect(mockCreateServerClient).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-002 回数制限の部品が落ちても入口を止めない', async () => {
      mockState.rateLimited = 'throw';
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await start('/auth/verified');

      expect(res.status).toBe(302);
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 予期しない例外は 500 の JSON で返す', async () => {
      mockCreateServerClient.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await start('/auth/verified');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      errorSpy.mockRestore();
    });
  });

  describe('戻りの窓口と行き先', () => {
    test('FLOW-AUTH-002 一般の会員は既定の送り先なら /auth/verified を通らず /account へ 303 で送る', async () => {
      mockState.role = 'user';

      const res = await comeBack(await start('/auth/verified'));

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/account');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    });

    test('FLOW-AUTH-002 役割が無い会員も一般として /account へ送る', async () => {
      mockState.role = undefined;

      const res = await comeBack(await start('/auth/verified'));

      expect(locationPath(res)).toBe('/account');
    });

    test.each(['admin', 'supporter'] as const)('FLOW-AUTH-002 %s は /auth/verified へ送り、そこで TOTP を通す', async (role) => {
      mockState.role = role;

      const res = await comeBack(await start('/auth/verified'));

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/auth/verified');
    });

    test('FLOW-AUTH-002 既定でない内部の送り先は会員でもそのまま使う', async () => {
      mockState.role = 'user';

      const res = await comeBack(await start('/account/orders'));

      expect(locationPath(res)).toBe('/account/orders');
    });

    test.each([
      ['外の住所', 'https://evil.example/steal'],
      ['2本のスラッシュ', '//evil.example'],
      ['バックスラッシュ', '/\\evil.example'],
    ])('FLOW-AUTH-002 戻りでも送り先の%sは受けず、既定の行き先へ替える', async (_label, next) => {
      mockState.role = 'user';
      const started = await start('/auth/verified');
      const callback = new URL(new URL(started.headers.get('location') as string).searchParams.get('redirect_to') as string);
      callback.searchParams.set('code', 'good-code');
      callback.searchParams.set('next', next);

      const res = asFake(
        await oauthCallback(new Request(callback.toString(), { headers: { cookie: pkceCookieHeader(started) } })),
      );

      expect(new URL(res.headers.get('location') as string).origin).toBe(ORIGIN);
      expect(locationPath(res)).toBe('/account');
    });

    test('FLOW-AUTH-002 メールの認証コードの画面を通らずに最後の行き先へ着く', async () => {
      const res = await comeBack(await start('/auth/verified'));

      expect(locationPath(res)).not.toContain('/login');
    });

    test('FLOW-AUTH-002 交換した session を保存し、認証の Cookie を応答に付ける', async () => {
      mockState.role = 'user';

      const res = await comeBack(await start('/auth/verified'));

      expect(mockPersist).toHaveBeenCalledTimes(1);
      const [persistedRes, session, user] = mockPersist.mock.calls[0];
      expect(persistedRes).toBe(res);
      expect(session).toEqual({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        expires_at: 1_900_000_000,
        token_type: 'bearer',
      });
      expect(user).toMatchObject({ id: 'user-1', email: 'member@example.com' });
      expect(res.cookies.jar.get('sb-access-token')).toBeDefined();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.oauth.callback', outcome: 'success', resource_id: 'user-1' }),
      );
    });

    test('FLOW-AUTH-002 トークンは画面に渡さず、行き先の住所にも載せない', async () => {
      const res = await comeBack(await start('/auth/verified'));

      const location = res.headers.get('location') as string;
      expect(location).not.toContain('access-1');
      expect(location).not.toContain('refresh-1');
      expect(location).not.toContain('good-code');
    });

    test('FLOW-AUTH-002 保存に失敗しても交換済みの応答を 303 のまま返し、理由を監査に残す', async () => {
      mockPersist.mockResolvedValue({ ok: false, error: 'db down' });

      const res = await comeBack(await start('/auth/verified'));

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/account');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: db down' }),
      );
    });

    test('FLOW-AUTH-002 保存が理由を返さずに失敗しても 303 のまま、理由は unknown で残す', async () => {
      mockPersist.mockResolvedValue(undefined);

      const res = await comeBack(await start('/auth/verified'));

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'session_persist_failed: unknown' }),
      );
    });

    test('FLOW-AUTH-002 保存が例外を投げても利用者を JSON で止めず 303 で進める', async () => {
      mockPersist.mockRejectedValue(new Error('persist exploded'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await comeBack(await start('/auth/verified'));

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/account');
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'Error: persist exploded' }),
      );
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 code が無ければ画面へ戻さず 400 の JSON を返す', async () => {
      const res = asFake(await oauthCallback(new Request(`${ORIGIN}/api/auth/oauth/callback?next=%2Fauth%2Fverified`)));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Bad Request' });
      expect(res.headers.get('location')).toBeNull();
    });

    test('FLOW-AUTH-002 検証の Cookie が無い戻りは交換できず 502 の JSON を返す', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await comeBack(await start('/auth/verified'), 'good-code', false);

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'OAuth exchange failed' });
      expect(mockPersist).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 偽りの code は交換できず 502 を返し、失敗を監査に残す', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await comeBack(await start('/auth/verified'), 'forged-code');

      expect(res.status).toBe(502);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.oauth.callback', outcome: 'failure', detail: 'token_exchange_failed' }),
      );
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 session の形が足りなければ 502 を返す', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      mockCreateServerClient.mockImplementationOnce(() => ({
        auth: {
          exchangeCodeForSession: async () => ({
            data: { session: { access_token: '', refresh_token: 'r' }, user: { id: 'u', email: 'a@example.com' } },
            error: null,
          }),
        },
      }));

      const res = asFake(await oauthCallback(new Request(`${ORIGIN}/api/auth/oauth/callback?code=x`)));

      expect(res.status).toBe(502);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'invalid_token_response_shape' }),
      );
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 Supabase の設定が無ければ戻りも 500 の JSON を返す', async () => {
      delete env.NEXT_PUBLIC_SUPABASE_URL;

      const res = asFake(await oauthCallback(new Request(`${ORIGIN}/api/auth/oauth/callback?code=x`)));

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Server misconfiguration' });
    });

    test('FLOW-AUTH-002 回数制限に当たった戻りは、その応答をそのまま返す', async () => {
      mockState.rateLimited = 'reply';

      const res = asFake(await oauthCallback(new Request(`${ORIGIN}/api/auth/oauth/callback?code=x`)));

      expect(res.status).toBe(429);
      expect(mockPersist).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-002 戻りの予期しない例外は 500 の JSON で返す', async () => {
      mockCreateServerClient.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = asFake(await oauthCallback(new Request(`${ORIGIN}/api/auth/oauth/callback?code=x`)));

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      errorSpy.mockRestore();
    });
  });
});
