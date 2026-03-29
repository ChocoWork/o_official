import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { getStripeServerClient } from '@/lib/stripe/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

const orderIdSchema = z.string().uuid();
const refundRequestSchema = z.object({
  amount: z.coerce.number().int().positive().optional(),
  reason: z.enum(['requested_by_customer', 'duplicate', 'fraudulent']).default('requested_by_customer'),
});

type OrderLookupRow = {
  id: string;
  payment_intent_id: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  total_amount: number;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let actorId: string | null = null;
  let orderIdForAudit: string | null = null;

  try {
    const authz = await authorizeAdminPermission('admin.orders.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    actorId = authz.userId;

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const { id } = await params;
    const parsedOrderId = orderIdSchema.safeParse(id);
    if (!parsedOrderId.success) {
      await logAudit({
        action: 'admin.orders.refund.create',
        actor_id: actorId,
        resource: 'orders',
        resource_id: id,
        outcome: 'failure',
        detail: 'Invalid order id',
        ip: clientIp,
        user_agent: userAgent,
      });

      return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
    }

    orderIdForAudit = parsedOrderId.data;

    const parsedBody = refundRequestSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) {
      await logAudit({
        action: 'admin.orders.refund.create',
        actor_id: actorId,
        resource: 'orders',
        resource_id: orderIdForAudit,
        outcome: 'failure',
        detail: 'Invalid refund request body',
        ip: clientIp,
        user_agent: userAgent,
      });

      return NextResponse.json(
        {
          error: 'Invalid request body',
          details: parsedBody.error.flatten(),
        },
        { status: 400 },
      );
    }

    const supabase = await createServiceRoleClient();

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, payment_intent_id, status, total_amount')
      .eq('id', orderIdForAudit)
      .maybeSingle<OrderLookupRow>();

    if (orderError) {
      console.error('[admin.orders.refund] Failed to fetch order:', orderError);
      return NextResponse.json({ error: 'Failed to process refund' }, { status: 500 });
    }

    if (!order) {
      await logAudit({
        action: 'admin.orders.refund.create',
        actor_id: actorId,
        resource: 'orders',
        resource_id: orderIdForAudit,
        outcome: 'failure',
        detail: 'Order not found',
        ip: clientIp,
        user_agent: userAgent,
      });

      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (!order.payment_intent_id.startsWith('pi_')) {
      await logAudit({
        action: 'admin.orders.refund.create',
        actor_id: actorId,
        resource: 'orders',
        resource_id: order.id,
        outcome: 'failure',
        detail: 'Order is not paid by Stripe PaymentIntent',
        ip: clientIp,
        user_agent: userAgent,
      });

      return NextResponse.json({ error: 'Stripe決済注文のみ返金できます。' }, { status: 400 });
    }

    if (order.status !== 'paid') {
      await logAudit({
        action: 'admin.orders.refund.create',
        actor_id: actorId,
        resource: 'orders',
        resource_id: order.id,
        outcome: 'conflict',
        detail: `Order is not refundable. Current status: ${order.status}`,
        ip: clientIp,
        user_agent: userAgent,
      });

      return NextResponse.json({ error: '決済完了の注文のみ返金できます。' }, { status: 409 });
    }

    const refundAmount = parsedBody.data.amount;

    if (refundAmount && refundAmount > order.total_amount) {
      return NextResponse.json({ error: '返金金額が注文金額を超えています。' }, { status: 400 });
    }

    const stripe = getStripeServerClient();

    const idempotencyKey = `admin-refund:${order.id}:${refundAmount ?? 'full'}`;

    const refund = await stripe.refunds.create(
      {
        payment_intent: order.payment_intent_id,
        amount: refundAmount,
        reason: parsedBody.data.reason,
        metadata: {
          order_id: order.id,
          actor_id: actorId,
        },
      },
      { idempotencyKey },
    );

    const isFullRefund = (refund.amount ?? 0) >= order.total_amount;

    if (isFullRefund) {
      await supabase.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
    }

    await logAudit({
      action: 'admin.orders.refund.create',
      actor_id: actorId,
      resource: 'orders',
      resource_id: order.id,
      outcome: 'success',
      detail: `Stripe refund created: ${refund.id}`,
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        payment_intent_id: order.payment_intent_id,
        refund_id: refund.id,
        amount: refund.amount,
        currency: refund.currency,
        reason: refund.reason,
        full_refund: isFullRefund,
      },
    });

    return NextResponse.json(
      {
        success: true,
        refundId: refund.id,
        refundAmount: refund.amount,
        currency: refund.currency,
        orderStatus: isFullRefund ? 'cancelled' : order.status,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        {
          error: error.message || 'Stripe返金処理に失敗しました。',
        },
        { status: error.statusCode ?? 400 },
      );
    }

    console.error('POST /api/admin/orders/:id/refund error:', error);

    await logAudit({
      action: 'admin.orders.refund.create',
      actor_id: actorId,
      resource: 'orders',
      resource_id: orderIdForAudit,
      outcome: 'error',
      detail: error instanceof Error ? error.message : 'Unexpected refund error',
    });

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
