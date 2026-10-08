import type { SupabaseClient } from '@supabase/supabase-js';
import { buildInventoryConflictBody, collectInventoryIssues } from '@/features/cart/services/cart-stock';
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
  | { kind: 'unavailable'; body: ReturnType<typeof buildInventoryConflictBody> }
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
 * カートと、サーバーが計算した割引前の金額を読む（create-session と同じ読み方・同じ規則）。
 * 非公開・削除された商品、取り扱いを終えた色・サイズがあれば買えない（FREQ-401）。DB の失敗は投げる。
 */
export async function loadCheckoutCart(supabase: SupabaseClient, cartId: string | null): Promise<CheckoutCartLoad> {
  if (!cartId) {
    return { kind: 'empty' };
  }
  const cartRows = await readCheckoutCartRows(supabase, cartId);
  if (cartRows.length === 0) {
    return { kind: 'empty' };
  }

  // 非公開の商品も名前で案内するため、create-session と同じく状態で絞らずに読む
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
  const issues = collectInventoryIssues(cartRows, items);
  if (issues.length > 0) {
    return { kind: 'unavailable', body: buildInventoryConflictBody(issues, 'out_of_stock') };
  }

  const itemMap = new Map<number, CheckoutItemSnapshotRow>(items.map((item) => [item.id, item]));
  return { kind: 'ok', cartRows, itemMap, amounts: calculateCheckoutAmountsFromCartRows(cartRows, itemMap) };
}
