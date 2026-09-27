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
  createServiceRoleClient: jest.fn(),
}));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));
jest.mock('@/lib/stripe/order-refund-sync', () => ({ syncOrderRefunds: jest.fn() }));

import Stripe from 'stripe';
import { POST } from '@/app/api/admin/orders/[id]/refund/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { syncOrderRefunds } from '@/lib/stripe/order-refund-sync';

const authorize = authorizeAdminPermission as jest.MockedFunction<typeof authorizeAdminPermission>;
const createSupabase = createClient as jest.MockedFunction<typeof createClient>;
const createServiceSupabase = createServiceRoleClient as jest.MockedFunction<typeof createServiceRoleClient>;
const getStripe = getStripeServerClient as jest.MockedFunction<typeof getStripeServerClient>;
const syncRefunds = syncOrderRefunds as jest.MockedFunction<typeof syncOrderRefunds>;

describe('POST /api/admin/orders/[id]/refund', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createServiceSupabase.mockResolvedValue({ rpc: jest.fn() } as never);
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
        id: '11111111-1111-4111-8111-111111111111',
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
    syncRefunds.mockResolvedValue({
      orderId: '11111111-1111-4111-8111-111111111111',
      refundedAmount: 0,
      orderStatus: 'paid',
    });

    const response = await POST(
      new Request('http://localhost/api/admin/orders/11111111-1111-4111-8111-111111111111/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'requested_by_customer' }),
      }),
      { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(syncRefunds).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-1',
      database: expect.objectContaining({ rpc: expect.any(Function) }),
      paymentIntentId: 'pi_konbini',
    }));
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
        id: '11111111-1111-4111-8111-111111111111',
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
    syncRefunds.mockResolvedValue({
      orderId: '11111111-1111-4111-8111-111111111111',
      refundedAmount: 21_499,
      orderStatus: 'cancelled',
    });

    const response = await POST(
      new Request('http://localhost/api/admin/orders/11111111-1111-4111-8111-111111111111/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'requested_by_customer' }),
      }),
      { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
    );

    expect(response.status).toBe(200);
    expect(syncRefunds).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-1',
      paymentIntentId: 'pi_shipped',
    }));
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
        id: '11111111-1111-4111-8111-111111111111',
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
      new Request('http://localhost/api/admin/orders/11111111-1111-4111-8111-111111111111/refund', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'requested_by_customer' }),
      }),
      { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Stripe返金処理に失敗しました。' });
    expect(JSON.stringify(body)).not.toContain('pi_sensitive_identifier');
  });

});
