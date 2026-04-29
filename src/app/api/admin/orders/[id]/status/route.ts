import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const orderIdSchema = z.string().uuid();
const updateStatusSchema = z.object({
  status: z.enum(['cancelled']),
});

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
