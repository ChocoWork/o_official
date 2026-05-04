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

const signInWithOAuthMock = jest.fn();
jest.mock('@supabase/ssr', () => {
  return {
    createServerClient: jest.fn(() => ({
      auth: {
        signInWithOAuth: signInWithOAuthMock,
      },
    })),
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
    signInWithOAuthMock.mockResolvedValue({
      data: {
        url: 'https://example.supabase.co/auth/v1/authorize?provider=google',
      },
      error: null,
    });
  });

  test('redirects to Supabase authorize with account chooser', async () => {
    const { GET } = await handlerImport();

    const req = new Request('http://localhost:3000/api/auth/oauth/start?provider=google&redirect_to=%2Fauth%2Fverified');
    const res: any = await GET(req);

    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(typeof location).toBe('string');
    expect(location).toContain('/auth/v1/authorize');

    expect(signInWithOAuthMock).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'http://localhost:3000/api/auth/oauth/callback?next=%2Fauth%2Fverified',
        queryParams: {
          prompt: 'select_account',
        },
      },
    });
  });

  test('returns 400 for unsupported provider', async () => {
    const { GET } = await handlerImport();

    const req = new Request('http://localhost:3000/api/auth/oauth/start?provider=github&redirect_to=%2Fauth%2Fverified');
    const res: any = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Unsupported provider');
  });

  test('returns 502 when oauth authorize url cannot be generated', async () => {
    signInWithOAuthMock.mockResolvedValueOnce({
      data: { url: null },
      error: { message: 'failed' },
    });

    const { GET } = await handlerImport();

    const req = new Request('http://localhost:3000/api/auth/oauth/start?provider=google&redirect_to=%2Fauth%2Fverified');
    const res: any = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('OAuth start failed');
  });
});

export {};
