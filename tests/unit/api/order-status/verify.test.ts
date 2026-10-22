/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

jest.mock('server-only', () => ({}), { virtual: true });

// 呼ばれた順を1つの配列に集める（守りの順の確かめ用）
const mockCalls: string[] = [];

const mockDenyIfCsrfInvalid = jest.fn();
jest.mock('@/features/cart/services/shopping-context', () => ({
  denyIfCsrfInvalid: (...args: unknown[]) => mockDenyIfCsrfInvalid(...args),
}));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
// ゲストにログインを必須にしないことの確かめ用（呼ばれたら落とす）
const mockAuthenticate = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));
const mockServiceClient = { name: 'service-client' };
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
}));
// 誤りの型（OrderStatusStoreError）は本物を残し、DB を呼ぶ2つの関数だけ差し替える
const mockGetLink = jest.fn();
const mockVerifyPhone = jest.fn();
jest.mock('@/lib/orders/status/status-store', () => ({
  ...jest.requireActual('@/lib/orders/status/status-store'),
  getOrderStatusLink: (...args: unknown[]) => mockGetLink(...args),
  verifyOrderStatusPhone: (...args: unknown[]) => mockVerifyPhone(...args),
}));
// 入力の読み取りが呼ばれた順だけ記録し、中身は本物を使う
jest.mock('@/lib/orders/status/status-phone', () => {
  const actual = jest.requireActual('@/lib/orders/status/status-phone');
  return {
    ...actual,
    parseOrderStatusLastFour: (value: unknown) => {
      mockCalls.push('parse');
      return actual.parseOrderStatusLastFour(value);
    },
  };
});

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/order-status/[token]/verify/route';
import { OrderStatusStoreError } from '@/lib/orders/status/status-store';
import { ORDER_STATUS_ERROR_MESSAGES } from '@/lib/orders/status/status-messages';
import { ORDER_STATUS_SESSION_COOKIE_NAME, readOrderStatusSession } from '@/lib/orders/status/status-session';

// 試験用の作り物の値だけを使う（本物の鍵・トークン・電話は使わない）
const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde';
const SECRET = 'order-status-verify-route-test-secret';
const LAST_FOUR = '4321';
const HOUR = 3600 * 1000;

const env = process.env as Record<string, string | undefined>;
const savedEnv: Record<string, string | undefined> = {};

const NOT_FOUND_BODY = { error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_NOT_FOUND, code: 'ORDER_STATUS_NOT_FOUND' };

function linkAnswer(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID,
    customerId: null,
    verifyUntil: new Date(Date.now() + 10 * 24 * HOUR).toISOString(),
    failedAttempts: 0,
    phoneAvailable: true,
    ...overrides,
  };
}

function okAnswer(verifyUntil: string = new Date(Date.now() + 10 * 24 * HOUR).toISOString()) {
  return { result: 'ok', verifyUntil, failedAttempts: 0 };
}

function limiterResponse(status: number, retryAfter: string, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'Retry-After': retryAfter },
  });
}

function postRequest(options: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
  const token = options.token ?? TOKEN;
  return new NextRequest(`http://localhost/api/order-status/${token}/verify`, {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json', ...options.headers },
    body: options.rawBody ?? JSON.stringify(options.body ?? { lastFour: LAST_FOUR }),
  });
}

async function post(options: Parameters<typeof postRequest>[0] = {}) {
  const response = await POST(postRequest(options), { params: Promise.resolve({ token: options.token ?? TOKEN }) });
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

// 誰が console に何を出したか。Error は開いて cause まで文字にして、漏れを探す
function loggedText(spies: jest.SpyInstance[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls.flat())
    .map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message} ${JSON.stringify(arg.cause)}` : String(arg)))
    .join(' ');
}

let consoleSpies: jest.SpyInstance[];

beforeEach(() => {
  jest.resetAllMocks();
  mockCalls.length = 0;
  for (const name of ['ORDER_STATUS_SESSION_SECRET', 'JWT_SECRET']) {
    savedEnv[name] = env[name];
  }
  env.ORDER_STATUS_SESSION_SECRET = SECRET;
  delete env.JWT_SECRET;

  mockDenyIfCsrfInvalid.mockImplementation(async () => {
    mockCalls.push('csrf');
    return null;
  });
  mockEnforceRateLimit.mockImplementation(async (args: { limit: number; windowSeconds: number; subject?: string }) => {
    mockCalls.push(`${args.subject === undefined ? 'ip' : 'order'}:${args.limit}/${args.windowSeconds}`);
    return undefined;
  });
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
  mockGetLink.mockImplementation(async () => {
    mockCalls.push('link');
    return linkAnswer();
  });
  mockVerifyPhone.mockImplementation(async () => {
    mockCalls.push('verify');
    return okAnswer();
  });
  consoleSpies = (['error', 'warn', 'log', 'info', 'debug'] as const).map((name) =>
    jest.spyOn(console, name).mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const name of ['ORDER_STATUS_SESSION_SECRET', 'JWT_SECRET']) {
    if (savedEnv[name] === undefined) {
      delete env[name];
    } else {
      env[name] = savedEnv[name];
    }
  }
  jest.restoreAllMocks();
});

describe('POST /api/order-status/[token]/verify の守りの順', () => {
  test('verifyはCSRFからIP、存在、注文枠、入力、DB比較の順', async () => {
    const { response } = await post();

    expect(response.status).toBe(200);
    expect(mockCalls).toEqual(['csrf', 'ip:30/600', 'link', 'order:5/900', 'parse', 'verify']);
  });

  test('存在しないトークンはIP枠だけ数えて404', async () => {
    mockGetLink.mockImplementation(async () => {
      mockCalls.push('link');
      return null;
    });

    const { response, body } = await post();

    expect(response.status).toBe(404);
    expect(body).toEqual(NOT_FOUND_BODY);
    const orderLimitCalls = mockEnforceRateLimit.mock.calls.filter(([args]) => args.subject !== undefined);
    expect(orderLimitCalls).toHaveLength(0);
    expect(mockCalls).toEqual(['csrf', 'ip:30/600', 'link']);
    expect(mockVerifyPhone).not.toHaveBeenCalled();
  });

  test('形の違うトークンは注文を読まず、同じ404（IP枠だけ数える）', async () => {
    const { response, body } = await post({ token: 'short-token' });

    expect(response.status).toBe(404);
    expect(body).toEqual(NOT_FOUND_BODY);
    expect(mockCalls).toEqual(['csrf', 'ip:30/600']);
    expect(mockGetLink).not.toHaveBeenCalled();
    expect(mockVerifyPhone).not.toHaveBeenCalled();
  });

  test('比較中に消えた・隠された注文も、同じ404（注文枠は数えた後）', async () => {
    mockVerifyPhone.mockImplementation(async () => {
      mockCalls.push('verify');
      return null;
    });

    const { response, body } = await post();

    expect(response.status).toBe(404);
    expect(body).toEqual(NOT_FOUND_BODY);
    expect(mockCalls).toEqual(['csrf', 'ip:30/600', 'link', 'order:5/900', 'parse', 'verify']);
  });

  test('CSRF拒否は403のFORBIDDENで、IP枠もDB比較も呼ばない', async () => {
    mockDenyIfCsrfInvalid.mockImplementation(async () => {
      mockCalls.push('csrf');
      return new Response(JSON.stringify({ error: 'Forbidden', reason: 'CSRF validation failed' }), { status: 403 });
    });

    const { response, body } = await post();

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_FORBIDDEN, code: 'ORDER_STATUS_FORBIDDEN' });
    expect(mockCalls).toEqual(['csrf']);
    expect(mockGetLink).not.toHaveBeenCalled();
    expect(mockVerifyPhone).not.toHaveBeenCalled();
  });

  test('CSRFの確かめ自体が失敗した時は500のFAILEDで、後ろを呼ばない', async () => {
    mockDenyIfCsrfInvalid.mockImplementation(async () => {
      mockCalls.push('csrf');
      return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 });
    });

    const { response, body } = await post();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_FAILED, code: 'ORDER_STATUS_FAILED' });
    expect(mockCalls).toEqual(['csrf']);
    expect(mockVerifyPhone).not.toHaveBeenCalled();
  });

  test('IP枠超過は429で、Retry-Afterを保ち、リンクもDB比較も呼ばない', async () => {
    mockEnforceRateLimit.mockImplementation(async (args: { limit: number; windowSeconds: number; subject?: string }) => {
      mockCalls.push(`${args.subject === undefined ? 'ip' : 'order'}:${args.limit}/${args.windowSeconds}`);
      return limiterResponse(429, '600', 'Too many requests');
    });

    const { response, body } = await post();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('600');
    expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_RATE_LIMITED, code: 'ORDER_STATUS_RATE_LIMITED' });
    expect(mockCalls).toEqual(['csrf', 'ip:30/600']);
    expect(mockGetLink).not.toHaveBeenCalled();
    expect(mockVerifyPhone).not.toHaveBeenCalled();
  });

  test('IP枠の障害（503）は制限無しで続けず、503のTEMPORARILY_UNAVAILABLEでRetry-Afterを保つ', async () => {
    mockEnforceRateLimit.mockImplementation(async (args: { limit: number; windowSeconds: number; subject?: string }) => {
      mockCalls.push(`${args.subject === undefined ? 'ip' : 'order'}:${args.limit}/${args.windowSeconds}`);
      return limiterResponse(503, '600', 'Rate limiter unavailable');
    });

    const { response, body } = await post();

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('600');
    expect(body).toEqual({
      error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_TEMPORARILY_UNAVAILABLE,
      code: 'ORDER_STATUS_TEMPORARILY_UNAVAILABLE',
    });
    expect(mockGetLink).not.toHaveBeenCalled();
    expect(mockVerifyPhone).not.toHaveBeenCalled();
  });

  test('注文枠超過は429で、入力の読み取りもDB比較も呼ばない', async () => {
    mockEnforceRateLimit.mockImplementation(async (args: { limit: number; windowSeconds: number; subject?: string }) => {
      mockCalls.push(`${args.subject === undefined ? 'ip' : 'order'}:${args.limit}/${args.windowSeconds}`);
      return args.subject === undefined ? undefined : limiterResponse(429, '900', 'Too many requests');
    });

    const { response, body } = await post();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('900');
    expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_RATE_LIMITED, code: 'ORDER_STATUS_RATE_LIMITED' });
    expect(mockCalls).toEqual(['csrf', 'ip:30/600', 'link', 'order:5/900']);
    expect(mockVerifyPhone).not.toHaveBeenCalled();
  });

  test('注文枠の障害（503）も、入力の読み取りもDB比較も呼ばずに止める', async () => {
    mockEnforceRateLimit.mockImplementation(async (args: { limit: number; windowSeconds: number; subject?: string }) => {
      mockCalls.push(`${args.subject === undefined ? 'ip' : 'order'}:${args.limit}/${args.windowSeconds}`);
      return args.subject === undefined ? undefined : limiterResponse(503, '900', 'Rate limiter unavailable');
    });

    const { response, body } = await post();

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('900');
    expect(body.code).toBe('ORDER_STATUS_TEMPORARILY_UNAVAILABLE');
    expect(mockVerifyPhone).not.toHaveBeenCalled();
  });

  test('制限は同じ窓口名で、注文枠のsubjectはlinkのUUID（tokenではない）、IP枠はsubject無し', async () => {
    await post();

    const [ipArgs, orderArgs] = mockEnforceRateLimit.mock.calls.map(([args]) => args);
    expect(ipArgs).toMatchObject({ endpoint: 'order-status:verify', limit: 30, windowSeconds: 600 });
    expect(ipArgs.subject).toBeUndefined();
    expect(orderArgs).toMatchObject({ endpoint: 'order-status:verify', limit: 5, windowSeconds: 900, subject: ORDER_ID });
    expect(orderArgs.subject).not.toBe(TOKEN);
    expect(JSON.stringify(mockEnforceRateLimit.mock.calls)).not.toContain(TOKEN);
  });

  test('ゲストにログインを必須にしない（認証を呼ばない）', async () => {
    const { response } = await post();

    expect(response.status).toBe(200);
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });
});

describe('入力の確かめ', () => {
  test.each([
    ['壊れたJSON', { rawBody: '{"lastFour":' }],
    ['空の本文', { rawBody: '' }],
    ['配列', { body: [LAST_FOUR] }],
    ['文字列そのもの', { body: LAST_FOUR }],
    ['lastFourが無い', { body: {} }],
    ['余計なキーがある', { body: { lastFour: LAST_FOUR, extra: 1 } }],
    ['別のキー名', { body: { last_four: LAST_FOUR } }],
    ['数値', { body: { lastFour: 4321 } }],
    ['3桁', { body: { lastFour: '432' } }],
    ['5桁', { body: { lastFour: '43210' } }],
    ['空文字', { body: { lastFour: '' } }],
    ['65字', { body: { lastFour: '4'.repeat(65) } }],
  ] as const)('入力不正（%s）は400のINPUT_INVALIDで、DB比較は0回', async (_name, options) => {
    const { response, body } = await post(options);

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_INPUT_INVALID, code: 'ORDER_STATUS_INPUT_INVALID' });
    expect(mockVerifyPhone).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
    // 注文枠は入力検証の前に数えている（不正入力でも短い枠は消費する）
    expect(mockEnforceRateLimit.mock.calls.some(([args]) => args.subject === ORDER_ID)).toBe(true);
  });

  test('全角数字・区切りの混じった4桁は、数字にそろえてDBへ渡す', async () => {
    await post({ body: { lastFour: '４３-２１' } });

    expect(mockVerifyPhone).toHaveBeenCalledWith(mockServiceClient, { token: TOKEN, lastFour: LAST_FOUR });
  });
});

describe('DBの答えの写し方', () => {
  test('成功だけに期限の早い方の確認Cookieを発行する', async () => {
    // 期限が24時間より先 → 発行から24時間
    const before = Math.floor(Date.now() / 1000);
    const { response, body } = await post();
    const after = Math.floor(Date.now() / 1000);

    expect(response.status).toBe(200);
    const cookieNames = response.cookies.getAll().map((cookie) => cookie.name);
    expect(cookieNames).toEqual(['sb-order-status']);

    const cookie = response.cookies.get(ORDER_STATUS_SESSION_COOKIE_NAME)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'strict', path: `/api/order-status/${TOKEN}` });
    expect(cookie.value).not.toContain(TOKEN);
    const session = readOrderStatusSession(cookie.value, {
      orderId: ORDER_ID,
      token: TOKEN,
      verifyUntil: new Date(Date.now() + 10 * 24 * HOUR).toISOString(),
    });
    expect(session).not.toBeNull();
    expect(session!.iat).toBeGreaterThanOrEqual(before);
    expect(session!.iat).toBeLessThanOrEqual(after);
    expect(session!.exp - session!.iat).toBe(86400);
    // expiresAt は Cookie の exp と同じ時刻
    expect(body).toEqual({ ok: true, expiresAt: new Date(session!.exp * 1000).toISOString() });
    // Max-Age が正（Next は Expires を発行時刻 + Max-Age で作り直すので、Expires は exp と最大で約1秒ずれる）
    expect(cookie.maxAge).toBe(session!.exp - session!.iat);
    const expiresAt = new Date(cookie.expires ?? 0).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(session!.exp * 1000);
    expect(expiresAt).toBeLessThan(session!.exp * 1000 + 2000);
  });

  test('確認の期限が24時間より前なら、その期限までのCookieを発行する', async () => {
    const verifyUntil = new Date(Date.now() + 2 * HOUR).toISOString();
    mockVerifyPhone.mockResolvedValue(okAnswer(verifyUntil));

    const { response, body } = await post();

    expect(response.status).toBe(200);
    const cookie = response.cookies.get(ORDER_STATUS_SESSION_COOKIE_NAME)!;
    const session = readOrderStatusSession(cookie.value, { orderId: ORDER_ID, token: TOKEN, verifyUntil });
    expect(session).not.toBeNull();
    expect(session!.exp).toBe(Math.floor(Date.parse(verifyUntil) / 1000));
    expect(cookie.maxAge).toBe(session!.exp - session!.iat);
    expect(cookie.maxAge).toBeLessThanOrEqual(2 * 3600);
    expect(body).toEqual({ ok: true, expiresAt: new Date(session!.exp * 1000).toISOString() });
  });

  test('成功以外では確認Cookieを発行しない', async () => {
    const failing = [
      { result: 'mismatch', verifyUntil: linkAnswer().verifyUntil, failedAttempts: 1 },
      { result: 'locked', verifyUntil: linkAnswer().verifyUntil, failedAttempts: 20 },
      { result: 'unavailable', verifyUntil: linkAnswer().verifyUntil, failedAttempts: 0 },
      { result: 'expired', verifyUntil: null, failedAttempts: 0 },
    ];
    for (const answer of failing) {
      mockVerifyPhone.mockResolvedValue(answer);
      const { response } = await post();
      expect(response.status).not.toBe(200);
      expect(response.cookies.getAll()).toEqual([]);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
  });

  test('20回目の不一致は欄を止め、429は合計に数えない', async () => {
    const verifyUntil = linkAnswer().verifyUntil;

    mockVerifyPhone.mockResolvedValue({ result: 'mismatch', verifyUntil, failedAttempts: 19 });
    const nineteenth = await post();
    expect(nineteenth.response.status).toBe(400);
    expect(nineteenth.body).toMatchObject({ code: 'ORDER_STATUS_MISMATCH', verifiable: true, reason: null });

    mockVerifyPhone.mockResolvedValue({ result: 'mismatch', verifyUntil, failedAttempts: 20 });
    const twentieth = await post();
    expect(twentieth.response.status).toBe(400);
    expect(twentieth.body).toMatchObject({ code: 'ORDER_STATUS_MISMATCH', verifiable: false, reason: 'locked' });

    // 429 の応答は DB 比較（＝失敗の合計の加算）に届かない
    mockVerifyPhone.mockClear();
    mockEnforceRateLimit.mockImplementation(async (args: { subject?: string }) =>
      args.subject === undefined ? undefined : limiterResponse(429, '900', 'Too many requests'),
    );
    const limited = await post();
    expect(limited.response.status).toBe(429);
    const verifyCallsAfter429 = mockVerifyPhone.mock.calls.length;
    expect(verifyCallsAfter429).toBe(0);
  });

  test.each([
    ['mismatch（19回）', { result: 'mismatch', failedAttempts: 19 }, 400, 'ORDER_STATUS_MISMATCH', true, null],
    ['mismatch（20回目）', { result: 'mismatch', failedAttempts: 20 }, 400, 'ORDER_STATUS_MISMATCH', false, 'locked'],
    ['既にlocked', { result: 'locked', failedAttempts: 20 }, 423, 'ORDER_STATUS_LOCKED', false, 'locked'],
    ['unavailable', { result: 'unavailable', failedAttempts: 0 }, 409, 'ORDER_STATUS_UNAVAILABLE', false, 'unavailable'],
    ['expired', { result: 'expired', failedAttempts: 0 }, 410, 'ORDER_STATUS_EXPIRED', false, 'expired'],
  ] as const)('%s は C-3 の表どおりのHTTPと固定文', async (_name, answer, status, code, verifiable, reason) => {
    mockVerifyPhone.mockResolvedValue({ ...answer, verifyUntil: linkAnswer().verifyUntil });

    const { response, body } = await post();

    expect(response.status).toBe(status);
    expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES[code], code, verifiable, reason });
  });

  test('okなのに期限が無い答えは成功にせず500', async () => {
    mockVerifyPhone.mockResolvedValue({ result: 'ok', verifyUntil: null, failedAttempts: 0 });

    const { response, body } = await post();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_FAILED, code: 'ORDER_STATUS_FAILED' });
    expect(response.cookies.getAll()).toEqual([]);
  });
});

describe('失敗の写し方とログ', () => {
  test('DB専用の ORDER_STATUS_ARGUMENT_INVALID は入力400、ORDER_NOT_FOUND は404に写す', async () => {
    mockVerifyPhone.mockRejectedValueOnce(
      new OrderStatusStoreError('verify_order_status_phone', { message: 'ORDER_STATUS_ARGUMENT_INVALID', code: '22023' }),
    );
    const invalid = await post();
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_INPUT_INVALID, code: 'ORDER_STATUS_INPUT_INVALID' });

    mockVerifyPhone.mockRejectedValueOnce(
      new OrderStatusStoreError('verify_order_status_phone', { message: 'ORDER_NOT_FOUND', code: 'P0002' }),
    );
    const missing = await post();
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual(NOT_FOUND_BODY);
  });

  test('それ以外のDBの誤り・例外は500のFAILEDで、DBの文・SQLSTATEを返さない', async () => {
    const dbError = { message: 'relation private.order_status_links secret-db-text', code: 'XX000', details: 'phone=09012345678' };
    mockVerifyPhone.mockRejectedValueOnce(new OrderStatusStoreError('verify_order_status_phone', dbError));
    const fromStore = await post();
    mockGetLink.mockRejectedValueOnce(new Error('connect ECONNREFUSED secret-host'));
    const fromLink = await post();
    mockCreateServiceRoleClient.mockRejectedValueOnce(new Error('service key missing'));
    const fromClient = await post();

    for (const { response, body } of [fromStore, fromLink, fromClient]) {
      expect(response.status).toBe(500);
      expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_FAILED, code: 'ORDER_STATUS_FAILED' });
    }
    expect(JSON.stringify([fromStore.body, fromLink.body, fromClient.body])).not.toMatch(/secret|XX000|09012345678|ECONNREFUSED/);
  });

  test('署名鍵が無い時は成功にせず500（Cookieを出さない）', async () => {
    delete env.ORDER_STATUS_SESSION_SECRET;
    delete env.JWT_SECRET;

    const { response, body } = await post();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_FAILED, code: 'ORDER_STATUS_FAILED' });
    expect(response.cookies.getAll()).toEqual([]);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('ログは固定codeだけで、トークン・下4桁・DBの文・Cookie・鍵を出さない', async () => {
    mockVerifyPhone.mockRejectedValueOnce(
      new OrderStatusStoreError('verify_order_status_phone', { message: `leak ${TOKEN} ${LAST_FOUR} 09012345678`, code: 'XX000' }),
    );
    await post();
    delete env.ORDER_STATUS_SESSION_SECRET;
    await post();
    env.ORDER_STATUS_SESSION_SECRET = SECRET;
    const ok = await post();
    const cookieValue = ok.response.cookies.get(ORDER_STATUS_SESSION_COOKIE_NAME)!.value;

    const text = loggedText(consoleSpies);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(LAST_FOUR);
    expect(text).not.toContain('09012345678');
    expect(text).not.toContain('leak');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(cookieValue);
    // 出してよいのは固定の記号だけ
    const printed = consoleSpies.flatMap((spy) => spy.mock.calls.flat());
    expect(printed.length).toBeGreaterThan(0);
    for (const argument of printed) {
      expect(argument).toBe('ORDER_STATUS_FAILED');
    }
  });
});

describe('応答の守り', () => {
  test('全ての成功と拒否と例外でno-store（Referrer-Policyはno-referrer）', async () => {
    const responses: Response[] = [];
    const collect = async (setup?: () => void, options?: Parameters<typeof postRequest>[0]) => {
      setup?.();
      responses.push((await post(options)).response);
    };
    const verifyUntil = linkAnswer().verifyUntil;

    await collect();
    await collect(undefined, { token: 'short-token' });
    await collect(undefined, { rawBody: 'not json' });
    await collect(() => mockGetLink.mockImplementationOnce(async () => null));
    await collect(() => mockVerifyPhone.mockResolvedValueOnce(null));
    for (const answer of [
      { result: 'mismatch', verifyUntil, failedAttempts: 3 },
      { result: 'mismatch', verifyUntil, failedAttempts: 20 },
      { result: 'locked', verifyUntil, failedAttempts: 20 },
      { result: 'unavailable', verifyUntil, failedAttempts: 0 },
      { result: 'expired', verifyUntil: null, failedAttempts: 0 },
    ]) {
      await collect(() => mockVerifyPhone.mockResolvedValueOnce(answer));
    }
    await collect(() => mockDenyIfCsrfInvalid.mockResolvedValueOnce(new Response('{}', { status: 403 })));
    await collect(() => mockDenyIfCsrfInvalid.mockResolvedValueOnce(new Response('{}', { status: 500 })));
    await collect(() => mockEnforceRateLimit.mockResolvedValueOnce(limiterResponse(429, '600', 'x')));
    await collect(() => mockEnforceRateLimit.mockResolvedValueOnce(limiterResponse(503, '600', 'x')));
    await collect(() => mockVerifyPhone.mockRejectedValueOnce(new Error('boom')));
    await collect(() => mockCreateServiceRoleClient.mockRejectedValueOnce(new Error('boom')));

    expect(responses.length).toBeGreaterThanOrEqual(16);
    const cacheControls = responses.map((response) => response.headers.get('Cache-Control'));
    expect(cacheControls.every((value) => value === 'no-store')).toBe(true);
    expect(responses.every((response) => response.headers.get('Referrer-Policy') === 'no-referrer')).toBe(true);
    expect(new Set(responses.map((response) => response.status))).toEqual(
      new Set([200, 400, 403, 404, 409, 410, 423, 429, 500, 503]),
    );
  });
});
