import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ALLOCATION_EVENT_LABELS, type AllocationHistoryEvent, type StockMovementInput,
  type StockMovementResult, type VariantInventory } from './allocation-types';

const ERRORS = {
  GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
  GROUP_G_FORBIDDEN: ['42501', 403, '在庫を変更する権限がありません。'],
  GROUP_G_STOCK_INSUFFICIENT: ['23514', 409, '在庫が足りないため、この数量は引けません。'],
  GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED: ['55000', 409, '割り当て済みの品を外す必要があります。数量を確認してください。'],
  GROUP_G_STOCK_RELEASE_REASON_REQUIRED: ['22023', 400, '割り当てを外す理由を入力してください。'],
  GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる在庫操作は実行できません。'],
} as const;

/** Stores only our fixed text and validated numbers, never provider errors or their cause. */
export class StockMovementError extends Error {
  constructor(public readonly status = 500, public readonly code?: keyof typeof ERRORS,
    public readonly releasedQuantity?: number) {
    super(code ? ERRORS[code][2] : '在庫の記録に失敗しました');
    this.name = 'StockMovementError';
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function quantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function nullableText(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]*$/.test(value); }

function stockError(error: unknown): StockMovementError {
  if (!object(error) || !text(error.message) || !Object.hasOwn(ERRORS, error.message)) return new StockMovementError();
  const code = error.message as keyof typeof ERRORS;
  if (error.code !== ERRORS[code][0]) return new StockMovementError();
  if (code === 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED') {
    let detail: unknown;
    try { detail = JSON.parse(typeof error.details === 'string' ? error.details : 'null'); } catch { return new StockMovementError(); }
    if (!object(detail) || Object.keys(detail).length !== 1 || !quantity(detail.releasedQuantity)) return new StockMovementError();
    return new StockMovementError(ERRORS[code][1], code, detail.releasedQuantity);
  }
  return new StockMovementError(ERRORS[code][1], code);
}

export async function recordStockMovement(client: SupabaseClient, actorId: string, input: StockMovementInput): Promise<StockMovementResult> {
  let response;
  try {
    response = await client.rpc('admin_record_stock_movement', { _item_id: input.itemId, _variant_id: input.variantId,
      _delta: input.delta, _reason: input.reason, _note: input.note, _actor_id: actorId, _request_key: input.requestKey,
      _expected_release_quantity: input.expectedReleaseQuantity });
  } catch { throw new StockMovementError(); }
  if (response.error) throw stockError(response.error);
  const r: unknown = response.data;
  if (!object(r) || !decimal(r.movementId) || !quantity(r.releasedQuantity) || !quantity(r.allocatedQuantity)
    || typeof r.replayed !== 'boolean') throw new StockMovementError();
  return { movementId: r.movementId, releasedQuantity: r.releasedQuantity, allocatedQuantity: r.allocatedQuantity, replayed: r.replayed };
}

async function read(client: SupabaseClient, name: string, args: Record<string, unknown>, message: string): Promise<unknown[]> {
  let result;
  try {
    result = await client.rpc(name, args);
  } catch { throw new Error(message); }
  if (!result.error && Array.isArray(result.data)) return result.data;
  if (result.error) {
    const error = new Error(message);
    error.name = result.error instanceof Error && result.error.name === 'PostgrestError' ? 'PostgrestError' : 'UnknownError';
    if (/^[0-9A-Z]{5}$/.test(result.error.code)) Object.assign(error, { code: result.error.code });
    throw error;
  }
  throw new Error(message);
}

export async function listGroupGVariantInventory(client: SupabaseClient, variantIds: number[]): Promise<VariantInventory[]> {
  if (!variantIds.length) return [];
  const failed = () => { throw new Error('INVENTORY_READ_FAILED'); };
  const rows = await read(client, 'list_group_g_variant_inventory', { _variant_ids: variantIds }, 'INVENTORY_READ_FAILED');
  const ids = new Set(variantIds);
  const seen = new Set<number>();
  const result = rows.map((r): VariantInventory => {
    if (!object(r) || typeof r.variant_id !== 'number' || !ids.has(r.variant_id) || seen.has(r.variant_id)
      || !quantity(r.free) || !quantity(r.paid_allocated) || !quantity(r.payment_held) || !quantity(r.on_hand)
      || !quantity(r.waiting) || r.on_hand !== r.free + r.paid_allocated + r.payment_held) return failed();
    seen.add(r.variant_id);
    return { variant_id: r.variant_id, free: r.free, paid_allocated: r.paid_allocated, payment_held: r.payment_held,
      on_hand: r.on_hand, waiting: r.waiting };
  });
  if (seen.size !== ids.size) return failed();
  return result;
}

export async function listItemAllocationHistory(client: SupabaseClient, itemId: number, limit: number): Promise<AllocationHistoryEvent[]> {
  const rows = await read(client, 'list_item_allocation_history', { _item_id: itemId, _limit: limit }, 'ALLOCATION_HISTORY_READ_FAILED');
  return rows.map((r): AllocationHistoryEvent => {
    if (!object(r) || !text(r.event_id) || !text(r.allocation_id) || !text(r.order_id) || !text(r.order_item_id)
      || !Number.isSafeInteger(r.variant_id) || Number(r.variant_id) <= 0 || !text(r.event_type)
      || !Object.hasOwn(ALLOCATION_EVENT_LABELS, r.event_type) || !quantity(r.quantity) || r.quantity === 0
      || !text(r.operation_id) || !nullableText(r.counterpart_allocation_id) || !nullableText(r.reverses_event_id)
      || !(r.stock_movement_id === null || decimal(r.stock_movement_id) || (Number.isSafeInteger(r.stock_movement_id) && Number(r.stock_movement_id) > 0))
      || !nullableText(r.reason) || !nullableText(r.actor_id) || !text(r.created_at)) throw new Error('ALLOCATION_HISTORY_READ_FAILED');
    return { id: r.event_id, allocationId: r.allocation_id, orderId: r.order_id, orderItemId: r.order_item_id,
      variantId: Number(r.variant_id), type: r.event_type as AllocationHistoryEvent['type'], quantity: r.quantity,
      operationId: r.operation_id, counterpartAllocationId: r.counterpart_allocation_id, reversesEventId: r.reverses_event_id,
      stockMovementId: r.stock_movement_id === null ? null : String(r.stock_movement_id), reason: r.reason,
      actorId: r.actor_id, createdAt: r.created_at };
  });
}
