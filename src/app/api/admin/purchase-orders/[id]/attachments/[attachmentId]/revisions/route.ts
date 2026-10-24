import 'server-only';

import { z } from 'zod';
import { revisePurchaseOrderDocument } from '@/lib/purchase-orders/purchase-order-documents';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';
import {
  isPurchaseOrderDay,
  PURCHASE_ORDER_DOCUMENT_MIN_DAY,
  PURCHASE_ORDER_LIMITS,
} from '@/lib/purchase-orders/purchase-order-types';

const { counterparty, documentAmountYen, reason } = PURCHASE_ORDER_LIMITS;

const bodySchema = z.object({
  transactionDate: z.string().refine(isPurchaseOrderDay, { message: 'transactionDate は YYYY-MM-DD の日付' })
    .refine((day) => day >= PURCHASE_ORDER_DOCUMENT_MIN_DAY, { message: 'transactionDate は 2000-01-01 以降' }),
  amountYen: z.number().int().min(documentAmountYen.min).max(documentAmountYen.max),
  currency: z.literal('JPY'),
  counterparty: z.string().trim().min(counterparty.min).max(counterparty.max),
  voided: z.boolean(),
  reason: z.string().trim().min(reason.min).max(reason.max),
  requestKey: z.string().uuid(),
});

/**
 * 取引書類の情報の訂正と無効化（G-2 / FREQ-530）。次の版を足し、前の版は残る。voided を真にすると無効化。理由が必須で、
 * 前の版と同じ内容は400。他の発注書の添付も400。成功は201で { attachmentId, revisionNo, replayed }。
 * 権限は admin.purchase_orders.manage + admin.purchase_orders.read。回数制限 admin.purchase_orders.attachment.revise の30回/600秒、
 * 監査 admin.purchase_orders.attachment.revise。
 * 流れは handlePurchaseOrderWrite（認可 → CSRF → 回数制限 → 検証 → DB の関数 → 監査）。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; attachmentId: string }> },
): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'POST /api/admin/purchase-orders/[id]/attachments/[attachmentId]/revisions',
    action: 'admin.purchase_orders.attachment.revise',
    rateLimit: 30,
    errorCode: 'PURCHASE_ORDER_ATTACHMENT_REVISE_FAILED',
    extraPathIds: ['attachmentId'],
    schema: bodySchema,
    status: 201,
    run: (client, actorId, purchaseOrderId, body, params) => revisePurchaseOrderDocument(client, actorId, {
      purchaseOrderId,
      attachmentId: params.attachmentId,
      transactionDate: body.transactionDate,
      amountYen: body.amountYen,
      currency: body.currency,
      counterparty: body.counterparty,
      voided: body.voided,
      reason: body.reason,
      requestKey: body.requestKey,
    }),
    auditSuccess: (body, result) => ({ attachment_id: result.attachmentId, voided: body.voided, replayed: result.replayed }),
    auditFailure: (body, params) => ({ attachment_id: params.attachmentId, voided: body.voided }),
  });
}
