/**
 * DD-AUTH-014 ログインの1段目の窓口の単体テスト。
 * 共有部品（Supabase の client・回数の制限・Turnstile・監査・Cookie・署名の印）は全部差し替え、窓口の分岐だけを通す。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: jest.fn(),
}));

jest.mock('@/lib/supabase/server', () => ({
  createPublicClient: jest.fn(),
}));

jest.mock('@/lib/auth/service-role-auth-client', () => {
  const mockSignInWithPassword = jest.fn();
  const mockSignInWithOtp = jest.fn();
  return {
    ...jest.requireActual('@/lib/auth/service-role-auth-client'),
    createServiceRoleAuthClient: jest.fn(async () => ({
      auth: { signInWithPassword: mockSignInWithPassword, signInWithOtp: mockSignInWithOtp },
    })),
    __mockSignInWithPassword: mockSignInWithPassword,
    __mockSignInWithOtp: mockSignInWithOtp,
  };
});

jest.mock('@/lib/audit', () => {
  const logAudit = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: logAudit, logAudit };
});

jest.mock('@/features/auth/return-intent/return-intent-store', () => ({
  ...jest.requireActual('@/features/auth/return-intent/return-intent-store'),
  createReturnIntent: jest.fn(),
}));

jest.mock('@/features/auth/services/login-2fa-session', () => ({
  createLoginTwoFactorSessionToken: jest.fn(() => 'signed-pending-token'),
  loginTwoFactorSessionMaxAgeSeconds: 300,
}));

jest.mock('@/lib/cookie', () => ({
  ...jest.requireActual('@/lib/cookie'),
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
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      _body: body,
      json: async () => body,
      headers: new Map<string, string>(Object.entries(init?.headers ?? {})),
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
const { verifyTurnstile } = require('@/lib/turnstile');
const { createPublicClient } = require('@/lib/supabase/server');
const {
  createServiceRoleAuthClient,
  __mockSignInWithPassword,
  __mockSignInWithOtp,
} = require('@/lib/auth/service-role-auth-client');
const { logAudit } = require('@/lib/audit');
const { createReturnIntent } = require('@/features/auth/return-intent/return-intent-store');
const { createLoginTwoFactorSessionToken } = require('@/features/auth/services/login-2fa-session');
/* eslint-enable @typescript-eslint/no-require-imports */

import { POST } from '@/app/api/auth/login/route';

const EMAIL = 'user@example.com';
const PASSWORD = 'correct-horse-battery-staple';
const USER_ID = 'user-123';

const limitedResponse = (status = 429) => ({ status, _body: { error: 'limited' } });

function buildRequest(
  body: unknown = { email: EMAIL, password: PASSWORD, turnstileToken: 'ts-token' },
  headers: Record<string, string> = {},
) {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/auth/login (DD-AUTH-014)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockReset();
    enforceRateLimit.mockResolvedValue(undefined);
    verifyTurnstile.mockResolvedValue({ ok: true });
    __mockSignInWithPassword.mockResolvedValue({
      data: { session: { access_token: 'a' }, user: { id: USER_ID, email: EMAIL } },
      error: null,
    });
    __mockSignInWithOtp.mockResolvedValue({ error: null });
    createReturnIntent.mockResolvedValue({ token: 'T'.repeat(43), maxAgeSeconds: 900 });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('DD-AUTH-014 正しい資格で 200・step otp・保留の Cookie・password_verified の監査を返す', async () => {
    const res: any = await POST(buildRequest());

    expect(res.status).toBe(200);
    expect(res._body.step).toBe('otp');
    expect(res._body.message).toEqual(expect.any(String));
    expect(createLoginTwoFactorSessionToken).toHaveBeenCalledWith({ userId: USER_ID, email: EMAIL });
    expect(res.cookies.get('sb-login-2fa-session')).toEqual(
      expect.objectContaining({
        value: 'signed-pending-token',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 300,
      }),
    );
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'password_verified',
      detail: 'otp_sent',
      resource_id: USER_ID,
    });
  });

  test('DD-AUTH-014 IP 単位 50 回とメール単位 5 回の順に auth:login の制限を数える', async () => {
    await POST(buildRequest());

    expect(enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(enforceRateLimit.mock.calls[0][0]).toEqual(
      expect.objectContaining({ endpoint: 'auth:login', limit: 50, windowSeconds: 600 }),
    );
    expect(enforceRateLimit.mock.calls[0][0].subject).toBeUndefined();
    expect(enforceRateLimit.mock.calls[1][0]).toEqual(
      expect.objectContaining({ endpoint: 'auth:login', limit: 5, windowSeconds: 600, subject: EMAIL }),
    );
  });

  test('DD-AUTH-040 パスワードの確かめと確認コードの送信は captcha を免除される auth だけの client で行い、未登録の利用者を作らない', async () => {
    await POST(buildRequest({ email: 'User@Example.com', password: PASSWORD, turnstileToken: 't' }));

    expect(createServiceRoleAuthClient).toHaveBeenCalledTimes(1);
    expect(createPublicClient).not.toHaveBeenCalled();
    expect(__mockSignInWithPassword).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
    expect(__mockSignInWithOtp).toHaveBeenCalledWith({ email: EMAIL, options: { shouldCreateUser: false } });
  });

  test('DD-AUTH-014 IP の制限が応答を返したらその応答をそのまま返し、本文を読まない', async () => {
    const limited = limitedResponse();
    enforceRateLimit.mockResolvedValueOnce(limited);
    const request = buildRequest();
    const jsonSpy = jest.spyOn(request, 'json');

    const res = await POST(request);

    expect(res).toBe(limited);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test('DD-AUTH-014 IP の制限の呼び出しが投げたら 500 で、先へ進まない（SEC-AUTH-013-AC-02）', async () => {
    enforceRateLimit.mockRejectedValueOnce(new Error('store down'));

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Rate limit middleware error'),
      expect.anything(),
    );
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test('DD-AUTH-014 形が合わない入力は 400 で、Turnstile もメールの制限も呼ばない', async () => {
    const res: any = await POST(buildRequest({ email: 'not-an-email', password: 'short' }));

    expect(res.status).toBe(400);
    expect(res._body.code).toBe('validation_error');
    expect(res._body.detail.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['email', 'password']));
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test('DD-AUTH-014 Turnstile の失敗で 403 と failure の監査（誤りの文あり）。メールの枠は数えない', async () => {
    verifyTurnstile.mockResolvedValue({ ok: false, error: 'invalid-input-response' });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(403);
    expect(res._body).toEqual({ error: 'Bot detection failed' });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'failure',
      detail: 'invalid-input-response',
    });
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test('DD-AUTH-014 Turnstile の失敗で誤りの文が無ければ turnstile_failed を監査に残す', async () => {
    verifyTurnstile.mockResolvedValue({ ok: false });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(403);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'turnstile_failed' }));
  });

  test('DD-AUTH-014 x-real-ip を空白を除いて Turnstile の IP に渡す', async () => {
    await POST(buildRequest(undefined, { 'x-real-ip': ' 203.0.113.7 ' }));

    expect(verifyTurnstile).toHaveBeenCalledWith('ts-token', '203.0.113.7');
  });

  test('DD-AUTH-014 x-real-ip が無いと Turnstile に IP を渡さない（null）', async () => {
    await POST(buildRequest());

    expect(verifyTurnstile).toHaveBeenCalledWith('ts-token', null);
  });

  test('DD-AUTH-014 x-real-ip が空でも Turnstile に IP を渡さない（null）', async () => {
    await POST(buildRequest(undefined, { 'x-real-ip': '' }));

    expect(verifyTurnstile).toHaveBeenCalledWith('ts-token', null);
  });

  test('DD-AUTH-014 x-forwarded-for は読まず、x-real-ip が在ればそちらを Turnstile に渡す', async () => {
    await POST(buildRequest(undefined, { 'x-forwarded-for': '198.51.100.99' }));
    expect(verifyTurnstile).toHaveBeenLastCalledWith('ts-token', null);

    await POST(buildRequest(undefined, { 'x-forwarded-for': '198.51.100.99', 'x-real-ip': '203.0.113.7' }));
    expect(verifyTurnstile).toHaveBeenLastCalledWith('ts-token', '203.0.113.7');
  });

  test('DD-AUTH-014 メールの制限が応答を返したらその応答をそのまま返す', async () => {
    const limited = limitedResponse();
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);

    const res = await POST(buildRequest());

    expect(res).toBe(limited);
    expect(verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test('DD-AUTH-014 メールの制限の呼び出しが投げたら 500 で、パスワードの確かめへ進まない（SEC-AUTH-013-AC-02）', async () => {
    enforceRateLimit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('store down'));

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test('DD-AUTH-040 SEC-AUTH-035-AC-02 パスワードの確かめを captcha が断ったら 401 にせず 500 と supabase_captcha_rejected の監査（誤りの本文は残さない）', async () => {
    __mockSignInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'captcha_failed', status: 400, message: 'captcha protection: request disallowed (no captcha_token found)' },
    });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'error',
      detail: 'supabase_captcha_rejected',
    });
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.cookies._cookies).toHaveLength(0);
  });

  test('DD-AUTH-040 SEC-AUTH-035-AC-02 確認コードの送信を captcha が断ったら 500 と supabase_captcha_rejected の監査。保留の Cookie を発行しない', async () => {
    __mockSignInWithOtp.mockResolvedValue({
      error: { code: 'captcha_failed', status: 400, message: 'captcha protection: request disallowed (no captcha_token found)' },
    });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(res.cookies._cookies).toHaveLength(0);
    expect(createLoginTwoFactorSessionToken).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'error',
      detail: 'supabase_captcha_rejected',
      resource_id: USER_ID,
    });
  });

  test('DD-AUTH-040 資格情報の誤り（400 Invalid login credentials）は captcha の拒否にせず今までどおり 401', async () => {
    __mockSignInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(401);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid login credentials' }));
  });

  test('DD-AUTH-014 SEC-AUTH-035-AC-02 GoTrue の回数の制限（429）は 401 にせず 429 と Retry-After と supabase_rate_limited の監査。確認コードは送らない', async () => {
    __mockSignInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { code: 'over_request_rate_limit', status: 429, message: 'Request rate limit reached' },
    });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toEqual(expect.stringMatching(/^\d+$/));
    expect(res._body).toEqual({ error: expect.any(String) });
    expect(res._body.error).not.toContain('パスワードが正しくありません');
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'error',
      detail: 'supabase_rate_limited',
    });
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.cookies._cookies).toHaveLength(0);
  });

  test('DD-AUTH-014 SEC-AUTH-035-AC-02 GoTrue の 5xx は 401 にせず 503 と supabase_unavailable の監査（誤りの本文は残さない）', async () => {
    __mockSignInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { name: 'AuthApiError', status: 500, message: 'Database error querying schema' },
    });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toEqual(expect.stringMatching(/^\d+$/));
    expect(res._body.error).not.toContain('パスワードが正しくありません');
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'error',
      detail: 'supabase_unavailable',
    });
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.cookies._cookies).toHaveLength(0);
  });

  test.each([
    ['status 0 の通信の失敗', { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' }],
    ['AuthRetryableFetchError（status 502）', { name: 'AuthRetryableFetchError', status: 502, message: 'bad gateway' }],
    ['status が無い AuthRetryableFetchError', { name: 'AuthRetryableFetchError', message: 'fetch failed' }],
  ])('DD-AUTH-014 SEC-AUTH-035-AC-02 %s は 503 と supabase_unavailable の監査', async (_label, error) => {
    __mockSignInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(503);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'supabase_unavailable' }));
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-014 SEC-AUTH-035-AC-02 未確認のメール（400 email_not_confirmed）は誤ったパスワードと同じ 401・同じ本文で、列挙の手掛かりを作らない', async () => {
    __mockSignInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' },
    });
    const unconfirmed: any = await POST(buildRequest());

    __mockSignInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' },
    });
    const wrong: any = await POST(buildRequest());

    expect(unconfirmed.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unconfirmed._body).toEqual(wrong._body);
  });

  test('DD-AUTH-014 パスワードの誤りは 401 と failure の監査（誤りの文あり）。確認コードは送らない', async () => {
    __mockSignInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { message: 'Invalid login credentials' },
    });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(401);
    expect(res._body).toEqual({ error: 'メールアドレスまたはパスワードが正しくありません。' });
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'failure',
      detail: 'Invalid login credentials',
    });
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(res.cookies._cookies).toHaveLength(0);
  });

  test('DD-AUTH-014 誤りが無くても session が無ければ 401 と invalid credentials の監査', async () => {
    __mockSignInWithPassword.mockResolvedValue({ data: { session: null, user: { id: USER_ID } }, error: null });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(401);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'invalid credentials' }));
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-014 誤りが無くても user が無ければ 401 を返す', async () => {
    __mockSignInWithPassword.mockResolvedValue({ data: { session: { access_token: 'a' }, user: null }, error: null });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(401);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('DD-AUTH-014 確認コードの送信の失敗は 500 と error の監査。保留の Cookie を発行しない', async () => {
    __mockSignInWithOtp.mockResolvedValue({ error: { message: 'smtp down' } });

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(res._body.error).toEqual(expect.any(String));
    expect(res.cookies._cookies).toHaveLength(0);
    expect(createLoginTwoFactorSessionToken).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: EMAIL,
      outcome: 'error',
      detail: 'otp_send_failed: smtp down',
      resource_id: USER_ID,
    });
  });

  test('DD-AUTH-014 本文が JSON でないと 500 Internal server error', async () => {
    const res: any = await POST(buildRequest('{not json'));

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
    expect(consoleErrorSpy).toHaveBeenCalledWith('Login handler error:', expect.anything());
  });

  test('DD-AUTH-014 予期しない例外も 500 Internal server error にする', async () => {
    __mockSignInWithPassword.mockRejectedValue(new Error('boom'));

    const res: any = await POST(buildRequest());

    expect(res.status).toBe(500);
    expect(res._body).toEqual({ error: 'Internal server error' });
  });

  describe('戻り先の控え（next）', () => {
    const body = (next?: unknown) => ({ email: EMAIL, password: PASSWORD, turnstileToken: 'ts-token', ...(next === undefined ? {} : { next }) });

    test('DD-AUTH-014 next が通ると控えの Cookie と保留の Cookie の両方を付け、控えは login の用途で保存される', async () => {
      const res: any = await POST(buildRequest(body('/item/3?color=red')));

      expect(res.status).toBe(200);
      expect(res._body.step).toBe('otp');
      expect(createReturnIntent).toHaveBeenCalledWith({ returnPath: '/item/3?color=red', purpose: 'login' });
      expect(res.cookies.get('sb-login-2fa-session')).toEqual(expect.objectContaining({ value: 'signed-pending-token' }));
      expect(res.cookies.get('sb-return-intent')).toEqual(
        expect.objectContaining({ value: 'T'.repeat(43), httpOnly: true, sameSite: 'lax', path: '/', maxAge: 900 }),
      );
    });

    test('DD-AUTH-014 応答の本文に戻り先の道筋も番号も出さない', async () => {
      const res: any = await POST(buildRequest(body('/item/3?color=red')));

      const text = JSON.stringify(res._body);
      expect(text).not.toContain('/item/3');
      expect(text).not.toContain('T'.repeat(43));
    });

    test.each([
      ['next が無い', undefined],
      ['外の住所', '//evil.example'],
      ['数値', 123],
      ['長すぎる値', '/item/' + 'a'.repeat(3000)],
      ['除外の道筋', '/login'],
    ])('DD-AUTH-014 %s でもログインは 400 にならず、控えを作らず控えの Cookie は消す側になる', async (_label, next) => {
      const res: any = await POST(buildRequest(body(next)));

      expect(res.status).toBe(200);
      expect(res._body.step).toBe('otp');
      expect(createReturnIntent).not.toHaveBeenCalled();
      expect(res.cookies.get('sb-return-intent')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
    });

    test('DD-AUTH-014 控えの保存が失敗してもログインは止まらず、応答は 200 の step otp で控えの Cookie は消す側になる', async () => {
      createReturnIntent.mockResolvedValue(null);

      const res: any = await POST(buildRequest(body('/account')));

      expect(res.status).toBe(200);
      expect(res._body.step).toBe('otp');
      expect(res.cookies.get('sb-return-intent')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
    });

    test('DD-AUTH-014 パスワードの誤り・ボット判定・制限・確認コードの送信の失敗では控えを作らず Cookie も付けない', async () => {
      __mockSignInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: 'bad' } });
      const wrongPassword: any = await POST(buildRequest(body('/account')));

      verifyTurnstile.mockResolvedValueOnce({ ok: false });
      const bot: any = await POST(buildRequest(body('/account')));

      enforceRateLimit.mockResolvedValueOnce(limitedResponse());
      const limited: any = await POST(buildRequest(body('/account')));

      __mockSignInWithOtp.mockResolvedValueOnce({ error: { message: 'smtp down' } });
      const otpFailed: any = await POST(buildRequest(body('/account')));

      expect([wrongPassword.status, bot.status, limited.status, otpFailed.status]).toEqual([401, 403, 429, 500]);
      expect(createReturnIntent).not.toHaveBeenCalled();
      for (const res of [wrongPassword, bot, otpFailed]) {
        expect(res.cookies.get('sb-return-intent')).toBeUndefined();
      }
    });
  });
});
