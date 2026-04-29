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

const mockSignInWithOtp = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
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
    mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
  });

  test('OTP送信は常に shouldCreateUser:true で行われる', async () => {
    const req = new Request('http://localhost/api/auth/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new-user@example.com' }),
    });

    const res = await identifyHandler(req);
    const body = (await res.json()) as { message?: string };

    expect(res.status).toBe(200);
    expect(body.message).toContain('認証コード');
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'new-user@example.com',
      options: { shouldCreateUser: true },
    });
  });

  test('既存メールでもOTP送信は shouldCreateUser:true で行われる', async () => {
    const req = new Request('http://localhost/api/auth/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'existing-user@example.com' }),
    });

    const res = await identifyHandler(req);

    expect(res.status).toBe(200);
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'existing-user@example.com',
      options: { shouldCreateUser: true },
    });
  });

  test('エラーありでもOTP送信は shouldCreateUser:true で行われる', async () => {
    const req = new Request('http://localhost/api/auth/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'error-user@example.com' }),
    });

    const res = await identifyHandler(req);

    expect(res.status).toBe(200);
    expect(mockSignInWithOtp).toHaveBeenCalledWith({
      email: 'error-user@example.com',
      options: { shouldCreateUser: true },
    });
  });
});
