/**
 * Google のログインの開始の窓口の単体テスト（DD-AUTH-020）。
 * 外へ出る先（制限・監査・Supabase のクライアント）だけ差し替え、住所の整形は本物を通す。
 */

const enforceRateLimitMock = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimitMock(...args),
}));

const logAuditMock = jest.fn();
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

type ClientOptions = {
  auth: { flowType: string; detectSessionInUrl: boolean };
  cookies: {
    getAll: () => Array<{ name: string; value: string }>;
    setAll: (cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => void;
  };
};

const signInWithOAuthMock = jest.fn();
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

const AUTHORIZE_URL = 'https://example.supabase.co/auth/v1/authorize?provider=google';
const ENV_KEYS = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;

function startRequest(query: string, cookie?: string) {
  return new Request(`http://localhost:3000/api/auth/oauth/start${query}`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

function lastClientOptions(): ClientOptions {
  const calls = createServerClientMock.mock.calls;
  return calls[calls.length - 1][2] as ClientOptions;
}

async function callGet(request: Request) {
  const { GET } = await import('@/app/api/auth/oauth/start/route');
  return (await GET(request)) as unknown as {
    status: number;
    headers: Map<string, string>;
    json: () => Promise<{ error: string }>;
  };
}

describe('Google のログインの開始の窓口', () => {
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
    signInWithOAuthMock.mockResolvedValue({ data: { url: AUTHORIZE_URL }, error: null });
    createServerClientMock.mockImplementation(() => ({ auth: { signInWithOAuth: signInWithOAuthMock } }));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('正常フロー', () => {
    it('DD-AUTH-020 google で 302 にし、select_account と戻り先の next を付けて同意の画面へ送る', async () => {
      const res = await callGet(startRequest('?provider=google&redirect_to=%2Fauth%2Fverified'));

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(AUTHORIZE_URL);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(signInWithOAuthMock).toHaveBeenCalledWith({
        provider: 'google',
        options: {
          redirectTo: 'http://localhost:3000/api/auth/oauth/callback?next=%2Fauth%2Fverified',
          queryParams: { prompt: 'select_account' },
        },
      });
      expect(lastClientOptions().auth).toEqual({ flowType: 'pkce', detectSessionInUrl: false });
      expect(enforceRateLimitMock).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'auth:oauth:start', limit: 50, windowSeconds: 600 })
      );
    });

    it('DD-AUTH-020 成功を auth.oauth.start の success として送り先つきで監査に残す', async () => {
      await callGet(startRequest('?provider=google&redirect_to=%2Fcheckout'));

      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.start',
        outcome: 'success',
        metadata: { provider: 'google', redirect_to: '/checkout' },
      });
    });

    it('DD-AUTH-020 ライブラリが溜めた PKCE の Cookie を 302 の応答へそのまま付け替える', async () => {
      signInWithOAuthMock.mockImplementationOnce(async () => {
        lastClientOptions().cookies.setAll([
          { name: 'sb-pkce-code-verifier', value: 'verifier', options: { httpOnly: true, path: '/' } },
          { name: 'sb-other', value: 'x' },
        ]);
        return { data: { url: AUTHORIZE_URL }, error: null };
      });

      await callGet(startRequest('?provider=google'));

      expect(cookieSetMock).toHaveBeenCalledTimes(2);
      expect(cookieSetMock).toHaveBeenNthCalledWith(1, 'sb-pkce-code-verifier', 'verifier', { httpOnly: true, path: '/' });
      expect(cookieSetMock).toHaveBeenNthCalledWith(2, 'sb-other', 'x', undefined);
    });

    it('DD-AUTH-020 溜まった Cookie が無ければ応答に Cookie を付けない', async () => {
      await callGet(startRequest('?provider=google'));

      expect(cookieSetMock).not.toHaveBeenCalled();
    });
  });

  describe('回数の制限', () => {
    it('DD-AUTH-020 回数の制限が応答を返したらそのまま返し、先へ進まない', async () => {
      const limited = { status: 429 };
      enforceRateLimitMock.mockResolvedValueOnce(limited);

      const res = await callGet(startRequest('?provider=google'));

      expect(res).toBe(limited);
      expect(createServerClientMock).not.toHaveBeenCalled();
      expect(logAuditMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-020 回数の制限の呼び出しが投げても記録して先へ進む', async () => {
      enforceRateLimitMock.mockRejectedValueOnce(new Error('redis down'));

      const res = await callGet(startRequest('?provider=google'));

      expect(res.status).toBe(302);
      expect(console.error).toHaveBeenCalledWith('Rate limit middleware error (oauth start):', expect.any(Error));
    });
  });

  describe('問い合わせの検査', () => {
    it.each([
      ['provider が無い', ''],
      ['provider が空', '?provider='],
    ])('DD-AUTH-020 %s と invalid_query を残して 400', async (_label, query) => {
      const res = await callGet(startRequest(query));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Bad Request');
      expect(logAuditMock).toHaveBeenCalledWith({ action: 'auth.oauth.start', outcome: 'failure', detail: 'invalid_query' });
      expect(createServerClientMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-020 google 以外は unsupported_provider を残して 400', async () => {
      const res = await callGet(startRequest('?provider=github'));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Unsupported provider');
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.start',
        outcome: 'failure',
        detail: 'unsupported_provider',
        metadata: { provider: 'github' },
      });
      expect(createServerClientMock).not.toHaveBeenCalled();
    });

    it.each([
      ['redirect_to が空', '?provider=google&redirect_to='],
      ['redirect_to が無い', '?provider=google'],
      ['外の住所', '?provider=google&redirect_to=https%3A%2F%2Fevil.example%2Fx'],
      ['// で始まる住所', '?provider=google&redirect_to=%2F%2Fevil.example'],
    ])('DD-AUTH-020 %s なら既定の /auth/verified を戻り先にする', async (_label, query) => {
      await callGet(startRequest(query));

      expect(signInWithOAuthMock).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            redirectTo: 'http://localhost:3000/api/auth/oauth/callback?next=%2Fauth%2Fverified',
          }),
        })
      );
    });
  });

  describe('環境変数', () => {
    it('DD-AUTH-020 SUPABASE_URL があればそれを使い、公開の名前より優先する', async () => {
      process.env.SUPABASE_URL = 'https://server.supabase.co';

      await callGet(startRequest('?provider=google'));

      expect(createServerClientMock.mock.calls[0][0]).toBe('https://server.supabase.co');
      expect(createServerClientMock.mock.calls[0][1]).toBe('anon');
    });

    it('DD-AUTH-020 SUPABASE_URL が無ければ NEXT_PUBLIC_SUPABASE_URL を使う', async () => {
      await callGet(startRequest('?provider=google'));

      expect(createServerClientMock.mock.calls[0][0]).toBe('https://example.supabase.co');
    });

    it('DD-AUTH-020 URL が両方無ければ missing_supabase_env を残して 500', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      const res = await callGet(startRequest('?provider=google'));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Server misconfiguration');
      expect(logAuditMock).toHaveBeenCalledWith({ action: 'auth.oauth.start', outcome: 'error', detail: 'missing_supabase_env' });
      expect(createServerClientMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-020 anon の鍵が無ければ missing_supabase_env を残して 500', async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      const res = await callGet(startRequest('?provider=google'));

      expect(res.status).toBe(500);
      expect(logAuditMock).toHaveBeenCalledWith({ action: 'auth.oauth.start', outcome: 'error', detail: 'missing_supabase_env' });
    });
  });

  describe('要求の Cookie の読み方', () => {
    async function readCookies(cookieHeader?: string) {
      await callGet(startRequest('?provider=google', cookieHeader));
      return lastClientOptions().cookies.getAll();
    }

    it('DD-AUTH-020 Cookie の見出しが無ければ空の一覧を渡す', async () => {
      expect(await readCookies()).toEqual([]);
    });

    it('DD-AUTH-020 見出しが空の文字でも空の一覧を渡す', async () => {
      expect(await readCookies('')).toEqual([]);
    });

    it('DD-AUTH-020 名前と値に分け、値は URL の形から戻す', async () => {
      expect(await readCookies('a=1; sb-token=hello%20world; ;b=x=y')).toEqual([
        { name: 'a', value: '1' },
        { name: 'sb-token', value: 'hello world' },
        { name: 'b', value: 'x=y' },
      ]);
    });

    it('DD-AUTH-020 = の無い項目と先頭が = の項目は捨てる', async () => {
      expect(await readCookies('novalue; =orphan; keep=1')).toEqual([{ name: 'keep', value: '1' }]);
    });

    it('DD-AUTH-020 値を URL の形で戻せなければ生の値を使う', async () => {
      expect(await readCookies('broken=%E0%A4%A')).toEqual([{ name: 'broken', value: '%E0%A4%A' }]);
    });
  });

  describe('URL の生成の失敗と例外', () => {
    it('DD-AUTH-020 生成が誤りを返したら 502 と oauth_authorize_url_generation_failed を残す', async () => {
      signInWithOAuthMock.mockResolvedValueOnce({ data: { url: null }, error: { message: 'failed' } });

      const res = await callGet(startRequest('?provider=google'));

      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('OAuth start failed');
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.start',
        outcome: 'failure',
        detail: 'oauth_authorize_url_generation_failed',
      });
    });

    it('DD-AUTH-020 誤りが無くても URL が無ければ 502', async () => {
      signInWithOAuthMock.mockResolvedValueOnce({ data: { url: null }, error: null });

      const res = await callGet(startRequest('?provider=google'));

      expect(res.status).toBe(502);
    });

    it('DD-AUTH-020 データ自体が無くても 502', async () => {
      signInWithOAuthMock.mockResolvedValueOnce({ data: null, error: null });

      const res = await callGet(startRequest('?provider=google'));

      expect(res.status).toBe(502);
    });

    it('DD-AUTH-020 URL があっても誤りが付いていれば 502 にし、Cookie は付けない', async () => {
      signInWithOAuthMock.mockResolvedValueOnce({ data: { url: AUTHORIZE_URL }, error: { message: 'boom' } });

      const res = await callGet(startRequest('?provider=google'));

      expect(res.status).toBe(502);
      expect(cookieSetMock).not.toHaveBeenCalled();
    });

    it('DD-AUTH-020 client の作成が投げたら error を残して 500', async () => {
      createServerClientMock.mockImplementationOnce(() => {
        throw new Error('client boom');
      });

      const res = await callGet(startRequest('?provider=google'));

      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Internal server error');
      expect(logAuditMock).toHaveBeenCalledWith({
        action: 'auth.oauth.start',
        outcome: 'error',
        detail: 'Error: client boom',
      });
    });
  });
});

export {};
