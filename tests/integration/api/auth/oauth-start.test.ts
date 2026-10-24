/**
 * Google のログインの開始の窓口（API-AUTH-007）。
 * 入力の絞り込み・戻り先の組み立て・PKCE の Cookie の付け直し・失敗の分岐を確かめる。
 */

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const signInWithOAuthMock = jest.fn();
const mockCreateServerClient = jest.fn((..._args: unknown[]) => ({
  auth: {
    signInWithOAuth: signInWithOAuthMock,
  },
}));
jest.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
    redirect: (url: URL, init?: any) => ({
      status: init?.status ?? 302,
      headers: new Map<string, string>([['location', url.toString()]]),
      cookies: { set: jest.fn() },
    }),
  },
}));

describe('API-AUTH-007 GET /api/auth/oauth/start', () => {
  const handlerImport = () => import('@/app/api/auth/oauth/start/route');
  const env = process.env as Record<string, string | undefined>;
  const SAVED = {
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    publicUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    url: env.SUPABASE_URL,
  };
  const errorSpy = jest.spyOn(console, 'error');

  function startRequest(query: string, headers: Record<string, string> = {}) {
    return new Request(`http://localhost:3000/api/auth/oauth/start${query}`, { headers });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy.mockImplementation(() => undefined);
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    delete env.SUPABASE_URL;
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    signInWithOAuthMock.mockResolvedValue({
      data: {
        url: 'https://example.supabase.co/auth/v1/authorize?provider=google',
      },
      error: null,
    });
  });

  afterAll(() => {
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = SAVED.anon;
    env.NEXT_PUBLIC_SUPABASE_URL = SAVED.publicUrl;
    env.SUPABASE_URL = SAVED.url;
    errorSpy.mockRestore();
  });

  test('API-AUTH-007 Google の同意の画面へ 302 で移し、毎回アカウントを選ばせる', async () => {
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=google&redirect_to=%2Fauth%2Fverified'));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.supabase.co/auth/v1/authorize?provider=google');

    expect(signInWithOAuthMock).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'http://localhost:3000/api/auth/oauth/callback?next=%2Fauth%2Fverified',
        queryParams: {
          prompt: 'select_account',
        },
      },
    });
  });

  test('API-AUTH-007 応答は no-store と no-referrer で、成功を送り先つきで監査に残す', async () => {
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=google&redirect_to=%2Faccount'));

    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'auth.oauth.start',
      outcome: 'success',
      metadata: { provider: 'google', redirect_to: '/account' },
    });
  });

  test.each([
    ['外部の住所', '?provider=google&redirect_to=https%3A%2F%2Fevil.example.net%2F'],
    ['プロトコル相対', '?provider=google&redirect_to=%2F%2Fevil.example.net'],
    ['バックスラッシュ入り', '?provider=google&redirect_to=%2F%5Cevil.example.net'],
    ['指定なし', '?provider=google'],
  ])('API-AUTH-007 戻りの送り先が内部の道でなければ既定の /auth/verified に直す（%s）', async (_label, query) => {
    const { GET } = await handlerImport();

    await GET(startRequest(query));

    const redirectTo = new URL(signInWithOAuthMock.mock.calls[0][0].options.redirectTo);
    expect(redirectTo.pathname).toBe('/api/auth/oauth/callback');
    expect(redirectTo.searchParams.get('next')).toBe('/auth/verified');
  });

  test('API-AUTH-007 PKCE の検証の値を溜めた Cookie を、応答のリダイレクトに付け直す', async () => {
    signInWithOAuthMock.mockImplementation(async () => {
      const config: any = mockCreateServerClient.mock.calls[0][2];
      config.cookies.setAll([
        { name: 'sb-pkce-code-verifier', value: 'verifier', options: { path: '/', maxAge: 600 } },
        { name: 'sb-other', value: 'x' },
      ]);
      return { data: { url: 'https://example.supabase.co/auth/v1/authorize' }, error: null };
    });
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=google'));

    expect(res.cookies.set).toHaveBeenCalledTimes(2);
    expect(res.cookies.set).toHaveBeenCalledWith('sb-pkce-code-verifier', 'verifier', { path: '/', maxAge: 600 });
    expect(res.cookies.set).toHaveBeenCalledWith('sb-other', 'x', undefined);
  });

  test('API-AUTH-007 PKCE のクライアントには匿名の鍵と URL を渡し、URL は SUPABASE_URL を優先する', async () => {
    env.SUPABASE_URL = 'https://internal.supabase.co';
    const { GET } = await handlerImport();

    await GET(startRequest('?provider=google'));

    expect(mockCreateServerClient).toHaveBeenCalledWith(
      'https://internal.supabase.co',
      'anon',
      expect.objectContaining({ auth: { flowType: 'pkce', detectSessionInUrl: false } }),
    );
  });

  test('API-AUTH-007 要求の Cookie を読み出す時は、値を復号し、壊れた組と名前の無い組は落とす', async () => {
    const { GET } = await handlerImport();

    await GET(startRequest('?provider=google', { cookie: 'a=1; b=%E3%81%82; broken=%E0%A4%A; novalue; =nameless' }));

    const config: any = mockCreateServerClient.mock.calls[0][2];
    expect(config.cookies.getAll()).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'あ' },
      { name: 'broken', value: '%E0%A4%A' },
    ]);
  });

  test('API-AUTH-007 Cookie が無い要求では空の一覧を返す', async () => {
    const { GET } = await handlerImport();

    await GET(startRequest('?provider=google'));

    const config: any = mockCreateServerClient.mock.calls[0][2];
    expect(config.cookies.getAll()).toEqual([]);
  });

  test('API-AUTH-007 provider が無ければ 400 で、URL を作らず監査に残す', async () => {
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest(''));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad Request' });
    expect(signInWithOAuthMock).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.oauth.start', outcome: 'failure', detail: 'invalid_query' }),
    );
  });

  test('API-AUTH-007 google 以外のプロバイダは 400 で、URL を作らず監査に残す', async () => {
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=github&redirect_to=%2Fauth%2Fverified'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Unsupported provider');
    expect(signInWithOAuthMock).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', detail: 'unsupported_provider', metadata: { provider: 'github' } }),
    );
  });

  test('API-AUTH-007 IP の制限に当たったらその応答を返し、URL を作らない', async () => {
    const limited = { status: 429 };
    mockEnforceRateLimit.mockResolvedValue(limited);
    const { GET } = await handlerImport();

    const res = await GET(startRequest('?provider=google'));

    expect(res).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:oauth:start', limit: 50, windowSeconds: 600 }),
    );
    expect(signInWithOAuthMock).not.toHaveBeenCalled();
  });

  test('API-AUTH-007 制限の部品が落ちても開始の処理は止めない', async () => {
    mockEnforceRateLimit.mockRejectedValue(new Error('rate limit down'));
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=google'));

    expect(res.status).toBe(302);
  });

  test.each([
    ['匿名の鍵が無い', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    ['Supabase の URL が無い', 'NEXT_PUBLIC_SUPABASE_URL'],
  ])('API-AUTH-007 環境変数が足りなければ 500（%s）で、URL を作らない', async (_label, name) => {
    delete env[name];
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=google'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Server misconfiguration' });
    expect(signInWithOAuthMock).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'missing_supabase_env' }),
    );
  });

  test('API-AUTH-007 認可の URL を作れなければ 502 を返し、Cookie は付けず監査に残す', async () => {
    signInWithOAuthMock.mockResolvedValueOnce({
      data: { url: null },
      error: { message: 'failed' },
    });

    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=google&redirect_to=%2Fauth%2Fverified'));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('OAuth start failed');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', detail: 'oauth_authorize_url_generation_failed' }),
    );
  });

  test('API-AUTH-007 エラーが無くても URL が空なら 502', async () => {
    signInWithOAuthMock.mockResolvedValueOnce({ data: { url: '' }, error: null });
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=google'));

    expect(res.status).toBe(502);
  });

  test('API-AUTH-007 想定外の例外は 500 の汎用の応答で、理由は監査だけに残す', async () => {
    signInWithOAuthMock.mockRejectedValueOnce(new Error('sdk crashed'));
    const { GET } = await handlerImport();

    const res: any = await GET(startRequest('?provider=google'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'Error: sdk crashed' }),
    );
  });
});

export {};
