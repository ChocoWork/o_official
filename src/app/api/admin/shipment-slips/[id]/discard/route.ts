import 'server-only';

import { z } from 'zod';
import {
  expectedVersionSchema,
  handleShipmentSlipWrite,
  requestKeySchema,
} from '@/lib/orders/shipment-slips/shipment-slip-route';
import { discardShipmentSlipDraft } from '@/lib/orders/shipment-slips/shipment-slip-store';

const bodySchema = z.object({ expectedVersion: expectedVersionSchema, requestKey: requestKeySchema });

/**
 * 発送票の下書きを破棄する（G-3 / FREQ-531-AC-03）。下書きでなければ 409（GROUP_G_SLIP_NOT_DRAFT）、版が違えば 409（GROUP_G_SLIP_VERSION_CONFLICT）。
 * 権限は窓口と DB の関数の両方で下書き・破棄の組を確かめ、実行者は認可結果の userId だけから渡す。
 * 同じ requestKey と同じ内容の再送は同じ結果を replayed: true で返す。成功は 200 { id, number, version, replayed }。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleShipmentSlipWrite({
    request,
    context,
    label: 'POST /api/admin/shipment-slips/[id]/discard',
    rateEndpoint: 'admin.shipment_slips.discard',
    rateLimit: 60,
    auditAction: 'admin.shipment_slips.draft.discard',
    errorCode: 'SHIPMENT_SLIP_DRAFT_DISCARD_FAILED',
    schema: bodySchema,
    status: 200,
    run: (client, actorId, slipId, body) => discardShipmentSlipDraft(client, actorId, {
      slipId: slipId as string, expectedVersion: body.expectedVersion, requestKey: body.requestKey,
    }),
    auditSuccess: (_body, result) => ({ replayed: result.replayed }),
    auditFailure: () => ({}),
  });
}
