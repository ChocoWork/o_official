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
    shipped: 0, completed: 1, inProduction: 0, readyUnshipped: 1, unshipped: 1, ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrdersQuery.select.mockReturnValue(mockOrdersQuery);
  mockOrdersQuery.eq.mockReturnValue(mockOrdersQuery);
  mockOrdersQuery.not.mockReturnValue(mockOrdersQuery);
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
