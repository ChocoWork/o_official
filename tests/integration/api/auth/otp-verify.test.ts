/**
 * OTP Verify API Integration Tests
 * 対応 REQ: FREQ-335（総当たり耐性と、検証するトークンの用途の限定）
 */

// Mock rate limit middleware（呼び出し引数を記録できるようにする）
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

// Mock Supabase service role client（verifyOtp の呼ばれ方を見る）
jest.mock('@/lib/supabase/server', () => {
  const mockVerifyOtp = jest.fn();
  return {
    createServiceRoleClient: jest.fn(async () => ({
      auth: { verifyOtp: mockVerifyOtp },
    })),
    __mockVerifyOtp: mockVerifyOtp,
  };
});

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/services/login-2fa-session', () => ({
  readLoginTwoFactorSessionFromCookieHeader: jest.fn(),
}));

jest.mock('@/lib/cookie', () => ({
  loginTwoFactorSessionCookieName: 'sb-login-2fa-session',
  clearCookieOptions: jest.fn(() => ({ path: '/', maxAge: 0 })),
}));

jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined),
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
const { __mockVerifyOtp } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const {
  readLoginTwoFactorSessionFromCookieHeader,
} = require('@/features/auth/services/login-2fa-session');

let otpVerifyHandler: any;

const PENDING_EMAIL = 'test@example.com';
const VALID_CODE = '12345678';

const fakeUser = {
  id: 'user-123',
  email: PENDING_EMAIL,
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
};
const fakeSession = {
  access_token: 'access',
  refresh_token: 'refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
};

function buildOtpRequest(code = VALID_CODE, extra?: Record<string, unknown>) {
  return new Request('http://localhost/api/auth/otp/verify', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'sb-login-2fa-session=whatever',
    },
    body: JSON.stringify({ code, ...extra }),
  });
}

describe('POST /api/auth/otp/verify - Integration Tests', () => {
  beforeAll(async () => {
    otpVerifyHandler = (await import('@/app/api/auth/otp/verify/route')).POST;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue({
      purpose: 'login_2fa',
      userId: 'user-123',
      email: PENDING_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    __mockVerifyOtp.mockResolvedValue({
      data: { session: fakeSession, user: fakeUser },
      error: null,
    });
  });

  test('[SECURITY] verifyOtp は type: email で 1 回だけ呼ばれる', async () => {
    const res: any = await otpVerifyHandler(buildOtpRequest());

    expect(res.status).toBe(200);
    expect(__mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(__mockVerifyOtp).toHaveBeenCalledWith({
      email: PENDING_EMAIL,
      token: VALID_CODE,
      type: 'email',
    });
  });

  test('[SECURITY] 本文に email を混ぜても宛先の判定に影響しない', async () => {
    // 宛先の判定材料をクライアントから受け取らない。偽装しうる入力そのものを無くす。
    const res: any = await otpVerifyHandler(
      buildOtpRequest(VALID_CODE, { email: 'attacker@example.com' }),
    );

    expect(res.status).toBe(200);
    expect(__mockVerifyOtp).toHaveBeenCalledWith({
      email: PENDING_EMAIL,
      token: VALID_CODE,
      type: 'email',
    });
  });

  test('[SECURITY] アカウント単位の制限は Cookie 由来の宛先で 5 回 / 600 秒', async () => {
    await otpVerifyHandler(buildOtpRequest());

    const calls = enforceRateLimit.mock.calls.map((c: any[]) => c[0]);
    const accountCall = calls.find((c: any) => c.subject);

    expect(accountCall).toBeDefined();
    expect(accountCall.subject).toBe(PENDING_EMAIL);
    expect(accountCall.endpoint).toBe('auth:otp:verify');
    expect(accountCall.limit).toBe(5);
    expect(accountCall.windowSeconds).toBe(600);
  });

  test('[SECURITY] Cookie が無効ならアカウント単位の枠を消費しない', async () => {
    // 制限が Cookie 検証より前にあると、Cookie を持たない相手が
    // 他人のアカウントの枠を故意に潰せる。
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue(null);

    const res: any = await otpVerifyHandler(buildOtpRequest());

    expect(res.status).toBe(401);
    const calls = enforceRateLimit.mock.calls.map((c: any[]) => c[0]);
    expect(calls.filter((c: any) => c.subject)).toHaveLength(0);
  });

  test('[SECURITY] 上限到達で 429 を返し、2FA Cookie を破棄する', async () => {
    enforceRateLimit.mockImplementation(async (args: any) =>
      args.subject
        ? new Response(JSON.stringify({ error: 'Too many requests' }), {
            status: 429,
            headers: { 'Retry-After': '600' },
          })
        : undefined,
    );

    const res: any = await otpVerifyHandler(buildOtpRequest());

    expect(res.status).toBe(429);
    expect(__mockVerifyOtp).not.toHaveBeenCalled();

    const cleared = res.cookies.get('sb-login-2fa-session');
    expect(cleared).toBeDefined();
    expect(cleared.maxAge).toBe(0);

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.otp.verify',
        outcome: 'failure',
        detail: 'account_rate_limited',
      }),
    );
  });

  test('[ERROR] コードが誤っていれば 401', async () => {
    __mockVerifyOtp.mockResolvedValue({
      data: null,
      error: { message: 'invalid otp' },
    });

    const res: any = await otpVerifyHandler(buildOtpRequest('87654321'));

    expect(res.status).toBe(401);
  });

  test('[SECURITY] 失敗しても他の type へ総当たりしない', async () => {
    // 総当たりは 1 回の入力で Supabase 側の検証を最大 3 回消費し、
    // signup / magiclink など別目的のトークンまで第 2 要素として受理しうる。
    __mockVerifyOtp.mockResolvedValue({
      data: null,
      error: { message: 'invalid otp' },
    });

    await otpVerifyHandler(buildOtpRequest('87654321'));

    expect(__mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(__mockVerifyOtp).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'email' }),
    );
  });
});

// このファイルをモジュールとして扱わせる（他テストとの const 名衝突を防ぐ）。
export {};
