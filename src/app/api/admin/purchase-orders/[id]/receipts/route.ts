import 'server-only';

import { z } from 'zod';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';
import { receivePurchaseOrder } from '@/lib/purchase-orders/purchase-order-store';
import { isPurchaseOrderDay, PURCHASE_ORDER_LIMITS } from '@/lib/purchase-orders/purchase-order-types';

const { lines, receivedQuantity, receiptMemo } = PURCHASE_ORDER_LIMITS;

const bodySchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483647),
  // 実在の日付（YYYY-MM-DD）。発注日から今日(日本時間)までかどうかは DB が確かめる
  receivedOn: z.string().refine(isPurchaseOrderDay, { message: 'receivedOn は YYYY-MM-DD の日付' }),
  // 前後の空白を落とした後の文字数で見る(DB と同じ)。空白だけは「メモ無し」として渡す
  memo: z.string().trim().max(receiptMemo.max).optional(),
  // 受け取る行だけ(未納の無い行は含めない)。各 1〜99999。未納の範囲かどうかは DB が確かめる
  lines: z.array(z.object({
    lineId: z.string().uuid(),
    quantity: z.number().int().min(receivedQuantity.min).max(receivedQuantity.max),
  })).min(lines.min).max(lines.max).refine(
    (items) => new Set(items.map((item) => item.lineId.toLowerCase())).size === items.length,
    { message: 'lineId は重複できません' },
  ),
  requestKey: z.string().uuid(),
});

/**
 * 発注書の受け取り（G-2 / FREQ-529）。数量確定済みの発注書の未納の範囲で、行ごとの良品の数を受け取る。
 * 台帳の入庫(restock・無タグ)・受取・納品済み・未納・空き在庫・FIFO の割当・状態の履歴が1つの DB 取引で保存され、1行でも不正なら何も残らない。
 * 同じ requestKey と同じ内容の再送は在庫を増やさず同じ結果を返す。成功は201で { receiptId, version, allocatedQuantity, replayed } をそのまま返す。
 * 権限は admin.receiving.manage + admin.purchase_orders.read。回数制限 admin.purchase_orders.receive の60回/600秒、監査 admin.purchase_orders.receive。
 * 流れは handlePurchaseOrderWrite（認可 → CSRF → 回数制限 → 検証 → DB の関数 → 監査）。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'POST /api/admin/purchase-orders/[id]/receipts',
    action: 'admin.purchase_orders.receive',
    rateLimit: 60,
    errorCode: 'PURCHASE_ORDER_RECEIVE_FAILED',
    permissions: ['admin.receiving.manage', 'admin.purchase_orders.read'],
    schema: bodySchema,
    status: 201,
    run: (client, actorId, purchaseOrderId, body) => receivePurchaseOrder(client, actorId, {
      purchaseOrderId,
      expectedVersion: body.expectedVersion,
      receivedOn: body.receivedOn,
      memo: body.memo || null,
      lines: body.lines,
      requestKey: body.requestKey,
    }),
    auditSuccess: (body, result) => ({ line_count: body.lines.length, allocated_quantity: result.allocatedQuantity, replayed: result.replayed }),
    auditFailure: (body) => ({ line_count: body.lines.length }),
  });
}
