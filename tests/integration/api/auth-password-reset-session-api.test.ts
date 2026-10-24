jest.mock('server-only', () => ({}), { virtual: true });

/**
 * API-AUTH-011 GET /api/auth/password-reset/session の結合テスト。
 * 窓口と再設定の Cookie の署名・読み取りは本物を使い、応答の組み立て（next/server）だけを差し替える。
 */

jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: any) => {
      const cookieCalls: any[] = [];
      return {
        status: init?.status ?? 200,
        headers: new Headers(),
        cookies: { set: jest.fn((value: any) => cookieCalls.push(value)) },
        _cookies: cookieCalls,
        json: async () => body,
      };
    },
  },
}));

const crypto = require('crypto');
const { enforceRateLimit } = require('@/features/auth/middleware/rateLimit');
const { createPasswordResetSessionToken } = require('@/features/auth/services/password-reset-session');

let handler: any;

const COOKIE = 'sb-password-reset-session';

function get(cookie?: string) {
  return new Request('http://localhost/api/auth/password-reset/session', {
    method: 'GET',
    headers: cookie === undefined ? {} : { cookie },
  });
}

function validToken(overrides: { expiresInSeconds?: number } = {}) {
  return createPasswordResetSessionToken({
    userId: 'user-123',
    email: 'test@example.com',
    tokenId: 'token-123',
    ...overrides,
  });
}

/** 本物と同じ鍵で署名した、中身だけが違う Cookie を作る。 */
function signedToken(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.JWT_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function expectCleared(res: any) {
  expect(res._cookies).toEqual([
    expect.objectContaining({ name: COOKIE, value: '', maxAge: 0, httpOnly: true, sameSite: 'strict' }),
  ]);
}

const envBackup = { ...process.env };

describe('API-AUTH-011 GET /api/auth/password-reset/session - Integration Tests', () => {
  beforeAll(async () => {
    handler = (await import('@/app/api/auth/password-reset/session/route')).GET;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PASSWORD_RESET_SESSION_SECRET;
    process.env.JWT_SECRET = 'test-jwt-secret';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  test('API-AUTH-011 有効な Cookie なら ready と宛先を返し、Cookie は消さない', async () => {
    const res = await handler(get(`${COOKIE}=${encodeURIComponent(validToken())}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, email: 'test@example.com' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res._cookies).toEqual([]);
  });

  test('API-AUTH-011 ほかの Cookie と並んで届いても再設定の Cookie だけを読む', async () => {
    const res = await handler(get(`theme=dark; ${COOKIE}=${encodeURIComponent(validToken())}; other=1`));

    expect(await res.json()).toEqual({ ready: true, email: 'test@example.com' });
  });

  test('API-AUTH-011 Cookie が無ければ ready:false・email:null を返して Cookie を消す', async () => {
    const res = await handler(get());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: false, email: null });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expectCleared(res);
  });

  test('API-AUTH-011 再設定の Cookie だけが無い Cookie の組でも ready:false', async () => {
    const res = await handler(get('theme=dark; other=1'));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test('API-AUTH-011 署名が違う Cookie は無効として消す', async () => {
    const [payload] = validToken().split('.');
    const res = await handler(get(`${COOKIE}=${encodeURIComponent(`${payload}.${'A'.repeat(43)}`)}`));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test('API-AUTH-011 署名の長さが違う Cookie は無効として消す', async () => {
    const [payload] = validToken().split('.');
    const res = await handler(get(`${COOKIE}=${encodeURIComponent(`${payload}.short`)}`));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test('API-AUTH-011 中身を書き換えた Cookie は署名が合わず無効', async () => {
    const [, signature] = validToken().split('.');
    const forged = Buffer.from(
      JSON.stringify({ purpose: 'password_reset', userId: 'victim', email: 'victim@example.com', tokenId: 't', exp: 9999999999 }),
      'utf8'
    ).toString('base64url');
    const res = await handler(get(`${COOKIE}=${encodeURIComponent(`${forged}.${signature}`)}`));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test('API-AUTH-011 期限が切れた Cookie は無効として消す', async () => {
    const res = await handler(get(`${COOKIE}=${encodeURIComponent(validToken({ expiresInSeconds: -1 }))}`));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test.each([
    ['用途が違う', { purpose: 'other', userId: 'u', email: 'e@example.com', tokenId: 't' }],
    ['userId が無い', { purpose: 'password_reset', email: 'e@example.com', tokenId: 't' }],
    ['email が無い', { purpose: 'password_reset', userId: 'u', tokenId: 't' }],
    ['tokenId が無い', { purpose: 'password_reset', userId: 'u', email: 'e@example.com' }],
  ])('API-AUTH-011 署名は正しくても「%s」Cookie は無効として消す', async (_label, claims) => {
    const token = signedToken({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 });

    const res = await handler(get(`${COOKIE}=${encodeURIComponent(token)}`));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test('API-AUTH-011 署名は正しくても exp が数でない Cookie は無効として消す', async () => {
    const token = signedToken({ purpose: 'password_reset', userId: 'u', email: 'e@example.com', tokenId: 't', exp: 'never' });

    const res = await handler(get(`${COOKIE}=${encodeURIComponent(token)}`));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test('API-AUTH-011 署名は正しくても中身が JSON でない Cookie は無効として消す', async () => {
    const encoded = Buffer.from('not json', 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', process.env.JWT_SECRET).update(encoded).digest('base64url');

    const res = await handler(get(`${COOKIE}=${encodeURIComponent(`${encoded}.${signature}`)}`));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test('API-AUTH-011 区切りが無い Cookie は無効として消す', async () => {
    const res = await handler(get(`${COOKIE}=nodot`));

    expect(await res.json()).toEqual({ ready: false, email: null });
    expectCleared(res);
  });

  test('API-AUTH-011 回数の制限は掛けない', async () => {
    const ready = await handler(get(`${COOKIE}=${encodeURIComponent(validToken())}`));
    const notReady = await handler(get());

    expect(await ready.json()).toMatchObject({ ready: true });
    expect(await notReady.json()).toEqual({ ready: false, email: null });
    expect(enforceRateLimit).not.toHaveBeenCalled();
  });
});

export {};
