import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ADMIN_ITEM_STATUS_LABELS, type AdminItemState, type AdminItemStatus,
  type ItemBlockedReason } from './item-state-types';

const BLOCKED_REASONS: readonly ItemBlockedReason[] = ['variant_missing', 'payment_review', 'exchange_fee_waiting',
  'cancel_requested', 'refund_processing', 'stock_shortage'];

/** RPC の生の本文・detail・cause は保持しない。 */
function failed(): never { throw new Error('ITEM_STATE_READ_FAILED'); }

export async function listAdminOrderItemStates(client: SupabaseClient, orderIds: string[]): Promise<AdminItemState[]> {
  if (orderIds.length === 0) return [];
  let data: unknown;
  try {
    const result = await client.rpc('list_admin_order_item_states', { _order_ids: orderIds });
    if (result.error) return failed();
    data = result.data;
  } catch { return failed(); }
  if (!Array.isArray(data)) return failed();
  return data.map((value: unknown): AdminItemState => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return failed();
    const r = value as Record<string, unknown>;
    if (typeof r.order_id !== 'string' || r.order_id.length === 0
      || typeof r.order_item_id !== 'string' || r.order_item_id.length === 0
      || typeof r.status !== 'string' || !Object.prototype.hasOwnProperty.call(ADMIN_ITEM_STATUS_LABELS, r.status)
      || typeof r.quantity !== 'number' || !Number.isInteger(r.quantity) || r.quantity <= 0 || r.quantity > 2147483647
      || !Array.isArray(r.blocked_reasons)
      || !r.blocked_reasons.every((reason: unknown) => typeof reason === 'string'
        && BLOCKED_REASONS.includes(reason as ItemBlockedReason))) return failed();
    return { orderId: r.order_id, orderItemId: r.order_item_id, status: r.status as AdminItemStatus,
      quantity: r.quantity, blockedReasons: r.blocked_reasons as ItemBlockedReason[] };
  });
}
