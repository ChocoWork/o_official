export {};
// GoTrue の access token の形（DD-AUTH-039）。AUTH_REQUIRE_APP_SESSION が既定で有効なので、ログインの保存には session_id が要る。
const SECRET_ACCESS = `secret-access.${Buffer.from(JSON.stringify({ session_id: '4c36ef0b-0332-42d8-b210-3326fc20c240' })).toString('base64url')}.s`;
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

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: jest.fn(),
}));

jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: async () => ({ status: 'ok' }),
  PWNED_PASSWORD_MESSAGE: 'pwned',
}));

type Handler = (request: Request) => Promise<any>;

const { createClient, createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { authenticateRequest } = require('@/lib/auth/authenticate');

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('認証の全体の作り（ARC-AUTH-001）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  test('ARC-AUTH-001 ログインの窓口はパスワードの確かめに匿名の client だけを使い、Cookie に触れる client は作らない', async () => {
    const signInWithPassword = jest.fn().mockResolvedValue({
      data: { session: { access_token: 'a', refresh_token: 'r' }, user: { id: 'u1', email: 'user@example.com' } },
      error: null,
    });
    const signInWithOtp = jest.fn().mockResolvedValue({ error: null });
    createPublicClient.mockResolvedValue({ auth: { signInWithPassword, signInWithOtp } });

    const { POST } = require('@/app/api/auth/login/route') as { POST: Handler };
    const res = await POST(postJson('/api/auth/login', { email: 'user@example.com', password: 'password123456789' }));

    expect(res.status).toBe(200);
    expect(createPublicClient).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'user@example.com', password: 'password123456789' });
  });

  test('ARC-AUTH-001 パスワードの段を通っても本文にトークンを返さず、セッションの Cookie も出さない', async () => {
    createPublicClient.mockResolvedValue({
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: { session: { access_token: SECRET_ACCESS, refresh_token: 'secret-refresh' }, user: { id: 'u1', email: 'user@example.com' } },
          error: null,
        }),
        signInWithOtp: jest.fn().mockResolvedValue({ error: null }),
      },
    });

    const { POST } = require('@/app/api/auth/login/route') as { POST: Handler };
    const res = await POST(postJson('/api/auth/login', { email: 'user@example.com', password: 'password123456789' }));
    const serialized = JSON.stringify(await res.json());

    expect(serialized).not.toContain('secret-access');
    expect(serialized).not.toContain('secret-refresh');
    expect(res.cookies.get('sb-access-token')).toBeUndefined();
    expect(res.cookies.get('sb-refresh-token')).toBeUndefined();
    expect(res.cookies.get('session_id')).toBeUndefined();
  });

  test('ARC-AUTH-001 確認コードの検証に成功すると、トークンは HttpOnly の Cookie に入り、本文には出ない', async () => {
    const session = { access_token: SECRET_ACCESS, refresh_token: 'secret-refresh', expires_at: Date.now() + 3600 };
    const user = { id: 'u1', email: 'user@example.com' };
    createPublicClient.mockResolvedValue({
      auth: { verifyOtp: jest.fn().mockResolvedValue({ data: { session, user }, error: null }) },
    });
    const insert = jest.fn().mockResolvedValue({ error: null });
    createServiceRoleClient.mockResolvedValue({ from: jest.fn(() => ({ insert })) });

    const { createLoginTwoFactorSessionToken } = require('@/features/auth/services/login-2fa-session');
    const pending = createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });

    const { POST } = require('@/app/api/auth/otp/verify/route') as { POST: Handler };
    const res = await POST(
      postJson('/api/auth/otp/verify', { code: '12345678' }, { cookie: `sb-login-2fa-session=${encodeURIComponent(pending)}` }),
    );

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain('secret-access');
    expect(serialized).not.toContain('secret-refresh');

    expect(res.cookies.get('sb-access-token')).toEqual(expect.objectContaining({ value: SECRET_ACCESS, httpOnly: true }));
    expect(res.cookies.get('sb-refresh-token')).toEqual(expect.objectContaining({ value: 'secret-refresh', httpOnly: true }));
    expect(res.cookies.get('sb-csrf-token')).toEqual(expect.objectContaining({ httpOnly: false }));
    // sessions の表には refresh token そのものでなくハッシュだけを控える。
    const stored = insert.mock.calls[0][0][0];
    expect(stored.refresh_token_hash).toEqual(expect.any(String));
    expect(stored.refresh_token_hash).not.toBe('secret-refresh');
    expect(JSON.stringify(stored)).not.toContain('secret-refresh');
  });

  test('ARC-AUTH-001 確認コードの検証が失敗したら、トークンの Cookie を出さず 401 を返す', async () => {
    createPublicClient.mockResolvedValue({
      auth: { verifyOtp: jest.fn().mockResolvedValue({ data: { session: null, user: null }, error: { message: 'expired' } }) },
    });
    const { createLoginTwoFactorSessionToken } = require('@/features/auth/services/login-2fa-session');
    const pending = createLoginTwoFactorSessionToken({ userId: 'u1', email: 'user@example.com' });

    const { POST } = require('@/app/api/auth/otp/verify/route') as { POST: Handler };
    const res = await POST(
      postJson('/api/auth/otp/verify', { code: '12345678' }, { cookie: `sb-login-2fa-session=${encodeURIComponent(pending)}` }),
    );

    expect(res.status).toBe(401);
    expect(res.cookies.get('sb-access-token')).toBeUndefined();
    expect(res.cookies.get('sb-refresh-token')).toBeUndefined();
  });

  describe('入力の形は全部の窓口で zod が確かめる', () => {
    const makeResetCookie = () => {
      const { createPasswordResetSessionToken } = require('@/features/auth/services/password-reset-session');
      const token = createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });
      return `sb-password-reset-session=${encodeURIComponent(token)}`;
    };

    const cases: Array<{ name: string; load: () => Handler; path: string; body: unknown; headers?: () => Record<string, string> }> = [
      {
        name: 'login',
        load: () => require('@/app/api/auth/login/route').POST,
        path: '/api/auth/login',
        body: { email: 'not-an-email', password: 'short' },
      },
      {
        name: 'register',
        load: () => require('@/app/api/auth/register/route').POST,
        path: '/api/auth/register',
        body: { email: 'not-an-email', password: 'short' },
      },
      {
        name: 'otp/verify',
        load: () => require('@/app/api/auth/otp/verify/route').POST,
        path: '/api/auth/otp/verify',
        body: { code: '123' },
      },
      {
        name: 'password-reset/request',
        load: () => require('@/app/api/auth/password-reset/request/route').POST,
        path: '/api/auth/password-reset/request',
        body: { email: 'not-an-email' },
      },
      {
        name: 'password-reset/confirm',
        load: () => require('@/app/api/auth/password-reset/confirm/route').POST,
        path: '/api/auth/password-reset/confirm',
        body: { new_password: 'short' },
        headers: () => ({ cookie: makeResetCookie() }),
      },
    ];

    test.each(cases)('ARC-AUTH-001 $name は形の合わない本文を 400 の validation_error で断り、Supabase を呼ばない', async ({ load, path, body, headers }) => {
      const res = await load()(postJson(path, body, headers?.()));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe('validation_error');
      expect(Array.isArray(json.detail)).toBe(true);
      expect(createPublicClient).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe('役割は JWT の app_metadata から読み、無ければ user にする', () => {
    const callMe = async () => {
      const { GET } = require('@/app/api/auth/me/route');
      return (await GET(new Request('http://localhost/api/auth/me'))) as any;
    };

    test.each([['admin'], ['supporter'], ['user']])('ARC-AUTH-001 app_metadata.role が %s ならそのまま返す', async (role) => {
      authenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'u1', email: 'u@example.com', aal: 'aal1', app_metadata: { role } } });
      const body = await (await callMe()).json();
      expect(body.authenticated).toBe(true);
      expect(body.user.role).toBe(role);
    });

    test.each([
      ['役割が無い', {}],
      ['役割が知らない値', { role: 'owner' }],
      ['app_metadata 自体が無い', undefined],
    ])('ARC-AUTH-001 %s時は user にする', async (_label, appMetadata) => {
      authenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'u1', email: 'u@example.com', aal: 'aal1', app_metadata: appMetadata } });
      const body = await (await callMe()).json();
      expect(body.user.role).toBe('user');
      expect(body.user.mfaVerified).toBe(false);
    });

    test('ARC-AUTH-001 認証に通らない要求には authenticated:false を返し、役割を渡さない', async () => {
      authenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
      const res = await callMe();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ authenticated: false });
    });
  });
});
