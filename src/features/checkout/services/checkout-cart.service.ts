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

/**
 * カートと、サーバーが計算した割引前の金額を読む（create-session と同じ読み方・同じ規則）。
 * 非公開・削除された商品があれば買えない（FREQ-401）。DB の失敗は投げる。
 */
export async function loadCheckoutCart(supabase: SupabaseClient, sessionId: string): Promise<CheckoutCartLoad> {
  const { data: cartData, error: cartError } = await supabase
    .from('carts')
    .select('id, item_id, quantity, color, size')
    .eq('session_id', sessionId);
  if (cartError) {
    throw cartError;
  }
  if (!cartData || cartData.length === 0) {
    return { kind: 'empty' };
  }

  const cartRows = cartData as CheckoutCartSnapshotRow[];
  const { data: itemsData, error: itemsError } = await supabase
    .from('items')
    .select('id, name, price, image_url, status')
    .in(
      'id',
      cartRows.map((row) => row.item_id),
    )
    .eq('status', 'published');
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
