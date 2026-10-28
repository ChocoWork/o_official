/**
 * DD-AUTH-016 確認コードの再送の窓口の単体テスト。
 * 共有部品（Supabase の client・回数の制限・監査・Cookie・署名の印）は全部差し替え、窓口の分岐だけを通す。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => {
  const mockSignInWithOtp = jest.fn();
  return {
    createPublicClient: jest.fn(async () => ({ auth: { signInWithOtp: mockSignInWithOtp } })),
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
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map<string, string>(),
      cookies: {
        _cookies: [] as Array<Record<string, unknown>>,
        set(cookie: Record<string, unknown>) {
          this._cookies.push(cookie);
        },
        get(name: string) {
          return this._cookies.find((item) => item.name === name);
        },
      },
    }),
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { createPublicClient, __mockSignInWithOtp } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const {
  readLoginTwoFactorSessionFromCookieHeader,
  createLoginTwoFactorSessionToken,
} = require('@/features/auth/services/login-2fa-session');
/* eslint-enable @typescript-eslint/no-require-imports */

import { POST } from '@/app/api/auth/login/resend/route';

const PENDING_EMAIL = 'pending@example.com';
const PENDING_USER_ID = 'user-123';
const PENDING_IAT = 1_700_000_000;
const COOKIE_HEADER = 'sb-login-2fa-session=signed';

const limitedResponse = (status = 429) => ({ status, _body: { error: 'limited' } });

function buildRequest(body?: unknown, cookie: string | null = COOKIE_HEADER) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== null) headers.cookie = cookie;
  return new Request('http://localhost/api/auth/login/resend', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST /api/auth/login/resend (DD-AUTH-016)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockReset();
    enforceRateLimit.mockResolvedValue(undefined);
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue({
      purpose: 'login_2fa',
      userId: PENDING_USER_ID,
      email: PENDING_EMAIL,
      iat: PENDING_IAT,
      exp: PENDING_IAT + 300,
    });
    __mockSignInWithOtp.mockResolvedValue({ error: null });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('DD-AUTH-016 保留ありで 200・no-store・作り直した保留の Cookie・otp_resent の監査を返す', async () => {
    const res: any = await POST(buildRequest());

    expect(res.status).toBe(200);
    expect(res._body).toEqual({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.cookies.get('sb-login-2fa-session')).toEqual({
      name: 'sb-login-2fa-session',
      value: 'refreshed-pending-token',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 300,
    });
    expect(readLoginTwoFactorSessionFromCookieHeader).toHaveBeenCalledWith(COOKIE_HEADER);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: PENDING_EMAIL,
      outcome: 'otp_resent',
      resource_id: PENDING_USER_ID,
    });
  });

  test('DD-AUTH-016 保留のメールへ匿名 client で未登録を作らずに送る', async () => {
    await POST(buildRequest());

    expect(createPublicClient).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithOtp).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithOtp).toHaveBeenCalledWith({
      email: PENDING_EMAIL,
      options: { shouldCreateUser: false },
    });
  });

  test('DD-AUTH-016 宛先は保留から取り、本文の email は見ない', async () => {
    const request = buildRequest({ email: 'attacker@example.com' });
    const jsonSpy = jest.spyOn(request, 'json');

    await POST(request);

    expect(jsonSpy).not.toHaveBeenCalled();
    expect(__mockSignInWithOtp).toHaveBeenCalledWith(expect.objectContaining({ email: PENDING_EMAIL }));
    expect(enforceRateLimit.mock.calls[1][0].subject).toBe(PENDING_EMAIL);
  });

  test('DD-AUTH-016 作り直す保留の印は元の iat と同じ利用者・メールで作り、30 分の上限を延ばさない', async () => {
    await POST(buildRequest());

    expect(createLoginTwoFactorSessionToken).toHaveBeenCalledTimes(1);
    expect(createLoginTwoFactorSessionToken).toHaveBeenCalledWith({
      userId: PENDING_USER_ID,
      email: PENDING_EMAIL,
      issuedAt: PENDING_IAT,
    });
  });

  test('DD-AUTH-016 保留が無い・無効なら 401 で、回数を数えず送らない', async () => {
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue(null);

    const res: any = await POST(buildRequest(undefined, null));

    expect(res.status).toBe(401);
    expect(res._body.error).toEqual(expect.any(String));
    expect(readLoginTwoFactorSessionFromCookieHeader).toHaveBeenCalledWith(null);
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(createPublicClient).not.toHaveBeenCalled();
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('DD-AUTH-016 IP 単位 50 回と宛先単位 5 回の順に、ログインと同じ auth:login の枠で数える', async () => {
    await POST(buildRequest());

    expect(enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(enforceRateLimit.mock.calls[0][0]).toEqual(
      expect.objectContaining({ endpoint: 'auth:login', limit: 50, windowSeconds: 600 }),
    );
    expect(enforceRateLimit.mock.calls[0][0].subject).toBeUndefined();
    expect(enforceRateLimit.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        endpoint: 'auth:login',
        limit: 5,
        windowSeconds: 600,
        subject: PENDING_EMAIL,
      }),
    );
  });

  test('DD-AUTH-016 IP の制限が応答を返したらその応答を返し、宛先の枠は数えず送らない', async () => {
    const limited = limitedResponse();
    enforceRateLimit.mockResolvedValueOnce(limited);

    const res = await POST(buildRequest());

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(createLoginTwoFactorSessionToken).not.toHaveBeenCalled();
  });

  test('DD-AUTH-016 宛先の制限が応答を返したらその応答を返し、送らず保留の Cookie も作り直さない', async () => {
    const limited = limitedResponse();
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);

    const res = await POST(buildRequest());

    expect(res).toBe(limited);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(createLoginTwoFactorSessionToken).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('DD-AUTH-016 制限の呼び出しが投げたら握りつぶさず、送信へ進まない（SEC-AUTH-013-AC-02）', async () => {
    enforceRateLimit.mockRejectedValueOnce(new Error('store down'));

    await expect(POST(buildRequest())).rejects.toThrow('store down');

    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Rate limit middleware error'),
      expect.anything(),
    );
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-016 宛先の制限が投げたら握りつぶさず、送信へ進まない（SEC-AUTH-013-AC-02）', async () => {
    enforceRateLimit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('store down'));

    await expect(POST(buildRequest())).rejects.toThrow('store down');

    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-016 送信が誤りなら 500 と otp_resend_failed の監査。保留の Cookie は作り直さない', async () => {
    __mockSignInWithOtp.mockResolvedValue({ error: { message: 'smtp down' } });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(res._body.error).toEqual(expect.any(String));
    expect(res.cookies._cookies).toHaveLength(0);
    expect(res.headers.has('Cache-Control')).toBe(false);
    expect(createLoginTwoFactorSessionToken).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: PENDING_EMAIL,
      outcome: 'error',
      detail: 'otp_resend_failed: smtp down',
      resource_id: PENDING_USER_ID,
    });
  });
});
