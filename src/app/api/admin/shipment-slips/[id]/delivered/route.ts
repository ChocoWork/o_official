import 'server-only';

import { z } from 'zod';
import { expectedVersionSchema, handleShipmentSlipWrite, requestKeySchema } from '@/lib/orders/shipment-slips/shipment-slip-route';
import { markShipmentSlipDelivered } from '@/lib/orders/shipment-slips/shipment-slip-store';

// 届いた日は日本時間の暦日（YYYY-MM-DD）。発送した日から今日までかは DB が確かめる
const bodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  deliveredOn: z.string().date(),
  notifyCustomer: z.boolean(),
  requestKey: requestKeySchema,
});

/**
 * 確定済みの発送票を全体で配達済みにする（G-3 / FREQ-534-AC-02）。票の全注文の有効な発送を届いた日の正午（日本時間）で配達済みにし、
 * 返品の期限はその届いた日から数える。すでに配達済みなら 409、届いた日が範囲外なら 400。
 * 認可は発送の操作の4権限を窓口と DB の関数の両方で確かめ、実行者は認可結果の userId だけから渡す。成功は 200 { id, version, deliveredAt, replayed }。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleShipmentSlipWrite({
    request,
    context,
    label: 'POST /api/admin/shipment-slips/[id]/delivered',
    rateEndpoint: 'admin.shipment_slips.delivered',
    rateLimit: 60,
    auditAction: 'admin.shipment_slips.delivered',
    errorCode: 'SHIPMENT_SLIP_DELIVERED_FAILED',
    schema: bodySchema,
    status: 200,
    run: (client, actorId, slipId, body) => markShipmentSlipDelivered(client, actorId, { ...body, slipId: slipId as string }),
    auditSuccess: (_body, result) => ({ replayed: result.replayed }),
    auditFailure: () => ({}),
  });
}
