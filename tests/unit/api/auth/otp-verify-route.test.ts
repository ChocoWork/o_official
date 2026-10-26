/**
 * DD-AUTH-015 ログインの2段目の窓口の単体テスト。
 * 共有部品（Supabase の client・回数の制限・監査・Cookie・署名の印・セッションの保存・ゲスト注文の紐付け）は
 * 全部差し替え、窓口の分岐だけを通す。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => {
  const mockVerifyOtp = jest.fn();
  return {
    createPublicClient: jest.fn(async () => ({ auth: { verifyOtp: mockVerifyOtp } })),
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
  persistSessionAndCookies: jest.fn(),
}));

jest.mock('@/features/cart/services/guest-shopping-token', () => ({
  readGuestShoppingTokens: jest.fn(() => ({ cart: 'cart-token', wishlist: 'wishlist-token' })),
}));

jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined),
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
const { createPublicClient, __mockVerifyOtp } = require('@/lib/supabase/server');
const { logAudit } = require('@/lib/audit');
const { readLoginTwoFactorSessionFromCookieHeader } = require('@/features/auth/services/login-2fa-session');
const { persistSessionAndCookies } = require('@/features/auth/services/register');
const { readGuestShoppingTokens } = require('@/features/cart/services/guest-shopping-token');
const { linkGuestOrdersByEmail } = require('@/lib/orders/link-guest-orders');
/* eslint-enable @typescript-eslint/no-require-imports */

import { POST } from '@/app/api/auth/otp/verify/route';

const PENDING_EMAIL = 'pending@example.com';
const CODE = '12345678';
const COOKIE_HEADER = 'sb-login-2fa-session=signed; cart=c; wishlist=w';

const fakeSession = { access_token: 'access', refresh_token: 'refresh' };
const fakeUser = {
  id: 'user-123',
  email: 'verified@example.com',
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
};

const limitedResponse = (retryAfter?: string, status = 429) => ({
  status,
  headers: new Map<string, string>(retryAfter ? [['Retry-After', retryAfter]] : []),
});

function buildRequest(body: unknown = { code: CODE }, cookie: string | null = COOKIE_HEADER) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== null) headers.cookie = cookie;
  return new Request('http://localhost/api/auth/otp/verify', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/auth/otp/verify (DD-AUTH-015)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockReset();
    enforceRateLimit.mockResolvedValue(undefined);
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue({
      purpose: 'login_2fa',
      userId: 'user-123',
      email: PENDING_EMAIL,
      iat: 1,
      exp: 2,
    });
    __mockVerifyOtp.mockResolvedValue({ data: { session: fakeSession, user: fakeUser }, error: null });
    persistSessionAndCookies.mockResolvedValue({ ok: true });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('DD-AUTH-015 正しいコードで 200・保留の Cookie の消去・保存・紐付け・success の監査を返す', async () => {
    const res: any = await POST(buildRequest());

    expect(res.status).toBe(200);
    expect(res._body).toEqual({
      user: { id: 'user-123', email: 'verified@example.com', role: 'user' },
      message: '認証に成功しました。',
    });
    expect(res.cookies.get('sb-login-2fa-session')).toEqual({
      name: 'sb-login-2fa-session',
      value: '',
      path: '/',
      maxAge: 0,
    });
    expect(readGuestShoppingTokens).toHaveBeenCalledWith(COOKIE_HEADER);
    expect(persistSessionAndCookies).toHaveBeenCalledWith(res, fakeSession, fakeUser, {
      cart: 'cart-token',
      wishlist: 'wishlist-token',
    });
    expect(linkGuestOrdersByEmail).toHaveBeenCalledWith({
      userId: 'user-123',
      email: 'verified@example.com',
      emailConfirmedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      actor_email: 'verified@example.com',
      outcome: 'success',
      detail: 'verified_type:email',
      resource_id: 'user-123',
    });
  });

  test('DD-AUTH-015 IP 単位 30 回と保留の宛先単位 5 回の順に auth:otp:verify の制限を数える', async () => {
    await POST(buildRequest());

    expect(enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(enforceRateLimit.mock.calls[0][0]).toEqual(
      expect.objectContaining({ endpoint: 'auth:otp:verify', limit: 30, windowSeconds: 600 }),
    );
    expect(enforceRateLimit.mock.calls[0][0].subject).toBeUndefined();
    expect(enforceRateLimit.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        endpoint: 'auth:otp:verify',
        limit: 5,
        windowSeconds: 600,
        subject: PENDING_EMAIL,
      }),
    );
  });

  test('DD-AUTH-015 IP の制限が応答を返したらその応答をそのまま返し、本文も保留も読まない', async () => {
    const limited = limitedResponse();
    enforceRateLimit.mockResolvedValueOnce(limited);
    const request = buildRequest();
    const jsonSpy = jest.spyOn(request, 'json');

    const res = await POST(request);

    expect(res).toBe(limited);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(readLoginTwoFactorSessionFromCookieHeader).not.toHaveBeenCalled();
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 IP の制限の呼び出しが投げても記録して先へ進む', async () => {
    enforceRateLimit.mockRejectedValueOnce(new Error('store down'));

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Rate limit middleware error (otp verify):', expect.any(Error));
  });

  test('DD-AUTH-015 形が合わないコードは 400 で、保留も確かめも読まない', async () => {
    const res: any = await POST(buildRequest({ code: '123' }));

    expect(res.status).toBe(400);
    expect(res._body.code).toBe('validation_error');
    expect(res._body.detail[0].path).toBe('code');
    expect(readLoginTwoFactorSessionFromCookieHeader).not.toHaveBeenCalled();
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 保留の Cookie が無い・無効なら 401 と missing_or_invalid_password_session の監査。宛先の枠は数えない', async () => {
    readLoginTwoFactorSessionFromCookieHeader.mockReturnValue(null);

    const res: any = await POST(buildRequest(undefined, null));

    expect(res.status).toBe(401);
    expect(res._body.error).toEqual(expect.any(String));
    expect(readLoginTwoFactorSessionFromCookieHeader).toHaveBeenCalledWith(null);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      outcome: 'failure',
      detail: 'missing_or_invalid_password_session',
    });
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 宛先単位の上限で 429 を作り直し、Retry-After を写して保留の Cookie を消す', async () => {
    const original = limitedResponse('42');
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(original);

    const res: any = await POST(buildRequest());

    expect(res).not.toBe(original);
    expect(res.status).toBe(429);
    expect(res._body).toEqual({ error: 'Too many requests' });
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(res.cookies.get('sb-login-2fa-session')).toEqual({
      name: 'sb-login-2fa-session',
      value: '',
      path: '/',
      maxAge: 0,
    });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      actor_email: PENDING_EMAIL,
      outcome: 'failure',
      detail: 'account_rate_limited',
    });
    expect(__mockVerifyOtp).not.toHaveBeenCalled();
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 宛先単位の上限で Retry-After が無ければ付けずに 429 を返す', async () => {
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limitedResponse());

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(429);
    expect(res.headers.has('Retry-After')).toBe(false);
    expect(res.cookies.get('sb-login-2fa-session')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
  });

  test('DD-AUTH-015 数え場所の障害の 503 も 429 に変えて保留の Cookie を消す', async () => {
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limitedResponse('5', 503));

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(res.cookies.get('sb-login-2fa-session')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'account_rate_limited' }));
  });

  test('DD-AUTH-015 宛先単位の制限の呼び出しが投げても記録して先へ進む', async () => {
    enforceRateLimit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('store down'));

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(200);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Rate limit middleware error (otp verify account):', expect.any(Error));
  });

  test('DD-AUTH-015 本文に別の email を書いても、確かめと数えは保留のメールで行い type email の 1 回だけ', async () => {
    await POST(buildRequest({ code: CODE, email: 'attacker@example.com' }));

    expect(createPublicClient).toHaveBeenCalledTimes(1);
    expect(__mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(__mockVerifyOtp).toHaveBeenCalledWith({ email: PENDING_EMAIL, token: CODE, type: 'email' });
    expect(enforceRateLimit.mock.calls[1][0].subject).toBe(PENDING_EMAIL);
  });

  test('DD-AUTH-015 確かめが誤りなら 401 と invalid_or_expired_otp の監査。保留の Cookie は消さない', async () => {
    __mockVerifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Token has expired' } });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(401);
    expect(res._body).toEqual({ error: '認証コードが無効、または期限切れです。' });
    expect(res.cookies._cookies).toHaveLength(0);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      actor_email: PENDING_EMAIL,
      outcome: 'failure',
      detail: 'invalid_or_expired_otp',
    });
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
    expect(linkGuestOrdersByEmail).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 誤りが無くても session が無ければ 401 を返す', async () => {
    __mockVerifyOtp.mockResolvedValue({ data: { session: null, user: fakeUser }, error: null });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(401);
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 誤りが無くても user が無ければ 401 を返す', async () => {
    __mockVerifyOtp.mockResolvedValue({ data: { session: fakeSession, user: null }, error: null });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(401);
    expect(persistSessionAndCookies).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 誤りも data も無い応答でも 401 を返す', async () => {
    __mockVerifyOtp.mockResolvedValue({ data: null, error: null });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(401);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'invalid_or_expired_otp' }));
  });

  test('DD-AUTH-015 セッションの保存が失敗なら 500 と session_persist_failed の監査（理由あり）。紐付けは呼ばない', async () => {
    persistSessionAndCookies.mockResolvedValue({ ok: false, error: 'db_insert_failed' });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'ログイン処理に失敗しました。' });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'auth.otp.verify',
      actor_email: 'verified@example.com',
      outcome: 'error',
      detail: 'session_persist_failed: db_insert_failed',
      resource_id: 'user-123',
    });
    expect(linkGuestOrdersByEmail).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 保存が失敗で理由が無ければ unknown を監査に残す', async () => {
    persistSessionAndCookies.mockResolvedValue({ ok: false });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'session_persist_failed: unknown' }));
  });

  test('DD-AUTH-015 成功の本文の user は id・email・role の 3 つだけで、Supabase の記録を載せない', async () => {
    __mockVerifyOtp.mockResolvedValue({
      data: {
        session: fakeSession,
        user: {
          ...fakeUser,
          aud: 'authenticated',
          phone: '+81900000000',
          app_metadata: { provider: 'email', role: 'admin' },
          user_metadata: { name: 'Taro' },
          identities: [{ identity_id: 'i-1' }],
        },
      },
      error: null,
    });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(200);
    expect(Object.keys(res._body.user).sort()).toEqual(['email', 'id', 'role']);
    expect(res._body.user.role).toBe('admin');
    expect(Object.keys(res._body).sort()).toEqual(['message', 'user']);
    expect(JSON.stringify(res._body)).not.toMatch(/app_metadata|user_metadata|identities|phone|aud|access|refresh/);
  });

  test.each([
    ['supporter', 'supporter'],
    [undefined, 'user'],
    ['user', 'user'],
    ['owner', 'user'],
    [1, 'user'],
  ])('DD-AUTH-015 app_metadata.role が %p なら role は %s', async (rawRole, expected) => {
    __mockVerifyOtp.mockResolvedValue({
      data: {
        session: fakeSession,
        user: { ...fakeUser, app_metadata: rawRole === undefined ? {} : { role: rawRole } },
      },
      error: null,
    });

    const res: any = await POST(buildRequest());

    expect(res._body.user.role).toBe(expected);
  });

  test('DD-AUTH-015 app_metadata が無い利用者の role は user', async () => {
    __mockVerifyOtp.mockResolvedValue({ data: { session: fakeSession, user: { id: 'user-123', email: 'a@example.com' } }, error: null });

    const res: any = await POST(buildRequest());

    expect(res._body.user).toEqual({ id: 'user-123', email: 'a@example.com', role: 'user' });
  });

  test('DD-AUTH-015 保存の結果が無い時も 500 と unknown を監査に残す', async () => {
    persistSessionAndCookies.mockResolvedValue(undefined);

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'session_persist_failed: unknown' }));
    expect(linkGuestOrdersByEmail).not.toHaveBeenCalled();
  });

  test('DD-AUTH-015 保存が失敗で利用者のメールが無ければ保留のメールを監査に使う', async () => {
    __mockVerifyOtp.mockResolvedValue({
      data: { session: fakeSession, user: { id: 'user-123', email: undefined } },
      error: null,
    });
    persistSessionAndCookies.mockResolvedValue({ ok: false, error: 'x' });

    await POST(buildRequest());

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ actor_email: PENDING_EMAIL, outcome: 'error' }));
  });

  test('DD-AUTH-015 利用者のメール・確認の時刻が無ければ保留のメールと null を紐付けと監査に使う', async () => {
    __mockVerifyOtp.mockResolvedValue({
      data: { session: fakeSession, user: { id: 'user-123' } },
      error: null,
    });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(200);
    expect(linkGuestOrdersByEmail).toHaveBeenCalledWith({
      userId: 'user-123',
      email: PENDING_EMAIL,
      emailConfirmedAt: null,
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actor_email: PENDING_EMAIL, outcome: 'success', resource_id: 'user-123' }),
    );
  });

  test('DD-AUTH-015 本文が JSON でないと 500 Internal server error', async () => {
    const res: any = await POST(buildRequest('{not json'));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(consoleErrorSpy).toHaveBeenCalledWith('OTP verify handler error:', expect.anything());
  });

  test('DD-AUTH-015 紐付けが投げても 500 Internal server error にする', async () => {
    linkGuestOrdersByEmail.mockRejectedValueOnce(new Error('link failed'));

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
  });
});
