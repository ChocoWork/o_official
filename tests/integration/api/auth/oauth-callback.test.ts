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

const maybeSingleMock = jest.fn();
const eqUpdateMock = jest.fn().mockResolvedValue({ data: null, error: null });
const updateMock = jest.fn().mockReturnValue({ eq: eqUpdateMock });

jest.mock('@/lib/supabase/server', () => {
  const from = jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    maybeSingle: maybeSingleMock,
    update: updateMock,
  }));

  return {
    createServiceRoleClient: jest.fn(async () => ({ from })),
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
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('[ERROR] state期限切れで 400 Bad Request', async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });

    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?code=valid-code&state=expired-state');
    const res: { status: number; json: () => Promise<{ error: string }> } = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid state');

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'invalid_or_expired_state',
      })
    );
  });

  test('[ERROR] code/state欠落で 400 Bad Request', async () => {
    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?state=only-state');
    const res: { status: number; json: () => Promise<{ error: string }> } = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Bad Request');

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'missing_code_or_state',
      })
    );
  });

  test('[ERROR] state再利用で 400 Bad Request', async () => {
    // used_at is not null のレコードは .is('used_at', null) で取得されず、結果的に data:null になる想定
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null });

    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?code=valid-code&state=reused-state');
    const res: { status: number; json: () => Promise<{ error: string }> } = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('Invalid state');

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'invalid_or_expired_state',
      })
    );
  });

  test('[ERROR] トークン交換失敗で 502 Bad Gateway', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: 'oauth-req-1',
        code_verifier: 'verifier-123',
        redirect_to: '/auth/verified',
      },
      error: null,
    });

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
      json: async () => ({ error: 'invalid_grant' }),
      } as unknown as Response),
    });

    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?code=bad-code&state=valid-state');
    const res: { status: number; json: () => Promise<{ error: string }> } = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('OAuth exchange failed');

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ used_at: expect.any(String) }));
    expect(eqUpdateMock).toHaveBeenCalledWith('id', 'oauth-req-1');

    const { logAudit } = require('@/lib/audit');
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.oauth.callback',
        outcome: 'failure',
        detail: 'token_exchange_failed',
        metadata: expect.objectContaining({ status: 400 }),
      })
    );
  });

  test('[SUCCESS] token交換成功で Cookie 発行 + 303 リダイレクト', async () => {
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: 'oauth-req-success-1',
        code_verifier: 'verifier-success-123',
        redirect_to: '/auth/verified',
      },
      error: null,
    });

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'bearer',
          user: {
            id: 'user-123',
            email: 'test@example.com',
          },
        }),
      } as unknown as Response),
    });

    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?code=good-code&state=valid-state');
    const res: { status: number; headers: Map<string, string> } = await GET(req);

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('http://localhost:3000/auth/verified');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ used_at: expect.any(String) }));
    expect(eqUpdateMock).toHaveBeenCalledWith('id', 'oauth-req-success-1');

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
    maybeSingleMock.mockResolvedValueOnce({
      data: {
        id: 'oauth-req-success-2',
        code_verifier: 'verifier-success-456',
        redirect_to: '/auth/verified',
      },
      error: null,
    });

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'access-token-2',
          refresh_token: 'refresh-token-2',
          expires_in: 3600,
          token_type: 'bearer',
          user: {
            id: 'user-456',
            email: 'persist-fail@example.com',
          },
        }),
      } as unknown as Response),
    });

    persistSessionAndCookiesMock.mockResolvedValueOnce({ ok: false, error: 'db insert failed' });

    const { GET } = await handlerImport();
    const req = new Request('http://localhost:3000/api/auth/oauth/callback?code=good-code-2&state=valid-state-2');
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
