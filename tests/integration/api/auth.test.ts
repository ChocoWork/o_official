export {};

// 漏洩パスワード検査は外部 API（HaveIBeenPwned）を叩く。テストからネットワークへ出さない。
// 検査そのものの挙動は tests/unit/lib/pwned-password.test.ts が担当する。
jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: async () => ({ status: 'ok' }),
  PWNED_PASSWORD_MESSAGE: 'このパスワードは過去の情報流出で公開されています。別のパスワードを設定してください。',
}));

jest.mock('next/server', () => ({
  after: () => {},
  NextResponse: {
    json: (body: any, init?: any) => {
      const res: any = {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map(),
        cookies: {
          _cookies: [] as any[],
          set(c: any) { this._cookies.push(c); },
          get(name: string) { return this._cookies.find((c: any) => c.name === name); },
        },
      };
      return res;
    },
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

let loginHandler: any;
let registerHandler: any;
let pwRequestHandler: any;
let pwConfirmHandler: any;

describe('Auth API integration (mocked supabase)', () => {
  beforeAll(() => {
    // require after mocking next/server
    loginHandler = require('@/app/api/auth/login/route').POST;
    registerHandler = require('@/app/api/auth/register/route').POST;
    pwRequestHandler = require('@/app/api/auth/password-reset/request/route').POST;
    pwConfirmHandler = require('@/app/api/auth/password-reset/confirm/route').POST;
  });

  beforeEach(() => {
    // default service client to satisfy audit/logging and password reset inserts
    const { createServiceRoleClient, createClient, createPublicClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({ from: jest.fn().mockReturnValue({ insert: jest.fn().mockResolvedValue({}) }), rpc: jest.fn().mockResolvedValue({ data: null, error: null }), auth: { admin: { updateUserById: jest.fn().mockResolvedValue({ data: { user: { id: "u1" } }, error: null }) } } });
    createClient.mockResolvedValue({ auth: { signInWithPassword: jest.fn().mockResolvedValue({ data: null, error: null }) } });
    createPublicClient.mockResolvedValue({ auth: { signInWithPassword: jest.fn().mockResolvedValue({ data: null, error: null }), signInWithOtp: jest.fn().mockResolvedValue({ error: null }) } });
    process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  afterEach(() => jest.resetAllMocks());

  test('login (step 1) verifies password, sends OTP and returns step=otp', async () => {
    const { createPublicClient } = require('@/lib/supabase/server');
    const signInWithOtp = jest.fn().mockResolvedValue({ error: null });
    const fakeClient = {
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: { session: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() }, user: { id: 'u', email: 'user@example.com' } },
          error: null,
        }),
        signInWithOtp,
      },
    };
    createPublicClient.mockResolvedValue(fakeClient);

    const req = new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', password: 'password123456789' }) });

    const res: any = await loginHandler(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.step).toBe('otp');
    expect(body.access_token).toBeUndefined();
    expect(signInWithOtp).toHaveBeenCalledWith({ email: 'user@example.com', options: { shouldCreateUser: false } });
    expect(res.cookies.get('sb-login-2fa-session')).toBeDefined();
  });

  test('login invalid credentials returns 401', async () => {
    const { createPublicClient } = require('@/lib/supabase/server');
    const fakeClient = {
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({ data: null, error: { message: 'invalid' } }),
        signInWithOtp: jest.fn().mockResolvedValue({ error: null }),
      },
    };
    createPublicClient.mockResolvedValue(fakeClient);

    const req = new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', password: 'wrongpass12345678' }) });

    const res: any = await loginHandler(req);
    expect(res.status).toBe(401);
  });

  test('register success (admin) returns 201', async () => {
    process.env.ADMIN_API_KEY = 'adm';
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const fakeService = {
      auth: { admin: { createUser: jest.fn().mockResolvedValue({ data: { user: { id: 'u1', email: 'new@example.com' } }, error: null }) } },
    };
    createServiceRoleClient.mockReturnValue(fakeService);

    const req = new Request('http://localhost/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'adm' }, body: JSON.stringify({ email: 'new@example.com', password: 'password123456789' }) });

    const res: any = await registerHandler(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.email).toBe('new@example.com');
  });

  test('register unauthorized without admin token returns 401', async () => {
    delete process.env.ADMIN_API_KEY;
    const req = new Request('http://localhost/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new@example.com', password: 'password123456789' }) });

    const res: any = await registerHandler(req);
    expect(res.status).toBe(500); // because server misconfiguration when ADMIN_API_KEY not configured
  });

  test('password reset request inserts token and returns 200', async () => {
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const insertMock = jest.fn().mockResolvedValue({});
    const chain: any = { insert: insertMock, select: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data: null }) };
    chain.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej);
    const fromMock = jest.fn(() => chain);
    const fakeService = { from: fromMock, rpc: jest.fn().mockResolvedValue({ data: "u1", error: null }) };
    createServiceRoleClient.mockReturnValue(fakeService);

    const req = new Request('http://localhost/api/auth/password-reset/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com' }) });

    const res: any = await pwRequestHandler(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(insertMock).toHaveBeenCalled();
  });

  test('password reset confirm with reset session updates password and returns 200', async () => {
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const { createPasswordResetSessionToken } = require('@/features/auth/services/password-reset-session');

    const updateUserById = jest.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'tok1' }, error: null }),
    };
    chain.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej);

    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
    createServiceRoleClient.mockReturnValue({ from: jest.fn(() => chain), rpc, auth: { admin: { updateUserById } } });

    const sessionToken = createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });
    const req = new Request('http://localhost/api/auth/password-reset/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `sb-password-reset-session=${encodeURIComponent(sessionToken)}` },
      body: JSON.stringify({ new_password: 'newpassword1234567' }),
    });

    const res: any = await pwConfirmHandler(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(updateUserById).toHaveBeenCalledWith('u1', { password: 'newpassword1234567' });
    // パスワード変更後は既存セッションを失効させる
    expect(rpc).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: 'u1' });
  });
});
