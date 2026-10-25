import 'server-only';

import { z } from 'zod';
import { expectedVersionSchema, handleShipmentSlipWrite, requestKeySchema } from '@/lib/orders/shipment-slips/shipment-slip-route';
import { updateShipmentSlipTracking } from '@/lib/orders/shipment-slips/shipment-slip-store';

// 運送会社と伝票番号は両方必須（空に戻す訂正は無い）。伝票番号は trim 後 ^[0-9A-Za-z-]{1,64}$
const bodySchema = z.object({
  expectedVersion: expectedVersionSchema,
  carrier: z.enum(['yamato', 'sagawa', 'japanpost']),
  trackingNumber: z.string().trim().regex(/^[0-9A-Za-z-]{1,64}$/),
  notifyCustomer: z.boolean(),
  requestKey: requestKeySchema,
});

/**
 * 確定済みの発送票の伝票番号を入れる・直す（G-3 / FREQ-534-AC-01）。票の全注文の有効な発送へ同じ運送会社と番号を反映し、
 * 通知がオンなら注文ごとに更新メールを1通ずつ積む。同じ値（番号は大文字小文字を無視）は 409、空に戻す訂正は 400。
 * 認可は発送の操作の4権限を窓口と DB の関数の両方で確かめ、実行者は認可結果の userId だけから渡す。成功は 200 { id, version, trackingVersion, replayed }。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleShipmentSlipWrite({
    request,
    context,
    label: 'POST /api/admin/shipment-slips/[id]/tracking',
    rateEndpoint: 'admin.shipment_slips.tracking',
    rateLimit: 60,
    auditAction: 'admin.shipment_slips.tracking.update',
    errorCode: 'SHIPMENT_SLIP_TRACKING_FAILED',
    schema: bodySchema,
    status: 200,
    run: (client, actorId, slipId, body) => updateShipmentSlipTracking(client, actorId, { ...body, slipId: slipId as string }),
    auditSuccess: (_body, result) => ({ tracking_version: result.trackingVersion, replayed: result.replayed }),
    auditFailure: () => ({}),
  });
}
