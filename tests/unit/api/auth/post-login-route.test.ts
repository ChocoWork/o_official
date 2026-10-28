/**
 * DD-AUTH-035 ログインの後の行き先の窓口（src/app/api/auth/post-login/route.ts）の単体テスト。
 * 回数の制限・認証・戻り先の解決（return-intent-service）は差し替え、窓口の分岐と、役割と aal の出どころ、応答の形を確かめる。
 */

jest.mock('next/server', () => {
  const makeHeaders = (init?: Record<string, string>) => {
    const map = new Map<string, string>(Object.entries(init ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      set: (key: string, value: string) => map.set(key.toLowerCase(), value),
      get: (key: string) => map.get(key.toLowerCase()) ?? null,
    };
  };
  return {
    NextResponse: {
      json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
        status: init?.status ?? 200,
        json: async () => body,
        headers: makeHeaders(init?.headers),
        cookies: { set: jest.fn() },
      }),
    },
  };
});

const mockAuthenticateRequest = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  // 実物と同じ形（unavailable は 503 + Retry-After、他は 401）の写し。
  authFailureResponse: (reason: string) => {
    const { NextResponse } = jest.requireMock('next/server');
    return reason === 'unavailable'
      ? NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503, headers: { 'Retry-After': '30' } })
      : NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  },
}));

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockResolveReturnDestination = jest.fn();
const mockApplyReturnIntentCookie = jest.fn();
jest.mock('@/features/auth/return-intent/return-intent-service', () => ({
  resolveReturnDestination: (...args: unknown[]) => mockResolveReturnDestination(...args),
  applyReturnIntentCookie: (...args: unknown[]) => mockApplyReturnIntentCookie(...args),
}));

import { POST } from '@/app/api/auth/post-login/route';

function request(headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/auth/post-login', { method: 'POST', headers });
}

const verifiedWith = (claims: Record<string, unknown> = {}) => ({
  ok: true,
  claims: { sub: 'user-1', aal: 'aal1', app_metadata: { role: 'user' }, ...claims },
});

describe('POST /api/auth/post-login', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockAuthenticateRequest.mockResolvedValue(verifiedWith());
    mockResolveReturnDestination.mockResolvedValue({ path: '/', needsMfa: false, action: { kind: 'keep' } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('DD-AUTH-035 回数の制限（auth:post-login・600 秒に 60 回）に当たったらその応答を返し、認証にも進まない', async () => {
    const limited = { status: 429 };
    mockEnforceRateLimit.mockResolvedValue(limited);

    const res = await POST(request());

    expect(res).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:post-login', limit: 60, windowSeconds: 600 }),
    );
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    expect(mockResolveReturnDestination).not.toHaveBeenCalled();
  });

  test('DD-AUTH-035 制限の部品が投げたら握りつぶさず、戻り先に触れない（SEC-AUTH-013-AC-02）', async () => {
    mockEnforceRateLimit.mockRejectedValue(new Error('rate down'));

    await expect(POST(request())).rejects.toThrow('rate down');

    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Rate limit middleware error'),
      expect.anything(),
    );
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    expect(mockResolveReturnDestination).not.toHaveBeenCalled();
  });

  test('DD-AUTH-035 未ログイン（unauthorized）なら 401 を返し、戻り先に触らない', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthorized' });

    const res: any = await POST(request({ cookie: 'sb-return-intent=x' }));

    expect(res.status).toBe(401);
    expect(mockResolveReturnDestination).not.toHaveBeenCalled();
    expect(mockApplyReturnIntentCookie).not.toHaveBeenCalled();
  });

  test('DD-AUTH-035 失効の確認ができない（unavailable）なら 503 と Retry-After を返し、戻り先に触らない', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: false, reason: 'unavailable' });

    const res: any = await POST(request());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(mockResolveReturnDestination).not.toHaveBeenCalled();
    expect(mockApplyReturnIntentCookie).not.toHaveBeenCalled();
  });

  test('DD-AUTH-035 一般の会員なら 200 で解決した戻り先と needsMfa:false を返し、login の用途で解決する', async () => {
    const action = { kind: 'clear' };
    mockResolveReturnDestination.mockResolvedValue({ path: '/item/3', needsMfa: false, action });
    const req = request({ cookie: 'sb-return-intent=x; other=1' });

    const res: any = await POST(req);

    expect(mockAuthenticateRequest).toHaveBeenCalledWith(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: '/item/3', needsMfa: false });
    expect(mockResolveReturnDestination).toHaveBeenCalledWith({
      cookieHeader: 'sb-return-intent=x; other=1',
      purpose: 'login',
      viewer: { id: 'user-1', role: 'user', aal: 'aal1' },
    });
    expect(mockApplyReturnIntentCookie).toHaveBeenCalledWith(res, action);
  });

  test('DD-AUTH-035 応答は no-store と no-referrer', async () => {
    const res: any = await POST(request());

    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  test('DD-AUTH-035 役割と aal はトークンの claims から読み、要求の見出し（x-role など）は無視する', async () => {
    mockAuthenticateRequest.mockResolvedValue(verifiedWith({ aal: 'aal2', app_metadata: { role: 'supporter' } }));

    await POST(request({ 'x-role': 'admin', 'x-aal': 'aal1' }));

    expect(mockResolveReturnDestination).toHaveBeenCalledWith(
      expect.objectContaining({ viewer: { id: 'user-1', role: 'supporter', aal: 'aal2' } }),
    );
  });

  test.each([
    ['役割が無い', {}],
    ['app_metadata が無い', undefined],
    ['未知の役割', { role: 'owner' }],
    ['文字でない役割', { role: 1 }],
  ])('DD-AUTH-035 %s なら user として解決に渡す', async (_label, appMetadata) => {
    mockAuthenticateRequest.mockResolvedValue(verifiedWith({ app_metadata: appMetadata }));

    await POST(request());

    expect(mockResolveReturnDestination).toHaveBeenCalledWith(
      expect.objectContaining({ viewer: expect.objectContaining({ role: 'user' }) }),
    );
  });

  test('DD-AUTH-035 aal が claims に無ければ null で解決に渡す', async () => {
    mockAuthenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'user-1' } });

    await POST(request());

    expect(mockResolveReturnDestination).toHaveBeenCalledWith(
      expect.objectContaining({ viewer: { id: 'user-1', role: 'user', aal: null } }),
    );
  });

  test('DD-AUTH-035 特権・aal1 なら needsMfa:true と /auth/verified を返し、控えの Cookie には触らない（keep）', async () => {
    mockAuthenticateRequest.mockResolvedValue(verifiedWith({ app_metadata: { role: 'admin' } }));
    mockResolveReturnDestination.mockResolvedValue({
      path: '/auth/verified',
      needsMfa: true,
      action: { kind: 'keep' },
    });

    const res: any = await POST(request({ cookie: 'sb-return-intent=x' }));

    expect(await res.json()).toEqual({ redirectTo: '/auth/verified', needsMfa: true });
    expect(mockApplyReturnIntentCookie).toHaveBeenCalledWith(res, { kind: 'keep' });
  });

  test('DD-AUTH-035 Cookie の見出しが無ければ null を解決へ渡す', async () => {
    await POST(request());

    expect(mockResolveReturnDestination).toHaveBeenCalledWith(expect.objectContaining({ cookieHeader: null }));
  });

  test('DD-AUTH-035 想定外の例外は 500 の汎用の応答にし、内部の理由・戻り先を本文に出さない', async () => {
    mockResolveReturnDestination.mockRejectedValue(new Error('boom /item/3'));

    const res: any = await POST(request({ cookie: 'sb-return-intent=x' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
