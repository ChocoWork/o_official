export {};

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => {
      const res: any = {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map(),
        cookies: {
          _cookies: [] as any[],
          set(c: any) { this._cookies.push(c); },
          get(name: string) { return this._cookies.find((c: any) => c.name === name); },
        },
      };
      return res;
    },
  },
}));

// Mock rateLimit middleware to avoid DB calls/noise
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

// persistNewSession は本物を使い、Cookie と sessions 行の更新が実際に走ることを検証する。
jest.mock('@/features/auth/services/session', () => ({
  ...jest.requireActual('@/features/auth/services/session'),
  findSessionByRefreshHash: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

let refreshHandler: any;
const { cookies } = require('next/headers');
const sessionService = require('@/features/auth/services/session');
const originalConsoleError = console.error;

describe('Refresh API integration (mocked supabase & headers & fetch)', () => {
  beforeAll(() => {
    refreshHandler = require('@/app/api/auth/refresh/route').POST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    console.error = jest.fn();
    // default service client chain
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const fromMock = jest.fn(() => ({
      update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({}) })),
      insert: jest.fn().mockResolvedValue({}),
    }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });
    // by default, no cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    sessionService.findSessionByRefreshHash.mockResolvedValue({ id: 'sess1', user_id: 'u1', revoked_at: null });
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    // ensure fetch polyfill/mocking is available in test environment
    if (!(global as any).fetch) {
      (global as any).fetch = jest.fn();
    }
  });

  test('no refresh cookie returns 401', async () => {
    const res: any = await refreshHandler();
    expect(res.status).toBe(401);
  });

  test('token endpoint failure returns 401', async () => {
    // Provide cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';

    // mock fetch to return non-ok
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, text: async () => 'bad' } as any);

    const res: any = await refreshHandler();
    expect(res.status).toBe(401);

    // restore fetch mock
    (global.fetch as jest.MockedFunction<any>).mockRestore();
  });

  test('更新の印を URL の grant_type と JSON 本文・apikey で交換し、Cookie と sessions を更新する', async () => {
    // Arrange
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';

    const fakeTokenResponse = {
      ok: true,
      json: async () => ({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 3600, user: { id: 'u1', email: 'user@example.com' } }),
    } as any;
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(fakeTokenResponse);

    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const fromMock = jest.fn(() => ({
      update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({}) })),
      insert: jest.fn().mockResolvedValue({}),
    }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    // Act
    const res: any = await refreshHandler();
    const body = await res.json();

    // Assert
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenRequest] = fetchSpy.mock.calls[0];
    const requestUrl = new URL(String(tokenUrl));
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(`${process.env.SUPABASE_URL}/auth/v1/token`);
    expect(requestUrl.searchParams.get('grant_type')).toBe('refresh_token');
    expect(Array.from(requestUrl.searchParams.keys())).toEqual(['grant_type']);
    expect(tokenRequest?.method).toBe('POST');

    const tokenHeaders = new Headers(tokenRequest?.headers);
    expect(tokenHeaders.get('Content-Type')).toBe('application/json');
    // 失敗時の表示にも印やキーの値を出さず、一致だけを検証する。
    expect(tokenHeaders.get('apikey') === process.env.SUPABASE_SERVICE_ROLE_KEY).toBe(true);
    expect(tokenHeaders.get('Authorization') === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`).toBe(true);

    expect(tokenRequest?.body === JSON.stringify({
      refresh_token: cookies().get('sb-refresh-token').value,
    })).toBe(true);

    expect(res.status).toBe(200);
    expect(body.access_token).toBeDefined();
    expect(body.user.email).toBe('user@example.com');

    // cookie set
    const cookie = res.cookies.get('sb-refresh-token');
    expect(cookie).toBeDefined();
    expect(cookie.value).toBe('new-r');

    // DB update called
    expect(createServiceRoleClient().from).toHaveBeenCalledWith('sessions');

    (global.fetch as jest.MockedFunction<any>).mockRestore();
  });

  // jti 照合による自前のリプレイ検出は撤去し、検出そのものは Supabase Auth に任せた。
  // 残った自前の門番は「revoked_at が立っている行は拒否する」の1点だけなので、
  // ここが外れると失効が効かなくなる。以下2本でその1点を固定する。

  test('失効済みセッションの refresh token は 401 で拒否し、認証 Cookie を破棄する', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';

    sessionService.findSessionByRefreshHash.mockResolvedValue({
      id: 'sess1',
      user_id: 'u1',
      revoked_at: new Date().toISOString(),
    });

    const fetchSpy = jest.spyOn(global, 'fetch');

    const res: any = await refreshHandler();

    expect(res.status).toBe(401);
    // 失効済みなら Supabase への token 交換まで行かせない
    expect(fetchSpy).not.toHaveBeenCalled();

    for (const name of ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token']) {
      expect(res.cookies.get(name)?.maxAge).toBe(0);
    }

    fetchSpy.mockRestore();
  });

  test('Supabase が token 交換を拒否したら 401 で認証 Cookie を破棄する', async () => {
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';

    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' } as any);

    const res: any = await refreshHandler();

    expect(res.status).toBe(401);
    // 死んだ Cookie を残すとクライアントが refresh を叩き続ける
    for (const name of ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token']) {
      expect(res.cookies.get(name)?.maxAge).toBe(0);
    }

    (global.fetch as jest.MockedFunction<any>).mockRestore();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });
});
