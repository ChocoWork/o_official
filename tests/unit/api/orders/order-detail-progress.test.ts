jest.mock('next/server', () => {
  const original = jest.requireActual('next/server');
  return {
    ...original,
    NextResponse: {
      json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
        status: init?.status ?? 200,
        body,
        headers: init?.headers ?? {},
      }),
    },
  };
});

jest.mock('@/lib/auth/authenticate', () => ({
  authenticateRequest: jest.fn().mockResolvedValue({ ok: true, claims: { sub: 'user-1' } }),
  authFailureResponse: jest.fn(),
}));

jest.mock('@/lib/storage/item-images', () => ({
  signItemImageUrl: jest.fn(async (_client: unknown, url: string | null) => url),
}));

// 持ち主の確かめ（お客様の権限の client）。ここで見つからなければ 404
const mockOwnerQuery = {
  select: jest.fn(),
  eq: jest.fn(),
  not: jest.fn(),
  maybeSingle: jest.fn(),
};
const mockServiceClient = { from: jest.fn() };
const mockCreateServiceRoleClient = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ from: () => mockOwnerQuery })),
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));

const mockListLines = jest.fn();
const mockListFulfillments = jest.fn();
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({
  listOrderLineFulfillment: (...args: unknown[]) => mockListLines(...args),
  listOrderFulfillments: (...args: unknown[]) => mockListFulfillments(...args),
}));

const mockListRefunds = jest.fn();
jest.mock('@/lib/orders/refund/refund-store', () => ({
  listOrderRefunds: (...args: unknown[]) => mockListRefunds(...args),
}));

// 返品・交換の欄（グループ E-3 段2）。実物の読み出し（DB の関数）は使わず、答えを差し替える
const mockLoadCustomerOrderReturns = jest.fn();
jest.mock('@/lib/orders/returns/customer-return-store', () => ({
  loadCustomerOrderReturns: (...args: unknown[]) => mockLoadCustomerOrderReturns(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/orders/[id]/route';
import type { CustomerOrderReturns } from '@/lib/orders/returns/customer-return-types';

type Json = Record<string, any>;
type RouteResponse = { status: number; body: Json; headers: Record<string, string> };

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

async function getDetail(): Promise<RouteResponse> {
  const response = await GET(new NextRequest(`http://localhost/api/orders/${ORDER_ID}`), {
    params: Promise.resolve({ id: ORDER_ID }),
  });
  return response as unknown as RouteResponse;
}

// console.error に渡された物を1つの文字にする。Error はそのまま渡されると DB の文（message・cause）が出るので、開いて確かめる
function loggedText(spy: jest.SpyInstance): string {
  return spy.mock.calls
    .flat()
    .map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message} ${JSON.stringify(arg.cause)}` : String(arg)))
    .join(' ');
}

const STOCK_ITEM = {
  id: 'line-stock', item_id: 10, variant_id: 101, item_name: 'リネンシャツ', item_image_url: null,
  color: '白', size: 'M', quantity: 2, line_total: 24000, line_kind: 'order',
};
const MADE_ITEM = {
  id: 'line-made', item_id: 11, variant_id: 111, item_name: 'ウールコート', item_image_url: null,
  color: '黒', size: 'L', quantity: 1, line_total: 58000, line_kind: 'order',
};
// 返品の交換でお店が足した品の行（同じ商品の色・サイズ違い）。値段は 0
const EXCHANGE_ITEM = {
  id: 'line-exchange', item_id: 10, variant_id: 102, item_name: 'リネンシャツ', item_image_url: null,
  color: '白', size: 'L', quantity: 1, line_total: 0, line_kind: 'exchange',
};

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID, created_at: '2026-10-01T00:00:00.000Z', status: 'paid', payment_intent_id: null,
    subtotal_amount: 82000, shipping_amount: 0, discount_amount: 0, total_amount: 82000, currency: 'jpy',
    shipping_full_name: '山田 花子', shipping_email: 'hanako@example.com', shipping_postal_code: '1500001',
    shipping_prefecture: '東京都', shipping_city: '渋谷区', shipping_address: '神宮前1-2-3', shipping_building: null,
    shipping_phone: '090-1111-2222',
    order_items: [STOCK_ITEM, MADE_ITEM],
    ...overrides,
  };
}

// 在庫の品2点が発送準備中
function stockLine(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID, orderItemId: 'line-stock', variantId: 101, fulfillmentType: 'stock', quantity: 2,
    shipped: 0, completed: 2, refundedBeforeShipment: 0, refundedAfterShipment: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
    ...overrides,
  };
}

// 受注生産の品1点が作っている途中
function madeLine(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID, orderItemId: 'line-made', variantId: 111, fulfillmentType: 'backorder', quantity: 1,
    shipped: 0, completed: 0, refundedBeforeShipment: 0, refundedAfterShipment: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
    ...overrides,
  };
}

// 交換の品1点（在庫から）が発送準備中
function exchangeLine(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID, orderItemId: 'line-exchange', variantId: 102, fulfillmentType: 'stock', quantity: 1,
    shipped: 0, completed: 1, refundedBeforeShipment: 0, refundedAfterShipment: 0, inProduction: 0, readyUnshipped: 1, unshipped: 1,
    ...overrides,
  };
}

function fulfillment(overrides: Record<string, unknown> = {}) {
  return {
    fulfillmentId: 'ful-1', number: 1, shippingCarrier: 'yamato', trackingNumber: '1234-5678-9012',
    notifyCustomer: true, completesOrder: false, shippedAt: '2026-10-05T15:30:00.000Z',
    createdByEmail: 'admin@example.com', cancelledAt: null, cancelledByEmail: null, legacy: false,
    lines: [{ orderItemId: 'line-stock', quantity: 2 }], ...overrides,
  };
}

// listOrderRefunds の1行。お客様に出さない内側の情報（操作した人のメール・メモ・照会番号など）も入れておき、答えに混ざらないことを確かめる
function refundRow(overrides: Record<string, unknown> = {}) {
  return {
    refundId: 'refund-1', source: 'admin', status: 'succeeded', stripeStatus: 'succeeded', pendingReason: null,
    failureReason: null, customerActionExpiresAt: null, paymentMethodType: 'card', amount: 12000, shippingAmount: 0,
    adjustmentAmount: 0, note: '社内メモ', stripeReason: 'requested_by_customer', cancelReason: null, notifyCustomer: true,
    actorEmail: 'admin@example.com', referenceNumber: 'ARN-123456', referenceType: 'acquirer_reference_number',
    createdAt: '2026-10-12T03:00:00.000Z', acceptedAt: '2026-10-12T03:00:01.000Z', succeededAt: '2026-10-12T03:00:02.000Z',
    failedAt: null, erroredAt: null, lines: [], ...overrides,
  };
}

function setup(options: { order?: unknown; lines?: unknown[]; fulfillments?: unknown[]; refunds?: unknown[] } = {}) {
  const { order = orderRow(), lines = [stockLine(), madeLine()], fulfillments = [], refunds = [] } = options;
  mockOwnerQuery.maybeSingle.mockResolvedValue({ data: order, error: null });
  mockListLines.mockResolvedValue(new Map([[ORDER_ID, lines]]));
  mockListFulfillments.mockResolvedValue(fulfillments);
  mockListRefunds.mockResolvedValue(refunds);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnerQuery.select.mockReturnValue(mockOwnerQuery);
  mockOwnerQuery.eq.mockReturnValue(mockOwnerQuery);
  mockOwnerQuery.not.mockReturnValue(mockOwnerQuery);
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
  mockLoadCustomerOrderReturns.mockResolvedValue(null);
});

describe('GET /api/orders/[id] の発送と進み具合（グループ E-1）', () => {
  it('持ち主の確かめを通った注文だけ、同じ service_role の client で数と発送を読む', async () => {
    setup();

    const response = await getDetail();

    expect(response.status).toBe(200);
    expect(mockOwnerQuery.eq).toHaveBeenCalledWith('id', ORDER_ID);
    expect(mockOwnerQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mockListLines).toHaveBeenCalledWith(mockServiceClient, [ORDER_ID]);
    expect(mockListFulfillments).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
  });

  it('他のお客様の注文（持ち主の確かめで見つからない）は 404 で、service_role を使わない', async () => {
    setup({ order: null });

    const response = await getDetail();

    expect(response.status).toBe(404);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockListLines).not.toHaveBeenCalled();
    expect(mockListFulfillments).not.toHaveBeenCalled();
  });

  it('持ち主の確かめの読み取りが失敗したら 500 で、service_role を使わない', async () => {
    setup();
    mockOwnerQuery.maybeSingle.mockResolvedValue({ data: null, error: { message: 'down' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getDetail();

    expect(response.status).toBe(500);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('入金済みで受注生産の品がまだ仕上がっていない注文は「受注生産中」で、5段', async () => {
    setup();

    const { body } = await getDetail();

    expect(body.status).toBe('paid');
    expect(body.progress).toEqual({
      key: 'in_production',
      label: '受注生産中',
      partiallyShipped: false,
      steps: [
        { key: 'payment', label: 'お支払い', state: 'done' },
        { key: 'in_production', label: '受注生産中', state: 'current' },
        { key: 'ready', label: '発送準備中', state: 'todo' },
        { key: 'in_transit', label: '配送中', state: 'todo' },
        { key: 'delivered', label: '配達済み', state: 'todo' },
      ],
    });
  });

  it('在庫の品を先に送った注文は、受注生産中のまま「一部発送済み」', async () => {
    setup({
      lines: [stockLine({ shipped: 2, readyUnshipped: 0, unshipped: 0 }), madeLine()],
      fulfillments: [fulfillment()],
    });

    const { body } = await getDetail();

    expect(body.progress).toMatchObject({ key: 'in_production', label: '受注生産中', partiallyShipped: true });
  });

  it('在庫の品だけの注文は4段で、発送の前は「発送準備中」', async () => {
    setup({ order: orderRow({ order_items: [STOCK_ITEM] }), lines: [stockLine()] });

    const { body } = await getDetail();

    expect(body.progress).toEqual({
      key: 'ready',
      label: '発送準備中',
      partiallyShipped: false,
      steps: [
        { key: 'payment', label: 'お支払い', state: 'done' },
        { key: 'ready', label: '発送準備中', state: 'current' },
        { key: 'in_transit', label: '配送中', state: 'todo' },
        { key: 'delivered', label: '配達済み', state: 'todo' },
      ],
    });
  });

  it('全部を送った注文（発送済み）は「配送中」で、発送準備中までが済んだ段になる', async () => {
    setup({
      order: orderRow({ status: 'shipped', order_items: [STOCK_ITEM] }),
      lines: [stockLine({ shipped: 2, readyUnshipped: 0, unshipped: 0 })],
      fulfillments: [fulfillment({ completesOrder: true })],
    });

    const { body } = await getDetail();

    expect(body.status).toBe('shipped');
    expect(body.progress).toEqual({
      key: 'in_transit',
      label: '配送中',
      partiallyShipped: false,
      steps: [
        { key: 'payment', label: 'お支払い', state: 'done' },
        { key: 'ready', label: '発送準備中', state: 'done' },
        { key: 'in_transit', label: '配送中', state: 'current' },
        { key: 'delivered', label: '配達済み', state: 'todo' },
      ],
    });
  });

  it('未決済の注文は「未決済」でお支払いの段が今の段。品を発送準備中や受注生産中として出さない（T8-1）', async () => {
    setup({ order: orderRow({ status: 'pending' }) });

    const { body } = await getDetail();

    expect(body.progress.label).toBe('未決済');
    expect(body.progress.steps[0]).toEqual({ key: 'payment', label: 'お支払い', state: 'current' });
    expect(body.items.map((item: Json) => [item.readyQuantity, item.inProductionQuantity])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('キャンセルの注文は段を出さず、言葉だけ返す', async () => {
    setup({ order: orderRow({ status: 'cancelled' }) });

    const { body } = await getDetail();

    expect(body.progress).toEqual({ key: 'cancelled', label: 'キャンセル', partiallyShipped: false, steps: null });
  });

  it('商品ごとに、発送した数・発送準備中の数・受注生産中の数を返す', async () => {
    setup({ lines: [stockLine({ shipped: 1, readyUnshipped: 1, unshipped: 1 }), madeLine()] });

    const { body } = await getDetail();

    expect(body.items).toEqual([
      expect.objectContaining({ id: 'line-stock', shippedQuantity: 1, readyQuantity: 1, inProductionQuantity: 0 }),
      expect.objectContaining({ id: 'line-made', shippedQuantity: 0, readyQuantity: 0, inProductionQuantity: 1 }),
    ]);
  });

  it('発送は取り消していない分だけを、1回目から順に、その発送の商品つきで返す（T8-2）', async () => {
    setup({
      fulfillments: [
        fulfillment({ fulfillmentId: 'ful-3', number: 3, cancelledAt: '2026-10-07T00:00:00.000Z', cancelledByEmail: 'admin@example.com' }),
        fulfillment({
          fulfillmentId: 'ful-2', number: 2, shippingCarrier: 'sagawa', trackingNumber: 'AB-123',
          shippedAt: '2026-10-20T00:00:00.000Z', lines: [{ orderItemId: 'line-made', quantity: 1 }],
        }),
        fulfillment(),
      ],
    });

    const { body } = await getDetail();

    expect(body.shipments.map((shipment: Json) => shipment.number)).toEqual([1, 2]);
    expect(body.shipments[0]).toEqual({
      id: 'ful-1',
      number: 1,
      shippedAt: '2026-10-05T15:30:00.000Z',
      carrier: 'yamato',
      carrierLabel: 'ヤマト運輸',
      trackingNumber: '1234-5678-9012',
      trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012',
      items: [{ orderItemId: 'line-stock', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2, lineKind: 'order' }],
    });
    expect(body.shipments[1]).toMatchObject({
      id: 'ful-2',
      carrierLabel: '佐川急便',
      trackingUrl: 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=AB-123',
      items: [{ orderItemId: 'line-made', name: 'ウールコート', color: '黒', size: 'L', quantity: 1 }],
    });
  });

  it('前からの発送の記録で配送業者・伝票番号が空でも落ちず、発送日と商品は返し、リンクは返さない', async () => {
    setup({ fulfillments: [fulfillment({ legacy: true, shippingCarrier: null, trackingNumber: null })] });

    const { status, body } = await getDetail();

    expect(status).toBe(200);
    expect(body.shipments).toHaveLength(1);
    expect(body.shipments[0]).toMatchObject({
      carrier: null,
      carrierLabel: null,
      trackingNumber: null,
      trackingUrl: null,
      shippedAt: '2026-10-05T15:30:00.000Z',
      items: [{ orderItemId: 'line-stock', quantity: 2 }],
    });
  });

  it('知らない配送業者の記号は、名前とリンクを空にして返す', async () => {
    setup({ fulfillments: [fulfillment({ shippingCarrier: 'newcarrier' })] });

    const { body } = await getDetail();

    expect(body.shipments[0]).toMatchObject({
      carrier: 'newcarrier',
      carrierLabel: null,
      trackingNumber: '1234-5678-9012',
      trackingUrl: null,
    });
  });

  it('操作した管理者のメールなど内側の情報は、お客様に返さない（T8-4）', async () => {
    setup({ fulfillments: [fulfillment()] });

    const { body } = await getDetail();

    expect(JSON.stringify(body)).not.toContain('admin@example.com');
    expect(Object.keys(body.shipments[0]).sort()).toEqual([
      'carrier', 'carrierLabel', 'id', 'items', 'number', 'shippedAt', 'trackingNumber', 'trackingUrl',
    ]);
  });

  it('注文の行の配送の列は読まず、返さない（発送ごとの shipments に置き換えた）', async () => {
    setup();

    const { body } = await getDetail();

    expect(body).not.toHaveProperty('shippedAt');
    expect(body).not.toHaveProperty('shippingCarrier');
    expect(body).not.toHaveProperty('trackingNumber');
    expect(String(mockOwnerQuery.select.mock.calls[0][0])).not.toMatch(/shipped_at|shipping_carrier|tracking_number/);
  });

  it('今の項目（注文番号・金額・配送先）はそのまま返す', async () => {
    setup();

    const { body } = await getDetail();

    expect(body).toMatchObject({
      id: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      status: 'paid',
      shippingFullName: '山田 花子',
      shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
    });
  });

  it('数や発送の読み取りが失敗したら 500（no-store）で、中身を返さない', async () => {
    setup();
    mockListFulfillments.mockRejectedValue(new Error('rpc failed'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getDetail();

    expect(response.status).toBe(500);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Failed to fetch order detail' });
    // ログには名前だけ残す（code・operation が無ければ null）。DB の文は出さない
    expect(consoleError).toHaveBeenCalledWith('Order fulfillment fetch error:', 'Error', null, null);
    expect(loggedText(consoleError)).not.toContain('rpc failed');
    consoleError.mockRestore();
  });

  it('発送の読み取りの失敗は、ログに名前・code・operation だけを残し、DB の文（宛先など）を出さない', async () => {
    const { FulfillmentStoreError } = jest.requireActual('@/lib/orders/fulfillment/fulfillment-store');
    setup();
    mockListFulfillments.mockRejectedValue(
      new FulfillmentStoreError('list_order_fulfillments', { code: '57014', message: 'DB-MESSAGE 〒1500001 神宮前1-2-3' }),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getDetail();

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      'Order fulfillment fetch error:',
      'FulfillmentStoreError',
      '57014',
      'list_order_fulfillments',
    );
    expect(loggedText(consoleError)).not.toContain('DB-MESSAGE');
    expect(loggedText(consoleError)).not.toContain('神宮前');
    consoleError.mockRestore();
  });
});

describe('GET /api/orders/[id] の返金（グループ E-2）', () => {
  it('持ち主の確かめを通った注文だけ、同じ service_role の client で返金を読む', async () => {
    setup();

    const response = await getDetail();

    expect(response.status).toBe(200);
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mockListRefunds).toHaveBeenCalledTimes(1);
    expect(mockListRefunds).toHaveBeenCalledWith(mockServiceClient, ORDER_ID);
  });

  it('他のお客様の注文（持ち主の確かめで見つからない）は 404 で、service_role も返金の読み取りも使わない', async () => {
    setup({ order: null, refunds: [refundRow()] });

    const response = await getDetail();

    expect(response.status).toBe(404);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Order not found' });
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockListRefunds).not.toHaveBeenCalled();
  });

  it('返金が無い注文は、refunds を空・refundTotal を null・商品の返金した数を 0 で返す', async () => {
    setup();

    const { body } = await getDetail();

    expect(body.refunds).toEqual([]);
    expect(body.refundTotal).toBeNull();
    expect(body.items.map((item: Json) => item.refundedQuantity)).toEqual([0, 0]);
  });

  it('返事待ち・保留は「手続き中」、成功は「完了」で、古い順に返す。日付は日本時間の日付、額は円の言葉（T14-1・T14-2）', async () => {
    // DB の関数は新しい順に返す
    setup({
      refunds: [
        refundRow({ refundId: 'refund-3', status: 'succeeded', amount: 3000, createdAt: '2026-10-15T09:00:00.000Z' }),
        refundRow({ refundId: 'refund-2', status: 'pending', amount: 2000, createdAt: '2026-10-13T01:00:00.000Z' }),
        // 15:30（UTC）は日本時間の翌日 0:30 なので、日付は 10/12
        refundRow({ refundId: 'refund-1', status: 'awaiting_response', amount: 1000, createdAt: '2026-10-11T15:30:00.000Z' }),
      ],
    });

    const { body } = await getDetail();

    expect(body.refunds).toEqual([
      { id: 'refund-1', date: '2026/10/12', amount: expect.stringMatching(/^[¥￥]1,000$/), status: 'processing', customerActionDeadline: null },
      { id: 'refund-2', date: '2026/10/13', amount: expect.stringMatching(/^[¥￥]2,000$/), status: 'processing', customerActionDeadline: null },
      { id: 'refund-3', date: '2026/10/15', amount: expect.stringMatching(/^[¥￥]3,000$/), status: 'completed', customerActionDeadline: null },
    ]);
  });

  it('エラーと失敗の返金は返さない。期限で失敗したコンビニ払いの返金は、額も期限も答えのどこにも出ない（Review Focus 2）', async () => {
    // 失敗の後始末の後: 注文は支払い済みに戻り、商品の返金した数も 0 に戻っている
    setup({
      order: orderRow({ order_items: [STOCK_ITEM] }),
      lines: [stockLine()],
      refunds: [
        refundRow({
          refundId: 'refund-failed', status: 'failed', amount: 13579, paymentMethodType: 'konbini', stripeStatus: 'failed',
          failureReason: 'expired', customerActionExpiresAt: '2026-11-24T15:00:00.000Z',
          createdAt: '2026-10-12T03:00:00.000Z', failedAt: '2026-11-25T00:00:00.000Z', succeededAt: null,
        }),
        refundRow({
          refundId: 'refund-error', status: 'error', amount: 24680, stripeStatus: null,
          createdAt: '2026-10-12T03:30:00.000Z', erroredAt: '2026-10-12T04:00:00.000Z', succeededAt: null,
        }),
      ],
    });

    const { status, body } = await getDetail();

    expect(status).toBe(200);
    expect(body.status).toBe('paid');
    expect(body.progress.key).toBe('ready');
    expect(body.refunds).toEqual([]);
    expect(body.refundTotal).toBeNull();
    expect(body.items[0].refundedQuantity).toBe(0);
    const json = JSON.stringify(body);
    expect(json).not.toContain('13,579');
    expect(json).not.toContain('24,680');
    expect(json).not.toContain('refund-failed');
    expect(json).not.toContain('refund-error');
    expect(json).not.toContain('11月24日');
  });

  it('エラー・失敗が混ざっていても、出している返金（手続き中・完了）だけで合計を出す（T14-3）', async () => {
    setup({
      refunds: [
        refundRow({ refundId: 'r4', status: 'failed', amount: 9999, createdAt: '2026-10-16T00:00:00.000Z' }),
        refundRow({ refundId: 'r3', status: 'succeeded', amount: 3000, createdAt: '2026-10-15T00:00:00.000Z' }),
        refundRow({ refundId: 'r2', status: 'error', amount: 8888, createdAt: '2026-10-14T00:00:00.000Z' }),
        refundRow({ refundId: 'r1', status: 'pending', amount: 2000, createdAt: '2026-10-13T00:00:00.000Z' }),
      ],
    });

    const { body } = await getDetail();

    expect(body.refunds.map((refund: Json) => refund.id)).toEqual(['r1', 'r3']);
    expect(body.refundTotal).toMatch(/^[¥￥]5,000$/);
  });

  it('「ご返金の合計」は、出す返金が2件以上の時だけ返す（T14-3）', async () => {
    setup({ refunds: [refundRow({ amount: 3000 })] });
    expect((await getDetail()).body.refundTotal).toBeNull();

    setup({
      refunds: [
        refundRow({ refundId: 'refund-2', amount: 2000, createdAt: '2026-10-13T00:00:00.000Z' }),
        refundRow({ refundId: 'refund-1', amount: 3000 }),
      ],
    });
    expect((await getDetail()).body.refundTotal).toMatch(/^[¥￥]5,000$/);
  });

  it('コンビニ払いで保留の返金だけ、返金先の口座の入力の期限を日本時間の「M月D日」で返す（T14-7）', async () => {
    setup({
      refunds: [
        // 日本時間の 11/25 0:00。必ず間に合う最後の日は 11/24。保留・コンビニ払い・期限あり → 出す
        refundRow({
          refundId: 'r1', status: 'pending', paymentMethodType: 'konbini',
          customerActionExpiresAt: '2026-11-24T15:00:00.000Z', createdAt: '2026-10-10T00:00:00.000Z',
        }),
        // 期限が無い → 出さない
        refundRow({
          refundId: 'r2', status: 'pending', paymentMethodType: 'konbini',
          customerActionExpiresAt: null, createdAt: '2026-10-11T00:00:00.000Z',
        }),
        // コンビニ払いでも成功なら、口座の入力は済んでいるので出さない
        refundRow({
          refundId: 'r3', status: 'succeeded', paymentMethodType: 'konbini',
          customerActionExpiresAt: '2026-11-24T15:00:00.000Z', createdAt: '2026-10-12T00:00:00.000Z',
        }),
        // カードの保留は、期限を持っていても出さない
        refundRow({
          refundId: 'r4', status: 'pending', paymentMethodType: 'card',
          customerActionExpiresAt: '2026-11-24T15:00:00.000Z', createdAt: '2026-10-13T00:00:00.000Z',
        }),
        // 返事待ち（Stripe の答えがまだ無い）も出さない
        refundRow({
          refundId: 'r5', status: 'awaiting_response', paymentMethodType: null,
          customerActionExpiresAt: null, createdAt: '2026-10-14T00:00:00.000Z',
        }),
      ],
    });

    const { body } = await getDetail();

    expect(body.refunds.map((refund: Json) => [refund.id, refund.customerActionDeadline])).toEqual([
      ['r1', '11月24日'],
      ['r2', null],
      ['r3', null],
      ['r4', null],
      ['r5', null],
    ]);
  });

  it('コンビニ払いの期限が日本時間の 23:59:59 なら、その日を口座の入力が必ず間に合う最後の日として返す（Ruling E2）', async () => {
    setup({
      refunds: [refundRow({
        status: 'pending', paymentMethodType: 'konbini', customerActionExpiresAt: '2026-11-25T14:59:59.000Z',
      })],
    });

    const { body } = await getDetail();

    expect(body.refunds[0].customerActionDeadline).toBe('11月25日');
  });

  it('商品ごとの返金した数は、発送前に返金した数と発送後に返金した数の合計（T14-4）', async () => {
    setup({
      order: orderRow({ order_items: [{ ...STOCK_ITEM, quantity: 3 }, MADE_ITEM] }),
      lines: [
        // 3点のうち、1点を発送後に、1点を発送前に返金した（発送 1・未発送 1）
        stockLine({
          quantity: 3, shipped: 1, completed: 3, refundedBeforeShipment: 1, refundedAfterShipment: 1,
          readyUnshipped: 1, unshipped: 1,
        }),
        madeLine(),
      ],
    });

    const { body } = await getDetail();

    expect(body.items).toEqual([
      expect.objectContaining({ id: 'line-stock', refundedQuantity: 2 }),
      expect.objectContaining({ id: 'line-made', refundedQuantity: 0 }),
    ]);
  });

  it('返金の行には名指しした5項目だけを入れ、操作した人のメール・メモ・照会番号・Stripe に伝えた理由は渡さない（T14-6）', async () => {
    setup({ refunds: [refundRow()] });

    const { body } = await getDetail();

    expect(Object.keys(body.refunds[0]).sort()).toEqual(['amount', 'customerActionDeadline', 'date', 'id', 'status']);
    const json = JSON.stringify(body);
    expect(json).not.toContain('admin@example.com');
    expect(json).not.toContain('社内メモ');
    expect(json).not.toContain('ARN-123456');
    expect(json).not.toContain('requested_by_customer');
  });

  it.each(['awaiting_response', 'pending'] as const)(
    '全部の商品を発送前に返金して、%s の返金がある支払い済みの注文は「キャンセルの手続き中」で、段を出さない',
    async (refundStatus) => {
      setup({
        order: orderRow({ order_items: [STOCK_ITEM] }),
        // 注文の数 2 を全部、発送前に返金した（未発送 0・発送 0）
        lines: [stockLine({ refundedBeforeShipment: 2, readyUnshipped: 0, unshipped: 0 })],
        refunds: [refundRow({ status: refundStatus, amount: 24000 })],
      });

      const { body } = await getDetail();

      expect(body.status).toBe('paid');
      expect(body.progress).toEqual({
        key: 'cancel_pending',
        label: 'キャンセルの手続き中',
        partiallyShipped: false,
        steps: null,
      });
      expect(body.items[0]).toMatchObject({ refundedQuantity: 2, readyQuantity: 0, inProductionQuantity: 0 });
      expect(body.refunds).toHaveLength(1);
    },
  );

  it.each(['failed', 'error'] as const)(
    '失敗・エラー（%s）の返金だけが残る注文は、手続き中の返金が無いので「キャンセルの手続き中」にしない',
    async (refundStatus) => {
      // DB の数は失敗した返金を数えないので、この組み合わせは実際には起きない。
      // 窓口が「手続き中の返金がある」を返金の状態（返事待ち・保留だけ）で決めることを確かめる
      setup({
        order: orderRow({ order_items: [STOCK_ITEM] }),
        lines: [stockLine({ refundedBeforeShipment: 2, readyUnshipped: 0, unshipped: 0 })],
        refunds: [refundRow({ status: refundStatus })],
      });

      const { body } = await getDetail();

      expect(body.progress.key).not.toBe('cancel_pending');
      expect(body.refunds).toEqual([]);
    },
  );

  it('一部の商品だけを返金して、まだ送る商品が残る注文は、手続き中の返金があっても「キャンセルの手続き中」にしない', async () => {
    setup({
      order: orderRow({ order_items: [STOCK_ITEM] }),
      lines: [stockLine({ refundedBeforeShipment: 1, readyUnshipped: 1, unshipped: 1 })],
      refunds: [refundRow({ status: 'pending', amount: 12000 })],
    });

    const { body } = await getDetail();

    expect(body.progress).toMatchObject({ key: 'ready', label: '発送準備中' });
    expect(body.progress.steps).not.toBeNull();
    expect(body.items[0]).toMatchObject({ refundedQuantity: 1, readyQuantity: 1 });
    expect(body.refunds).toHaveLength(1);
  });

  it('全額を返金してキャンセルになった注文は、完了した返金を出し、言葉は「キャンセル」のまま', async () => {
    setup({
      order: orderRow({ status: 'cancelled', order_items: [STOCK_ITEM] }),
      lines: [stockLine({ refundedBeforeShipment: 2, readyUnshipped: 0, unshipped: 0 })],
      refunds: [refundRow({ amount: 24000 })],
    });

    const { body } = await getDetail();

    expect(body.progress).toEqual({ key: 'cancelled', label: 'キャンセル', partiallyShipped: false, steps: null });
    expect(body.refunds).toEqual([expect.objectContaining({ id: 'refund-1', status: 'completed' })]);
    expect(body.items[0]).toMatchObject({ refundedQuantity: 2 });
  });

  it('返金の読み取りが失敗したら 500（no-store）で、中身を返さない。ログに名前・code・operation だけを残し、DB の文を出さない（T14-5）', async () => {
    setup();
    mockListRefunds.mockRejectedValue(
      Object.assign(
        new Error('refund store failed: list_order_refunds', { cause: { message: 'DB-MESSAGE 〒1500001 神宮前1-2-3' } }),
        { name: 'RefundStoreError', code: '57014', operation: 'list_order_refunds' },
      ),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getDetail();

    expect(response.status).toBe(500);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Failed to fetch order detail' });
    expect(consoleError).toHaveBeenCalledWith('Order refund fetch error:', 'RefundStoreError', '57014', 'list_order_refunds');
    expect(loggedText(consoleError)).not.toContain('DB-MESSAGE');
    expect(loggedText(consoleError)).not.toContain('神宮前');
    consoleError.mockRestore();
  });
});

describe('GET /api/orders/[id] の返品・交換の欄 returnSection（グループ E-3 段2）', () => {
  const RETURN_SECTION: CustomerOrderReturns = {
    returns: [
      {
        id: 'e1b2c3d4-1111-4222-8333-444455556666', number: 1, label: 'ORD-A1B2C3D4-R1',
        status: 'requested', customerStatus: 'requested',
        returnMethod: 'customer_ships', returnShippingPayer: 'shop', returnShippingFee: 0, returnAddress: null,
        requestedAt: '2026-10-13T01:00:00.000Z', closedAt: null,
        lines: [
          {
            itemName: 'リネンシャツ', color: '白', size: 'M', quantity: 1,
            requestedResolution: 'refund', requestedExchange: null, resolution: 'refund', exchange: null,
          },
        ],
        refundAmount: null, sentBack: [], declineMessage: null, exchangeShipping: 'none',
      },
    ],
    cancelRequests: [],
    availability: { returns: 'available', endedOn: null, cancel: false },
  };

  it('持ち主の確かめを通った注文だけ、同じ service_role の client とお客様の番号（claims.sub）で読み、答えの returnSection に入れる', async () => {
    setup();
    mockLoadCustomerOrderReturns.mockResolvedValue(RETURN_SECTION);

    const response = await getDetail();

    expect(response.status).toBe(200);
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
    expect(mockLoadCustomerOrderReturns).toHaveBeenCalledTimes(1);
    expect(mockLoadCustomerOrderReturns).toHaveBeenCalledWith(mockServiceClient, { orderId: ORDER_ID, customerId: 'user-1' });
    expect(response.body.returnSection).toEqual(RETURN_SECTION);
  });

  it('他のお客様の注文（持ち主の確かめで見つからない）は 404 で、返品の欄を読まない', async () => {
    setup({ order: null });

    const response = await getDetail();

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Order not found' });
    expect(mockLoadCustomerOrderReturns).not.toHaveBeenCalled();
  });

  it('返品の欄が読めなくても、注文の答えは返し、返品の欄だけ null にする。ログは誤りの名前だけで、DB の文・記号を出さない', async () => {
    setup();
    mockLoadCustomerOrderReturns.mockRejectedValue(
      Object.assign(new Error('DB-MESSAGE 〒1500001 神宮前1-2-3'), { name: 'RefundStoreError', code: '57014' }),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getDetail();

    expect(response.status).toBe(200);
    expect(response.body.returnSection).toBeNull();
    expect(response.body).toMatchObject({ id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid' });
    expect(consoleError).toHaveBeenCalledWith('Order return section fetch error:', 'RefundStoreError');
    expect(loggedText(consoleError)).not.toContain('DB-MESSAGE');
    expect(loggedText(consoleError)).not.toContain('神宮前');
    expect(loggedText(consoleError)).not.toContain('57014');
    consoleError.mockRestore();
  });

  it('DB が注文なし（null）と答えた時も、返品の欄は null で注文は返す', async () => {
    setup();
    mockLoadCustomerOrderReturns.mockResolvedValue(null);

    const response = await getDetail();

    expect(response.status).toBe(200);
    expect(response.body.returnSection).toBeNull();
  });

  it('返品の欄は、ほかの項目に影響しない（返品の欄を除くと、欄が null の時の答えと同じ）', async () => {
    setup({ fulfillments: [fulfillment()], refunds: [refundRow()] });
    const empty = await getDetail();
    mockLoadCustomerOrderReturns.mockResolvedValue(RETURN_SECTION);
    const filled = await getDetail();

    const { returnSection: emptySection, ...emptyRest } = empty.body;
    const { returnSection: filledSection, ...filledRest } = filled.body;
    expect(emptySection).toBeNull();
    expect(filledSection).toEqual(RETURN_SECTION);
    expect(filledRest).toEqual(emptyRest);
    // 比べる相手が空でないこと（発送と返金が答えに入っている）
    expect(filledRest.shipments).toHaveLength(1);
    expect(filledRest.refunds).toHaveLength(1);
  });
});

describe('GET /api/orders/[id] の交換の品の行と返品の返金（グループ E-3）', () => {
  it('商品の行ごとに lineKind（order か exchange）を返す。交換の品の行の金額は DB の値（¥0）のまま返す（T13-3）', async () => {
    setup({
      order: orderRow({ order_items: [STOCK_ITEM, EXCHANGE_ITEM] }),
      lines: [stockLine({ shipped: 2, readyUnshipped: 0, unshipped: 0 }), exchangeLine()],
    });

    const { body } = await getDetail();

    expect(body.items.map((item: Json) => [item.id, item.lineKind])).toEqual([
      ['line-stock', 'order'],
      ['line-exchange', 'exchange'],
    ]);
    expect(body.items[1]).toMatchObject({ itemId: 10, variantId: 102, color: '白', size: 'L', quantity: 1 });
    expect(body.items[1].amount).toMatch(/^[¥￥]0$/);
  });

  it('商品の読み取りに line_kind の列を入れる', async () => {
    setup();

    await getDetail();

    expect(String(mockOwnerQuery.select.mock.calls[0][0])).toMatch(/line_kind/);
  });

  it('発送の商品にも lineKind を付ける（交換の品の発送を「交換の品」と書くため）', async () => {
    setup({
      order: orderRow({ status: 'shipped', order_items: [STOCK_ITEM, EXCHANGE_ITEM] }),
      lines: [
        stockLine({ shipped: 2, readyUnshipped: 0, unshipped: 0 }),
        exchangeLine({ shipped: 1, readyUnshipped: 0, unshipped: 0 }),
      ],
      fulfillments: [
        fulfillment({
          fulfillmentId: 'ful-2', number: 2, shippedAt: '2026-10-20T00:00:00.000Z',
          lines: [{ orderItemId: 'line-exchange', quantity: 1 }],
        }),
        fulfillment(),
      ],
    });

    const { body } = await getDetail();

    expect(body.shipments.map((shipment: Json) => shipment.items)).toEqual([
      [{ orderItemId: 'line-stock', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2, lineKind: 'order' }],
      [{ orderItemId: 'line-exchange', name: 'リネンシャツ', color: '白', size: 'L', quantity: 1, lineKind: 'exchange' }],
    ]);
  });

  it('交換の品を足して支払い済みに戻った注文は、交換の品を発送準備中に数え、「一部発送済み」を付ける（今の数え方のまま）', async () => {
    setup({
      order: orderRow({ order_items: [STOCK_ITEM, EXCHANGE_ITEM] }),
      // 元の品2点は発送済み。交換の品1点は在庫から、発送準備中
      lines: [stockLine({ shipped: 2, readyUnshipped: 0, unshipped: 0 }), exchangeLine()],
      fulfillments: [fulfillment()],
    });

    const { body } = await getDetail();

    expect(body.status).toBe('paid');
    expect(body.progress).toMatchObject({ key: 'ready', label: '発送準備中', partiallyShipped: true });
    expect(body.items.map((item: Json) => [item.id, item.shippedQuantity, item.readyQuantity])).toEqual([
      ['line-stock', 2, 0],
      ['line-exchange', 0, 1],
    ]);
  });

  it('返品の返金（source が return）も、ほかの返金と同じく「ご返金」に出す（仕様書 8-2）', async () => {
    setup({ refunds: [refundRow({ refundId: 'refund-return', source: 'return', amount: 9000 })] });

    const { body } = await getDetail();

    expect(body.refunds).toEqual([
      {
        id: 'refund-return', date: '2026/10/12', amount: expect.stringMatching(/^[¥￥]9,000$/),
        status: 'completed', customerActionDeadline: null,
      },
    ]);
  });
});
