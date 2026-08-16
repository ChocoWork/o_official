jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      cookies: { set: jest.fn() },
    }),
  },
}));

const mockAuthorize = jest.fn();
const mockCsrf = jest.fn();
const mockOrderSelect = jest.fn();
const mockSyncPaymentIntentAccounting = jest.fn();
const mockSyncRefundAccounting = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: async () => ({ from: () => mockOrderSelect() }),
}));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: () => ({}) }));
jest.mock('@/lib/stripe/supabase-accounting-database', () => ({
  createStripeAccountingDatabase: jest.fn().mockReturnValue({}),
}));
jest.mock('@/lib/stripe/accounting-sync', () => ({
  syncPaymentIntentAccounting: (...args: unknown[]) => mockSyncPaymentIntentAccounting(...args),
  syncRefundAccounting: (...args: unknown[]) => mockSyncRefundAccounting(...args),
}));

import { POST } from '@/app/api/admin/accounting/stripe-backfill/route';

function request(body: unknown = { limit: 100 }): Request {
  return new Request('http://localhost/api/admin/accounting/stripe-backfill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type OrdersBuilder = {
  select: jest.Mock;
  not: jest.Mock;
  gt: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
};

function ordersQuery(rows: Array<{ id: string; payment_intent_id: string }>) {
  const builder: OrdersBuilder = {
    select: jest.fn(() => builder),
    not: jest.fn(() => builder),
    gt: jest.fn(() => builder),
    order: jest.fn(() => builder),
    limit: jest.fn(async () => ({ data: rows, error: null })),
  };
  return builder;
}

describe('POST /api/admin/accounting/stripe-backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', actorEmail: 'admin@example.com' });
    mockCsrf.mockResolvedValue(undefined);
    mockSyncPaymentIntentAccounting.mockResolvedValue({ disposition: 'inserted' });
    mockSyncRefundAccounting.mockResolvedValue({ disposition: 'inserted' });
    mockOrderSelect.mockReturnValue(ordersQuery([{ id: 'order-1', payment_intent_id: 'pi_1' }]));
  });

  it('denies a request without the finance manage permission', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: { status: 403, json: async () => ({}) } });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mockSyncPaymentIntentAccounting).not.toHaveBeenCalled();
  });

  it('denies a request that fails CSRF verification', async () => {
    mockCsrf.mockResolvedValue(new Response(null, { status: 403 }));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(mockSyncPaymentIntentAccounting).not.toHaveBeenCalled();
  });

  it.each([[0], [101], ['many']])('rejects an out-of-range limit: %s', async (limit) => {
    const response = await POST(request({ limit }));

    expect(response.status).toBe(400);
    expect(mockSyncPaymentIntentAccounting).not.toHaveBeenCalled();
  });

  it('syncs existing orders only and returns the next cursor', async () => {
    mockOrderSelect.mockReturnValue(ordersQuery([
      { id: 'order-1', payment_intent_id: 'pi_1' },
      { id: 'order-2', payment_intent_id: 'pi_2' },
    ]));

    const body = await (await POST(request({ limit: 2 }))).json();

    expect(mockSyncPaymentIntentAccounting).toHaveBeenCalledTimes(2);
    expect(body.data).toMatchObject({
      processed: 2,
      synced: 2,
      failed: 0,
      nextCursor: 'order-2',
      errors: [],
    });
  });

  it('reports a failed order without aborting the batch', async () => {
    mockOrderSelect.mockReturnValue(ordersQuery([
      { id: 'order-1', payment_intent_id: 'pi_1' },
      { id: 'order-2', payment_intent_id: 'pi_2' },
    ]));
    mockSyncPaymentIntentAccounting
      .mockRejectedValueOnce(new Error('stripe unavailable'))
      .mockResolvedValueOnce({ disposition: 'inserted' });

    const body = await (await POST(request({ limit: 2 }))).json();

    expect(body.data).toMatchObject({
      processed: 2,
      synced: 1,
      failed: 1,
      errors: [{ orderId: 'order-1', reason: 'stripe unavailable' }],
    });
  });

  it('returns a null cursor when the page is not full', async () => {
    const body = await (await POST(request({ limit: 100 }))).json();

    expect(body.data.nextCursor).toBeNull();
  });
});
