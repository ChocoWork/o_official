export {};
jest.mock('server-only', () => ({}), { virtual: true });

jest.mock('next/server', () => ({
  after: () => {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const cookies: Array<Record<string, unknown>> = [];
      return {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map<string, string>(),
        cookies: {
          _cookies: cookies,
          set(c: Record<string, unknown>) {
            cookies.push(c);
          },
          get(name: string) {
            return cookies.find((c) => c.name === name);
          },
        },
      };
    },
  },
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

const { cookies } = require('next/headers');

const MINUTE = 60;
const DAY = 24 * 60 * 60;

const setNodeEnv = (value: string | undefined) => {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
};

const cookieLib = () => require('@/lib/cookie') as typeof import('@/lib/cookie');

describe('認証の Cookie は用途ごとに名前・寿命・属性を分ける（DATA-AUTH-004）', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.JWT_SECRET = 'test-jwt-secret';
    delete process.env.LOGIN_2FA_SESSION_SECRET;
    delete process.env.PASSWORD_RESET_SESSION_SECRET;
    setNodeEnv('test');
    cookies.mockResolvedValue({ get: jest.fn().mockReturnValue(undefined), getAll: jest.fn().mockReturnValue([]) });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setNodeEnv(ORIGINAL_NODE_ENV);
  });

  describe('名前と属性の表', () => {
    const rows = [
      { label: 'access token', name: 'sb-access-token', nameKey: 'accessCookieName', optionsKey: 'cookieOptionsForAccess', maxAge: 7 * DAY, httpOnly: true, sameSite: 'lax' },
      { label: 'refresh token', name: 'sb-refresh-token', nameKey: 'refreshCookieName', optionsKey: 'cookieOptionsForRefresh', maxAge: 7 * DAY, httpOnly: true, sameSite: 'lax' },
      { label: 'CSRF の印', name: 'sb-csrf-token', nameKey: 'csrfCookieName', optionsKey: 'cookieOptionsForCsrf', maxAge: 7 * DAY, httpOnly: false, sameSite: 'lax' },
      { label: '端末の印', name: 'session_id', nameKey: 'sessionCookieName', optionsKey: 'cookieOptionsForSession', maxAge: 30 * DAY, httpOnly: true, sameSite: 'lax' },
      { label: 'ログインの保留', name: 'sb-login-2fa-session', nameKey: 'loginTwoFactorSessionCookieName', optionsKey: 'cookieOptionsForLoginTwoFactor', maxAge: 5 * MINUTE, httpOnly: true, sameSite: 'strict' },
      { label: '再設定', name: 'sb-password-reset-session', nameKey: 'passwordResetSessionCookieName', optionsKey: 'cookieOptionsForPasswordReset', maxAge: 10 * MINUTE, httpOnly: true, sameSite: 'strict' },
    ] as const;

    test.each(rows)('DATA-AUTH-004 $label の Cookie は名前 $name・HttpOnly=$httpOnly・SameSite=$sameSite・パス / で、渡した寿命を持つ', (row) => {
      const lib = cookieLib() as unknown as Record<string, any>;

      expect(lib[row.nameKey]).toBe(row.name);
      expect(lib[row.optionsKey](row.maxAge)).toEqual({
        httpOnly: row.httpOnly,
        secure: false,
        sameSite: row.sameSite,
        path: '/',
        maxAge: row.maxAge,
      });
    });

    test.each(rows)('DATA-AUTH-004 $label の Cookie は本番だけ Secure を付ける', (row) => {
      const lib = cookieLib() as unknown as Record<string, any>;

      setNodeEnv('production');
      expect(lib[row.optionsKey](row.maxAge).secure).toBe(true);
      setNodeEnv('development');
      expect(lib[row.optionsKey](row.maxAge).secure).toBe(false);
    });

    test('DATA-AUTH-004 消す時の Cookie は HttpOnly と SameSite=Lax を保ち、寿命を 0 にする', () => {
      setNodeEnv('production');
      expect(cookieLib().clearCookieOptions()).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
    });

    test('DATA-AUTH-004 端末の印は 16 バイトの乱数の 16 進で、毎回変わる', () => {
      const first = cookieLib().generateSessionId();
      const second = cookieLib().generateSessionId();

      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(second).toMatch(/^[0-9a-f]{32}$/);
      expect(first).not.toBe(second);
    });
  });

  describe('窓口が実際に出す Cookie', () => {

    test('DATA-AUTH-004 ログアウトは認証の Cookie 全部とゲストのカート・お気に入り、ライブラリの sb-…-auth-token を寿命 0 で消す', async () => {
      cookies.mockResolvedValue({
        get: jest.fn().mockReturnValue(undefined),
        getAll: jest.fn().mockReturnValue([
          { name: 'sb-abcdefgh-auth-token', value: 'x' },
          { name: 'sb-abcdefgh-auth-token.0', value: 'y' },
          { name: 'sb-abcdefgh-auth-token-code-verifier', value: 'z' },
          { name: 'unrelated-cookie', value: 'w' },
        ]),
      });
      const { POST } = require('@/app/api/auth/logout/route') as { POST: () => Promise<any> };

      const res = await POST();

      expect(res.status).toBe(200);
      const cleared = [
        'session_id',
        'sb-refresh-token',
        'sb-access-token',
        'sb-csrf-token',
        'sb-login-2fa-session',
        'sb-password-reset-session',
        'cart',
        'wishlist',
        'sb-abcdefgh-auth-token',
        'sb-abcdefgh-auth-token.0',
      ];
      for (const name of cleared) {
        expect(res.cookies.get(name)).toEqual(expect.objectContaining({ value: '', maxAge: 0, httpOnly: true }));
      }
      expect(res.cookies.get('unrelated-cookie')).toBeUndefined();
      expect(res.cookies.get('sb-abcdefgh-auth-token-code-verifier')).toBeUndefined();
    });
  });
});
