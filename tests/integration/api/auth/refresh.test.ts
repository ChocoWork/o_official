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

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
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
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { logAudit } = require('@/lib/audit');
const { createServiceRoleClient } = require('@/lib/supabase/server');

const AUTH_COOKIE_NAMES = ['sb-access-token', 'sb-refresh-token', 'sb-csrf-token'];
// 結び付いた行（DD-AUTH-039）。AUTH_REQUIRE_APP_SESSION は既定で有効なので、更新は結び付いた行の続きにだけ通る。
const AUTH_SESSION_ID = '4c36ef0b-0332-42d8-b210-3326fc20c240';

const callRefresh = () =>
  refreshHandler(new Request('http://localhost:3000/api/auth/refresh', { method: 'POST' }));

const setRefreshCookie = (value: string | undefined) => {
  cookies.mockReturnValue({
    get: jest.fn((name: string) => (name === 'sb-refresh-token' && value ? { value } : undefined)),
  });
};

const setSupabaseEnv = () => {
  process.env.SUPABASE_URL = 'https://supabase.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';
};

const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  ({
    ok: true,
    json: async () => ({
      access_token: 'new-a',
      refresh_token: 'new-r',
      expires_in: 3600,
      user: { id: 'u1', email: 'user@example.com' },
      ...overrides,
    }),
  }) as any;

const expectAuthCookiesCleared = (res: any) => {
  for (const name of AUTH_COOKIE_NAMES) {
    expect(res.cookies.get(name)?.maxAge).toBe(0);
    expect(res.cookies.get(name)?.value).toBe('');
  }
};

type ServiceChain = {
  insert: jest.Mock;
  update: jest.Mock;
  updateEq: jest.Mock;
};

const installServiceClient = (opts: { insertError?: unknown; updateError?: unknown } = {}): ServiceChain => {
  const insert = jest.fn().mockResolvedValue({ error: opts.insertError ?? null });
  const updateEq = jest.fn().mockResolvedValue({ error: opts.updateError ?? null });
  const update = jest.fn(() => ({ eq: updateEq }));
  createServiceRoleClient.mockReturnValue({ from: jest.fn(() => ({ insert, update })) });
  return { insert, update, updateEq };
};

describe('Refresh API integration (mocked supabase & headers & fetch)', () => {
  let fetchSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeAll(() => {
    refreshHandler = require('@/app/api/auth/refresh/route').POST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    logAudit.mockResolvedValue(undefined);
    enforceRateLimit.mockResolvedValue(undefined);
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    delete process.env.AUTH_REQUIRE_APP_SESSION;
    sessionService.findSessionByRefreshHash.mockResolvedValue({
      id: 'sess1',
      user_id: 'u1',
      revoked_at: null,
      auth_session_id: AUTH_SESSION_ID,
    });
    installServiceClient();
    delete process.env.SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!(global as any).fetch) {
      (global as any).fetch = jest.fn();
    }
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('API-AUTH-014 refresh の Cookie が無ければ 401 で、Supabase にも行にも触れない', async () => {
    const res: any = await callRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No refresh token' });
    expect(sessionService.findSessionByRefreshHash).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('API-AUTH-014 IP の制限に当たったら、その応答をそのまま返して先へ進まない', async () => {
    const limited: any = { status: 429, json: async () => ({ error: 'Too many requests' }) };
    enforceRateLimit.mockResolvedValue(limited);
    setRefreshCookie('old-refresh');
    setSupabaseEnv();

    const res = await callRefresh();

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:refresh', limit: 30, windowSeconds: 600 }),
    );
    expect(sessionService.findSessionByRefreshHash).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('API-AUTH-014 回数制限の部品が壊れたら更新は止める。500 で、交換へ進まない（SEC-AUTH-013-AC-02）', async () => {
    enforceRateLimit.mockRejectedValue(new Error('rate limit store down'));
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    fetchSpy.mockResolvedValue(tokenResponse());

    const res: any = await callRefresh();

    expect(res.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sessionService.findSessionByRefreshHash).not.toHaveBeenCalled();
  });

  test('API-AUTH-014 更新の印を URL の grant_type と JSON 本文・apikey で交換し、Cookie と sessions を更新する', async () => {
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    fetchSpy.mockResolvedValue(tokenResponse());
    const chain = installServiceClient();

    const res: any = await callRefresh();
    const body = await res.json();

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
    expect(tokenRequest?.body === JSON.stringify({ refresh_token: 'old-refresh' })).toBe(true);

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toMatch(/access_token|refresh_token|app_metadata|new-a|new-r/);

    expect(res.cookies.get('sb-refresh-token')?.value).toBe('new-r');
    expect(res.cookies.get('sb-access-token')?.value).toBe('new-a');
    expect(res.cookies.get('sb-csrf-token')?.value).toEqual(expect.any(String));
    expect(res.cookies.get('sb-csrf-token')?.value).not.toBe('');

    // 新しい行を足し、古い行に失効の印を付ける
    expect(chain.insert).toHaveBeenCalledTimes(1);
    expect(chain.insert.mock.calls[0][0][0]).toEqual(
      expect.objectContaining({ user_id: 'u1', quarantined: false, auth_session_id: AUTH_SESSION_ID }),
    );
    expect(chain.update).toHaveBeenCalledWith(expect.objectContaining({ revoked_at: expect.any(String) }));
    expect(chain.updateEq).toHaveBeenCalledWith('id', 'sess1');
  });

  test('API-AUTH-014 交換が成功したら success を監査に残す', async () => {
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    fetchSpy.mockResolvedValue(tokenResponse());

    await callRefresh();

    expect(logAudit).toHaveBeenCalledWith({ action: 'refresh', actor_id: 'u1', outcome: 'success' });
  });

  test('API-AUTH-014 自前の行が無い refresh token は 401 で、Supabase へ行かせず認証 Cookie を消す', async () => {
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    sessionService.findSessionByRefreshHash.mockResolvedValue(null);
    fetchSpy.mockResolvedValue(tokenResponse());

    const res: any = await callRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session not bound' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expectAuthCookiesCleared(res);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'refresh', detail: 'unbound_session' }));
  });

  test('API-AUTH-014 旗が無効なら、自前の行が無くても拒否せず、Supabase の交換結果の利用者で続ける', async () => {
    process.env.AUTH_REQUIRE_APP_SESSION = 'off';
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    sessionService.findSessionByRefreshHash.mockResolvedValue(null);
    fetchSpy.mockResolvedValue(tokenResponse({ user: { id: 'u-from-supabase' } }));
    const chain = installServiceClient();

    const res: any = await callRefresh();

    expect(res.status).toBe(200);
    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(chain.insert.mock.calls[0][0][0]).toEqual(
      expect.objectContaining({ user_id: 'u-from-supabase', auth_session_id: null }),
    );
    // 差し替える古い行が無いので失効の更新はしない
    expect(chain.update).not.toHaveBeenCalled();
  });

  test('API-AUTH-014 失効の印がある行の refresh token は 401 で拒否し、認証 Cookie を消して Supabase へ行かせない', async () => {
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    sessionService.findSessionByRefreshHash.mockResolvedValue({
      id: 'sess1',
      user_id: 'u1',
      revoked_at: new Date().toISOString(),
    });

    const res: any = await callRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session revoked' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expectAuthCookiesCleared(res);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'refresh',
      actor_id: 'u1',
      outcome: 'failure',
      detail: 'session_revoked',
    });
  });

  test('API-AUTH-014 Supabase が交換を拒否したら 401 で認証 Cookie を消し、failure を監査に残す', async () => {
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    fetchSpy.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' } as any);

    const res: any = await callRefresh();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Failed to refresh token' });
    // 死んだ Cookie を残すとクライアントが refresh を叩き続ける
    expectAuthCookiesCleared(res);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'refresh',
      actor_id: 'u1',
      outcome: 'failure',
      detail: 'supabase_refresh_failed',
      metadata: { status: 400 },
    });
  });

  test('API-AUTH-014 Supabase の URL か service role の鍵が無ければ 500 で、交換を試みない', async () => {
    setRefreshCookie('old-refresh');
    process.env.SUPABASE_URL = 'https://supabase.example';

    const res: any = await callRefresh();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Server misconfiguration' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('API-AUTH-014 SUPABASE_URL が無くても NEXT_PUBLIC_SUPABASE_URL で交換する', async () => {
    setRefreshCookie('old-refresh');
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://public.supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';
    fetchSpy.mockResolvedValue(tokenResponse());

    const res: any = await callRefresh();

    expect(res.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('https://public.supabase.example/auth/v1/token');
  });

  test('API-AUTH-014 行の保存に失敗しても、発行済みのトークンと Cookie は配り、error を監査に残す', async () => {
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    fetchSpy.mockResolvedValue(tokenResponse());
    installServiceClient({ insertError: { message: 'db down' } });

    const res: any = await callRefresh();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(res.cookies.get('sb-refresh-token')?.value).toBe('new-r');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'refresh', actor_id: 'u1', outcome: 'error' }),
    );
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  test('API-AUTH-014 古い行の失効の更新に失敗しても、発行済みのトークンは配る', async () => {
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    fetchSpy.mockResolvedValue(tokenResponse());
    installServiceClient({ updateError: { message: 'update failed' } });

    const res: any = await callRefresh();

    expect(res.status).toBe(200);
    expect(res.cookies.get('sb-access-token')?.value).toBe('new-a');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  test('API-AUTH-014 想定外の例外は 500 を返す', async () => {
    setRefreshCookie('old-refresh');
    setSupabaseEnv();
    fetchSpy.mockRejectedValue(new Error('network down'));

    const res: any = await callRefresh();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
