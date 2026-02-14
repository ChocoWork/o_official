/**
 * OAuth Start API Integration Tests
 * タスク: [AUTH-02]
 * 対応 REQ: REQ-AUTH-006
 * 対応 ARCH-ID: ARCH-AUTH-06
 * 仕様書: docs/specs/01_auth.md §4.5
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

// Minimal Supabase service-role mock for oauth_requests insert
jest.mock('@/lib/supabase/server', () => {
  const insert = jest.fn().mockResolvedValue({ data: [{ id: 'req-1' }], error: null });
  const from = jest.fn(() => ({ insert }));
  return {
    createServiceRoleClient: jest.fn(async () => ({ from })),
  };
});

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: any, init?: any) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map<string, string>(),
    }),
    redirect: (url: URL, init?: any) => ({
      status: init?.status ?? 302,
      headers: new Map<string, string>([['location', url.toString()]]),
      cookies: { set: jest.fn() },
    }),
  },
}));

describe('GET /api/auth/oauth/start', () => {
  const handlerImport = () => import('@/app/api/auth/oauth/start/route');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  });

  test('redirects to Supabase authorize with state and PKCE', async () => {
    const { GET } = await handlerImport();

    const req = new Request('http://localhost:3000/api/auth/oauth/start?provider=google&redirect_to=%2Fauth%2Fverified');
    const res: any = await GET(req);

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(typeof location).toBe('string');
    expect(location).toContain('/auth/v1/authorize');
    expect(location).toContain('provider=google');
    expect(location).toContain('code_challenge=');
    expect(location).toContain('code_challenge_method=S256');
    expect(location).toContain('state=');
    expect(location).toContain('redirect_to=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fauth%2Foauth%2Fcallback');
  });

  test('returns 400 for unsupported provider', async () => {
    const { GET } = await handlerImport();

    const req = new Request('http://localhost:3000/api/auth/oauth/start?provider=github&redirect_to=%2Fauth%2Fverified');
    const res: any = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Unsupported provider');
  });
});

export {};
