/**
 * OAuth Callback API Integration Tests (Error Cases)
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

const persistSessionAndCookiesMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: (...args: unknown[]) => persistSessionAndCookiesMock(...args),
}));

const exchangeCodeForSessionMock = jest.fn();
jest.mock('@supabase/ssr', () => {
  return {
    createServerClient: jest.fn(() => ({
      auth: {
        exchangeCodeForSession: exchangeCodeForSessionMock,
      },
    })),
  };
});

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map<string, string>(),
      cookies: { set: jest.fn() },
    }),
    redirect: (url: URL, init?: { status?: number }) => ({
      status: init?.status ?? 302,
      headers: new Map<string, string>([['location', url.toString()]]),
      cookies: { set: jest.fn() },
    }),
  },
}));

describe('GET /api/auth/oauth/callback - Error Cases', () => {
  const handlerImport = () => import('@/app/api/auth/oauth/callback/route');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    exchangeCodeForSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          expires_at: 1_900_000_000,
          token_type: 'bearer',
        },
        user: {
          id: 'user-123',
          email: 'test@example.com',
        },
      },
      error: null,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('[ERROR] code欠落で 400 Bad Request', async () => {
    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?next=%2Fauth%2Fverified');
    const res: { status: number; json: () => Promise<{ error: string }> } = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Bad Request');

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'missing_code',
      })
    );
  });

  test('[ERROR] code欠落で 400 Bad Request', async () => {
    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback');
    const res: { status: number; json: () => Promise<{ error: string }> } = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Bad Request');

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'missing_code',
      })
    );
  });

  test('[ERROR] トークン交換失敗で 502 Bad Gateway', async () => {
    exchangeCodeForSessionMock.mockResolvedValueOnce({
      data: {
        session: null,
        user: null,
      },
      error: { message: 'invalid_grant' },
    });

    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?code=bad-code&next=%2Fauth%2Fverified');
    const res: { status: number; json: () => Promise<{ error: string }> } = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('OAuth exchange failed');

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'token_exchange_failed',
        metadata: expect.objectContaining({ error: 'invalid_grant' }),
      })
    );
  });

  test('[SUCCESS] token交換成功で Cookie 発行 + 303 リダイレクト', async () => {
    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?code=good-code&next=%2Fauth%2Fverified');
    const res: { status: number; headers: Map<string, string> } = await GET(req);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/auth/verified');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    expect(persistSessionAndCookiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 303 }),
      expect.objectContaining({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      }),
      expect.objectContaining({
        id: 'user-123',
        email: 'test@example.com',
      })
    );

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'success',
        actor_email: 'test@example.com',
        resource_id: 'user-123',
      })
    );
  });

  test('[ERROR] セッション永続化失敗でも 303 リダイレクトは返る', async () => {
    exchangeCodeForSessionMock.mockResolvedValueOnce({
      data: {
        session: {
          access_token: 'access-token-2',
          refresh_token: 'refresh-token-2',
          expires_in: 3600,
          expires_at: 1_900_000_001,
          token_type: 'bearer',
        },
        user: {
          id: 'user-456',
          email: 'persist-fail@example.com',
        },
      },
      error: null,
    });

    persistSessionAndCookiesMock.mockResolvedValueOnce({ ok: false, error: 'db insert failed' });

    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?code=good-code-2&next=%2Fauth%2Fverified');
    const res: { status: number; headers: Map<string, string> } = await GET(req);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/auth/verified');

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'error',
      })
    );
  });
});

export {};
