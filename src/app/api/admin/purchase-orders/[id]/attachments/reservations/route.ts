import 'server-only';

import { z } from 'zod';
import { reservePurchaseOrderDocument } from '@/lib/purchase-orders/purchase-order-documents';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';
import { PURCHASE_ORDER_LIMITS } from '@/lib/purchase-orders/purchase-order-types';

const bodySchema = z.object({
  kind: z.enum(['quote', 'invoice']),
  // 前後の空白を落としてから長さを見る（DB も落としてから数える）。拡張子（pdf・jpg・jpeg・png）は DB が確かめる
  fileName: z.string().trim().min(PURCHASE_ORDER_LIMITS.documentFileName.min).max(PURCHASE_ORDER_LIMITS.documentFileName.max),
  // 差し替えの予約だけ、差し替える添付（この発注書の物かは DB が確かめる）。予約に残り、確定が版1へ写す
  replacesAttachmentId: z.string().uuid().nullish(),
  requestKey: z.string().uuid(),
});

/**
 * 取引書類の置き場の予約（G-2 / FREQ-530）。DB に予約（24時間。差し替えなら差し替える添付も）を足し、続けて署名つきの送り先（上書きできない形）を返す。
 * 差し替える添付がこの発注書の物でなければ400（GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID）。
 * 成功は201で { reservationId, signedUrl, expiresAt, replayed }。署名つきの送り先は応答にだけ載せ、監査にもログにも出さない。
 * 置き場の送り先を作れなかった時は503で、予約は残る（画面は保存が終わっていないファイルとして続きから送り直せる）。
 * 権限は admin.purchase_orders.manage + admin.purchase_orders.read。回数制限 admin.purchase_orders.attachment.reserve の30回/600秒。
 * 流れは handlePurchaseOrderWrite（認可 → CSRF → 回数制限 → 検証 → DB の関数 → 監査）。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'POST /api/admin/purchase-orders/[id]/attachments/reservations',
    action: 'admin.purchase_orders.attachment.reserve',
    rateLimit: 30,
    errorCode: 'PURCHASE_ORDER_ATTACHMENT_RESERVE_FAILED',
    schema: bodySchema,
    status: 201,
    run: (client, actorId, purchaseOrderId, body) => reservePurchaseOrderDocument(client, actorId, {
      purchaseOrderId,
      kind: body.kind,
      fileName: body.fileName,
      replacesAttachmentId: body.replacesAttachmentId ?? null,
      requestKey: body.requestKey,
    }),
    auditSuccess: (_body, result) => ({ replayed: result.replayed }),
    auditFailure: () => ({}),
  });
}
