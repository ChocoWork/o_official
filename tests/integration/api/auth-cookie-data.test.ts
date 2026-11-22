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

type Handler = (request: Request) => Promise<any>;

const { cookies } = require('next/headers');
const { createServiceRoleClient } = require('@/lib/supabase/server');

const MINUTE = 60;
const DAY = 24 * 60 * 60;

const setNodeEnv = (value: string | undefined) => {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
};

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const cookieHeaderFor = (name: string, value: string) => ({ cookie: `${name}=${encodeURIComponent(value)}` });

const resetSession = () => require('@/features/auth/services/password-reset-session') as typeof import('@/features/auth/services/password-reset-session');
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

    test('DATA-AUTH-004 再設定のリンクを確かめると、利用者・宛先・印の行を署名した印を SameSite=Strict・10 分で出す', async () => {
      const chain: any = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        gte: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'tok1', user_id: 'u1', email: 'user@example.com' }, error: null }),
      };
      createServiceRoleClient.mockResolvedValue({ from: jest.fn(() => chain) });
      const { POST } = require('@/app/api/auth/password-reset/link/route') as { POST: Handler };

      const res = await POST(postJson('/api/auth/password-reset/link', { token: 'raw-reset-token' }));

      expect(res.status).toBe(200);
      const issued = res.cookies.get('sb-password-reset-session');
      expect(issued).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/', maxAge: 10 * MINUTE }));
      expect(resetSession().verifyPasswordResetSessionToken(issued.value)).toEqual(
        expect.objectContaining({ purpose: 'password_reset', userId: 'u1', email: 'user@example.com', tokenId: 'tok1' }),
      );
    });

    test('DATA-AUTH-004 再設定の印が無い・壊れている時の session 窓口は、同じ名前を SameSite=Strict で消す', async () => {
      const { GET } = require('@/app/api/auth/password-reset/session/route') as { GET: Handler };

      const res = await GET(new Request('http://localhost/api/auth/password-reset/session', { headers: cookieHeaderFor('sb-password-reset-session', 'broken.value') }));

      expect(await res.json()).toEqual({ ready: false, email: null });
      expect(res.cookies.get('sb-password-reset-session')).toEqual(expect.objectContaining({ value: '', sameSite: 'strict', maxAge: 0 }));
    });

    test('DATA-AUTH-004 生きた再設定の印がある時の session 窓口は、準備ができたと答え、印を消さない', async () => {
      const token = resetSession().createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });
      const { GET } = require('@/app/api/auth/password-reset/session/route') as { GET: Handler };

      const res = await GET(new Request('http://localhost/api/auth/password-reset/session', { headers: cookieHeaderFor('sb-password-reset-session', token) }));

      expect(await res.json()).toEqual({ ready: true, email: 'user@example.com' });
      expect(res.cookies.get('sb-password-reset-session')).toBeUndefined();
    });

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

  describe('署名した印の決まり', () => {

    test('DATA-AUTH-004 再設定の印は、中身を書き換えると署名が合わず読めない', () => {
      const token = resetSession().createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });
      const [payload, signature] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), userId: 'victim' }), 'utf8').toString('base64url');

      expect(resetSession().verifyPasswordResetSessionToken(token)).not.toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken(`${forged}.${signature}`)).toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken(null)).toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken('no-dot')).toBeNull();
    });

  });
});
