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
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
}));

const { cookies, headers } = require('next/headers');

// Bypass CSRF middleware checks in this integration test suite to avoid
// dependencies on header hashing and DB state. Individual CSRF unit tests
// cover the middleware behavior.
jest.mock('@/lib/csrfMiddleware', () => ({
  requireCsrfOrDeny: jest.fn().mockResolvedValue(undefined),
}));

describe('Auth cookie flags (integration, mocked)', () => {
  let loginHandler: any;
  let refreshHandler: any;
  let logoutHandler: any;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeAll(() => {
    loginHandler = require('@/app/api/auth/login/route').POST;
    refreshHandler = require('@/app/api/auth/refresh/route').POST;
    logoutHandler = require('@/app/api/auth/logout/route').POST;
  });

  afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // default: no cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
  });

  test('login sets refresh cookie HttpOnly=true, SameSite=lax and csrf cookie HttpOnly=false, SameSite=lax', async () => {
    process.env.NODE_ENV = 'production';

    // mock supabase client signInWithPassword
    const { createClient, createServiceRoleClient } = require('@/lib/supabase/server');
    createClient.mockReturnValue({ auth: { signInWithPassword: jest.fn().mockResolvedValue({ data: { session: { access_token: 'a', refresh_token: 'r', expires_at: new Date().toISOString() }, user: { id: 'u1' } }, error: null }) } });

    const fromMock = jest.fn((table: string) => ({ insert: jest.fn().mockResolvedValue({}) }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    // call handler
    const req: any = { json: async () => ({ email: 'u@example.com', password: 'passw0rd' }) };
    const res: any = await loginHandler(req);

    const refreshCookie = res.cookies.get('sb-refresh-token');
    const csrfCookie = res.cookies.get('sb-csrf-token');

    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.httpOnly).toBe(true);
    expect(refreshCookie.sameSite).toBe('lax');
    expect(refreshCookie.secure).toBe(true);

    expect(csrfCookie).toBeDefined();
    expect(csrfCookie.httpOnly).toBe(false);
    expect(csrfCookie.sameSite).toBe('lax');
  });

  test('refresh sets new refresh cookie and csrf cookie with proper flags', async () => {
    process.env.NODE_ENV = 'production';
    // Provide existing cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });

    // token exchange requires SUPABASE env in handler
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';

    // mock fetch token exchange
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 3600, user: { id: 'u1' } }) });

    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const fromMock = jest.fn((table: string) => ({
      update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({}) }),
      insert: jest.fn().mockResolvedValue({}),
    }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const res: any = await refreshHandler();

    const refreshCookie = res.cookies.get('sb-refresh-token');
    const csrfCookie = res.cookies.get('sb-csrf-token');

    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.httpOnly).toBe(true);
    expect(refreshCookie.sameSite).toBe('lax');
    expect(refreshCookie.secure).toBe(true);

    expect(csrfCookie).toBeDefined();
    expect(csrfCookie.httpOnly).toBe(false);
    expect(csrfCookie.sameSite).toBe('lax');

    (global.fetch as jest.MockedFunction<any>).mockRestore?.();
  });

  test('logout clears cookies (maxAge=0) and clear cookie options preserve httpOnly flag for refresh cookie', async () => {
    // provide cookie so logout triggers revoke path
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });

    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const fromMock = jest.fn((table: string) => ({ update: jest.fn().mockResolvedValue({}) }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const res: any = await logoutHandler();

    const refreshCookie = res.cookies.get('sb-refresh-token');
    const accessCookie = res.cookies.get('sb-access-token');
    const csrfCookie = res.cookies.get('sb-csrf-token');

    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.maxAge).toBe(0);
    expect(refreshCookie.httpOnly).toBe(true);

    expect(accessCookie).toBeDefined();
    expect(accessCookie.maxAge).toBe(0);

    expect(csrfCookie).toBeDefined();
    expect(csrfCookie.maxAge).toBe(0);
  });
});
