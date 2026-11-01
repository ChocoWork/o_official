/**
 * ARC-AUTH-002: ログインはパスワードの確かめとメールの確認コードの2段で、間の保留を署名した短命の Cookie に持つ。
 * login・resend・otp/verify の3つの窓口を、本物の署名と Cookie の部品でつないで通す。
 * セッションの確定（persistSessionAndCookies）は本物を通し、外の依存（Supabase の振る舞い・sessions 表への保存・回数の制限・注文の紐付け・監査）だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/orders/link-guest-orders', () => ({
  linkGuestOrdersByEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/supabase/server', () => {
  const mockAuth = {
    signInWithPassword: jest.fn(),
    signInWithOtp: jest.fn(),
    verifyOtp: jest.fn(),
  };
  const sessionsInsert = jest.fn();
  const service = { from: jest.fn(() => ({ insert: sessionsInsert })) };
  return {
    createPublicClient: jest.fn(async () => ({ auth: mockAuth })),
    createServiceRoleClient: jest.fn(async () => service),
    __mockAuth: mockAuth,
    __service: service,
    __sessionsInsert: sessionsInsert,
  };
});

// パスワードの確かめと確認コードの送信は captcha を免除される auth だけの client（DD-AUTH-040）。
// verifyOtp は captcha が掛からないので createPublicClient のまま。同じ mockAuth を共有する。
jest.mock('@/lib/auth/service-role-auth-client', () => ({
  ...jest.requireActual('@/lib/auth/service-role-auth-client'),
  createServiceRoleAuthClient: jest.fn(async () => ({
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    auth: require('@/lib/supabase/server').__mockAuth,
  })),
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

import crypto from 'crypto';

const { __mockAuth, __service, __sessionsInsert } = require('@/lib/supabase/server');

const SECRET = 'arc-auth-002-test-secret';
const PASSWORD = 'correct-horse-battery-staple';
const CODE = '12345678';
const USER = { id: 'user-123', email: 'member@example.com', email_confirmed_at: '2026-01-01T00:00:00.000Z' };
// GoTrue の access token の形（DD-AUTH-039）。AUTH_REQUIRE_APP_SESSION が既定で有効なので、ログインの保存には session_id が要る。
const ACCESS_TOKEN = `access-token-value.${Buffer.from(JSON.stringify({ session_id: '4c36ef0b-0332-42d8-b210-3326fc20c240' })).toString('base64url')}.s`;
const SESSION = { access_token: ACCESS_TOKEN, refresh_token: 'refresh-token-value' };
const COOKIE_NAME = 'sb-login-2fa-session';

type Handler = (request: Request) => Promise<any>;
let login: Handler;
let resend: Handler;
let verify: Handler;

function post(path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function loginRequest(email = USER.email) {
  return post('/api/auth/login', { email, password: PASSWORD });
}

function sign(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function cookieOf(res: any) {
  return `${COOKIE_NAME}=${res.cookies.get(COOKIE_NAME).value}`;
}

describe('ARC-AUTH-002 ログインの2段と保留の Cookie', () => {
  beforeAll(async () => {
    process.env.LOGIN_2FA_SESSION_SECRET = SECRET;
    login = (await import('@/app/api/auth/login/route')).POST as Handler;
    resend = (await import('@/app/api/auth/login/resend/route')).POST as Handler;
    verify = (await import('@/app/api/auth/otp/verify/route')).POST as Handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    __mockAuth.signInWithPassword.mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
    __mockAuth.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    __mockAuth.verifyOtp.mockImplementation(async ({ token }: { token: string }) =>
      token === CODE
        ? { data: { session: SESSION, user: USER }, error: null }
        : { data: { session: null, user: null }, error: { message: 'Token has expired or is invalid' } },
    );
    __sessionsInsert.mockResolvedValue({ error: null });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('ARC-AUTH-002 1段目の応答の保留の Cookie を持って2段目を通ると、ここで初めてトークンの保存に進む', async () => {
    const first = await login(loginRequest());

    expect(first.status).toBe(200);
    expect(__sessionsInsert).not.toHaveBeenCalled();
    expect(first.cookies.all().map((c: { name: string }) => c.name)).toEqual([COOKIE_NAME, 'sb-return-intent']);

    const second = await verify(post('/api/auth/otp/verify', { code: CODE }, cookieOf(first)));

    expect(second.status).toBe(200);
    expect(second.cookies.get(COOKIE_NAME)).toMatchObject({ value: '', maxAge: 0 });
    expect(second.cookies.get('sb-access-token')).toMatchObject({ value: SESSION.access_token, httpOnly: true });
    expect(second.cookies.get('sb-refresh-token')).toMatchObject({ value: SESSION.refresh_token, httpOnly: true });
    expect(second.cookies.get('sb-csrf-token').value).toEqual(expect.any(String));
    expect(__service.from).toHaveBeenCalledWith('sessions');
    expect(__sessionsInsert).toHaveBeenCalledTimes(1);
    const [row] = __sessionsInsert.mock.calls[0][0];
    expect(row.user_id).toBe(USER.id);
    expect(row.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(SESSION.refresh_token);
  });

  test('ARC-AUTH-002 保留の Cookie が無ければ、正しいコードでも2段目は通らず Supabase の確かめにも進まない', async () => {
    const res = await verify(post('/api/auth/otp/verify', { code: CODE }));

    expect(res.status).toBe(401);
    expect(__mockAuth.verifyOtp).not.toHaveBeenCalled();
    expect(__sessionsInsert).not.toHaveBeenCalled();
  });

  test('ARC-AUTH-002 別の鍵で署名した Cookie は2段目も再送も通さない', async () => {
    const payload = Buffer.from(
      JSON.stringify({ purpose: 'login_2fa', userId: USER.id, email: USER.email, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 }),
      'utf8',
    ).toString('base64url');
    const foreign = `${payload}.${crypto.createHmac('sha256', 'another-secret').update(payload).digest('base64url')}`;
    const cookie = `${COOKIE_NAME}=${foreign}`;

    const verified = await verify(post('/api/auth/otp/verify', { code: CODE }, cookie));
    const resent = await resend(post('/api/auth/login/resend', {}, cookie));

    expect(verified.status).toBe(401);
    expect(resent.status).toBe(401);
    expect(__mockAuth.verifyOtp).not.toHaveBeenCalled();
    expect(__mockAuth.signInWithOtp).not.toHaveBeenCalled();
  });

  test('ARC-AUTH-002 正しい署名でも、用途が違う印・iat が無い旧形式の印は通さない', async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrongPurpose = sign({ purpose: 'password_reset', userId: USER.id, email: USER.email, iat: now, exp: now + 300 });
    const legacy = sign({ purpose: 'login_2fa', userId: USER.id, email: USER.email, exp: now + 300 });

    for (const token of [wrongPurpose, legacy]) {
      const res = await verify(post('/api/auth/otp/verify', { code: CODE }, `${COOKIE_NAME}=${token}`));
      expect(res.status).toBe(401);
    }
    expect(__mockAuth.verifyOtp).not.toHaveBeenCalled();
  });

  test('ARC-AUTH-002 確認コードを送る宛先と確かめる宛先は、どちらも保留の Cookie の宛先で、本文の email は使わない', async () => {
    const first = await login(loginRequest());
    const cookie = cookieOf(first);

    await resend(post('/api/auth/login/resend', { email: 'attacker@example.com' }, cookie));
    await verify(post('/api/auth/otp/verify', { code: CODE, email: 'attacker@example.com' }, cookie));

    expect(__mockAuth.signInWithOtp).toHaveBeenCalledTimes(2);
    for (const call of __mockAuth.signInWithOtp.mock.calls) {
      expect(call[0].email).toBe(USER.email);
    }
    expect(__mockAuth.verifyOtp).toHaveBeenCalledWith({ email: USER.email, token: CODE, type: 'email' });
  });

  test('ARC-AUTH-002 保留の Cookie は 5分・HttpOnly・SameSite=Strict で、中身は用途・利用者・宛先・時刻だけ', async () => {
    const first = await login(loginRequest());

    const cookie = first.cookies.get(COOKIE_NAME);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'strict', maxAge: 300 });
    const decoded = JSON.parse(Buffer.from(cookie.value.split('.')[0], 'base64url').toString('utf8'));
    expect(decoded).toMatchObject({ purpose: 'login_2fa', userId: USER.id, email: USER.email });
    expect(Object.keys(decoded).sort()).toEqual(['email', 'exp', 'iat', 'purpose', 'userId']);
    expect(JSON.stringify(decoded)).not.toContain(PASSWORD);
  });

  test('ARC-AUTH-002 1段目のパスワードが誤りなら保留の Cookie は配られず、2段目へ進む道が無い', async () => {
    __mockAuth.signInWithPassword.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } });

    const first = await login(loginRequest());

    expect(first.status).toBe(401);
    expect(first.cookies.get(COOKIE_NAME)).toBeUndefined();
    expect(__mockAuth.signInWithOtp).not.toHaveBeenCalled();
  });

  test('ARC-AUTH-002 確認コードを打ち間違えても同じ保留で打ち直せる', async () => {
    const first = await login(loginRequest());
    const cookie = cookieOf(first);

    const wrong = await verify(post('/api/auth/otp/verify', { code: '00000000' }, cookie));
    const right = await verify(post('/api/auth/otp/verify', { code: CODE }, cookie));

    expect(wrong.status).toBe(401);
    expect(wrong.cookies.get(COOKIE_NAME)).toBeUndefined();
    expect(right.status).toBe(200);
  });

  test('ARC-AUTH-002 再送で受け取った Cookie でも2段目が通る（宛先と利用者は変わらない）', async () => {
    const first = await login(loginRequest());
    const resent = await resend(post('/api/auth/login/resend', {}, cookieOf(first)));

    const second = await verify(post('/api/auth/otp/verify', { code: CODE }, cookieOf(resent)));

    expect(resent.status).toBe(200);
    expect(second.status).toBe(200);
    expect(__mockAuth.verifyOtp).toHaveBeenCalledWith({ email: USER.email, token: CODE, type: 'email' });
  });

  test('ARC-AUTH-002 確認コードの確かめは type=email の1回だけで、ほかの用途のコードを試さない', async () => {
    const first = await login(loginRequest());

    await verify(post('/api/auth/otp/verify', { code: '00000000' }, cookieOf(first)));

    expect(__mockAuth.verifyOtp).toHaveBeenCalledTimes(1);
    expect(__mockAuth.verifyOtp.mock.calls[0][0].type).toBe('email');
  });
});
