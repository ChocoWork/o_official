// トークンの更新の窓口（DD-AUTH-027）の単体テスト。
// Cookie・回数の制限・自前の sessions の引き・Supabase の交換（fetch）・行の差し替え・監査を差し替え、
// 窓口が下す分岐（401・500・200）と、失敗の時に消す Cookie を見る。

import { POST } from '@/app/api/auth/refresh/route';
import { cookies } from 'next/headers';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { findSessionByRefreshHash, persistNewSession } from '@/features/auth/services/session';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map<string, string>(),
      cookies: {
        _cookies: [] as Array<Record<string, unknown>>,
        set(cookie: Record<string, unknown>) {
          this._cookies.push(cookie);
        },
        get(name: string) {
          return this._cookies.find((cookie) => cookie.name === name);
        },
      },
    }),
  },
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/features/auth/services/session', () => ({
  findSessionByRefreshHash: jest.fn(),
  persistNewSession: jest.fn(),
}));

const mockedCookies = cookies as unknown as jest.Mock;
const mockedLogAudit = logAudit as jest.Mock;
const mockedEnforceRateLimit = enforceRateLimit as jest.Mock;
const mockedFindSession = findSessionByRefreshHash as jest.Mock;
const mockedPersistNewSession = persistNewSession as jest.Mock;
const mockedFetch = jest.fn();

/** 消えた Cookie は、値が空で有効期限が0秒（ブラウザに捨てさせる指示）になっている */
const CLEARED = { value: '', maxAge: 0, path: '/', httpOnly: true };
const AUTH_COOKIES = ['sb-refresh-token', 'sb-access-token', 'sb-csrf-token'];

type Res = {
  status: number;
  json: () => Promise<unknown>;
  cookies: { _cookies: unknown[]; get: (name: string) => unknown };
};

const request = () => new Request('http://localhost:3000/api/auth/refresh', { method: 'POST' });
const call = async () => (await POST(request())) as unknown as Res;

const exchangeOk = (body: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    user: { id: 'user-from-supabase' },
    ...body,
  }),
  text: async () => '',
});

const exchangeFailed = (status = 400) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => 'invalid_grant',
});

const AUTH_SESSION_ID = '4c36ef0b-0332-42d8-b210-3326fc20c240';

const sessionRow = (extra: Record<string, unknown> = {}) => ({
  id: 'session-row-1',
  user_id: 'user-from-row',
  revoked_at: null,
  auth_session_id: AUTH_SESSION_ID,
  ...extra,
});

const expectAuthCookiesCleared = (res: Res) => {
  for (const name of AUTH_COOKIES) {
    expect(res.cookies.get(name)).toMatchObject({ name, ...CLEARED });
  }
};

describe('POST /api/auth/refresh', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.AUTH_REQUIRE_APP_SESSION;
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://public.supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    mockedCookies.mockResolvedValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    mockedEnforceRateLimit.mockResolvedValue(undefined);
    mockedFindSession.mockResolvedValue(sessionRow());
    mockedPersistNewSession.mockResolvedValue(undefined);
    mockedLogAudit.mockResolvedValue(undefined);
    mockedFetch.mockResolvedValue(exchangeOk());
    global.fetch = mockedFetch as unknown as typeof fetch;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  test('DD-AUTH-027 行があり交換が成功なら 200 で { ok: true } だけを返し（トークンも利用者も載せない）、行を差し替えて success を残す', async () => {
    const req = request();
    const res = (await POST(req)) as unknown as Res;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toMatch(/access_token|refresh_token|app_metadata|new-access|new-refresh/);
    expect(mockedEnforceRateLimit).toHaveBeenCalledWith({
      request: req,
      endpoint: 'auth:refresh',
      limit: 30,
      windowSeconds: 600,
    });
    expect(mockedFindSession).toHaveBeenCalledWith('old-refresh', { throwOnError: true });
    expect(mockedPersistNewSession).toHaveBeenCalledWith(res, {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      userId: 'user-from-row',
      previousSessionId: 'session-row-1',
      previousRefreshToken: 'old-refresh',
      trustedAuthSessionId: AUTH_SESSION_ID,
    });
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({ action: 'refresh', actor_id: 'user-from-row', outcome: 'success' });
    expect(res.cookies._cookies).toEqual([]);
  });

  test('DD-AUTH-027 交換は service role の鍵で、更新の印を本文に入れて URL に更新方法を指定して呼ぶ', async () => {
    await call();

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch).toHaveBeenCalledWith('https://supabase.test/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer service-key',
        apikey: 'service-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: 'old-refresh' }),
    });
  });

  test('DD-AUTH-027 旗が無効なら、行が無くても交換が成功なら 200 で、警告を残し、利用者の id は応答から取り前の行の id は null', async () => {
    process.env.AUTH_REQUIRE_APP_SESSION = 'off';
    mockedFindSession.mockResolvedValue(null);

    const res = await call();

    expect(res.status).toBe(200);
    expect(consoleWarn).toHaveBeenCalledWith('[auth.refresh] no local session row for the presented refresh token');
    expect(mockedPersistNewSession).toHaveBeenCalledWith(res, {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      userId: 'user-from-supabase',
      previousSessionId: null,
      previousRefreshToken: 'old-refresh',
      trustedAuthSessionId: null,
    });
    expect(mockedLogAudit).toHaveBeenCalledWith({ action: 'refresh', actor_id: undefined, outcome: 'success' });
  });

  test('DD-AUTH-027 旗が無効で行が無く応答にも利用者が無ければ、利用者の id は undefined のまま差し替える', async () => {
    process.env.AUTH_REQUIRE_APP_SESSION = 'off';
    mockedFindSession.mockResolvedValue(null);
    mockedFetch.mockResolvedValue(exchangeOk({ user: undefined }));

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockedPersistNewSession).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ userId: undefined, previousSessionId: null }),
    );
  });

  test('DD-AUTH-027 行の利用者の id が空なら、応答の利用者の id を使う', async () => {
    mockedFindSession.mockResolvedValue(sessionRow({ user_id: '' }));

    const res = await call();

    expect(mockedPersistNewSession).toHaveBeenCalledWith(res, expect.objectContaining({ userId: 'user-from-supabase' }));
  });

  test('DD-AUTH-027 回数の制限が応答を返したらそのまま返し、Cookie も交換も見ない', async () => {
    const limited = { status: 429 };
    mockedEnforceRateLimit.mockResolvedValue(limited);

    const res = await POST(request());

    expect(res).toBe(limited);
    expect(mockedCookies).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test('DD-AUTH-027 回数の制限の呼び出しが投げたら 500 で、交換へ進まない（SEC-AUTH-013-AC-02）', async () => {
    const error = new Error('rate limit down');
    mockedEnforceRateLimit.mockRejectedValue(error);

    const res = await call();

    expect(res.status).toBe(500);
    expect(consoleError).not.toHaveBeenCalledWith('Rate limit middleware error (refresh):', error);
    expect(mockedCookies).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test.each([
    { label: 'Cookie の値が空', cookie: { value: '' } },
    { label: 'Cookie が無い', cookie: undefined },
  ])('DD-AUTH-027 refresh の $label なら 401 No refresh token で、Cookie は消さず行も交換も見ない', async ({ cookie }) => {
    mockedCookies.mockResolvedValue({ get: jest.fn().mockReturnValue(cookie) });

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'No refresh token' });
    expect(res.cookies._cookies).toEqual([]);
    expect(mockedFindSession).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test('DD-AUTH-027 行に revoked_at があれば failure（session_revoked）を残し、3つの Cookie を消して 401 で、交換は呼ばない', async () => {
    mockedFindSession.mockResolvedValue(sessionRow({ revoked_at: '2026-10-24T00:00:00.000Z' }));

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session revoked' });
    expectAuthCookiesCleared(res);
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'refresh',
      actor_id: 'user-from-row',
      outcome: 'failure',
      detail: 'session_revoked',
    });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedPersistNewSession).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: 'SUPABASE_URL がある',
      url: 'https://supabase.test',
      publicUrl: 'https://public.supabase.test',
      expected: 'https://supabase.test',
    },
    {
      label: 'SUPABASE_URL が無く NEXT_PUBLIC_SUPABASE_URL がある',
      url: undefined,
      publicUrl: 'https://public.supabase.test',
      expected: 'https://public.supabase.test',
    },
  ])('DD-AUTH-027 $label とき、その URL で交換を呼ぶ', async ({ url, publicUrl, expected }) => {
    if (url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = url;
    process.env.NEXT_PUBLIC_SUPABASE_URL = publicUrl;

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledWith(`${expected}/auth/v1/token?grant_type=refresh_token`, expect.any(Object));
  });

  test.each([
    { label: 'URL が両方とも無い', url: undefined, publicUrl: undefined, key: 'service-key' },
    { label: '鍵が無い', url: 'https://supabase.test', publicUrl: undefined, key: undefined },
    { label: 'URL が空文字で鍵も空文字', url: '', publicUrl: '', key: '' },
  ])('DD-AUTH-027 $label なら 500 Server misconfiguration で、監査も交換もしない', async ({ url, publicUrl, key }) => {
    for (const [name, value] of [
      ['SUPABASE_URL', url],
      ['NEXT_PUBLIC_SUPABASE_URL', publicUrl],
      ['SUPABASE_SERVICE_ROLE_KEY', key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }

    const res = await call();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Server misconfiguration' });
    expect(mockedLogAudit).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test('DD-AUTH-027 交換の応答が成功でなければ failure（応答の状態つき）を残し、3つの Cookie を消して 401', async () => {
    mockedFetch.mockResolvedValue(exchangeFailed(400));

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Failed to refresh token' });
    expectAuthCookiesCleared(res);
    expect(consoleError).toHaveBeenCalledWith('Token refresh failed:', 'invalid_grant');
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'refresh',
      actor_id: 'user-from-row',
      outcome: 'failure',
      detail: 'supabase_refresh_failed',
      metadata: { status: 400 },
    });
    expect(mockedPersistNewSession).not.toHaveBeenCalled();
  });

  test('DD-AUTH-027 旗が無効で行が無いまま交換が失敗しても 401 で、監査の利用者の id は undefined', async () => {
    process.env.AUTH_REQUIRE_APP_SESSION = 'off';
    mockedFindSession.mockResolvedValue(null);
    mockedFetch.mockResolvedValue(exchangeFailed(500));

    const res = await call();

    expect(res.status).toBe(401);
    expectAuthCookiesCleared(res);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'refresh',
      actor_id: undefined,
      outcome: 'failure',
      detail: 'supabase_refresh_failed',
      metadata: { status: 500 },
    });
  });

  test('DD-AUTH-027 行の差し替えが投げても発行済みのトークンは 200 で返し、error を監査に残す', async () => {
    const dbError = new Error('db down');
    mockedPersistNewSession.mockRejectedValue(dbError);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(consoleError).toHaveBeenCalledWith('Session DB update error during refresh:', dbError);
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'refresh',
      actor_id: 'user-from-row',
      outcome: 'error',
      detail: String(dbError),
    });
  });

  test('DD-AUTH-027 旗が無効で行が無いまま差し替えが投げても 200 で、error の監査の利用者の id は undefined', async () => {
    process.env.AUTH_REQUIRE_APP_SESSION = 'off';
    mockedFindSession.mockResolvedValue(null);
    mockedPersistNewSession.mockRejectedValue(new Error('db down'));

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'refresh',
      actor_id: undefined,
      outcome: 'error',
      detail: 'Error: db down',
    });
  });

  test('DD-AUTH-027 差し替えが成功のあと success の監査が投げたら、error を残して 200 を返す', async () => {
    mockedLogAudit.mockRejectedValueOnce(new Error('audit down')).mockResolvedValue(undefined);

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockedLogAudit).toHaveBeenCalledTimes(2);
    expect(mockedLogAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'refresh', outcome: 'error', detail: 'Error: audit down' }),
    );
  });

  test('DD-AUTH-027 交換の応答が JSON でなければ記録して 500', async () => {
    const parseError = new SyntaxError('Unexpected token');
    mockedFetch.mockResolvedValue({
      ...exchangeOk(),
      json: async () => {
        throw parseError;
      },
    });

    const res = await call();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalledWith('Refresh handler error:', parseError);
    expect(mockedPersistNewSession).not.toHaveBeenCalled();
  });

  test.each([
    { label: 'Cookie の読み出し', setup: () => mockedCookies.mockRejectedValue(new Error('no request scope')) },
    { label: '行の引き', setup: () => mockedFindSession.mockRejectedValue(new Error('db read failed')) },
    { label: '交換の fetch', setup: () => mockedFetch.mockRejectedValue(new Error('network down')) },
  ])('DD-AUTH-027 $label が投げたら 500 Internal server error', async ({ setup }) => {
    setup();

    const res = await call();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(consoleError).toHaveBeenCalledWith('Refresh handler error:', expect.any(Error));
    expect(mockedPersistNewSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/refresh 結び付けの強制（DD-AUTH-039）', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.AUTH_REQUIRE_APP_SESSION;
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    mockedCookies.mockResolvedValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    mockedEnforceRateLimit.mockResolvedValue(undefined);
    mockedPersistNewSession.mockResolvedValue(undefined);
    mockedLogAudit.mockResolvedValue(undefined);
    mockedFetch.mockResolvedValue(exchangeOk());
    global.fetch = mockedFetch as unknown as typeof fetch;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  test.each([
    { label: '前の行が無い', row: null, actor: undefined },
    { label: '前の行の auth_session_id が NULL', row: sessionRow({ auth_session_id: null }), actor: 'user-from-row' },
    { label: '前の行の auth_session_id が無い（列を返さない）', row: sessionRow({ auth_session_id: undefined }), actor: 'user-from-row' },
  ])('DD-AUTH-039 旗が有効で $label なら GoTrue を呼ばず 401 で、3つの Cookie を消し、unbound_session を監査に残す', async ({ row, actor }) => {
    mockedFindSession.mockResolvedValue(row);

    const res = await call();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Session not bound' });
    expectAuthCookiesCleared(res);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedPersistNewSession).not.toHaveBeenCalled();
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({
      action: 'refresh',
      actor_id: actor,
      outcome: 'failure',
      detail: 'unbound_session',
    });
    expect(JSON.stringify(mockedLogAudit.mock.calls)).not.toMatch(/old-refresh|4c36ef0b/);
  });

  test('DD-AUTH-039 旗が有効で行の引きが失敗（SessionLookupError）なら GoTrue を呼ばず 503 で、Cookie は消さず、session_lookup_failed を監査に残す', async () => {
    mockedFindSession.mockRejectedValue(Object.assign(new Error('lookup failed'), { name: 'SessionLookupError' }));

    const res = await call();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Session lookup failed' });
    expect(res.cookies._cookies).toEqual([]);
    expect(mockedFindSession).toHaveBeenCalledWith('old-refresh', { throwOnError: true });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedPersistNewSession).not.toHaveBeenCalled();
    expect(mockedLogAudit).toHaveBeenCalledTimes(1);
    expect(mockedLogAudit).toHaveBeenCalledWith({ action: 'refresh', outcome: 'error', detail: 'session_lookup_failed' });
    expect(consoleError).not.toHaveBeenCalledWith('Refresh handler error:', expect.anything());
  });

  test('DD-AUTH-039 旗が無効なら行の引きに throwOnError を渡さず、引きの失敗（null）でも従来どおり更新する', async () => {
    process.env.AUTH_REQUIRE_APP_SESSION = 'off';
    mockedFindSession.mockResolvedValue(null);

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockedFindSession).toHaveBeenCalledWith('old-refresh', { throwOnError: false });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  test('DD-AUTH-039 旗が有効で前の行が失効済みなら、従来どおり session_revoked で GoTrue を呼ばず 401', async () => {
    mockedFindSession.mockResolvedValue(sessionRow({ revoked_at: '2026-10-24T00:00:00.000Z' }));

    const res = await call();

    expect(res.status).toBe(401);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedLogAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'session_revoked' }));
  });

  test('DD-AUTH-039 旗が有効で結び付いた行なら更新し、persistNewSession に前の行の auth_session_id を渡す', async () => {
    mockedFindSession.mockResolvedValue(sessionRow());

    const res = await call();

    expect(res.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedPersistNewSession).toHaveBeenCalledWith(res, expect.objectContaining({ trustedAuthSessionId: AUTH_SESSION_ID }));
  });

  test.each(['off', 'OFF', '0', 'false'])(
    'DD-AUTH-039 旗が %s なら、結び付いていない行でも従来どおり更新できる（trustedAuthSessionId は null）',
    async (flag) => {
      process.env.AUTH_REQUIRE_APP_SESSION = flag;
      mockedFindSession.mockResolvedValue(sessionRow({ auth_session_id: null }));

      const res = await call();

      expect(res.status).toBe(200);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockedPersistNewSession.mock.calls[0][1].trustedAuthSessionId).toBeNull();
    },
  );
});
