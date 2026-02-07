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
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn(),
}));

const { cookies } = require('next/headers');
const { logAudit } = require('@/lib/audit');

let registerHandler: any;
let loginHandler: any;
let refreshHandler: any;
let logoutHandler: any;

describe('Auth full flow integration (register -> login -> refresh -> logout)', () => {
  beforeAll(() => {
    registerHandler = require('@/app/api/auth/register/route').POST;
    loginHandler = require('@/app/api/auth/login/route').POST;
    refreshHandler = require('@/app/api/auth/refresh/route').POST;
    logoutHandler = require('@/app/api/auth/logout/route').POST;
  });

  beforeEach(() => {
    jest.resetAllMocks();
    // default cookies to none
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue(undefined) });
    delete process.env.ADMIN_API_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!(global as any).fetch) (global as any).fetch = jest.fn();
  });

  test('register -> login -> refresh -> logout sequence', async () => {
    // REGISTER (admin create user)
    process.env.ADMIN_API_KEY = 'adm';
    const fakeServiceAdmin = { auth: { admin: { createUser: jest.fn().mockResolvedValue({ data: { user: { id: 'u-seq', email: 'seq@example.com' } }, error: null }) } }, from: jest.fn() };
    const { createServiceRoleClient, createClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue(fakeServiceAdmin);

    const regReq = new Request('http://localhost/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'adm' }, body: JSON.stringify({ email: 'seq@example.com', password: 'password123' }) });
    const regRes: any = await registerHandler(regReq);
    const regBody = await regRes.json();
    expect(regRes.status).toBe(201);
    expect(regBody.email).toBe('seq@example.com');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'register', outcome: 'success' }));

    // LOGIN
    const fakeClient = { auth: { signInWithPassword: jest.fn().mockResolvedValue({ data: { session: { access_token: 'a1', refresh_token: 'r1', expires_at: Date.now() + 3600 }, user: { id: 'u-seq', email: 'seq@example.com' } }, error: null }) } };
    createClient.mockResolvedValue(fakeClient);
    const fromMock = jest.fn((table:string) => ({ insert: jest.fn().mockResolvedValue({}) }));
    createServiceRoleClient.mockReturnValue({ from: fromMock });

    const loginReq = new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'seq@example.com', password: 'password123' }) });
    const loginRes: any = await loginHandler(loginReq);
    const loginBody = await loginRes.json();
    expect(loginRes.status).toBe(200);
    expect(loginBody.access_token).toBeDefined();
    // inspect cookie set by login
    const refreshCookie = loginRes.cookies.get('sb-refresh-token');
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie.value).toBe('r1');
    expect(createServiceRoleClient().from).toHaveBeenCalledWith('sessions');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'login', outcome: 'success' }));

    // REFRESH - simulate cookie store having the refresh token from login
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: refreshCookie.value }) });
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc_key';

    (global as any).fetch.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600, user: { id: 'u-seq', email: 'seq@example.com' } }) });
    const serviceFromMock = jest.fn((table: string) => ({ update: jest.fn().mockResolvedValue({}), insert: jest.fn().mockResolvedValue({}) }));
    createServiceRoleClient.mockReturnValue({ from: serviceFromMock });

    const refreshRes: any = await refreshHandler();
    const refreshBody = await refreshRes.json();
    expect(refreshRes.status).toBe(200);
    expect(refreshBody.access_token).toBeDefined();
    // new cookie should be set
    const newCookie = refreshRes.cookies.get('sb-refresh-token');
    expect(newCookie.value).toBe('r2');
    expect(createServiceRoleClient().from).toHaveBeenCalledWith('sessions');

    // LOGOUT - cookie store has latest refresh token
    cookies.mockReturnValue({ get: jest.fn().mockReturnValue({ value: newCookie.value }) });
    const logoutRes: any = await logoutHandler();
    const logoutBody = await logoutRes.json();
    expect(logoutRes.status).toBe(200);
    expect(logoutBody.ok).toBe(true);
    const clearedCookie = logoutRes.cookies.get('sb-refresh-token');
    expect(clearedCookie.maxAge).toBe(0);
  });
});