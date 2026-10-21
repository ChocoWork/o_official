import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { SHIPPING_CARRIER_IDS } from '@/lib/orders/shipping-carriers';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { scheduleDeliveryTracking } from '@/lib/orders/tracking/delivery-schedule';
import { DeliveryOperationError, updateFulfillmentTracking } from '@/lib/orders/tracking/delivery-store';
import { createDeliveryAudit, deliveryUuid, guardDeliveryAdminWrite, respondToDeliveryError } from '@/lib/orders/tracking/delivery-route-support';

const bodySchema = z.object({
  requestKey: deliveryUuid, carrier: z.enum(SHIPPING_CARRIER_IDS),
  trackingNumber: z.string().trim().regex(/^[0-9A-Za-z-]{1,64}$/), notifyCustomer: z.boolean(),
}).strict();
const paramsSchema = z.object({ id: deliveryUuid, fulfillmentId: deliveryUuid });

export async function POST(request: Request, { params }: { params: Promise<{ id: string; fulfillmentId: string }> }) {
  const guard = await guardDeliveryAdminWrite(request, 'tracking');
  if (!guard.ok) return guard.response;
  const routeParams = await params;
  const audit = createDeliveryAudit(request, guard.actorId, 'tracking', routeParams.id);
  try {
    const parsedParams = paramsSchema.safeParse(routeParams);
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsedParams.success || !body.success) throw new DeliveryOperationError('DELIVERY_ARGUMENT_INVALID');
    const { id: orderId, fulfillmentId } = parsedParams.data;
    const result = await updateFulfillmentTracking(await createServiceRoleClient(), { ...body.data, orderId, fulfillmentId, actorId: guard.actorId });
    scheduleOrderEmailDelivery();
    scheduleDeliveryTracking();
    await audit('success', { fulfillmentId, trackingVersion: result.trackingVersion, carrier: body.data.carrier,
      trackingNumber: body.data.trackingNumber, notifyCustomer: body.data.notifyCustomer, replayed: result.replayed });
    return NextResponse.json({ data: result });
  } catch (error) { return respondToDeliveryError(error, audit); }
}
