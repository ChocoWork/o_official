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

const { authenticateRequest } = require('@/lib/auth/authenticate');

describe('認証の全体の作り（ARC-AUTH-001）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-jwt-secret';
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
