export {};

// ログインの後の行き先の窓口（API-AUTH-019）。戻り先の解決（return-intent-service・return-path）は本物を通し、
// 認証の確かめと、控えの表を触る rpc（consume_auth_return_intent）だけを差し替える。

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => {
      const headers = new Map<string, string>(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      return {
        status: init?.status ?? 200,
        json: async () => body,
        headers: {
          set: (k: string, v: string) => headers.set(k.toLowerCase(), v),
          get: (k: string) => headers.get(k.toLowerCase()) ?? null,
        },
        cookies: { set: jest.fn() },
      };
    },
  },
}));

const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockLogAudit(...args),
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockAuthenticateRequest = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  authFailureResponse: (reason: string) => {
    const { NextResponse } = jest.requireMock('next/server');
    return reason === 'unavailable'
      ? NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503, headers: { 'Retry-After': '30' } })
      : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  },
}));

const INTENT_TOKEN = 'C'.repeat(43);
const INTENT_COOKIE = `sb-return-intent=${INTENT_TOKEN}`;

const viewer = (role: string, aal: string) => ({
  ok: true,
  claims: { sub: 'user-1', aal, app_metadata: { role } },
});

describe('API-AUTH-019 POST /api/auth/post-login', () => {
  const errorSpy = jest.spyOn(console, 'error');

  function postLoginRequest(headers: Record<string, string> = {}) {
    return new Request('http://localhost:3000/api/auth/post-login', { method: 'POST', headers });
  }

  async function callPost(request: Request): Promise<any> {
    const route = await import('@/app/api/auth/post-login/route');
    return route.POST(request);
  }

  /** 最初の 1 回だけ道筋を返し、2 回目からは null を返す（1 回で使い切る DB の関数の写し）。 */
  function fakeConsume(returnPath: string | null) {
    let used = false;
    mockRpc.mockImplementation(async (name: string) => {
      if (name !== 'consume_auth_return_intent' || used) return { data: null, error: null };
      used = true;
      return { data: returnPath, error: null };
    });
  }

  function intentCookieCalls(res: any) {
    return (res.cookies.set as jest.Mock).mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg && typeof arg === 'object' && arg.name === 'sb-return-intent');
  }

  beforeEach(() => {
    jest.resetAllMocks();
    errorSpy.mockImplementation(() => undefined);
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockAuthenticateRequest.mockResolvedValue(viewer('user', 'aal1'));
  });

  afterAll(() => {
    errorSpy.mockRestore();
  });

  test('API-AUTH-019 未ログインは 401 で、控えの表に触らない', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthorized' });
    fakeConsume('/item/3');

    const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('API-AUTH-019 一般の会員は控えを login の用途で使い切って戻り先を受け取り、Cookie が消える', async () => {
    fakeConsume('/item/3?color=red');

    const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: '/item/3?color=red', needsMfa: false });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('consume_auth_return_intent', {
      _token_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      _purpose: 'login',
      _user_id: 'user-1',
    });
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(INTENT_TOKEN);
    expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0, path: '/' })]);
  });

  test('API-AUTH-019 続けて 2 回呼ぶと 2 回目は戻り先が出ず / になる（FR-AUTH-005-AC-07 の単位試験版）', async () => {
    fakeConsume('/item/3');

    const first = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));
    const second = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    expect((await first.json()).redirectTo).toBe('/item/3');
    expect(await second.json()).toEqual({ redirectTo: '/', needsMfa: false });
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  test('API-AUTH-019 控えの Cookie が無ければ / を返し、表に触らず Cookie も触らない', async () => {
    fakeConsume('/item/3');

    const res = await callPost(postLoginRequest());

    expect(await res.json()).toEqual({ redirectTo: '/', needsMfa: false });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(intentCookieCalls(res)).toEqual([]);
  });

  test('API-AUTH-019 形の合わない番号の Cookie は表に触らず / を返し、Cookie を消す', async () => {
    const res = await callPost(postLoginRequest({ cookie: 'sb-return-intent=short' }));

    expect(await res.json()).toEqual({ redirectTo: '/', needsMfa: false });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0 })]);
  });

  test('API-AUTH-019 一般の会員で保存が /admin（入口で通った古い控え）なら出口で外れて / になる', async () => {
    fakeConsume('/admin');

    const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    expect(await res.json()).toEqual({ redirectTo: '/', needsMfa: false });
  });

  test.each(['//evil.example.net', '/login', '/api/auth/me', '/%09/evil.example.net'])(
    'API-AUTH-019 保存の値が改ざんされて %s になっていても出口の確かめで外れ、既定の / を返す',
    async (stored) => {
      fakeConsume(stored);

      const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

      expect(await res.json()).toEqual({ redirectTo: '/', needsMfa: false });
    },
  );

  test('API-AUTH-019 特権・aal2 で保存が /admin/orders ならそのまま返す', async () => {
    mockAuthenticateRequest.mockResolvedValue(viewer('admin', 'aal2'));
    fakeConsume('/admin/orders');

    const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    expect(await res.json()).toEqual({ redirectTo: '/admin/orders', needsMfa: false });
    expect(mockRpc).toHaveBeenCalledWith('consume_auth_return_intent', expect.objectContaining({ _user_id: 'user-1' }));
  });

  test.each(['admin', 'supporter'])('API-AUTH-019 %s・aal2 で控えが無ければ既定の /admin を返す', async (role) => {
    mockAuthenticateRequest.mockResolvedValue(viewer(role, 'aal2'));

    const res = await callPost(postLoginRequest());

    expect(await res.json()).toEqual({ redirectTo: '/admin', needsMfa: false });
  });

  test.each(['admin', 'supporter'])('API-AUTH-019 %s・aal1 は表に触らず /auth/verified と needsMfa:true を返し、控えの Cookie を残す', async (role) => {
    mockAuthenticateRequest.mockResolvedValue(viewer(role, 'aal1'));
    fakeConsume('/admin/orders');

    const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    expect(await res.json()).toEqual({ redirectTo: '/auth/verified', needsMfa: true });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(intentCookieCalls(res)).toEqual([]);
  });

  test('API-AUTH-019 控えの表の rpc が失敗しても 200 で既定の / を返し、Cookie を消す（ログインを止めない）', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'XX000' } });

    const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: '/', needsMfa: false });
    expect(intentCookieCalls(res)).toEqual([expect.objectContaining({ value: '', maxAge: 0 })]);
  });

  test('API-AUTH-019 要求の見出しの x-role・x-aal では特権にならない（claims だけを信じる）', async () => {
    fakeConsume('/admin');

    const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE, 'x-role': 'admin', 'x-aal': 'aal2' }));

    expect(await res.json()).toEqual({ redirectTo: '/', needsMfa: false });
  });

  test('API-AUTH-019 制限に当たったらその応答をそのまま返し、認証にも表にも進まない', async () => {
    const limited = { status: 429 };
    mockEnforceRateLimit.mockResolvedValue(limited);

    const res = await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    expect(res).toBe(limited);
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  test('API-AUTH-019 監査と console に戻り先の道筋・番号を残さない', async () => {
    fakeConsume('/item/secret-path');

    await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));
    fakeConsume('/login');
    await callPost(postLoginRequest({ cookie: INTENT_COOKIE }));

    const logged = JSON.stringify([mockLogAudit.mock.calls, errorSpy.mock.calls]);
    expect(logged).not.toContain(INTENT_TOKEN);
    expect(logged).not.toContain('secret-path');
  });
});
