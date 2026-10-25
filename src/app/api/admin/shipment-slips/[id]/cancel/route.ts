import 'server-only';

import { z } from 'zod';
import {
  expectedVersionSchema,
  handleShipmentSlipWrite,
  requestKeySchema,
} from '@/lib/orders/shipment-slips/shipment-slip-route';
import { cancelShipmentSlip } from '@/lib/orders/shipment-slips/shipment-slip-store';

const bodySchema = z.object({ expectedVersion: expectedVersionSchema, requestKey: requestKeySchema });

/**
 * 確定済みの発送票を全体で取り消す（G-3 / FREQ-533-AC-04・FREQ-534-AC-03）。票の全注文の発送を取り消し、割当の消費を1回だけ戻す。
 * 返品・発送後の返金・取り消せない状態の注文が1つでもあれば全体を 409 で断り、何も変えない。
 * 認可は発送の操作の4権限を窓口と DB の関数の両方で確かめ、実行者は認可結果の userId だけから渡す。
 * 同じ requestKey と同じ内容の再送は同じ結果を replayed: true で返す。成功は 200 { id, version, restoredQuantity, replayed }。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleShipmentSlipWrite({
    request,
    context,
    label: 'POST /api/admin/shipment-slips/[id]/cancel',
    rateEndpoint: 'admin.shipment_slips.cancel',
    rateLimit: 30,
    auditAction: 'admin.shipment_slips.cancel',
    errorCode: 'SHIPMENT_SLIP_CANCEL_FAILED',
    schema: bodySchema,
    status: 200,
    run: (client, actorId, slipId, body) => cancelShipmentSlip(client, actorId, {
      slipId: slipId as string, expectedVersion: body.expectedVersion, requestKey: body.requestKey,
    }),
    auditSuccess: (_body, result) => ({ restored_quantity: result.restoredQuantity, replayed: result.replayed }),
    auditFailure: () => ({}),
  });
}
