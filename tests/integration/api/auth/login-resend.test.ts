/**
 * Login Resend API Integration Tests
 * 対応 REQ: FREQ-334-REQ-05（再送をパスワード不要にし、宛先を Cookie 由来にする）
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => {
  const mockSignInWithOtp = jest.fn();
  return {
    createPublicClient: jest.fn(async () => ({
      auth: { signInWithOtp: mockSignInWithOtp },
    })),
    __mockSignInWithOtp: mockSignInWithOtp,
  };
});

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/services/login-2fa-session', () => ({
  readLoginTwoFactorSessionFromCookieHeader: jest.fn(),
  createLoginTwoFactorSessionToken: jest.fn(() => 'refreshed-pending-token'),
  loginTwoFactorSessionMaxAgeSeconds: 300,
}));

jest.mock('@/lib/cookie', () => ({
  loginTwoFactorSessionCookieName: 'sb-login-2fa-session',
  cookieOptionsForLoginTwoFactor: jest.fn((maxAge: number) => ({
    httpOnly: true,
    secure: true,
    sameSite: 'strict' as const,
    path: '/',
    maxAge,
  })),
}));

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
          set(c: any) {
            this._cookies.push(c);
          },
          get(name: string) {
            return this._cookies.find((item: any) => item.name === name);
          },
        },
      };
      return res;
    },
  },
}));

const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { __mockSignInWithOtp } = require('@/lib/supabase/server');
const {
  readLoginTwoFactorSessionFromCookieHeader,
  createLoginTwoFactorSessionToken,
} = require('@/features/auth/services/login-2fa-session');

let resendHandler: any;

const PENDING_EMAIL = 'test@example.com';
const PENDING_IAT = Math.floor(Date.now() / 1000) - 120;

function buildRequest(body?: unknown) {
  return new Request('http://localhost/api/auth/login/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'sb-login-2fa-session=whatever',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST /api/auth/login/resend - Integration Tests', () => {
  beforeAll(async () => {
    resendHandler = (await import('@/app/api/auth/login/resend/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    __mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue({
      purpose: 'login_2fa',
      userId: 'user-123',
      email: PENDING_EMAIL,
      iat: PENDING_IAT,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
  });

  test('[SECURITY] 宛先は Cookie 由来で、本文の email を無視する', async () => {
    // 本文の宛先を信じると、他人の宛先へ当社ドメインからメールを送らせる導線になる。
    const res: any = await resendHandler(
      buildRequest({ email: 'attacker@example.com' }),
    );

    expect(res.status).toBe(200);
    expect(__mockSignInWithOtp).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithOtp).toHaveBeenCalledWith({
      email: PENDING_EMAIL,
      options: { shouldCreateUser: false },
    });
  });

  test('[SECURITY] 2FA Cookie が無ければ 401 で、メールを送らない', async () => {
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue(null);

    const res: any = await resendHandler(buildRequest());

    expect(res.status).toBe(401);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('[SECURITY] レート制限の枠を /api/auth/login と共有する', async () => {
    await resendHandler(buildRequest());

    const calls = enforceRateLimit.mock.calls.map((c: any[]) => c[0]);
    const accountCall = calls.find((c: any) => c.subject);

    // 枠を分けると、ログイン 5 通 + 再送 5 通で 10 通送れてしまう。
    expect(accountCall).toBeDefined();
    expect(accountCall.endpoint).toBe('auth:login');
    expect(accountCall.subject).toBe(PENDING_EMAIL);
    expect(accountCall.limit).toBe(5);
    expect(accountCall.windowSeconds).toBe(600);
  });

  test('[SECURITY] IP 単位の制限も掛ける（/api/auth/login と同じ二段）', async () => {
    await resendHandler(buildRequest());

    const calls = enforceRateLimit.mock.calls.map((c: any[]) => c[0]);
    const ipCall = calls.find((c: any) => !c.subject);

    expect(ipCall).toBeDefined();
    expect(ipCall.endpoint).toBe('auth:login');
    expect(ipCall.limit).toBe(50);
    expect(ipCall.windowSeconds).toBe(600);
  });

  test('[SECURITY] IP 単位が上限ならメールを送らない', async () => {
    enforceRateLimit.mockImplementation(async (args: any) =>
      args.subject
        ? undefined
        : new Response(JSON.stringify({ error: 'Too many requests' }), {
            status: 429,
          }),
    );

    const res: any = await resendHandler(buildRequest());

    expect(res.status).toBe(429);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('[SECURITY] 再発行トークンは元の iat を引き継ぐ', async () => {
    // 引き継がないと絶対上限の起点がリセットされ、再送を繰り返す限り
    // 保留状態を延ばせてしまう。
    await resendHandler(buildRequest());

    expect(createLoginTwoFactorSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({ issuedAt: PENDING_IAT }),
    );
  });

  test('[SUCCESS] 成功時に 2FA Cookie を再発行して期限を延ばす', async () => {
    const res: any = await resendHandler(buildRequest());

    const cookie = res.cookies.get('sb-login-2fa-session');
    expect(cookie).toBeDefined();
    expect(cookie.value).toBe('refreshed-pending-token');
    expect(cookie.maxAge).toBe(300);
  });

  test('[ERROR] 送信に失敗したら 500 で、Cookie を延ばさない', async () => {
    __mockSignInWithOtp.mockResolvedValue({
      data: null,
      error: { message: 'smtp down' },
    });

    const res: any = await resendHandler(buildRequest());

    expect(res.status).toBe(500);
    expect(res.cookies.get('sb-login-2fa-session')).toBeUndefined();
  });
});

// このファイルをモジュールとして扱わせる（他テストとの const 名衝突を防ぐ）。
export {};
