export {};

jest.mock('next/server', () => ({
  NextResponse: {
    redirect: (url: any, init?: any) => {
      const headers = {
        _map: new Map<string, string>(),
        set(key: string, value: string) {
          this._map.set(key.toLowerCase(), value);
        },
        get(key: string) {
          return this._map.get(key.toLowerCase()) || null;
        },
      };
      headers.set('Location', url.toString());
      return {
        status: init?.status ?? 302,
        headers,
        cookies: {
          set: jest.fn(),
        },
      };
    },
  },
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
}));

// Mock rateLimit middleware to avoid DB calls
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockLinkGuestOrdersByEmail = jest.fn().mockResolvedValue(0);
jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: (...args: unknown[]) => mockLinkGuestOrdersByEmail(...args),
}));

describe('GET /api/auth/confirm', () => {
  const env = process.env as Record<string, string | undefined>;
  const ORIGINAL_ALLOWED = env.APP_ALLOWED_ORIGINS;
  const ORIGINAL_TRUST = env.TRUST_PROXY_HEADERS;

  afterAll(() => {
    env.APP_ALLOWED_ORIGINS = ORIGINAL_ALLOWED;
    env.TRUST_PROXY_HEADERS = ORIGINAL_TRUST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // x-forwarded-host は二段の条件を満たしたときだけ採用される。
    // 1) 信頼できる proxy 配下であること（TRUST_PROXY_HEADERS / VERCEL）
    // 2) その origin が許可リストに載っていること
    // どちらも Host ヘッダー注入によるオープンリダイレクト対策。
    env.TRUST_PROXY_HEADERS = 'true';
    env.APP_ALLOWED_ORIGINS = 'http://example.com';
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({
      auth: {
        verifyOtp: jest.fn().mockResolvedValue({ data: null, error: null }),
      },
    });
  });

  test('missing token redirects to default path', async () => {
    const route = await import('@/app/api/auth/confirm/route');
    const req = new Request('http://localhost/api/auth/confirm', {
      headers: { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'http' },
    });

    let res: any;
    try {
      res = await route.GET(req as any);
    } catch (err) {
      console.error('confirm missing-token test error:', err);
      throw err;
    }
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('http://example.com/account');
  });

  test('valid token redirects to redirect_to and persists session', async () => {
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({
      auth: {
        verifyOtp: jest.fn().mockResolvedValue({
          data: {
            session: { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
            user: { id: 'u1', email: 'user@example.com' },
          },
          error: null,
        }),
      },
    });

    const { persistSessionAndCookies } = require('@/features/auth/services/register');

    const route = await import('@/app/api/auth/confirm/route');
    const req = new Request('http://localhost/api/auth/confirm?token_hash=hash&type=signup&redirect_to=%2Fauth%2Fverified', {
      headers: { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'http' },
    });

    let res: any;
    try {
      res = await route.GET(req as any);
    } catch (err) {
      console.error('confirm valid-token test error:', err);
      throw err;
    }

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('http://example.com/auth/verified');
    expect(persistSessionAndCookies).toHaveBeenCalled();
  });

  test('メール確認に成功したらゲスト注文の紐付けを呼ぶ', async () => {
    const { persistSessionAndCookies } = require('@/features/auth/services/register');
    persistSessionAndCookies.mockResolvedValue({ ok: true });

    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({
      auth: {
        verifyOtp: jest.fn().mockResolvedValue({
          data: {
            session: { access_token: 'a', refresh_token: 'r' },
            user: {
              id: 'user-1',
              email: 'hanako@example.com',
              email_confirmed_at: '2026-08-10T00:00:00Z',
            },
          },
          error: null,
        }),
      },
    });

    const { GET } = require('@/app/api/auth/confirm/route');
    await GET(new Request('http://example.com/api/auth/confirm?token_hash=t&type=email'));

    expect(mockLinkGuestOrdersByEmail).toHaveBeenCalledWith({
      userId: 'user-1',
      email: 'hanako@example.com',
      emailConfirmedAt: '2026-08-10T00:00:00Z',
    });
  });

  test('許可リストに無い x-forwarded-host は採用しない', async () => {
    const route = await import('@/app/api/auth/confirm/route');
    const req = new Request('http://localhost/api/auth/confirm', {
      headers: { 'x-forwarded-host': 'evil.example.net', 'x-forwarded-proto': 'http' },
    });

    const res: any = await route.GET(req as any);

    // 攻撃者が指定したホストへは飛ばさず、既定のオリジンへ戻す。
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).not.toContain('evil.example.net');
  });

  test('信頼できる proxy 配下でなければ x-forwarded-host を見ない', async () => {
    env.TRUST_PROXY_HEADERS = 'false';

    const route = await import('@/app/api/auth/confirm/route');
    const req = new Request('http://localhost/api/auth/confirm', {
      headers: { 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'http' },
    });

    const res: any = await route.GET(req as any);

    // 許可リストに載っている origin でも、proxy を信頼しない設定では採用しない。
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('http://localhost:3000/account');
  });
});
