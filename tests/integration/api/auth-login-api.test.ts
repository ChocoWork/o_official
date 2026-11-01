/**
 * API-AUTH-001: POST /api/auth/login（パスワードを確かめて確認コードを送り、保留の Cookie を返す）の結合テスト。
 * 保留の印の署名は本物の実装で作らせ、外の依存（Supabase・回数の制限・Turnstile・監査）だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/turnstile', () => ({
  verifyTurnstile: jest.fn(),
}));

jest.mock('@/lib/audit', () => {
  const logAudit = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: logAudit, logAudit };
});

// 戻り先の控えの保存だけを差し替える（確かめと Cookie の動作は本物）
jest.mock('@/features/auth/return-intent/return-intent-store', () => ({
  ...jest.requireActual('@/features/auth/return-intent/return-intent-store'),
  createReturnIntent: jest.fn(),
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

import { verifyLoginTwoFactorSessionToken } from '@/features/auth/services/login-2fa-session';

/* eslint-disable @typescript-eslint/no-require-imports */
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { verifyTurnstile } = require('@/lib/turnstile');
const { logAudit } = require('@/lib/audit');
const { createReturnIntent } = require('@/features/auth/return-intent/return-intent-store');
const {
  createServiceRoleAuthClient,
  __mockSignInWithPassword,
  __mockSignInWithOtp,
} = require('@/lib/auth/service-role-auth-client');
/* eslint-enable @typescript-eslint/no-require-imports */

const PASSWORD = 'correct-horse-battery-staple';
const USER = { id: 'user-123', email: 'member@example.com' };
const SESSION = { access_token: 'first-step-access', refresh_token: 'first-step-refresh' };

type Handler = (request: Request) => Promise<any>;
let loginHandler: Handler;

function buildRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function validBody(extra: Record<string, unknown> = {}) {
  return { email: USER.email, password: PASSWORD, turnstileToken: 'ts-token', ...extra };
}

describe('API-AUTH-001 POST /api/auth/login', () => {
  beforeAll(async () => {
    process.env.LOGIN_2FA_SESSION_SECRET = 'api-auth-001-test-secret';
    loginHandler = (await import('@/app/api/auth/login/route')).POST as Handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    enforceRateLimit.mockReset();
    enforceRateLimit.mockResolvedValue(undefined);
    verifyTurnstile.mockResolvedValue({ ok: true });
    __mockSignInWithPassword.mockReset();
    __mockSignInWithOtp.mockReset();
    __mockSignInWithPassword.mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
    __mockSignInWithOtp.mockResolvedValue({ data: {}, error: null });
    createReturnIntent.mockResolvedValue({ token: 'A'.repeat(43), maxAgeSeconds: 900 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('API-AUTH-001 200 は step=otp を返し、パスワードを通った印の Cookie を5分・HttpOnly・SameSite=Strict で配る', async () => {
    const res = await loginHandler(buildRequest(validBody()));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.step).toBe('otp');
    expect(typeof body.message).toBe('string');

    const cookie = res.cookies.get('sb-login-2fa-session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/', maxAge: 300 });
    const pending = verifyLoginTwoFactorSessionToken(cookie.value);
    expect(pending).toMatchObject({ purpose: 'login_2fa', userId: USER.id, email: USER.email });
    expect(pending!.exp - pending!.iat).toBe(300);
  });

  test('API-AUTH-001 1段目で得た session は捨て、トークンを本文にも Cookie にも出さない', async () => {
    const res = await loginHandler(buildRequest(validBody()));

    // 配るのは保留の印と、戻り先の控え（この要求は next が無いので消す側）だけ。認証のトークンの Cookie は無い
    expect(res.cookies.all().map((c: { name: string }) => c.name)).toEqual(['sb-login-2fa-session', 'sb-return-intent']);
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain(SESSION.access_token);
    expect(serialized).not.toContain(SESSION.refresh_token);
    expect(JSON.stringify(res.cookies.all())).not.toContain(SESSION.refresh_token);
  });

  test('API-AUTH-001 next が通ると控えの Cookie を HttpOnly・SameSite=Lax・15 分で保留の Cookie と一緒に配り、番号は本文に出さない', async () => {
    const res = await loginHandler(buildRequest(validBody({ next: '/wishlist' })));

    expect(createReturnIntent).toHaveBeenCalledWith({ returnPath: '/wishlist', purpose: 'login' });
    expect(res.cookies.get('sb-login-2fa-session')).toBeDefined();
    expect(res.cookies.get('sb-return-intent')).toEqual(
      expect.objectContaining({ value: 'A'.repeat(43), httpOnly: true, sameSite: 'lax', path: '/', maxAge: 900 }),
    );
    expect(JSON.stringify(await res.json())).not.toContain('A'.repeat(43));
  });

  test('API-AUTH-001 next が外の住所・数値・長すぎる値でも 400 にならず 200 の step=otp で、控えの Cookie は消す側になる', async () => {
    for (const next of ['//evil.example', 123, '/item/' + 'a'.repeat(3000)]) {
      createReturnIntent.mockClear();

      const res = await loginHandler(buildRequest(validBody({ next })));

      expect(res.status).toBe(200);
      expect((await res.json()).step).toBe('otp');
      expect(createReturnIntent).not.toHaveBeenCalled();
      expect(res.cookies.get('sb-return-intent')).toEqual(expect.objectContaining({ value: '', maxAge: 0 }));
    }
  });

  test('API-AUTH-001 保留の Cookie の中身にパスワードやトークンを入れない', async () => {
    const res = await loginHandler(buildRequest(validBody()));

    const payload = res.cookies.get('sb-login-2fa-session').value.split('.')[0];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(Object.keys(decoded).sort()).toEqual(['email', 'exp', 'iat', 'purpose', 'userId']);
  });

  test('API-AUTH-001 順番は IP の制限 → Turnstile → メールの制限 → パスワード → 確認コードの送信', async () => {
    const events: string[] = [];
    enforceRateLimit.mockImplementation(async (args: { subject?: string }) => {
      events.push(args.subject ? 'rate:account' : 'rate:ip');
    });
    verifyTurnstile.mockImplementation(async () => {
      events.push('turnstile');
      return { ok: true };
    });
    __mockSignInWithPassword.mockImplementation(async () => {
      events.push('password');
      return { data: { session: SESSION, user: USER }, error: null };
    });
    __mockSignInWithOtp.mockImplementation(async () => {
      events.push('otp');
      return { data: {}, error: null };
    });

    const res = await loginHandler(buildRequest(validBody()));

    expect(res.status).toBe(200);
    expect(events).toEqual(['rate:ip', 'turnstile', 'rate:account', 'password', 'otp']);
  });

  test('API-AUTH-001 IP の制限は50回/600秒、メールの制限は5回/600秒で小文字にそろえた宛先を数える', async () => {
    await loginHandler(buildRequest(validBody({ email: 'Member@Example.COM' })));

    const calls = enforceRateLimit.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ endpoint: 'auth:login', limit: 50, windowSeconds: 600 });
    expect(calls[0].subject).toBeUndefined();
    expect(calls[1]).toMatchObject({
      endpoint: 'auth:login',
      limit: 5,
      windowSeconds: 600,
      subject: 'member@example.com',
    });
  });

  test('API-AUTH-001 IP の制限に当たれば本文を読まず、Turnstile も Supabase も呼ばない', async () => {
    const limited = { status: 429 };
    enforceRateLimit.mockResolvedValueOnce(limited);

    const res = await loginHandler(buildRequest('this is not json'));

    expect(res).toBe(limited);
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(createServiceRoleAuthClient).not.toHaveBeenCalled();
  });

  test('API-AUTH-001 メールの制限に当たればその応答を返し、パスワードを確かめない', async () => {
    const limited = { status: 429 };
    enforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);

    const res = await loginHandler(buildRequest(validBody()));

    expect(res).toBe(limited);
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test('API-AUTH-001 回数の制限の部品が落ちたら 500 で止まり、ログインを続けない（SEC-AUTH-013-AC-02）', async () => {
    enforceRateLimit.mockRejectedValue(new Error('limiter down'));

    const res = await loginHandler(buildRequest(validBody()));

    expect(res.status).toBe(500);
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
  });

  test.each([
    ['メールの形が違う', { email: 'not-an-email' }],
    ['パスワードが15文字', { password: 'a'.repeat(15) }],
    ['パスワードが129文字', { password: 'a'.repeat(129) }],
    ['パスワードが無い', { password: undefined }],
  ])('API-AUTH-001 形の誤り（%s）は 400 で、Turnstile 以降へ進まない', async (_label, override) => {
    const res = await loginHandler(buildRequest(validBody(override)));

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('validation_error');
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
  });

  test('API-AUTH-001 JSON として読めない本文は 500 を返し、Supabase を呼ばない', async () => {
    const res = await loginHandler(buildRequest('{broken'));

    expect(res.status).toBe(500);
    expect(createServiceRoleAuthClient).not.toHaveBeenCalled();
  });

  test('API-AUTH-001 Turnstile には本文の印と x-real-ip の IP を渡す', async () => {
    await loginHandler(buildRequest(validBody(), { 'x-real-ip': '203.0.113.9' }));

    expect(verifyTurnstile).toHaveBeenCalledWith('ts-token', '203.0.113.9');
  });

  test('API-AUTH-001 Turnstile に失敗したら 403 で、メールの制限もパスワードの確かめも行わず監査に残す', async () => {
    verifyTurnstile.mockResolvedValue({ ok: false, error: 'missing_turnstile_token' });

    const res = await loginHandler(buildRequest(validBody()));

    expect(res.status).toBe(403);
    expect(enforceRateLimit).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithPassword).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: USER.email,
      outcome: 'failure',
      detail: 'missing_turnstile_token',
    });
  });

  test('API-AUTH-001 パスワードの確かめと確認コードの送信は captcha を免除される auth だけの client（createServiceRoleAuthClient）1 つで行い、確認コードは新しい利用者を作らない設定で送る', async () => {
    await loginHandler(buildRequest(validBody()));

    expect(createServiceRoleAuthClient).toHaveBeenCalledTimes(1);
    expect(__mockSignInWithPassword).toHaveBeenCalledWith({ email: USER.email, password: PASSWORD });
    expect(__mockSignInWithOtp).toHaveBeenCalledWith({
      email: USER.email,
      options: { shouldCreateUser: false },
    });
  });

  test('API-AUTH-001 メールかパスワードの誤りは 401 で同じ文言を返し、確認コードを送らず Cookie も配らない', async () => {
    __mockSignInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } });
    const wrongPassword = await loginHandler(buildRequest(validBody()));
    __mockSignInWithPassword.mockResolvedValueOnce({ data: { session: null, user: null }, error: { message: 'User not found' } });
    const unknownEmail = await loginHandler(buildRequest(validBody({ email: 'nobody@example.com' })));

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
    expect(wrongPassword.cookies.all()).toHaveLength(0);
    expect(__mockSignInWithOtp).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: USER.email,
      outcome: 'failure',
      detail: 'Invalid login credentials',
    });
  });

  test('API-AUTH-001 エラーが無くても session か user が空なら 401 で、理由は invalid credentials と残す', async () => {
    __mockSignInWithPassword.mockResolvedValue({ data: { session: null, user: USER }, error: null });

    const res = await loginHandler(buildRequest(validBody()));

    expect(res.status).toBe(401);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'invalid credentials' }));
  });

  test('API-AUTH-001 確認コードの送信に失敗したら 500 で、Cookie を配らず error を監査に残す', async () => {
    __mockSignInWithOtp.mockResolvedValue({ data: {}, error: { message: 'smtp down' } });

    const res = await loginHandler(buildRequest(validBody()));

    expect(res.status).toBe(500);
    expect(res.cookies.all()).toHaveLength(0);
    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: USER.email,
      outcome: 'error',
      detail: 'otp_send_failed: smtp down',
      resource_id: USER.id,
    });
  });

  test('API-AUTH-001 成功は password_verified として監査に残し、no-store は付けない', async () => {
    const res = await loginHandler(buildRequest(validBody()));

    expect(logAudit).toHaveBeenCalledWith({
      action: 'login',
      actor_email: USER.email,
      outcome: 'password_verified',
      detail: 'otp_sent',
      resource_id: USER.id,
    });
    expect(res.headers.get('Cache-Control')).toBeUndefined();
  });

  test('API-AUTH-001 Supabase の呼び出しが例外で落ちたら 500 を返す', async () => {
    __mockSignInWithPassword.mockRejectedValue(new Error('network'));

    const res = await loginHandler(buildRequest(validBody()));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Internal server error');
  });
});
