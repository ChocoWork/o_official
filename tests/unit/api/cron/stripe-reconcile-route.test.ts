jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));
jest.mock('@/lib/stripe/reconcile-orders', () => ({
  reconcileStripeOrders: jest.fn(),
  reconcileStripePayouts: jest.fn(),
}));
jest.mock('@/lib/stripe/supabase-accounting-database', () => ({
  createStripeAccountingDatabase: jest.fn().mockReturnValue({}),
}));

import { GET } from '@/app/api/cron/stripe-reconcile/route';
import { reconcileStripeOrders, reconcileStripePayouts } from '@/lib/stripe/reconcile-orders';

const mockReconcileOrders = reconcileStripeOrders as jest.Mock;
const mockReconcilePayouts = reconcileStripePayouts as jest.Mock;

function authorizedRequest(): Request {
  return new Request('http://localhost/api/cron/stripe-reconcile', {
    headers: { authorization: 'Bearer cron-secret' },
  });
}

describe('GET /api/cron/stripe-reconcile', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret';
    jest.clearAllMocks();
  });
  afterEach(() => { delete process.env.CRON_SECRET; });

  it('rejects requests without the cron bearer token', async () => {
    const response = await GET(new Request('http://localhost/api/cron/stripe-reconcile'));
    expect(response.status).toBe(401);
    expect(reconcileStripeOrders).not.toHaveBeenCalled();
  });

  it('does not create orders for unmatched Stripe payments', async () => {
    mockReconcileOrders.mockResolvedValue({
      checkedPayments: 2,
      unmatchedActivePayments: ['pi_stripe_only'],
      refundMismatches: [],
      syncedBalanceTransactions: 1,
      syncedRefunds: 0,
      errors: [],
    });
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });

    const response = await GET(authorizedRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      matchedOrders: 1,
      unmatchedPayments: 1,
      syncedBalanceTransactions: 1,
      syncedRefunds: 0,
      syncedPayouts: 0,
      payoutMismatches: 0,
      errors: [],
    });
  });

  it('merges order and payout errors into one report', async () => {
    mockReconcileOrders.mockResolvedValue({
      checkedPayments: 1,
      unmatchedActivePayments: [],
      refundMismatches: [],
      syncedBalanceTransactions: 0,
      syncedRefunds: 0,
      errors: [{ sourceId: 'pi_1', reason: 'stripe unavailable' }],
    });
    mockReconcilePayouts.mockResolvedValue({
      syncedPayouts: 1,
      payoutMismatches: 1,
      errors: [{ sourceId: 'po_1', reason: 'payout sync failed' }],
    });

    const body = await (await GET(authorizedRequest())).json();

    expect(body.data.errors).toEqual([
      { sourceId: 'pi_1', reason: 'stripe unavailable' },
      { sourceId: 'po_1', reason: 'payout sync failed' },
    ]);
    expect(body.data.payoutMismatches).toBe(1);
  });

  it('returns 502 when reconciliation itself throws', async () => {
    mockReconcileOrders.mockRejectedValue(new Error('database down'));
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(502);
  });
});
