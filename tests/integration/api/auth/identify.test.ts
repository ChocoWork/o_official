/**
 * Identify API Integration Tests
 * タスク: [AUTH-01-IDF-15c]
 * 仕様書: docs/specs/01_auth.md
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const mockCreateUser = jest.fn();
const mockSignInWithOtp = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({
    auth: {
      admin: {
        createUser: mockCreateUser,
      },
    },
  })),
  createClient: jest.fn(async () => ({
    auth: {
      signInWithOtp: mockSignInWithOtp,
    },
  })),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      cookies: {
        set: jest.fn(),
      },
    }),
  },
}));

describe('POST /api/auth/identify', () => {
  let identifyHandler: (request: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;

  beforeAll(async () => {
    identifyHandler = (await import('@/app/api/auth/identify/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
  });

  test('未登録メールでもJIT作成後にOTP送信（shouldCreateUser=false）', async () => {
    const req = new Request('http://localhost/api/auth/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new-user@example.com' }),
    });

    const res = await identifyHandler(req);
    const body = (await res.json()) as { message?: string };

    expect(res.status).toBe(200);
    expect(body.message).toContain('認証コード');
    expect(mockCreateUser).toHaveBeenCalledWith({ email: 'new-user@example.com', email_confirm: true });
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'new-user@example.com',
      options: { shouldCreateUser: false },
    });
  });

  test('既存メールでcreateUserが重複エラーでもOTP送信継続（shouldCreateUser=false）', async () => {
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: 'User already registered' },
    });

    const req = new Request('http://localhost/api/auth/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'existing-user@example.com' }),
    });

    const res = await identifyHandler(req);

    expect(res.status).toBe(200);
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'existing-user@example.com',
      options: { shouldCreateUser: false },
    });
  });

  test('JIT作成が重複以外のエラー時はフォールバック（shouldCreateUser=true）', async () => {
    mockCreateUser.mockResolvedValue({
      data: null,
      error: { message: 'Service unavailable' },
    });

    const req = new Request('http://localhost/api/auth/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'fallback-user@example.com' }),
    });

    const res = await identifyHandler(req);

    expect(res.status).toBe(200);
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'fallback-user@example.com',
      options: { shouldCreateUser: true },
    });
  });
});
