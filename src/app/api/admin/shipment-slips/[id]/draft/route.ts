import 'server-only';

import { z } from 'zod';
import {
  draftLinesSchema,
  expectedVersionSchema,
  handleShipmentSlipWrite,
  requestKeySchema,
} from '@/lib/orders/shipment-slips/shipment-slip-route';
import { saveShipmentSlipDraft } from '@/lib/orders/shipment-slips/shipment-slip-store';

const bodySchema = z.object({ expectedVersion: expectedVersionSchema, lines: draftLinesSchema, requestKey: requestKeySchema });

/**
 * 発送票の下書きの品物を丸ごと入れ替える（G-3 / FREQ-531-AC-03）。外す・追加はどちらもこの窓口で、選択の全部を送る。
 * 権限は窓口と DB の関数の両方で下書き・破棄の組を確かめ、実行者は認可結果の userId だけから渡す。
 * 版が違えば 409（GROUP_G_SLIP_VERSION_CONFLICT）、下書きでなければ 409（GROUP_G_SLIP_NOT_DRAFT）。
 * 同じ requestKey と同じ内容の再送は同じ結果を replayed: true で返す。成功は 200 { id, number, version, replayed }。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleShipmentSlipWrite({
    request,
    context,
    label: 'POST /api/admin/shipment-slips/[id]/draft',
    rateEndpoint: 'admin.shipment_slips.draft',
    rateLimit: 120,
    auditAction: 'admin.shipment_slips.draft.save',
    errorCode: 'SHIPMENT_SLIP_DRAFT_SAVE_FAILED',
    schema: bodySchema,
    status: 200,
    run: (client, actorId, slipId, body) => saveShipmentSlipDraft(client, actorId, {
      slipId, expectedVersion: body.expectedVersion, lines: body.lines, requestKey: body.requestKey,
    }),
    auditSuccess: (body, result) => ({ line_count: body.lines.length, replayed: result.replayed }),
    auditFailure: (body) => ({ line_count: body.lines.length }),
  });
}
