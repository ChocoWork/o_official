import 'server-only';

import { z } from 'zod';
import { issueDocumentUploadUrl } from '@/lib/purchase-orders/purchase-order-documents';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';

const bodySchema = z.object({});

/**
 * 取引書類の署名つき送り先の出し直し（G-2 / FREQ-530。ページを読み直した後・送れなかった後の再開）。本文は無い。
 * 予約がこの発注書の物でなければ409、すでに添付に結ばれていても409。置き場にすでに保存済みなら { uploaded: true }、
 * 無ければ新しい署名つきの送り先 { uploaded: false, signedUrl }（200）。署名つきの送り先は応答にだけ載せる。
 * 権限は admin.purchase_orders.manage + admin.purchase_orders.read（DB の読取の確かめも実行者つきで行う）。
 * 回数制限 admin.purchase_orders.attachment.upload_url の30回/600秒。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; reservationId: string }> },
): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'POST /api/admin/purchase-orders/[id]/attachments/reservations/[reservationId]/upload-url',
    action: 'admin.purchase_orders.attachment.upload_url',
    rateLimit: 30,
    errorCode: 'PURCHASE_ORDER_ATTACHMENT_UPLOAD_URL_FAILED',
    extraPathIds: ['reservationId'],
    schema: bodySchema,
    status: 200,
    run: (client, actorId, purchaseOrderId, _body, params) => issueDocumentUploadUrl(client, actorId, {
      purchaseOrderId,
      reservationId: params.reservationId,
    }),
    auditSuccess: (_body, result) => ({ uploaded: result.uploaded }),
    auditFailure: () => ({}),
  });
}
