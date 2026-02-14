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

describe('GET /api/auth/confirm', () => {
  beforeEach(() => {
    jest.resetAllMocks();
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
      // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
      console.error('confirm valid-token test error:', err);
      throw err;
    }

    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('http://example.com/auth/verified');
    expect(persistSessionAndCookies).toHaveBeenCalled();
  });
});
