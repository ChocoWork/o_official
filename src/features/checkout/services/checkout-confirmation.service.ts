import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CheckoutDraftItemSnapshot,
  CheckoutShippingSnapshot,
} from '@/features/checkout/services/checkout-draft.service';
import { previewFulfillment, type Fulfillment } from '@/features/checkout/services/checkout-fulfillment.service';

export type CheckoutConfirmationLine = {
  itemId: number;
  name: string;
  /** 税込みの単価（決済の画面の明細と同じ） */
  price: number;
  imageUrl: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  variantId: number | null;
  fulfillment: Fulfillment;
};

/** 最終確認画面に出す内容。決済の画面（Stripe の Checkout Session）の中身と同じものを見せる */
export type CheckoutConfirmation = {
  checkoutSessionId: string;
  clientSecret: string;
  shipping: CheckoutShippingSnapshot;
  lines: CheckoutConfirmationLine[];
  promotionCode: string | null;
};

const EMPTY_SHIPPING: CheckoutShippingSnapshot = {
  email: null,
  fullName: null,
  kanaName: null,
  postalCode: null,
  prefecture: null,
  city: null,
  address: null,
  building: null,
  phone: null,
};

type OrderItemFulfillmentRow = {
  item_id: number | string;
  color: string | null;
  size: string | null;
  variant_id: number | string | null;
  fulfillment_type: string;
};

function lineKey(itemId: number, color: string | null, size: string | null): string {
  return `${itemId}|${color ?? ''}|${size ?? ''}`;
}

/**
 * 最終確認画面に出す内容を作る（グループ F 設計書 2-3、計画の決め事 D8）。
 *
 * 明細・配送先は下書きの写し（決済の画面の中身と同じ）から作り、カートの今の中身は使わない。
 * お届けの目安は、受け付け済みなら確保した結果（注文の明細）、まだならその時点の在庫で決める。
 * 受け付けの後は在庫が確保の分だけ減っているので、読み直すと在庫ありの明細を受注生産と見せてしまう。
 */
export async function buildCheckoutConfirmation(
  deps: { supabase: SupabaseClient; signImageUrl(raw: string | null): Promise<string | null> },
  params: {
    checkoutSessionId: string;
    clientSecret: string;
    itemsSnapshot: CheckoutDraftItemSnapshot[];
    shippingSnapshot: CheckoutShippingSnapshot | null;
    promotionCode: string | null;
    acceptedOrderId: string | null;
  },
): Promise<CheckoutConfirmation> {
  const fulfillmentByKey = new Map<string, { variantId: number | null; fulfillment: Fulfillment }>();

  if (params.acceptedOrderId) {
    const { data, error } = await deps.supabase
      .from('order_items')
      .select('item_id, color, size, variant_id, fulfillment_type')
      .eq('order_id', params.acceptedOrderId);
    if (error) {
      throw error;
    }
    for (const row of (data ?? []) as OrderItemFulfillmentRow[]) {
      fulfillmentByKey.set(lineKey(Number(row.item_id), row.color, row.size), {
        variantId: row.variant_id === null ? null : Number(row.variant_id),
        fulfillment: row.fulfillment_type === 'stock' ? 'stock' : 'backorder',
      });
    }
  } else {
    const preview = await previewFulfillment(
      deps.supabase,
      params.itemsSnapshot.map((item) => ({
        item_id: item.item_id,
        color: item.color,
        size: item.size,
        quantity: item.quantity,
      })),
    );
    for (const line of preview) {
      fulfillmentByKey.set(lineKey(line.itemId, line.color, line.size), {
        variantId: line.variantId,
        fulfillment: line.fulfillment,
      });
    }
  }

  const lines = await Promise.all(
    params.itemsSnapshot.map(async (item): Promise<CheckoutConfirmationLine> => {
      const fulfillment = fulfillmentByKey.get(lineKey(item.item_id, item.color, item.size));
      return {
        itemId: item.item_id,
        name: item.item_name,
        price: item.item_price,
        imageUrl: await deps.signImageUrl(item.item_image_url),
        color: item.color,
        size: item.size,
        quantity: item.quantity,
        variantId: fulfillment?.variantId ?? null,
        // 分からない明細を「在庫あり」と見せると、お届けが遅れることを伝えられない
        fulfillment: fulfillment?.fulfillment ?? 'backorder',
      };
    }),
  );

  return {
    checkoutSessionId: params.checkoutSessionId,
    clientSecret: params.clientSecret,
    shipping: params.shippingSnapshot ?? EMPTY_SHIPPING,
    lines,
    promotionCode: params.promotionCode,
  };
}
