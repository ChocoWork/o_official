jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(),
}));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));
jest.mock('@/lib/stripe/order-refund-sync', () => ({ syncPaymentIntentRefunds: jest.fn() }));
const mockRefundDeps = { name: 'refund-service-deps' };
jest.mock('@/lib/orders/refund/refund-service', () => ({
  createDefaultRefundServiceDeps: async () => mockRefundDeps,
}));

import Stripe from 'stripe';
import { POST } from '@/app/api/admin/orders/[id]/refund/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { syncPaymentIntentRefunds } from '@/lib/stripe/order-refund-sync';

const authorize = authorizeAdminPermission as jest.MockedFunction<typeof authorizeAdminPermission>;
const createSupabase = createClient as jest.MockedFunction<typeof createClient>;
const getStripe = getStripeServerClient as jest.MockedFunction<typeof getStripeServerClient>;
const syncRefunds = syncPaymentIntentRefunds as jest.MockedFunction<typeof syncPaymentIntentRefunds>;

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

/** 取り込みの答え。返金の記録を1件書いて、注文がその状態になった */
function syncedWith(orderStatus: 'paid' | 'cancelled', refundedAmount: number) {
  return {
    kind: 'synced' as const,
    orderId: ORDER_ID,
    orderStatus,
    results: [
      {
        refundId: '22222222-2222-4222-8222-222222222222',
        orderId: ORDER_ID,
        status: 'succeeded' as const,
        newlyAccepted: true,
        newlyFailed: false,
        orderStatus,
        refundedAmount,
        rereserveShortage: 0,
        emailEnqueued: false,
        exceptionId: null,
      },
    ],
  };
}

describe('POST /api/admin/orders/[id]/refund', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not cancel an order while a Konbini refund requires action', async () => {
    authorize.mockResolvedValue({
      ok: true,
      userId: 'admin-1',
      role: 'admin',
      actorEmail: 'admin@example.com',
    });
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: ORDER_ID,
        payment_intent_id: 'pi_konbini',
        status: 'paid',
        total_amount: 21_499,
      },
      error: null,
    });
    const from = jest.fn().mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      update: jest.fn().mockReturnValue({ eq: jest.fn() }),
    });
    createSupabase.mockResolvedValue({ from } as never);
    const refundCreate = jest.fn().mockResolvedValue({
      id: 're_konbini',
      amount: 21_499,
      currency: 'jpy',
      reason: 'requested_by_customer',
      status: 'requires_action',
    });
    getStripe.mockReturnValue({ refunds: { create: refundCreate } } as never);
    syncRefunds.mockResolvedValue({ kind: 'synced', orderId: ORDER_ID, orderStatus: 'paid', results: [] });

    const response = await POST(
      new Request(`http://localhost/api/admin/orders/${ORDER_ID}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'requested_by_customer' }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(syncRefunds).toHaveBeenCalledWith(mockRefundDeps, 'pi_konbini');
    expect(body.orderStatus).toBe('paid');
    expect(body.refundStatus).toBe('requires_action');
  });

  it('allows a shipped order to be refunded without changing it locally', async () => {
    authorize.mockResolvedValue({
      ok: true,
      userId: 'admin-1',
      role: 'admin',
      actorEmail: 'admin@example.com',
    });
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: ORDER_ID,
        payment_intent_id: 'pi_shipped',
        status: 'shipped',
        total_amount: 21_499,
      },
      error: null,
    });
    createSupabase.mockResolvedValue({
      from: jest.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    } as never);
    getStripe.mockReturnValue({
      refunds: {
        create: jest.fn().mockResolvedValue({
          id: 're_shipped',
          amount: 21_499,
          currency: 'jpy',
          reason: 'requested_by_customer',
          status: 'succeeded',
        }),
      },
    } as never);
    syncRefunds.mockResolvedValue(syncedWith('cancelled', 21_499));

    const response = await POST(
      new Request(`http://localhost/api/admin/orders/${ORDER_ID}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'requested_by_customer' }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) },
    );

    expect(response.status).toBe(200);
    expect(syncRefunds).toHaveBeenCalledWith(mockRefundDeps, 'pi_shipped');
  });

  it('does not expose Stripe error details to the client', async () => {
    authorize.mockResolvedValue({
      ok: true,
      userId: 'admin-1',
      role: 'admin',
      actorEmail: 'admin@example.com',
    });
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: ORDER_ID,
        payment_intent_id: 'pi_sensitive_identifier',
        status: 'paid',
        total_amount: 21_499,
      },
      error: null,
    });
    createSupabase.mockResolvedValue({
      from: jest.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    } as never);
    getStripe.mockReturnValue({
      refunds: {
        create: jest.fn().mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({
          type: 'invalid_request_error',
          message: 'No such PaymentIntent: pi_sensitive_identifier',
          statusCode: 400,
        })),
      },
    } as never);

    const response = await POST(
      new Request(`http://localhost/api/admin/orders/${ORDER_ID}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'requested_by_customer' }),
      }),
      { params: Promise.resolve({ id: ORDER_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Stripe返金処理に失敗しました。' });
    expect(JSON.stringify(body)).not.toContain('pi_sensitive_identifier');
  });
});
