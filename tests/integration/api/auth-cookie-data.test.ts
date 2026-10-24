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

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

type Handler = (request: Request) => Promise<any>;

const crypto = require('crypto') as typeof import('crypto');
const { cookies } = require('next/headers');
const { createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');

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

const twoFactor = () => require('@/features/auth/services/login-2fa-session') as typeof import('@/features/auth/services/login-2fa-session');
const resetSession = () => require('@/features/auth/services/password-reset-session') as typeof import('@/features/auth/services/password-reset-session');
const cookieLib = () => require('@/lib/cookie') as typeof import('@/lib/cookie');

/** 署名つきの印を、署名だけ正しい任意の中身で作る。 */
const signPayload = (payload: Record<string, unknown>) => {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', 'test-jwt-secret').update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

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
    test('DATA-AUTH-004 ログインの 1 段目は、保留の署名した印を SameSite=Strict・5 分で出し、中身に用途と宛先を持つ', async () => {
      createPublicClient.mockResolvedValue({
        auth: {
          signInWithPassword: jest.fn().mockResolvedValue({
            data: { session: { access_token: 'a', refresh_token: 'r' }, user: { id: 'u1', email: 'user@example.com' } },
            error: null,
          }),
          signInWithOtp: jest.fn().mockResolvedValue({ error: null }),
        },
      });
      const { POST } = require('@/app/api/auth/login/route') as { POST: Handler };

      const res = await POST(postJson('/api/auth/login', { email: 'user@example.com', password: 'password123456789' }));

      const pending = res.cookies.get('sb-login-2fa-session');
      expect(pending).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/', maxAge: 5 * MINUTE }));
      const claims = twoFactor().verifyLoginTwoFactorSessionToken(pending.value);
      expect(claims).toEqual(expect.objectContaining({ purpose: 'login_2fa', userId: 'u1', email: 'user@example.com' }));
      expect(claims!.exp - claims!.iat).toBe(5 * MINUTE);
    });

    test('DATA-AUTH-004 確認コードの検証に成功すると、access・refresh・CSRF は 7 日、端末の印は 30 日で出し、保留の印は捨てる', async () => {
      setNodeEnv('production');
      const session = { access_token: 'access-1', refresh_token: 'refresh-1', expires_at: Date.now() + 3600 };
      createPublicClient.mockResolvedValue({
        auth: { verifyOtp: jest.fn().mockResolvedValue({ data: { session, user: { id: 'u1', email: 'user@example.com' } }, error: null }) },
      });
      createServiceRoleClient.mockResolvedValue({ from: jest.fn(() => ({ insert: jest.fn().mockResolvedValue({ error: null }) })) });
      const pendingToken = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });
      const { POST } = require('@/app/api/auth/otp/verify/route') as { POST: Handler };

      const res = await POST(postJson('/api/auth/otp/verify', { code: '12345678' }, cookieHeaderFor('sb-login-2fa-session', pendingToken)));

      expect(res.status).toBe(200);
      expect(res.cookies.get('sb-access-token')).toEqual(expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * DAY }));
      expect(res.cookies.get('sb-refresh-token')).toEqual(expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 7 * DAY }));
      expect(res.cookies.get('sb-csrf-token')).toEqual(expect.objectContaining({ httpOnly: false, secure: true, sameSite: 'lax', maxAge: 7 * DAY }));
      const device = res.cookies.get('session_id');
      expect(device).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: 30 * DAY }));
      expect(device.value).toMatch(/^[0-9a-f]{32}$/);
      // 使い終わった保留の印は、同じ名前で寿命 0 にして消す。
      expect(res.cookies.get('sb-login-2fa-session')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
    });

    test('DATA-AUTH-004 認証コードの再送は保留の印を出し直すが、最初の iat を引き継ぐ', async () => {
      const firstIssuedAt = Math.floor(Date.now() / 1000) - 10 * MINUTE;
      const pendingToken = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com', issuedAt: firstIssuedAt });
      createPublicClient.mockResolvedValue({ auth: { signInWithOtp: jest.fn().mockResolvedValue({ error: null }) } });
      const { POST } = require('@/app/api/auth/login/resend/route') as { POST: Handler };

      const res = await POST(postJson('/api/auth/login/resend', {}, cookieHeaderFor('sb-login-2fa-session', pendingToken)));

      expect(res.status).toBe(200);
      const reissued = res.cookies.get('sb-login-2fa-session');
      expect(reissued).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'strict', maxAge: 5 * MINUTE }));
      const claims = twoFactor().verifyLoginTwoFactorSessionToken(reissued.value);
      expect(claims!.iat).toBe(firstIssuedAt);
      expect(claims!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

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
    test('DATA-AUTH-004 保留の印は、中身を 1 文字でも書き換えると署名が合わず読めない', () => {
      const token = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });
      const [payload, signature] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), email: 'victim@example.com' }), 'utf8').toString('base64url');

      expect(twoFactor().verifyLoginTwoFactorSessionToken(token)).not.toBeNull();
      expect(twoFactor().verifyLoginTwoFactorSessionToken(`${forged}.${signature}`)).toBeNull();
      expect(twoFactor().verifyLoginTwoFactorSessionToken(`${payload}.`)).toBeNull();
      expect(twoFactor().verifyLoginTwoFactorSessionToken('')).toBeNull();
      expect(twoFactor().verifyLoginTwoFactorSessionToken(undefined)).toBeNull();
    });

    test('DATA-AUTH-004 再設定の印は、中身を書き換えると署名が合わず読めない', () => {
      const token = resetSession().createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });
      const [payload, signature] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), userId: 'victim' }), 'utf8').toString('base64url');

      expect(resetSession().verifyPasswordResetSessionToken(token)).not.toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken(`${forged}.${signature}`)).toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken(null)).toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken('no-dot')).toBeNull();
    });

    test('DATA-AUTH-004 用途が違う印は、同じ鍵で署名されていても断る', () => {
      const pending = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });
      const reset = resetSession().createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });

      expect(resetSession().verifyPasswordResetSessionToken(pending)).toBeNull();
      expect(twoFactor().verifyLoginTwoFactorSessionToken(reset)).toBeNull();
      expect(twoFactor().readLoginTwoFactorSessionFromCookieHeader(`sb-login-2fa-session=${encodeURIComponent(reset)}`)).toBeNull();
      expect(resetSession().readPasswordResetSessionFromCookieHeader(`sb-password-reset-session=${encodeURIComponent(pending)}`)).toBeNull();
    });

    test('DATA-AUTH-004 必要な項目が欠けた印は、署名が正しくても断る（iat の無い旧い形を含む）', () => {
      const now = Math.floor(Date.now() / 1000);
      const legacy = signPayload({ purpose: 'login_2fa', userId: 'u1', email: 'user@example.com', exp: now + 300 });
      const noUser = signPayload({ purpose: 'login_2fa', email: 'user@example.com', iat: now, exp: now + 300 });
      const resetNoTokenId = signPayload({ purpose: 'password_reset', userId: 'u1', email: 'user@example.com', exp: now + 300 });

      expect(twoFactor().verifyLoginTwoFactorSessionToken(legacy)).toBeNull();
      expect(twoFactor().verifyLoginTwoFactorSessionToken(noUser)).toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken(resetNoTokenId)).toBeNull();
    });

    test('DATA-AUTH-004 署名は合っていても JSON として読めない中身は断る', () => {
      const encoded = Buffer.from('not-json', 'utf8').toString('base64url');
      const signature = crypto.createHmac('sha256', 'test-jwt-secret').update(encoded).digest('base64url');

      expect(twoFactor().verifyLoginTwoFactorSessionToken(`${encoded}.${signature}`)).toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken(`${encoded}.${signature}`)).toBeNull();
    });

    test('DATA-AUTH-004 保留の印は 5 分で切れ、再設定の印は 10 分で切れる', () => {
      const issuedAt = Date.now();
      const pending = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });
      const reset = resetSession().createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });
      const nowSpy = jest.spyOn(Date, 'now');

      nowSpy.mockReturnValue(issuedAt + 5 * MINUTE * 1000 - 5000);
      expect(twoFactor().verifyLoginTwoFactorSessionToken(pending)).not.toBeNull();
      nowSpy.mockReturnValue(issuedAt + 5 * MINUTE * 1000 + 1000);
      expect(twoFactor().verifyLoginTwoFactorSessionToken(pending)).toBeNull();

      nowSpy.mockReturnValue(issuedAt + 10 * MINUTE * 1000 - 5000);
      expect(resetSession().verifyPasswordResetSessionToken(reset)).not.toBeNull();
      nowSpy.mockReturnValue(issuedAt + 10 * MINUTE * 1000 + 1000);
      expect(resetSession().verifyPasswordResetSessionToken(reset)).toBeNull();
    });

    test('DATA-AUTH-004 保留の印は再送で exp が延びても、最初の iat から 30 分で切れる', () => {
      const start = Date.now();
      const nowSpy = jest.spyOn(Date, 'now');
      const firstIat = Math.floor(start / 1000);

      // 29 分後に再送して出し直した印（exp は延びるが iat は最初のまま）。
      nowSpy.mockReturnValue(start + 29 * MINUTE * 1000);
      const reissued = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com', issuedAt: firstIat });

      nowSpy.mockReturnValue(start + 30 * MINUTE * 1000);
      expect(twoFactor().verifyLoginTwoFactorSessionToken(reissued)).not.toBeNull();
      nowSpy.mockReturnValue(start + 30 * MINUTE * 1000 + 2000);
      expect(twoFactor().verifyLoginTwoFactorSessionToken(reissued)).toBeNull();
      expect(twoFactor().loginTwoFactorSessionAbsoluteMaxAgeSeconds).toBe(30 * MINUTE);
    });

    test('DATA-AUTH-004 専用の鍵があればそれで署名し、無ければ JWT_SECRET を使う', () => {
      process.env.LOGIN_2FA_SESSION_SECRET = 'dedicated-2fa-secret';
      process.env.PASSWORD_RESET_SESSION_SECRET = 'dedicated-reset-secret';
      const pending = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });
      const reset = resetSession().createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });

      expect(twoFactor().verifyLoginTwoFactorSessionToken(pending)).not.toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken(reset)).not.toBeNull();

      // 専用の鍵を外すと JWT_SECRET に戻り、専用の鍵で署名した印は読めなくなる。
      delete process.env.LOGIN_2FA_SESSION_SECRET;
      delete process.env.PASSWORD_RESET_SESSION_SECRET;
      expect(twoFactor().verifyLoginTwoFactorSessionToken(pending)).toBeNull();
      expect(resetSession().verifyPasswordResetSessionToken(reset)).toBeNull();

      const fallbackSigned = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });
      expect(twoFactor().verifyLoginTwoFactorSessionToken(fallbackSigned)).not.toBeNull();
    });

    test('DATA-AUTH-004 署名の鍵がどこにも無ければ、印を作れず例外にする', () => {
      delete process.env.JWT_SECRET;

      expect(() => twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' })).toThrow('Login 2FA session secret is not configured');
      expect(() => resetSession().createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' })).toThrow('Password reset session secret is not configured');
    });

    test('DATA-AUTH-004 Cookie の見出しから印を取る時は、名前が違う Cookie と URL エンコードを正しく扱う', () => {
      const pending = twoFactor().createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });

      expect(twoFactor().readLoginTwoFactorSessionFromCookieHeader(null)).toBeNull();
      expect(twoFactor().readLoginTwoFactorSessionFromCookieHeader('other=1; session_id=abc')).toBeNull();
      expect(twoFactor().readLoginTwoFactorSessionFromCookieHeader(`other=1; sb-login-2fa-session=${encodeURIComponent(pending)}; x=2`)).toEqual(
        expect.objectContaining({ userId: 'u1' }),
      );
      expect(resetSession().readPasswordResetSessionFromCookieHeader(undefined)).toBeNull();
    });
  });
});
