import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CheckoutCartSnapshotRow,
  CheckoutItemSnapshotRow,
} from '@/features/checkout/services/checkout-draft.service';
import {
  calculateCheckoutAmountsFromCartRows,
  type CheckoutDisplayedAmounts,
} from '@/features/checkout/services/checkout-pricing.service';

export type CheckoutCartLoad =
  | { kind: 'empty' }
  | {
      kind: 'ok';
      cartRows: CheckoutCartSnapshotRow[];
      itemMap: Map<number, CheckoutItemSnapshotRow>;
      amounts: CheckoutDisplayedAmounts;
    };

type CartLineRow = {
  id: string;
  quantity: number;
  item_variants: {
    id: number;
    item_id: number;
    is_active: boolean;
    item_colors: { name: string } | null;
    item_sizes: { label: string } | null;
  } | null;
};

/** カートの明細を、下書きを作る行（商品・色・サイズの名前・数量）にする。色・サイズの名前はバリアントから引く */
export async function readCheckoutCartRows(supabase: SupabaseClient, cartId: string): Promise<CheckoutCartSnapshotRow[]> {
  const { data, error } = await supabase
    .from('cart_lines')
    .select('id, quantity, item_variants(id, item_id, is_active, item_colors(name), item_sizes(label))')
    .eq('cart_id', cartId);
  if (error) {
    throw error;
  }
  return ((data ?? []) as unknown as CartLineRow[])
    .filter((row) => row.item_variants !== null)
    .map((row) => ({
      id: row.id,
      item_id: Number(row.item_variants!.item_id),
      quantity: row.quantity,
      color: row.item_variants!.item_colors?.name ?? null,
      size: row.item_variants!.item_sizes?.label ?? null,
      variant_id: Number(row.item_variants!.id),
      variant_active: row.item_variants!.is_active,
    }));
}

/**
 * 明細を、買えるものと買えないもの（取り扱いを終えたバリアント、非公開・無い商品）に分ける。
 * 明細ごとに見る（同じ商品でも販売中の色・サイズの明細は買える）。GET /api/cart が出さない明細と同じ規則（設計書 6-1）
 */
export function splitPurchasableCartRows(
  cartRows: CheckoutCartSnapshotRow[],
  items: CheckoutItemSnapshotRow[],
): { purchasable: CheckoutCartSnapshotRow[]; unavailable: CheckoutCartSnapshotRow[] } {
  const itemMap = new Map<number, CheckoutItemSnapshotRow>(items.map((item) => [item.id, item]));
  const purchasable: CheckoutCartSnapshotRow[] = [];
  const unavailable: CheckoutCartSnapshotRow[] = [];
  for (const row of cartRows) {
    const isPurchasable = row.variant_active !== false && itemMap.get(row.item_id)?.status === 'published';
    (isPurchasable ? purchasable : unavailable).push(row);
  }
  return { purchasable, unavailable };
}

/**
 * 買えない明細を、持ち主のカートから消す。
 * cart_id の条件を必ず付け、他人のカートの明細を消さない（service role は RLS を通らない）。DB の失敗は投げる。
 */
export async function removeCartLines(supabase: SupabaseClient, cartId: string, lineIds: string[]): Promise<void> {
  // 明細を先にロックし AFTER トリガーが持ち主を更新するため、持ち主を先にロックする
  // cart_change_line・merge_guest_into_member と同時に走ると、まれにデッドロック（40P01）になる。
  // 片方の要求は 500 になるがトランザクションが戻るのでデータは壊れず、送り直せば通る。
  const { error } = await supabase.from('cart_lines').delete().eq('cart_id', cartId).in('id', lineIds);
  if (error) {
    throw error;
  }
}

/**
 * カートと、サーバーが計算した割引前の金額を読む（create-session と同じ読み方）。
 * 買える明細だけで金額を出す。画面（GET /api/cart）に出ている明細と同じなので、割引の目安が画面の小計とずれない（FREQ-401）。
 * 買えない明細があっても、ここでは断らず、消さない（割引コードの確かめは確かめだけで、カートを変えない）。DB の失敗は投げる。
 */
export async function loadCheckoutCart(supabase: SupabaseClient, cartId: string | null): Promise<CheckoutCartLoad> {
  if (!cartId) {
    return { kind: 'empty' };
  }
  const cartRows = await readCheckoutCartRows(supabase, cartId);
  if (cartRows.length === 0) {
    return { kind: 'empty' };
  }

  // 商品は create-session と同じく状態で絞らずに読み、買えるかどうかは splitPurchasableCartRows で分ける
  const { data: itemsData, error: itemsError } = await supabase
    .from('items')
    .select('id, name, price, image_url, status')
    .in(
      'id',
      cartRows.map((row) => row.item_id),
    );
  if (itemsError) {
    throw itemsError;
  }

  const items = (itemsData ?? []) as CheckoutItemSnapshotRow[];
  const { purchasable } = splitPurchasableCartRows(cartRows, items);
  if (purchasable.length === 0) {
    return { kind: 'empty' };
  }

  const itemMap = new Map<number, CheckoutItemSnapshotRow>(items.map((item) => [item.id, item]));
  return { kind: 'ok', cartRows: purchasable, itemMap, amounts: calculateCheckoutAmountsFromCartRows(purchasable, itemMap) };
}
