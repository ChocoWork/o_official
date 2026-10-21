import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { DeliveryOperationError, markFulfillmentDelivered } from '@/lib/orders/tracking/delivery-store';
import { createDeliveryAudit, deliveryDate, deliveryUuid, guardDeliveryAdminWrite, respondToDeliveryError } from '@/lib/orders/tracking/delivery-route-support';

const bodySchema = z.object({ requestKey: deliveryUuid, deliveredOn: z.string(), notifyCustomer: z.boolean() }).strict();
const paramsSchema = z.object({ id: deliveryUuid, fulfillmentId: deliveryUuid });

export async function POST(request: Request, { params }: { params: Promise<{ id: string; fulfillmentId: string }> }) {
  const guard = await guardDeliveryAdminWrite(request, 'delivered');
  if (!guard.ok) return guard.response;
  const routeParams = await params;
  const audit = createDeliveryAudit(request, guard.actorId, 'delivered', routeParams.id);
  try {
    const parsedParams = paramsSchema.safeParse(routeParams);
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsedParams.success || !body.success) throw new DeliveryOperationError('DELIVERY_ARGUMENT_INVALID');
    if (!deliveryDate.safeParse(body.data.deliveredOn).success) throw new DeliveryOperationError('DELIVERY_DATE_INVALID');
    const { id: orderId, fulfillmentId } = parsedParams.data;
    const result = await markFulfillmentDelivered(await createServiceRoleClient(), { ...body.data, orderId, fulfillmentId, actorId: guard.actorId });
    scheduleOrderEmailDelivery();
    await audit('success', { fulfillmentId, deliveredOn: body.data.deliveredOn, replayed: result.replayed });
    return NextResponse.json({ data: result });
  } catch (error) { return respondToDeliveryError(error, audit); }
}
