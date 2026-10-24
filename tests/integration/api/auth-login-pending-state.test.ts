/**
 * STATE-AUTH-001: ログインの保留は5分の Cookie で、再送で延ばしても最初から30分で切れ、確定・取り消し・上限で消える。
 * 時計を動かしながら、本物の署名の部品と login・resend・otp/verify・cancel の窓口で状態の移りを通す。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn(),
}));

jest.mock('@/lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/features/auth/services/register', () => ({
  persistSessionAndCookies: jest.fn(),
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
  return {
    createPublicClient: jest.fn(async () => ({ auth: mockAuth })),
    __mockAuth: mockAuth,
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

import crypto from 'crypto';
import {
  createLoginTwoFactorSessionToken,
  readLoginTwoFactorSessionFromCookieHeader,
  verifyLoginTwoFactorSessionToken,
  loginTwoFactorSessionAbsoluteMaxAgeSeconds,
  loginTwoFactorSessionMaxAgeSeconds,
} from '@/features/auth/services/login-2fa-session';

/* eslint-disable @typescript-eslint/no-require-imports */
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { __mockAuth } = require('@/lib/supabase/server');
const { persistSessionAndCookies } = require('@/features/auth/services/register');
const { logAudit } = require('@/lib/audit');
/* eslint-enable @typescript-eslint/no-require-imports */

const SECRET = 'state-auth-001-test-secret';
const COOKIE_NAME = 'sb-login-2fa-session';
const T0 = 1_800_000_000;
const CODE = '12345678';
const USER = { id: 'user-123', email: 'member@example.com', email_confirmed_at: null };
const SESSION = { access_token: 'access', refresh_token: 'refresh' };

type Handler = (request: Request) => Promise<any>;
let login: Handler;
let resend: Handler;
let verify: Handler;
let cancel: Handler;
let nowSeconds = T0;

function at(offsetSeconds: number) {
  nowSeconds = T0 + offsetSeconds;
}

function post(path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function cookieOf(res: any) {
  return `${COOKIE_NAME}=${res.cookies.get(COOKIE_NAME).value}`;
}

function startPending() {
  return login(post('/api/auth/login', { email: USER.email, password: 'correct-horse-battery-staple' }));
}

function readPending(res: any) {
  return verifyLoginTwoFactorSessionToken(res.cookies.get(COOKIE_NAME).value);
}

describe('STATE-AUTH-001 ログインの保留の寿命と終わり方', () => {
  beforeAll(async () => {
    process.env.LOGIN_2FA_SESSION_SECRET = SECRET;
    login = (await import('@/app/api/auth/login/route')).POST as Handler;
    resend = (await import('@/app/api/auth/login/resend/route')).POST as Handler;
    verify = (await import('@/app/api/auth/otp/verify/route')).POST as Handler;
    cancel = (await import('@/app/api/auth/login/cancel/route')).POST as Handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    nowSeconds = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => nowSeconds * 1000);
    enforceRateLimit.mockReset();
    enforceRateLimit.mockResolvedValue(undefined);
    persistSessionAndCookies.mockReset();
    persistSessionAndCookies.mockResolvedValue({ ok: true });
    __mockAuth.signInWithPassword.mockResolvedValue({ data: { session: SESSION, user: USER }, error: null });
    __mockAuth.signInWithOtp.mockResolvedValue({ data: {}, error: null });
    __mockAuth.verifyOtp.mockImplementation(async ({ token }: { token: string }) =>
      token === CODE
        ? { data: { session: SESSION, user: USER }, error: null }
        : { data: { session: null, user: null }, error: { message: 'invalid' } },
    );
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('STATE-AUTH-001 保留の寿命は5分、絶対の上限は30分と定めている', () => {
    expect(loginTwoFactorSessionMaxAgeSeconds).toBe(300);
    expect(loginTwoFactorSessionAbsoluteMaxAgeSeconds).toBe(1800);
  });

  test('STATE-AUTH-001 login が 200 を返した時に iat を刻み、期限をそこから5分に置く', async () => {
    at(123);
    const res = await startPending();

    expect(readPending(res)).toMatchObject({ iat: T0 + 123, exp: T0 + 123 + 300 });
    expect(res.cookies.get(COOKIE_NAME).maxAge).toBe(300);
  });

  test('STATE-AUTH-001 保留は期限の1秒前まで有効で、期限の瞬間に無効になる', async () => {
    const res = await startPending();
    const cookie = cookieOf(res);

    at(299);
    expect(readLoginTwoFactorSessionFromCookieHeader(cookie)).not.toBeNull();
    at(300);
    expect(readLoginTwoFactorSessionFromCookieHeader(cookie)).toBeNull();
  });

  test('STATE-AUTH-001 5分を過ぎたら、再送も確定も無いのと同じに断られる', async () => {
    const res = await startPending();
    const cookie = cookieOf(res);
    at(301);

    const resent = await resend(post('/api/auth/login/resend', {}, cookie));
    const verified = await verify(post('/api/auth/otp/verify', { code: CODE }, cookie));

    expect(resent.status).toBe(401);
    expect(verified.status).toBe(401);
    expect(__mockAuth.verifyOtp).not.toHaveBeenCalled();
  });

  test('STATE-AUTH-001 再送は iat を引き継ぎ、期限だけを再送の時点から5分に戻す', async () => {
    const first = await startPending();
    at(200);

    const resent = await resend(post('/api/auth/login/resend', {}, cookieOf(first)));

    expect(readPending(resent)).toMatchObject({ iat: T0, exp: T0 + 200 + 300 });
    at(499);
    expect(readLoginTwoFactorSessionFromCookieHeader(cookieOf(resent))).not.toBeNull();
    at(500);
    expect(readLoginTwoFactorSessionFromCookieHeader(cookieOf(resent))).toBeNull();
  });

  test('STATE-AUTH-001 再送を重ねて期限を延ばし続けても、最初の発行から30分ちょうどまでしか保てない', async () => {
    let current = await startPending();

    // 250 秒おきに再送すると、期限は毎回5分に戻るが iat は T0 のまま。
    for (let elapsed = 250; elapsed <= 1750; elapsed += 250) {
      at(elapsed);
      current = await resend(post('/api/auth/login/resend', {}, cookieOf(current)));
      expect(current.status).toBe(200);
      expect(readPending(current)!.iat).toBe(T0);
    }

    // 期限（T0+2050）はまだ先でも、iat から30分ちょうどの時点までは有効。
    at(1800);
    expect(readLoginTwoFactorSessionFromCookieHeader(cookieOf(current))).not.toBeNull();
    // 1秒でも超えたら、期限が残っていても無効。
    at(1801);
    expect(readLoginTwoFactorSessionFromCookieHeader(cookieOf(current))).toBeNull();

    const resent = await resend(post('/api/auth/login/resend', {}, cookieOf(current)));
    const verified = await verify(post('/api/auth/otp/verify', { code: CODE }, cookieOf(current)));
    expect(resent.status).toBe(401);
    expect(verified.status).toBe(401);
  });

  test('STATE-AUTH-001 再送の呼び出し側が iat を渡さずに作った印は、30分の起点がやり直しになる（引き継ぎが要る理由）', () => {
    const original = createLoginTwoFactorSessionToken({ userId: USER.id, email: USER.email });
    at(1700);
    const renewedWithoutIat = createLoginTwoFactorSessionToken({ userId: USER.id, email: USER.email });
    const renewedWithIat = createLoginTwoFactorSessionToken({ userId: USER.id, email: USER.email, issuedAt: T0 });
    at(1900);

    expect(verifyLoginTwoFactorSessionToken(original)).toBeNull();
    expect(verifyLoginTwoFactorSessionToken(renewedWithoutIat)).not.toBeNull();
    expect(verifyLoginTwoFactorSessionToken(renewedWithIat)).toBeNull();
  });

  test('STATE-AUTH-001 確定（otp/verify が 200）で保留の Cookie を空にして消す', async () => {
    const first = await startPending();

    const confirmed = await verify(post('/api/auth/otp/verify', { code: CODE }, cookieOf(first)));

    expect(confirmed.status).toBe(200);
    expect(confirmed.cookies.get(COOKIE_NAME)).toMatchObject({ value: '', maxAge: 0 });
    // 消す指示を受けたブラウザは空の値を送る。空の値は保留として読まれない。
    expect(readLoginTwoFactorSessionFromCookieHeader(`${COOKIE_NAME}=`)).toBeNull();
  });

  test('STATE-AUTH-001 取り消し（cancel）で保留の Cookie が消え、監査に残る', async () => {
    const first = await startPending();

    const cancelled = await cancel(post('/api/auth/login/cancel', {}, cookieOf(first)));

    expect(cancelled.cookies.get(COOKIE_NAME)).toMatchObject({ value: '', maxAge: 0 });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'cancelled', actor_email: USER.email }));
  });

  test('STATE-AUTH-001 宛先単位の上限で保留の Cookie が消え、確かめは行われない', async () => {
    const first = await startPending();
    enforceRateLimit.mockImplementation(async (args: { subject?: string }) =>
      args.subject ? new Response('{}', { status: 429, headers: { 'Retry-After': '600' } }) : undefined,
    );

    const limited = await verify(post('/api/auth/otp/verify', { code: CODE }, cookieOf(first)));

    expect(limited.status).toBe(429);
    expect(limited.cookies.get(COOKIE_NAME)).toMatchObject({ value: '', maxAge: 0 });
    expect(__mockAuth.verifyOtp).not.toHaveBeenCalled();
  });

  test('STATE-AUTH-001 確認コードの誤りでは保留を消さず、同じ保留で5回まで打ち直せる', async () => {
    const first = await startPending();
    const cookie = cookieOf(first);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      at(attempt * 10);
      const wrong = await verify(post('/api/auth/otp/verify', { code: `0000000${attempt}` }, cookie));
      expect(wrong.status).toBe(401);
      expect(wrong.cookies.get(COOKIE_NAME)).toBeUndefined();
    }
    at(60);
    const right = await verify(post('/api/auth/otp/verify', { code: CODE }, cookie));

    expect(right.status).toBe(200);
  });

  test.each([
    ['署名が違う', (payload: string) => `${payload}.${'A'.repeat(43)}`],
    ['署名が無い', (payload: string) => payload],
    ['署名の長さが違う', (payload: string) => `${payload}.short`],
  ])('STATE-AUTH-001 保留の印の検査（%s）に外れたら、無いのと同じに扱う', async (_label, tamper) => {
    const first = await startPending();
    const payload = first.cookies.get(COOKIE_NAME).value.split('.')[0];
    const cookie = `${COOKIE_NAME}=${tamper(payload)}`;

    expect(readLoginTwoFactorSessionFromCookieHeader(cookie)).toBeNull();
    logAudit.mockClear();
    const cancelled = await cancel(post('/api/auth/login/cancel', {}, cookie));
    expect(cancelled.status).toBe(200);
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('STATE-AUTH-001 中身を書き換えて署名を付け直さない限り、宛先を差し替えた印は無効になる', async () => {
    const first = await startPending();
    const [, signature] = first.cookies.get(COOKIE_NAME).value.split('.');
    const swappedPayload = Buffer.from(
      JSON.stringify({ purpose: 'login_2fa', userId: USER.id, email: 'victim@example.com', iat: T0, exp: T0 + 300 }),
      'utf8',
    ).toString('base64url');

    expect(readLoginTwoFactorSessionFromCookieHeader(`${COOKIE_NAME}=${swappedPayload}.${signature}`)).toBeNull();
  });

  test.each([
    ['用途が違う', { purpose: 'password_reset' }],
    ['利用者の id が文字でない', { userId: 42 }],
    ['宛先が無い', { email: undefined }],
    ['iat が無い', { iat: undefined }],
    ['exp が文字', { exp: 'soon' }],
  ])('STATE-AUTH-001 署名が正しくても中身の検査（%s）に外れたら、無いのと同じに扱う', (_label, override) => {
    const payload = Buffer.from(
      JSON.stringify({ purpose: 'login_2fa', userId: USER.id, email: USER.email, iat: T0, exp: T0 + 300, ...override }),
      'utf8',
    ).toString('base64url');
    const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

    expect(verifyLoginTwoFactorSessionToken(`${payload}.${signature}`)).toBeNull();
  });

  test('STATE-AUTH-001 保留の Cookie は同居する別の Cookie から取り出せ、空や似た名前は保留として読まない', async () => {
    const first = await startPending();
    const value = first.cookies.get(COOKIE_NAME).value;

    expect(readLoginTwoFactorSessionFromCookieHeader(`a=1; ${COOKIE_NAME}=${encodeURIComponent(value)}; b=2`)).toMatchObject({ email: USER.email });
    expect(readLoginTwoFactorSessionFromCookieHeader(`x-${COOKIE_NAME}=${value}`)).toBeNull();
    expect(readLoginTwoFactorSessionFromCookieHeader('')).toBeNull();
    expect(readLoginTwoFactorSessionFromCookieHeader(null)).toBeNull();
    expect(verifyLoginTwoFactorSessionToken(undefined)).toBeNull();
    expect(verifyLoginTwoFactorSessionToken('')).toBeNull();
  });
});
