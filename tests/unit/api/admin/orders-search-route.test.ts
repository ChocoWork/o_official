export {};

const authorizeMock = jest.fn();
const createClientMock = jest.fn();
const getStripeMock = jest.fn();
let queryResult: { data: unknown[]; count: number; error: null } = { data: [], count: 0, error: null };
let shipBlockedRows: Array<{ order_id: string }> = [];

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
          order_items: [],
        },
      ],
      count: 3,
      error: null,
    };
    shipBlockedRows = [{ order_id: 'order-mismatch' }];
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

    expect(byId['order-in-progress']).toMatchObject({ status: '支払い手続き中', canCancel: true, cancelBlockedUntil: null });
    expect(byId['order-voucher']).toMatchObject({
      status: '未決済',
      canCancel: false,
      cancelBlockedUntil: new Date(future * 1000).toISOString(),
    });
    expect(byId['order-mismatch']).toMatchObject({
      status: '決済完了',
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
});
