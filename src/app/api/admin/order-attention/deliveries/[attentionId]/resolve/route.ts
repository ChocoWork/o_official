import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import { DeliveryOperationError, resolveDeliveryAttention } from '@/lib/orders/tracking/delivery-store';
import { createDeliveryAudit, deliveryUuid, guardDeliveryAdminWrite, respondToDeliveryError } from '@/lib/orders/tracking/delivery-route-support';

const bodySchema = z.object({}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ attentionId: string }> }) {
  const guard = await guardDeliveryAdminWrite(request, 'resolve');
  if (!guard.ok) return guard.response;
  const { attentionId } = await params;
  const audit = createDeliveryAudit(request, guard.actorId, 'resolve', attentionId);
  try {
    if (!deliveryUuid.safeParse(attentionId).success || !bodySchema.safeParse(await request.json().catch(() => null)).success) {
      throw new DeliveryOperationError('DELIVERY_ARGUMENT_INVALID');
    }
    const result = await resolveDeliveryAttention(await createServiceRoleClient(), { attentionId, actorId: guard.actorId });
    scheduleOrderEmailDelivery();
    await audit('success', { attentionId, outcome: result.outcome });
    return NextResponse.json({ data: result });
  } catch (error) { return respondToDeliveryError(error, audit); }
}
