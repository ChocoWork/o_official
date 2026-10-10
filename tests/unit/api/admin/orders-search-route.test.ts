export {};

const authorizeMock = jest.fn();
const createClientMock = jest.fn();
const getStripeMock = jest.fn();
let queryResult: { data: unknown[]; count: number; error: null } = { data: [], count: 0, error: null };
let shipBlockedRows: Array<{ order_id: string }> = [];
// public.list_order_line_fulfillment が返す行（service_role の RPC）。支払い済み・発送済みの注文の商品ごとの数
let lineFulfillmentRows: Array<Record<string, unknown>> = [];
const rpcMock = jest.fn();

function lineRow(overrides: Record<string, unknown>) {
  return {
    order_id: 'order-1', order_item_id: 'item-1', variant_id: 1, fulfillment_type: 'stock', quantity: 1,
    shipped: 0, completed: 1, in_production: 0, ready_unshipped: 1, unshipped: 1,
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
    then: (resolve: (value: unknown) => void) => resolve(queryResult),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const method of ['select', 'order', 'range', 'gte', 'lte', 'eq', 'neq', 'not', 'is', 'or'] as const) {
      query[method].mockReturnValue(query);
    }
    queryResult = { data: [], count: 0, error: null };
    authorizeMock.mockResolvedValue({ ok: true });
    createClientMock.mockResolvedValue({ from: jest.fn().mockReturnValue(query) });
    shipBlockedRows = [];
    lineFulfillmentRows = [];
    rpcMock.mockReset();
    rpcMock.mockImplementation(async () => ({ data: lineFulfillmentRows, error: null }));
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

  it('marks both paid and shipped Stripe orders as refundable', async () => {
    queryResult = {
      data: [
        {
          id: 'paid-order',
          payment_intent_id: 'pi_refundable_paid',
          status: 'paid',
          total_amount: 10_000,
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
    getStripeMock.mockReturnValue({
      paymentIntents: {
        retrieve: jest.fn().mockImplementation((id: string) => Promise.resolve({
          id,
          status: 'succeeded',
          payment_method_types: ['card'],
        })),
      },
    });

    const { GET } = await import('@/app/api/admin/orders/route');
    const response = await GET(new Request('http://localhost/api/admin/orders'));
    const body = await response.json() as { data: Array<{ id: string; canRefund: boolean }> };

    expect(response.status).toBe(200);
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'paid-order', canRefund: true }),
      expect.objectContaining({ id: 'shipped-order', canRefund: true }),
    ]));
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

    it('商品の番号・色・サイズ・在庫か受注生産かを、注文の商品と一緒に読む', async () => {
      await listOrders([]);

      const selected = String(query.select.mock.calls[0][0]);
      expect(selected).toMatch(/order_items\s*\(\s*id,\s*item_name,\s*color,\s*size,\s*quantity,\s*fulfillment_type\s*\)/);
      expect(query.select.mock.calls[0][1]).toEqual({ count: 'exact' });
    });

    it('一部を送って受注生産の品が残る注文は「受注生産中」＋一部発送済みで、発送も仕上がりの記録もできる', async () => {
      lineFulfillmentRows = [
        lineRow({ order_id: 'order-1', order_item_id: 'item-stock', quantity: 2, shipped: 1, completed: 2, in_production: 0, ready_unshipped: 1, unshipped: 1 }),
        lineRow({ order_id: 'order-1', order_item_id: 'item-coat', fulfillment_type: 'backorder', quantity: 1, shipped: 0, completed: 0, in_production: 1, ready_unshipped: 0, unshipped: 1 }),
      ];

      const { rows } = await listOrders([paidOrderRow()]);

      expect(rpcMock).toHaveBeenCalledTimes(1);
      expect(rpcMock).toHaveBeenCalledWith('list_order_line_fulfillment', { _order_ids: ['order-1'] });
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
          id: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillmentType: 'stock',
          shipped: 1, inProduction: 0, readyUnshipped: 1,
        },
        {
          id: 'item-coat', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, fulfillmentType: 'backorder',
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
      expect(rpcMock).not.toHaveBeenCalled();
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
      rpcMock.mockResolvedValue({ data: null, error: { message: 'down', code: '08006' } });
      queryResult = { data: [paidOrderRow()], count: 1, error: null };

      try {
        const { GET } = await import('@/app/api/admin/orders/route');
        const response = await GET(new Request('http://localhost/api/admin/orders'));

        expect(response.status).toBe(500);
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
});
