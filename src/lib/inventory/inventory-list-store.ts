import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { calcRequiredQuantity, INVENTORY_LIST_TEXT, type AdminInventoryRow } from './inventory-list-types';

/** DB が実行者の権限（admin.stock.read）で断った時だけ。固定の文と番号だけを持ち、DB の生の文も cause も持たない。 */
export class AdminInventoryError extends Error {
  readonly status = 403;
  readonly code = 'GROUP_G_FORBIDDEN';

  constructor() {
    super(INVENTORY_LIST_TEXT.forbidden);
    this.name = 'AdminInventoryError';
  }
}

const failed = () => new Error('INVENTORY_READ_FAILED');

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** DB の SQLSTATE と文の組が両方そろった時だけ権限の拒否として扱う（片方だけの一致は信用しない） */
function isForbidden(error: unknown): boolean {
  return isObject(error) && error.message === 'GROUP_G_FORBIDDEN' && error.code === '42501';
}

function toRow(raw: unknown, seen: Set<number>): AdminInventoryRow {
  if (!isObject(raw)) throw failed();
  const { variant_id: variantId, item_id: itemId } = raw;
  if (typeof variantId !== 'number' || !Number.isSafeInteger(variantId) || variantId <= 0 || seen.has(variantId)
    || typeof itemId !== 'number' || !Number.isSafeInteger(itemId) || itemId <= 0
    || typeof raw.item_name !== 'string' || !isNullableText(raw.color_name) || !isNullableText(raw.size_label)
    || typeof raw.is_active !== 'boolean'
    || !isCount(raw.free) || !isCount(raw.paid_allocated) || !isCount(raw.payment_held) || !isCount(raw.on_hand)
    || !isCount(raw.order_quantity) || !isCount(raw.on_order) || !isCount(raw.required)
    || raw.on_hand !== raw.free + raw.paid_allocated + raw.payment_held
    || raw.required !== calcRequiredQuantity(raw.order_quantity, raw.on_hand, raw.on_order)) throw failed();
  seen.add(variantId);
  return {
    variantId, itemId, itemName: raw.item_name, colorName: raw.color_name, sizeLabel: raw.size_label, isActive: raw.is_active,
    free: raw.free, paidAllocated: raw.paid_allocated, paymentHeld: raw.payment_held, onHand: raw.on_hand,
    orderQuantity: raw.order_quantity, onOrder: raw.on_order, required: raw.required,
  };
}

/**
 * 在庫一覧表を DB の関数 list_admin_inventory から1回で読む（読むだけ。variant も台帳も作らない）。
 * 行の並びは DB が決めた順のまま。数の整合が崩れた応答は読み違いなので INVENTORY_READ_FAILED で止める。
 */
export async function listAdminInventory(client: SupabaseClient, actorId: string): Promise<AdminInventoryRow[]> {
  let result;
  try {
    result = await client.rpc('list_admin_inventory', { _actor_id: actorId });
  } catch {
    throw failed();
  }
  if (result.error) {
    if (isForbidden(result.error)) throw new AdminInventoryError();
    throw failed();
  }
  if (!Array.isArray(result.data)) throw failed();
  const seen = new Set<number>();
  return result.data.map((raw: unknown) => toRow(raw, seen));
}
