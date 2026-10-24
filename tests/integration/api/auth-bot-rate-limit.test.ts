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

jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));

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

jest.mock('@/lib/pwned-password', () => ({
  checkPwnedPassword: async () => ({ status: 'ok' }),
  PWNED_PASSWORD_MESSAGE: 'pwned',
}));

type Handler = (request: Request) => Promise<any>;

const { cookies } = require('next/headers');
const { createClient, createPublicClient, createServiceRoleClient } = require('@/lib/supabase/server');
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

const pendingCookieHeader = (email: string) => {
  const { createLoginTwoFactorSessionToken } = require('@/features/auth/services/login-2fa-session');
  const token = createLoginTwoFactorSessionToken({ userId: 'u1', email });
  return { cookie: `sb-login-2fa-session=${encodeURIComponent(token)}` };
};

const loginBody = { email: 'User@Example.com', password: 'password123456789', turnstileToken: 'ts-token' };

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
      { label: 'POST /api/auth/login', method: 'POST', path: '/api/auth/login', load: () => require('@/app/api/auth/login/route').POST, endpoint: 'auth:login', limit: 50, windowSeconds: 600 },
      {
        label: 'POST /api/auth/login/resend',
        method: 'POST',
        path: '/api/auth/login/resend',
        load: () => require('@/app/api/auth/login/resend/route').POST,
        endpoint: 'auth:login',
        limit: 50,
        windowSeconds: 600,
        headers: () => pendingCookieHeader('pending@example.com'),
      },
      { label: 'POST /api/auth/otp/verify', method: 'POST', path: '/api/auth/otp/verify', load: () => require('@/app/api/auth/otp/verify/route').POST, endpoint: 'auth:otp:verify', limit: 30, windowSeconds: 600 },
      { label: 'POST /api/auth/register', method: 'POST', path: '/api/auth/register', load: () => require('@/app/api/auth/register/route').POST, endpoint: 'auth:register', limit: 20, windowSeconds: 3600 },
      { label: 'POST /api/auth/password-reset/request', method: 'POST', path: '/api/auth/password-reset/request', load: () => require('@/app/api/auth/password-reset/request/route').POST, endpoint: 'auth:password_reset_request', limit: 10, windowSeconds: 3600 },
      { label: 'POST /api/auth/password-reset/link', method: 'POST', path: '/api/auth/password-reset/link', load: () => require('@/app/api/auth/password-reset/link/route').POST, endpoint: 'auth:password_reset_link', limit: 20, windowSeconds: 600 },
      { label: 'POST /api/auth/password-reset/confirm', method: 'POST', path: '/api/auth/password-reset/confirm', load: () => require('@/app/api/auth/password-reset/confirm/route').POST, endpoint: 'auth:password_reset_confirm', limit: 10, windowSeconds: 3600 },
      { label: 'GET /api/auth/confirm', method: 'GET', path: '/api/auth/confirm', load: () => require('@/app/api/auth/confirm/route').GET, endpoint: 'auth:confirm', limit: 50, windowSeconds: 600 },
      { label: 'GET /api/auth/oauth/start', method: 'GET', path: '/api/auth/oauth/start', load: () => require('@/app/api/auth/oauth/start/route').GET, endpoint: 'auth:oauth:start', limit: 50, windowSeconds: 600 },
      { label: 'GET /api/auth/oauth/callback', method: 'GET', path: '/api/auth/oauth/callback', load: () => require('@/app/api/auth/oauth/callback/route').GET, endpoint: 'auth:oauth:callback', limit: 50, windowSeconds: 600 },
      { label: 'POST /api/auth/refresh', method: 'POST', path: '/api/auth/refresh', load: () => require('@/app/api/auth/refresh/route').POST, endpoint: 'auth:refresh', limit: 30, windowSeconds: 600 },
      { label: 'POST /api/auth/mfa/enroll-totp', method: 'POST', path: '/api/auth/mfa/enroll-totp', load: () => require('@/app/api/auth/mfa/enroll-totp/route').POST, endpoint: 'auth:mfa:enroll-totp', limit: 10, windowSeconds: 600 },
      { label: 'POST /api/auth/mfa/verify', method: 'POST', path: '/api/auth/mfa/verify', load: () => require('@/app/api/auth/mfa/verify/route').POST, endpoint: 'auth:mfa:verify', limit: 20, windowSeconds: 600 },
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
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe('ログインはメール単位の枠を Turnstile の後に数える', () => {
    test('ARC-AUTH-005 login は Turnstile を通ってから、小文字にそろえたメールを subject にして 5 回／600 秒の枠を数える', async () => {
      enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(tooMany());
      const { POST } = require('@/app/api/auth/login/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/login', loginBody, { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }));

      expect(res.status).toBe(429);
      expect(verifyTurnstile).toHaveBeenCalledWith('ts-token', '203.0.113.5');
      expect(enforceRateLimit).toHaveBeenCalledTimes(2);
      expect(enforceRateLimit.mock.calls[1][0]).toEqual(
        expect.objectContaining({ endpoint: 'auth:login', limit: 5, windowSeconds: 600, subject: 'user@example.com' }),
      );
      expect(verifyTurnstile.mock.invocationCallOrder[0]).toBeLessThan(enforceRateLimit.mock.invocationCallOrder[1]);
      expect(createPublicClient).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-005 login は Turnstile に落ちたら 403 で止め、メールの枠を数えない（他人の枠を潰させない）', async () => {
      verifyTurnstile.mockResolvedValue({ ok: false, error: 'invalid-input-response' });
      const { POST } = require('@/app/api/auth/login/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/login', loginBody));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Bot detection failed' });
      expect(enforceRateLimit).toHaveBeenCalledTimes(1);
      expect(enforceRateLimit.mock.calls[0][0].subject).toBeUndefined();
      expect(createPublicClient).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'login', outcome: 'failure', detail: 'invalid-input-response' }));
    });

    test('ARC-AUTH-005 login は本番で Turnstile の鍵が無いと 403 で断る', async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      delete process.env.TURNSTILE_SECRET_KEY;
      verifyTurnstile.mockImplementation(jest.requireActual('@/lib/turnstile').verifyTurnstile);
      const { POST } = require('@/app/api/auth/login/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/login', loginBody));

      expect(res.status).toBe(403);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'turnstile_not_configured' }));
      expect(createPublicClient).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-005 login は Origin の確かめを窓口に持たず、別のサイトの Origin でもここでは断らない（共有の proxy が受け持つ）', async () => {
      createPublicClient.mockResolvedValue({
        auth: { signInWithPassword: jest.fn().mockResolvedValue({ data: null, error: { message: 'invalid' } }) },
      });
      const { POST } = require('@/app/api/auth/login/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/login', loginBody, { origin: 'https://evil.example' }));

      expect(res.status).toBe(401);
      expect(createPublicClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('パスワード再設定の申請はメール単位の枠を Turnstile の後に数える', () => {
    const resetBody = { email: 'User@Example.com', turnstileToken: 'ts-token' };

    test('ARC-AUTH-005 password-reset/request は Turnstile を通ってから、メールを subject にして 5 回／3600 秒の枠を数える', async () => {
      enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(tooMany());
      const { POST } = require('@/app/api/auth/password-reset/request/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/password-reset/request', resetBody));

      expect(res.status).toBe(429);
      expect(enforceRateLimit.mock.calls[1][0]).toEqual(
        expect.objectContaining({ endpoint: 'auth:password_reset_request', limit: 5, windowSeconds: 3600, subject: 'user@example.com' }),
      );
      expect(verifyTurnstile.mock.invocationCallOrder[0]).toBeLessThan(enforceRateLimit.mock.invocationCallOrder[1]);
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-005 password-reset/request は Turnstile に落ちたら 403 で止め、メールの枠を数えない', async () => {
      verifyTurnstile.mockResolvedValue({ ok: false, error: 'missing_turnstile_token' });
      const { POST } = require('@/app/api/auth/password-reset/request/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/password-reset/request', resetBody));

      expect(res.status).toBe(403);
      expect(enforceRateLimit).toHaveBeenCalledTimes(1);
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });
  });

  describe('会員登録は IP 単位の枠だけで、メール送信の手前に Turnstile を置く', () => {
    test('ARC-AUTH-005 register は Turnstile に落ちたら 403 で止め、Supabase を呼ばず、メール単位の枠も持たない', async () => {
      verifyTurnstile.mockResolvedValue({ ok: false, error: 'invalid-input-response' });
      const { POST } = require('@/app/api/auth/register/route') as { POST: Handler };

      const res = await POST(
        request('POST', '/api/auth/register', { email: 'new@example.com', password: 'password123456789', turnstileToken: 'ts-token' }, { 'x-forwarded-for': '203.0.113.9' }),
      );

      expect(res.status).toBe(403);
      expect(verifyTurnstile).toHaveBeenCalledWith('ts-token', '203.0.113.9');
      expect(enforceRateLimit).toHaveBeenCalledTimes(1);
      expect(enforceRateLimit.mock.calls[0][0]).toEqual(expect.objectContaining({ endpoint: 'auth:register', limit: 20, windowSeconds: 3600 }));
      expect(createClient).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
    });
  });

  describe('認証コードの再送と検証のメール単位の枠は、宛先を Cookie から取る', () => {
    test('ARC-AUTH-005 login/resend は IP の枠の次に、ログインと同じ枠（auth:login）を Cookie の宛先で数え、本文のメールは見ない', async () => {
      enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(tooMany());
      const { POST } = require('@/app/api/auth/login/resend/route') as { POST: Handler };

      const res = await POST(
        request('POST', '/api/auth/login/resend', { email: 'attacker-chosen@example.com' }, pendingCookieHeader('pending@example.com')),
      );

      expect(res.status).toBe(429);
      expect(enforceRateLimit).toHaveBeenCalledTimes(2);
      expect(enforceRateLimit.mock.calls[0][0]).toEqual(expect.objectContaining({ endpoint: 'auth:login', limit: 50, windowSeconds: 600 }));
      expect(enforceRateLimit.mock.calls[1][0]).toEqual(
        expect.objectContaining({ endpoint: 'auth:login', limit: 5, windowSeconds: 600, subject: 'pending@example.com' }),
      );
      expect(verifyTurnstile).not.toHaveBeenCalled();
      expect(createPublicClient).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-005 login/resend は保留の Cookie が無ければ 401 で断り、枠を数えない', async () => {
      const { POST } = require('@/app/api/auth/login/resend/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/login/resend', {}));

      expect(res.status).toBe(401);
      expect(enforceRateLimit).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-005 otp/verify は Cookie が無ければ 401 で断り、メール単位の枠を数えない（他人の枠を潰させない）', async () => {
      const { POST } = require('@/app/api/auth/otp/verify/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/otp/verify', { code: '12345678', email: 'victim@example.com' }));

      expect(res.status).toBe(401);
      expect(enforceRateLimit).toHaveBeenCalledTimes(1);
      expect(enforceRateLimit.mock.calls[0][0].subject).toBeUndefined();
      expect(createPublicClient).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-005 otp/verify は Cookie の宛先で 5 回／600 秒の枠を数え、超えたら Retry-After を引き継いで保留の Cookie を捨てる', async () => {
      enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(tooMany());
      const { POST } = require('@/app/api/auth/otp/verify/route') as { POST: Handler };

      const res = await POST(
        request('POST', '/api/auth/otp/verify', { code: '12345678', email: 'victim@example.com' }, pendingCookieHeader('pending@example.com')),
      );

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('600');
      expect(enforceRateLimit.mock.calls[1][0]).toEqual(
        expect.objectContaining({ endpoint: 'auth:otp:verify', limit: 5, windowSeconds: 600, subject: 'pending@example.com' }),
      );
      expect(res.cookies.get('sb-login-2fa-session')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
      expect(createPublicClient).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_email: 'pending@example.com', detail: 'account_rate_limited' }));
    });
  });

  describe('回数の制限の呼び出しが例外を投げたら、記録だけして通す', () => {
    test('ARC-AUTH-005 login は枠の数え場所が落ちても処理を続け、console.error に残す', async () => {
      enforceRateLimit.mockRejectedValue(new Error('counter down'));
      createPublicClient.mockResolvedValue({
        auth: { signInWithPassword: jest.fn().mockResolvedValue({ data: null, error: { message: 'invalid' } }) },
      });
      const { POST } = require('@/app/api/auth/login/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/login', loginBody));

      expect(res.status).toBe(401);
      expect(enforceRateLimit).toHaveBeenCalledTimes(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Rate limit middleware error (login):', expect.any(Error));
      expect(consoleErrorSpy).toHaveBeenCalledWith('Rate limit middleware error (login-account):', expect.any(Error));
    });

    test('ARC-AUTH-005 refresh は枠の数え場所が落ちても処理を続け、Cookie が無ければ 401 を返す', async () => {
      enforceRateLimit.mockRejectedValue(new Error('counter down'));
      const { POST } = require('@/app/api/auth/refresh/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/refresh'));

      expect(res.status).toBe(401);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Rate limit middleware error (refresh):', expect.any(Error));
    });
  });

  describe('回数の制限を置かない窓口', () => {
    test('ARC-AUTH-005 login/cancel は枠を数えず、保留の Cookie を捨てる', async () => {
      const { POST } = require('@/app/api/auth/login/cancel/route') as { POST: Handler };

      const res = await POST(request('POST', '/api/auth/login/cancel', {}, pendingCookieHeader('pending@example.com')));

      expect(res.status).toBe(200);
      expect(enforceRateLimit).not.toHaveBeenCalled();
      expect(res.cookies.get('sb-login-2fa-session')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
    });

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

    test('ARC-AUTH-005 mfa/status は枠を数えない', async () => {
      createClient.mockResolvedValue({});
      authenticateRequest.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
      authFailureResponse.mockReturnValue({ status: 401 });
      const { GET } = require('@/app/api/auth/mfa/status/route') as { GET: Handler };

      const res = await GET(request('GET', '/api/auth/mfa/status'));

      expect(res.status).toBe(401);
      expect(enforceRateLimit).not.toHaveBeenCalled();
    });

    test('ARC-AUTH-005 password-reset/session は枠を数えずに再設定の Cookie の状態を答える', async () => {
      const { GET } = require('@/app/api/auth/password-reset/session/route') as { GET: Handler };

      const res = await GET(request('GET', '/api/auth/password-reset/session'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ready: false, email: null });
      expect(enforceRateLimit).not.toHaveBeenCalled();
    });
  });
});
