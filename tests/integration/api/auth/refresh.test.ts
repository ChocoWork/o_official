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

// Mock rateLimit middleware to avoid DB calls/noise
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

let refreshHandler: any;
const { cookies } = require('next/headers');
const originalConsoleError = console.error;

describe('Refresh API integration (mocked supabase & headers & fetch)', () => {
  beforeAll(() => {
    refreshHandler = require('@/app/api/auth/refresh/route').POST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    console.error = jest.fn();
    // default service client chain
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const fromMock = jest.fn((table: string) => ({
      update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({}) })),
      insert: jest.fn().mockResolvedValue({}),
    }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });
    // by default, no cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    // ensure fetch polyfill/mocking is available in test environment
    if (!(global as any).fetch) {
      (global as any).fetch = jest.fn();
    }
  });

  test('no refresh cookie returns 401', async () => {
    const res: any = await refreshHandler();
    expect(res.status).toBe(401);
  });

  test('token endpoint failure returns 401', async () => {
    // Provide cookie
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';

    // mock fetch to return non-ok
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, text: async () => 'bad' } as any);

    const res: any = await refreshHandler();
    expect(res.status).toBe(401);

    // restore fetch mock
    (global.fetch as jest.MockedFunction<any>).mockRestore();
  });

  test('successful refresh exchanges token, sets cookie and updates sessions table', async () => {
    // Arrange
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: 'old-refresh' }) });
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';

    const fakeTokenResponse = {
      ok: true,
      json: async () => ({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 3600, user: { id: 'u1', email: 'user@example.com' } }),
    } as any;
    jest.spyOn(global, 'fetch').mockResolvedValue(fakeTokenResponse);

    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const fromMock = jest.fn((table: string) => ({
      update: jest.fn(() => ({ eq: jest.fn().mockResolvedValue({}) })),
      insert: jest.fn().mockResolvedValue({}),
    }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    // Act
    const res: any = await refreshHandler();
    const body = await res.json();

    // Assert
    expect(res.status).toBe(200);
    expect(body.access_token).toBeDefined();
    expect(body.user.email).toBe('user@example.com');

    // cookie set
    const cookie = res.cookies.get('sb-refresh-token');
    expect(cookie).toBeDefined();
    expect(cookie.value).toBe('new-r');

    // DB update called
    expect(createServiceRoleClient().from).toHaveBeenCalledWith('sessions');

    (global.fetch as jest.MockedFunction<any>).mockRestore();
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });
});
