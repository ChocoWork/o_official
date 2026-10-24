/**
 * Google のログインの戻りの窓口の単体テスト（DD-AUTH-021）。
 * 外へ出る先（制限・監査・Supabase のクライアント・セッションの保存）だけ差し替え、
 * 住所の整形とゲストの印の読み取りは本物を通す。
 */

const enforceRateLimitMock = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimitMock(...args),
}));

const logAuditMock = jest.fn();
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

const persistSessionAndCookiesMock = jest.fn();
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => persistSessionAndCookiesMock(...args),
}));

type ClientOptions = {
  auth: { flowType: string; detectSessionInUrl: boolean };
  cookies: {
    getAll: () => Array<{ name: string; value: string }>;
    setAll: (cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => void;
  };
};

const exchangeCodeForSessionMock = jest.fn();
const createServerClientMock = jest.fn();
jest.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => createServerClientMock(...args),
}));

const cookieSetMock = jest.fn();
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
    redirect: (url: URL, init?: { status?: number }) => ({
      status: init?.status ?? 302,
      headers: new Map<string, string>([['location', url.toString()]]),
      cookies: { set: cookieSetMock },
    }),
  },
}));

const ENV_KEYS = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;
const CART_TOKEN = 'c'.repeat(43);
const WISHLIST_TOKEN = 'w'.repeat(43);

type ExchangeUser = {
  id: string;
  email?: string | null;
  app_metadata?: { role?: unknown };
};

function exchangeSuccess(user: ExchangeUser = { id: 'user-123', email: 'test@example.com' }) {
  return {
    data: {
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        expires_at: 1_900_000_000,
        token_type: 'bearer',
      },
      user,
    },
    error: null,
  };
}

function callbackRequest(query: string, cookie?: string) {
  return new Request(`http://localhost:3000/api/auth/oauth/callback${query}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

function lastClientOptions(): ClientOptions {
  const calls = createServerClientMock.mock.calls;
  return calls[calls.length - 1][2] as ClientOptions;
}

async function callGet(request: Request) {
  const { GET } = await import('@/app/api/auth/oauth/callback/route');
  return (await GET(request)) as unknown as {
    status: number;
    headers: Map<string, string>;
    json: () => Promise<{ error: string }>;
  };
}

describe('Google のログインの戻りの窓口', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    enforceRateLimitMock.mockResolvedValue(undefined);
    logAuditMock.mockResolvedValue(undefined);
    persistSessionAndCookiesMock.mockResolvedValue({ ok: true });
    exchangeCodeForSessionMock.mockResolvedValue(exchangeSuccess());
    createServerClientMock.mockImplementation(() => ({
      auth: { exchangeCodeForSession: exchangeCodeForSessionMock },
    }));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('正常フローと送り先', () => {
    it('DD-AUTH-021 一般の会員で既定の送り先なら 303 で /account へ送り、session を保存して success を残す', async () => {
      const res = await callGet(callbackRequest('?code=good&next=%2Fauth%2Fverified'));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/account');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(exchangeCodeForSessionMock).toHaveBeenCalledWith('good');
      expect(lastClientOptions().auth).toEqual({ flowType: 'pkce', detectSessionInUrl: false });
      expect(enforceRateLimitMock).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'auth:oauth:callback', limit: 50, windowSeconds: 600 })
      );
      expect(persistSessionAndCookiesMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 303 }),
        {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          expires_at: 1_900_000_000,
          token_type: 'bearer',
        },
        expect.objectContaining({ id: 'user-123', email: 'test@example.com' }),
        { cartToken: null, wishlistToken: null }
      );
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.callback',
        outcome: 'success',
        actor_email: 'test@example.com',
        resource_id: 'user-123',
      });
    });

    it('DD-AUTH-021 next が無い一般の会員も既定の送り先とみなして /account へ送る', async () => {
      const res = await callGet(callbackRequest('?code=good'));

      expect(res.headers.get('location')).toBe('http://localhost:3000/account');
    });

    it('DD-AUTH-021 next が空でも無いのと同じに扱う', async () => {
      const res = await callGet(callbackRequest('?code=good&next='));

      expect(res.headers.get('location')).toBe('http://localhost:3000/account');
    });

    it.each(['admin', 'supporter'])('DD-AUTH-021 役割が %s なら既定の /auth/verified へ送る', async (role) => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(
        exchangeSuccess({ id: 'staff-1', email: 'staff@example.com', app_metadata: { role } })
      );

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/verified');
    });

    it('DD-AUTH-021 一般の会員でも既定でない送り先を指定すればその道へ送る', async () => {
      const res = await callGet(callbackRequest('?code=good&next=%2Fcheckout'));

      expect(res.headers.get('location')).toBe('http://localhost:3000/checkout');
    });

    it('DD-AUTH-021 管理者が既定でない送り先を指定してもその道へ送る', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(
        exchangeSuccess({ id: 'staff-1', email: 'staff@example.com', app_metadata: { role: 'admin' } })
      );

      const res = await callGet(callbackRequest('?code=good&next=%2Fadmin'));

      expect(res.headers.get('location')).toBe('http://localhost:3000/admin');
    });

    it('DD-AUTH-021 外の住所の next は既定へ戻し、一般の会員なら /account にする', async () => {
      const res = await callGet(callbackRequest('?code=good&next=https%3A%2F%2Fevil.example%2F'));

      expect(res.headers.get('location')).toBe('http://localhost:3000/account');
    });

    it.each([
      ['役割が user', { role: 'user' }],
      ['役割が無い', {}],
      ['app_metadata が無い', undefined],
      ['許可の3つに無い役割', { role: 'owner' }],
      ['文字でない役割', { role: 42 }],
    ])('DD-AUTH-021 %s なら user とみなして /account へ送る', async (_label, appMetadata) => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(
        exchangeSuccess({ id: 'user-9', email: 'u@example.com', app_metadata: appMetadata })
      );

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.headers.get('location')).toBe('http://localhost:3000/account');
    });

    it('DD-AUTH-021 ライブラリが溜めた Cookie を 303 の応答へ付け替える', async () => {
      exchangeCodeForSessionMock.mockImplementationOnce(async () => {
        lastClientOptions().cookies.setAll([
          { name: 'sb-session', value: 'v', options: { httpOnly: false, path: '/' } },
          { name: 'sb-plain', value: 'p' },
        ]);
        return exchangeSuccess();
      });

      await callGet(callbackRequest('?code=good'));

      expect(cookieSetMock).toHaveBeenCalledTimes(2);
      expect(cookieSetMock).toHaveBeenNthCalledWith(1, 'sb-session', 'v', { httpOnly: false, path: '/' });
      expect(cookieSetMock).toHaveBeenNthCalledWith(2, 'sb-plain', 'p', undefined);
    });

    it('DD-AUTH-021 溜まった Cookie が無ければ Cookie を付けない', async () => {
      await callGet(callbackRequest('?code=good'));

      expect(cookieSetMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-021 ゲストのカート・お気に入りの印を添えてセッションを保存する', async () => {
      await callGet(callbackRequest('?code=good', `cart=${CART_TOKEN}; wishlist=${WISHLIST_TOKEN}`));

      expect(persistSessionAndCookiesMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { cartToken: CART_TOKEN, wishlistToken: WISHLIST_TOKEN }
      );
    });
  });

  describe('回数の制限', () => {
    it('DD-AUTH-021 回数の制限が応答を返したらそのまま返し、先へ進まない', async () => {
      const limited = { status: 429 };
      enforceRateLimitMock.mockResolvedValueOnce(limited);

      const res = await callGet(callbackRequest('?code=good'));

      expect(res).toBe(limited);
      expect(createServerClientMock).not.toHaveBeenCalled();
      expect(logAuditMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-021 回数の制限の呼び出しが投げても記録して先へ進む', async () => {
      enforceRateLimitMock.mockRejectedValueOnce(new Error('redis down'));

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(303);
      expect(console.error).toHaveBeenCalledWith('Rate limit middleware error (oauth callback):', expect.any(Error));
    });
  });

  describe('問い合わせと環境変数', () => {
    it.each([
      ['code が無い', '?next=%2Fauth%2Fverified'],
      ['code が空', '?code=&next=%2Fauth%2Fverified'],
      ['問い合わせが無い', ''],
    ])('DD-AUTH-021 %s と missing_code を残して 400', async (_label, query) => {
      const res = await callGet(callbackRequest(query));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Bad Request');
      expect(logAuditMock).toHaveBeenCalledWith({ action: 'auth.oauth.callback', outcome: 'failure', detail: 'missing_code' });
      expect(createServerClientMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-021 SUPABASE_URL があればそれを使う', async () => {
      process.env.SUPABASE_URL = 'https://server.supabase.co';

      await callGet(callbackRequest('?code=good'));

      expect(createServerClientMock.mock.calls[0][0]).toBe('https://server.supabase.co');
      expect(createServerClientMock.mock.calls[0][1]).toBe('anon');
    });

    it('DD-AUTH-021 SUPABASE_URL が無ければ NEXT_PUBLIC_SUPABASE_URL を使う', async () => {
      await callGet(callbackRequest('?code=good'));

      expect(createServerClientMock.mock.calls[0][0]).toBe('https://example.supabase.co');
    });

    it('DD-AUTH-021 URL が両方無ければ missing_supabase_env を残して 500', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Server misconfiguration');
      expect(logAuditMock).toHaveBeenCalledWith({ action: 'auth.oauth.callback', outcome: 'error', detail: 'missing_supabase_env' });
      expect(createServerClientMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-021 anon の鍵が無ければ missing_supabase_env を残して 500', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(500);
      expect(logAuditMock).toHaveBeenCalledWith({ action: 'auth.oauth.callback', outcome: 'error', detail: 'missing_supabase_env' });
    });
  });

  describe('交換の失敗', () => {
    it('DD-AUTH-021 交換が誤りを返したら誤りの文を添えて token_exchange_failed を残し 502', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: 'invalid_grant' } });

      const res = await callGet(callbackRequest('?code=bad'));

      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('OAuth exchange failed');
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'token_exchange_failed',
        metadata: { error: 'invalid_grant' },
      });
      expect(persistSessionAndCookiesMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-021 誤りの文が無ければ監査の error は null', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce({ data: { session: null, user: null }, error: {} });

      await callGet(callbackRequest('?code=bad'));

      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'token_exchange_failed', metadata: { error: null } })
      );
    });

    it('DD-AUTH-021 誤りが無くても session が無ければ 502 にし、error は null', async () => {
      const ok = exchangeSuccess();
      exchangeCodeForSessionMock.mockResolvedValueOnce({ data: { session: null, user: ok.data.user }, error: null });

      const res = await callGet(callbackRequest('?code=bad'));

      expect(res.status).toBe(502);
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'token_exchange_failed', metadata: { error: null } })
      );
    });

    it('DD-AUTH-021 誤りが無くても user が無ければ 502', async () => {
      const ok = exchangeSuccess();
      exchangeCodeForSessionMock.mockResolvedValueOnce({ data: { session: ok.data.session, user: null }, error: null });

      const res = await callGet(callbackRequest('?code=bad'));

      expect(res.status).toBe(502);
    });

    it('DD-AUTH-021 session も user も揃っていても誤りが付いていれば 502', async () => {
      const ok = exchangeSuccess();
      exchangeCodeForSessionMock.mockResolvedValueOnce({ ...ok, error: { message: 'late error' } });

      const res = await callGet(callbackRequest('?code=bad'));

      expect(res.status).toBe(502);
      expect(persistSessionAndCookiesMock).not.toHaveBeenCalled();
    });
  });

  describe('応答の形の検査', () => {
    it('DD-AUTH-021 access_token が空なら invalid_token_response_shape を残して 502', async () => {
      const ok = exchangeSuccess();
      exchangeCodeForSessionMock.mockResolvedValueOnce({
        data: { session: { ...ok.data.session, access_token: '' }, user: ok.data.user },
        error: null,
      });

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('OAuth exchange failed');
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.callback',
        outcome: 'error',
        detail: 'invalid_token_response_shape',
      });
      expect(persistSessionAndCookiesMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-021 利用者のメールの形が誤りなら 502', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(exchangeSuccess({ id: 'user-1', email: 'not-an-email' }));

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(502);
    });

    it('DD-AUTH-021 メールの無い利用者は通し、監査の actor_email は null', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(exchangeSuccess({ id: 'user-1' }));

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(303);
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.callback',
        outcome: 'success',
        actor_email: null,
        resource_id: 'user-1',
      });
    });

    it('DD-AUTH-021 メールが null の利用者も通し、監査の actor_email は null', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(exchangeSuccess({ id: 'user-2', email: null }));

      await callGet(callbackRequest('?code=good'));

      expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', actor_email: null }));
    });
  });

  describe('セッションの保存の失敗', () => {
    it('DD-AUTH-021 保存の結果が ok でなければ理由を添えて error を残し、作った 303 を返す', async () => {
      persistSessionAndCookiesMock.mockResolvedValueOnce({ ok: false, error: 'db insert failed' });

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/account');
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.callback',
        outcome: 'error',
        detail: 'session_persist_failed: db insert failed',
        resource_id: 'user-123',
      });
      expect(logAuditMock).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    });

    it('DD-AUTH-021 保存の結果に理由が無ければ unknown を残す', async () => {
      persistSessionAndCookiesMock.mockResolvedValueOnce({ ok: false });

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(303);
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: unknown' })
      );
    });

    it('DD-AUTH-021 保存が結果を返さなければ unknown を残して 303 を返す', async () => {
      persistSessionAndCookiesMock.mockResolvedValueOnce(undefined);

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(303);
      expect(logAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: unknown' })
      );
    });

    it('DD-AUTH-021 保存が投げたら error を残し、作った 303 を返す', async () => {
      persistSessionAndCookiesMock.mockRejectedValueOnce(new Error('persist boom'));

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(303);
      expect(console.error).toHaveBeenCalledWith('persistSessionAndCookies failed:', expect.any(Error));
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.callback',
        outcome: 'error',
        detail: 'Error: persist boom',
        resource_id: 'user-123',
      });
    });
  });

  describe('要求の Cookie の読み方', () => {
    async function readCookies(cookieHeader?: string) {
      await callGet(callbackRequest('?code=good', cookieHeader));
      return lastClientOptions().cookies.getAll();
    }

    it('DD-AUTH-021 Cookie の見出しが無ければ空の一覧を渡す', async () => {
      expect(await readCookies()).toEqual([]);
    });

    it('DD-AUTH-021 見出しが空の文字でも空の一覧を渡す', async () => {
      expect(await readCookies('')).toEqual([]);
    });

    it('DD-AUTH-021 名前と値に分け、値は URL の形から戻す', async () => {
      expect(await readCookies('sb-pkce=a%20b; ;k=x=y')).toEqual([
        { name: 'sb-pkce', value: 'a b' },
        { name: 'k', value: 'x=y' },
      ]);
    });

    it('DD-AUTH-021 = の無い項目と先頭が = の項目は捨てる', async () => {
      expect(await readCookies('novalue; =orphan; keep=1')).toEqual([{ name: 'keep', value: '1' }]);
    });

    it('DD-AUTH-021 値を URL の形で戻せなければ生の値を使う', async () => {
      expect(await readCookies('broken=%E0%A4%A')).toEqual([{ name: 'broken', value: '%E0%A4%A' }]);
    });
  });

  describe('例外', () => {
    it('DD-AUTH-021 client の作成が投げたら error を残して 500', async () => {
      createServerClientMock.mockImplementationOnce(() => {
        throw new Error('client boom');
      });

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Internal server error');
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.callback',
        outcome: 'error',
        detail: 'Error: client boom',
      });
    });

    it('DD-AUTH-021 交換の呼び出しが投げても 500 を返す', async () => {
      exchangeCodeForSessionMock.mockRejectedValueOnce(new Error('network down'));

      const res = await callGet(callbackRequest('?code=good'));

      expect(res.status).toBe(500);
      expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Error: network down' }));
    });
  });
});

export {};
