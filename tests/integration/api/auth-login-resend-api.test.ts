/**
 * API-AUTH-003: POST /api/auth/login/resend（保留の宛先にだけ確認コードを送り直し、保留の寿命を戻す）の結合テスト。
 * 保留の印は本物の署名で作り、外の依存（Supabase・回数の制限・監査）だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/auth/service-role-auth-client', () => {
  const mockSignInWithOtp = jest.fn();
  return {
    ...jest.requireActual('@/lib/auth/service-role-auth-client'),
    createServiceRoleAuthClient: jest.fn(async () => ({ auth: { signInWithOtp: mockSignInWithOtp } })),
    __mockSignInWithOtp: mockSignInWithOtp,
  };
});

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const cookieJar: Array<Record<string, unknown>> = [];
      return {
        status: init?.status ?? 200,
        json: async () => body,
        headers: new Map<string, string>(),
        cookies: {
          set(c: Record<string, unknown>) {
            cookieJar.push(c);
          },
          get(name: string) {
            return cookieJar.find((item) => item.name === name);
          },
          all: () => cookieJar,
        },
      };
    },
  },
}));

import {
  createLoginTwoFactorSessionToken,
  verifyLoginTwoFactorSessionToken,
} from '@/features/auth/services/login-2fa-session';

/* eslint-disable @typescript-eslint/no-require-imports */
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { logAudit } = require('@/lib/audit');
const { createServiceRoleAuthClient, __mockSignInWithOtp } = require('@/lib/auth/service-role-auth-client');
/* eslint-enable @typescript-eslint/no-require-imports */

const EMAIL = 'member@example.com';
const USER_ID = 'user-123';
const T0 = 1_800_000_000; // 秒。固定した「いま」

type Handler = (request: Request) => Promise<any>;
let resendHandler: Handler;
let nowSeconds = T0;

function tokenAt(issuedAt: number, issuedNow = nowSeconds) {
  const spy = jest.spyOn(Date, 'now').mockReturnValue(issuedNow * 1000);
  const token = createLoginTwoFactorSessionToken({ userId: USER_ID, email: EMAIL, issuedAt });
  spy.mockImplementation(() => nowSeconds * 1000);
  return token;
}

function buildRequest(cookie: string | null, body?: BodyInit) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request('http://localhost/api/auth/login/resend', { method: 'POST', headers, body });
}

describe('API-AUTH-003 POST /api/auth/login/resend', () => {
  beforeAll(async () => {
    process.env.LOGIN_2FA_SESSION_SECRET = 'api-auth-003-test-secret';
    resendHandler = (await import('@/app/api/auth/login/resend/route')).POST as Handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    nowSeconds = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => nowSeconds * 1000);
    enforceRateLimit.mockReset();
    enforceRateLimit.mockResolvedValue(undefined);
    __mockSignInWithOtp.mockReset();
    __mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('API-AUTH-003 200 は ok=true を no-store で返し、保留の宛先に新しい利用者を作らない設定で送る', async () => {
    const cookie = `sb-login-2fa-session=${tokenAt(T0 - 60)}`;

    const res = await resendHandler(buildRequest(cookie));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(createServiceRoleAuthClient).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithOtp).toHaveBeenCalledWith({ email: EMAIL, options: { shouldCreateUser: false } });
  });

  test('API-AUTH-003 保留の Cookie が無ければ 401 で、制限も送信も行わない', async () => {
    const res = await resendHandler(buildRequest(null));

    expect(res.status).toBe(401);
    expect(enforceRateLimit).not.toHaveBeenCalled();
    expect(createServiceRoleAuthClient).not.toHaveBeenCalled();
    expect(res.cookies.all()).toHaveLength(0);
  });

  test('API-AUTH-003 署名が壊れた保留の Cookie は 401 で、メールを送らない', async () => {
    const res = await resendHandler(buildRequest(`sb-login-2fa-session=${tokenAt(T0)}tampered`));

    expect(res.status).toBe(401);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-003 5分を過ぎた保留の Cookie は 401', async () => {
    const cookie = `sb-login-2fa-session=${tokenAt(T0)}`;
    nowSeconds = T0 + 300;

    const res = await resendHandler(buildRequest(cookie));

    expect(res.status).toBe(401);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-003 本文は読まない（壊れた本文でも、別の email を入れても保留の宛先に送る）', async () => {
    const cookie = `sb-login-2fa-session=${tokenAt(T0)}`;

    const broken = await resendHandler(buildRequest(cookie, '{broken'));
    const spoofed = await resendHandler(buildRequest(cookie, JSON.stringify({ email: 'victim@example.com' })));

    expect(broken.status).toBe(200);
    expect(spoofed.status).toBe(200);
    expect(__mockSignInWithOtp).toHaveBeenCalledTimes(2);
    for (const call of __mockSignInWithOtp.mock.calls) {
      expect(call[0].email).toBe(EMAIL);
    }
  });

  test('API-AUTH-003 制限は保留の Cookie の後に、ログインと同じ枠で IP 50回/600秒 → 宛先 5回/600秒の順に数える', async () => {
    const cookie = `sb-login-2fa-session=${tokenAt(T0)}`;

    await resendHandler(buildRequest(cookie));

    const calls = enforceRateLimit.mock.calls.map((c: unknown[]) => c[0] as { subject?: string });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ endpoint: 'auth:login', limit: 50, windowSeconds: 600 });
    expect(calls[0].subject).toBeUndefined();
    expect(calls[1]).toMatchObject({ endpoint: 'auth:login', limit: 5, windowSeconds: 600, subject: EMAIL });
  });

  test('API-AUTH-003 IP の制限に当たればその応答を返し、メールを送らず Cookie も延ばさない', async () => {
    const limited = { status: 429 };
    enforceRateLimit.mockResolvedValueOnce(limited);

    const res = await resendHandler(buildRequest(`sb-login-2fa-session=${tokenAt(T0)}`));

    expect(res).toBe(limited);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
  });

  test('API-AUTH-003 宛先の制限に当たればその応答を返し、メールを送らない', async () => {
    const limited = { status: 429 };
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);

    const res = await resendHandler(buildRequest(`sb-login-2fa-session=${tokenAt(T0)}`));

    expect(res).toBe(limited);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-003 回数の制限の部品が落ちたら握りつぶさず、送り直さない（SEC-AUTH-013-AC-02）', async () => {
    enforceRateLimit.mockRejectedValue(new Error('limiter down'));

    await expect(resendHandler(buildRequest(`sb-login-2fa-session=${tokenAt(T0)}`))).rejects.toThrow('limiter down');

    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-003 保留の Cookie を、元の iat のまま寿命だけ5分に戻して作り直す', async () => {
    const issuedAt = T0 - 600;
    const cookie = `sb-login-2fa-session=${tokenAt(issuedAt, T0 - 200)}`;

    const res = await resendHandler(buildRequest(cookie));

    const renewed = res.cookies.get('sb-login-2fa-session');
    expect(renewed).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/', maxAge: 300 });
    const pending = verifyLoginTwoFactorSessionToken(renewed.value);
    expect(pending).toMatchObject({ userId: USER_ID, email: EMAIL, iat: issuedAt, exp: T0 + 300 });
  });

  test('API-AUTH-003 送信に失敗したら 500 で、Cookie を作り直さず error を監査に残す', async () => {
    __mockSignInWithOtp.mockResolvedValue({ data: {}, error: { message: 'smtp down' } });

    const res = await resendHandler(buildRequest(`sb-login-2fa-session=${tokenAt(T0)}`));

    expect(res.status).toBe(500);
    expect(res.cookies.all()).toHaveLength(0);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'error',
      detail: 'otp_resend_failed: smtp down',
      resource_id: USER_ID,
    });
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'otp_resent' }));
  });

  test('API-AUTH-003 成功は otp_resent として監査に残す', async () => {
    await resendHandler(buildRequest(`sb-login-2fa-session=${tokenAt(T0)}`));

    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'otp_resent',
      resource_id: USER_ID,
    });
  });
});
