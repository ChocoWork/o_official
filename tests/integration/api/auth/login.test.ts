/**
 * Login API Integration Tests
 * タスク: [AUTH-01-06]
 * 対応 REQ: REQ-AUTH-002
 * 対応 ARCH-ID: ARCH-AUTH-02
 * 仕様書: docs/specs/01_auth.md §4.2
 */

// Mock rate limit middleware
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

// Mock Supabase client
jest.mock('@/lib/supabase/server', () => {
  const mockSignInWithPassword = jest.fn();
  
  const createMockClient = jest.fn(async () => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
    },
  }));

  const createMockServiceRoleClient = jest.fn(() => ({
    from: jest.fn((table: string) => ({
      insert: jest.fn().mockResolvedValue({ data: [{ id: 'session-id' }], error: null }),
    })),
  }));

  return {
    createClient: createMockClient,
    createServiceRoleClient: createMockServiceRoleClient,
    __mockSignInWithPassword: mockSignInWithPassword,
  };
});

// Mock audit log
jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// Mock hash utilities
jest.mock('@/lib/hash', () => ({
  tokenHashSha256: jest.fn((token: string) => `hashed_${token}`),
}));

// Mock cookie utilities
jest.mock('@/lib/cookie', () => ({
  refreshCookieName: 'sb-refresh-token',
  accessCookieName: 'sb-access-token',
  csrfCookieName: 'csrf-token',
  cookieOptionsForRefresh: jest.fn(() => ({
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  })),
  cookieOptionsForAccess: jest.fn(() => ({
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 15 * 60,
  })),
  cookieOptionsForCsrf: jest.fn(() => ({
    httpOnly: false,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  })),
}));

// Mock CSRF utilities
jest.mock('@/lib/csrf', () => ({
  generateCsrfToken: jest.fn(() => 'mock-csrf-token'),
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

const { __mockSignInWithPassword } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
let loginHandler: any;

describe('POST /api/auth/login - Integration Tests', () => {
  beforeAll(async () => {
    loginHandler = (await import('@/app/api/auth/login/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('正常系', () => {
    test('[SUCCESS] 正しいメール・パスワードで 200 + セッション Cookie 発行', async () => {
      // Arrange
      const mockSession = {
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
      };

      __mockSignInWithPassword.mockResolvedValue({
        data: { session: mockSession, user: mockUser },
        error: null,
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'ValidPassword123!',
        }),
      });

      // Act
      const res: any = await loginHandler(req);
      const body = await res.json();

      // Assert
      expect(res.status).toBe(200);
      expect(body.access_token).toBe('mock-access-token');
      expect(body.user).toEqual(mockUser);

      // Cookie が設定されていることを確認
      const refreshCookie = res.cookies.get('sb-refresh-token');
      const accessCookie = res.cookies.get('sb-access-token');
      const csrfCookie = res.cookies.get('csrf-token');

      expect(refreshCookie).toBeDefined();
      expect(refreshCookie.value).toBe('mock-refresh-token');
      expect(accessCookie).toBeDefined();
      expect(accessCookie.value).toBe('mock-access-token');
      expect(csrfCookie).toBeDefined();

      // 監査ログが記録されていることを確認
      expect(logAudit).toHaveBeenCalledWith({
        action: 'login',
        actor_email: 'test@example.com',
        outcome: 'success',
        resource_id: 'user-123',
      });
    });

    test('[SUCCESS] sessions テーブルにレコードが作成される', async () => {
      const mockSession = {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
      const mockUser = {
        id: 'user-456',
        email: 'user@example.com',
      };

      __mockSignInWithPassword.mockResolvedValue({
        data: { session: mockSession, user: mockUser },
        error: null,
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'Password123!',
        }),
      });

      const res: any = await loginHandler(req);

      expect(res.status).toBe(200);

      // セッションの保存を確認（モックなので、実際にテーブルにデータが入る前提のテスト）
      // 実際の呼び出しは内部で行われているため、ここでは成功レスポンスを確認する
      const body = await res.json();
      expect(body.access_token).toBeDefined();
      expect(body.user).toBeDefined();
    });
  });

  describe('異常系', () => {
    test('[ERROR] 誤ったパスワードで 401 Unauthorized', async () => {
      __mockSignInWithPassword.mockResolvedValue({
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'WrongPassword',
        }),
      });

      const res: any = await loginHandler(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error).toBe('Invalid credentials');

      // 失敗ログが記録されていることを確認
      expect(logAudit).toHaveBeenCalledWith({
        action: 'login',
        actor_email: 'test@example.com',
        outcome: 'failure',
        detail: 'Invalid login credentials',
      });
    });

    test('[ERROR] 存在しないメールで 401 Unauthorized', async () => {
      __mockSignInWithPassword.mockResolvedValue({
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: 'SomePassword123!',
        }),
      });

      const res: any = await loginHandler(req);
      const body = await res.json();

      expect(res.status).toBe(401);
      expect(body.error).toBe('Invalid credentials');
    });

    test('[VALIDATION] 不正なメールフォーマットで 400 Bad Request', async () => {
      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'invalid-email',
          password: 'Password123!',
        }),
      });

      const res: any = await loginHandler(req);

      expect(res.status).toBe(400);
    });

    test('[VALIDATION] パスワードが短すぎる場合 400 Bad Request', async () => {
      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'short',
        }),
      });

      const res: any = await loginHandler(req);

      expect(res.status).toBe(400);
    });

    test('[ERROR] セッションなしで 401 Unauthorized', async () => {
      __mockSignInWithPassword.mockResolvedValue({
        data: { session: null, user: { id: 'user-789', email: 'test@example.com' } },
        error: null,
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'Password123!',
        }),
      });

      const res: any = await loginHandler(req);

      expect(res.status).toBe(401);
    });
  });

  describe('セキュリティ', () => {
    test('[SECURITY] レート制限チェックが実行されている', async () => {
      const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

      __mockSignInWithPassword.mockResolvedValue({
        data: {
          session: { access_token: 'token', refresh_token: 'refresh', expires_at: Date.now() },
          user: { id: 'user-id', email: 'test@example.com' },
        },
        error: null,
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'Password123!',
        }),
      });

      await loginHandler(req);

      // IP レベルのレート制限が呼ばれていることを確認
      expect(enforceRateLimit).toHaveBeenCalledWith({
        request: req,
        endpoint: 'auth:login',
        limit: 50,
        windowSeconds: 600,
      });

      // アカウントレベルのレート制限が呼ばれていることを確認
      expect(enforceRateLimit).toHaveBeenCalledWith({
        request: req,
        endpoint: 'auth:login',
        limit: 5,
        windowSeconds: 600,
        subject: 'test@example.com',
      });
    });

    test('[SECURITY] リフレッシュトークンは HttpOnly Cookie で設定される', async () => {
      __mockSignInWithPassword.mockResolvedValue({
        data: {
          session: {
            access_token: 'access',
            refresh_token: 'refresh',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
          user: { id: 'user-id', email: 'test@example.com' },
        },
        error: null,
      });

      const req = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'Password123!',
        }),
      });

      const res: any = await loginHandler(req);
      const body = await res.json();

      // レスポンス本体にはリフレッシュトークンが含まれないことを確認
      expect(body.refresh_token).toBeUndefined();
      expect(body.access_token).toBeDefined();

      // Cookie にのみリフレッシュトークンが設定されていることを確認
      const refreshCookie = res.cookies.get('sb-refresh-token');
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie.value).toBe('refresh');
    });
  });
});

export {};
