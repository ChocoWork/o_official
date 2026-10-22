/** @jest-environment node */
import { HIDDEN_ORDER_STATUS_FILTER } from '@/lib/orders/order-payment-types';
import type { CustomerOrderReturns } from '@/lib/orders/returns/customer-return-types';
import type { PublicCustomerOrderReturns } from '@/lib/orders/customer-order-view-types';
import { ORDER_STATUS_ERROR_MESSAGES, ORDER_STATUS_TEXT } from '@/lib/orders/status/status-messages';
import {
  OrderStatusStoreError,
  ensureOrderStatusLink,
  getOrderStatusLink,
  loadOrderStatusPrivateInput,
  loadOrderStatusPublicMaterial,
  loadOrderStatusReturns,
  orderStatusVerification,
  verifyOrderStatusPhone,
  type OrderStatusStore,
} from '@/lib/orders/status/status-store';
import type { OrderStatusErrorCode, OrderStatusLink } from '@/lib/orders/status/status-types';

jest.mock('server-only', () => ({}), { virtual: true });

// 試験用の作り物の値だけを使う
const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const CUSTOMER_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = '11b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = '11b2c3d4-1111-4222-8333-444455556662';
const FULFILLMENT_1 = '01b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_2 = '02b2c3d4-1111-4222-8333-444455556666';
const REFUND_1 = '21b2c3d4-1111-4222-8333-444455556666';
const CANCEL_1 = 'e1b2c3d4-1111-4222-8333-444455556666';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde';
const SECRET_SENTINEL = 'ORDER-STATUS-SECRET-SENTINEL';
const PRIVATE_SENTINEL = 'ORDER-STATUS-PRIVATE-SENTINEL';
const returnId = (n: number) => `31b2c3d4-1111-4222-8333-4444555566${String(n).padStart(2, '0')}`;

// ---- 呼び出しを記録する store ----

type Answer = { data?: unknown; error?: unknown };
type RpcAnswer = Answer | (() => Answer | Promise<Answer>);
type QueryCall = { table: string; method: string; args: unknown[] };

function makeStore(config: { rpc?: Record<string, RpcAnswer>; tables?: Record<string, Answer> } = {}) {
  const rpcCalls: Array<[string, unknown]> = [];
  const queryCalls: QueryCall[] = [];

  const rpc = jest.fn(async (name: string, args?: unknown) => {
    rpcCalls.push([name, args]);
    const configured = config.rpc?.[name];
    if (configured === undefined) return { data: null, error: { message: `unexpected rpc ${name}`, code: 'XX000' } };
    const answer = typeof configured === 'function' ? await configured() : configured;
    return { data: answer.data ?? null, error: answer.error ?? null };
  });

  const from = jest.fn((table: string) => {
    const configured = config.tables?.[table];
    const result = configured
      ? { data: configured.data ?? null, error: configured.error ?? null }
      : { data: null, error: { message: `unexpected table ${table}`, code: 'XX000' } };
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'not', 'is', 'order', 'limit']) {
      builder[method] = (...args: unknown[]) => {
        queryCalls.push({ table, method, args });
        return builder;
      };
    }
    builder.maybeSingle = () => {
      queryCalls.push({ table, method: 'maybeSingle', args: [] });
      return Promise.resolve(result);
    };
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return builder;
  });

  return { store: { rpc, from } as unknown as OrderStatusStore, rpc, from, rpcCalls, queryCalls };
}

async function expectStoreError(run: () => Promise<unknown>, operation?: string) {
  const error = await run().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OrderStatusStoreError);
  const storeError = error as OrderStatusStoreError;
  expect(storeError.code).toBe('ORDER_STATUS_STORE_FAILED');
  expect(storeError.message).toBe('order status store failed');
  expect(storeError.message.includes(SECRET_SENTINEL)).toBe(false);
  if (operation) expect(storeError.operation).toBe(operation);
  return storeError;
}

const REMOVE = Symbol('remove');
function changed<T>(base: T, path: Array<string | number>, value: unknown): T {
  const copy = JSON.parse(JSON.stringify(base));
  let target = copy;
  for (const key of path.slice(0, -1)) target = target[key];
  const last = path[path.length - 1];
  if (value === REMOVE) {
    delete target[last];
  } else {
    target[last] = value;
  }
  return copy;
}

// 秘密値・個人情報をログへ出さない（console を一切呼ばない）
let consoleSpies: jest.SpyInstance[];
beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    jest.spyOn(console, method).mockImplementation(() => undefined),
  );
});
afterEach(() => {
  const calls = consoleSpies.flatMap((spy) => spy.mock.calls);
  consoleSpies.forEach((spy) => spy.mockRestore());
  expect(calls).toEqual([]);
});

// ---- リンク ----

const LINK_ROW = {
  order_id: ORDER_ID,
  customer_id: CUSTOMER_ID,
  verify_until: '2026-11-12T03:00:00+00:00',
  failed_attempts: 2,
  phone_available: true,
};
const LINK: OrderStatusLink = {
  orderId: ORDER_ID,
  customerId: CUSTOMER_ID,
  verifyUntil: '2026-11-12T03:00:00+00:00',
  failedAttempts: 2,
  phoneAvailable: true,
};

describe('ensureOrderStatusLink', () => {
  test('注文の番号を渡し、DB が返した43文字のトークンを返す', async () => {
    const { store, rpcCalls } = makeStore({ rpc: { ensure_order_status_link: { data: TOKEN } } });

    await expect(ensureOrderStatusLink(store, ORDER_ID)).resolves.toBe(TOKEN);

    expect(rpcCalls).toEqual([['ensure_order_status_link', { _order_id: ORDER_ID }]]);
  });

  test('DBの失敗・形の違う答えは固定のエラー（DBの文は cause にだけ残す）', async () => {
    const dbError = { message: `ORDER_NOT_FOUND ${SECRET_SENTINEL}`, code: 'P0002' };
    const failing = makeStore({ rpc: { ensure_order_status_link: { error: dbError } } });
    const storeError = await expectStoreError(() => ensureOrderStatusLink(failing.store, ORDER_ID), 'ensure_order_status_link');
    expect(storeError.cause).toBe(dbError);

    for (const data of [null, undefined, 123, '', TOKEN.slice(0, 42), `${TOKEN}A`, `${TOKEN.slice(0, 42)}+`, [TOKEN], { token: TOKEN }]) {
      const { store } = makeStore({ rpc: { ensure_order_status_link: { data } } });
      await expectStoreError(() => ensureOrderStatusLink(store, ORDER_ID), 'ensure_order_status_link');
    }
  });
});

describe('getOrderStatusLink', () => {
  test('トークンを渡し、1行の答えを OrderStatusLink にする', async () => {
    const { store, rpcCalls } = makeStore({ rpc: { get_order_status_link: { data: [LINK_ROW] } } });

    await expect(getOrderStatusLink(store, TOKEN)).resolves.toEqual(LINK);

    expect(rpcCalls).toEqual([['get_order_status_link', { _token: TOKEN }]]);
  });

  test('期限NULL・会員でない注文・電話の無い注文も写す', async () => {
    const { store } = makeStore({
      rpc: { get_order_status_link: { data: [{ ...LINK_ROW, customer_id: null, verify_until: null, phone_available: false }] } },
    });

    await expect(getOrderStatusLink(store, TOKEN)).resolves.toEqual({
      ...LINK,
      customerId: null,
      verifyUntil: null,
      phoneAvailable: false,
    });
  });

  test('0行（存在しない・隠す状態・形違い）は null', async () => {
    const { store } = makeStore({ rpc: { get_order_status_link: { data: [] } } });

    await expect(getOrderStatusLink(store, TOKEN)).resolves.toBeNull();
  });

  test('形の違うトークンはDBを呼ばず null', async () => {
    const { store, rpcCalls } = makeStore();

    await expect(getOrderStatusLink(store, TOKEN.slice(0, 42))).resolves.toBeNull();
    await expect(getOrderStatusLink(store, `${TOKEN.slice(0, 42)}+`)).resolves.toBeNull();
    await expect(getOrderStatusLink(store, '')).resolves.toBeNull();

    expect(rpcCalls).toEqual([]);
  });

  test('答えに電話・トークンを持ち込まない。余分なキーは写さない', async () => {
    const { store } = makeStore({
      rpc: { get_order_status_link: { data: [{ ...LINK_ROW, token: TOKEN, shipping_phone: PRIVATE_SENTINEL, last_four: PRIVATE_SENTINEL }] } },
    });

    const link = await getOrderStatusLink(store, TOKEN);

    expect(Object.keys(link ?? {}).sort()).toEqual(['customerId', 'failedAttempts', 'orderId', 'phoneAvailable', 'verifyUntil']);
    expect(JSON.stringify(link).includes(PRIVATE_SENTINEL)).toBe(false);
    expect(JSON.stringify(link).includes(TOKEN)).toBe(false);
  });

  test('壊れた答えとDB失敗を空の成功にしない', async () => {
    const broken: unknown[] = [
      null,
      {},
      'text',
      [null],
      ['row'],
      [LINK_ROW, LINK_ROW],
      [{ ...LINK_ROW, order_id: 5 }],
      [{ ...LINK_ROW, order_id: 'not-a-uuid' }],
      [{ ...LINK_ROW, customer_id: 'not-a-uuid' }],
      [{ ...LINK_ROW, customer_id: undefined }],
      [{ ...LINK_ROW, verify_until: 'not-a-date' }],
      [{ ...LINK_ROW, verify_until: '2026-02-30T00:00:00+00:00' }],
      [{ ...LINK_ROW, verify_until: 20261112 }],
      [{ ...LINK_ROW, verify_until: undefined }],
      [{ ...LINK_ROW, failed_attempts: '2' }],
      [{ ...LINK_ROW, failed_attempts: 2.5 }],
      [{ ...LINK_ROW, failed_attempts: -1 }],
      [{ ...LINK_ROW, failed_attempts: 21 }],
      [{ ...LINK_ROW, phone_available: 'true' }],
      [{ ...LINK_ROW, phone_available: undefined }],
    ];
    for (const data of broken) {
      const { store } = makeStore({ rpc: { get_order_status_link: { data } } });
      await expectStoreError(() => getOrderStatusLink(store, TOKEN), 'get_order_status_link');
    }

    const dbError = { message: SECRET_SENTINEL, code: '08006' };
    const failing = makeStore({ rpc: { get_order_status_link: { error: dbError } } });
    const storeError = await expectStoreError(() => getOrderStatusLink(failing.store, TOKEN), 'get_order_status_link');
    expect(storeError.cause).toBe(dbError);
  });
});

describe('verifyOrderStatusPhone', () => {
  const VERIFY_ROW = { result: 'ok', verify_until: '2026-11-12T03:00:00+00:00', failed_attempts: 2 };

  test('トークンと数字4桁だけをDBへ渡し、DBの判定を5つの結果のまま写す。TSで電話を比べない', async () => {
    for (const result of ['ok', 'mismatch', 'locked', 'unavailable', 'expired']) {
      const { store, rpcCalls, from } = makeStore({ rpc: { verify_order_status_phone: { data: [{ ...VERIFY_ROW, result }] } } });

      await expect(verifyOrderStatusPhone(store, { token: TOKEN, lastFour: '5678' })).resolves.toEqual({
        result,
        verifyUntil: '2026-11-12T03:00:00+00:00',
        failedAttempts: 2,
      });

      expect(rpcCalls).toEqual([['verify_order_status_phone', { _token: TOKEN, _last_four: '5678' }]]);
      expect(from).not.toHaveBeenCalled();
    }
  });

  test('期限NULLの答え（期限切れ）も写す', async () => {
    const { store } = makeStore({ rpc: { verify_order_status_phone: { data: [{ result: 'expired', verify_until: null, failed_attempts: 0 }] } } });

    await expect(verifyOrderStatusPhone(store, { token: TOKEN, lastFour: '5678' })).resolves.toEqual({
      result: 'expired',
      verifyUntil: null,
      failedAttempts: 0,
    });
  });

  test('0行（存在しない・隠す状態）は null。形の違うトークンはDBを呼ばず null', async () => {
    const empty = makeStore({ rpc: { verify_order_status_phone: { data: [] } } });
    await expect(verifyOrderStatusPhone(empty.store, { token: TOKEN, lastFour: '5678' })).resolves.toBeNull();

    const none = makeStore();
    await expect(verifyOrderStatusPhone(none.store, { token: TOKEN.slice(0, 42), lastFour: '5678' })).resolves.toBeNull();
    expect(none.rpcCalls).toEqual([]);
  });

  test('壊れた答えとDB失敗を空の成功にしない。DBの文・入力の4桁は固定エラーの文に入らない', async () => {
    const broken: unknown[] = [
      null,
      {},
      [null],
      [VERIFY_ROW, VERIFY_ROW],
      [{ ...VERIFY_ROW, result: 'weird' }],
      [{ ...VERIFY_ROW, result: undefined }],
      [{ ...VERIFY_ROW, verify_until: 'not-a-date' }],
      [{ ...VERIFY_ROW, verify_until: undefined }],
      [{ ...VERIFY_ROW, failed_attempts: '2' }],
      [{ ...VERIFY_ROW, failed_attempts: 21 }],
      [{ ...VERIFY_ROW, failed_attempts: -1 }],
    ];
    for (const data of broken) {
      const { store } = makeStore({ rpc: { verify_order_status_phone: { data } } });
      await expectStoreError(() => verifyOrderStatusPhone(store, { token: TOKEN, lastFour: '5678' }), 'verify_order_status_phone');
    }

    const dbError = { message: `ORDER_STATUS_ARGUMENT_INVALID ${SECRET_SENTINEL} 5678`, code: '22023' };
    const failing = makeStore({ rpc: { verify_order_status_phone: { error: dbError } } });
    const storeError = await expectStoreError(
      () => verifyOrderStatusPhone(failing.store, { token: TOKEN, lastFour: '5678' }),
      'verify_order_status_phone',
    );
    expect(storeError.cause).toBe(dbError);
    expect(storeError.message.includes('5678')).toBe(false);
    expect(storeError.message.includes(TOKEN)).toBe(false);
  });

  test('rpc が例外を投げても固定エラー（元の例外は cause にだけ残す）', async () => {
    const thrown = new Error(SECRET_SENTINEL);
    const { store } = makeStore({
      rpc: {
        verify_order_status_phone: () => {
          throw thrown;
        },
      },
    });

    const storeError = await expectStoreError(
      () => verifyOrderStatusPhone(store, { token: TOKEN, lastFour: '5678' }),
      'verify_order_status_phone',
    );
    expect(storeError.cause).toBe(thrown);
  });
});

describe('orderStatusVerification', () => {
  const NOW = new Date('2026-10-22T03:00:00.000Z');
  const link = (overrides: Partial<OrderStatusLink>): OrderStatusLink => ({
    orderId: ORDER_ID,
    customerId: null,
    verifyUntil: '2026-10-22T03:00:01.000Z',
    failedAttempts: 0,
    phoneAvailable: true,
    ...overrides,
  });

  test('期限・電話の有無・失敗の数だけから、確認できるか／理由を決める（判定の順は 期限切れ → 利用不可 → ロック）', () => {
    const cases: Array<[string, OrderStatusLink, ReturnType<typeof orderStatusVerification>]> = [
      ['確認できる', link({}), { verifiable: true, reason: null }],
      ['失敗19回はまだ確認できる', link({ failedAttempts: 19 }), { verifiable: true, reason: null }],
      ['失敗20回はロック', link({ failedAttempts: 20 }), { verifiable: false, reason: 'locked' }],
      ['電話が無い', link({ phoneAvailable: false }), { verifiable: false, reason: 'unavailable' }],
      ['期限NULL', link({ verifyUntil: null }), { verifiable: false, reason: 'expired' }],
      ['期限が現在と同時刻は期限切れ', link({ verifyUntil: NOW.toISOString() }), { verifiable: false, reason: 'expired' }],
      ['期限が過去', link({ verifyUntil: '2026-10-22T02:59:59+00:00' }), { verifiable: false, reason: 'expired' }],
      ['期限切れと電話無しが重なれば期限切れ', link({ verifyUntil: null, phoneAvailable: false }), { verifiable: false, reason: 'expired' }],
      ['期限切れとロックが重なれば期限切れ', link({ verifyUntil: null, failedAttempts: 20 }), { verifiable: false, reason: 'expired' }],
      ['電話無しとロックが重なれば利用不可', link({ phoneAvailable: false, failedAttempts: 20 }), { verifiable: false, reason: 'unavailable' }],
      ['読めない期限は期限切れ', link({ verifyUntil: 'not-a-date' }), { verifiable: false, reason: 'expired' }],
    ];

    expect(cases.filter(([, input, expected]) => JSON.stringify(orderStatusVerification(input, NOW)) !== JSON.stringify(expected)).map(([name]) => name)).toEqual([]);
  });

  test('時計を渡さなければ今の時刻で判定する', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    expect(orderStatusVerification(link({ verifyUntil: future }))).toEqual({ verifiable: true, reason: null });
    expect(orderStatusVerification(link({ verifyUntil: past }))).toEqual({ verifiable: false, reason: 'expired' });
  });
});

// ---- 公開材料 ----

const MATERIAL_JSON = {
  order: {
    id: ORDER_ID,
    created_at: '2026-10-20T01:00:00.123456+00:00',
    status: 'shipped',
    subtotal_amount: 12000,
    shipping_amount: 500,
    discount_amount: 1000,
    total_amount: 11500,
    currency: 'jpy',
    order_items: [
      { id: ITEM_1, item_id: 12, variant_id: 101, item_name: 'シルクブラウス', item_image_url: 'items/12/main.jpg', color: '白', size: 'M', quantity: 2, line_total: 12000, line_kind: 'order' },
      { id: ITEM_2, item_id: null, variant_id: null, item_name: '交換のリネンパンツ', item_image_url: null, color: null, size: null, quantity: 1, line_total: 0, line_kind: 'exchange' },
    ],
  },
  line_rows: [
    { order_id: ORDER_ID, order_item_id: ITEM_1, variant_id: 101, fulfillment_type: 'in_stock', quantity: 2, shipped: 2, completed: 0, refunded_before_shipment: 0, refunded_after_shipment: 1, in_production: 0, ready_unshipped: 0, unshipped: 0 },
    { order_id: ORDER_ID, order_item_id: ITEM_2, variant_id: null, fulfillment_type: 'made_to_order', quantity: 1, shipped: 0, completed: 0, refunded_before_shipment: 0, refunded_after_shipment: 0, in_production: 1, ready_unshipped: 0, unshipped: 1 },
  ],
  fulfillments: [
    { fulfillment_id: FULFILLMENT_1, number: 1, shipping_carrier: 'yamato', shipped_at: '2026-10-21T01:00:00+00:00', cancelled_at: null, lines: [{ order_item_id: ITEM_1, quantity: 2 }] },
    { fulfillment_id: FULFILLMENT_2, number: 2, shipping_carrier: null, shipped_at: '2026-10-22T01:00:00Z', cancelled_at: '2026-10-22T02:00:00+00:00', lines: [] },
  ],
  delivery_detail: {
    enabled: true,
    fulfillments: [
      {
        fulfillment_id: FULFILLMENT_1, cancelled_at: null, tracking_version: 1, delivery_status: 'in_transit',
        delivery_status_at: '2026-10-21T05:00:00+00:00', delivered_at: null,
        registration: { state: 'registered', ever_registered: true },
        events: [
          { tracking_version: 1, status: 'in_transit', happened_at: '2026-10-21T05:00:00+00:00', recorded_at: '2026-10-21T05:01:00+00:00' },
          { tracking_version: 1, status: 'confirmed', happened_at: '2026-10-21T01:00:00+00:00', recorded_at: '2026-10-21T01:01:00+00:00' },
        ],
      },
      {
        fulfillment_id: FULFILLMENT_2, cancelled_at: '2026-10-22T02:00:00+00:00', tracking_version: 1, delivery_status: 'confirmed',
        delivery_status_at: '2026-10-22T01:00:00+00:00', delivered_at: null, registration: null, events: [],
      },
    ],
  },
  delivery_summary: { active_count: 1, delivered_count: 0 },
  refund_rows: [{ refund_id: REFUND_1, created_at: '2026-10-23T01:00:00+00:00', amount: 1000, status: 'succeeded' }],
};
const MATERIAL = {
  order: MATERIAL_JSON.order,
  lineRows: [
    { orderId: ORDER_ID, orderItemId: ITEM_1, variantId: 101, fulfillmentType: 'in_stock', quantity: 2, shipped: 2, completed: 0, refundedBeforeShipment: 0, refundedAfterShipment: 1, inProduction: 0, readyUnshipped: 0, unshipped: 0 },
    { orderId: ORDER_ID, orderItemId: ITEM_2, variantId: null, fulfillmentType: 'made_to_order', quantity: 1, shipped: 0, completed: 0, refundedBeforeShipment: 0, refundedAfterShipment: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1 },
  ],
  fulfillments: [
    { fulfillmentId: FULFILLMENT_1, number: 1, shippingCarrier: 'yamato', shippedAt: '2026-10-21T01:00:00+00:00', cancelledAt: null, lines: [{ orderItemId: ITEM_1, quantity: 2 }] },
    { fulfillmentId: FULFILLMENT_2, number: 2, shippingCarrier: null, shippedAt: '2026-10-22T01:00:00Z', cancelledAt: '2026-10-22T02:00:00+00:00', lines: [] },
  ],
  deliveryDetail: {
    enabled: true,
    fulfillments: [
      {
        fulfillmentId: FULFILLMENT_1, cancelledAt: null, trackingVersion: 1, deliveryStatus: 'in_transit',
        deliveryStatusAt: '2026-10-21T05:00:00+00:00', deliveredAt: null,
        registration: { state: 'registered', everRegistered: true },
        events: [
          { trackingVersion: 1, status: 'in_transit', happenedAt: '2026-10-21T05:00:00+00:00', recordedAt: '2026-10-21T05:01:00+00:00' },
          { trackingVersion: 1, status: 'confirmed', happenedAt: '2026-10-21T01:00:00+00:00', recordedAt: '2026-10-21T01:01:00+00:00' },
        ],
      },
      {
        fulfillmentId: FULFILLMENT_2, cancelledAt: '2026-10-22T02:00:00+00:00', trackingVersion: 1, deliveryStatus: 'confirmed',
        deliveryStatusAt: '2026-10-22T01:00:00+00:00', deliveredAt: null, registration: null, events: [],
      },
    ],
  },
  deliverySummary: { activeCount: 1, deliveredCount: 0 },
  refundRows: [{ refundId: REFUND_1, createdAt: '2026-10-23T01:00:00+00:00', amount: 1000, status: 'succeeded' }],
};

// ---- 返品 ----

type ReturnJsonOptions = { id: string; number: number; status: string; customerStatus: string; address?: boolean; includePrivate: boolean };
function returnJson({ id, number, status, customerStatus, address = false, includePrivate }: ReturnJsonOptions) {
  return {
    id, number, status, customer_status: customerStatus,
    return_method: 'customer_ships', return_shipping_payer: 'customer', return_shipping_fee: 800,
    ...(includePrivate
      ? { return_address: address ? { name: '返品係', postal_code: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' } : null }
      : {}),
    requested_at: '2026-10-22T01:00:00+00:00', closed_at: null,
    lines: [
      { item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, requested_resolution: 'exchange', requested_exchange: { color: '白', size: 'L' }, resolution: 'exchange', exchange: { color: '白', size: 'L' } },
      { item_name: 'リネンパンツ', color: null, size: null, quantity: 1, requested_resolution: null, requested_exchange: null, resolution: 'refund', exchange: null },
    ],
    refund_amount: number === 2 ? 5400 : null,
    sent_back: [
      { item_name: 'レザーベルト', color: '茶', size: null, quantity: 1, message: '着用の跡があります', ...(includePrivate ? { carrier: null, tracking_number: null } : {}) },
      { item_name: 'ウールコート', color: '黒', size: 'L', quantity: 2, message: null, ...(includePrivate ? { carrier: 'yamato', tracking_number: `AB-${number}` } : {}) },
    ],
    decline_message: customerStatus === 'declined' ? 'お受けできませんでした。' : null,
    exchange_shipping: 'none',
  };
}
const RETURNS_EXTRAS_JSON = {
  cancel_requests: [
    { id: CANCEL_1, status: 'declined', requested_at: '2026-10-21T02:00:00+00:00', lines: [{ item_name: 'リネンパンツ', color: null, size: null, quantity: 2 }], decline_message: 'すでに準備を進めています。' },
  ],
  availability: { returns: 'ended', ended_on: '2026-10-20', cancel: false },
};
const RETURNS_EXTRAS = {
  cancelRequests: [
    { id: CANCEL_1, status: 'declined', requestedAt: '2026-10-21T02:00:00+00:00', lines: [{ itemName: 'リネンパンツ', color: null, size: null, quantity: 2 }], declineMessage: 'すでに準備を進めています。' },
  ],
  availability: { returns: 'ended', endedOn: '2026-10-20', cancel: false },
};

function publicReturnsJson() {
  return {
    returns: [
      returnJson({ id: returnId(2), number: 2, status: 'open', customerStatus: 'accepted', includePrivate: false }),
      returnJson({ id: returnId(1), number: 1, status: 'declined', customerStatus: 'declined', includePrivate: false }),
    ],
    ...RETURNS_EXTRAS_JSON,
  };
}
function publicReturn(id: string, number: number, customerStatus: string, status: string) {
  return {
    id, number, label: `ORD-A1B2C3D4-R${number}`, status, customerStatus,
    returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnShippingFee: 800,
    requestedAt: '2026-10-22T01:00:00+00:00', closedAt: null,
    lines: [
      { itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 1, requestedResolution: 'exchange', requestedExchange: { color: '白', size: 'L' }, resolution: 'exchange', exchange: { color: '白', size: 'L' } },
      { itemName: 'リネンパンツ', color: null, size: null, quantity: 1, requestedResolution: null, requestedExchange: null, resolution: 'refund', exchange: null },
    ],
    refundAmount: number === 2 ? 5400 : null,
    sentBack: [
      { itemName: 'レザーベルト', color: '茶', size: null, quantity: 1, message: '着用の跡があります' },
      { itemName: 'ウールコート', color: '黒', size: 'L', quantity: 2, message: null },
    ],
    declineMessage: customerStatus === 'declined' ? 'お受けできませんでした。' : null,
    exchangeShipping: 'none',
  };
}
const PUBLIC_RETURNS = {
  returns: [publicReturn(returnId(2), 2, 'accepted', 'open'), publicReturn(returnId(1), 1, 'declined', 'declined')],
  ...RETURNS_EXTRAS,
};

// 2つのオーバーロードは真偽の変数を受けないので、試験では分けて呼ぶ
async function loadReturns(store: OrderStatusStore, includePrivate: boolean): Promise<unknown> {
  return includePrivate
    ? await loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: true })
    : await loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: false });
}

const ALL_CUSTOMER_STATUSES = ['requested', 'accepted', 'partially_received', 'inspecting', 'awaiting_fee', 'refund_preparing', 'returned', 'declined'] as const;
function privateReturnsJson() {
  return {
    returns: ALL_CUSTOMER_STATUSES.map((customerStatus, index) =>
      returnJson({ id: returnId(index + 1), number: index + 1, status: 'open', customerStatus, address: true, includePrivate: true }),
    ),
    ...RETURNS_EXTRAS_JSON,
  };
}

describe('公開の読み出し', () => {
  test('公開のstoreは公開材料RPCと返品falseだけを呼ぶ', async () => {
    const { store, rpcCalls, queryCalls } = makeStore({
      rpc: { get_order_status_public_material: { data: MATERIAL_JSON }, get_order_status_returns: { data: publicReturnsJson() } },
    });

    const material = await loadOrderStatusPublicMaterial(store, ORDER_ID);
    const publicReturns: PublicCustomerOrderReturns | null = await loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: false });

    const publicRpcCalls = rpcCalls;
    const expectedPublicCalls = [
      ['get_order_status_public_material', { _order_id: ORDER_ID }],
      ['get_order_status_returns', { _order_id: ORDER_ID, _include_private: false }],
    ];
    const privateSelectCalls = queryCalls.filter((call) => call.method === 'select');
    expect(publicRpcCalls).toEqual(expectedPublicCalls);
    expect(privateSelectCalls).toEqual([]);
    expect(queryCalls).toEqual([]);
    expect(material).toEqual(MATERIAL);
    expect(publicReturns).toEqual(PUBLIC_RETURNS);
  });

  test('公開材料は名指しの項目だけを写し、DBが余分な個人情報のキーを返しても出力へ持ち込まない', async () => {
    const leaky = JSON.parse(JSON.stringify(MATERIAL_JSON));
    leaky.shipping_phone = PRIVATE_SENTINEL;
    leaky.order.shipping_email = PRIVATE_SENTINEL;
    leaky.order.payment_intent_id = PRIVATE_SENTINEL;
    leaky.order.order_items[0].internal_note = PRIVATE_SENTINEL;
    leaky.line_rows[0].tracking_number = PRIVATE_SENTINEL;
    leaky.fulfillments[0].tracking_number = PRIVATE_SENTINEL;
    leaky.fulfillments[0].lines[0].shipping_phone = PRIVATE_SENTINEL;
    leaky.delivery_detail.fulfillments[0].tracking_number = PRIVATE_SENTINEL;
    leaky.delivery_detail.fulfillments[0].registration.failure_kind = PRIVATE_SENTINEL;
    leaky.delivery_detail.fulfillments[0].events[0].actor_email = PRIVATE_SENTINEL;
    leaky.refund_rows[0].payment_method_type = PRIVATE_SENTINEL;
    leaky.refund_rows[0].note = PRIVATE_SENTINEL;
    const { store } = makeStore({ rpc: { get_order_status_public_material: { data: leaky } } });

    const material = await loadOrderStatusPublicMaterial(store, ORDER_ID);

    expect(material).toEqual(MATERIAL);
    expect(JSON.stringify(material).includes(PRIVATE_SENTINEL)).toBe(false);
  });

  test('公開の返品は返送先と送り返しの業者・伝票番号のキーを持たない。DBが返しても写さない', async () => {
    const leaky = changed(publicReturnsJson(), ['returns', 0, 'return_address'], { name: PRIVATE_SENTINEL, postal_code: '1', address: 'x', phone: '2' });
    leaky.returns[0].sent_back[1] = { ...leaky.returns[0].sent_back[1], carrier: 'yamato', tracking_number: PRIVATE_SENTINEL } as never;
    const { store } = makeStore({ rpc: { get_order_status_returns: { data: leaky } } });

    const result = await loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: false });

    expect(JSON.stringify(result).includes(PRIVATE_SENTINEL)).toBe(false);
    for (const entry of result?.returns ?? []) {
      expect(entry).not.toHaveProperty('returnAddress');
      for (const sent of entry.sentBack) {
        expect(sent).not.toHaveProperty('carrier');
        expect(sent).not.toHaveProperty('trackingNumber');
      }
    }
    expect(result).toEqual(PUBLIC_RETURNS);
  });

  test('注文が無い・隠す状態（DBがSQLのNULL）は材料も返品も null', async () => {
    const { store } = makeStore({ rpc: { get_order_status_public_material: { data: null }, get_order_status_returns: { data: null } } });

    await expect(loadOrderStatusPublicMaterial(store, ORDER_ID)).resolves.toBeNull();
    await expect(loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: false })).resolves.toBeNull();
    await expect(loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: true })).resolves.toBeNull();
  });

  test('返品が空でもキャンセルの申し込みが空でも、形が正しければそのまま空で返す', async () => {
    const { store } = makeStore({
      rpc: { get_order_status_returns: { data: { returns: [], cancel_requests: [], availability: { returns: 'none', ended_on: null, cancel: false } } } },
    });

    await expect(loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: false })).resolves.toEqual({
      returns: [],
      cancelRequests: [],
      availability: { returns: 'none', endedOn: null, cancel: false },
    });
  });

  test('壊れた公開材料を空の成功にしない', async () => {
    const cases: Array<[string, unknown]> = [
      ['配列', []],
      ['文字列', 'text'],
      ['数値', 123],
      ['空のオブジェクト', {}],
      ...(['order', 'line_rows', 'fulfillments', 'delivery_detail', 'delivery_summary', 'refund_rows'] as const).map(
        (key): [string, unknown] => [`${key} が無い`, changed(MATERIAL_JSON, [key], REMOVE)],
      ),
      ['order.id', changed(MATERIAL_JSON, ['order', 'id'], 'not-a-uuid')],
      ['order.created_at', changed(MATERIAL_JSON, ['order', 'created_at'], 'yesterday')],
      ['order.created_at 存在しない日', changed(MATERIAL_JSON, ['order', 'created_at'], '2026-02-30T00:00:00+00:00')],
      ['order.status 支払い手続き中', changed(MATERIAL_JSON, ['order', 'status'], 'payment_in_progress')],
      ['order.status 放棄', changed(MATERIAL_JSON, ['order', 'status'], 'abandoned')],
      ['order.status 未知', changed(MATERIAL_JSON, ['order', 'status'], 'weird')],
      ['order.subtotal_amount 文字列', changed(MATERIAL_JSON, ['order', 'subtotal_amount'], '12000')],
      ['order.shipping_amount 小数', changed(MATERIAL_JSON, ['order', 'shipping_amount'], 500.5)],
      ['order.discount_amount 負', changed(MATERIAL_JSON, ['order', 'discount_amount'], -1)],
      ['order.currency', changed(MATERIAL_JSON, ['order', 'currency'], 5)],
      ['order.order_items null', changed(MATERIAL_JSON, ['order', 'order_items'], null)],
      ['order.order_items オブジェクト', changed(MATERIAL_JSON, ['order', 'order_items'], {})],
      ['明細 id', changed(MATERIAL_JSON, ['order', 'order_items', 0, 'id'], 5)],
      ['明細 item_id 文字列', changed(MATERIAL_JSON, ['order', 'order_items', 0, 'item_id'], '12')],
      ['明細 item_name', changed(MATERIAL_JSON, ['order', 'order_items', 0, 'item_name'], null)],
      ['明細 color 数値', changed(MATERIAL_JSON, ['order', 'order_items', 1, 'color'], 5)],
      ['明細 color 無し', changed(MATERIAL_JSON, ['order', 'order_items', 1, 'color'], REMOVE)],
      ['明細 quantity 文字列', changed(MATERIAL_JSON, ['order', 'order_items', 0, 'quantity'], '2')],
      ['明細 line_kind', changed(MATERIAL_JSON, ['order', 'order_items', 0, 'line_kind'], 'weird')],
      ['line_rows null', changed(MATERIAL_JSON, ['line_rows'], null)],
      ['line_rows order_id', changed(MATERIAL_JSON, ['line_rows', 0, 'order_id'], 1)],
      ['line_rows shipped 文字列', changed(MATERIAL_JSON, ['line_rows', 0, 'shipped'], '2')],
      ['line_rows unshipped 負', changed(MATERIAL_JSON, ['line_rows', 0, 'unshipped'], -1)],
      ['line_rows fulfillment_type', changed(MATERIAL_JSON, ['line_rows', 0, 'fulfillment_type'], 5)],
      ['fulfillments オブジェクト', changed(MATERIAL_JSON, ['fulfillments'], {})],
      ['fulfillments number 0', changed(MATERIAL_JSON, ['fulfillments', 0, 'number'], 0)],
      ['fulfillments shipped_at', changed(MATERIAL_JSON, ['fulfillments', 0, 'shipped_at'], 'x')],
      ['fulfillments cancelled_at 数値', changed(MATERIAL_JSON, ['fulfillments', 0, 'cancelled_at'], 5)],
      ['fulfillments shipping_carrier 数値', changed(MATERIAL_JSON, ['fulfillments', 0, 'shipping_carrier'], 5)],
      ['fulfillments lines null', changed(MATERIAL_JSON, ['fulfillments', 0, 'lines'], null)],
      ['fulfillments lines quantity', changed(MATERIAL_JSON, ['fulfillments', 0, 'lines', 0, 'quantity'], 'x')],
      ['fulfillments lines order_item_id', changed(MATERIAL_JSON, ['fulfillments', 0, 'lines', 0, 'order_item_id'], 'x')],
      ['delivery_detail.enabled', changed(MATERIAL_JSON, ['delivery_detail', 'enabled'], 'true')],
      ['delivery_detail.fulfillments null', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments'], null)],
      ['delivery_status', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'delivery_status'], 'weird')],
      ['tracking_version 0', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'tracking_version'], 0)],
      ['delivery_status_at', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'delivery_status_at'], null)],
      ['delivered_at', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'delivered_at'], 5)],
      ['registration 文字列', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'registration'], 'x')],
      ['registration.state', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'registration', 'state'], 'weird')],
      ['registration.ever_registered', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'registration', 'ever_registered'], 1)],
      ['registration 無し', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'registration'], REMOVE)],
      ['events null', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'events'], null)],
      ['events status', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'events', 0, 'status'], 'weird')],
      ['events happened_at', changed(MATERIAL_JSON, ['delivery_detail', 'fulfillments', 0, 'events', 0, 'happened_at'], 'x')],
      ['delivery_summary.active_count', changed(MATERIAL_JSON, ['delivery_summary', 'active_count'], '1')],
      ['delivery_summary.delivered_count が active を超える', changed(MATERIAL_JSON, ['delivery_summary', 'delivered_count'], 2)],
      ['refund_rows status', changed(MATERIAL_JSON, ['refund_rows', 0, 'status'], 'weird')],
      ['refund_rows amount', changed(MATERIAL_JSON, ['refund_rows', 0, 'amount'], '1000')],
      ['refund_rows created_at', changed(MATERIAL_JSON, ['refund_rows', 0, 'created_at'], null)],
      ['refund_rows refund_id', changed(MATERIAL_JSON, ['refund_rows', 0, 'refund_id'], 'x')],
    ];

    const accepted: string[] = [];
    for (const [name, data] of cases) {
      const { store } = makeStore({ rpc: { get_order_status_public_material: { data } } });
      const outcome = await loadOrderStatusPublicMaterial(store, ORDER_ID).then(
        () => 'resolved',
        (error: unknown) => (error instanceof OrderStatusStoreError && error.code === 'ORDER_STATUS_STORE_FAILED' ? 'store-error' : 'other-error'),
      );
      if (outcome !== 'store-error') accepted.push(`${name}: ${outcome}`);
    }
    expect(accepted).toEqual([]);
  });

  test('公開材料のDB失敗は固定エラー（DBの文は cause にだけ残す）', async () => {
    const dbError = { message: SECRET_SENTINEL, code: '08006' };
    const { store } = makeStore({ rpc: { get_order_status_public_material: { error: dbError } } });

    const storeError = await expectStoreError(() => loadOrderStatusPublicMaterial(store, ORDER_ID), 'get_order_status_public_material');

    expect(storeError.cause).toBe(dbError);
  });
});

describe('返品の読み出し', () => {
  test('includePrivate:true は返送先と送り返しの伝票番号つきの形（会員と同じ答え）で返す', async () => {
    const { store, rpcCalls } = makeStore({ rpc: { get_order_status_returns: { data: privateReturnsJson() } } });

    const result: CustomerOrderReturns | null = await loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: true });

    expect(rpcCalls).toEqual([['get_order_status_returns', { _order_id: ORDER_ID, _include_private: true }]]);
    expect(result?.returns).toHaveLength(8);
    expect(result?.returns[1]).toMatchObject({
      id: returnId(2),
      label: 'ORD-A1B2C3D4-R2',
      customerStatus: 'accepted',
      returnAddress: { name: '返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' },
      sentBack: [
        { itemName: 'レザーベルト', color: '茶', size: null, quantity: 1, message: '着用の跡があります', carrier: null, trackingNumber: null },
        { itemName: 'ウールコート', color: '黒', size: 'L', quantity: 2, message: null, carrier: 'yamato', trackingNumber: 'AB-2' },
      ],
    });
    expect(result).toMatchObject(RETURNS_EXTRAS);
  });

  test('壊れた返品の答えを空の成功にしない（公開・個人情報つきの両方）', async () => {
    const buildCases = (json: object, includePrivate: boolean) => {
      const cases: Array<[string, unknown]> = [
        ['配列', []],
        ['文字列', 'text'],
        ['空のオブジェクト', {}],
        ['returns が無い', changed(json, ['returns'], REMOVE)],
        ['returns null', changed(json, ['returns'], null)],
        ['returns オブジェクト', changed(json, ['returns'], {})],
        ['返品 id', changed(json, ['returns', 0, 'id'], 5)],
        ['返品 number 文字列', changed(json, ['returns', 0, 'number'], '2')],
        ['返品 status', changed(json, ['returns', 0, 'status'], 'cancelled')],
        ['返品 customer_status', changed(json, ['returns', 0, 'customer_status'], 'weird')],
        ['返品 return_method', changed(json, ['returns', 0, 'return_method'], 'weird')],
        ['返品 return_shipping_payer', changed(json, ['returns', 0, 'return_shipping_payer'], 'weird')],
        ['返品 return_shipping_fee 文字列', changed(json, ['returns', 0, 'return_shipping_fee'], '800')],
        ['返品 requested_at', changed(json, ['returns', 0, 'requested_at'], 'x')],
        ['返品 closed_at 数値', changed(json, ['returns', 0, 'closed_at'], 5)],
        ['返品 lines null', changed(json, ['returns', 0, 'lines'], null)],
        ['返品 lines quantity', changed(json, ['returns', 0, 'lines', 0, 'quantity'], '1')],
        ['返品 lines resolution', changed(json, ['returns', 0, 'lines', 0, 'resolution'], 'weird')],
        ['返品 lines requested_resolution', changed(json, ['returns', 0, 'lines', 0, 'requested_resolution'], 'weird')],
        ['返品 lines exchange 文字列', changed(json, ['returns', 0, 'lines', 0, 'exchange'], 'x')],
        ['返品 lines item_name', changed(json, ['returns', 0, 'lines', 0, 'item_name'], null)],
        ['返品 refund_amount 文字列', changed(json, ['returns', 0, 'refund_amount'], '5')],
        ['返品 sent_back null', changed(json, ['returns', 0, 'sent_back'], null)],
        ['返品 sent_back message 数値', changed(json, ['returns', 0, 'sent_back', 0, 'message'], 5)],
        ['返品 sent_back quantity', changed(json, ['returns', 0, 'sent_back', 0, 'quantity'], 'x')],
        ['返品 decline_message 数値', changed(json, ['returns', 0, 'decline_message'], 5)],
        ['返品 exchange_shipping', changed(json, ['returns', 0, 'exchange_shipping'], 'weird')],
        ['cancel_requests null', changed(json, ['cancel_requests'], null)],
        ['cancel_requests status', changed(json, ['cancel_requests', 0, 'status'], 'weird')],
        ['cancel_requests requested_at', changed(json, ['cancel_requests', 0, 'requested_at'], 'x')],
        ['cancel_requests lines quantity', changed(json, ['cancel_requests', 0, 'lines', 0, 'quantity'], 'x')],
        ['availability null', changed(json, ['availability'], null)],
        ['availability.returns', changed(json, ['availability', 'returns'], 'weird')],
        ['availability.ended_on 数値', changed(json, ['availability', 'ended_on'], 5)],
        ['availability.cancel 文字列', changed(json, ['availability', 'cancel'], 'yes')],
      ];
      if (includePrivate) {
        cases.push(
          ['return_address 文字列', changed(json, ['returns', 0, 'return_address'], 'x')],
          ['return_address の欄が足りない', changed(json, ['returns', 0, 'return_address'], { name: 'x' })],
          ['return_address のキーが無い', changed(json, ['returns', 0, 'return_address'], REMOVE)],
          ['sent_back carrier 数値', changed(json, ['returns', 0, 'sent_back', 0, 'carrier'], 5)],
          ['sent_back carrier のキーが無い', changed(json, ['returns', 0, 'sent_back', 0, 'carrier'], REMOVE)],
          ['sent_back tracking_number 数値', changed(json, ['returns', 0, 'sent_back', 1, 'tracking_number'], 5)],
          ['sent_back tracking_number のキーが無い', changed(json, ['returns', 0, 'sent_back', 1, 'tracking_number'], REMOVE)],
        );
      }
      return cases;
    };

    const accepted: string[] = [];
    for (const includePrivate of [false, true]) {
      for (const [name, data] of buildCases(includePrivate ? privateReturnsJson() : publicReturnsJson(), includePrivate)) {
        const { store } = makeStore({ rpc: { get_order_status_returns: { data } } });
        const outcome = await loadReturns(store, includePrivate).then(
          () => 'resolved',
          (error: unknown) => (error instanceof OrderStatusStoreError && error.code === 'ORDER_STATUS_STORE_FAILED' ? 'store-error' : 'other-error'),
        );
        if (outcome !== 'store-error') accepted.push(`${includePrivate ? 'private' : 'public'} ${name}: ${outcome}`);
      }
    }
    expect(accepted).toEqual([]);
  });

  test('返品のDB失敗は固定エラー', async () => {
    const dbError = { message: SECRET_SENTINEL, code: '08006' };
    const { store } = makeStore({ rpc: { get_order_status_returns: { error: dbError } } });

    for (const includePrivate of [false, true]) {
      const storeError = await expectStoreError(() => loadReturns(store, includePrivate), 'get_order_status_returns');
      expect(storeError.cause).toBe(dbError);
    }
  });
});

// ---- 個人情報 ----

const ORDER_ROW = {
  shipping_full_name: '山田 花子',
  shipping_postal_code: '150-0001',
  shipping_prefecture: '東京都',
  shipping_city: '渋谷区',
  shipping_address: '神宮前1-2-3',
  shipping_building: 'Aビル 3F',
  shipping_phone: '090-1234-5678',
  shipping_email: 'hanako@example.com',
  payment_intent_id: 'pi_test_123',
};
const ORDER_ROW_OUTPUT = {
  shipping_full_name: '山田 花子',
  shipping_postal_code: '150-0001',
  shipping_prefecture: '東京都',
  shipping_city: '渋谷区',
  shipping_address: '神宮前1-2-3',
  shipping_building: 'Aビル 3F',
  shipping_phone: '090-1234-5678',
  shipping_email: 'hanako@example.com',
};
const FULFILLMENT_ROWS = [
  { id: FULFILLMENT_1, number: 1, shipping_carrier: 'yamato', tracking_number: 'AB-1234', cancelled_at: null },
  { id: FULFILLMENT_2, number: 2, shipping_carrier: null, tracking_number: null, cancelled_at: null },
];

function privateStore(overrides: { orders?: Answer; drafts?: Answer; fulfillments?: Answer; returns?: RpcAnswer } = {}) {
  return makeStore({
    rpc: { get_order_status_returns: overrides.returns ?? { data: privateReturnsJson() } },
    tables: {
      orders: overrides.orders ?? { data: ORDER_ROW },
      checkout_drafts: overrides.drafts ?? { data: { payment_method: 'card' } },
      order_fulfillments: overrides.fulfillments ?? { data: FULFILLMENT_ROWS },
    },
  });
}

describe('loadOrderStatusPrivateInput', () => {
  test('個人情報のstoreは認可済みの注文だけ名指しの列で読む', async () => {
    const { store, queryCalls, rpcCalls } = privateStore();

    const input = await loadOrderStatusPrivateInput(store, ORDER_ID);

    const selectedColumns = queryCalls.filter((call) => call.method === 'select').map((call) => [call.table, call.args[0]]);
    const expectedPrivateColumns = [
      ['orders', 'shipping_full_name,shipping_postal_code,shipping_prefecture,shipping_city,shipping_address,shipping_building,shipping_phone,shipping_email,payment_intent_id'],
      ['checkout_drafts', 'payment_method'],
      ['order_fulfillments', 'id,number,shipping_carrier,tracking_number,cancelled_at'],
    ];
    expect(selectedColumns).toEqual(expectedPrivateColumns);
    expect(input).not.toBeNull();
    expect(rpcCalls).toEqual([['get_order_status_returns', { _order_id: ORDER_ID, _include_private: true }]]);
  });

  test('絞り込み（注文の番号・隠す状態の除外・取消でない発送・番号の昇順）をDB側に付ける', async () => {
    const { store, queryCalls } = privateStore();

    await loadOrderStatusPrivateInput(store, ORDER_ID);

    const byTable = (table: string) => queryCalls.filter((call) => call.table === table).map((call) => [call.method, ...call.args]);
    expect(byTable('orders')).toEqual([
      ['select', expect.any(String)],
      ['eq', 'id', ORDER_ID],
      ['not', 'status', 'in', HIDDEN_ORDER_STATUS_FILTER],
      ['maybeSingle'],
    ]);
    expect(byTable('checkout_drafts')).toEqual([
      ['select', 'payment_method'],
      ['eq', 'payment_intent_id', 'pi_test_123'],
      ['limit', 1],
      ['maybeSingle'],
    ]);
    expect(byTable('order_fulfillments')).toEqual([
      ['select', expect.any(String)],
      ['eq', 'order_id', ORDER_ID],
      ['is', 'cancelled_at', null],
      ['order', 'number', { ascending: true }],
    ]);
  });

  test('住所・連絡先・支払方法・発送・返品を、認可後の入力の形で返す。payment_intent_id は出さない', async () => {
    const { store } = privateStore();

    const input = await loadOrderStatusPrivateInput(store, ORDER_ID);

    expect(input?.order).toEqual(ORDER_ROW_OUTPUT);
    expect(input?.paymentMethod).toBe('card');
    expect(input?.fulfillments).toEqual([
      { fulfillmentId: FULFILLMENT_1, number: 1, shippingCarrier: 'yamato', trackingNumber: 'AB-1234', cancelledAt: null },
      { fulfillmentId: FULFILLMENT_2, number: 2, shippingCarrier: null, trackingNumber: null, cancelledAt: null },
    ]);
    expect(input?.returnSection).toMatchObject(RETURNS_EXTRAS);
    expect(JSON.stringify(input).includes('pi_test_123')).toBe(false);
    expect(Object.keys(input?.order ?? {})).not.toContain('payment_intent_id');
  });

  test('返送先は accepted / partially_received の返品だけに残り、送り返しは元の配列indexのまま残る', async () => {
    const { store } = privateStore();

    const input = await loadOrderStatusPrivateInput(store, ORDER_ID);

    const addressByStatus = Object.fromEntries((input?.returnSection?.returns ?? []).map((entry) => [entry.customerStatus, entry.returnAddress !== null]));
    expect(addressByStatus).toEqual({
      requested: false,
      accepted: true,
      partially_received: true,
      inspecting: false,
      awaiting_fee: false,
      refund_preparing: false,
      returned: false,
      declined: false,
    });
    for (const entry of input?.returnSection?.returns ?? []) {
      expect(entry.sentBack.map((sent) => sent.trackingNumber)).toEqual([null, `AB-${entry.number}`]);
      expect(entry.sentBack.map((sent) => sent.itemName)).toEqual(['レザーベルト', 'ウールコート']);
    }
    const accepted = input?.returnSection?.returns.find((entry) => entry.customerStatus === 'accepted');
    expect(accepted?.returnAddress).toEqual({ name: '返品係', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3', phone: '03-1234-5678' });
  });

  test('発送の無い注文は空の配列、支払方法の無い注文（payment_intent_id なし・下書き無し）は null', async () => {
    const noShipments = privateStore({ fulfillments: { data: [] } });
    await expect(loadOrderStatusPrivateInput(noShipments.store, ORDER_ID)).resolves.toMatchObject({ fulfillments: [] });

    const noIntent = privateStore({ orders: { data: { ...ORDER_ROW, payment_intent_id: null } } });
    const result = await loadOrderStatusPrivateInput(noIntent.store, ORDER_ID);
    expect(result?.paymentMethod).toBeNull();
    expect(noIntent.queryCalls.some((call) => call.table === 'checkout_drafts')).toBe(false);

    const noDraft = privateStore({ drafts: { data: null } });
    await expect(loadOrderStatusPrivateInput(noDraft.store, ORDER_ID)).resolves.toMatchObject({ paymentMethod: null });
  });

  test('空欄・電話なしなど null の住所の項目もそのまま null で渡す', async () => {
    const empty = {
      shipping_full_name: null, shipping_postal_code: null, shipping_prefecture: null, shipping_city: null,
      shipping_address: null, shipping_building: null, shipping_phone: null, shipping_email: null, payment_intent_id: null,
    };
    const { store } = privateStore({ orders: { data: empty } });

    const input = await loadOrderStatusPrivateInput(store, ORDER_ID);

    expect(input?.order).toEqual(Object.fromEntries(Object.keys(ORDER_ROW_OUTPUT).map((key) => [key, null])));
    expect(Object.keys(input?.order ?? {}).sort()).toEqual(Object.keys(ORDER_ROW_OUTPUT).sort());
  });

  test('注文が無い・隠す状態なら null。ほかの読み取りをしない', async () => {
    const { store, queryCalls, rpcCalls } = privateStore({ orders: { data: null } });

    await expect(loadOrderStatusPrivateInput(store, ORDER_ID)).resolves.toBeNull();

    expect(queryCalls.every((call) => call.table === 'orders')).toBe(true);
    expect(rpcCalls).toEqual([]);
  });

  test('返品の読み出しが SQL の NULL（読む間に注文が隠れた）なら、個人情報を空で返さず null', async () => {
    const { store } = privateStore({ returns: { data: null } });

    await expect(loadOrderStatusPrivateInput(store, ORDER_ID)).resolves.toBeNull();
  });

  test('壊れた答えとDB失敗を空の成功にしない', async () => {
    const dbError = { message: SECRET_SENTINEL, code: '08006' };
    const failures: Array<[string, ReturnType<typeof privateStore>]> = [
      ['orders のDB失敗', privateStore({ orders: { error: dbError } })],
      ['checkout_drafts のDB失敗', privateStore({ drafts: { error: dbError } })],
      ['order_fulfillments のDB失敗', privateStore({ fulfillments: { error: dbError } })],
      ['返品RPCのDB失敗', privateStore({ returns: { error: dbError } })],
      ['orders の列が文字列でない', privateStore({ orders: { data: { ...ORDER_ROW, shipping_phone: 5 } } })],
      ['orders の列が無い', privateStore({ orders: { data: { ...ORDER_ROW, shipping_email: undefined } } })],
      ['orders が配列', privateStore({ orders: { data: [ORDER_ROW] } })],
      ['orders の payment_intent_id が数値', privateStore({ orders: { data: { ...ORDER_ROW, payment_intent_id: 5 } } })],
      ['下書きの支払方法が数値', privateStore({ drafts: { data: { payment_method: 5 } } })],
      ['下書きの支払方法が無い', privateStore({ drafts: { data: {} } })],
      ['発送が配列でない', privateStore({ fulfillments: { data: {} } })],
      ['発送が null', privateStore({ fulfillments: { data: null } })],
      ['発送の id が UUID でない', privateStore({ fulfillments: { data: [{ ...FULFILLMENT_ROWS[0], id: 'x' }] } })],
      ['発送の番号が文字列', privateStore({ fulfillments: { data: [{ ...FULFILLMENT_ROWS[0], number: '1' }] } })],
      ['発送の番号が0', privateStore({ fulfillments: { data: [{ ...FULFILLMENT_ROWS[0], number: 0 }] } })],
      ['発送の伝票番号が数値', privateStore({ fulfillments: { data: [{ ...FULFILLMENT_ROWS[0], tracking_number: 5 }] } })],
      ['発送の取消日が数値', privateStore({ fulfillments: { data: [{ ...FULFILLMENT_ROWS[0], cancelled_at: 5 }] } })],
      ['返品の答えが壊れている', privateStore({ returns: { data: { returns: 'x' } } })],
    ];

    const accepted: string[] = [];
    for (const [name, { store }] of failures) {
      const outcome = await loadOrderStatusPrivateInput(store, ORDER_ID).then(
        () => 'resolved',
        (error: unknown) => (error instanceof OrderStatusStoreError && error.code === 'ORDER_STATUS_STORE_FAILED' && error.message === 'order status store failed' ? 'store-error' : 'other-error'),
      );
      if (outcome !== 'store-error') accepted.push(`${name}: ${outcome}`);
    }
    expect(accepted).toEqual([]);
  });

  test('DB失敗の元の文は cause にだけ残り、固定エラーの文・operation に入らない', async () => {
    const dbError = { message: SECRET_SENTINEL, code: '08006' };
    const { store } = privateStore({ orders: { error: dbError } });

    const storeError = await expectStoreError(() => loadOrderStatusPrivateInput(store, ORDER_ID));

    expect(storeError.cause).toBe(dbError);
    expect(storeError.operation.includes(SECRET_SENTINEL)).toBe(false);
  });

  test('from が例外を投げても固定エラーにする', async () => {
    const { store } = privateStore();
    (store as unknown as { from: () => never }).from = () => {
      throw new Error(SECRET_SENTINEL);
    };

    await expectStoreError(() => loadOrderStatusPrivateInput(store, ORDER_ID));
  });
});

describe('store 全体の失敗', () => {
  test('壊れたRPCの答えとDB失敗を空の成功にしない', async () => {
    const dbError = { message: `${SECRET_SENTINEL} 5678`, code: 'XX000' };
    const brokenAnswer = { unexpected: 'shape' };
    const runs: Array<[string, (store: OrderStatusStore) => Promise<unknown>]> = [
      ['ensure_order_status_link', (store) => ensureOrderStatusLink(store, ORDER_ID)],
      ['get_order_status_link', (store) => getOrderStatusLink(store, TOKEN)],
      ['verify_order_status_phone', (store) => verifyOrderStatusPhone(store, { token: TOKEN, lastFour: '5678' })],
      ['get_order_status_public_material', (store) => loadOrderStatusPublicMaterial(store, ORDER_ID)],
      ['get_order_status_returns', (store) => loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: false })],
      ['get_order_status_returns', (store) => loadOrderStatusReturns(store, { orderId: ORDER_ID, includePrivate: true })],
    ];

    for (const [operation, run] of runs) {
      const failing = makeStore({ rpc: { [operation]: { error: dbError } } });
      const failure = await expectStoreError(() => run(failing.store), operation);
      expect(failure.cause).toBe(dbError);

      const broken = makeStore({ rpc: { [operation]: { data: brokenAnswer } } });
      const error = await expectStoreError(() => run(broken.store), operation);
      expect(error.code).toBe('ORDER_STATUS_STORE_FAILED');
      expect(error.message.includes(SECRET_SENTINEL)).toBe(false);
    }

    const failingPrivate = privateStore({ orders: { error: dbError } });
    const privateError = await expectStoreError(() => loadOrderStatusPrivateInput(failingPrivate.store, ORDER_ID));
    expect(privateError.code).toBe('ORDER_STATUS_STORE_FAILED');
    expect(privateError.message.includes(SECRET_SENTINEL)).toBe(false);
  });
});

describe('OrderStatusStoreError', () => {
  test('message は固定、operation と code を持ち、元のエラーは cause にだけ残る', () => {
    const cause = new Error(SECRET_SENTINEL);

    const error = new OrderStatusStoreError('verify_order_status_phone', cause);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('OrderStatusStoreError');
    expect(error.message).toBe('order status store failed');
    expect(error.operation).toBe('verify_order_status_phone');
    expect(error.code).toBe('ORDER_STATUS_STORE_FAILED');
    expect(error.cause).toBe(cause);
  });

  test('cause を渡さなければ cause は持たない', () => {
    const error = new OrderStatusStoreError('get_order_status_link');

    expect('cause' in error).toBe(false);
  });
});

// ---- 固定文（C-4・C-5）。画面と窓口が同じ文を使うため、一字も変えないことをここで固定する ----

describe('固定文', () => {
  test('C-4 の誤りの記号ごとの文を一字も変えず持つ', () => {
    const expected: Record<OrderStatusErrorCode, string> = {
      ORDER_STATUS_NOT_FOUND: 'このページは見つかりません',
      ORDER_STATUS_INPUT_INVALID: '電話番号の下4桁を入れてください。',
      ORDER_STATUS_MISMATCH: '電話番号の下4桁が一致しません。もう一度確かめてください。',
      ORDER_STATUS_LOCKED: '確認できる回数を超えました。ログインするか、お問い合わせください。',
      ORDER_STATUS_UNAVAILABLE: 'ログインするか、お問い合わせください',
      ORDER_STATUS_EXPIRED: '電話番号で確認できる期間が過ぎました。ログインするか、お問い合わせください。',
      ORDER_STATUS_RATE_LIMITED: 'しばらくしてから、もう一度お試しください。',
      ORDER_STATUS_FORBIDDEN: '画面を開き直して、もう一度お試しください。',
      ORDER_STATUS_AUTH_REQUIRED: 'ログインするか、電話番号の下4桁で確かめてください。',
      ORDER_STATUS_TEMPORARILY_UNAVAILABLE: 'ただいま確認できません。時間をおいて、もう一度お試しください。',
      ORDER_STATUS_FAILED: 'ご注文の状況を読み込めませんでした。時間をおいて、もう一度お試しください。',
    };

    expect(ORDER_STATUS_ERROR_MESSAGES).toEqual(expected);
    expect(Object.keys(ORDER_STATUS_ERROR_MESSAGES).sort()).toEqual(Object.keys(expected).sort());
  });

  test('C-5 の画面の文を一字も変えず持つ', () => {
    const text = ORDER_STATUS_TEXT;

    expect([
      text.metadataTitle,
      text.heading,
      text.orderNumber('ORD-A1B2C3D4'),
      text.orderDate('2026/10/20 10:00'),
      text.progressAriaLabel,
      text.shipment.heading(2),
      text.shipment.shippedAt,
      text.shipment.carrier,
      text.shipment.deliveredAt,
      text.shipment.lastUpdate,
      text.shipment.history,
      text.shipment.trackingNumber,
      text.shipment.trackingLink,
      text.shipment.deliveredOn('10月22日'),
      text.shipment.updatedAt('2026/10/22 12:00'),
      text.shipment.problem,
      text.unshipped.readyHeading,
      text.unshipped.inProductionHeading,
      text.items.heading,
      text.items.quantity(3),
      text.items.exchange,
      text.items.refunded(1),
      text.items.exchangeAmount,
      text.items.colorSize('白', 'M'),
      text.amounts.heading,
      text.amounts.subtotal,
      text.amounts.shipping,
      text.amounts.discount,
      text.amounts.total,
      text.refunds.heading,
      text.refunds.processing,
      text.refunds.completed,
      text.refunds.total,
    ]).toEqual([
      'ご注文の状況 | Le Fil des Heures',
      'ご注文の状況',
      '注文番号 ORD-A1B2C3D4',
      'ご注文日 2026/10/20 10:00',
      '配送ステータス',
      '配送情報（2回目）',
      '発送日',
      '配送業者',
      'お届け日',
      '最後の更新',
      '配送の移り変わり',
      '追跡番号',
      '配送状況を確認する',
      'お届け日 10月22日',
      '最後の更新 2026/10/22 12:00',
      '配送に遅れや問題が出ています。詳しくは配送業者のページをご確認ください',
      '発送準備中の商品',
      '受注生産中の商品',
      'ご注文商品',
      '数量: 3',
      '交換の品',
      '返金済み 1点',
      '—',
      '白 / M',
      '支払金額',
      '小計',
      '送料',
      'クーポン値引き',
      '支払金額',
      'ご返金',
      '手続き中',
      '完了',
      'ご返金の合計',
    ]);

    expect([
      text.verify.heading,
      text.verify.description,
      text.verify.label,
      text.verify.hint,
      text.verify.placeholder,
      text.verify.submit,
      text.verify.submitting,
      text.verify.verified,
      text.verify.loadingPrivate,
      text.private.shippingHeading,
      text.private.contactHeading,
      text.private.paymentHeading,
      text.private.trackingHeading,
      text.private.returnsHeading,
      text.private.name,
      text.private.postalCode,
      text.private.address,
      text.private.phone,
      text.private.email,
      text.private.empty,
      text.private.trackingNumber('AB-1234'),
      text.private.returnAddress,
      text.private.returnAddressLine('150-0001', '東京都渋谷区神宮前1-2-3'),
      text.private.sentBackTracking('AB-9'),
    ]).toEqual([
      'お届け先などの確認',
      'お届け先・お支払い方法・伝票番号を見るには、ご注文の時の電話番号の下4桁を入れてください。',
      'ご注文の時の電話番号の下4桁',
      '数字4桁を入れてください。',
      '1234',
      '確かめる',
      '確認中…',
      '確認できました。',
      'お届け先などを確認しています。',
      'お届け先',
      'ご連絡先',
      'お支払い方法',
      '伝票番号',
      '返品の返送先・送り返しの伝票番号',
      'お名前',
      '郵便番号',
      '住所',
      '電話番号',
      'メールアドレス',
      '-',
      '追跡番号 AB-1234',
      '返送先:',
      '〒150-0001 東京都渋谷区神宮前1-2-3',
      '送り返しの伝票番号: AB-9',
    ]);

    expect([
      text.login.label,
      text.login.href,
      text.guest.heading,
      text.guest.registerDescription,
      text.guest.registerLabel,
      text.guest.registerHref,
      text.guest.contactDescription,
      text.guest.contactLabel,
      text.guest.contactHref('ORD-A1B2C3D4'),
      text.owner.heading,
      text.owner.description,
      text.owner.linkLabel,
      text.owner.href(ORDER_ID),
      text.reload,
      text.notFoundLink.label,
      text.notFoundLink.href,
    ]).toEqual([
      'ログインする',
      '/login',
      '返品・キャンセルをご希望の方へ',
      'ご注文の時と同じメールアドレスで会員登録し、メールの確認を済ませると、このご注文が会員の注文履歴に入り、そこから返品・キャンセルを申し込めます。',
      '会員登録して申し込む',
      '/login?tab=register',
      '会員登録をせずにお申し込みをご希望の方は、お問い合わせからご連絡ください。注文番号は入力済みで開きます。',
      'お問い合わせから申し込む',
      '/contact?type=order&order=ORD-A1B2C3D4',
      '返品・キャンセルのお申し込み',
      '返品・キャンセルのお申し込みは、会員の注文のページで受け付けています。',
      '会員の注文のページへ',
      `/account/orders/${ORDER_ID}`,
      'もう一度読み込む',
      'トップページへ',
      '/',
    ]);
  });
});
