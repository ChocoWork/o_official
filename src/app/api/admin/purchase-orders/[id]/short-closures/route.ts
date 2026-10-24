import 'server-only';

import { z } from 'zod';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';
import { shortClosePurchaseOrder } from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_LIMITS } from '@/lib/purchase-orders/purchase-order-types';

const { lines, reason } = PURCHASE_ORDER_LIMITS;

const bodySchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483647),
  lineIds: z.array(z.string().uuid()).min(lines.min).max(lines.max).refine(
    (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
    { message: 'lineIds は重複できません' },
  ),
  reason: z.string().trim().min(reason.min).max(reason.max),
  requestKey: z.string().uuid(),
});

/**
 * 残りの打切り（G-2 / FREQ-528）。数量確定後は未納のある行を選んで残りを打ち切り、数量確定前の取消は発注書の全行を渡す
 * （どちらも入庫・台帳・割当は動かさない。確定前に一部の行だけを渡すと DB が 22023 で断る）。理由が必須。
 * 成功は201で { version, closedQuantity, replayed } をそのまま返す。
 * 流れは handlePurchaseOrderWrite（認可 → CSRF → 回数制限 → 検証 → DB の関数 → 監査 admin.purchase_orders.short_close）。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'POST /api/admin/purchase-orders/[id]/short-closures',
    action: 'admin.purchase_orders.short_close',
    rateLimit: 30,
    errorCode: 'PURCHASE_ORDER_SHORT_CLOSE_FAILED',
    schema: bodySchema,
    status: 201,
    run: (client, actorId, purchaseOrderId, body) => shortClosePurchaseOrder(client, actorId, {
      purchaseOrderId,
      expectedVersion: body.expectedVersion,
      lineIds: body.lineIds,
      reason: body.reason,
      requestKey: body.requestKey,
    }),
    auditSuccess: (body, result) => ({ line_count: body.lineIds.length, closed_quantity: result.closedQuantity, replayed: result.replayed }),
    auditFailure: (body) => ({ line_count: body.lineIds.length }),
  });
}
