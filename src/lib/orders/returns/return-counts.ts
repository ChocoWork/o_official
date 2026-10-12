import type { SupabaseClient } from '@supabase/supabase-js';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';

/**
 * 注文の「返品できる数」の合計（グループ E-3 設計書 4-8）。返品の画面の下の「返品できる品: あと{n}点」に使う。
 * 数え方は DB の関数 list_order_line_return_counts の1か所（注文の商品ごとの returnable）で、ここでは足すだけ。
 * 呼ぶのは返品の一覧の窓口だけ（ほかの窓口は返品できる数を持たない）。
 * サーバーだけで使う（画面から読まない）。単体テストが直接読むので、サーバー専用の印（server-only）は付けない。
 */
export async function loadReturnableUnits(client: Pick<SupabaseClient, 'rpc'>, orderId: string): Promise<number> {
  const { data, error } = await client.rpc('list_order_line_return_counts', { _order_ids: [orderId] });
  if (error) {
    throw new RefundStoreError('list_order_line_return_counts', error);
  }
  // 表を返す関数の答えは配列。数えられない行（null）は 0 として足す
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  return rows.reduce((total, row) => total + Number(row.returnable ?? 0), 0);
}
