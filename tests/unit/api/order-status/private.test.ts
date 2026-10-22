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

// 呼ばれた順を1つの配列に集める（認可の前に個人情報を読まないことの確かめ用）
const mockCalls: string[] = [];

const mockAuthenticate = jest.fn();
jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
}));
const mockServiceClient = { rpc: jest.fn(), from: jest.fn() };
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: (...args: unknown[]) => mockCreateServiceRoleClient(...args),
}));
// 誤りの型・期限の判定は本物を残し、DB を呼ぶ2つの関数だけ差し替える
const mockGetLink = jest.fn();
const mockLoadPrivateInput = jest.fn();
jest.mock('@/lib/orders/status/status-store', () => ({
  ...jest.requireActual('@/lib/orders/status/status-store'),
  getOrderStatusLink: (...args: unknown[]) => mockGetLink(...args),
  loadOrderStatusPrivateInput: (...args: unknown[]) => mockLoadPrivateInput(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/order-status/[token]/private/route';
import { OrderStatusStoreError } from '@/lib/orders/status/status-store';
import { ORDER_STATUS_ERROR_MESSAGES } from '@/lib/orders/status/status-messages';
import { ORDER_STATUS_SESSION_COOKIE_NAME, createOrderStatusSession } from '@/lib/orders/status/status-session';
import type { CustomerOrderPrivateInput } from '@/lib/orders/customer-order-view-types';

// 試験用の作り物の値だけを使う（本物の鍵・トークン・電話は使わない）
const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const OWNER_ID = 'b2c3d4e5-2222-4333-8444-555566667777';
const OTHER_MEMBER_ID = 'c3d4e5f6-3333-4444-8555-666677778888';
const FULFILLMENT_ID = 'd4e5f6a7-4444-4555-8666-777788889999';
const RETURN_ID = 'e5f6a7b8-5555-4666-8777-88889999aaaa';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde';
const SECRET = 'order-status-private-route-test-secret';
const HOUR = 3600 * 1000;

const env = process.env as Record<string, string | undefined>;
const savedEnv: Record<string, string | undefined> = {};

const NOT_FOUND_BODY = { error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_NOT_FOUND, code: 'ORDER_STATUS_NOT_FOUND' };
const FAILED_BODY = { error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_FAILED, code: 'ORDER_STATUS_FAILED' };

function future(hours: number): string {
  return new Date(Date.now() + hours * HOUR).toISOString();
}

function linkAnswer(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID,
    customerId: OWNER_ID,
    verifyUntil: future(10 * 24),
    failedAttempts: 3,
    phoneAvailable: true,
    ...overrides,
  };
}

const PRIVATE_INPUT: CustomerOrderPrivateInput = {
  order: {
    shipping_full_name: '試験 太郎',
    shipping_postal_code: '1500001',
    shipping_prefecture: '東京都',
    shipping_city: '渋谷区',
    shipping_address: '神宮前1-2-3',
    shipping_building: 'テストビル101',
    shipping_phone: '09000000000',
    shipping_email: 'customer@example.com',
  },
  paymentMethod: 'stripe_card',
  fulfillments: [
    { fulfillmentId: FULFILLMENT_ID, number: 1, shippingCarrier: null, trackingNumber: 'TEST-TRACK-0001', cancelledAt: null },
  ],
  returnSection: {
    returns: [
      {
        id: RETURN_ID,
        number: 1,
        label: 'R-1',
        status: 'open',
        customerStatus: 'accepted',
        returnMethod: 'customer_ships',
        returnShippingPayer: 'customer',
        returnShippingFee: 0,
        returnAddress: { name: '返送センター', postalCode: '1000001', address: '東京都千代田区1-1', phone: '0300000000' },
        requestedAt: '2026-10-20T00:00:00.000Z',
        closedAt: null,
        lines: [],
        refundAmount: null,
        sentBack: [{ itemName: '品', color: null, size: null, quantity: 1, message: null, carrier: null, trackingNumber: 'TEST-SENT-0001' }],
        declineMessage: null,
        exchangeShipping: 'none',
      },
    ],
    cancelRequests: [],
    availability: { returns: 'none', endedOn: null, cancel: false },
  },
};

// P9 の完全な答え。お届け先の名前・郵便番号・住所・電話、連絡先メール、支払方法、発送の伝票番号、返品の返送先と送り返しの伝票番号だけ
const EXPECTED_PRIVATE_VIEW = {
  shipping: { fullName: '試験 太郎', postalCode: '1500001', address: '東京都 渋谷区 神宮前1-2-3 テストビル101', phone: '09000000000' },
  contactEmail: 'customer@example.com',
  paymentMethod: 'クレジットカード',
  shipments: [{ id: FULFILLMENT_ID, number: 1, trackingNumber: 'TEST-TRACK-0001', trackingUrl: null }],
  returns: [
    {
      id: RETURN_ID,
      returnAddress: { name: '返送センター', postalCode: '1000001', address: '東京都千代田区1-1', phone: '0300000000' },
      sentBack: [{ index: 0, trackingNumber: 'TEST-SENT-0001' }],
    },
  ],
};

/** 確認済みの印の Cookie の値（鍵は試験用）。now を過去にして、印自身の期限切れも作れる */
function stampValue(options: { verifyUntil?: string; now?: Date } = {}): string {
  return createOrderStatusSession({
    orderId: ORDER_ID,
    token: TOKEN,
    verifyUntil: options.verifyUntil ?? future(10 * 24),
    now: options.now,
  }).value;
}

type RequestOptions = { token?: string; stamp?: string; access?: string; refresh?: string; bearer?: string; search?: string };

function getRequest(options: RequestOptions = {}) {
  const cookies: string[] = [];
  if (options.stamp) cookies.push(`${ORDER_STATUS_SESSION_COOKIE_NAME}=${options.stamp}`);
  if (options.access) cookies.push(`sb-access-token=${options.access}`);
  if (options.refresh) cookies.push(`sb-refresh-token=${options.refresh}`);
  const headers: Record<string, string> = {};
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  return new NextRequest(`http://localhost/api/order-status/${options.token ?? TOKEN}/private${options.search ?? ''}`, {
    method: 'GET',
    headers,
  });
}

async function get(options: RequestOptions = {}) {
  const response = await GET(getRequest(options), { params: Promise.resolve({ token: options.token ?? TOKEN }) });
  const body = (await response.json()) as Record<string, any>;
  return { response, body };
}

function authOk(sub: string) {
  mockAuthenticate.mockImplementation(async () => {
    mockCalls.push('auth');
    return { ok: true, claims: { sub, session_id: 'session-1' } };
  });
}

function authFail(reason: 'missing' | 'invalid' | 'revoked' | 'unavailable') {
  mockAuthenticate.mockImplementation(async () => {
    mockCalls.push('auth');
    return { ok: false, reason };
  });
}

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

  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
  mockGetLink.mockImplementation(async () => {
    mockCalls.push('link');
    return linkAnswer();
  });
  mockLoadPrivateInput.mockImplementation(async () => {
    mockCalls.push('private');
    return PRIVATE_INPUT;
  });
  authFail('missing');
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

describe('GET /api/order-status/[token]/private の認可', () => {
  test('ログイン印の無いゲストは200のnoneで認証を呼ばない', async () => {
    const { response, body } = await get();

    expect(response.status).toBe(200);
    expect(body).toEqual({ access: 'none', verifiable: true, reason: null });
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(mockLoadPrivateInput).not.toHaveBeenCalled();
  });

  test('noneは電話の有無などで決まる確認の可否だけを返す（data・失敗数・期限・customerIdを足さない）', async () => {
    const cases = [
      [linkAnswer({ phoneAvailable: false }), { access: 'none', verifiable: false, reason: 'unavailable' }],
      [linkAnswer({ failedAttempts: 20 }), { access: 'none', verifiable: false, reason: 'locked' }],
      [linkAnswer({ verifyUntil: future(-1) }), { access: 'none', verifiable: false, reason: 'expired' }],
      [linkAnswer({ verifyUntil: null }), { access: 'none', verifiable: false, reason: 'expired' }],
      [linkAnswer({ verifyUntil: future(5), customerId: null }), { access: 'none', verifiable: true, reason: null }],
    ] as const;
    for (const [link, expected] of cases) {
      mockGetLink.mockResolvedValueOnce(link);
      const { response, body } = await get();
      expect(response.status).toBe(200);
      expect(body).toEqual(expected);
    }
  });

  test('queryで認可情報を受け取らない', async () => {
    const { body } = await get({ search: `?access=member&customerId=${OWNER_ID}&token=${TOKEN}&verified=1` });

    expect(body).toEqual({ access: 'none', verifiable: true, reason: null });
    expect(mockLoadPrivateInput).not.toHaveBeenCalled();
  });

  test('別の会員は200のnone、印があればverified', async () => {
    authOk(OTHER_MEMBER_ID);
    const accesses: string[] = [];

    const loggedInOther = await get({ access: 'other-member-access' });
    expect(loggedInOther.response.status).toBe(200);
    expect(loggedInOther.body).toEqual({ access: 'none', verifiable: true, reason: null });
    accesses.push(loggedInOther.body.access);

    const withStamp = await get({ access: 'other-member-access', stamp: stampValue() });
    expect(withStamp.response.status).toBe(200);
    accesses.push(withStamp.body.access);

    expect(accesses).toEqual(['none', 'verified']);
  });

  test('持ち主の会員はmember（expiresAtはnull）で、確認の印が無くてもP9の完全な答えを受け取る', async () => {
    authOk(OWNER_ID);

    const { response, body } = await get({ access: 'owner-access' });

    expect(response.status).toBe(200);
    expect(body).toEqual({ access: 'member', data: EXPECTED_PRIVATE_VIEW, expiresAt: null });
    expect(mockCalls).toEqual(['link', 'auth', 'private']);
    expect(mockLoadPrivateInput).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
  });

  test('持ち主がいない注文（ゲストの注文）は、認証が通った会員でもnone', async () => {
    mockGetLink.mockResolvedValue(linkAnswer({ customerId: null }));
    authOk(OWNER_ID);

    const { response, body } = await get({ access: 'member-access' });

    expect(response.status).toBe(200);
    expect(body).toEqual({ access: 'none', verifiable: true, reason: null });
    expect(mockLoadPrivateInput).not.toHaveBeenCalled();
  });

  test('有効な確認の印はverifiedで、P9の完全な答えと印の期限を返す（認証は呼ばない）', async () => {
    const verifyUntil = future(2);
    mockGetLink.mockResolvedValue(linkAnswer({ verifyUntil }));

    const { response, body } = await get({ stamp: stampValue({ verifyUntil }) });

    expect(response.status).toBe(200);
    expect(body).toEqual({
      access: 'verified',
      data: EXPECTED_PRIVATE_VIEW,
      expiresAt: new Date(Math.floor(Date.parse(verifyUntil) / 1000) * 1000).toISOString(),
    });
    expect(Object.keys(body).sort()).toEqual(['access', 'data', 'expiresAt']);
    expect(Object.keys(body.data).sort()).toEqual(['contactEmail', 'paymentMethod', 'returns', 'shipments', 'shipping']);
    expect(mockAuthenticate).not.toHaveBeenCalled();
    expect(mockGetLink).toHaveBeenCalledWith(mockServiceClient, TOKEN);
    // この試験は mockGetLink を置き換えているので、記録に残るのは個人情報の読み出しだけ
    expect(mockCalls).toEqual(['private']);
  });

  test('有効な印があれば古いログイン印で401にしない', async () => {
    authFail('invalid');

    const { response, body } = await get({ stamp: stampValue(), access: 'stale-access', refresh: 'stale-refresh', bearer: 'stale-bearer' });

    const access = body.access;
    expect(response.status).toBe(200);
    expect(access).toBe('verified');
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  test('古いログイン印だけとrefreshだけは401、認証不能は503', async () => {
    const statuses: number[] = [];

    authFail('invalid');
    const staleAccess = await get({ access: 'stale-access' });
    statuses.push(staleAccess.response.status);
    expect(staleAccess.body).toEqual({
      access: 'none',
      verifiable: true,
      reason: null,
      error: 'Unauthorized',
      code: 'ORDER_STATUS_AUTH_REQUIRED',
    });
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);

    authFail('missing');
    const refreshOnly = await get({ refresh: 'only-refresh' });
    statuses.push(refreshOnly.response.status);
    expect(refreshOnly.body).toEqual({
      access: 'none',
      verifiable: true,
      reason: null,
      error: 'Unauthorized',
      code: 'ORDER_STATUS_AUTH_REQUIRED',
    });

    authFail('unavailable');
    const unavailable = await get({ access: 'maybe-valid-access' });
    statuses.push(unavailable.response.status);
    expect(unavailable.response.headers.get('Retry-After')).toBe('30');
    expect(unavailable.body).toEqual({
      error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_TEMPORARILY_UNAVAILABLE,
      code: 'ORDER_STATUS_TEMPORARILY_UNAVAILABLE',
    });

    expect(statuses).toEqual([401, 401, 503]);
    expect(mockLoadPrivateInput).not.toHaveBeenCalled();
  });

  test.each([
    ['Authorizationヘッダー', { bearer: 'stale-bearer' }],
    ['アクセスのCookie', { access: 'stale-access' }],
    ['refreshのCookie', { refresh: 'only-refresh' }],
  ] as const)('ログインの印の持ち込み（%s）があり、認証が失敗(invalid/revoked/missing)したら401', async (_name, options) => {
    for (const reason of ['invalid', 'revoked', 'missing'] as const) {
      authFail(reason);
      const { response, body } = await get(options);
      expect(response.status).toBe(401);
      expect(body).toMatchObject({ access: 'none', error: 'Unauthorized', code: 'ORDER_STATUS_AUTH_REQUIRED' });
      expect(body).not.toHaveProperty('data');
    }
  });

  test('印が無効なだけ（持ち込みなし）では401にしない', async () => {
    const { response, body } = await get({ stamp: 'not-a-valid.stamp' });

    expect(response.status).toBe(200);
    expect(body).toEqual({ access: 'none', verifiable: true, reason: null });
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  test('DBの期限と印の期限を毎回照合する', async () => {
    // 印自身の期限が切れている（2時間前に発行、1時間前に切れた）。DB の期限は先
    const past = new Date(Date.now() - 2 * HOUR);
    const ownExpired = await get({
      stamp: stampValue({ verifyUntil: new Date(past.getTime() + HOUR).toISOString(), now: past }),
    });
    expect(ownExpired.response.status).toBe(200);
    expect(ownExpired.body).toEqual({ access: 'none', verifiable: true, reason: null });

    // 印は有効だが、DB の期限が過ぎた
    const stamp = stampValue();
    mockGetLink.mockResolvedValue(linkAnswer({ verifyUntil: future(-1) }));
    const dbExpired = await get({ stamp });
    expect(dbExpired.body).toEqual({ access: 'none', verifiable: false, reason: 'expired' });
    const expiredStampAccess = dbExpired.body.access;
    expect(expiredStampAccess).toBe('none');

    // DB の期限が印の期限より前に縮んだ（印は通らない）
    mockGetLink.mockResolvedValue(linkAnswer({ verifyUntil: future(1) }));
    const shortened = await get({ stamp });
    expect(shortened.body).toEqual({ access: 'none', verifiable: true, reason: null });

    // 期限が過ぎても、ログインした持ち主はmember（印が残っていても、古くても）
    authOk(OWNER_ID);
    mockGetLink.mockResolvedValue(linkAnswer({ verifyUntil: future(-1) }));
    const owner = await get({ stamp, access: 'owner-access' });
    const ownerAfterDeadlineAccess = owner.body.access;
    expect(ownerAfterDeadlineAccess).toBe('member');
    expect(owner.body.expiresAt).toBeNull();
    expect(owner.body.data).toEqual(EXPECTED_PRIVATE_VIEW);
  });

  test('別の注文・別のトークンの印は通らない', async () => {
    // 他の注文の印（path が違う窓口に付いた印を流用した想定）
    const otherOrderStamp = createOrderStatusSession({
      orderId: 'f6a7b8c9-6666-4777-8888-9999aaaabbbb',
      token: TOKEN,
      verifyUntil: future(10 * 24),
    }).value;
    const otherTokenStamp = createOrderStatusSession({
      orderId: ORDER_ID,
      token: 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-ZyXwV',
      verifyUntil: future(10 * 24),
    }).value;

    for (const stamp of [otherOrderStamp, otherTokenStamp]) {
      const { response, body } = await get({ stamp });
      expect(response.status).toBe(200);
      expect(body).toEqual({ access: 'none', verifiable: true, reason: null });
    }
    expect(mockLoadPrivateInput).not.toHaveBeenCalled();
  });

  test('認可前に個人情報のselectと完全な返品を呼ばない', async () => {
    const past = new Date(Date.now() - 2 * HOUR);
    const denied: Array<() => Promise<unknown>> = [
      () => get({ token: 'short-token' }),
      () => get(),
      () => get({ stamp: 'garbage' }),
      () => get({ stamp: stampValue({ verifyUntil: new Date(past.getTime() + HOUR).toISOString(), now: past }) }),
      () => {
        authFail('invalid');
        return get({ access: 'stale-access' });
      },
      () => {
        authFail('unavailable');
        return get({ access: 'maybe-valid' });
      },
      () => {
        authOk(OTHER_MEMBER_ID);
        return get({ access: 'other-member' });
      },
      () => {
        mockGetLink.mockImplementationOnce(async () => null);
        return get({ stamp: stampValue() });
      },
    ];
    for (const run of denied) {
      await run();
    }
    const privateCallsBeforeGrant = mockLoadPrivateInput.mock.calls;
    expect(privateCallsBeforeGrant).toEqual([]);
    expect(mockServiceClient.rpc).not.toHaveBeenCalled();
    expect(mockServiceClient.from).not.toHaveBeenCalled();

    // 認可された時は、認可の後ろで1回だけ読む
    mockCalls.length = 0;
    authOk(OWNER_ID);
    await get({ access: 'owner-access' });
    expect(mockCalls).toEqual(['link', 'auth', 'private']);
    expect(mockLoadPrivateInput).toHaveBeenCalledTimes(1);
  });
});

describe('同じ404と失敗の写し方', () => {
  test('GET404の3種類同文', async () => {
    // 形の違うトークン（DBを呼ばない）
    const badShape = await get({ token: 'short-token' });
    expect(mockGetLink).not.toHaveBeenCalled();
    // 存在しない・隠す状態のトークン（DBは0行）
    mockGetLink.mockResolvedValueOnce(null);
    const unknown = await get();
    // 認可の後で、読む間に注文が隠れた・消えた
    mockLoadPrivateInput.mockResolvedValueOnce(null);
    authOk(OWNER_ID);
    const vanished = await get({ access: 'owner-access' });

    const responses = [badShape, unknown, vanished];
    expect(responses.map(({ response }) => response.status)).toEqual([404, 404, 404]);
    for (const { body } of responses) {
      expect(body).toEqual(NOT_FOUND_BODY);
    }
    expect(JSON.stringify(badShape.body)).toBe(JSON.stringify(unknown.body));
    expect(JSON.stringify(unknown.body)).toBe(JSON.stringify(vanished.body));
  });

  test('DB専用の ORDER_NOT_FOUND は404、ORDER_STATUS_ARGUMENT_INVALID は入力400に写す', async () => {
    mockGetLink.mockRejectedValueOnce(new OrderStatusStoreError('get_order_status_link', { message: 'ORDER_NOT_FOUND', code: 'P0002' }));
    const missing = await get();
    expect(missing.response.status).toBe(404);
    expect(missing.body).toEqual(NOT_FOUND_BODY);

    mockGetLink.mockRejectedValueOnce(
      new OrderStatusStoreError('get_order_status_link', { message: 'ORDER_STATUS_ARGUMENT_INVALID', code: '22023' }),
    );
    const invalid = await get();
    expect(invalid.response.status).toBe(400);
    expect(invalid.body).toEqual({ error: ORDER_STATUS_ERROR_MESSAGES.ORDER_STATUS_INPUT_INVALID, code: 'ORDER_STATUS_INPUT_INVALID' });
  });

  test('認可後の組み立てが失敗したら500で、個人情報を空の成功にしない', async () => {
    authOk(OWNER_ID);
    mockLoadPrivateInput.mockRejectedValueOnce(new OrderStatusStoreError('orders', { message: 'secret-db-text', code: 'XX000' }));
    const storeFailed = await get({ access: 'owner-access' });

    // 組み立て（buildCustomerOrderPrivateView）が壊れた材料で落ちる場合
    mockLoadPrivateInput.mockResolvedValueOnce({ order: null, paymentMethod: null, fulfillments: [], returnSection: null });
    const buildFailed = await get({ access: 'owner-access' });

    mockCreateServiceRoleClient.mockRejectedValueOnce(new Error('service key missing'));
    const clientFailed = await get();

    for (const { response, body } of [storeFailed, buildFailed, clientFailed]) {
      expect(response.status).toBe(500);
      expect(body).toEqual(FAILED_BODY);
      expect(body).not.toHaveProperty('data');
    }
    expect(JSON.stringify([storeFailed.body, buildFailed.body, clientFailed.body])).not.toMatch(/secret-db-text|XX000/);
  });

  test('署名鍵が無い時は、印が来ていれば確かめられないので500（未確認として黙って通さない）', async () => {
    const stamp = stampValue();
    delete env.ORDER_STATUS_SESSION_SECRET;
    delete env.JWT_SECRET;

    const { response, body } = await get({ stamp });

    expect(response.status).toBe(500);
    expect(body).toEqual(FAILED_BODY);
    expect(mockLoadPrivateInput).not.toHaveBeenCalled();
  });

  test('ログは固定codeだけで、トークン・印・DBの文・鍵・個人情報を出さない', async () => {
    const stamp = stampValue();
    authOk(OWNER_ID);
    mockLoadPrivateInput.mockRejectedValueOnce(
      new OrderStatusStoreError('orders', { message: `leak ${TOKEN} 09000000000 customer@example.com`, code: 'XX000' }),
    );
    await get({ access: 'owner-access' });
    delete env.ORDER_STATUS_SESSION_SECRET;
    await get({ stamp });
    env.ORDER_STATUS_SESSION_SECRET = SECRET;
    mockGetLink.mockRejectedValueOnce(new Error(`ECONNREFUSED ${TOKEN}`));
    await get();
    // 成功した応答は個人情報を含むが、ログには出ない
    const success = await get({ stamp });
    expect(success.body.access).toBe('verified');

    const text = loggedText(consoleSpies);
    for (const secretText of [TOKEN, stamp, SECRET, '09000000000', 'customer@example.com', 'leak', 'ECONNREFUSED', 'TEST-TRACK-0001', '試験 太郎']) {
      expect(text).not.toContain(secretText);
    }
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
    const collect = async (setup: (() => void) | undefined, options?: RequestOptions) => {
      setup?.();
      responses.push((await get(options)).response);
    };
    const stamp = stampValue();

    await collect(undefined); // none 200
    await collect(undefined, { token: 'short-token' }); // 404
    await collect(() => mockGetLink.mockResolvedValueOnce(null)); // 404
    await collect(undefined, { stamp }); // verified 200
    await collect(() => authOk(OWNER_ID), { access: 'owner-access' }); // member 200
    await collect(() => authOk(OTHER_MEMBER_ID), { access: 'other-member' }); // none 200
    await collect(() => authFail('invalid'), { access: 'stale-access' }); // 401
    await collect(() => authFail('missing'), { refresh: 'only-refresh' }); // 401
    await collect(() => authFail('unavailable'), { access: 'maybe-valid' }); // 503
    await collect(() => {
      authOk(OWNER_ID);
      mockLoadPrivateInput.mockResolvedValueOnce(null);
    }, { access: 'owner-access' }); // 404
    await collect(() => {
      authOk(OWNER_ID);
      mockLoadPrivateInput.mockRejectedValueOnce(new Error('boom'));
    }, { access: 'owner-access' }); // 500
    await collect(() => mockGetLink.mockRejectedValueOnce(new Error('boom'))); // 500
    await collect(() => mockCreateServiceRoleClient.mockRejectedValueOnce(new Error('boom'))); // 500

    expect(responses.length).toBe(13);
    const cacheControls = responses.map((response) => response.headers.get('Cache-Control'));
    expect(cacheControls.every((value) => value === 'no-store')).toBe(true);
    expect(responses.every((response) => response.headers.get('Referrer-Policy') === 'no-referrer')).toBe(true);
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200, 401, 404, 500, 503]));
    // この窓口は Cookie を発行しない
    expect(responses.every((response) => response.headers.get('set-cookie') === null)).toBe(true);
  });
});
