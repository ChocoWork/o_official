/**
 * API-AUTH-002: POST /api/auth/otp/verify（保留の宛先で確認コードを確かめ、通ったらログインを確定する）の結合テスト。
 * 保留の印は本物の署名で作り、外の依存（Supabase・回数の制限・セッションの保存・注文の紐付け・監査）だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/supabase/server', () => {
  const mockVerifyOtp = jest.fn();
  return {
    createPublicClient: jest.fn(async () => ({ auth: { verifyOtp: mockVerifyOtp } })),
    __mockVerifyOtp: mockVerifyOtp,
  };
});

jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: jest.fn(),
}));

jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: jest.fn(),
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
const { createPublicClient, __mockVerifyOtp } = require('@/lib/supabase/server');
const { persistSessionAndCookies } = require('@/features/auth/services/register');
const { linkGuestOrdersByEmail } = require('@/lib/orders/link-guest-orders');
/* eslint-enable @typescript-eslint/no-require-imports */

const PENDING_EMAIL = 'member@example.com';
const CODE = '12345678';
const USER = {
  id: 'user-123',
  email: PENDING_EMAIL,
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
};
const SESSION = { access_token: 'access', refresh_token: 'refresh' };

type Handler = (request: Request) => Promise<any>;
let verifyHandler: Handler;

function pendingCookie() {
  const token = createLoginTwoFactorSessionToken({ userId: USER.id, email: PENDING_EMAIL });
  return `sb-login-2fa-session=${token}`;
}

function buildRequest(body: unknown, cookie: string | null = pendingCookie()) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request('http://localhost/api/auth/otp/verify', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('API-AUTH-002 POST /api/auth/otp/verify', () => {
  beforeAll(async () => {
    process.env.LOGIN_2FA_SESSION_SECRET = 'api-auth-002-test-secret';
    verifyHandler = (await import('@/app/api/auth/otp/verify/route')).POST as Handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockReset();
    enforceRateLimit.mockResolvedValue(undefined);
    __mockVerifyOtp.mockReset();
    __mockVerifyOtp.mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
    persistSessionAndCookies.mockReset();
    persistSessionAndCookies.mockResolvedValue({ ok: true });
    linkGuestOrdersByEmail.mockReset();
    linkGuestOrdersByEmail.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('API-AUTH-002 200 は user と message を返し、保留の Cookie を空にして消す', async () => {
    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: USER.id, email: PENDING_EMAIL, role: 'user' },
      message: '認証に成功しました。',
    });
    expect(res.cookies.get('sb-login-2fa-session')).toMatchObject({ value: '', maxAge: 0, path: '/' });
  });

  test('API-AUTH-002 確定は セッションの保存 → ゲスト注文の紐付け → 成功の監査 の順で、ゲストの印も保存へ渡す', async () => {
    const cartToken = 'c'.repeat(43);
    const wishlistToken = 'w'.repeat(43);
    const res = await verifyHandler(
      buildRequest({ code: CODE }, `${pendingCookie()}; cart=${cartToken}; wishlist=${wishlistToken}`),
    );

    expect(persistSessionAndCookies).toHaveBeenCalledWith(res, SESSION, USER, { cartToken, wishlistToken });
    expect(linkGuestOrdersByEmail).toHaveBeenCalledWith({
      userId: USER.id,
      email: PENDING_EMAIL,
      emailConfirmedAt: USER.email_confirmed_at,
    });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      actor_email: PENDING_EMAIL,
      outcome: 'success',
      detail: 'verified_type:email',
      resource_id: USER.id,
    });
    const persistOrder = persistSessionAndCookies.mock.invocationCallOrder[0];
    const linkOrder = linkGuestOrdersByEmail.mock.invocationCallOrder[0];
    const auditOrder = logAudit.mock.invocationCallOrder[0];
    expect(persistOrder).toBeLessThan(linkOrder);
    expect(linkOrder).toBeLessThan(auditOrder);
  });

  test('API-AUTH-002 利用者の記録にメールも確認日時も無ければ、保留の宛先と null で紐付ける', async () => {
    __mockVerifyOtp.mockResolvedValue({
      data: { session: SESSION, user: { id: USER.id, email: null } },
      error: null,
    });

    await verifyHandler(buildRequest({ code: CODE }));

    expect(linkGuestOrdersByEmail).toHaveBeenCalledWith({
      userId: USER.id,
      email: PENDING_EMAIL,
      emailConfirmedAt: null,
    });
  });

  test('API-AUTH-002 IP の制限は30回/600秒で、当たれば本文も保留の Cookie も見ずにその応答を返す', async () => {
    const limited = { status: 429 };
    enforceRateLimit.mockResolvedValueOnce(limited);

    const res = await verifyHandler(buildRequest('not json', null));

    expect(res).toBe(limited);
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'auth:otp:verify', limit: 30, windowSeconds: 600 }),
    );
    expect(enforceRateLimit.mock.calls[0][0].subject).toBeUndefined();
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
  });

  test.each([
    ['7桁', { code: '1234567' }],
    ['9桁', { code: '123456789' }],
    ['空', { code: '' }],
    ['code が無い', {}],
    ['数でない型', { code: 12345678 }],
  ])('API-AUTH-002 コードの形の誤り（%s）は 400 で、宛先の制限も Supabase も使わない', async (_label, body) => {
    const res = await verifyHandler(buildRequest(body));

    expect(res.status).toBe(400);
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
    expect(enforceRateLimit.mock.calls.filter((c: unknown[]) => (c[0] as { subject?: string }).subject)).toHaveLength(0);
  });

  test('API-AUTH-002 コードの前後の空白は除いて確かめる', async () => {
    await verifyHandler(buildRequest({ code: `  ${CODE}  ` }));

    expect(__mockVerifyOtp).toHaveBeenCalledWith({ email: PENDING_EMAIL, token: CODE, type: 'email' });
  });

  test('API-AUTH-002 保留の Cookie が無ければ 401 で、コードが正しくても確かめず、宛先を持たない監査を残す', async () => {
    const res = await verifyHandler(buildRequest({ code: CODE }, null));

    expect(res.status).toBe(401);
    expect(createPublicClient).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      outcome: 'failure',
      detail: 'missing_or_invalid_password_session',
    });
  });

  test('API-AUTH-002 署名が合わない保留の Cookie は無いのと同じに扱って 401 にする', async () => {
    const forged = `${pendingCookie()}x`;

    const res = await verifyHandler(buildRequest({ code: CODE }, forged));

    expect(res.status).toBe(401);
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-002 宛先の制限は保留の宛先で5回/600秒、IP の制限より後に数える', async () => {
    await verifyHandler(buildRequest({ code: CODE, email: 'attacker@example.com' }));

    const calls = enforceRateLimit.mock.calls.map((c: unknown[]) => c[0] as { subject?: string; limit: number });
    expect(calls).toHaveLength(2);
    expect(calls[0].subject).toBeUndefined();
    expect(calls[1]).toMatchObject({ endpoint: 'auth:otp:verify', limit: 5, windowSeconds: 600, subject: PENDING_EMAIL });
  });

  test('API-AUTH-002 宛先の上限は 429 で、Retry-After を引き継ぎ、保留の Cookie も消し、確かめに進まない', async () => {
    enforceRateLimit.mockImplementation(async (args: { subject?: string }) =>
      args.subject
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '321' } })
        : undefined,
    );

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('321');
    expect(res.cookies.get('sb-login-2fa-session')).toMatchObject({ value: '', maxAge: 0 });
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      actor_email: PENDING_EMAIL,
      outcome: 'failure',
      detail: 'account_rate_limited',
    });
  });

  test('API-AUTH-002 Retry-After の無い上限の応答でも 429 を返して保留の Cookie を消す', async () => {
    enforceRateLimit.mockImplementation(async (args: { subject?: string }) =>
      args.subject ? new Response('{}', { status: 429 }) : undefined,
    );

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(429);
    expect(res.headers.has('Retry-After')).toBe(false);
    expect(res.cookies.get('sb-login-2fa-session')).toMatchObject({ maxAge: 0 });
  });

  test('API-AUTH-002 回数の制限の部品が落ちたら 500 で止まり、確かめを続けない（SEC-AUTH-013-AC-02）', async () => {
    enforceRateLimit.mockRejectedValue(new Error('limiter down'));

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(500);
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
  });

  test('API-AUTH-002 コードが誤りなら 401 で、保存も紐付けもせず、保留の Cookie は消さない', async () => {
    __mockVerifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Token has expired or is invalid' } });

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(401);
    expect(res.cookies.get('sb-login-2fa-session')).toBeUndefined();
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
    expect(linkGuestOrdersByEmail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      actor_email: PENDING_EMAIL,
      outcome: 'failure',
      detail: 'invalid_or_expired_otp',
    });
  });

  test('API-AUTH-002 エラーが無くても session か user が空なら 401', async () => {
    __mockVerifyOtp.mockResolvedValue({ data: { session: null, user: USER }, error: null });

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(401);
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
  });

  test('API-AUTH-002 確かめの結果が undefined でも例外にせず 401 にする', async () => {
    __mockVerifyOtp.mockResolvedValue({ data: undefined, error: null });

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(401);
  });

  test('API-AUTH-002 セッションの保存に失敗したら 500 で、紐付けも成功の監査もせず error を残す', async () => {
    persistSessionAndCookies.mockResolvedValue({ ok: false, error: 'insert failed' });

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(500);
    expect(linkGuestOrdersByEmail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      actor_email: PENDING_EMAIL,
      outcome: 'error',
      detail: 'session_persist_failed: insert failed',
      resource_id: USER.id,
    });
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });

  test('API-AUTH-002 保存の結果が返らない時も 500 で、理由は unknown と残す', async () => {
    persistSessionAndCookies.mockResolvedValue(undefined);

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(500);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'session_persist_failed: unknown' }));
  });

  test('API-AUTH-002 JSON として読めない本文は 500 を返し、確かめに進まない', async () => {
    const res = await verifyHandler(buildRequest('{broken'));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Internal server error');
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-002 注文の紐付けが例外で落ちたら 500 を返し、成功の監査は残さない', async () => {
    linkGuestOrdersByEmail.mockRejectedValue(new Error('db down'));

    const res = await verifyHandler(buildRequest({ code: CODE }));

    expect(res.status).toBe(500);
    expect(logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success' }));
  });
});
