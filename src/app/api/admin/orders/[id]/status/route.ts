import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import { sendOrderShippedEmail } from '@/lib/orders/order-shipped-email';

const orderIdSchema = z.string().uuid();
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
      description: 'Order status update endpoint (cancel only)',
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
      const id = parsedOrderId.data;
      const supabase = await createServiceRoleClient();

      // 読んでから書く形にしない。status と shipped_at を条件に含めた
      // UPDATE 1本で確定させることで、同時に2回押しても発送は1回しか成立せず、
      // 通知メールも1通しか出ない。
      const { data, error } = await supabase
        .from('orders')
        .update({
          status: 'shipped',
          shipped_at: new Date().toISOString(),
          shipping_carrier: parsedBody.data.carrier,
          tracking_number: parsedBody.data.trackingNumber,
        })
        .eq('id', id)
        .eq('status', 'paid')
        .is('shipped_at', null)
        .select('id, shipping_email, shipping_full_name');

      if (error) {
        console.error('[admin.orders.status] Failed to ship order:', error);
        return NextResponse.json({ error: '発送状態の更新に失敗しました。' }, { status: 500 });
      }

      if (!data?.length) {
        await logAudit({
          action: 'admin.orders.status.update',
          actor_id: authz.userId,
          outcome: 'failure',
          resource: 'orders',
          resource_id: id,
          detail: 'not_shippable',
        });
        return NextResponse.json(
          { error: '発送できる状態ではありません。決済完了の未発送注文のみ発送できます。' },
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
        email: data[0].shipping_email,
        fullName: data[0].shipping_full_name,
        carrier: parsedBody.data.carrier,
        trackingNumber: parsedBody.data.trackingNumber,
      });

      return NextResponse.json({ success: true, status: 'shipped' }, { status: 200 });
    }

    const supabase = await createClient(request);

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('orders')
      .select('id, status')
      .eq('id', parsedOrderId.data)
      .maybeSingle<{ id: string; status: 'pending' | 'paid' | 'failed' | 'cancelled' }>();

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

    const { data: updatedOrder, error: updateError } = await supabase
      .from('orders')
      .update({ status: parsedBody.data.status })
      .eq('id', parsedOrderId.data)
      .select('id, status')
      .single<{ id: string; status: 'pending' | 'paid' | 'failed' | 'cancelled' }>();

    if (updateError || !updatedOrder) {
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
