import { NextResponse } from 'next/server';
import {
  applyRotatedCsrfCookie,
  enforceAdminStockistMutationRateLimit,
  enforceAdminStockistReadRateLimit,
  hasRotatedCsrfToken,
  requireAdminStockistCsrf,
  toCsrfDenyResponse,
} from '@/features/stockist/services/admin-security';

const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRequireCsrfOrDeny = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: () => mockRequireCsrfOrDeny(),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const cookies = new Map<string, Record<string, unknown>>();
      return {
        status: init?.status ?? 200,
        headers: new Headers(),
        json: async () => body,
        cookies: {
          set: (cookie: { name: string }) => cookies.set(cookie.name, cookie),
          get: (name: string) => cookies.get(name),
          getAll: () => Array.from(cookies.values()),
        },
      };
    },
  },
}));

beforeEach(() => {
  jest.resetAllMocks();
});

describe('requireAdminStockistCsrf', () => {
  it('DD-STOCKIST-036 共有の確かめが undefined を返せばそのまま返す', async () => {
    mockRequireCsrfOrDeny.mockResolvedValue(undefined);
    await expect(requireAdminStockistCsrf()).resolves.toBeUndefined();
    expect(mockRequireCsrfOrDeny).toHaveBeenCalledTimes(1);
  });

  it('DD-STOCKIST-036 共有の確かめが拒否の Response を返せば同じ物を返す', async () => {
    const denied = new Response(null, { status: 403 });
    mockRequireCsrfOrDeny.mockResolvedValue(denied);
    await expect(requireAdminStockistCsrf()).resolves.toBe(denied);
  });
});

describe('hasRotatedCsrfToken', () => {
  it('DD-STOCKIST-036 rotatedCsrfToken の鍵を持つ物で真を返す', () => {
    expect(hasRotatedCsrfToken({ rotatedCsrfToken: 't' })).toBe(true);
  });

  it('DD-STOCKIST-036 rotatedCsrfToken の鍵が無い別の鍵だけの物は偽を返す', () => {
    expect(hasRotatedCsrfToken({ status: 403, _body: {} })).toBe(false);
  });

  it.each([null, 'x', {}, undefined, 1])('DD-STOCKIST-036 hasRotatedCsrfToken は %p で偽を返す', (value) => {
    expect(hasRotatedCsrfToken(value)).toBe(false);
  });
});

describe('toCsrfDenyResponse', () => {
  it.each([undefined, null, 0, ''])('DD-STOCKIST-036 偽の値 %p は null を返して通す', (value) => {
    expect(toCsrfDenyResponse(value)).toBeNull();
  });

  it('DD-STOCKIST-036 回した token の形は null を返して通す', () => {
    expect(toCsrfDenyResponse({ rotatedCsrfToken: 't' })).toBeNull();
  });

  it('DD-STOCKIST-036 Response はそのまま同じ物を返す', () => {
    const denied = new Response(null, { status: 403 });
    expect(toCsrfDenyResponse(denied)).toBe(denied);
  });

  it('DD-STOCKIST-036 状態と本文を持つ作り物の形から同じ状態と本文の応答を作る', async () => {
    const response = toCsrfDenyResponse({ status: 403, _body: { error: 'Forbidden' } });
    expect(response).not.toBeNull();
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({ error: 'Forbidden' });
  });

  it('DD-STOCKIST-036 headers が Headers なら全部を応答の見出しに写す', () => {
    const response = toCsrfDenyResponse({
      status: 403,
      _body: { error: 'Forbidden' },
      headers: new Headers({ 'x-a': '1', 'x-c': '3' }),
    });
    expect(response?.headers.get('x-a')).toBe('1');
    expect(response?.headers.get('x-c')).toBe('3');
  });

  it('DD-STOCKIST-036 headers がただの物なら全部の組を応答の見出しに写す', () => {
    const response = toCsrfDenyResponse({
      status: 429,
      _body: { error: 'Too many requests' },
      headers: { 'x-b': '2', 'retry-after': '600' },
    });
    expect(response?.status).toBe(429);
    expect(response?.headers.get('x-b')).toBe('2');
    expect(response?.headers.get('retry-after')).toBe('600');
  });

  it('DD-STOCKIST-036 headers が無い作り物の形でも見出しを足さずに応答を返す', () => {
    const response = toCsrfDenyResponse({ status: 403, _body: {} });
    expect(response?.status).toBe(403);
    expect(response?.headers.get('x-a')).toBeNull();
  });

  it('DD-STOCKIST-036 headers が null の作り物の形でも見出しを足さずに応答を返す', () => {
    const response = toCsrfDenyResponse({ status: 500, _body: { error: 'x' }, headers: null });
    expect(response?.status).toBe(500);
  });

  it.each([{ status: 403 }, { _body: {} }, 'x', 5, {}])(
    'DD-STOCKIST-036 拒否の形でない値 %p は null を返して通す',
    (value) => {
      expect(toCsrfDenyResponse(value)).toBeNull();
    },
  );
});

describe('applyRotatedCsrfCookie', () => {
  it.each([undefined, null, {}, 'x'])('DD-STOCKIST-037 結果が %p の時は Cookie を増やさない', (result) => {
    const response = NextResponse.json({ success: true });
    applyRotatedCsrfCookie(response, result);
    expect(response.cookies.getAll()).toHaveLength(0);
  });

  // 現状の動きの記録。maxAge 0 はブラウザに Cookie を消させる値で、食い違いの候補（ユーザーに聞く項目）。答えが出たらこの件を直す。
  it('DD-STOCKIST-037 現状の記録 回した token の形なら csrf の Cookie を値 t で付ける', () => {
    const response = NextResponse.json({ success: true });
    applyRotatedCsrfCookie(response, { rotatedCsrfToken: 't' });
    const cookie = response.cookies.get('sb-csrf-token');
    expect(cookie?.value).toBe('t');
    expect(cookie?.httpOnly).toBeFalsy();
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.maxAge).toBe(0);
  });
});

describe('回数の制限', () => {
  const request = new Request('http://localhost/api/admin/stockists', { method: 'GET' });
  const tooMany = new Response(null, { status: 429 });
  const unavailable = new Response(null, { status: 503 });

  it('DD-STOCKIST-038 読みの関数は read の枠で2回数え、2回目だけに操作者の id を渡す', async () => {
    mockEnforceRateLimit.mockResolvedValue(undefined);
    await expect(enforceAdminStockistReadRateLimit(request, 'admin-1')).resolves.toBeUndefined();
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request,
      endpoint: 'admin:stockists:read',
      limit: 120,
      windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request,
      endpoint: 'admin:stockists:read',
      limit: 120,
      windowSeconds: 600,
      subject: 'admin-1',
    });
  });

  it('DD-STOCKIST-038 変更の関数は mutation の枠で2回数え、2回目だけに操作者の id を渡す', async () => {
    mockEnforceRateLimit.mockResolvedValue(undefined);
    await expect(enforceAdminStockistMutationRateLimit(request, 'admin-2')).resolves.toBeUndefined();
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request,
      endpoint: 'admin:stockists:mutation',
      limit: 20,
      windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request,
      endpoint: 'admin:stockists:mutation',
      limit: 20,
      windowSeconds: 600,
      subject: 'admin-2',
    });
  });

  it('DD-STOCKIST-038 送り元の枠が止めたらその応答を返し、操作者の枠を数えない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(tooMany);
    await expect(enforceAdminStockistReadRateLimit(request, 'admin-1')).resolves.toBe(tooMany);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
  });

  it('DD-STOCKIST-038 変更の関数も送り元の枠が止めたら操作者の枠を数えない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(unavailable);
    await expect(enforceAdminStockistMutationRateLimit(request, 'admin-1')).resolves.toBe(unavailable);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
  });

  it('DD-STOCKIST-038 読みの関数も送り元を通り操作者の枠が止めたらその応答を返す', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(unavailable);
    await expect(enforceAdminStockistReadRateLimit(request, 'admin-1')).resolves.toBe(unavailable);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
  });

  it('DD-STOCKIST-038 変更の関数も送り元を通り操作者の枠が使えない時はその応答を返す', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(unavailable);
    await expect(enforceAdminStockistMutationRateLimit(request, 'admin-1')).resolves.toBe(unavailable);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
  });

  it('DD-STOCKIST-038 送り元を通り操作者の枠が止めたらその応答を返す', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(tooMany);
    await expect(enforceAdminStockistMutationRateLimit(request, 'admin-1')).resolves.toBe(tooMany);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
  });
});
