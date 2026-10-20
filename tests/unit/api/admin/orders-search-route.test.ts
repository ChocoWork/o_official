import { inspect } from 'node:util';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import type { OrderReturnSummary } from '@/lib/orders/returns/return-types';

export {};

const authorizeMock = jest.fn();
const createClientMock = jest.fn();
const getStripeMock = jest.fn();
let queryResult: { data: unknown[]; count: number; error: unknown } = { data: [], count: 0, error: null };
let shipBlockedRows: Array<{ order_id: string }> = [];
// public.list_order_line_fulfillment が返す行（service_role の RPC）。支払い済み・発送済みの注文の商品ごとの数
let lineFulfillmentRows: Array<Record<string, unknown>> = [];
const rpcMock = jest.fn();
// public.list_order_refund_summaries が返す行を、注文の番号ごとに上書きする（service_role の RPC）。
// 書かなかった注文は、受け取った額が無い要約になる
let refundSummaryOverrides: Record<string, Record<string, unknown>> = {};
// 商品ごとの数（list_order_line_fulfillment）の読み込みだけを失敗させる時の DB の誤り。null なら成功
let lineFulfillmentError: unknown = null;
// public.list_order_ids_by_return_status が返す行（service_role の RPC）。返品の絞り込み（return=）に当たる注文の番号
let returnFilterRows: Array<{ order_id: string }> = [];
// その RPC だけを失敗させる時の DB の誤り。null なら成功
let returnFilterError: unknown = null;
// 返品の要約（Task 4 の return-store の listOrderReturnSummaries を差し替えた物）を、注文の番号ごとに上書きする。
// 書かなかった注文は、返品の無い要約になる
let returnSummaryOverrides: Record<string, Partial<OrderReturnSummary>> = {};
const listOrderReturnSummariesMock = jest.fn();
const countReturnAttentionMock = jest.fn();
// キャンセルの申し込みの印・一行の数・絞り込みの読み出し（Task 8 の cancel-request-reads）を、窓口の形で差し替える
const listOrderIdsWithOpenCancelRequestMock = jest.fn();
const findOrderIdsWithOpenCancelRequestMock = jest.fn();
const countOrdersWithOpenCancelRequestMock = jest.fn();

function returnSummaryOf(orderId: string, overrides: Partial<OrderReturnSummary> = {}): OrderReturnSummary {
  return {
    orderId, displayStatus: null, marks: [], nextAction: 'none', hasReturnable: false, refundWaitingReturns: 0, requestedReturns: 0,
    ...overrides,
  };
}

function refundSummaryRow(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    order_id: orderId, paid_amount: null, succeeded_amount: 0, open_amount: 0, refundable_amount: 0,
    has_open_refund: false, has_unresolved_refund_failure: false,
    ...overrides,
  };
}

/** 名前を指定した RPC を呼んだ引数を、呼んだ順に返す */
function rpcCallsOf(name: string): unknown[] {
  return rpcMock.mock.calls.filter(([calledName]) => calledName === name).map(([, args]) => args);
}

function lineRow(overrides: Record<string, unknown>) {
  return {
    order_id: 'order-1', order_item_id: 'item-1', variant_id: 1, fulfillment_type: 'stock', quantity: 1,
    shipped: 0, completed: 1, refunded_before_shipment: 0, refunded_after_shipment: 0, in_production: 0, ready_unshipped: 1, unshipped: 1,
    ...overrides,
  };
}

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => authorizeMock(...args),
}));

const createServiceRoleClientMock = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
  createServiceRoleClient: (...args: unknown[]) => createServiceRoleClientMock(...args),
}));

jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: (...args: unknown[]) => getStripeMock(...args),
}));

jest.mock('@/lib/orders/returns/cancel-request-reads', () => ({
  listOrderIdsWithOpenCancelRequest: (...args: unknown[]) => listOrderIdsWithOpenCancelRequestMock(...args),
  findOrderIdsWithOpenCancelRequest: (...args: unknown[]) => findOrderIdsWithOpenCancelRequestMock(...args),
  countOrdersWithOpenCancelRequest: (...args: unknown[]) => countOrdersWithOpenCancelRequestMock(...args),
}));

// 返品の要約と一行の数（Task 4 の return-store）は、窓口の形で差し替える
jest.mock('@/lib/orders/returns/return-store', () => ({
  listOrderReturnSummaries: (...args: unknown[]) => listOrderReturnSummariesMock(...args),
  countReturnAttention: (...args: unknown[]) => countReturnAttentionMock(...args),
}));

describe('GET /api/admin/orders statutory search', () => {
  const query = {
    select: jest.fn(),
    order: jest.fn(),
    range: jest.fn(),
    gte: jest.fn(),
    lte: jest.fn(),
    eq: jest.fn(),
    neq: jest.fn(),
    not: jest.fn(),
    is: jest.fn(),
    or: jest.fn(),
    in: jest.fn(),
    then: (resolve: (value: unknown) => void) => resolve(queryResult),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const method of ['select', 'order', 'range', 'gte', 'lte', 'eq', 'neq', 'not', 'is', 'or', 'in'] as const) {
      query[method].mockReturnValue(query);
    }
    queryResult = { data: [], count: 0, error: null };
    authorizeMock.mockResolvedValue({ ok: true });
    createClientMock.mockResolvedValue({ from: jest.fn().mockReturnValue(query) });
    shipBlockedRows = [];
    lineFulfillmentRows = [];
    lineFulfillmentError = null;
    refundSummaryOverrides = {};
    returnFilterRows = [];
    returnFilterError = null;
    returnSummaryOverrides = {};
    listOrderReturnSummariesMock.mockReset();
    listOrderReturnSummariesMock.mockImplementation(async (_store: unknown, orderIds: string[]) =>
      new Map(orderIds.map((orderId): [string, OrderReturnSummary] => [orderId, returnSummaryOf(orderId, returnSummaryOverrides[orderId])])));
    countReturnAttentionMock.mockReset();
    countReturnAttentionMock.mockResolvedValue({ requested: 0, refundWaiting: 0 });
    listOrderIdsWithOpenCancelRequestMock.mockReset();
    listOrderIdsWithOpenCancelRequestMock.mockResolvedValue([]);
    findOrderIdsWithOpenCancelRequestMock.mockReset();
    findOrderIdsWithOpenCancelRequestMock.mockResolvedValue(new Set());
    countOrdersWithOpenCancelRequestMock.mockReset();
    countOrdersWithOpenCancelRequestMock.mockResolvedValue(0);
    rpcMock.mockReset();
    rpcMock.mockImplementation(async (name: string, args: { _order_ids?: string[] }) => {
      if (name === 'list_order_refund_summaries') {
        return {
          data: (args._order_ids ?? []).map((orderId) => refundSummaryRow(orderId, refundSummaryOverrides[orderId])),
          error: null,
        };
      }
      if (name === 'list_order_ids_by_return_status') {
        return returnFilterError ? { data: null, error: returnFilterError } : { data: returnFilterRows, error: null };
      }
      return lineFulfillmentError
        ? { data: null, error: lineFulfillmentError }
        : { data: lineFulfillmentRows, error: null };
    });
    createServiceRoleClientMock.mockResolvedValue({
      from: jest.fn().mockReturnValue({
        select: () => ({
          in: () => ({
            eq: () => ({
              is: async () => ({ data: shipBlockedRows, error: null }),
            }),
          }),
        }),
      }),
      rpc: (...args: unknown[]) => rpcMock(...args),
    });
  });

  it.each(['amountMin=-1', 'amountMax=1.5', 'status=unknown'])(
    'rejects invalid statutory search %s',
    async (parameters) => {
      const { GET } = await import('@/app/api/admin/orders/route');
      const response = await GET(
        new Request(`http://localhost/api/admin/orders?${parameters}`),
      );

      expect(response.status).toBe(400);
    },
  );

  it('applies date, amount, counterparty, reference and status filters', async () => {
    const { GET } = await import('@/app/api/admin/orders/route');
    const response = await GET(
      new Request(
        'http://localhost/api/admin/orders?from=2026-01-01&to=2026-12-31&amountMin=1000&amountMax=50000&counterparty=buyer%40example.com&reference=pi_123&status=paid',
      ),
    );

    expect(response.status).toBe(200);
    expect(query.gte).toHaveBeenCalledWith('total_amount', 1000);
    expect(query.lte).toHaveBeenCalledWith('total_amount', 50000);
    expect(query.eq).toHaveBeenCalledWith('status', 'paid');
    expect(query.or).toHaveBeenCalledWith(
      expect.stringContaining('shipping_email.ilike.%buyer@example.com%'),
    );
    expect(query.or).toHaveBeenCalledWith(
      expect.stringContaining('payment_intent_id.ilike.%pi\\_123%'),
    );
  });

  it('rejects reversed ranges', async () => {
    const { GET } = await import('@/app/api/admin/orders/route');
    const response = await GET(
      new Request(
        'http://localhost/api/admin/orders?from=2026-12-31&to=2026-01-01&amountMin=20&amountMax=10',
      ),
    );

    expect(response.status).toBe(400);
  });

  // 返金のボタンは、受け取った額と返金の記録（list_order_refund_summaries）で決める。Stripe の支払いは読まない（本計画 P13）。
  // 片方は Stripe を読めず、片方は支払いが成功になっていない。どちらでも返金の可否は変わらない
  it('支払い済みと発送済みの注文は、Stripe の支払いを読めなくても、返せる額が残っていれば返金できる', async () => {
    queryResult = {
      data: [
        {
          id: 'paid-order',
          payment_intent_id: 'pi_refundable_paid',
          status: 'paid',
          total_amount: 10_000,
          refunded_amount: 0,
          currency: 'jpy',
          shipping_full_name: 'Paid Customer',
          shipping_email: 'paid@example.com',
          created_at: '2026-09-22T00:00:00.000Z',
          shipped_at: null,
          shipping_carrier: null,
          tracking_number: null,
          order_items: [],
        },
        {
          id: 'shipped-order',
          payment_intent_id: 'pi_refundable_shipped',
          status: 'shipped',
          total_amount: 10_000,
          refunded_amount: 0,
          currency: 'jpy',
          shipping_full_name: 'Shipped Customer',
          shipping_email: 'shipped@example.com',
          created_at: '2026-09-22T00:00:00.000Z',
          shipped_at: '2026-09-22T01:00:00.000Z',
          shipping_carrier: 'yamato',
          tracking_number: '1234',
          order_items: [],
        },
      ],
      count: 2,
      error: null,
    };
    refundSummaryOverrides = {
      'paid-order': { paid_amount: 10_000, refundable_amount: 10_000 },
      'shipped-order': { paid_amount: 10_000, refundable_amount: 10_000 },
    };
    getStripeMock.mockReturnValue({
      paymentIntents: {
        retrieve: jest.fn().mockImplementation((id: string) =>
          id === 'pi_refundable_paid'
            ? Promise.reject(new Error('stripe unavailable'))
            : Promise.resolve({ id, status: 'requires_payment_method', payment_method_types: ['card'] })),
      },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const { GET } = await import('@/app/api/admin/orders/route');
      const response = await GET(new Request('http://localhost/api/admin/orders'));
      const body = await response.json() as { data: Array<{ id: string; canRefund: boolean }> };

      expect(response.status).toBe(200);
      // 支払い方法の言葉と Stripe の状態は、今のまま Stripe の支払いから出る（読めなかった側は「不明」と null）
      expect(body.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'paid-order', canRefund: true, paymentMethod: '不明', stripePaymentStatus: null }),
        expect.objectContaining({
          id: 'shipped-order', canRefund: true, paymentMethod: 'カード', stripePaymentStatus: 'requires_payment_method',
        }),
      ]));
    } finally {
      warn.mockRestore();
    }
  });


  it('決済済みでも配送先の必須項目が欠けていれば出荷不可として返す', async () => {
    queryResult = {
      data: [{
        id: 'paid-missing-address',
        payment_intent_id: 'pi_missing_address',
        status: 'paid',
        total_amount: 10000,
        currency: 'jpy',
        shipping_email: 'buyer@example.com',
        shipping_full_name: '山田太郎',
        shipping_postal_code: '1000001',
        shipping_prefecture: '東京都',
        shipping_city: '千代田区',
        shipping_address: ' ',
        shipping_phone: '0312345678',
        created_at: '2026-09-22T00:00:00.000Z',
        shipped_at: null,
        shipping_carrier: null,
        tracking_number: null,
        order_items: [],
      }],
      count: 1,
      error: null,
    };
    getStripeMock.mockReturnValue({
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          status: 'succeeded',
          payment_method_types: ['card'],
        }),
      },
    });

    const { GET } = await import('@/app/api/admin/orders/route');
    const response = await GET(new Request('http://localhost/api/admin/orders'));
    const body = await response.json() as {
      data: Array<{ canShip: boolean; missingShippingFields: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(body.data[0].canShip).toBe(false);
    expect(body.data[0].missingShippingFields).toEqual(['address']);
  });

  it('状態の絞り込みに支払い手続き中と放棄を足し、既定の一覧では放棄を除く', async () => {
    const { GET } = await import('@/app/api/admin/orders/route');

    expect((await GET(new Request('http://localhost/api/admin/orders?status=payment_in_progress'))).status).toBe(200);
    expect(query.eq).toHaveBeenCalledWith('status', 'payment_in_progress');
    expect(query.neq).not.toHaveBeenCalled();

    query.eq.mockClear();
    await GET(new Request('http://localhost/api/admin/orders'));
    expect(query.neq).toHaveBeenCalledWith('status', 'abandoned');
  });

  it('要確認のみの絞り込みは、確認済みでない要確認の注文だけにする', async () => {
    const { GET } = await import('@/app/api/admin/orders/route');

    await GET(new Request('http://localhost/api/admin/orders?review=only'));

    expect(query.not).toHaveBeenCalledWith('review_reason', 'is', null);
    expect(query.is).toHaveBeenCalledWith('reviewed_at', null);
  });

  it('新しい状態の表示名・要確認の印・発送止め・取消の可否を返し、PaymentIntent が空でも落ちない', async () => {
    const future = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    queryResult = {
      data: [
        {
          id: 'order-in-progress',
          payment_intent_id: null,
          checkout_session_id: 'cs_1',
          status: 'payment_in_progress',
          total_amount: 10_000,
          currency: 'jpy',
          review_reason: null,
          reviewed_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
          order_items: [],
        },
        {
          id: 'order-voucher',
          payment_intent_id: 'pi_voucher',
          checkout_session_id: 'cs_2',
          status: 'pending',
          total_amount: 10_000,
          currency: 'jpy',
          review_reason: null,
          reviewed_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
          order_items: [],
        },
        {
          id: 'order-mismatch',
          payment_intent_id: 'pi_mismatch',
          checkout_session_id: 'cs_3',
          status: 'paid',
          total_amount: 10_000,
          currency: 'jpy',
          shipping_email: 'buyer@example.com',
          shipping_full_name: '山田太郎',
          shipping_postal_code: '1000001',
          shipping_prefecture: '東京都',
          shipping_city: '千代田区',
          shipping_address: '丸の内1-1-1',
          shipping_phone: '0312345678',
          review_reason: 'stock_not_reserved',
          reviewed_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
          order_items: [
            { id: 'item-mismatch', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, fulfillment_type: 'stock' },
          ],
        },
      ],
      count: 3,
      error: null,
    };
    shipBlockedRows = [{ order_id: 'order-mismatch' }];
    lineFulfillmentRows = [lineRow({ order_id: 'order-mismatch', order_item_id: 'item-mismatch' })];
    getStripeMock.mockReturnValue({
      paymentIntents: {
        retrieve: jest.fn().mockImplementation((id: string) => Promise.resolve(
          id === 'pi_voucher'
            ? {
                id,
                status: 'requires_action',
                payment_method_types: ['konbini'],
                next_action: { konbini_display_details: { expires_at: future } },
              }
            : { id, status: 'succeeded', payment_method_types: ['card'] },
        )),
      },
    });

    const { GET } = await import('@/app/api/admin/orders/route');
    const response = await GET(new Request('http://localhost/api/admin/orders'));
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    const byId = Object.fromEntries(body.data.map((row) => [row.id, row]));

    expect(byId['order-in-progress']).toMatchObject({
      status: '支払い手続き中', orderStatus: 'payment_in_progress', canCancel: true, cancelBlockedUntil: null,
    });
    expect(byId['order-voucher']).toMatchObject({
      status: '未決済',
      orderStatus: 'pending',
      canCancel: false,
      cancelBlockedUntil: new Date(future * 1000).toISOString(),
    });
    expect(byId['order-mismatch']).toMatchObject({
      status: '発送準備中',
      orderStatus: 'paid',
      needsReview: true,
      canShip: false,
      shipBlockedReason: '支払額の確認が必要です（要対応）',
    });
  });

  // 取消 API は、PaymentIntent が requires_action か processing の間は 409 にする。払込票の期限を過ぎても、
  // Stripe が期限切れを確定するまでは変わらない。一覧はサーバーの時計と比べず、同じ判定を返す（設計書 4-1）
  describe('入金待ち（pending）の取消の可否は取消 API と同じ判定にする', () => {
    function pendingOrder(paymentIntentId: string) {
      return {
        id: `order-${paymentIntentId}`,
        payment_intent_id: paymentIntentId,
        checkout_session_id: `cs_${paymentIntentId}`,
        status: 'pending',
        total_amount: 10_000,
        currency: 'jpy',
        review_reason: null,
        reviewed_at: null,
        created_at: '2026-09-27T00:00:00.000Z',
        order_items: [],
      };
    }

    async function listPendingOrder(paymentIntentId: string, retrieve: jest.Mock) {
      queryResult = { data: [pendingOrder(paymentIntentId)], count: 1, error: null };
      getStripeMock.mockReturnValue({ paymentIntents: { retrieve } });

      const { GET } = await import('@/app/api/admin/orders/route');
      const response = await GET(new Request('http://localhost/api/admin/orders'));
      const body = await response.json() as { data: Array<Record<string, unknown>> };
      return body.data[0];
    }

    it('払込票の期限を過ぎていても、Stripe が期限切れを確定する前（requires_action）は取り消せない', async () => {
      const past = Math.floor(Date.now() / 1000) - 60 * 60;

      const row = await listPendingOrder('pi_voucher_past', jest.fn().mockResolvedValue({
        id: 'pi_voucher_past',
        status: 'requires_action',
        payment_method_types: ['konbini'],
        next_action: { konbini_display_details: { expires_at: past } },
      }));

      expect(row).toMatchObject({ canCancel: false, cancelBlockedUntil: new Date(past * 1000).toISOString() });
    });

    it.each<[string, string, Record<string, unknown>]>([
      ['processing', 'pi_processing', { status: 'processing', payment_method_types: ['konbini'] }],
      ['requires_action（コンビニ以外）', 'pi_paypay_action', { status: 'requires_action', payment_method_types: ['paypay'] }],
    ])('%s の間は取り消せない（Stripe が期限を返さないので cancelBlockedUntil は null）', async (_label, paymentIntentId, paymentIntent) => {
      const row = await listPendingOrder(
        paymentIntentId,
        jest.fn().mockResolvedValue({ id: paymentIntentId, ...paymentIntent }),
      );

      expect(row).toMatchObject({ canCancel: false, cancelBlockedUntil: null });
    });

    it('払込票が期限切れの PaymentIntent（requires_payment_method）は取り消せる', async () => {
      const row = await listPendingOrder('pi_voucher_expired', jest.fn().mockResolvedValue({
        id: 'pi_voucher_expired',
        status: 'requires_payment_method',
        payment_method_types: ['konbini'],
      }));

      expect(row).toMatchObject({ canCancel: true, cancelBlockedUntil: null });
    });

    it('PaymentIntent を読めない入金待ちは、取り消せない側に倒す（取消 API が Stripe の現在値で決める）', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const row = await listPendingOrder('pi_unreadable', jest.fn().mockRejectedValue(new Error('stripe unavailable')));

        expect(row).toMatchObject({ canCancel: false, cancelBlockedUntil: null });
        expect(warn).toHaveBeenCalledWith('[admin.orders] Failed to retrieve payment intent:', expect.any(Error));
      } finally {
        warn.mockRestore();
      }
    });
  });

  // 注文の言葉と発送・仕上がりのボタンは、商品ごとの数（private.order_line_fulfillment を service_role で読んだ物）から出す。
  // 言葉（status）は表示のため。件数・絞り込み・CSV の判断には DB の状態（orderStatus）を使う（本計画 P9・P10）
  describe('商品ごとの数・注文の言葉・発送と仕上がりのボタン', () => {
    function paidOrderRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'order-1',
        payment_intent_id: null,
        checkout_session_id: 'cs_1',
        status: 'paid',
        total_amount: 30_000,
        currency: 'jpy',
        shipping_email: 'buyer@example.com',
        shipping_full_name: '山田太郎',
        shipping_postal_code: '1000001',
        shipping_prefecture: '東京都',
        shipping_city: '千代田区',
        shipping_address: '丸の内1-1-1',
        shipping_phone: '0312345678',
        review_reason: null,
        reviewed_at: null,
        created_at: '2026-10-10T00:00:00.000Z',
        shipped_at: null,
        shipping_carrier: null,
        tracking_number: null,
        order_items: [
          { id: 'item-stock', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock' },
          { id: 'item-coat', item_name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillment_type: 'backorder' },
        ],
        ...overrides,
      };
    }

    async function listOrders(rows: unknown[], url = 'http://localhost/api/admin/orders') {
      queryResult = { data: rows, count: rows.length, error: null };
      const { GET } = await import('@/app/api/admin/orders/route');
      const response = await GET(new Request(url));
      const body = await response.json() as { data: Array<Record<string, any>> };
      return { response, rows: body.data };
    }

    it('商品の番号・色・サイズ・在庫か受注生産か・交換の品の印（line_kind）を、注文の商品と一緒に読む', async () => {
      await listOrders([]);

      const selected = String(query.select.mock.calls[0][0]);
      expect(selected).toMatch(/order_items\s*\(\s*id,\s*item_name,\s*color,\s*size,\s*quantity,\s*fulfillment_type,\s*line_kind\s*\)/);
      expect(query.select.mock.calls[0][1]).toEqual({ count: 'exact' });
    });

    it('一部を送って受注生産の品が残る注文は「受注生産中」＋一部発送済みで、発送も仕上がりの記録もできる', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, shipped: 1, completed: 2, in_production: 0, ready_unshipped: 1, unshipped: 1 }),
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 0, in_production: 1, ready_unshipped: 0, unshipped: 1 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rpcCallsOf('list_order_line_fulfillment')).toEqual([{ _order_ids: ['order-1'] }]);
      expect(rows[0]).toMatchObject({
        status: '受注生産中',
        orderStatus: 'paid',
        progressKey: 'in_production',
        partiallyShipped: true,
        canShip: true,
        canRecordCompletion: true,
        itemCount: '3点',
      });
      expect(rows[0].items).toEqual([
        {
          id: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillmentType: 'stock', lineKind: 'order',
          shipped: 1, inProduction: 0, readyUnshipped: 1,
        },
        {
          id: 'item-coat', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillmentType: 'backorder', lineKind: 'order',
          shipped: 0, inProduction: 1, readyUnshipped: 0,
        },
      ]);
    });

    it('全部の商品が発送準備中なら「発送準備中」で、仕上がりの記録は出さない', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, completed: 2, ready_unshipped: 2, unshipped: 2 }),
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, completed: 1, ready_unshipped: 1, unshipped: 1 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rows[0]).toMatchObject({
        status: '発送準備中', orderStatus: 'paid', progressKey: 'ready', partiallyShipped: false, canShip: true, canRecordCompletion: false,
      });
    });

    it('全部を送った注文は「配送中」（DB の状態は shipped）で、発送も仕上がりの記録もできない', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, shipped: 2, completed: 2, ready_unshipped: 0, unshipped: 0 }),
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, shipped: 1, completed: 1, ready_unshipped: 0, unshipped: 0 }),
      ];

      const { rows } = await listOrders([
        paidOrderRow({ status: 'shipped', shipped_at: '2026-10-10T01:00:00.000Z', shipping_carrier: 'yamato', tracking_number: '1234' }),
      ]);

      expect(rows[0]).toMatchObject({
        status: '配送中', orderStatus: 'shipped', progressKey: 'in_transit', partiallyShipped: false, canShip: false, canRecordCompletion: false,
      });
    });

    it('数を読むのは支払い済みと発送済みの注文だけ。ほかの注文は数を 0 にして、言葉は状態のまま', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-paid', order_item_id: 'item-stock', quantity: 2, completed: 2, ready_unshipped: 2, unshipped: 2 }),
      ];

      const { rows } = await listOrders([
        paidOrderRow({ id: 'order-pending', status: 'pending' }),
        paidOrderRow({ id: 'order-failed', status: 'failed' }),
        paidOrderRow({ id: 'order-cancelled', status: 'cancelled' }),
        paidOrderRow({ id: 'order-paid', order_items: [{ id: 'item-stock', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock' }] }),
      ]);
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

      expect(rpcMock).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: ['order-paid'] });
      expect(byId['order-pending']).toMatchObject({ status: '未決済', orderStatus: 'pending', canShip: false, canRecordCompletion: false, partiallyShipped: false });
      expect(byId['order-failed']).toMatchObject({ status: '決済失敗', orderStatus: 'failed' });
      expect(byId['order-cancelled']).toMatchObject({ status: 'キャンセル', orderStatus: 'cancelled' });
      expect(byId['order-pending'].items.every((item: Record<string, number>) => item.shipped === 0 && item.inProduction === 0 && item.readyUnshipped === 0)).toBe(true);
      expect(byId['order-paid']).toMatchObject({ status: '発送準備中', canShip: true });
    });

    it('支払い済み・発送済みの注文が無い一覧は、数を読みに行かない', async () => {
      const { rows } = await listOrders([paidOrderRow({ status: 'pending' })]);

      expect(rows).toHaveLength(1);
      expect(rpcCallsOf('list_order_line_fulfillment')).toEqual([]);
    });

    it('支払額の確認が残る注文は発送できないが、受注生産中の数があれば仕上がりは記録できる', async () => {
      shipBlockedRows = [{ order_id: 'order-1' }];
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, completed: 0, in_production: 1, ready_unshipped: 0, unshipped: 1 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rows[0]).toMatchObject({
        canShip: false, shipBlockedReason: '支払額の確認が必要です（要対応）', canRecordCompletion: true,
      });
    });

    it('送る品も作る品も残っていない支払い済みの注文には、発送も仕上がりの記録も出さない', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, shipped: 2, completed: 2, ready_unshipped: 0, unshipped: 0 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rows[0]).toMatchObject({ canShip: false, canRecordCompletion: false });
    });

    it('数を読めなかった時は 500 にする（数が無いまま発送できる印を出さない）', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      lineFulfillmentError = { message: 'down', code: '08006' };
      queryResult = { data: [paidOrderRow()], count: 1, error: null };

      try {
        const { GET } = await import('@/app/api/admin/orders/route');
        const response = await GET(new Request('http://localhost/api/admin/orders'));

        expect(response.status).toBe(500);
      } finally {
        consoleError.mockRestore();
      }
    });

    // FulfillmentStoreError は cause に DB の生の誤り（details・hint 込み）を持ち、例外ごとログに渡すと Node は [cause] まで出す。
    // 発送の窓口と同じく、名前と code・operation だけを出す
    it('数を読めなかった時のログには、例外の名前・code・operation だけを出し、DB の文（message・details・hint）は出さない', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      lineFulfillmentError = { message: 'SECRET-MESSAGE', details: 'SECRET-DETAILS', hint: 'SECRET-HINT', code: '08006' };
      queryResult = { data: [paidOrderRow()], count: 1, error: null };

      try {
        const { GET } = await import('@/app/api/admin/orders/route');
        const response = await GET(new Request('http://localhost/api/admin/orders'));

        expect(response.status).toBe(500);
        expect(consoleError).toHaveBeenCalledWith(
          'GET /api/admin/orders error:', 'FulfillmentStoreError', '08006', 'list_order_line_fulfillment',
        );
        // 渡した引数の中身（例外を渡していれば cause の中まで）に、DB の文の目印が無いこと
        expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain('SECRET');
      } finally {
        consoleError.mockRestore();
      }
    });

    // supabase-js は throwOnError を使わない時、誤りを Error ではなく素のオブジェクト（message・code・details・hint）で返す。
    // 通信の失敗も同じ形。Error ではないので、ログの名前は UnknownError になる
    it('注文の読みが失敗した時も、ログには名前（Error でなければ UnknownError）と code だけを出し、DB の文は出さない', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const databaseError = { message: 'SECRET-MESSAGE', details: 'SECRET-DETAILS', hint: 'SECRET-HINT', code: '42703' };
      queryResult = { data: [], count: 0, error: databaseError };

      try {
        const { GET } = await import('@/app/api/admin/orders/route');
        const response = await GET(new Request('http://localhost/api/admin/orders'));

        expect(response.status).toBe(500);
        expect(consoleError).toHaveBeenCalledWith('[admin.orders] Failed to fetch orders:', 'UnknownError', '42703', null);
        expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain('SECRET');
      } finally {
        consoleError.mockRestore();
      }
    });

    it('状態の絞り込みの値は DB の状態のまま。言葉（発送済み・配送中など）は受け付けない', async () => {
      const { GET } = await import('@/app/api/admin/orders/route');

      expect((await GET(new Request('http://localhost/api/admin/orders?status=shipped'))).status).toBe(200);
      expect(query.eq).toHaveBeenCalledWith('status', 'shipped');
      expect((await GET(new Request(`http://localhost/api/admin/orders?status=${encodeURIComponent('発送済み')}`))).status).toBe(400);
      expect((await GET(new Request(`http://localhost/api/admin/orders?status=${encodeURIComponent('配送中')}`))).status).toBe(400);
    });
  });
  // 「支払い」の列・小さな印・返金とキャンセルのボタンは、受け取った額と返金の記録（service_role の list_order_refund_summaries）で決める。
  // 返金のボタンのために Stripe の支払いを読まない（本計画 P13）。未入金の取消の判定と支払い方法の言葉は、今のまま Stripe の支払いを読む。
  // PaymentIntent は route.ts の中で5分覚えているので、Stripe を使う試験は PaymentIntent の番号を試験ごとに変える
  describe('支払いの列・返金の印・返金とキャンセルのボタン', () => {
    function orderRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'order-1',
        payment_intent_id: null,
        checkout_session_id: 'cs_1',
        status: 'paid',
        total_amount: 10_000,
        refunded_amount: 0,
        currency: 'jpy',
        shipping_email: 'buyer@example.com',
        shipping_full_name: '山田太郎',
        shipping_postal_code: '1000001',
        shipping_prefecture: '東京都',
        shipping_city: '千代田区',
        shipping_address: '丸の内1-1-1',
        shipping_phone: '0312345678',
        review_reason: null,
        reviewed_at: null,
        created_at: '2026-10-11T00:00:00.000Z',
        shipped_at: null,
        shipping_carrier: null,
        tracking_number: null,
        order_items: [
          { id: 'item-1', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock' },
        ],
        ...overrides,
      };
    }

    async function listOrders(rows: unknown[]) {
      queryResult = { data: rows, count: rows.length, error: null };
      const { GET } = await import('@/app/api/admin/orders/route');
      const response = await GET(new Request('http://localhost/api/admin/orders'));
      const body = await response.json() as { data: Array<Record<string, any>> };
      return { response, rows: body.data };
    }

    it('返金済みの額（refunded_amount）は利用者の JWT で読み、受け取った額（paid_amount）は読まない', async () => {
      await listOrders([]);

      const selected = String(query.select.mock.calls[0][0]);
      expect(selected).toMatch(/\brefunded_amount\b/);
      // paid_amount は店内だけの列（お客様の JWT に GRANT しない）。要約の RPC から受け取る
      expect(selected).not.toMatch(/\bpaid_amount\b/);
    });

    it('返金の要約は、1ページ分の注文（ほかの状態の注文も含む）を1回で読む', async () => {
      await listOrders([
        orderRow({ id: 'order-a' }),
        orderRow({ id: 'order-b', status: 'pending' }),
        orderRow({ id: 'order-c', status: 'cancelled' }),
      ]);

      expect(rpcCallsOf('list_order_refund_summaries')).toEqual([{ _order_ids: ['order-a', 'order-b', 'order-c'] }]);
    });

    it.each<[string, string, string, Record<string, unknown>, number | null]>([
      ['支払い手続き中', 'unpaid', '未入金', { status: 'payment_in_progress' }, null],
      ['入金待ち', 'unpaid', '未入金', { status: 'pending' }, null],
      ['決済失敗', 'failed', '支払いの失敗', { status: 'failed' }, null],
      ['放棄', 'none', '支払いなし', { status: 'abandoned' }, null],
      ['未入金のまま取り消した注文', 'none', '支払いなし', { status: 'cancelled' }, null],
      ['支払い済み', 'paid', '支払い済み', { status: 'paid' }, 10_000],
      ['返金の無い発送済み', 'paid', '支払い済み', { status: 'shipped' }, 10_000],
      ['一部を返金した注文', 'partially_refunded', '一部返金', { status: 'paid', refunded_amount: 3_000 }, 10_000],
      ['全額を返金して取り消した注文', 'refunded', '返金済み', { status: 'cancelled', refunded_amount: 10_000 }, 10_000],
    ])('%s の支払いは %s（%s）', async (_name, key, word, overrides, paidAmount) => {
      refundSummaryOverrides = { 'order-1': { paid_amount: paidAmount } };

      const { rows } = await listOrders([orderRow(overrides)]);

      expect(rows[0]).toMatchObject({ paymentStatusKey: key, paymentStatus: word });
    });

    it('返金済みの額は金額の言葉で返し、返金が無ければ -', async () => {
      refundSummaryOverrides = { 'order-1': { paid_amount: 10_000 }, 'order-2': { paid_amount: 10_000 } };

      const { rows } = await listOrders([
        orderRow({ id: 'order-1', refunded_amount: 3_000 }),
        orderRow({ id: 'order-2' }),
      ]);

      expect(rows[0].refundedAmountLabel).toMatch(/3,000$/);
      expect(rows[1].refundedAmountLabel).toBe('-');
    });

    it('小さな印は、返事待ち・保留の返金（返金の手続き中）と、開いている返金の失敗の要対応（返金の失敗）をそれぞれ返す', async () => {
      refundSummaryOverrides = {
        'order-pending': { paid_amount: 10_000, open_amount: 6_000, refundable_amount: 4_000, has_open_refund: true },
        'order-failed': { paid_amount: 10_000, refundable_amount: 10_000, has_unresolved_refund_failure: true },
        'order-plain': { paid_amount: 10_000, refundable_amount: 10_000 },
      };

      const { rows } = await listOrders([
        orderRow({ id: 'order-pending' }),
        orderRow({ id: 'order-failed' }),
        orderRow({ id: 'order-plain' }),
      ]);
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

      expect(byId['order-pending']).toMatchObject({ refundPending: true, refundFailed: false });
      expect(byId['order-failed']).toMatchObject({ refundPending: false, refundFailed: true });
      expect(byId['order-plain']).toMatchObject({ refundPending: false, refundFailed: false });
    });

    it.each<[string, boolean, Record<string, unknown>, Record<string, unknown>]>([
      ['支払い済みで返せる額がある', true, { status: 'paid' }, { paid_amount: 10_000, refundable_amount: 10_000 }],
      ['発送済みで返せる額がある', true, { status: 'shipped' }, { paid_amount: 10_000, refundable_amount: 10_000 }],
      [
        '一部を返金した後も返せる額が残っている', true, { status: 'paid', refunded_amount: 3_000 },
        { paid_amount: 10_000, succeeded_amount: 3_000, refundable_amount: 7_000 },
      ],
      [
        '取り消した注文に入金が届いた（受け取った額があり、まだ返していない）', true, { status: 'cancelled' },
        { paid_amount: 10_000, refundable_amount: 10_000 },
      ],
      [
        '全額を返し終えた', false, { status: 'cancelled', refunded_amount: 10_000 },
        { paid_amount: 10_000, succeeded_amount: 10_000, refundable_amount: 0 },
      ],
      [
        'コンビニ払いの返金が保留（口座の入力待ち）や返事待ちでも、返せる額が残っていれば出す', true, { status: 'paid' },
        { paid_amount: 10_000, open_amount: 4_000, refundable_amount: 6_000, has_open_refund: true },
      ],
      [
        '残りを全部返す返金が返事待ち・保留で、返せる額が0', false, { status: 'paid' },
        { paid_amount: 10_000, open_amount: 10_000, refundable_amount: 0, has_open_refund: true },
      ],
      ['入金待ち（受け取った額が無い）', false, { status: 'pending' }, { paid_amount: null }],
      ['未入金のまま取り消した注文', false, { status: 'cancelled' }, { paid_amount: null }],
    ])('%s なら canRefund=%s', async (_name, canRefund, overrides, summary) => {
      refundSummaryOverrides = { 'order-1': summary };

      const { rows } = await listOrders([orderRow(overrides)]);

      expect(rows[0].canRefund).toBe(canRefund);
    });

    type CancelCase = {
      name: string;
      kind: 'unpaid' | 'paid' | null;
      order: Record<string, unknown>;
      summary?: Record<string, unknown>;
      /** 発送した数（支払い済み・発送済みの注文の商品ごとの数。注文の数は2） */
      shipped?: number;
      /** 入金待ちの注文の PaymentIntent（Stripe が返す物） */
      paymentIntent?: Record<string, unknown>;
    };

    it.each<CancelCase>([
      { name: '支払い手続き中', kind: 'unpaid', order: { status: 'payment_in_progress' } },
      { name: '決済失敗', kind: 'unpaid', order: { status: 'failed' } },
      {
        name: '入金待ちで払込票が期限切れ', kind: 'unpaid',
        order: { status: 'pending', payment_intent_id: 'pi_cancel_kind_expired' },
        paymentIntent: { status: 'requires_payment_method' },
      },
      {
        name: '入金待ちで払込票が有効', kind: null,
        order: { status: 'pending', payment_intent_id: 'pi_cancel_kind_voucher' },
        paymentIntent: { status: 'requires_action' },
      },
      {
        name: '支払い済みで1つも発送していない', kind: 'paid', order: { status: 'paid' },
        summary: { paid_amount: 10_000, refundable_amount: 10_000 }, shipped: 0,
      },
      {
        name: '支払い済みで一部を発送した', kind: null, order: { status: 'paid' },
        summary: { paid_amount: 10_000, refundable_amount: 10_000 }, shipped: 1,
      },
      {
        name: '支払い済みで返せる額が無い', kind: null, order: { status: 'paid' },
        summary: { paid_amount: 10_000, refundable_amount: 0 }, shipped: 0,
      },
      {
        name: '発送済み', kind: null, order: { status: 'shipped' },
        summary: { paid_amount: 10_000, refundable_amount: 10_000 }, shipped: 2,
      },
      {
        name: '取り消した注文', kind: null, order: { status: 'cancelled' },
        summary: { paid_amount: 10_000, refundable_amount: 10_000 },
      },
    ])('$name の注文は cancelKind=$kind', async ({ kind, order, summary = {}, shipped = 0, paymentIntent }) => {
      refundSummaryOverrides = { 'order-1': summary };
      lineFulfillmentRows = [lineRow({
        order_id: 'order-1', order_item_id: 'item-1', quantity: 2, shipped, completed: 2,
        ready_unshipped: 2 - shipped, unshipped: 2 - shipped,
      })];
      if (paymentIntent) {
        getStripeMock.mockReturnValue({
          paymentIntents: { retrieve: jest.fn().mockResolvedValue({ payment_method_types: ['konbini'], ...paymentIntent }) },
        });
      }

      const { rows } = await listOrders([orderRow(order)]);

      expect(rows[0]).toMatchObject({ cancelKind: kind, canCancel: kind !== null });
    });

    it('支払い済みで、未発送も発送も0で、返事待ち・保留の返金がある注文は「キャンセルの手続き中」', async () => {
      lineFulfillmentRows = [lineRow({
        order_id: 'order-1', order_item_id: 'item-1', quantity: 2, shipped: 0, completed: 2, ready_unshipped: 0, unshipped: 0,
      })];
      refundSummaryOverrides = {
        'order-1': { paid_amount: 10_000, open_amount: 10_000, refundable_amount: 0, has_open_refund: true },
      };

      const { rows } = await listOrders([orderRow()]);

      expect(rows[0]).toMatchObject({
        status: 'キャンセルの手続き中', orderStatus: 'paid', progressKey: 'cancel_pending', refundPending: true, canShip: false,
      });
    });

    it('未発送が残っていれば、返金の手続き中でも進み具合の言葉は変えない', async () => {
      lineFulfillmentRows = [lineRow({
        order_id: 'order-1', order_item_id: 'item-1', quantity: 2, shipped: 0, completed: 2, ready_unshipped: 1, unshipped: 1,
      })];
      refundSummaryOverrides = {
        'order-1': { paid_amount: 10_000, open_amount: 4_000, refundable_amount: 6_000, has_open_refund: true },
      };

      const { rows } = await listOrders([orderRow()]);

      expect(rows[0]).toMatchObject({ status: '発送準備中', progressKey: 'ready', refundPending: true });
    });

    it('返金の要約を読めなかった時は 500 にする（返せる額が分からないまま返金のボタンを出さない）。ログは名前と code だけ', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      rpcMock.mockImplementation(async (name: string) =>
        name === 'list_order_refund_summaries'
          ? { data: null, error: { message: 'SECRET-MESSAGE', details: 'SECRET-DETAILS', hint: 'SECRET-HINT', code: '08006' } }
          : { data: lineFulfillmentRows, error: null });
      queryResult = { data: [orderRow()], count: 1, error: null };

      try {
        const { GET } = await import('@/app/api/admin/orders/route');
        const response = await GET(new Request('http://localhost/api/admin/orders'));

        expect(response.status).toBe(500);
        expect(consoleError.mock.calls[0].slice(0, 3)).toEqual(['GET /api/admin/orders error:', 'RefundStoreError', '08006']);
        expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain('SECRET');
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  // 返品の列・小さな印・ボタンの名前（returnSummary）、一覧の上の一行の数（returnAttention）、返品の絞り込み（return=）、
  // 商品数から交換の品を外すこと。返品の要約と数は DB の関数が出す（Task 4 の return-store を差し替えて渡す）。
  // 絞り込みは、DB の関数 list_order_ids_by_return_status が返す注文の番号で注文を絞る（グループ E-3 設計書 8-1・10-1）
  describe('返品の要約・一行の数・絞り込み・交換の品の商品数', () => {
    function orderRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'order-1',
        payment_intent_id: null,
        checkout_session_id: 'cs_1',
        status: 'paid',
        total_amount: 10_000,
        refunded_amount: 0,
        currency: 'jpy',
        shipping_email: 'buyer@example.com',
        shipping_full_name: '山田太郎',
        shipping_postal_code: '1000001',
        shipping_prefecture: '東京都',
        shipping_city: '千代田区',
        shipping_address: '丸の内1-1-1',
        shipping_phone: '0312345678',
        review_reason: null,
        reviewed_at: null,
        created_at: '2026-10-12T00:00:00.000Z',
        shipped_at: null,
        shipping_carrier: null,
        tracking_number: null,
        order_items: [
          { id: 'item-1', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock', line_kind: 'order' },
        ],
        ...overrides,
      };
    }

    async function listOrders(rows: unknown[], url = 'http://localhost/api/admin/orders') {
      queryResult = { data: rows, count: rows.length, error: null };
      const { GET } = await import('@/app/api/admin/orders/route');
      const response = await GET(new Request(url));
      const body = await response.json() as { data: Array<Record<string, any>>; pagination: unknown; returnAttention: unknown };
      return { response, body, rows: body.data };
    }

    it('商品数（itemCount）は交換の品の行を外す。購入商品（items）には残して lineKind を付け、line_kind が読めない行は order', async () => {
      const { rows } = await listOrders([orderRow({
        order_items: [
          { id: 'item-1', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock', line_kind: 'order' },
          { id: 'item-ex', item_name: 'シルクブラウス', color: '黒', size: 'L', quantity: 1, fulfillment_type: 'stock', line_kind: 'exchange' },
          { id: 'item-old', item_name: 'ウールコート', color: null, size: null, quantity: 3, fulfillment_type: 'stock' },
        ],
      })]);

      expect(rows[0].itemCount).toBe('5点');
      expect(rows[0].items.map((item: { id: string; lineKind: string }) => [item.id, item.lineKind])).toEqual([
        ['item-1', 'order'],
        ['item-ex', 'exchange'],
        ['item-old', 'order'],
      ]);
    });

    it('発送・受注生産の数（進み具合・発送と仕上がりのボタン）は、交換の品の行も数える', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-1', quantity: 2, shipped: 2, completed: 2, ready_unshipped: 0, unshipped: 0 }),
        lineRow({
          order_id: 'order-1', order_item_id: 'item-ex', fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 0,
          in_production: 1, ready_unshipped: 0, unshipped: 1,
        }),
      ];

      const { rows } = await listOrders([orderRow({
        order_items: [
          { id: 'item-1', item_name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillment_type: 'stock', line_kind: 'order' },
          { id: 'item-ex', item_name: 'シルクブラウス', color: '黒', size: 'L', quantity: 1, fulfillment_type: 'backorder', line_kind: 'exchange' },
        ],
      })]);

      expect(rows[0]).toMatchObject({
        itemCount: '2点', status: '受注生産中', partiallyShipped: true, canShip: true, canRecordCompletion: true,
      });
    });

    it('各注文に返品の要約（returnSummary）を付ける。要約は DB の関数が出した物をそのまま写し、返品の無い注文は null と 0 の要約', async () => {
      returnSummaryOverrides = {
        'order-a': {
          displayStatus: 'refund_waiting', marks: ['awaiting_fee'], nextAction: 'refund', hasReturnable: true,
          refundWaitingReturns: 1, requestedReturns: 0,
        },
        'order-b': { displayStatus: 'in_progress', marks: ['partially_received'], nextAction: 'receive' },
      };

      const { rows } = await listOrders([orderRow({ id: 'order-a' }), orderRow({ id: 'order-b' }), orderRow({ id: 'order-c' })]);
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

      expect(byId['order-a'].returnSummary).toEqual({
        orderId: 'order-a', displayStatus: 'refund_waiting', marks: ['awaiting_fee'], nextAction: 'refund', hasReturnable: true,
        refundWaitingReturns: 1, requestedReturns: 0,
      });
      expect(byId['order-b'].returnSummary).toMatchObject({
        displayStatus: 'in_progress', marks: ['partially_received'], nextAction: 'receive',
      });
      expect(byId['order-c'].returnSummary).toEqual(returnSummaryOf('order-c'));
    });

    it('返品の要約は、1ページ分の注文（ほかの状態の注文も含む）を service_role で1回で読む', async () => {
      await listOrders([
        orderRow({ id: 'order-a' }),
        orderRow({ id: 'order-b', status: 'pending' }),
        orderRow({ id: 'order-c', status: 'cancelled' }),
      ]);

      expect(listOrderReturnSummariesMock).toHaveBeenCalledTimes(1);
      expect(listOrderReturnSummariesMock).toHaveBeenCalledWith(
        expect.objectContaining({ rpc: expect.any(Function) }),
        ['order-a', 'order-b', 'order-c'],
      );
    });

    it('要約が返らなかった注文は、返品の無い要約にする', async () => {
      listOrderReturnSummariesMock.mockResolvedValueOnce(new Map());

      const { rows } = await listOrders([orderRow()]);

      expect(rows[0].returnSummary).toEqual(returnSummaryOf('order-1'));
    });

    it('一覧の上の一行の数（returnAttention）を service_role で読み、答えに付ける', async () => {
      countReturnAttentionMock.mockResolvedValue({ requested: 2, refundWaiting: 1 });

      const { body } = await listOrders([orderRow()]);

      expect(body.returnAttention).toEqual({ requested: 2, refundWaiting: 1 });
      expect(countReturnAttentionMock).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }));
    });

    it.each(['requested', 'in_progress', 'refund_waiting', 'returned'])(
      '返品の絞り込み return=%s は、DB の関数が返した注文の番号で注文を絞る',
      async (displayStatus) => {
        returnFilterRows = [{ order_id: 'order-a' }, { order_id: 'order-b' }];

        const { response, rows } = await listOrders(
          [orderRow({ id: 'order-a' }), orderRow({ id: 'order-b' })],
          `http://localhost/api/admin/orders?return=${displayStatus}`,
        );

        expect(response.status).toBe(200);
        expect(rows.map((row) => row.id)).toEqual(['order-a', 'order-b']);
        expect(rpcCallsOf('list_order_ids_by_return_status')).toEqual([{ _display_status: displayStatus }]);
        expect(query.in).toHaveBeenCalledWith('id', ['order-a', 'order-b']);
      },
    );

    it('絞り込みの問いが無ければ、番号を引く DB の関数を呼ばず、注文を番号で絞らない', async () => {
      await listOrders([orderRow()]);

      expect(rpcCallsOf('list_order_ids_by_return_status')).toEqual([]);
      expect(query.in).not.toHaveBeenCalled();
    });

    it('返品の絞り込みは、ほかの絞り込み（状態・検索）と「かつ」で重なる', async () => {
      returnFilterRows = [{ order_id: 'order-a' }];

      await listOrders(
        [orderRow({ id: 'order-a' })],
        'http://localhost/api/admin/orders?return=returned&status=paid&counterparty=yamada',
      );

      expect(query.eq).toHaveBeenCalledWith('status', 'paid');
      expect(query.or).toHaveBeenCalledWith(expect.stringContaining('shipping_full_name.ilike.%yamada%'));
      expect(query.in).toHaveBeenCalledWith('id', ['order-a']);
    });

    it.each(['return=cancelled', 'return=', 'return=refund_waiting%20'])(
      '返品の絞り込みの値が4つのどれでもなければ（%s）400。DB の関数を呼ばない',
      async (parameters) => {
        const { GET } = await import('@/app/api/admin/orders/route');

        const response = await GET(new Request(`http://localhost/api/admin/orders?${parameters}`));

        expect(response.status).toBe(400);
        expect(rpcCallsOf('list_order_ids_by_return_status')).toEqual([]);
      },
    );

    it('当たる注文が無ければ、注文を読まずに空の一覧を返す。一行の数は付ける', async () => {
      returnFilterRows = [];
      countReturnAttentionMock.mockResolvedValue({ requested: 1, refundWaiting: 2 });
      const { GET } = await import('@/app/api/admin/orders/route');

      const response = await GET(new Request('http://localhost/api/admin/orders?return=requested&page=3&pageSize=50'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        data: [],
        pagination: { page: 3, pageSize: 50, total: 0, totalPages: 1 },
        returnAttention: { requested: 1, refundWaiting: 2 },
        cancelRequestAttention: 0,
      });
      expect(query.select).not.toHaveBeenCalled();
      expect(query.in).not.toHaveBeenCalled();
      expect(rpcCallsOf('list_order_line_fulfillment')).toEqual([]);
    });

    it('絞り込みの番号を読めなかった時は 500。ログは名前と code だけで、DB の文は出さない', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      returnFilterError = { message: 'SECRET-MESSAGE', details: 'SECRET-DETAILS', hint: 'SECRET-HINT', code: '08006' };

      try {
        const { GET } = await import('@/app/api/admin/orders/route');
        const response = await GET(new Request('http://localhost/api/admin/orders?return=requested'));

        expect(response.status).toBe(500);
        expect(consoleError).toHaveBeenCalledWith('GET /api/admin/orders error:', 'UnknownError', '08006', null);
        expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain('SECRET');
      } finally {
        consoleError.mockRestore();
      }
    });

    it('当たる注文が100件より多い時は、番号を100件ずつに分けて読み、新しい順に並べ直してこのページの分を返す（URL の長さで断られないように）', async () => {
      const ids = Array.from({ length: 250 }, (_, index) => `order-${String(index).padStart(3, '0')}`);
      returnFilterRows = ids.map((orderId) => ({ order_id: orderId }));
      // 分けた問い合わせごとに、その番号の先頭の注文だけが、ほかの絞り込みにも当たった答えを返す（後ろの番号ほど新しい注文）
      const createdAtOf: Record<string, string> = {
        'order-000': '2026-10-10T00:00:00.000Z',
        'order-100': '2026-10-11T00:00:00.000Z',
        'order-200': '2026-10-12T00:00:00.000Z',
      };
      query.in.mockImplementation((_column: string, chunk: string[]) => {
        queryResult = { data: [orderRow({ id: chunk[0], created_at: createdAtOf[chunk[0]] })], count: 1, error: null };
        return query;
      });
      const { GET } = await import('@/app/api/admin/orders/route');

      const response = await GET(new Request('http://localhost/api/admin/orders?return=returned&pageSize=2'));
      const body = await response.json() as { data: Array<{ id: string }>; pagination: unknown };

      expect(response.status).toBe(200);
      expect(query.in.mock.calls.map(([column, chunk]) => [column, chunk.length])).toEqual([['id', 100], ['id', 100], ['id', 50]]);
      expect(query.in.mock.calls.flatMap(([, chunk]) => chunk)).toEqual(ids);
      // ほかの絞り込み（ここでは既定の「放棄を除く」）は、分けた問い合わせごとに重ねる。ページは範囲の指定（range）ではなく、並べ直した後で切り出す
      expect(query.neq.mock.calls).toEqual([['status', 'abandoned'], ['status', 'abandoned'], ['status', 'abandoned']]);
      expect(query.range).not.toHaveBeenCalled();
      // 3件に当たり、新しい順の先頭2件がこのページ。総数は当たった数
      expect(body.data.map((row) => row.id)).toEqual(['order-200', 'order-100']);
      expect(body.pagination).toEqual({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    });

    // キャンセルの申し込み（グループ E-3 段2、決め事 P11）: 各行の印 cancelRequestOpen、一覧の上の一行の数 cancelRequestAttention、
    // 絞り込み cancelRequest=open。読み出しは cancel-request-reads が表を直に読む（ここでは差し替えた物の呼ばれ方と答えの形を確かめる）
    describe('キャンセルの申し込みの印・一行の数・絞り込み', () => {
      it('各注文に cancelRequestOpen を付ける。印は1ページ分の注文の番号（ほかの状態の注文も含む）で1回だけ引く', async () => {
        findOrderIdsWithOpenCancelRequestMock.mockResolvedValue(new Set(['order-a']));

        const { rows } = await listOrders([
          orderRow({ id: 'order-a' }),
          orderRow({ id: 'order-b', status: 'pending' }),
          orderRow({ id: 'order-c', status: 'cancelled' }),
        ]);

        expect(Object.fromEntries(rows.map((row) => [row.id, row.cancelRequestOpen]))).toEqual({
          'order-a': true,
          'order-b': false,
          'order-c': false,
        });
        expect(findOrderIdsWithOpenCancelRequestMock).toHaveBeenCalledTimes(1);
        expect(findOrderIdsWithOpenCancelRequestMock).toHaveBeenCalledWith(
          expect.objectContaining({ rpc: expect.any(Function) }),
          ['order-a', 'order-b', 'order-c'],
        );
      });

      it('一覧の上の一行の数（cancelRequestAttention）を service_role で読み、答えに付ける', async () => {
        countOrdersWithOpenCancelRequestMock.mockResolvedValue(3);

        const { body } = await listOrders([orderRow()]);

        expect((body as unknown as { cancelRequestAttention: number }).cancelRequestAttention).toBe(3);
        expect(countOrdersWithOpenCancelRequestMock).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }));
      });

      it('絞り込みの問いが無ければ、番号を引く読み出しを呼ばず、注文を番号で絞らない', async () => {
        await listOrders([orderRow()]);

        expect(listOrderIdsWithOpenCancelRequestMock).not.toHaveBeenCalled();
        expect(query.in).not.toHaveBeenCalled();
      });

      it('絞り込み cancelRequest=open は、開いている申し込みのある注文の番号で注文を絞る', async () => {
        listOrderIdsWithOpenCancelRequestMock.mockResolvedValue(['order-b', 'order-a']);

        const { response, rows } = await listOrders(
          [orderRow({ id: 'order-a' }), orderRow({ id: 'order-b' })],
          'http://localhost/api/admin/orders?cancelRequest=open',
        );

        expect(response.status).toBe(200);
        expect(rows.map((row) => row.id)).toEqual(['order-a', 'order-b']);
        expect(listOrderIdsWithOpenCancelRequestMock).toHaveBeenCalledTimes(1);
        expect(listOrderIdsWithOpenCancelRequestMock).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }));
        expect(query.in).toHaveBeenCalledWith('id', ['order-b', 'order-a']);
        expect(rpcCallsOf('list_order_ids_by_return_status')).toEqual([]);
      });

      it('cancelRequest=open は、ほかの絞り込み（状態・検索）と「かつ」で重なる', async () => {
        listOrderIdsWithOpenCancelRequestMock.mockResolvedValue(['order-a']);

        await listOrders(
          [orderRow({ id: 'order-a' })],
          'http://localhost/api/admin/orders?cancelRequest=open&status=paid&counterparty=yamada',
        );

        expect(query.eq).toHaveBeenCalledWith('status', 'paid');
        expect(query.or).toHaveBeenCalledWith(expect.stringContaining('shipping_full_name.ilike.%yamada%'));
        expect(query.in).toHaveBeenCalledWith('id', ['order-a']);
      });

      it('return= と cancelRequest=open が両方付いたら、両方に当たる注文だけで絞る（return= 側の並びのまま）', async () => {
        returnFilterRows = [{ order_id: 'order-a' }, { order_id: 'order-b' }, { order_id: 'order-c' }];
        listOrderIdsWithOpenCancelRequestMock.mockResolvedValue(['order-d', 'order-c', 'order-b']);

        await listOrders(
          [orderRow({ id: 'order-b' }), orderRow({ id: 'order-c' })],
          'http://localhost/api/admin/orders?return=requested&cancelRequest=open',
        );

        expect(rpcCallsOf('list_order_ids_by_return_status')).toEqual([{ _display_status: 'requested' }]);
        expect(query.in).toHaveBeenCalledWith('id', ['order-b', 'order-c']);
      });

      it('両方付いて重なる注文が無ければ、注文を読まずに空の一覧を返す。二つの一行の数は付ける', async () => {
        returnFilterRows = [{ order_id: 'order-a' }];
        listOrderIdsWithOpenCancelRequestMock.mockResolvedValue(['order-z']);
        countReturnAttentionMock.mockResolvedValue({ requested: 1, refundWaiting: 0 });
        countOrdersWithOpenCancelRequestMock.mockResolvedValue(4);
        const { GET } = await import('@/app/api/admin/orders/route');

        const response = await GET(new Request('http://localhost/api/admin/orders?return=requested&cancelRequest=open'));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          data: [],
          pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 },
          returnAttention: { requested: 1, refundWaiting: 0 },
          cancelRequestAttention: 4,
        });
        expect(query.select).not.toHaveBeenCalled();
        expect(query.in).not.toHaveBeenCalled();
      });

      it('cancelRequest=open だけで、開いている申し込みが無ければ、注文を読まずに空の一覧を返す', async () => {
        listOrderIdsWithOpenCancelRequestMock.mockResolvedValue([]);
        countOrdersWithOpenCancelRequestMock.mockResolvedValue(0);
        const { GET } = await import('@/app/api/admin/orders/route');

        const response = await GET(new Request('http://localhost/api/admin/orders?cancelRequest=open&page=2'));

        await expect(response.json()).resolves.toEqual({
          data: [],
          pagination: { page: 2, pageSize: 20, total: 0, totalPages: 1 },
          returnAttention: { requested: 0, refundWaiting: 0 },
          cancelRequestAttention: 0,
        });
        expect(query.select).not.toHaveBeenCalled();
        expect(findOrderIdsWithOpenCancelRequestMock).not.toHaveBeenCalled();
      });

      it.each(['cancelRequest=closed', 'cancelRequest=', 'cancelRequest=OPEN'])(
        '絞り込みの値が open でなければ（%s）400。表を読まない',
        async (parameters) => {
          const { GET } = await import('@/app/api/admin/orders/route');

          const response = await GET(new Request(`http://localhost/api/admin/orders?${parameters}`));

          expect(response.status).toBe(400);
          expect(listOrderIdsWithOpenCancelRequestMock).not.toHaveBeenCalled();
        },
      );

      // 読めなかった時は 500（印と「キャンセルの申し込み」の数を欠いたまま一覧を出さない）。cancel-request-reads は E-2 の RefundStoreError で投げる
      it.each<[string, () => unknown, string, string]>([
        [
          '各行の印',
          () => findOrderIdsWithOpenCancelRequestMock.mockRejectedValue(
            new RefundStoreError('find_open_cancel_requests', { message: 'SECRET-MESSAGE', code: '08006' }),
          ),
          'http://localhost/api/admin/orders',
          'find_open_cancel_requests',
        ],
        [
          '一覧の上の一行の数',
          () => countOrdersWithOpenCancelRequestMock.mockRejectedValue(
            new RefundStoreError('count_open_cancel_requests', { message: 'SECRET-MESSAGE', code: '08006' }),
          ),
          'http://localhost/api/admin/orders',
          'count_open_cancel_requests',
        ],
        [
          '絞り込みの番号',
          () => listOrderIdsWithOpenCancelRequestMock.mockRejectedValue(
            new RefundStoreError('list_open_cancel_requests', { message: 'SECRET-MESSAGE', code: '08006' }),
          ),
          'http://localhost/api/admin/orders?cancelRequest=open',
          'list_open_cancel_requests',
        ],
      ])('%sを読めなかった時は 500。ログは名前・code・呼び出しの名前だけで、DB の文は出さない', async (_name, fail, url, operation) => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        fail();
        queryResult = { data: [orderRow()], count: 1, error: null };

        try {
          const { GET } = await import('@/app/api/admin/orders/route');
          const response = await GET(new Request(url));

          expect(response.status).toBe(500);
          expect(consoleError).toHaveBeenCalledWith('GET /api/admin/orders error:', 'RefundStoreError', '08006', operation);
          expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain('SECRET');
        } finally {
          consoleError.mockRestore();
        }
      });
    });

    // 思いがけない DB の失敗は、Task 4 の return-store が E-2 の RefundStoreError（呼び出しの名前と DB の記号を持ち、DB の文は cause にだけ残す）で投げる
    it.each<[string, () => unknown, string]>([
      [
        '返品の要約',
        () => listOrderReturnSummariesMock.mockRejectedValue(
          new RefundStoreError('list_order_return_summaries', { message: 'SECRET-MESSAGE', code: '08006' }),
        ),
        'list_order_return_summaries',
      ],
      [
        '一覧の上の一行の数',
        () => countReturnAttentionMock.mockRejectedValue(
          new RefundStoreError('count_order_return_attention', { message: 'SECRET-MESSAGE', code: '08006' }),
        ),
        'count_order_return_attention',
      ],
    ])('%sを読めなかった時は 500（返品の印を欠いたまま一覧を出さない）。ログは名前・code・呼び出しの名前だけ', async (_name, fail, operation) => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      fail();
      queryResult = { data: [orderRow()], count: 1, error: null };

      try {
        const { GET } = await import('@/app/api/admin/orders/route');
        const response = await GET(new Request('http://localhost/api/admin/orders'));

        expect(response.status).toBe(500);
        expect(consoleError).toHaveBeenCalledWith('GET /api/admin/orders error:', 'RefundStoreError', '08006', operation);
        expect(inspect(consoleError.mock.calls, { depth: null })).not.toContain('SECRET');
      } finally {
        consoleError.mockRestore();
      }
    });
  });
});
