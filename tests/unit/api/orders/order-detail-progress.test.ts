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

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/orders/[id]/route';

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
  color: '白', size: 'M', quantity: 2, line_total: 24000,
};
const MADE_ITEM = {
  id: 'line-made', item_id: 11, variant_id: 111, item_name: 'ウールコート', item_image_url: null,
  color: '黒', size: 'L', quantity: 1, line_total: 58000,
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
    shipped: 0, completed: 2, inProduction: 0, readyUnshipped: 2, unshipped: 2, ...overrides,
  };
}

// 受注生産の品1点が作っている途中
function madeLine(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID, orderItemId: 'line-made', variantId: 111, fulfillmentType: 'backorder', quantity: 1,
    shipped: 0, completed: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1, ...overrides,
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

function setup(options: { order?: unknown; lines?: unknown[]; fulfillments?: unknown[] } = {}) {
  const { order = orderRow(), lines = [stockLine(), madeLine()], fulfillments = [] } = options;
  mockOwnerQuery.maybeSingle.mockResolvedValue({ data: order, error: null });
  mockListLines.mockResolvedValue(new Map([[ORDER_ID, lines]]));
  mockListFulfillments.mockResolvedValue(fulfillments);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnerQuery.select.mockReturnValue(mockOwnerQuery);
  mockOwnerQuery.eq.mockReturnValue(mockOwnerQuery);
  mockOwnerQuery.not.mockReturnValue(mockOwnerQuery);
  mockCreateServiceRoleClient.mockResolvedValue(mockServiceClient);
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
      items: [{ orderItemId: 'line-stock', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2 }],
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
