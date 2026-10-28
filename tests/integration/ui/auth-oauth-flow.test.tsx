import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LoginModal from '@/components/LoginModal';
import RegisterModal from '@/components/RegisterModal';
import { LoginProvider } from '@/contexts/LoginContext';
import { GET as oauthStart, POST as oauthStartPost } from '@/app/api/auth/oauth/start/route';
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
  cookies: {
    jar: Map<string, { value: string; options?: unknown }>;
    set: (nameOrCookie: string | { name: string; value: string }, value?: string, options?: unknown) => void;
  };
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
const mockCreateReturnIntent = jest.fn();
const mockConsumeReturnIntent = jest.fn();

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
        // 戻り先の控えの Cookie は { name, value, ...属性 } の形で渡される
        set: (nameOrCookie, value, options) => {
          if (typeof nameOrCookie === 'object') {
            jar.set(nameOrCookie.name, { value: nameOrCookie.value, options: nameOrCookie });
          } else {
            jar.set(nameOrCookie, { value: value as string, options });
          }
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
// 戻り先の控えの保存だけを差し替える（確かめと Cookie の動作、出口の解決は本物）
jest.mock('@/features/auth/return-intent/return-intent-store', () => ({
  ...jest.requireActual('@/features/auth/return-intent/return-intent-store'),
  createReturnIntent: (...args: unknown[]) => mockCreateReturnIntent(...args),
  consumeReturnIntent: (...args: unknown[]) => mockConsumeReturnIntent(...args),
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

function startPostRequest(body: unknown) {
  return new Request(new URL('/api/auth/oauth/start', ORIGIN).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startPost(next?: unknown) {
  return asFake(await oauthStartPost(startPostRequest(next === undefined ? { provider: 'google' } : { provider: 'google', next })));
}

// ブラウザが次の要求に付ける Cookie。消された物（空の値）は付けない。
function pkceCookieHeader(started: FakeResponse) {
  return Array.from(started.cookies.jar.entries())
    .filter(([, { value }]) => value !== '')
    .map(([name, { value }]) => `${name}=${value}`)
    .join('; ');
}

// GET の開始は Location、POST の開始は本文の url に Google の同意の画面の住所が入る。
function authorizeUrlOf(started: FakeResponse) {
  return started.headers.get('location') ?? (started.body as { url: string }).url;
}

// Google が戻してくる形を作る。戻り先は開始の窓口が Google へ渡した値をそのまま使う。
async function comeBack(started: FakeResponse, code = 'good-code', withCookie = true) {
  const authorize = new URL(authorizeUrlOf(started));
  const callback = new URL(authorize.searchParams.get('redirect_to') as string);
  callback.searchParams.set('code', code);
  const headers: Record<string, string> = withCookie ? { cookie: pkceCookieHeader(started) } : {};
  return asFake(await oauthCallback(new Request(callback.toString(), { headers })));
}

// 画面の fetch を開始の窓口の本物につなぐ。画面が受け取る応答と、窓口が作った Cookie（開始の応答）を控える。
let lastStarted: FakeResponse | null = null;
function routeFetchToOauthStart() {
  lastStarted = null;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/oauth/start') {
      const res = asFake(await oauthStartPost(new Request(new URL(url, ORIGIN).toString(), init)));
      lastStarted = res;
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ authenticated: false }) } as unknown as Response;
  }) as unknown as typeof fetch;
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
    // 1 回で使い切る控えの表の写し（番号は固定。作った道筋を、用途が合う最初の 1 回だけ返す）
    const intents = new Map<string, { returnPath: string; purpose: string; used: boolean }>();
    mockCreateReturnIntent.mockImplementation(async ({ returnPath, purpose }: { returnPath: string; purpose: string }) => {
      intents.set('T'.repeat(43), { returnPath, purpose, used: false });
      return { token: 'T'.repeat(43), maxAgeSeconds: 900 };
    });
    mockConsumeReturnIntent.mockImplementation(async ({ token, purpose }: { token: string; purpose: string }) => {
      const intent = intents.get(token);
      if (!intent || intent.used || intent.purpose !== purpose) return null;
      intent.used = true;
      return intent.returnPath;
    });
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
    test('FLOW-AUTH-002 ログインの画面の Google のボタンは開始の窓口へ POST し、返った Google の住所へ移る', async () => {
      routeFetchToOauthStart();
      await mount(<LoginModal open={true} />);

      fireEvent.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
      const target = new URL(mockNavigate.mock.calls[0][0] as string);
      expect(target.origin).toBe('https://accounts.example.test');
      const startCall = (global.fetch as jest.Mock).mock.calls.find((call) => String(call[0]) === '/api/auth/oauth/start');
      expect(startCall[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      expect(JSON.parse(startCall[1].body)).toEqual({ provider: 'google' });
      expect(mockCreateReturnIntent).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-002 会員登録の画面の Google のボタンも同じ窓口へ POST して移る', async () => {
      routeFetchToOauthStart();
      await mount(<RegisterModal />);

      fireEvent.click(screen.getByRole('button', { name: /Googleで登録/ }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
      expect(new URL(mockNavigate.mock.calls[0][0] as string).origin).toBe('https://accounts.example.test');
    });

    test('FLOW-AUTH-002 戻り先つきの画面から、控えて Google へ移り、戻りで元の頁へ着く（番号は URL に載らない）', async () => {
      mockState.role = 'user';
      routeFetchToOauthStart();
      await mount(<LoginModal open={true} returnTo="/item/3?color=red" />);

      fireEvent.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
      expect(mockCreateReturnIntent).toHaveBeenCalledWith({ returnPath: '/item/3?color=red', purpose: 'login' });
      expect(mockNavigate.mock.calls[0][0]).not.toContain('T'.repeat(43));
      const res = await comeBack(lastStarted as FakeResponse);
      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/item/3?color=red');
    });

    test('FLOW-AUTH-002 戻り先つきの会員登録の画面も、Google のログインの戻り先として控える', async () => {
      routeFetchToOauthStart();
      await mount(<RegisterModal returnTo="/account" />);

      fireEvent.click(screen.getByRole('button', { name: /Googleで登録/ }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
      expect(mockCreateReturnIntent).toHaveBeenCalledWith({ returnPath: '/account', purpose: 'login' });
    });

    test('FLOW-AUTH-002 開始の窓口が失敗したら移らない', async () => {
      routeFetchToOauthStart();
      mockState.authorizeError = true;
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await mount(<LoginModal open={true} />);

      fireEvent.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

      await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/auth/oauth/start', expect.anything()));
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockNavigate).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 画面はパスワードの窓口を呼ばず、認証コードの画面へも移らない', async () => {
      routeFetchToOauthStart();
      await mount(<LoginModal open={true} />);

      fireEvent.click(screen.getByRole('button', { name: /Googleでサインイン/ }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledTimes(1));
      const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
      expect(urls).not.toContain('/api/auth/login');
      expect(urls).not.toContain('/api/auth/otp/verify');
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('開始の窓口', () => {
    test('FLOW-AUTH-002 Google の同意の画面へ 302 で送り、毎回アカウントを選ばせる', async () => {
      const res = await start();

      expect(res.status).toBe(302);
      const authorize = new URL(res.headers.get('location') as string);
      expect(authorize.origin).toBe('https://accounts.example.test');
      expect(authorize.searchParams.get('prompt')).toBe('select_account');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    });

    test('FLOW-AUTH-002 PKCE の検証の値を窓口の Cookie に持たせ、戻りの住所には道筋も番号も載せない', async () => {
      const res = await start();

      expect(res.cookies.jar.get(PKCE_COOKIE)).toEqual({ value: 'verifier-1', options: { httpOnly: true } });
      const callback = new URL(new URL(res.headers.get('location') as string).searchParams.get('redirect_to') as string);
      expect(callback.origin + callback.pathname).toBe(`${ORIGIN}/api/auth/oauth/callback`);
      expect(callback.search).toBe('');
    });

    test('FLOW-AUTH-002 GET は redirect_to を読まず、戻り先の控えを作らず、残っている控えの Cookie を消す', async () => {
      const res = await start('/account/orders');

      expect(mockCreateReturnIntent).not.toHaveBeenCalled();
      expect(res.cookies.jar.get('sb-return-intent')).toMatchObject({ value: '', options: expect.objectContaining({ maxAge: 0 }) });
      const callback = new URL(new URL(res.headers.get('location') as string).searchParams.get('redirect_to') as string);
      expect(callback.search).toBe('');
    });

    test('FLOW-AUTH-002 POST は 200 の { url } を返し、リダイレクトにしない（CSP の form-action のため）', async () => {
      const res = await startPost('/account/orders');

      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      const authorize = new URL((res.body as { url: string }).url);
      expect(authorize.origin).toBe('https://accounts.example.test');
      expect(authorize.searchParams.get('prompt')).toBe('select_account');
      expect(res.cookies.jar.get(PKCE_COOKIE)).toBeDefined();
    });

    test('FLOW-AUTH-002 内部の道の送り先は控えて、番号は Cookie だけで渡す（本文にも戻りの住所にも載せない）', async () => {
      const res = await startPost('/account/orders');

      expect(mockCreateReturnIntent).toHaveBeenCalledWith({ returnPath: '/account/orders', purpose: 'login' });
      expect(res.cookies.jar.get('sb-return-intent')).toMatchObject({
        value: 'T'.repeat(43),
        options: expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 900 }),
      });
      expect(JSON.stringify(res.body)).not.toContain('T'.repeat(43));
      const callback = new URL(new URL((res.body as { url: string }).url).searchParams.get('redirect_to') as string);
      expect(callback.search).toBe('');
    });

    test.each([
      ['外の住所', 'https://evil.example/steal'],
      ['2本のスラッシュ', '//evil.example'],
      ['バックスラッシュ', '/\\evil.example'],
      ['道の形でない文字', 'account'],
      ['タブを含む道', '/%09/evil.example'],
      ['数値', 123],
    ])('FLOW-AUTH-002 送り先に%sを渡しても開始は 200 のまま、控えを作らず Cookie を消す', async (_label, next) => {
      const res = await startPost(next);

      expect(res.status).toBe(200);
      expect(mockCreateReturnIntent).not.toHaveBeenCalled();
      expect(res.cookies.jar.get('sb-return-intent')).toMatchObject({ value: '', options: expect.objectContaining({ maxAge: 0 }) });
    });

    test('FLOW-AUTH-002 送り先を渡さなければ控えを作らず、古い控えの Cookie を消す', async () => {
      const res = await startPost();

      expect(res.status).toBe(200);
      expect(mockCreateReturnIntent).not.toHaveBeenCalled();
      expect(res.cookies.jar.get('sb-return-intent')).toMatchObject({ value: '', options: expect.objectContaining({ maxAge: 0 }) });
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

      const res = await start();

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'OAuth start failed' });
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 Supabase の設定が無ければ 500 の JSON を返す', async () => {
      delete env.NEXT_PUBLIC_SUPABASE_URL;

      const res = await start();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Server misconfiguration' });
    });

    test('FLOW-AUTH-002 回数制限に当たったら、その応答をそのまま返す', async () => {
      mockState.rateLimited = 'reply';

      const res = await start();

      expect(res.status).toBe(429);
      expect(mockCreateServerClient).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-002 回数制限の部品が落ちたら 500 で入口を止める（SEC-AUTH-013-AC-02）', async () => {
      mockState.rateLimited = 'throw';
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await start();

      expect(res.status).toBe(500);
      expect(mockCreateServerClient).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 予期しない例外は 500 の JSON で返す', async () => {
      mockCreateServerClient.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await start();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      errorSpy.mockRestore();
    });
  });

  describe('戻りの窓口と行き先', () => {
    test('FLOW-AUTH-002 戻り先を控えていない一般の会員は /auth/verified を通らず / へ 303 で送る', async () => {
      mockState.role = 'user';

      const res = await comeBack(await start());

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(mockConsumeReturnIntent).not.toHaveBeenCalled();
    });

    test('FLOW-AUTH-002 役割が無い会員も一般として / へ送る', async () => {
      mockState.role = undefined;

      const res = await comeBack(await start());

      expect(locationPath(res)).toBe('/');
    });

    test.each(['admin', 'supporter'] as const)('FLOW-AUTH-002 %s は /auth/verified へ送り、そこで TOTP を通す（控えは使い切らない）', async (role) => {
      mockState.role = role;

      const res = await comeBack(await startPost('/admin/orders'));

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/auth/verified');
      expect(mockConsumeReturnIntent).not.toHaveBeenCalled();
      expect(res.cookies.jar.get('sb-return-intent')).toBeUndefined();
    });

    test('FLOW-AUTH-002 開始で控えた内部の道へ、保存の後に控えを使い切って 303 で送り、控えの Cookie を消す', async () => {
      mockState.role = 'user';

      const res = await comeBack(await startPost('/item/3?color=red'));

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/item/3?color=red');
      expect(mockConsumeReturnIntent).toHaveBeenCalledWith({ token: 'T'.repeat(43), purpose: 'login', userId: 'user-1' });
      expect(res.cookies.jar.get('sb-return-intent')).toMatchObject({
        value: '',
        options: expect.objectContaining({ maxAge: 0 }),
      });
      expect(mockPersist.mock.invocationCallOrder[0]).toBeLessThan(mockConsumeReturnIntent.mock.invocationCallOrder[0]);
    });

    test('FLOW-AUTH-002 使った控えは 2 回目の戻りでは使えず / になる', async () => {
      mockState.role = 'user';
      const started = await startPost('/item/3');

      const first = await comeBack(started);
      const second = await comeBack(started);

      expect(locationPath(first)).toBe('/item/3');
      expect(locationPath(second)).toBe('/');
    });

    test('FLOW-AUTH-002 控えが /admin を指していても一般の会員は / へ送る（出口で役割を確かめ直す）', async () => {
      mockState.role = 'user';

      const res = await comeBack(await startPost('/admin'));

      expect(locationPath(res)).toBe('/');
    });

    test.each([
      ['内部の道', '/account/orders'],
      ['外の住所', 'https://evil.example/steal'],
      ['2本のスラッシュ', '//evil.example'],
      ['バックスラッシュ', '/\\evil.example'],
    ])('FLOW-AUTH-002 戻りの URL に古い形の next（%s）が付いても読まず、/ へ送る', async (_label, next) => {
      mockState.role = 'user';
      const started = await start();
      const callback = new URL(new URL(authorizeUrlOf(started)).searchParams.get('redirect_to') as string);
      callback.searchParams.set('code', 'good-code');
      callback.searchParams.set('next', next);

      const res = asFake(
        await oauthCallback(new Request(callback.toString(), { headers: { cookie: pkceCookieHeader(started) } })),
      );

      expect(new URL(res.headers.get('location') as string).origin).toBe(ORIGIN);
      expect(locationPath(res)).toBe('/');
    });

    test('FLOW-AUTH-002 メールの認証コードの画面を通らずに最後の行き先へ着く', async () => {
      const res = await comeBack(await start());

      expect(locationPath(res)).not.toContain('/login');
    });

    test('FLOW-AUTH-002 交換した session を保存し、認証の Cookie を応答に付ける', async () => {
      mockState.role = 'user';

      const res = await comeBack(await start());

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
      const res = await comeBack(await start());

      const location = res.headers.get('location') as string;
      expect(location).not.toContain('access-1');
      expect(location).not.toContain('refresh-1');
      expect(location).not.toContain('good-code');
    });

    test('FLOW-AUTH-002 保存に失敗しても交換済みの応答を 303 のまま返し、理由を監査に残す', async () => {
      mockPersist.mockResolvedValue({ ok: false, error: 'db down' });

      const res = await comeBack(await startPost('/item/3'));

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/');
      expect(mockConsumeReturnIntent).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: db down' }),
      );
    });

    test('FLOW-AUTH-002 保存が理由を返さずに失敗しても 303 のまま、理由は unknown で残す', async () => {
      mockPersist.mockResolvedValue(undefined);

      const res = await comeBack(await start());

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'session_persist_failed: unknown' }),
      );
    });

    test('FLOW-AUTH-002 保存が例外を投げても利用者を JSON で止めず 303 で進める', async () => {
      mockPersist.mockRejectedValue(new Error('persist exploded'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await comeBack(await startPost('/item/3'));

      expect(res.status).toBe(303);
      expect(locationPath(res)).toBe('/');
      expect(mockConsumeReturnIntent).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'Error: persist exploded' }),
      );
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 code が無ければ画面へ戻さず 400 の JSON を返す', async () => {
      const res = asFake(await oauthCallback(new Request(`${ORIGIN}/api/auth/oauth/callback?next=%2Faccount`)));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Bad Request' });
      expect(res.headers.get('location')).toBeNull();
    });

    test('FLOW-AUTH-002 検証の Cookie が無い戻りは交換できず 502 の JSON を返す', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await comeBack(await start(), 'good-code', false);

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'OAuth exchange failed' });
      expect(mockPersist).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    test('FLOW-AUTH-002 偽りの code は交換できず 502 を返し、失敗を監査に残す', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await comeBack(await start(), 'forged-code');

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
