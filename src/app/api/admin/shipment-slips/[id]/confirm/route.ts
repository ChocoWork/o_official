import 'server-only';

import { z } from 'zod';
import { expectedVersionSchema, handleShipmentSlipWrite, requestKeySchema } from '@/lib/orders/shipment-slips/shipment-slip-route';
import { confirmShipmentSlip } from '@/lib/orders/shipment-slips/shipment-slip-store';

const bodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  carrier: z.enum(['yamato', 'sagawa', 'japanpost']).nullable(),
  trackingNumber: z.string().trim().regex(/^[0-9A-Za-z-]{1,64}$/).nullable(),
  shipmentDate: z.string().date(),
  notifyCustomer: z.boolean(),
  requestKey: requestKeySchema,
}).refine((body) => (body.carrier === null) === (body.trackingNumber === null));

/** 発送票の全注文を確定する（FREQ-533）。共通窓口が認可・CSRF・制限・検証・監査の順とactorを守る。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleShipmentSlipWrite({
    request, context, label: 'POST /api/admin/shipment-slips/[id]/confirm',
    rateEndpoint: 'admin.shipment_slips.confirm', rateLimit: 60,
    auditAction: 'admin.shipment_slips.confirm', errorCode: 'SHIPMENT_SLIP_CONFIRM_FAILED',
    schema: bodySchema, status: 200,
    run: (client, actorId, slipId, body) => confirmShipmentSlip(client, actorId, { ...body, slipId: slipId as string }),
    auditSuccess: (_body, result) => ({ fulfillment_count: result.fulfillments.length, replayed: result.replayed }),
    auditFailure: () => ({}),
  });
}
