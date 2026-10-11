import type { SupabaseClient } from '@supabase/supabase-js';
import { toOrderNumber } from '@/lib/orders/order-number';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import type { RefundMaterialLine, RefundMaterials, RefundPaymentMethod } from '@/lib/orders/refund/refund-types';

type MaterialItemRow = { id: string; item_name: string; color: string | null; size: string | null };

/**
 * 返金の画面の支払い方法。お客様の注文の窓口（src/app/api/orders/[id]/route.ts）と同じく checkout_drafts.payment_method から読む。
 * 値は stripe_card・stripe_paypay・stripe_konbini・link のほか、Stripe の種別がそのまま入る（mapStripePaymentMethodType）。
 * 返金の案内を分ける4つ以外は unknown にする。実際に返金を頼む時の支払いの種類は、Stripe の支払いから読む（本計画 P10）。
 */
function toPaymentMethod(value: string | null): RefundPaymentMethod {
  switch (value) {
    case 'stripe_card':
      return 'card';
    case 'link':
      return 'link';
    case 'stripe_paypay':
      return 'paypay';
    case 'stripe_konbini':
      return 'konbini';
    default:
      return 'unknown';
  }
}

/** DB の材料の lines（jsonb の配列）を、商品の番号で引ける形にする */
function countsByItemId(value: unknown): Map<string, Record<string, unknown>> {
  const lines = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  return new Map(lines.map((line) => [String(line.order_item_id), line] as const));
}

/**
 * 返金の画面が開いた時に読む材料（グループ E-2 設計書 5-2）。service_role の client で読む。注文が無ければ null。
 * 数・金額・割り振った割引は DB の関数 load_order_refund_materials が出す（数え方は DB の1か所）。
 * ここでは、商品の名前・色・サイズ（order_items）と支払い方法（checkout_drafts）を足し、商品を登録順に並べる。
 * サーバーだけで使う（画面から読まない）。単体テストが直接読むので、サーバー専用の印（server-only）は付けない。
 */
export async function loadRefundMaterials(client: SupabaseClient, orderId: string): Promise<RefundMaterials | null> {
  const { data, error } = await client.rpc('load_order_refund_materials', { _order_id: orderId });
  if (error) {
    throw new RefundStoreError('load_order_refund_materials', error);
  }
  // 表を返す関数の答えは配列。行が1つのオブジェクトで来ても読める。注文が無ければ0行
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row) {
    return null;
  }

  // ここから先は、呼び出し側が渡した文字ではなく、DB が返した番号（小文字）で引く
  const dbOrderId = String(row.order_id);
  const [orderResult, itemsResult] = await Promise.all([
    // DB の材料の関数は支払いの番号を返さない。宛先・氏名・メールは読まない
    client.from('orders').select('payment_intent_id').eq('id', dbOrderId).maybeSingle<{ payment_intent_id: string | null }>(),
    // 同じ注文の商品は同じ時刻に登録されるので、id を足して並びを決める
    client
      .from('order_items')
      .select('id, item_name, color, size')
      .eq('order_id', dbOrderId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ]);
  if (orderResult.error) {
    throw new RefundStoreError('load_order', orderResult.error);
  }
  if (itemsResult.error) {
    throw new RefundStoreError('load_order_items', itemsResult.error);
  }

  // 支払い方法（checkout_drafts に注文確定時の payment_intent_id が書き戻されている）
  const paymentIntentId = orderResult.data?.payment_intent_id ?? null;
  let draftPaymentMethod: string | null = null;
  if (paymentIntentId) {
    const draftResult = await client
      .from('checkout_drafts')
      .select('payment_method')
      .eq('payment_intent_id', paymentIntentId)
      .limit(1)
      .maybeSingle<{ payment_method: string }>();
    if (draftResult.error) {
      throw new RefundStoreError('load_checkout_draft', draftResult.error);
    }
    draftPaymentMethod = draftResult.data?.payment_method ?? null;
  }

  const counts = countsByItemId(row.lines);
  const lines = ((itemsResult.data ?? []) as MaterialItemRow[]).flatMap((item): RefundMaterialLine[] => {
    const line = counts.get(item.id);
    if (!line) {
      return [];
    }
    return [{
      orderItemId: item.id,
      name: item.item_name,
      color: item.color,
      size: item.size,
      fulfillmentType: line.fulfillment_type === 'backorder' ? 'backorder' : 'stock',
      itemPrice: Number(line.item_price),
      quantity: Number(line.quantity),
      lineTotal: Number(line.line_total),
      shipped: Number(line.shipped),
      unshipped: Number(line.unshipped),
      refundedBeforeShipment: Number(line.refunded_before_shipment),
      refundedAfterShipment: Number(line.refunded_after_shipment),
      shippedRefundable: Number(line.shipped_refundable),
      restockable: Number(line.restockable),
      lineDiscount: Number(line.line_discount),
      refundedUnits: Number(line.refunded_units),
    }];
  });

  // 受け取った額が空の注文（未入金）の金額は null で届く。Number(null) は 0
  return {
    order: {
      id: dbOrderId,
      orderNumber: toOrderNumber(dbOrderId),
      status: row.order_status as OrderStatus,
      paymentMethod: toPaymentMethod(draftPaymentMethod),
      totalAmount: Number(row.total_amount),
      shippingAmount: Number(row.shipping_amount),
      discountAmount: Number(row.discount_amount),
      paidAmount: Number(row.paid_amount),
      succeededAmount: Number(row.succeeded_amount),
      openAmount: Number(row.open_amount),
      refundableAmount: Number(row.refundable_amount),
      refundedShipping: Number(row.refunded_shipping),
      refundableShipping: Number(row.refundable_shipping),
      shippedTotal: Number(row.shipped_total),
      unshippedTotal: Number(row.unshipped_total),
    },
    lines,
    awaitingRefund: row.awaiting_refund_id
      ? {
          id: String(row.awaiting_refund_id),
          amount: Number(row.awaiting_refund_amount),
          createdAt: String(row.awaiting_refund_created_at),
        }
      : null,
  };
}
