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

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
  headers: jest.fn(),
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

jest.mock('@/lib/audit', () => {
  const logAudit = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: logAudit, logAudit };
});

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn(),
  authFailureResponse: jest.fn(),
}));

jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: jest.fn(),
}));

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

type Handler = (request: Request) => Promise<any>;

const { cookies } = require('next/headers');
const { createClient, createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
const { createServiceRoleAuthClient } = require('@/lib/auth/service-role-auth-client');
const { logAudit } = require('@/lib/audit');
const { authenticateRequest, authFailureResponse } = require('@/lib/auth/authenticate');
const { verifyTurnstile } = require('@/lib/turnstile');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');

const tooMany = () =>
  new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '600' },
  });

const request = (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });

describe('ボットの確かめと回数の制限（ARC-AUTH-005）', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.JWT_SECRET = 'test-jwt-secret';
    (logAudit as jest.Mock).mockResolvedValue(undefined);
    enforceRateLimit.mockResolvedValue(undefined);
    verifyTurnstile.mockResolvedValue({ ok: true });
    cookies.mockResolvedValue({ get: jest.fn().mockReturnValue(undefined), getAll: jest.fn().mockReturnValue([]) });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIGINAL_NODE_ENV;
  });

  describe('IP 単位の枠は、各窓口が何かをする前に数える', () => {
    const rows: Array<{
      label: string;
      method: 'GET' | 'POST';
      path: string;
      load: () => Handler;
      endpoint: string;
      limit: number;
      windowSeconds: number;
      headers?: () => Record<string, string>;
    }> = [
      { label: 'POST /api/auth/oauth/start', method: 'POST', path: '/api/auth/oauth/start', load: () => require('@/app/api/auth/oauth/start/route').POST, endpoint: 'auth:oauth:start', limit: 50, windowSeconds: 600 },
      { label: 'GET /api/auth/oauth/start', method: 'GET', path: '/api/auth/oauth/start', load: () => require('@/app/api/auth/oauth/start/route').GET, endpoint: 'auth:oauth:start', limit: 50, windowSeconds: 600 },
      { label: 'GET /api/auth/oauth/callback', method: 'GET', path: '/api/auth/oauth/callback', load: () => require('@/app/api/auth/oauth/callback/route').GET, endpoint: 'auth:oauth:callback', limit: 50, windowSeconds: 600 },
      { label: 'POST /api/auth/refresh', method: 'POST', path: '/api/auth/refresh', load: () => require('@/app/api/auth/refresh/route').POST, endpoint: 'auth:refresh', limit: 30, windowSeconds: 600 },
    ];

    test.each(rows)('ARC-AUTH-005 $label は先頭で枠（$limit 回／$windowSeconds 秒）を数え、超えたら 429 をそのまま返して先へ進まない', async (row) => {
      const limited = tooMany();
      enforceRateLimit.mockResolvedValueOnce(limited);

      const res = await row.load()(request(row.method, row.path, {}, row.headers?.()));

      expect(res).toBe(limited);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(enforceRateLimit).toHaveBeenCalledTimes(1);
      const arg = enforceRateLimit.mock.calls[0][0];
      expect(arg).toEqual(expect.objectContaining({ endpoint: row.endpoint, limit: row.limit, windowSeconds: row.windowSeconds }));
      expect(arg.subject).toBeUndefined();
      expect(arg.request).toBeInstanceOf(Request);
      expect(verifyTurnstile).not.toHaveBeenCalled();
      expect(createPublicClient).not.toHaveBeenCalled();
      expect(createServiceRoleAuthClient).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe('回数の制限の呼び出しが例外を投げたら、握りつぶさず先へ進まない（SEC-AUTH-013-AC-02）', () => {

    test('ARC-AUTH-005 refresh は枠の数え場所が落ちたら 500 で止まる（Cookie の有無を見る前）', async () => {
      enforceRateLimit.mockRejectedValue(new Error('counter down'));
      const { POST } = require('@/app/api/auth/refresh/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/refresh'));

      expect(res.status).toBe(500);
      expect(consoleErrorSpy).not.toHaveBeenCalledWith('Rate limit middleware error (refresh):', expect.anything());
    });
  });

  describe('回数の制限を置かない窓口', () => {

    test('ARC-AUTH-005 logout は枠を数えずに 200 を返す', async () => {
      const { POST } = require('@/app/api/auth/logout/route') as { POST: () => Promise<any> };

      const res = await POST();

      expect(res.status).toBe(200);
      expect(enforceRateLimit).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-005 me は枠を数えずに答える', async () => {
      authenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
      const { GET } = require('@/app/api/auth/me/route') as { GET: Handler };

      const res = await GET(request('GET', '/api/auth/me'));

      expect(res.status).toBe(200);
      expect(enforceRateLimit).not.toHaveBeenCalled();
    });
  });
});
