export {};
jest.mock('server-only', () => ({}), { virtual: true });

jest.mock('next/server', () => ({
  after: () => {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const cookies: Array<Record<string, unknown>> = [];
      return {
        status: init?.status ?? 200,
        _body: body,
        json: async () => body,
        headers: new Map<string, string>(),
        cookies: {
          _cookies: cookies,
          set(c: Record<string, unknown>) {
            cookies.push(c);
          },
          get(name: string) {
            return cookies.find((c) => c.name === name);
          },
        },
      };
    },
  },
}));

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

jest.mock('@/lib/auth/staff-passkey-idle-rpc', () => ({ staffIdlePeek: jest.fn().mockResolvedValue({ ok: true, value: true }) }));
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: jest.fn(),
}));

jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: async () => ({ status: 'ok' }),
  PWNED_PASSWORD_MESSAGE: 'pwned',
}));

type Handler = (request: Request) => Promise<any>;

const { createClient, createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { createServiceRoleAuthClient } = require('@/lib/auth/service-role-auth-client');
const { authenticateRequest } = require('@/lib/auth/authenticate');

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('認証の全体の作り（ARC-AUTH-001）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  describe('入力の形は全部の窓口で zod が確かめる', () => {
    const makeResetCookie = () => {
      const { createPasswordResetSessionToken } = require('@/features/auth/services/password-reset-session');
      const token = createPasswordResetSessionToken({ userId: 'u1', email: 'user@example.com', tokenId: 'tok1' });
      return `sb-password-reset-session=${encodeURIComponent(token)}`;
    };

    const cases: Array<{ name: string; load: () => Handler; path: string; body: unknown; headers?: () => Record<string, string> }> = [
      {
        name: 'password-reset/request',
        load: () => require('@/app/api/auth/password-reset/request/route').POST,
        path: '/api/auth/password-reset/request',
        body: { email: 'not-an-email' },
      },
      {
        name: 'password-reset/confirm',
        load: () => require('@/app/api/auth/password-reset/confirm/route').POST,
        path: '/api/auth/password-reset/confirm',
        body: { new_password: 'short' },
        headers: () => ({ cookie: makeResetCookie() }),
      },
    ];

    test.each(cases)('ARC-AUTH-001 $name は形の合わない本文を 400 の validation_error で断り、Supabase を呼ばない', async ({ load, path, body, headers }) => {
      const res = await load()(postJson(path, body, headers?.()));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe('validation_error');
      expect(Array.isArray(json.detail)).toBe(true);
      expect(createPublicClient).not.toHaveBeenCalled();
      expect(createServiceRoleAuthClient).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe('役割は JWT の app_metadata から読み、無ければ user にする', () => {
    const callMe = async () => {
      const { GET } = require('@/app/api/auth/me/route');
      return (await GET(new Request('http://localhost/api/auth/me'))) as any;
    };

    test.each([['admin'], ['supporter'], ['user']])('ARC-AUTH-001 app_metadata.role が %s ならそのまま返す', async (role) => {
      authenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'u1', session_id: 'session-1', email: 'u@example.com', aal: 'aal1', app_metadata: { role } } });
      const body = await (await callMe()).json();
      expect(body.authenticated).toBe(true);
      expect(body.user.role).toBe(role);
    });

    test.each([
      ['役割が無い', {}],
      ['役割が知らない値', { role: 'owner' }],
      ['app_metadata 自体が無い', undefined],
    ])('ARC-AUTH-001 %s時は user にする', async (_label, appMetadata) => {
      authenticateRequest.mockResolvedValue({ ok: true, claims: { sub: 'u1', session_id: 'session-1', email: 'u@example.com', aal: 'aal1', app_metadata: appMetadata } });
      const body = await (await callMe()).json();
      expect(body.user.role).toBe('user');
      expect(body.user.mfaVerified).toBe(false);
    });

    test('ARC-AUTH-001 認証に通らない要求には authenticated:false を返し、役割を渡さない', async () => {
      authenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
      const res = await callMe();
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ authenticated: false });
    });
  });
});
