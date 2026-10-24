import 'server-only';

import { z } from 'zod';
import { attachPurchaseOrderDocument } from '@/lib/purchase-orders/purchase-order-documents';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';
import {
  isPurchaseOrderDay,
  PURCHASE_ORDER_DOCUMENT_MIN_DAY,
  PURCHASE_ORDER_LIMITS,
} from '@/lib/purchase-orders/purchase-order-types';

const { counterparty, documentAmountYen } = PURCHASE_ORDER_LIMITS;

const bodySchema = z.object({
  reservationId: z.string().uuid(),
  // ブラウザが計算した SHA-256（64桁の小文字）。ページを読み直した後でファイルが手元に無い再開だけ null（サーバーが読み戻した本文から計算する）
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  // 実在の日付で 2000-01-01 以降（未来でもよい）
  transactionDate: z.string().refine(isPurchaseOrderDay, { message: 'transactionDate は YYYY-MM-DD の日付' })
    .refine((day) => day >= PURCHASE_ORDER_DOCUMENT_MIN_DAY, { message: 'transactionDate は 2000-01-01 以降' }),
  amountYen: z.number().int().min(documentAmountYen.min).max(documentAmountYen.max),
  currency: z.literal('JPY'),
  counterparty: z.string().trim().min(counterparty.min).max(counterparty.max),
  requestKey: z.string().uuid(),
});

/**
 * 取引書類の確定（G-2 / FREQ-530）。置き場に保存済みのファイルを読み戻して検査(拡張子・先頭のバイト・種類・大きさ・SHA-256)し、
 * 予約を添付（版1: 取引日・金額・取引先。差し替えなら、予約に残した差し替え元）に結ぶ。差し替え元は本文では受けず、予約から写す。
 * 置き場にまだ無ければ409、種類の不一致・大きすぎ・ハッシュの不一致は422、置き場の不調は503。
 * 成功は201で { attachmentId, revisionNo, replayed }。同じ requestKey の再送は同じ結果を返す（応答を失った後の再送）。
 * 権限は admin.purchase_orders.manage + admin.purchase_orders.read。回数制限 admin.purchase_orders.attachment.attach の30回/600秒、
 * 監査 admin.purchase_orders.attachment.attach（発注書・予約・添付の ID、再送かどうか、結果コードだけ）。
 * 流れは handlePurchaseOrderWrite（認可 → CSRF → 回数制限 → 検証 → 置き場の確かめ → DB の関数 → 監査）。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'POST /api/admin/purchase-orders/[id]/attachments',
    action: 'admin.purchase_orders.attachment.attach',
    rateLimit: 30,
    errorCode: 'PURCHASE_ORDER_ATTACHMENT_ATTACH_FAILED',
    schema: bodySchema,
    status: 201,
    run: (client, actorId, purchaseOrderId, body) => attachPurchaseOrderDocument(client, actorId, {
      purchaseOrderId,
      reservationId: body.reservationId,
      sha256: body.sha256,
      transactionDate: body.transactionDate,
      amountYen: body.amountYen,
      currency: body.currency,
      counterparty: body.counterparty,
      requestKey: body.requestKey,
    }),
    auditSuccess: (body, result) => ({ reservation_id: body.reservationId, attachment_id: result.attachmentId, replayed: result.replayed }),
    auditFailure: (body) => ({ reservation_id: body.reservationId }),
  });
}
