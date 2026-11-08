import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { scheduleAccountingPosting } from '@/lib/accounting/posting-runner';
import { getSlipDisputeHolds } from '@/lib/accounting/posting-store';
import { DISPUTE_HOLD_CODE, DISPUTE_HOLD_MESSAGE } from '@/lib/orders/shipment-slips/shipment-slip-notice';
import { expectedVersionSchema, handleShipmentSlipWrite, requestKeySchema } from '@/lib/orders/shipment-slips/shipment-slip-route';
import { ShipmentSlipError, confirmShipmentSlip } from '@/lib/orders/shipment-slips/shipment-slip-store';

const bodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  carrier: z.enum(['yamato', 'sagawa', 'japanpost']).nullable(),
  trackingNumber: z.string().trim().regex(/^[0-9A-Za-z-]{1,64}$/).nullable(),
  shipmentDate: z.string().date(),
  notifyCustomer: z.boolean(),
  requestKey: requestKeySchema,
}).refine((body) => (body.carrier === null) === (body.trackingNumber === null));

/** 判断待ちの取り消しがある注文を含む票の確定を止める印。共通窓口が code と固定の文で 409 にし、監査は failure と DISPUTE_HOLD だけを残す。 */
class DisputeHoldError extends ShipmentSlipError {
  constructor() {
    super(409);
    this.message = DISPUTE_HOLD_MESSAGE;
    Object.defineProperty(this, 'code', { value: DISPUTE_HOLD_CODE, enumerable: true, configurable: true });
  }
}

/**
 * 発送票の全注文を確定する（FREQ-533）。共通窓口が認可・CSRF・制限・検証・監査の順とactorを守る。
 * 確定の関数を呼ぶ前に、票の注文にカード会社の判断待ちの取り消しがあるかを読み、1件でもあれば 409
 * `{ error, code: 'DISPUTE_HOLD', orderIds }` を返して確定しない（FREQ-568-AC-06。4-e3。DB の止めは計画3）。
 * 読めない時も確定せず、固定の失敗にする。確定したら応答の後に会計の計上を流す。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const held: { orderIds: string[] | null } = { orderIds: null };
  const response = await handleShipmentSlipWrite({
    request, context, label: 'POST /api/admin/shipment-slips/[id]/confirm',
    rateEndpoint: 'admin.shipment_slips.confirm', rateLimit: 60,
    auditAction: 'admin.shipment_slips.confirm', errorCode: 'SHIPMENT_SLIP_CONFIRM_FAILED',
    schema: bodySchema, status: 200,
    run: async (client, actorId, slipId, body) => {
      const holds = await getSlipDisputeHolds(client, slipId as string);
      if (holds.length > 0) {
        held.orderIds = [...new Set(holds.map((hold) => hold.orderId))];
        throw new DisputeHoldError();
      }
      const result = await confirmShipmentSlip(client, actorId, { ...body, slipId: slipId as string });
      scheduleAccountingPosting('shipment_confirm');
      return result;
    },
    auditSuccess: (_body, result) => ({ fulfillment_count: result.fulfillments.length, replayed: result.replayed }),
    auditFailure: () => ({}),
  });
  if (held.orderIds === null || response.status !== 409) return response;
  const stopped = NextResponse.json({ error: DISPUTE_HOLD_MESSAGE, code: DISPUTE_HOLD_CODE, orderIds: held.orderIds }, { status: 409 });
  stopped.headers.set('Cache-Control', 'no-store');
  return stopped;
}
