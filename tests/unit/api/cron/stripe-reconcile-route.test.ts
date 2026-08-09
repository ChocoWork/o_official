jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));
jest.mock('@/lib/stripe/reconcile-orders', () => ({ reconcileStripeOrders: jest.fn() }));

import { GET } from '@/app/api/cron/stripe-reconcile/route';
import { reconcileStripeOrders } from '@/lib/stripe/reconcile-orders';

describe('GET /api/cron/stripe-reconcile', () => {
  beforeEach(() => { process.env.CRON_SECRET = 'cron-secret'; });
  afterEach(() => { delete process.env.CRON_SECRET; });

  it('rejects requests without the cron bearer token', async () => {
    const response = await GET(new Request('http://localhost/api/cron/stripe-reconcile'));
    expect(response.status).toBe(401);
    expect(reconcileStripeOrders).not.toHaveBeenCalled();
  });
});
