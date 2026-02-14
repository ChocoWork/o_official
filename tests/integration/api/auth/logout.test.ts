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
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    // default: no CSRF header (optional since logout can work without CSRF check in some flows)
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(null) });
  });

  test('no cookie returns 200 and clears cookies', async () => {
    const res: any = await logoutHandler();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const refreshCookie = res.cookies.get('sb-refresh-token');
    const accessCookie = res.cookies.get('sb-access-token');
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
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(csrfToken) }); // Valid CSRF header

    const eqMock = jest.fn().mockResolvedValue({});
    const updateMock = jest.fn().mockReturnValue({ eq: eqMock });
    const maybeSingleMock = jest.fn().mockResolvedValue({ data: { csrf_token_hash: csrfHash } });
    const selectEqMock = jest.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: selectEqMock });
    const fromMock = jest.fn((table: string) => ({ update: updateMock, select: selectMock }));
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    // Act
    const res: any = await logoutHandler();
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(createServiceRoleClient().from).toHaveBeenCalledWith('sessions');
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ revoked_at: expect.any(String) }));

    const refreshCookie = res.cookies.get('sb-refresh-token');
    const accessCookie = res.cookies.get('sb-access-token');
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.maxAge).toBe(0);
    expect(accessCookie).toBeDefined();
    expect(accessCookie.maxAge).toBe(0);
  });

  test('DB update failure still clears cookies and returns 200', async () => {
    const { tokenHashSha256 } = await import('@/lib/hash');
    const csrfToken = 'valid-csrf-token';
    const csrfHash = await tokenHashSha256(csrfToken);

    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    headers.mockReturnValue({ get: jest.fn().mockReturnValue(csrfToken) });

    const updateMock = jest.fn(() => { throw new Error('db fail'); });
    const maybeSingleMock = jest.fn().mockResolvedValue({ data: { csrf_token_hash: csrfHash } });
    const selectEqMock = jest.fn().mockReturnValue({ maybeSingle: maybeSingleMock });
    const selectMock = jest.fn().mockReturnValue({ eq: selectEqMock });
    const fromMock = jest.fn((table: string) => ({ update: updateMock, select: selectMock }));
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const res: any = await logoutHandler();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const refreshCookie = res.cookies.get('sb-refresh-token');
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.maxAge).toBe(0);
  });
});