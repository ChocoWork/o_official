import type { SupabaseClient } from '@supabase/supabase-js';
import { previewFulfillment } from '@/features/checkout/services/checkout-fulfillment.service';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { CART_OPTION_NAMES, EMPTY_CART_JSON, type CartJson, type CartJsonLine } from '@/features/cart/types/cart-json';

type CartLineRow = {
  id: string;
  quantity: number;
  added_at: string;
  item_variants: {
    id: number;
    item_id: number;
    is_active: boolean;
    item_colors: { name: string } | null;
    item_sizes: { label: string } | null;
    items: { id: number; name: string; price: number; image_url: string | null; status: string } | null;
  } | null;
};

/**
 * カート全体を Shopify の /cart.js と同じ形で組み立てる（設計書 6-1）。印 token は返さない。
 * 非公開の商品と取り扱い終了のバリアントの明細は出さない（本計画の決め事 P14）。並びは入れた日時の新しい順。
 * 同じ日時でも並びが変わらないよう、次に明細の id の昇順で並べる。
 */
export async function buildCartJson(supabase: SupabaseClient, cartId: string | null): Promise<CartJson> {
  if (!cartId) {
    return { ...EMPTY_CART_JSON, items: [] };
  }

  const { data, error } = await supabase
    .from('cart_lines')
    .select('id, quantity, added_at, item_variants(id, item_id, is_active, item_colors(name), item_sizes(label), items(id, name, price, image_url, status))')
    .eq('cart_id', cartId)
    .order('added_at', { ascending: false })
    .order('id', { ascending: true });
  if (error) {
    throw error;
  }

  const rows = ((data ?? []) as unknown as CartLineRow[]).filter(
    (row) => row.item_variants?.is_active === true && row.item_variants.items?.status === 'published',
  );

  let fulfillments: Array<'stock' | 'backorder' | null> = rows.map(() => null);
  try {
    const preview = await previewFulfillment(
      supabase,
      rows.map((row) => ({
        item_id: Number(row.item_variants!.item_id),
        color: row.item_variants!.item_colors?.name ?? null,
        size: row.item_variants!.item_sizes?.label ?? null,
        quantity: row.quantity,
      })),
    );
    fulfillments = rows.map((_, index) => preview.find((line) => line.lineNo === index + 1)?.fulfillment ?? null);
  } catch (previewError) {
    console.error('Failed to preview cart fulfillment:', previewError);
  }

  const items: CartJsonLine[] = await Promise.all(
    rows.map(async (row, index) => {
      const variant = row.item_variants!;
      const item = variant.items!;
      const color = variant.item_colors?.name ?? null;
      const size = variant.item_sizes?.label ?? null;
      const variantTitle = [color, size].filter((value): value is string => Boolean(value)).join(' / ') || null;
      const options = [
        color ? { name: CART_OPTION_NAMES.color, value: color } : null,
        size ? { name: CART_OPTION_NAMES.size, value: size } : null,
      ].filter((option): option is NonNullable<typeof option> => option !== null);
      return {
        key: row.id,
        id: Number(variant.id),
        variant_id: Number(variant.id),
        product_id: Number(item.id),
        quantity: row.quantity,
        title: variantTitle ? `${item.name} - ${variantTitle}` : item.name,
        product_title: item.name,
        variant_title: variantTitle,
        options_with_values: options,
        price: item.price,
        line_price: item.price * row.quantity,
        image: (await signItemImageUrl(supabase, item.image_url)) ?? item.image_url,
        url: `/item/${item.id}`,
        fulfillment: fulfillments[index],
      };
    }),
  );

  const subtotal = items.reduce((sum, line) => sum + line.line_price, 0);
  return {
    item_count: items.reduce((sum, line) => sum + line.quantity, 0),
    currency: 'JPY',
    items_subtotal_price: subtotal,
    total_price: subtotal,
    items,
  };
}
