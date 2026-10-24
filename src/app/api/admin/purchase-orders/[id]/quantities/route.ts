import 'server-only';

import { z } from 'zod';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';
import { confirmPurchaseOrderQuantities } from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_LIMITS } from '@/lib/purchase-orders/purchase-order-types';

const { lines, confirmedQuantity, unitPriceYen, reason } = PURCHASE_ORDER_LIMITS;

const bodySchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483647),
  lines: z.array(z.object({
    lineId: z.string().uuid(),
    quantity: z.number().int().min(confirmedQuantity.min).max(confirmedQuantity.max),
    // 未登録は null で明示する（省いた項目と 0 円を取り違えない）
    unitPriceYen: z.number().int().min(unitPriceYen.min).max(unitPriceYen.max).nullable(),
  })).min(lines.min).max(lines.max).refine(
    (items) => new Set(items.map((item) => item.lineId.toLowerCase())).size === items.length,
    { message: 'lineId は重複できません' },
  ),
  // 最初の確定では省ける。訂正で空なら DB が GROUP_G_PO_REASON_REQUIRED で断る（前後の空白を落として、空白だけは無しとして渡す）
  reason: z.string().trim().max(reason.max).optional(),
  requestKey: z.string().uuid(),
});

/**
 * 数量の確定・訂正（G-2 / FREQ-527）。lines は発注書の全行をちょうど1回ずつ（足りない・重複・他の発注書の行は DB が 22023 で断る）。
 * 成功は201で { version, changedLines, replayed } をそのまま返す。
 * 流れは handlePurchaseOrderWrite（認可 → CSRF → 回数制限 → 検証 → DB の関数 → 監査 admin.purchase_orders.quantity.confirm）。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'POST /api/admin/purchase-orders/[id]/quantities',
    action: 'admin.purchase_orders.quantity.confirm',
    rateLimit: 60,
    errorCode: 'PURCHASE_ORDER_QUANTITIES_FAILED',
    schema: bodySchema,
    status: 201,
    run: (client, actorId, purchaseOrderId, body) => confirmPurchaseOrderQuantities(client, actorId, {
      purchaseOrderId,
      expectedVersion: body.expectedVersion,
      lines: body.lines,
      reason: body.reason || null,
      requestKey: body.requestKey,
    }),
    auditSuccess: (body, result) => ({ line_count: body.lines.length, changed_lines: result.changedLines, replayed: result.replayed }),
    auditFailure: (body) => ({ line_count: body.lines.length }),
  });
}
