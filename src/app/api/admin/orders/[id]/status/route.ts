import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';
import { readCheckoutPayment, type CheckoutPaymentStripeClient } from '@/lib/stripe/checkout-payment-reader';
import {
  reconcileCheckoutPayment,
  ReconcileTransientError,
  type ReconcileResult,
} from '@/lib/stripe/checkout-payment-reconciler';
import { createDefaultReconcilerDeps } from '@/lib/stripe/checkout-payment-reconciler-deps';
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import { sendOrderShippedEmail } from '@/lib/orders/order-shipped-email';
import {
  ADMIN_NOTE_MAX_LENGTH,
  CANCEL_REASONS,
  PAYMENT_EXCEPTION_REASON_LABELS,
  type CancelReason,
  type OrderStatus,
} from '@/lib/orders/order-payment-types';

const orderIdSchema = z.string().uuid();

const updateStatusSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('cancelled'),
    reason: z.enum(CANCEL_REASONS),
    note: z.string().trim().max(ADMIN_NOTE_MAX_LENGTH).optional(),
    notifyCustomer: z.boolean().default(true),
  }),
  z.object({
    status: z.literal('shipped'),
    carrier: z.enum(SHIPPING_CARRIER_IDS),
    trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
  }),
]);

type CancelRequest = { reason: CancelReason; note?: string; notifyCustomer: boolean };

type CurrentOrder = {
  id: string;
  status: OrderStatus;
  payment_intent_id: string | null;
  checkout_session_id: string | null;
};

type AuditOutcome = 'success' | 'failure' | 'error' | 'conflict';
type AuditFn = (outcome: AuditOutcome, detail: string, metadata?: Record<string, unknown>) => Promise<void>;

const VOUCHER_VALID_MESSAGE = '払込票が有効な間は取り消せません。払込期限を過ぎると自動で期限切れになります。';
const STATE_CHANGED_MESSAGE = '注文の状態が変わったためキャンセルできませんでした。';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  return NextResponse.json(
    {
      endpoint: `/api/admin/orders/${id}/status`,
      method: 'POST',
      description: 'Order status update endpoint (cancel or shipped)',
      requiredBody: { status: 'cancelled', reason: CANCEL_REASONS },
    },
    { status: 200 },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await authorizeAdminPermission('admin.orders.manage', request);
    if (!authz.ok) {
      return authz.response;
    }

    const { id } = await params;
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;
    const audit: AuditFn = (outcome, detail, metadata) =>
      logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: id,
        outcome,
        detail,
        ip: clientIp,
        user_agent: userAgent,
        metadata: metadata ?? null,
      });

    const parsedOrderId = orderIdSchema.safeParse(id);
    if (!parsedOrderId.success) {
      await audit('failure', 'Invalid order id');
      return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
    }

    const parsedBody = updateStatusSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) {
      await audit('failure', 'Invalid request body');
      return NextResponse.json(
        { error: 'Invalid request body', details: parsedBody.error.flatten() },
        { status: 400 },
      );
    }

    if (parsedBody.data.status === 'shipped') {
      const serviceRoleSupabase = await createServiceRoleClient();
      const { data, error } = await serviceRoleSupabase.rpc('admin_ship_paid_order', {
        _actor_id: authz.userId,
        _order_id: parsedOrderId.data,
        _shipping_carrier: parsedBody.data.carrier,
        _tracking_number: parsedBody.data.trackingNumber,
      });

      if (error) {
        console.error('[admin.orders.status] Failed to ship order:', error);
        return NextResponse.json({ error: '発送状態の更新に失敗しました。' }, { status: 500 });
      }

      const shippedOrder = Array.isArray(data) ? data[0] : data;
      if (!shippedOrder) {
        await audit('failure', 'not_shippable');
        return NextResponse.json(
          {
            error:
              '発送できる状態ではありません。決済完了・未発送で配送先の必須項目が揃い、支払額の確認（要対応）が済んだ注文のみ発送できます。',
          },
          { status: 409 },
        );
      }

      await audit('success', 'Status changed to shipped', { status: 'shipped', carrier: parsedBody.data.carrier });

      await sendOrderShippedEmail({
        orderId: id,
        email: shippedOrder.shipping_email,
        fullName: shippedOrder.shipping_full_name,
        carrier: parsedBody.data.carrier,
        trackingNumber: parsedBody.data.trackingNumber,
      });

      return NextResponse.json({ success: true, status: 'shipped' }, { status: 200 });
    }

    const cancel: CancelRequest = {
      reason: parsedBody.data.reason,
      note: parsedBody.data.note || undefined,
      notifyCustomer: parsedBody.data.notifyCustomer,
    };
    if (cancel.reason === 'other' && !cancel.note) {
      return NextResponse.json({ error: '「その他」を選んだときはメモを入力してください。' }, { status: 400 });
    }

    const supabase = await createClient(request);
    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, status, payment_intent_id, checkout_session_id')
      .eq('id', parsedOrderId.data)
      .maybeSingle<CurrentOrder>();

    if (currentOrderError) {
      console.error('[admin.orders.status] Failed to fetch order:', currentOrderError);
      return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
    }

    if (!currentOrder) {
      await audit('failure', 'Order not found');
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (currentOrder.status === 'cancelled') {
      await audit('conflict', 'Order already cancelled');
      return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
    }

    if (currentOrder.status === 'shipped') {
      await audit('conflict', 'Order already shipped');
      return NextResponse.json({ error: '発送済みの注文はキャンセルできません。' }, { status: 409 });
    }

    if (currentOrder.status === 'paid') {
      await audit('conflict', 'Cannot cancel: order is already paid');
      return NextResponse.json(
        { error: '支払い済みの注文は返金処理を伴わずキャンセルできません。' },
        { status: 409 },
      );
    }

    if (currentOrder.status === 'abandoned') {
      await audit('conflict', 'Cannot cancel: order is abandoned');
      return NextResponse.json({ error: '放棄された注文は取り消せません。' }, { status: 409 });
    }

    if (currentOrder.status === 'failed') {
      return cancelFailedOrder(currentOrder, cancel, authz.userId, audit);
    }

    return cancelUnpaidOrder(currentOrder, cancel, authz.userId, audit);
  } catch (error) {
    console.error('POST /api/admin/orders/:id/status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** 失敗 → 取消。在庫は戻し済み。お客様には送らない（期限切れで知らせ済み） */
async function cancelFailedOrder(
  order: CurrentOrder,
  cancel: CancelRequest,
  actorId: string,
  audit: AuditFn,
): Promise<Response> {
  const serviceRoleSupabase = await createServiceRoleClient();
  const { data, error } = await serviceRoleSupabase.rpc('admin_cancel_failed_order', {
    _order_id: order.id,
    _actor_id: actorId,
    _cancel_reason: cancel.reason,
    _note: cancel.note ?? null,
  });

  if (error) {
    console.error('[admin.orders.status] Failed to cancel failed order:', error);
    await audit('error', 'Failed to update order status');
    return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
  }

  const updated = Array.isArray(data) ? data[0] : data;
  if (!updated) {
    await audit('conflict', 'Order state changed before failed-order cancellation could be applied');
    return NextResponse.json({ error: STATE_CHANGED_MESSAGE }, { status: 409 });
  }

  await audit('success', 'Status changed to cancelled', { from: 'failed', to: 'cancelled', cancel_reason: cancel.reason });
  return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
}

/**
 * 支払い手続き中・入金待ち → 取消（設計書 3-2・5-2、R-18）。
 * 支払い手続き中は開いている決済を先に失効させる（Checkout の PaymentIntent は直接 cancel できない）。
 * 入金待ちは払込票が有効な間は取り消さない。どちらも最後は照合関数が Stripe の現在値で決める。
 */
async function cancelUnpaidOrder(
  order: CurrentOrder,
  cancel: CancelRequest,
  actorId: string,
  audit: AuditFn,
): Promise<Response> {
  const stripe = getStripeServerClient();

  try {
    if (order.status === 'payment_in_progress') {
      if (order.checkout_session_id) {
        await expireOpenCheckoutSession(stripe, order.checkout_session_id);
      }
    } else {
      const snapshot = await readCheckoutPayment(stripe as unknown as CheckoutPaymentStripeClient, {
        checkoutSessionId: order.checkout_session_id,
        paymentIntentId: order.payment_intent_id,
      });
      if (snapshot.state.kind === 'awaiting_payment') {
        const cancelBlockedUntil = snapshot.voucherExpiresAt?.toISOString() ?? null;
        await audit('conflict', 'Cannot cancel: payment voucher is still valid', { voucher_expires_at: cancelBlockedUntil });
        return NextResponse.json({ error: VOUCHER_VALID_MESSAGE, cancelBlockedUntil }, { status: 409 });
      }
    }

    const result = await reconcileCheckoutPayment(await createDefaultReconcilerDeps(), {
      checkoutSessionId: order.checkout_session_id,
      paymentIntentId: order.payment_intent_id,
      adminCancel: { actorId, reason: cancel.reason, note: cancel.note, notifyCustomer: cancel.notifyCustomer },
    });
    return respondToCancelResult(result, order, cancel, audit);
  } catch (error) {
    if (error instanceof ReconcileTransientError) {
      await audit('error', 'Cannot cancel: Stripe or database is temporarily unavailable', { reason: error.code });
      return NextResponse.json(
        { error: 'Stripe の状態を確認できませんでした。時間をおいて再試行してください。' },
        { status: 503 },
      );
    }

    console.error('[admin.orders.status] Failed to cancel unpaid order:', error);
    await audit('error', 'Failed to terminate Stripe Checkout payment');
    return NextResponse.json({ error: 'Stripe 決済のキャンセルに失敗しました。' }, { status: 500 });
  }
}

async function respondToCancelResult(
  result: ReconcileResult,
  order: CurrentOrder,
  cancel: CancelRequest,
  audit: AuditFn,
): Promise<Response> {
  if (result.kind === 'needs_action') {
    await audit('conflict', 'Cannot cancel: payment needs action', { exception_reason: result.reason });
    return NextResponse.json(
      {
        error: `要対応として記録しました（${PAYMENT_EXCEPTION_REASON_LABELS[result.reason]}）。ORDER タブの要対応から対応してください。`,
      },
      { status: 409 },
    );
  }

  if (result.orderStatus === 'cancelled') {
    await audit('success', 'Status changed to cancelled', {
      from: order.status,
      to: 'cancelled',
      cancel_reason: cancel.reason,
      notify_customer: cancel.notifyCustomer,
    });
    return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
  }

  if (result.orderStatus === 'paid' || result.orderStatus === 'shipped') {
    await audit('conflict', 'Cannot cancel: payment completed', { order_status: result.orderStatus });
    return NextResponse.json(
      { error: '支払いが完了したためキャンセルできません。返金は別の操作で行ってください。' },
      { status: 409 },
    );
  }

  if (result.orderStatus === 'pending') {
    await audit('conflict', 'Cannot cancel: payment voucher was issued');
    return NextResponse.json({ error: VOUCHER_VALID_MESSAGE }, { status: 409 });
  }

  await audit('conflict', 'Order state changed before cancellation could be applied', { order_status: result.orderStatus });
  return NextResponse.json({ error: STATE_CHANGED_MESSAGE }, { status: 409 });
}
