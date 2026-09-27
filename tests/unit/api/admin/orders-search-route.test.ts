export {};

const authorizeMock = jest.fn();
const createClientMock = jest.fn();
const getStripeMock = jest.fn();
let queryResult: { data: unknown[]; count: number; error: null } = { data: [], count: 0, error: null };

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

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
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
    or: jest.fn(),
    then: (resolve: (value: unknown) => void) => resolve(queryResult),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    for (const method of ['select', 'order', 'range', 'gte', 'lte', 'eq', 'or'] as const) {
      query[method].mockReturnValue(query);
    }
    queryResult = { data: [], count: 0, error: null };
    authorizeMock.mockResolvedValue({ ok: true });
    createClientMock.mockResolvedValue({ from: jest.fn().mockReturnValue(query) });
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
});
