// ログアウトは、この端末のゲストのカート・お気に入りの印（cart・wishlist の Cookie）も消す（設計書 4-3）。
// 会員の分はサーバーに残り、次のログインで戻るため、DB の会員の分には触れない。

import { POST } from '@/app/api/auth/logout/route';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyAccessToken } from '@/lib/auth/authenticate';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { cookies, headers } from 'next/headers';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const res = {
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
      };
      return res;
    },
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
}));

// CSRF の確かめはここで見たいことではないため、素通り（undefined）か拒否の応答を返す。
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const mockedCookies = cookies as unknown as jest.Mock;
const mockedHeaders = headers as unknown as jest.Mock;
const mockedCreateServiceRoleClient = createServiceRoleClient as jest.Mock;
const mockedVerifyAccessToken = verifyAccessToken as jest.Mock;
const mockedRequireCsrfOrDeny = requireCsrfOrDeny as jest.Mock;

/** 消えた Cookie は、値が空で有効期限が0秒（ブラウザに捨てさせる指示）になっている */
const CLEARED = { value: '', maxAge: 0, path: '/', httpOnly: true };

describe('POST /api/auth/logout: ゲストのカート・お気に入りの印', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedCookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined), getAll: jest.fn().mockReturnValue([]) });
    mockedHeaders.mockReturnValue({ get: jest.fn().mockReturnValue(null) });
    mockedRequireCsrfOrDeny.mockResolvedValue(undefined);
    mockedVerifyAccessToken.mockResolvedValue({ ok: true, claims: { session_id: 'session-1' } });
  });

  afterEach(() => jest.restoreAllMocks());

  test('未ログイン（refresh Cookie なし）でも、cart と wishlist の Cookie を消す', async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(res.cookies.get('cart')).toMatchObject({ name: 'cart', ...CLEARED });
    expect(res.cookies.get('wishlist')).toMatchObject({ name: 'wishlist', ...CLEARED });
  });

  test('ログイン中のログアウトでも、cart と wishlist の Cookie を消し、会員の分の DB には触れない', async () => {
    mockedCookies.mockReturnValue({
      get: jest.fn().mockReturnValue({ value: 'old-refresh' }),
      getAll: jest.fn().mockReturnValue([]),
    });
    const select = jest.fn().mockResolvedValue({ data: [{ user_id: 'user-1' }], error: null });
    const update = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ select }) });
    const from = jest.fn<{ update: jest.Mock }, [string]>(() => ({ update }));
    const rpc = jest.fn().mockResolvedValue({ data: 1, error: null });
    mockedCreateServiceRoleClient.mockResolvedValue({ from, rpc });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(res.cookies.get('cart')).toMatchObject({ name: 'cart', ...CLEARED });
    expect(res.cookies.get('wishlist')).toMatchObject({ name: 'wishlist', ...CLEARED });
    // 触れる表はセッションだけ。カート・お気に入りの表（会員の分）は消さない。
    expect(from.mock.calls.map(([table]) => table)).toEqual(['sessions']);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['revoke_auth_session']);
  });

  test('セッションを失効させる DB が落ちても、cart と wishlist の Cookie は消す', async () => {
    mockedCookies.mockReturnValue({
      get: jest.fn().mockReturnValue({ value: 'old-refresh' }),
      getAll: jest.fn().mockReturnValue([]),
    });
    mockedCreateServiceRoleClient.mockResolvedValue({
      from: jest.fn(() => ({
        update: jest.fn(() => {
          throw new Error('db fail');
        }),
      })),
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(res.cookies.get('cart')).toMatchObject({ name: 'cart', ...CLEARED });
    expect(res.cookies.get('wishlist')).toMatchObject({ name: 'wishlist', ...CLEARED });
  });

  test('CSRF が拒否されても、cart と wishlist の Cookie は消す', async () => {
    mockedCookies.mockReturnValue({
      get: jest.fn().mockReturnValue({ value: 'old-refresh' }),
      getAll: jest.fn().mockReturnValue([]),
    });
    mockedCreateServiceRoleClient.mockResolvedValue({ from: jest.fn(), rpc: jest.fn() });
    mockedRequireCsrfOrDeny.mockResolvedValue({ status: 403, _body: { error: 'Forbidden' } });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(res.cookies.get('cart')).toMatchObject({ name: 'cart', ...CLEARED });
    expect(res.cookies.get('wishlist')).toMatchObject({ name: 'wishlist', ...CLEARED });
  });
});
