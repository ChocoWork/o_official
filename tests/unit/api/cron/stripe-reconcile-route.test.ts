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

import * as reconcileRoute from '@/app/api/cron/stripe-reconcile/route';
import { reconcileStripeOrders, reconcileStripePayouts } from '@/lib/stripe/reconcile-orders';

const mockReconcileOrders = reconcileStripeOrders as jest.Mock;
const mockReconcilePayouts = reconcileStripePayouts as jest.Mock;
const { POST } = reconcileRoute;
// 定期処理の合言葉は32文字以上（設計書 2026-10-05 グループ B の 4-3）
const CRON_SECRET = 'cron-secret-for-unit-tests-0123456789';

function authorizedRequest(): Request {
  return new Request('http://localhost/api/cron/stripe-reconcile', {
    method: 'POST',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

describe('POST /api/cron/stripe-reconcile', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    jest.clearAllMocks();
  });
  afterEach(() => { delete process.env.CRON_SECRET; });

  it('rejects requests without the cron bearer token', async () => {
    const response = await POST(new Request('http://localhost/api/cron/stripe-reconcile', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(reconcileStripeOrders).not.toHaveBeenCalled();
  });

  it('rejects a CRON_SECRET shorter than 32 characters even when the header matches', async () => {
    process.env.CRON_SECRET = 'short-secret';
    const response = await POST(new Request('http://localhost/api/cron/stripe-reconcile', {
      method: 'POST',
      headers: { authorization: 'Bearer short-secret' },
    }));
    expect(response.status).toBe(401);
    expect(reconcileStripeOrders).not.toHaveBeenCalled();
  });

  it('is called with POST only (pg_net sends POST)', () => {
    expect('GET' in reconcileRoute).toBe(false);
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

    const response = await POST(authorizedRequest());
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

    const body = await (await POST(authorizedRequest())).json();

    expect(body.data.errors).toEqual([
      { sourceId: 'pi_1', reason: 'stripe unavailable' },
      { sourceId: 'po_1', reason: 'payout sync failed' },
    ]);
    expect(body.data.payoutMismatches).toBe(1);
  });

  it('returns 502 when reconciliation itself throws', async () => {
    mockReconcileOrders.mockRejectedValue(new Error('database down'));
    mockReconcilePayouts.mockResolvedValue({ syncedPayouts: 0, payoutMismatches: 0, errors: [] });

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(502);
  });
});
