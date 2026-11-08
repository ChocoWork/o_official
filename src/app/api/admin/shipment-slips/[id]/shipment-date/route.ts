import 'server-only';

// File: src/app/api/admin/shipment-slips/[id]/shipment-date/route.ts
import { z } from 'zod';
import { scheduleAccountingPosting } from '@/lib/accounting/posting-runner';
import { expectedVersionSchema, handleShipmentSlipWrite, requestKeySchema, SHIPMENT_SLIP_DATE_PERMISSIONS } from '@/lib/orders/shipment-slips/shipment-slip-route';
import { correctShipmentDate } from '@/lib/orders/shipment-slips/shipment-slip-store';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';

const bodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  shipmentDate: z.string().date(),
  reason: z.string().trim().min(1).max(200),
  requestKey: requestKeySchema,
});

/** FREQ-535-AC-03: 訂正の3権限→CSRF→IP/actor制限→検証→RPC→監査。actorは認可結果のみ。 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleShipmentSlipWrite({
    request, context, label: 'POST /api/admin/shipment-slips/[id]/shipment-date',
    permissions: SHIPMENT_SLIP_DATE_PERMISSIONS, forbiddenMessage: SHIPMENT_SLIP_TEXT.dateForbidden,
    rateEndpoint: 'admin.shipment_slips.date', rateLimit: 30,
    auditAction: 'admin.shipment_slips.date.correct', errorCode: 'SHIPMENT_SLIP_DATE_FAILED',
    schema: bodySchema, status: 200, requiredReason: true,
    run: async (client, actorId, slipId, body) => {
      const result = await correctShipmentDate(client, actorId, { ...body, slipId: slipId as string });
      // 古い日の取り消しと新しい日の仕訳を、応答を返した後に入れる。失敗は応答に影響しない
      scheduleAccountingPosting('shipment_date');
      return result;
    },
    auditSuccess: (_body, result) => ({ replayed: result.replayed }), auditFailure: () => ({}),
  });
}
