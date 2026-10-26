import { z } from 'zod';
import { itemStateReasonLabel, ORDER_ITEM_STATUS_ORDER, type OrderHistoryItemStateEntry } from './admin-order-types';
import { adminOrderIntegerSchema, adminOrderTimestampSchema } from './admin-order-query';

export const itemStateHistoryDbRowSchema = z.object({
  id: z.string().uuid(), created_at: adminOrderTimestampSchema, order_item_id: z.string().uuid(), item_name: z.string(),
  color: z.string().nullable(), size: z.string().nullable(), is_exchange: z.boolean(), quantity: adminOrderIntegerSchema.positive().max(2147483647),
  from_status: z.enum(ORDER_ITEM_STATUS_ORDER).nullable(), to_status: z.enum(ORDER_ITEM_STATUS_ORDER).nullable(), reason: z.string(), actor_id: z.string().uuid().nullable(), operation: z.string(),
  ref_kind: z.enum(['shipment_slip', 'purchase_order']).nullable(), ref_id: z.string().uuid().nullable(), ref_label: z.string().nullable(), note: z.string().nullable(), counterpart_order_id: z.string().uuid().nullable(),
});
export type ItemStateHistoryDbRow = z.infer<typeof itemStateHistoryDbRowSchema>;

/** DBの順序を維持し、管理画面と試験の橋渡しで同じ言葉・名前・参照を作る。 */
export function mapItemStateHistoryRows(rows: readonly ItemStateHistoryDbRow[], actorEmailOf: (actorId: string) => string | null): OrderHistoryItemStateEntry[] {
  return rows.map((row) => {
    const variant = [row.color, row.size].filter(Boolean).join(' / ');
    return {
      id: row.id, at: row.created_at, orderItemId: row.order_item_id,
      itemName: `${row.item_name}${variant ? `（${variant}）` : ''}${row.is_exchange ? '（交換品）' : ''}`,
      quantity: row.quantity, from: row.from_status, to: row.to_status, reason: row.reason, reasonLabel: itemStateReasonLabel(row.reason),
      actorEmail: row.actor_id === null ? null : actorEmailOf(row.actor_id), automatic: row.actor_id === null,
      ref: row.ref_kind && row.ref_id && row.ref_label ? { kind: row.ref_kind, id: row.ref_id, label: row.ref_label } : null,
      swap: row.operation === 'allocation_swap' && row.counterpart_order_id ? { counterpartOrderId: row.counterpart_order_id, note: row.note } : null,
    };
  });
}
