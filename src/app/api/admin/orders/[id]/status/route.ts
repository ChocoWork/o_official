import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getStripeServerClient } from '@/lib/stripe/server';
import {
  expireCheckoutSessionForPaymentIntent,
  isPendingCheckoutPaymentIntentStatus,
} from '@/lib/stripe/checkout-session-expiry';
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import { sendOrderShippedEmail } from '@/lib/orders/order-shipped-email';

const orderIdSchema = z.string().uuid();

function isResourceMissingError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'resource_missing',
  );
}

const updateStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  z.object({
    status: z.literal('shipped'),
    carrier: z.enum(SHIPPING_CARRIER_IDS),
    trackingNumber: z.string().trim().min(1).max(64).regex(/^[0-9A-Za-z-]+$/),
  }),
]);

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
      requiredBody: { status: 'cancelled' },
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
    const parsedOrderId = orderIdSchema.safeParse(id);
    if (!parsedOrderId.success) {
      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: id,
        outcome: 'failure',
        detail: 'Invalid order id',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
    }

    const parsedBody = updateStatusSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsedBody.success) {
      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: parsedOrderId.data,
        outcome: 'failure',
        detail: 'Invalid request body',
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
        await logAudit({
          action: 'admin.orders.status.update',
          actor_id: authz.userId,
          outcome: 'failure',
          resource: 'orders',
          resource_id: id,
          detail: 'not_shippable',
        });
        return NextResponse.json(
          { error: '発送できる状態ではありません。決済完了・未発送で配送先の必須項目が揃った注文のみ発送できます。' },
          { status: 409 },
        );
      }

      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        outcome: 'success',
        resource: 'orders',
        resource_id: id,
        metadata: { status: 'shipped', carrier: parsedBody.data.carrier },
      });

      await sendOrderShippedEmail({
        orderId: id,
        email: shippedOrder.shipping_email,
        fullName: shippedOrder.shipping_full_name,
        carrier: parsedBody.data.carrier,
        trackingNumber: parsedBody.data.trackingNumber,
      });

      return NextResponse.json({ success: true, status: 'shipped' }, { status: 200 });
    }

    const supabase = await createClient(request);

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, status, payment_intent_id, checkout_session_id')
      .eq('id', parsedOrderId.data)
      .maybeSingle<{
        id: string;
        status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'shipped';
        payment_intent_id: string | null;
        checkout_session_id: string | null;
      }>();

    if (currentOrderError) {
      console.error('[admin.orders.status] Failed to fetch order:', currentOrderError);
      return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
    }

    if (!currentOrder) {
      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: parsedOrderId.data,
        outcome: 'failure',
        detail: 'Order not found',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    if (currentOrder.status === 'cancelled') {
      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: parsedOrderId.data,
        outcome: 'conflict',
        detail: 'Order already cancelled',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
    }

    if (currentOrder.status === 'shipped') {
      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: parsedOrderId.data,
        outcome: 'conflict',
        detail: 'Order already shipped',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json(
        { error: '発送済みの注文はキャンセルできません。' },
        { status: 409 },
      );
    }

    // pending の注文をキャンセルする場合、在庫は既に引き当て済みで PaymentIntent も
    // 生きているため、status を直接書き換えるだけでは在庫が永久に戻らず、コンビニ払込票も
    // 支払い可能なまま残ってしまう（レビュー指摘 C2）。release_stock_for_unpaid_order に
    // _next_status: 'cancelled' を渡し、在庫復元とステータス遷移を1つのRPCで完結させる。
    if (currentOrder.status === 'pending') {
      const paymentIntentId = currentOrder.payment_intent_id;

      if (!paymentIntentId) {
        console.error('[admin.orders.status] pending order has no payment_intent_id', parsedOrderId.data);
        await logAudit({
          action: 'admin.orders.status.update',
          actor_id: authz.userId,
          resource: 'orders',
          resource_id: parsedOrderId.data,
          outcome: 'error',
          detail: 'Pending order has no payment_intent_id',
          ip: clientIp,
          user_agent: userAgent,
        });
        return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
      }

      let stripeTerminalState:
        | { kind: 'payment_intent_canceled' }
        | {
            kind: 'checkout_session_expired';
            sessionId: string;
            expiredNow: boolean;
          };

      try {
        const stripe = getStripeServerClient();
        let paymentIntentStatus: string;

        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          paymentIntentStatus = paymentIntent.status;
        } catch (retrieveError) {
          if (!isResourceMissingError(retrieveError)) {
            throw retrieveError;
          }

          // resource_missing は「IDが存在しない、または別種別のID」という取得失敗であり、
          // 未入金を示す決済状態ではない。状態を検証できない限り、Session の状態だけで
          // 注文キャンセルや在庫解放へ進めない。
          await logAudit({
            action: 'admin.orders.status.update',
            actor_id: authz.userId,
            resource: 'orders',
            resource_id: parsedOrderId.data,
            outcome: 'conflict',
            detail: 'Cannot cancel: payment intent could not be verified',
            ip: clientIp,
            user_agent: userAgent,
            metadata: { stripe_error_code: 'resource_missing' },
          });
          return NextResponse.json(
            { error: 'Stripe 上の決済状態を確認できないためキャンセルできません。' },
            { status: 409 },
          );
        }

        if (paymentIntentStatus === 'succeeded') {
          await logAudit({
            action: 'admin.orders.status.update',
            actor_id: authz.userId,
            resource: 'orders',
            resource_id: parsedOrderId.data,
            outcome: 'conflict',
            detail: 'Cannot cancel: payment intent already succeeded',
            ip: clientIp,
            user_agent: userAgent,
            metadata: { payment_intent_status: paymentIntentStatus },
          });
          return NextResponse.json(
            { error: '支払いが完了しているためキャンセルできません。返金は別の操作で行ってください。' },
            { status: 409 },
          );
        }

        // processing はコンビニ払込・銀行振込では入金済みを意味し得る。
        // async_payment_succeeded より先に在庫を戻さない。
        if (paymentIntentStatus === 'processing') {
          await logAudit({
            action: 'admin.orders.status.update',
            actor_id: authz.userId,
            resource: 'orders',
            resource_id: parsedOrderId.data,
            outcome: 'conflict',
            detail: 'Cannot cancel: payment intent is processing',
            ip: clientIp,
            user_agent: userAgent,
            metadata: { payment_intent_status: paymentIntentStatus },
          });
          return NextResponse.json(
            { error: '支払いが処理中のためキャンセルできません。返金は別の操作で行ってください。' },
            { status: 409 },
          );
        }

        if (paymentIntentStatus === 'canceled') {
          stripeTerminalState = { kind: 'payment_intent_canceled' };
        } else {
          if (!isPendingCheckoutPaymentIntentStatus(paymentIntentStatus)) {
            await logAudit({
              action: 'admin.orders.status.update',
              actor_id: authz.userId,
              resource: 'orders',
              resource_id: parsedOrderId.data,
              outcome: 'conflict',
              detail: 'Cannot cancel: unsupported payment intent status',
              ip: clientIp,
              user_agent: userAgent,
              metadata: { payment_intent_status: paymentIntentStatus },
            });
            return NextResponse.json(
              { error: 'Stripe 上の決済状態を確認できないためキャンセルできません。' },
              { status: 409 },
            );
          }

          const expiry = await expireCheckoutSessionForPaymentIntent({
            stripe,
            paymentIntentId,
            checkoutSessionId: currentOrder.checkout_session_id,
          });

          if (expiry.outcome !== 'expired') {
            await logAudit({
              action: 'admin.orders.status.update',
              actor_id: authz.userId,
              resource: 'orders',
              resource_id: parsedOrderId.data,
              outcome: 'conflict',
              detail: expiry.outcome === 'blocked'
                ? 'Cannot cancel: checkout session is not expireable'
                : 'Cannot cancel: checkout session could not be verified',
              ip: clientIp,
              user_agent: userAgent,
              metadata: {
                payment_intent_status: paymentIntentStatus,
                checkout_session_id: expiry.sessionId,
                checkout_session_status:
                  expiry.outcome === 'blocked' ? expiry.sessionStatus : null,
                checkout_payment_status:
                  expiry.outcome === 'blocked' ? expiry.paymentStatus : null,
                reason: expiry.outcome === 'unavailable' ? expiry.reason : null,
              },
            });
            return NextResponse.json(
              {
                error:
                  '決済が完了または処理中、もしくはStripe上の決済状態を確認できないためキャンセルできません。',
              },
              { status: 409 },
            );
          }

          stripeTerminalState = {
            kind: 'checkout_session_expired',
            sessionId: expiry.sessionId,
            expiredNow: expiry.expiredNow,
          };
        }
      } catch (stripeError) {
        console.error('[admin.orders.status] Failed to terminate Checkout payment:', stripeError);
        await logAudit({
          action: 'admin.orders.status.update',
          actor_id: authz.userId,
          resource: 'orders',
          resource_id: parsedOrderId.data,
          outcome: 'error',
          detail: 'Failed to terminate Stripe Checkout payment',
          ip: clientIp,
          user_agent: userAgent,
        });
        return NextResponse.json({ error: 'Stripe 決済のキャンセルに失敗しました。' }, { status: 500 });
      }

      const serviceRoleSupabase = await createServiceRoleClient();
      const { data: releaseData, error: releaseError } = await serviceRoleSupabase.rpc(
        'release_stock_for_unpaid_order',
        { _payment_intent_id: paymentIntentId, _next_status: 'cancelled' },
      );

      if (releaseError) {
        console.error('[admin.orders.status] Failed to release stock for cancelled order:', releaseError);
        await logAudit({
          action: 'admin.orders.status.update',
          actor_id: authz.userId,
          resource: 'orders',
          resource_id: parsedOrderId.data,
          outcome: 'error',
          detail: 'Failed to release stock while cancelling order',
          ip: clientIp,
          user_agent: userAgent,
        });
        return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
      }

      const releaseRow = Array.isArray(releaseData) ? releaseData[0] : releaseData;

      if (releaseRow?.released !== true) {
        // 読み取りと RPC の間に注文の状態が変わった（例: 直前に paid になった）。
        // 在庫もステータスも変更されていないので success を返してはいけない。
        await logAudit({
          action: 'admin.orders.status.update',
          actor_id: authz.userId,
          resource: 'orders',
          resource_id: parsedOrderId.data,
          outcome: 'conflict',
          detail: 'Order state changed before cancellation could be applied',
          ip: clientIp,
          user_agent: userAgent,
          metadata: {
            from: currentOrder.status,
            stripe_terminal_state: stripeTerminalState.kind,
            checkout_session_id:
              stripeTerminalState.kind === 'checkout_session_expired'
                ? stripeTerminalState.sessionId
                : null,
            stock_released: false,
          },
        });
        return NextResponse.json(
          { error: '注文の状態が変わったためキャンセルできませんでした。' },
          { status: 409 },
        );
      }

      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: parsedOrderId.data,
        outcome: 'success',
        detail: 'Status changed to cancelled',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          from: currentOrder.status,
          to: 'cancelled',
          stripe_terminal_state: stripeTerminalState.kind,
          checkout_session_id:
            stripeTerminalState.kind === 'checkout_session_expired'
              ? stripeTerminalState.sessionId
              : null,
          checkout_session_expired_now:
            stripeTerminalState.kind === 'checkout_session_expired'
              ? stripeTerminalState.expiredNow
              : false,
          stock_released: true,
        },
      });

      return NextResponse.json({ success: true, status: 'cancelled' }, { status: 200 });
    }

    if (currentOrder.status === 'paid') {
      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: parsedOrderId.data,
        outcome: 'conflict',
        detail: 'Cannot cancel: order is already paid',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json(
        { error: '支払い済みの注文は返金処理を伴わずキャンセルできません。' },
        { status: 409 },
      );
    }

    // failed -> cancelled は専用RPC内の条件付きUPDATEで原子的に確定する。
    const serviceRoleSupabase = await createServiceRoleClient();
    const { data: cancelledData, error: updateError } = await serviceRoleSupabase.rpc(
      'admin_cancel_failed_order',
      { _actor_id: authz.userId, _order_id: parsedOrderId.data },
    );

    if (updateError) {
      console.error('[admin.orders.status] Failed to update order status:', updateError);
      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: parsedOrderId.data,
        outcome: 'error',
        detail: 'Failed to update order status',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Failed to update order status' }, { status: 500 });
    }

    const updatedOrder = Array.isArray(cancelledData) ? cancelledData[0] : cancelledData;
    if (!updatedOrder) {
      await logAudit({
        action: 'admin.orders.status.update',
        actor_id: authz.userId,
        resource: 'orders',
        resource_id: parsedOrderId.data,
        outcome: 'conflict',
        detail: 'Order state changed before failed-order cancellation could be applied',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json(
        { error: '注文の状態が変わったためキャンセルできませんでした。' },
        { status: 409 },
      );
    }

    await logAudit({
      action: 'admin.orders.status.update',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: updatedOrder.id,
      outcome: 'success',
      detail: `Status changed to ${updatedOrder.status}`,
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        from: currentOrder.status,
        to: updatedOrder.status,
      },
    });

    return NextResponse.json({ success: true, status: updatedOrder.status }, { status: 200 });
  } catch (error) {
    console.error('POST /api/admin/orders/:id/status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
