/**
 * Google のログインの戻りの窓口（API-AUTH-008）。
 * code の交換・戻り先の控えの使い切りと役割による送り先の決定・保存の失敗の扱い・失敗の分岐を確かめる。
 * 戻り先の解決（return-intent-service）は本物を通し、控えの表を触る rpc だけを差し替える。
 */

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockLogAudit(...args),
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

// 控えの表は service_role の rpc だけで触る。consume は呼ばれた回数と引数を見る。
const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}));

const persistSessionAndCookiesMock = jest.fn();
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => persistSessionAndCookiesMock(...args),
}));

const exchangeCodeForSessionMock = jest.fn();
const mockCreateServerClient = jest.fn((..._args: unknown[]) => ({
  auth: {
    exchangeCodeForSession: exchangeCodeForSessionMock,
  },
}));
jest.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mockCreateServerClient(...args),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map<string, string>(),
      cookies: { set: jest.fn() },
    }),
    redirect: (url: URL, init?: { status?: number }) => ({
      status: init?.status ?? 302,
      headers: new Map<string, string>([['location', url.toString()]]),
      cookies: { set: jest.fn() },
    }),
  },
}));

const SESSION = {
  access_token: 'access-token',
  refresh_token: 'refresh-token',
  expires_in: 3600,
  expires_at: 1_900_000_000,
  token_type: 'bearer',
};

const INTENT_TOKEN = 'A'.repeat(43);
const INTENT_COOKIE = `sb-return-intent=${INTENT_TOKEN}`;

/** 最初の 1 回だけ道筋を返し、2 回目からは null を返す（1 回で使い切る DB の関数の写し）。 */
function fakeConsume(returnPath: string | null) {
  let used = false;
  mockRpc.mockImplementation(async (name: string) => {
    if (name !== 'consume_auth_return_intent') return { data: null, error: null };
    if (used) return { data: null, error: null };
    used = true;
    return { data: returnPath, error: null };
  });
}

function intentCookieCalls(res: any) {
  return (res.cookies.set as jest.Mock).mock.calls
    .map(([arg]) => arg)
    .filter((arg) => arg && typeof arg === 'object' && arg.name === 'sb-return-intent');
}

function exchanged(user: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return {
    data: {
      session: { ...SESSION, ...session },
      user: { id: 'user-123', email: 'test@example.com', ...user },
    },
    error: null,
  };
}

describe('API-AUTH-008 GET /api/auth/oauth/callback', () => {
  const handlerImport = () => import('@/app/api/auth/oauth/callback/route');
  const env = process.env as Record<string, string | undefined>;
  const SAVED = {
    anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    publicUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    url: env.SUPABASE_URL,
  };
  const errorSpy = jest.spyOn(console, 'error');

  function callbackRequest(query: string, headers: Record<string, string> = {}) {
    return new Request(`http://localhost:3000/api/auth/oauth/callback${query}`, { headers });
  }

  async function callGet(request: Request): Promise<any> {
    const { GET } = await handlerImport();
    return GET(request);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy.mockImplementation(() => undefined);
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    delete env.SUPABASE_URL;
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    persistSessionAndCookiesMock.mockResolvedValue({ ok: true });
    exchangeCodeForSessionMock.mockResolvedValue(exchanged());
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  afterAll(() => {
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = SAVED.anon;
    env.NEXT_PUBLIC_SUPABASE_URL = SAVED.publicUrl;
    env.SUPABASE_URL = SAVED.url;
    errorSpy.mockRestore();
  });

  describe('入口', () => {
    test('API-AUTH-008 IP の制限に当たったらその応答を返し、code を交換しない', async () => {
      const limited = { status: 429 };
      mockEnforceRateLimit.mockResolvedValue(limited);

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res).toBe(limited);
      expect(mockEnforceRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'auth:oauth:callback', limit: 50, windowSeconds: 600 }),
      );
      expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
    });

    test('API-AUTH-008 制限の部品が落ちたら 500 で止まり、交換へ進まない（SEC-AUTH-013-AC-02）', async () => {
      mockEnforceRateLimit.mockRejectedValue(new Error('rate limit down'));

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.status).toBe(500);
      expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
    });

    test.each([
      ['next だけ付いている', '?next=%2Faccount'],
      ['何も付いていない', ''],
      ['code が空', '?code=&next=%2Faccount'],
    ])('API-AUTH-008 code が無ければ 400 で、交換せず監査に残す（%s）', async (_label, query) => {
      const res = await callGet(callbackRequest(query));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('Bad Request');
      expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.oauth.callback', outcome: 'failure', detail: 'missing_code' }),
      );
    });

    test.each([
      ['匿名の鍵が無い', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
      ['Supabase の URL が無い', 'NEXT_PUBLIC_SUPABASE_URL'],
    ])('API-AUTH-008 環境変数が足りなければ 500（%s）で、交換しない', async (_label, name) => {
      delete env[name];

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Server misconfiguration' });
      expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'missing_supabase_env' }),
      );
    });

    test('API-AUTH-008 要求の Cookie を PKCE のクライアントへ渡す時は、値を復号し、壊れた組を落とす', async () => {
      await callGet(callbackRequest('?code=good-code', { cookie: 'sb-pkce=%E3%81%82; novalue; =nameless' }));

      const config: any = mockCreateServerClient.mock.calls[0][2];
      expect(mockCreateServerClient.mock.calls[0][0]).toBe('https://example.supabase.co');
      expect(config.auth).toEqual({ flowType: 'pkce', detectSessionInUrl: false });
      expect(config.cookies.getAll()).toEqual([{ name: 'sb-pkce', value: 'あ' }]);
    });
  });

  describe('code の交換の失敗', () => {
    test('API-AUTH-008 交換が失敗したら 502 を返し、保存せず理由を監査に残す', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce({
        data: {
          session: null,
          user: null,
        },
        error: { message: 'invalid_grant' },
      });

      const res = await callGet(callbackRequest('?code=bad-code'));
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.error).toBe('OAuth exchange failed');
      expect(persistSessionAndCookiesMock).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.oauth.callback',
          outcome: 'failure',
          detail: 'token_exchange_failed',
          metadata: expect.objectContaining({ error: 'invalid_grant' }),
        }),
      );
    });

    test('API-AUTH-008 エラーが無くても session か会員が欠けていれば 502', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce({ data: { session: SESSION, user: null }, error: null });

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.status).toBe(502);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'token_exchange_failed', metadata: { error: null } }),
      );
    });

    test.each([
      ['access token が空', exchanged({}, { access_token: '' })],
      ['refresh token が空', exchanged({}, { refresh_token: '' })],
      ['会員の id が空', exchanged({ id: '' })],
      ['会員のメールの形が不正', exchanged({ email: 'not-an-email' })],
    ])('API-AUTH-008 応答の形が不正（%s）なら 502 で、保存しない', async (_label, result) => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(result);

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'OAuth exchange failed' });
      expect(persistSessionAndCookiesMock).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'invalid_token_response_shape' }),
      );
    });

    test('API-AUTH-008 メールの無い会員（電話だけなど）でも形の確かめを通る', async () => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(exchanged({ email: null }));

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'success', actor_email: null }),
      );
    });

    test('API-AUTH-008 交換が例外で落ちたら 500 の汎用の応答で、理由は監査だけに残す', async () => {
      exchangeCodeForSessionMock.mockRejectedValueOnce(new Error('sdk crashed'));

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'Error: sdk crashed' }),
      );
    });
  });

  describe('成功の送り先', () => {
    test('API-AUTH-008 控えが無い一般の会員は / へ 303 で移し、セッションを保存する（消す物が無いので控えの Cookie は触らない）', async () => {
      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(intentCookieCalls(res)).toEqual([]);

      expect(persistSessionAndCookiesMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 303 }),
        expect.objectContaining({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
        }),
        expect.objectContaining({
          id: 'user-123',
          email: 'test@example.com',
        }),
        // この要求にはゲストのカート・お気に入りの Cookie が無いので、印は2つとも空
        { cartToken: null, wishlistToken: null },
      );

      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.oauth.callback',
          outcome: 'success',
          actor_email: 'test@example.com',
          resource_id: 'user-123',
        }),
      );
    });

    test('API-AUTH-008 控えがあれば保存の後に login の用途で使い切り、戻り先へ 303 で移して控えの Cookie を消す', async () => {
      fakeConsume('/item/3?color=red');

      const res = await callGet(callbackRequest('?code=good-code', { cookie: INTENT_COOKIE }));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/item/3?color=red');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith('consume_auth_return_intent', {
        _token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        _purpose: 'login',
        _user_id: 'user-123',
      });
      expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(INTENT_TOKEN);
      expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0, path: '/' })]);
    });

    test('API-AUTH-008 使い切れなかった控え（期限切れ・使用済み）は / へ移し、Cookie は消す', async () => {
      fakeConsume(null);

      const res = await callGet(callbackRequest('?code=good-code', { cookie: INTENT_COOKIE }));

      expect(res.headers.get('location')).toBe('http://localhost:3000/');
      expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0 })]);
    });

    test('API-AUTH-008 控えが /admin を指していても一般の会員は / へ移す（出口で役割を確かめ直す）', async () => {
      fakeConsume('/admin');

      const res = await callGet(callbackRequest('?code=good-code', { cookie: INTENT_COOKIE }));

      expect(res.headers.get('location')).toBe('http://localhost:3000/');
    });

    test('API-AUTH-008 形の合わない番号の Cookie は使い切りを呼ばず / へ移し、消す', async () => {
      const res = await callGet(callbackRequest('?code=good-code', { cookie: 'sb-return-intent=short' }));

      expect(res.headers.get('location')).toBe('http://localhost:3000/');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0 })]);
    });

    test.each(['admin', 'supporter'])('API-AUTH-008 %s は aal1 なので /auth/verified（TOTP の画面）へ通し、控えは使い切らない', async (role) => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(exchanged({ app_metadata: { role } }));
      fakeConsume('/admin/orders');

      const res = await callGet(callbackRequest('?code=good-code', { cookie: INTENT_COOKIE }));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/verified');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(intentCookieCalls(res)).toEqual([]);
    });

    test.each([
      ['未知の役割', { role: 'owner' }],
      ['役割が文字列でない', { role: 1 }],
      ['app_metadata が無い', undefined],
    ])('API-AUTH-008 役割が読めない（%s）会員は一般として扱い、/ へ移す', async (_label, appMetadata) => {
      exchangeCodeForSessionMock.mockResolvedValueOnce(exchanged({ app_metadata: appMetadata }));

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.headers.get('location')).toBe('http://localhost:3000/');
    });

    test.each([
      ['外部の住所', '?code=good-code&next=https%3A%2F%2Fevil.example.net%2F'],
      ['プロトコル相対', '?code=good-code&next=%2F%2Fevil.example.net'],
      ['バックスラッシュ入り', '?code=good-code&next=%2F%5Cevil.example.net'],
      ['タブ入り', '?code=good-code&next=%2F%09%2Fevil.example.net'],
      ['解釈で外へ向く', '?code=good-code&next=%2F.%2F%2Fevil.example.net'],
      ['内部の道（古い形）', '?code=good-code&next=%2Faccount%2Forders'],
    ])('API-AUTH-008 URL の next は読まない。外へも内部の道へも移さない（%s）', async (_label, query) => {
      const general = await callGet(callbackRequest(query));
      exchangeCodeForSessionMock.mockResolvedValueOnce(exchanged({ app_metadata: { role: 'admin' } }));
      const admin = await callGet(callbackRequest(query));

      expect(general.headers.get('location')).toBe('http://localhost:3000/');
      expect(admin.headers.get('location')).toBe('http://localhost:3000/auth/verified');
    });

    test('API-AUTH-008 ライブラリが溜めた session の Cookie を、移す応答へ付ける', async () => {
      exchangeCodeForSessionMock.mockImplementationOnce(async () => {
        const config: any = mockCreateServerClient.mock.calls[0][2];
        config.cookies.setAll([{ name: 'sb-session', value: 'v', options: { path: '/' } }]);
        return exchanged();
      });

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.cookies.set).toHaveBeenCalledWith('sb-session', 'v', { path: '/' });
    });

    test('API-AUTH-008 ゲストのカートとお気に入りの Cookie の印を、保存へ引き継ぐ', async () => {
      const cart = 'c'.repeat(43);
      const wishlist = 'w'.repeat(43);

      await callGet(callbackRequest('?code=good-code', { cookie: `cart=${cart}; wishlist=${wishlist}` }));

      expect(persistSessionAndCookiesMock.mock.calls[0][3]).toEqual({ cartToken: cart, wishlistToken: wishlist });
    });
  });

  describe('保存の失敗', () => {
    test('API-AUTH-008 保存に失敗しても 303 を返し、控えを使い切らず、成功は監査に残さない', async () => {
      persistSessionAndCookiesMock.mockResolvedValueOnce({ ok: false, error: 'db insert failed' });
      fakeConsume('/item/3');

      const res = await callGet(callbackRequest('?code=good-code-2', { cookie: INTENT_COOKIE }));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(intentCookieCalls(res)).toEqual([]);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.oauth.callback',
          outcome: 'error',
          detail: 'session_persist_failed: db insert failed',
          resource_id: 'user-123',
        }),
      );
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    });

    test('API-AUTH-008 保存が結果を返さなくても unknown として監査に残す', async () => {
      persistSessionAndCookiesMock.mockResolvedValueOnce(undefined);

      const res = await callGet(callbackRequest('?code=good-code'));

      expect(res.status).toBe(303);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'session_persist_failed: unknown' }),
      );
    });

    test('API-AUTH-008 保存が例外で落ちても 303 を返し、JSON で止めず理由を監査に残す', async () => {
      persistSessionAndCookiesMock.mockRejectedValueOnce(new Error('persist crashed'));

      fakeConsume('/item/3');

      const res = await callGet(callbackRequest('?code=good-code', { cookie: INTENT_COOKIE }));

      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/');
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'error', detail: 'Error: persist crashed', resource_id: 'user-123' }),
      );
      expect(mockLogAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
    });
  });
});

export {};
