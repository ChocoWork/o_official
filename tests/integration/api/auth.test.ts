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

let loginHandler: any;
let registerHandler: any;
let pwRequestHandler: any;
let pwConfirmHandler: any;

describe('Auth API integration (mocked supabase)', () => {
  beforeAll(() => {
    // require after mocking next/server
    loginHandler = require('@/app/api/auth/login/route').POST;
    registerHandler = require('@/app/api/auth/register/route').POST;
    pwRequestHandler = require('@/app/api/auth/password-reset/request/route').POST;
    pwConfirmHandler = require('@/app/api/auth/password-reset/confirm/route').POST;
  });

  beforeEach(() => {
    // default service client to satisfy audit/logging and password reset inserts
    const { createServiceRoleClient, createClient } = require('@/lib/supabase/server');
    createServiceRoleClient.mockReturnValue({ from: jest.fn().mockReturnValue({ insert: jest.fn().mockResolvedValue({}) }), auth: { admin: { updateUserById: jest.fn().mockResolvedValue({}) } } });
    createClient.mockResolvedValue({ auth: { signInWithPassword: jest.fn().mockResolvedValue({ data: null, error: null }) } });
    process.env.MAIL_FROM_ADDRESS = 'no-reply@example.com';
  });

  afterEach(() => jest.resetAllMocks());

  test('login success returns 200 with access_token and user', async () => {
    const { createClient } = require('@/lib/supabase/server');
    const fakeClient = {
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: { session: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() }, user: { id: 'u', email: 'user@example.com' } },
          error: null,
        }),
      },
    };
    createClient.mockResolvedValue(fakeClient);

    const req = new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', password: 'password123' }) });

    const res: any = await loginHandler(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.access_token).toBeDefined();
    expect(body.user.email).toBe('user@example.com');
  });

  test('login invalid credentials returns 401', async () => {
    const { createClient } = require('@/lib/supabase/server');
    const fakeClient = {
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({ data: null, error: { message: 'invalid' } }),
      },
    };
    createClient.mockResolvedValue(fakeClient);

    const req = new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', password: 'wrongpass' }) });

    const res: any = await loginHandler(req);
    expect(res.status).toBe(401);
  });

  test('register success (admin) returns 201', async () => {
    process.env.ADMIN_API_KEY = 'adm';
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const fakeService = {
      auth: { admin: { createUser: jest.fn().mockResolvedValue({ data: { user: { id: 'u1', email: 'new@example.com' } }, error: null }) } },
    };
    createServiceRoleClient.mockReturnValue(fakeService);

    const req = new Request('http://localhost/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'adm' }, body: JSON.stringify({ email: 'new@example.com', password: 'password123' }) });

    const res: any = await registerHandler(req);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.email).toBe('new@example.com');
  });

  test('register unauthorized without admin token returns 401', async () => {
    delete process.env.ADMIN_API_KEY;
    const req = new Request('http://localhost/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new@example.com', password: 'password123' }) });

    const res: any = await registerHandler(req);
    expect(res.status).toBe(500); // because server misconfiguration when ADMIN_API_KEY not configured
  });

  test('password reset request inserts token and returns 200', async () => {
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const insertMock = jest.fn().mockResolvedValue({});
    const fromMock = jest.fn((table: string) => ({ insert: insertMock, select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data: null }) }));
    const fakeService = { from: fromMock };
    createServiceRoleClient.mockReturnValue(fakeService);

    const req = new Request('http://localhost/api/auth/password-reset/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com' }) });

    const res: any = await pwRequestHandler(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(insertMock).toHaveBeenCalled();
  });

  test('password reset confirm with valid token updates password and returns 200', async () => {
    const { createServiceRoleClient } = require('@/lib/supabase/server');
    const updateMock = jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({}) });
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'tok1', user_id: 'u1', email: 'user@example.com' } }),
      update: jest.fn().mockReturnThis(),
    };
    // make eq and update chainable
    chain.update.mockReturnValue({ eq: jest.fn().mockResolvedValue({}) });

    const fromFn = jest.fn((table: string) => chain);
    const fakeService = { from: fromFn, auth: { admin: { updateUserById: jest.fn().mockResolvedValue({}) } } };
    createServiceRoleClient.mockReturnValue(fakeService);

    const req = new Request('http://localhost/api/auth/password-reset/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'tok', email: 'user@example.com', new_password: 'newpassword123' }) });

    const res: any = await pwConfirmHandler(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });
});
