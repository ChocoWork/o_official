import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * 店頭に出す在庫の見え方（FREQ-400）。
 *
 * ブランドの前提は受注生産。在庫の有無は「買えるか」ではなく「納期」を分ける
 * （在庫あり = 3〜7営業日で発送 / 在庫なし = 受注生産で数週間〜2ヶ月。法令ページと同じ区分）。
 * どちらも買えるので、在庫を理由に注文を止めない。
 *
 * 公開するのは有無（真偽）だけで、残数は出さない。残数は在庫量そのものが外から分かるうえ、
 * 「あと1点」で急かす売り方になり、セールをしないというブランドの方針と合わない。
 *
 * item_variants は anon / authenticated から読めない（実測）。店頭の読み出しはサーバ側でしか
 * 走らないため、ここだけ service role で読み、公開中の商品に絞ったうえで必要な形に落として返す。
 * 匿名に SELECT を開くより、出す物をこの1か所で決めるほうが漏れが起きにくい。
 */

export type VariantAvailability = {
  colorName: string | null;
  sizeLabel: string | null;
  /** すぐ出せるか。false は「買えない」ではなく「受注生産になる」 */
  inStock: boolean;
  /** バリアントの番号。カートに入れる窓口（/api/cart/add）へ送る（Shopify も公開している番号） */
  variantId: number;
};

export type ItemAvailability = {
  /** すぐ出せる組み合わせが1つも無い */
  madeToOrder: boolean;
  combinations: VariantAvailability[];
};

type VariantRow = {
  id: number;
  item_id: number;
  stock_quantity: number;
  is_active: boolean;
  item_colors: { name: string } | null;
  item_sizes: { label: string } | null;
};

/** 組み合わせが分からないときの既定。商品詳細では納期を出さず、再試行を案内する。 */
const UNKNOWN_AVAILABILITY: ItemAvailability = { madeToOrder: true, combinations: [] };

export async function getItemsAvailability(
  itemIds: number[],
): Promise<Map<number, ItemAvailability>> {
  const result = new Map<number, ItemAvailability>();
  if (itemIds.length === 0) {
    return result;
  }

  const fallback = () => {
    for (const itemId of itemIds) {
      result.set(itemId, { ...UNKNOWN_AVAILABILITY });
    }
    return result;
  };

  try {
    const supabase = await createServiceRoleClient();
    const { data, error } = await supabase
      .from('item_variants')
      .select('id, item_id, stock_quantity, is_active, item_colors(name), item_sizes(label), items!inner(status)')
      .in('item_id', itemIds)
      .eq('items.status', 'published');

    if (error) {
      console.error('Failed to fetch item variant availability:', error);
      return fallback();
    }

    for (const itemId of itemIds) {
      result.set(itemId, { madeToOrder: true, combinations: [] });
    }

    for (const row of (data ?? []) as unknown as VariantRow[]) {
      const entry = result.get(row.item_id);
      if (!entry || !row.is_active) continue;

      // 販売中の組み合わせだけに納期を付け、取り扱い終了を受注生産と誤表示しない。
      const inStock = row.stock_quantity > 0;
      entry.combinations.push({
        colorName: row.item_colors?.name ?? null,
        sizeLabel: row.item_sizes?.label ?? null,
        inStock,
        variantId: Number(row.id),
      });
      if (inStock) {
        entry.madeToOrder = false;
      }
    }

    return result;
  } catch (error) {
    console.error('Failed to fetch item variant availability:', error);
    return fallback();
  }
}

/** 1商品分だけ引く。商品詳細から使う。 */
export async function getItemAvailability(itemId: number): Promise<ItemAvailability> {
  const map = await getItemsAvailability([itemId]);
  return map.get(itemId) ?? { ...UNKNOWN_AVAILABILITY };
}
