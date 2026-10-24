import 'server-only';

import { z } from 'zod';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';
import { reversePurchaseOrderReceipt } from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_LIMITS } from '@/lib/purchase-orders/purchase-order-types';

const { lines, receivedQuantity, reason } = PURCHASE_ORDER_LIMITS;

const bodySchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483647),
  // 取り消す行(取消 = 取り消せる数ぜんぶ、訂正 = 一部の行の一部の数)。取り消せる数の範囲かどうかは DB が確かめる
  lines: z.array(z.object({
    receiptLineId: z.string().uuid(),
    quantity: z.number().int().min(receivedQuantity.min).max(receivedQuantity.max),
  })).min(lines.min).max(lines.max).refine(
    (items) => new Set(items.map((item) => item.receiptLineId.toLowerCase())).size === items.length,
    { message: 'receiptLineId は重複できません' },
  ),
  reason: z.string().trim().min(reason.min).max(reason.max),
  // 外す割当の点数の確認値。最初は省く。窓口が 409 で返した点数を、確認の後に入れて新しい requestKey で送り直す
  expectedReleaseQuantity: z.number().int().min(0).max(2147483647).optional(),
  requestKey: z.string().uuid(),
});

/**
 * 発注書の受け取りの取消・数量訂正（G-2 / FREQ-529。同じ操作）。相殺の受取を追記して納品済み・未納を戻し、在庫は G-1 の減らし方で減らす
 * （空き在庫 → 足りなければ支払い済みの割当を新しい注文から外す。出荷で消費された分は外れない）。理由が必須。
 * 外す割当があるのに expectedReleaseQuantity が無い・違う時は、書込み0件で409 { code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED',
 * error, releasedQuantity }（G-1 の在庫の窓口と同じ形）。利用者の確認の後は、新しい requestKey と expectedReleaseQuantity で送り直し、
 * 同じ確定送信の通信の再送だけが同じ requestKey と本文を使う。成功は201で { receiptId, version, releasedQuantity, replayed } をそのまま返す。
 * 権限は admin.receiving.manage + admin.purchase_orders.read。回数制限 admin.purchase_orders.receipt.reverse の30回/600秒、
 * 監査 admin.purchase_orders.receipt.reverse。
 * 流れは handlePurchaseOrderWrite（認可 → CSRF → 回数制限 → 検証 → DB の関数 → 監査）。パスの receiptId が uuid でなければ400。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string; receiptId: string }> }): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'POST /api/admin/purchase-orders/[id]/receipts/[receiptId]/reversals',
    action: 'admin.purchase_orders.receipt.reverse',
    rateLimit: 30,
    errorCode: 'PURCHASE_ORDER_RECEIPT_REVERSE_FAILED',
    permissions: ['admin.receiving.manage', 'admin.purchase_orders.read'],
    extraPathIds: ['receiptId'],
    schema: bodySchema,
    status: 201,
    run: (client, actorId, purchaseOrderId, body, params) => reversePurchaseOrderReceipt(client, actorId, {
      purchaseOrderId,
      expectedVersion: body.expectedVersion,
      receiptId: params.receiptId,
      lines: body.lines,
      reason: body.reason,
      expectedReleaseQuantity: body.expectedReleaseQuantity ?? null,
      requestKey: body.requestKey,
    }),
    auditSuccess: (body, result) => ({ line_count: body.lines.length, released_quantity: result.releasedQuantity, replayed: result.replayed }),
    auditFailure: (body) => ({ line_count: body.lines.length }),
  });
}
