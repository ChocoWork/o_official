/**
 * Login API Integration Tests
 * タスク: [AUTH-01-06]
 * 対応 REQ: REQ-AUTH-002 / FREQ-58（メール + パスワード + メールOTP の2要素認証 step1）
 *
 * 新フロー: /api/auth/login はパスワードを検証し、成功したらメール OTP を送信して
 * 「パスワード検証済み」の署名 Cookie を発行する（セッションはまだ発行しない）。
 */

// Mock rate limit middleware
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

// Mock Supabase client (public client: password check + OTP send)
jest.mock('@/lib/supabase/server', () => {
  const mockSignInWithPassword = jest.fn();
  const mockSignInWithOtp = jest.fn();

  const createMockPublicClient = jest.fn(async () => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signInWithOtp: mockSignInWithOtp,
    },
  }));

  return {
    createPublicClient: createMockPublicClient,
    __mockSignInWithPassword: mockSignInWithPassword,
    __mockSignInWithOtp: mockSignInWithOtp,
  };
});

// Mock audit log
jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// Mock the signed pending-2FA token service
jest.mock('@/features/auth/services/login-2fa-session', () => ({
  createLoginTwoFactorSessionToken: jest.fn(() => 'mock-pending-token'),
  loginTwoFactorSessionMaxAgeSeconds: 600,
}));

// Mock cookie utilities used by the login route
jest.mock('@/lib/cookie', () => ({
  loginTwoFactorSessionCookieName: 'sb-login-2fa-session',
  cookieOptionsForLoginTwoFactor: jest.fn(() => ({
    httpOnly: true,
    secure: true,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 600,
  })),
}));

// Mock NextResponse
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => {
      const res: any = {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map(),
        cookies: {
          _cookies: [] as any[],
          set(c: any) {
            this._cookies.push(c);
          },
          get(name: string) {
            return this._cookies.find((item: any) => item.name === name);
          },
        },
      };
      return res;
    },
  },
}));

const { __mockSignInWithPassword, __mockSignInWithOtp } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
let loginHandler: any;

const validSession = {
  access_token: 'mock-access-token',
  refresh_token: 'mock-refresh-token',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
};

describe('POST /api/auth/login - Integration Tests', () => {
  beforeAll(async () => {
    loginHandler = (await import('@/app/api/auth/login/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    __mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
  });

  describe('正常系', () => {
    test('[SUCCESS] 正しいメール・パスワードで 200 + OTP 送信 + pending Cookie', async () => {
      const mockUser = { id: 'user-123', email: 'test@example.com' };
      __mockSignInWithPassword.mockResolvedValue({
        data: { session: validSession, user: mockUser },
        error: null,
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'ValidPassword123!' }),
      });

      const res: any = await loginHandler(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.step).toBe('otp');

      // OTP は shouldCreateUser: false で送信される（未登録ユーザーは作成しない）
      expect(__mockSignInWithOtp).toHaveBeenCalledWith({
        email: 'test@example.com',
        options: { shouldCreateUser: false },
      });

      // 「パスワード検証済み」Cookie が設定され、セッション Cookie は設定されない
      const pendingCookie = res.cookies.get('sb-login-2fa-session');
      expect(pendingCookie).toBeDefined();
      expect(pendingCookie.value).toBe('mock-pending-token');
      expect(res.cookies.get('sb-access-token')).toBeUndefined();
      expect(res.cookies.get('sb-refresh-token')).toBeUndefined();

      // レスポンス本体にトークンを含めない
      expect(body.access_token).toBeUndefined();

      expect(logAudit).toHaveBeenCalledWith({
        action: 'login',
        actor_email: 'test@example.com',
        outcome: 'password_verified',
        detail: 'otp_sent',
        resource_id: 'user-123',
      });
    });
  });

  describe('異常系', () => {
    test('[ERROR] 誤ったパスワードで 401（OTP は送信しない）', async () => {
      __mockSignInWithPassword.mockResolvedValue({
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'WrongPassword' }),
      });

      const res: any = await loginHandler(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error).toBe('メールアドレスまたはパスワードが正しくありません。');
      expect(__mockSignInWithOtp).not.toHaveBeenCalled();

      expect(logAudit).toHaveBeenCalledWith({
        action: 'login',
        actor_email: 'test@example.com',
        outcome: 'failure',
        detail: 'Invalid login credentials',
      });
    });

    test('[ERROR] 存在しないメールで 401', async () => {
      __mockSignInWithPassword.mockResolvedValue({
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@example.com', password: 'SomePassword123!' }),
      });

      const res: any = await loginHandler(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error).toBe('メールアドレスまたはパスワードが正しくありません。');
    });

    test('[VALIDATION] 不正なメールフォーマットで 400', async () => {
      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'invalid-email', password: 'Password123!' }),
      });

      const res: any = await loginHandler(req);
      expect(res.status).toBe(400);
    });

    test('[VALIDATION] パスワードが短すぎる場合 400', async () => {
      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'short' }),
      });

      const res: any = await loginHandler(req);
      expect(res.status).toBe(400);
    });

    test('[ERROR] セッションなしで 401', async () => {
      __mockSignInWithPassword.mockResolvedValue({
        data: { session: null, user: { id: 'user-789', email: 'test@example.com' } },
        error: null,
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'Password123!' }),
      });

      const res: any = await loginHandler(req);
      expect(res.status).toBe(401);
    });

    test('[ERROR] OTP 送信失敗で 500', async () => {
      __mockSignInWithPassword.mockResolvedValue({
        data: { session: validSession, user: { id: 'user-123', email: 'test@example.com' } },
        error: null,
      });
      __mockSignInWithOtp.mockResolvedValue({ data: {}, error: { message: 'mailer error' } });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'Password123!' }),
      });

      const res: any = await loginHandler(req);
      expect(res.status).toBe(500);
      expect(res.cookies.get('sb-login-2fa-session')).toBeUndefined();
    });
  });

  describe('セキュリティ', () => {
    test('[SECURITY] レート制限チェックが実行されている', async () => {
      const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

      __mockSignInWithPassword.mockResolvedValue({
        data: { session: validSession, user: { id: 'user-id', email: 'test@example.com' } },
        error: null,
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'Password123!' }),
      });

      await loginHandler(req);

      expect(enforceRateLimit).toHaveBeenCalledWith({
        request: req,
        endpoint: 'auth:login',
        limit: 50,
        windowSeconds: 600,
      });

      expect(enforceRateLimit).toHaveBeenCalledWith({
        request: req,
        endpoint: 'auth:login',
        limit: 5,
        windowSeconds: 600,
        subject: 'test@example.com',
      });
    });
  });
});

export {};
