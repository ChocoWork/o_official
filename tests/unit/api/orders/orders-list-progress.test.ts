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

// お客様の権限の client が読む注文の一覧
const mockOrdersQuery = {
  select: jest.fn(),
  eq: jest.fn(),
  not: jest.fn(),
  order: jest.fn(),
};
const mockServiceClient = { from: jest.fn() };
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ from: () => mockOrdersQuery })),
  createServiceRoleClient: jest.fn(async () => mockServiceClient),
}));

const mockListLines = jest.fn();
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({
  listOrderLineFulfillment: (...args: unknown[]) => mockListLines(...args),
}));

const mockListRefundSummaries = jest.fn();
jest.mock('@/lib/orders/refund/refund-store', () => ({
  listOrderRefundSummaries: (...args: unknown[]) => mockListRefundSummaries(...args),
}));

// 配送の集計（グループ E-4）。実物の読み出し（DB の関数）は使わず、答えを差し替える
jest.mock('server-only', () => ({}), { virtual: true });
const mockListDeliverySummaries = jest.fn();
jest.mock('@/lib/orders/tracking/delivery-store', () => ({
  listOrderDeliverySummaries: (...args: unknown[]) => mockListDeliverySummaries(...args),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/orders/route';

type Json = Record<string, any>;
type RouteResponse = { status: number; body: Json; headers: Record<string, string> };

async function getList(): Promise<RouteResponse> {
  return (await GET(new NextRequest('http://localhost/api/orders'))) as unknown as RouteResponse;
}

// console.error に渡された物を1つの文字にする。Error はそのまま渡されると DB の文（message・cause）が出るので、開いて確かめる
function loggedText(spy: jest.SpyInstance): string {
  return spy.mock.calls
    .flat()
    .map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message} ${JSON.stringify(arg.cause)}` : String(arg)))
    .join(' ');
}

function orderRow(id: string, status: string) {
  return {
    id, created_at: '2026-10-01T00:00:00.000Z', status, total_amount: 12000, currency: 'jpy',
    shipping_full_name: '山田 花子', shipping_email: 'hanako@example.com', shipping_phone: '090-1111-2222',
    shipping_postal_code: '1500001', shipping_prefecture: '東京都', shipping_city: '渋谷区',
    shipping_address: '神宮前1-2-3', shipping_building: null,
    order_items: [
      { id: `${id}-line`, item_id: 10, item_name: 'リネンシャツ', item_image_url: null, color: '白', size: 'M', quantity: 1, line_total: 12000 },
    ],
  };
}

// 在庫の品1点が発送準備中
function line(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    orderId, orderItemId: `${orderId}-line`, variantId: 101, fulfillmentType: 'stock', quantity: 1,
    shipped: 0, completed: 1, refundedBeforeShipment: 0, refundedAfterShipment: 0, inProduction: 0, readyUnshipped: 1, unshipped: 1,
    ...overrides,
  };
}

// listOrderRefundSummaries の1行
function refundSummary(orderId: string, hasOpenRefund: boolean) {
  return {
    orderId, paidAmount: 12000, succeededAmount: 0, openAmount: hasOpenRefund ? 12000 : 0,
    refundableAmount: hasOpenRefund ? 0 : 12000, hasOpenRefund, hasUnresolvedRefundFailure: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrdersQuery.select.mockReturnValue(mockOrdersQuery);
  mockOrdersQuery.eq.mockReturnValue(mockOrdersQuery);
  mockOrdersQuery.not.mockReturnValue(mockOrdersQuery);
  mockListRefundSummaries.mockResolvedValue(new Map());
  // 既定は、発送の記録なし（従来の言葉と同じ）
  mockListDeliverySummaries.mockImplementation(async (_store: unknown, orderIds: string[]) =>
    new Map(orderIds.map((id) => [id, { activeCount: 0, deliveredCount: 0, attentionKind: null }])));
});

describe('GET /api/orders の言葉（グループ E-1）', () => {
  it('一覧の言葉は、商品の数から出した注文の言葉にする。数は一覧の全部の注文を1回で読む', async () => {
    mockOrdersQuery.order.mockResolvedValue({
      data: [
        orderRow('order-made', 'paid'),
        orderRow('order-ready', 'paid'),
        orderRow('order-sent', 'shipped'),
        orderRow('order-partial', 'paid'),
        orderRow('order-pending', 'pending'),
        orderRow('order-failed', 'failed'),
        orderRow('order-cancelled', 'cancelled'),
      ],
      error: null,
    });
    mockListLines.mockResolvedValue(
      new Map([
        ['order-made', [line('order-made', { fulfillmentType: 'backorder', completed: 0, inProduction: 1, readyUnshipped: 0 })]],
        ['order-ready', [line('order-ready')]],
        ['order-sent', [line('order-sent', { shipped: 1, readyUnshipped: 0, unshipped: 0 })]],
        // 在庫の品は送り、受注生産の品はまだ作っている
        [
          'order-partial',
          [
            line('order-partial', { shipped: 1, readyUnshipped: 0, unshipped: 0 }),
            line('order-partial', { orderItemId: 'order-partial-line-2', fulfillmentType: 'backorder', completed: 0, inProduction: 1, readyUnshipped: 0 }),
          ],
        ],
        ['order-pending', [line('order-pending')]],
      ]),
    );

    const { status, body } = await getList();

    expect(status).toBe(200);
    expect(mockOrdersQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(body.data.map((order: Json) => order.status)).toEqual([
      '受注生産中',
      '発送準備中',
      '配送中',
      '受注生産中',
      '未決済',
      '決済失敗',
      'キャンセル',
    ]);
    expect(mockListLines).toHaveBeenCalledTimes(1);
    expect(mockListLines).toHaveBeenCalledWith(mockServiceClient, [
      'order-made', 'order-ready', 'order-sent', 'order-partial', 'order-pending', 'order-failed', 'order-cancelled',
    ]);
  });

  it('一覧は言葉だけを返す（一部発送済みの印は注文の画面で出す）', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: [orderRow('order-partial', 'paid')], error: null });
    mockListLines.mockResolvedValue(
      new Map([[
        'order-partial',
        [
          line('order-partial', { shipped: 1, readyUnshipped: 0, unshipped: 0 }),
          line('order-partial', { orderItemId: 'order-partial-line-2', fulfillmentType: 'backorder', completed: 0, inProduction: 1, readyUnshipped: 0 }),
        ],
      ]]),
    );

    const { body } = await getList();

    expect(body.data[0].status).toBe('受注生産中');
    expect(body.data[0]).not.toHaveProperty('partiallyShipped');
  });

  it('数の読み取りが失敗したら 500（no-store）', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: [orderRow('order-1', 'paid')], error: null });
    mockListLines.mockRejectedValue(new Error('rpc failed'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getList();

    expect(response.status).toBe(500);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Failed to fetch orders' });
    // ログには名前だけ残す（code・operation が無ければ null）。DB の文は出さない
    expect(consoleError).toHaveBeenCalledWith('Orders fulfillment fetch error:', 'Error', null, null);
    expect(loggedText(consoleError)).not.toContain('rpc failed');
    consoleError.mockRestore();
  });

  it('数の読み取りの失敗は、ログに名前・code・operation だけを残し、DB の文（宛先など）を出さない', async () => {
    const { FulfillmentStoreError } = jest.requireActual('@/lib/orders/fulfillment/fulfillment-store');
    mockOrdersQuery.order.mockResolvedValue({ data: [orderRow('order-1', 'paid')], error: null });
    mockListLines.mockRejectedValue(
      new FulfillmentStoreError('list_order_line_fulfillment', { code: '57014', message: 'DB-MESSAGE 〒1500001 神宮前1-2-3' }),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getList();

    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      'Orders fulfillment fetch error:',
      'FulfillmentStoreError',
      '57014',
      'list_order_line_fulfillment',
    );
    expect(loggedText(consoleError)).not.toContain('DB-MESSAGE');
    expect(loggedText(consoleError)).not.toContain('神宮前');
    consoleError.mockRestore();
  });

  it('一覧の読み取りが失敗したら 500 で、数を読まない', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: null, error: { message: 'down' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getList();

    expect(response.status).toBe(500);
    expect(mockListLines).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('GET /api/orders の言葉と返金（グループ E-2）', () => {
  it('全部の商品を発送前に返金して手続き中の返金がある注文は、一覧も「キャンセルの手続き中」。返金の有無は一覧の全部の注文を1回で読む', async () => {
    mockOrdersQuery.order.mockResolvedValue({
      data: [orderRow('order-cancel-pending', 'paid'), orderRow('order-ready', 'paid'), orderRow('order-partial', 'paid')],
      error: null,
    });
    mockListLines.mockResolvedValue(
      new Map([
        // 1点の注文を、発送前に全部返金した（未発送 0・発送 0）
        ['order-cancel-pending', [line('order-cancel-pending', { refundedBeforeShipment: 1, readyUnshipped: 0, unshipped: 0 })]],
        ['order-ready', [line('order-ready')]],
        // 2点のうち1点だけ返金した。まだ送る商品が残る
        [
          'order-partial',
          [
            line('order-partial', { refundedBeforeShipment: 1, readyUnshipped: 0, unshipped: 0 }),
            line('order-partial', { orderItemId: 'order-partial-line-2' }),
          ],
        ],
      ]),
    );
    mockListRefundSummaries.mockResolvedValue(
      new Map([
        ['order-cancel-pending', refundSummary('order-cancel-pending', true)],
        ['order-ready', refundSummary('order-ready', false)],
        ['order-partial', refundSummary('order-partial', true)],
      ]),
    );

    const { status, body } = await getList();

    expect(status).toBe(200);
    expect(body.data.map((order: Json) => order.status)).toEqual(['キャンセルの手続き中', '発送準備中', '発送準備中']);
    expect(mockListRefundSummaries).toHaveBeenCalledTimes(1);
    expect(mockListRefundSummaries).toHaveBeenCalledWith(mockServiceClient, [
      'order-cancel-pending', 'order-ready', 'order-partial',
    ]);
  });

  it('返金の有無の読み取りが失敗したら 500（no-store）で、ログに名前・code・operation だけを残し、DB の文を出さない', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: [orderRow('order-1', 'paid')], error: null });
    mockListLines.mockResolvedValue(new Map([['order-1', [line('order-1')]]]));
    mockListRefundSummaries.mockRejectedValue(
      Object.assign(
        new Error('refund store failed: list_order_refund_summaries', { cause: { message: 'DB-MESSAGE 〒1500001 神宮前1-2-3' } }),
        { name: 'RefundStoreError', code: '57014', operation: 'list_order_refund_summaries' },
      ),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getList();

    expect(response.status).toBe(500);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Failed to fetch orders' });
    expect(consoleError).toHaveBeenCalledWith(
      'Orders refund fetch error:',
      'RefundStoreError',
      '57014',
      'list_order_refund_summaries',
    );
    expect(loggedText(consoleError)).not.toContain('DB-MESSAGE');
    expect(loggedText(consoleError)).not.toContain('神宮前');
    consoleError.mockRestore();
  });
});

describe('GET /api/orders の言葉と配達済み（グループ E-4 設計書 7-2）', () => {
  const sentLine = (orderId: string) => line(orderId, { shipped: 1, readyUnshipped: 0, unshipped: 0 });
  const summary = (activeCount: number, deliveredCount: number) => ({ activeCount, deliveredCount, attentionKind: null });

  it('取り消していない発送が全部配達済みの注文は「配達済み」。一部だけ・発送0件は「配送中」。配送の集計は一覧の全部の注文を1回で読む', async () => {
    mockOrdersQuery.order.mockResolvedValue({
      data: [orderRow('order-delivered', 'shipped'), orderRow('order-partial', 'shipped'), orderRow('order-empty', 'shipped'), orderRow('order-pending', 'pending')],
      error: null,
    });
    mockListLines.mockResolvedValue(
      new Map([
        ['order-delivered', [sentLine('order-delivered')]],
        ['order-partial', [sentLine('order-partial')]],
        ['order-empty', [sentLine('order-empty')]],
        ['order-pending', [line('order-pending')]],
      ]),
    );
    mockListDeliverySummaries.mockResolvedValue(
      new Map([
        ['order-delivered', summary(2, 2)],
        ['order-partial', summary(2, 1)],
        ['order-empty', summary(0, 0)],
        ['order-pending', summary(1, 1)],
      ]),
    );

    const { status, body } = await getList();

    expect(status).toBe(200);
    expect(body.data.map((order: Json) => order.status)).toEqual(['配達済み', '配送中', '配送中', '未決済']);
    expect(mockListDeliverySummaries).toHaveBeenCalledTimes(1);
    expect(mockListDeliverySummaries).toHaveBeenCalledWith(mockServiceClient, [
      'order-delivered', 'order-partial', 'order-empty', 'order-pending',
    ]);
  });

  it('発送準備中の品が残る注文は、配達済みの発送があっても「発送準備中」のまま', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: [orderRow('order-mixed', 'paid')], error: null });
    mockListLines.mockResolvedValue(
      new Map([['order-mixed', [sentLine('order-mixed'), line('order-mixed', { orderItemId: 'order-mixed-line-2' })]]]),
    );
    mockListDeliverySummaries.mockResolvedValue(new Map([['order-mixed', summary(1, 1)]]));

    const { body } = await getList();

    expect(body.data[0].status).toBe('発送準備中');
  });

  it('配送の集計の読み取りが失敗したら 500（no-store）で、中身を返さない。ログは名前・code・operation だけ', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: [orderRow('order-1', 'shipped')], error: null });
    mockListLines.mockResolvedValue(new Map([['order-1', [sentLine('order-1')]]]));
    mockListDeliverySummaries.mockRejectedValue(
      Object.assign(
        new Error('delivery store failed: list_order_delivery_summaries', { cause: { message: 'DB-MESSAGE 〒1500001 神宮前1-2-3' } }),
        { name: 'DeliveryStoreError', code: '57014', operation: 'list_order_delivery_summaries' },
      ),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await getList();

    expect(response.status).toBe(500);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body).toEqual({ error: 'Failed to fetch orders' });
    expect(consoleError).toHaveBeenCalledWith(
      'Orders delivery fetch error:',
      'DeliveryStoreError',
      '57014',
      'list_order_delivery_summaries',
    );
    expect(loggedText(consoleError)).not.toContain('DB-MESSAGE');
    expect(loggedText(consoleError)).not.toContain('神宮前');
    consoleError.mockRestore();
  });

  it('一覧の読み取りが失敗したら、配送の集計を読まない', async () => {
    mockOrdersQuery.order.mockResolvedValue({ data: null, error: { message: 'down' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await getList();

    expect(mockListDeliverySummaries).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
