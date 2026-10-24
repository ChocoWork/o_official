/**
 * API-AUTH-004: POST /api/auth/login/cancel（保留の Cookie を捨て、保留があった時だけ監査に残す）の結合テスト。
 * 保留の印は本物の署名で作り、監査と回数の制限だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

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

import { createLoginTwoFactorSessionToken } from '@/features/auth/services/login-2fa-session';

/* eslint-disable @typescript-eslint/no-require-imports */
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { logAudit } = require('@/lib/audit');
/* eslint-enable @typescript-eslint/no-require-imports */

const EMAIL = 'member@example.com';
const T0 = 1_800_000_000;

type Handler = (request: Request) => Promise<any>;
let cancelHandler: Handler;
let nowSeconds = T0;

function validToken() {
  return createLoginTwoFactorSessionToken({ userId: 'user-123', email: EMAIL });
}

function buildRequest(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new Request('http://localhost/api/auth/login/cancel', { method: 'POST', headers });
}

describe('API-AUTH-004 POST /api/auth/login/cancel', () => {
  beforeAll(async () => {
    process.env.LOGIN_2FA_SESSION_SECRET = 'api-auth-004-test-secret';
    cancelHandler = (await import('@/app/api/auth/login/cancel/route')).POST as Handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    nowSeconds = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => nowSeconds * 1000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('API-AUTH-004 有効な保留があれば ok=true を no-store で返し、Cookie を空にして消す', async () => {
    const res = await cancelHandler(buildRequest(`sb-login-2fa-session=${validToken()}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.cookies.get('sb-login-2fa-session')).toMatchObject({ value: '', maxAge: 0, path: '/', httpOnly: true });
  });

  test('API-AUTH-004 有効な保留があった時だけ、宛先つきの cancelled を監査に1回残す', async () => {
    await cancelHandler(buildRequest(`sb-login-2fa-session=${validToken()}`));

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'cancelled',
      detail: 'otp_step_abandoned',
    });
  });

  test('API-AUTH-004 Cookie が無くても同じ 200 を返し、監査は残さない', async () => {
    const res = await cancelHandler(buildRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.cookies.get('sb-login-2fa-session')).toMatchObject({ value: '', maxAge: 0 });
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('API-AUTH-004 署名が合わない Cookie でも 200 で消す指示を返すが、監査は残さない（行の水増しを防ぐ）', async () => {
    const res = await cancelHandler(buildRequest(`sb-login-2fa-session=${validToken()}forged`));

    expect(res.status).toBe(200);
    expect(res.cookies.get('sb-login-2fa-session')).toMatchObject({ maxAge: 0 });
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('API-AUTH-004 5分を過ぎた保留でも 200 で消す指示を返すが、監査は残さない', async () => {
    const cookie = `sb-login-2fa-session=${validToken()}`;
    nowSeconds = T0 + 300;

    const res = await cancelHandler(buildRequest(cookie));

    expect(res.status).toBe(200);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('API-AUTH-004 ほかの Cookie と並んでいても、URL エンコードされていても保留を見つけて監査に残す', async () => {
    const encoded = encodeURIComponent(validToken());

    await cancelHandler(buildRequest(`theme=dark; sb-login-2fa-session=${encoded}; cart=abc`));

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_email: EMAIL, outcome: 'cancelled' }));
  });

  test('API-AUTH-004 名前が似ているだけの別の Cookie は保留として扱わない', async () => {
    await cancelHandler(buildRequest(`x-sb-login-2fa-session=${validToken()}`));

    expect(logAudit).not.toHaveBeenCalled();
  });

  test('API-AUTH-004 回数の制限は使わない（CSRF は共有の proxy に任せる）', async () => {
    const withPending = await cancelHandler(buildRequest(`sb-login-2fa-session=${validToken()}`));
    const withoutPending = await cancelHandler(buildRequest());

    expect(withPending.status).toBe(200);
    expect(withoutPending.status).toBe(200);
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });
});
