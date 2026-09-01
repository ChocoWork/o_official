export {};

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
          set(c: any) { this._cookies.push(c); },
          get(name: string) { return this._cookies.find((c: any) => c.name === name); },
        },
      };
      return res;
    },
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(),
  verifyAccessToken: jest.fn(),
}));

// ログアウトは期限切れトークンからも session_id を読む必要があるため
// authenticateRequest ではなく verifyAccessToken を直接使う。
jest.mock('@/lib/auth/authenticate', () => ({
  verifyAccessToken: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const { cookies, headers } = require('next/headers');
let logoutHandler: any;

describe('Logout API integration (mocked supabase & headers)', () => {
  beforeAll(() => {
    logoutHandler = require('@/app/api/auth/logout/route').POST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // default: no cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined), getAll: jest.fn().mockReturnValue([]) });
    // default: no CSRF header (optional since logout can work without CSRF check in some flows)
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(null) });
    const { verifyAccessToken } = require('@/lib/auth/authenticate');
    verifyAccessToken.mockResolvedValue({ ok: true, claims: { session_id: 'session-1' } });
  });

  test('no cookie returns 200 and clears cookies', async () => {
    const res: any = await logoutHandler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const refreshCookie = res.cookies.get('sb-refresh-token');
    const sessionCookie = res.cookies.get('session_id');
    const accessCookie = res.cookies.get('sb-access-token');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie.maxAge).toBe(0);
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.maxAge).toBe(0);
    expect(accessCookie).toBeDefined();
    expect(accessCookie.maxAge).toBe(0);
  });

  test('with cookie revokes sessions and clears cookies', async () => {
    // Mock CSRF verification to allow request
    const { tokenHashSha256 } = await import('@/lib/hash');
    const csrfToken = 'valid-csrf-token';
    const csrfHash = await tokenHashSha256(csrfToken);
    
    // Arrange: provide cookie and mock DB update chain
    cookies.mockReturnValue({
      get: jest.fn((name: string) =>
        name === 'sb-access-token' ? { value: 'old-access' } : { value: 'old-refresh' },
      ),
      getAll: jest.fn().mockReturnValue([]),
    });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(csrfToken) }); // Valid CSRF header

    const eqMock = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue({ data: [{ user_id: 'user-1' }], error: null }) });
    const updateMock = jest.fn().mockReturnValue({ eq: eqMock });
    const maybeSingleMock = jest.fn().mockResolvedValue({ data: { csrf_token_hash: csrfHash } });
    const selectEqMock = jest.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: selectEqMock });
    const fromMock = jest.fn(() => ({ update: updateMock, select: selectMock }));
    const rpcMock = jest.fn().mockResolvedValue({ data: 1, error: null });
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({ from: fromMock, rpc: rpcMock });

    // Act
    const res: any = await logoutHandler();
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(createServiceRoleClient().from).toHaveBeenCalledWith('sessions');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ revoked_at: expect.any(String) }));
    // 自前テーブルだけでなく Supabase 側のセッションも終了させる。
    // access token の有効性に依存しないよう session_id クレームで RPC を叩く。
    expect(rpcMock).toHaveBeenCalledWith('revoke_auth_session', { p_session_id: 'session-1' });

    const refreshCookie = res.cookies.get('sb-refresh-token');
    const sessionCookie = res.cookies.get('session_id');
    const accessCookie = res.cookies.get('sb-access-token');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie.maxAge).toBe(0);
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.maxAge).toBe(0);
    expect(accessCookie).toBeDefined();
    expect(accessCookie.maxAge).toBe(0);
  });

  test('DB update failure still clears cookies and returns 200', async () => {
    const { tokenHashSha256 } = await import('@/lib/hash');
    const csrfToken = 'valid-csrf-token';
    const csrfHash = await tokenHashSha256(csrfToken);

    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }), getAll: jest.fn().mockReturnValue([]) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(csrfToken) });

    const updateMock = jest.fn(() => { throw new Error('db fail'); });
    const maybeSingleMock = jest.fn().mockResolvedValue({ data: { csrf_token_hash: csrfHash } });
    const selectEqMock = jest.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: selectEqMock });
    const fromMock = jest.fn(() => ({ update: updateMock, select: selectMock }));
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const res: any = await logoutHandler();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const refreshCookie = res.cookies.get('sb-refresh-token');
    const sessionCookie = res.cookies.get('session_id');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie.maxAge).toBe(0);
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.maxAge).toBe(0);
  });

  test('clears leftover @supabase/ssr auth cookies set by OAuth login', async () => {
    // Google OAuth ログインが残す sb-<ref>-auth-token[.N] も消えること
    cookies.mockReturnValue({
      get: jest.fn().mockReturnValue(undefined),
      getAll: jest.fn().mockReturnValue([
        { name: 'sb-abcdefgh-auth-token', value: 'x' },
        { name: 'sb-abcdefgh-auth-token.0', value: 'y' },
        { name: 'unrelated-cookie', value: 'z' },
      ]),
    });

    const res: any = await logoutHandler();
    expect(res.status).toBe(200);

    const ssrCookie = res.cookies.get('sb-abcdefgh-auth-token');
    const ssrChunk = res.cookies.get('sb-abcdefgh-auth-token.0');
    const unrelated = res.cookies.get('unrelated-cookie');
    expect(ssrCookie).toBeDefined();
    expect(ssrCookie.maxAge).toBe(0);
    expect(ssrChunk).toBeDefined();
    expect(ssrChunk.maxAge).toBe(0);
    expect(unrelated).toBeUndefined();
  });

  test('access token が期限切れで session_id を取れなくても Auth 側セッションを残さない', async () => {
    const { tokenHashSha256 } = await import('@/lib/hash');
    const csrfToken = 'valid-csrf-token';
    const csrfHash = await tokenHashSha256(csrfToken);

    cookies.mockReturnValue({
      get: jest.fn().mockReturnValue({ value: 'old-refresh' }),
      getAll: jest.fn().mockReturnValue([]),
    });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(csrfToken) });

    const eqMock = jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue({ data: [{ user_id: 'user-1' }], error: null }) });
    const maybeSingleMock = jest.fn().mockResolvedValue({ data: { csrf_token_hash: csrfHash } });
    const fromMock = jest.fn(() => ({
      update: jest.fn().mockReturnValue({ eq: eqMock }),
      select: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ maybeSingle: maybeSingleMock }) }),
    }));
    const rpcMock = jest.fn().mockResolvedValue({ data: 2, error: null });
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const { verifyAccessToken } = require('@/lib/auth/authenticate');
    createServiceRoleClient.mockReturnValue({ from: fromMock, rpc: rpcMock });
    // access Cookie が無い／期限切れで session_id が取り出せない状況
    verifyAccessToken.mockResolvedValue({ ok: false, reason: 'missing' });

    const res: any = await logoutHandler();

    expect(res.status).toBe(200);
    // 単一セッションを特定できないときは全端末を落とす。生きたサーバセッションを残さない。
    expect(rpcMock).toHaveBeenCalledWith('revoke_auth_sessions_for_user', { p_user_id: 'user-1' });
    expect(res.cookies.get('sb-refresh-token').maxAge).toBe(0);
  });
});
