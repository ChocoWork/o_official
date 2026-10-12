import type { SupabaseClient } from '@supabase/supabase-js';
import { findMissingShippingFields } from '@/features/checkout/services/checkout-draft.service';
import { toOrderNumber } from '@/lib/orders/order-number';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { deriveOrderProgress } from '@/lib/orders/order-progress';
import {
  FulfillmentStoreError,
  listOrderFulfillments,
  listOrderLineFulfillment,
} from '@/lib/orders/fulfillment/fulfillment-store';
import type {
  FulfillmentBlockedReason,
  FulfillmentMaterialLine,
  FulfillmentMaterials,
} from '@/lib/orders/fulfillment/fulfillment-types';
import { listOrderReturns } from '@/lib/orders/returns/return-store';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';

type MaterialOrderRow = {
  id: string;
  status: OrderStatus;
  shipping_email: string | null;
  shipping_full_name: string | null;
  shipping_postal_code: string | null;
  shipping_prefecture: string | null;
  shipping_city: string | null;
  shipping_address: string | null;
  shipping_phone: string | null;
};

type MaterialItemRow = {
  id: string;
  item_name: string;
  color: string | null;
  size: string | null;
  /** 交換の品の行は exchange。読めなかった行（古い見本）は order と同じに扱う */
  line_kind?: 'order' | 'exchange';
};

const ORDER_COLUMNS =
  'id, status, shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_phone';

/**
 * 発送の画面が開いた時に読む材料（グループ E-1 設計書 6-1・6-2）。service_role の client で読む。
 * 発送できない理由 blockedReason は、DB の関数 admin_create_fulfillment が断る理由を画面が先に知らせるために出す
 * （決済完了でない → 配送先が足りない → 支払額の違いの要対応が残っている、の順）。DB の判定と全く同じではなく、2点が違う。
 * - 空白だけの欄は、画面の方が厳しく見る（JS の trim は全角空白も除く。DB の btrim は半角空白だけ）
 * - 未発送の品が無い決済完了の注文は、DB だけが断る（ORDER_NOT_SHIPPABLE）
 * 交換の品の行（返品の交換で足した行）があれば、返品の一覧から、手数料のお支払いを待っていて送れない数も出す（グループ E-3 設計書 7-1）。
 * 注文が無ければ null。
 */
export async function loadFulfillmentMaterials(client: SupabaseClient, orderId: string): Promise<FulfillmentMaterials | null> {
  const { data: order, error: orderError } = await client
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .maybeSingle<MaterialOrderRow>();
  if (orderError) {
    throw new FulfillmentStoreError('load_order', orderError);
  }
  if (!order) {
    return null;
  }

  // ここから先は、呼び出し側が渡した文字ではなく、DB が返した番号（小文字）で引く
  const [itemsResult, exceptionsResult, countsByOrder, fulfillmentRows] = await Promise.all([
    // 同じ注文の商品は同じ時刻に登録されるので、id を足して並びを決める
    client
      .from('order_items')
      .select('id, item_name, color, size, line_kind')
      .eq('order_id', order.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
    // 管理画面の一覧（src/app/api/admin/orders/route.ts）と、発送の DB の関数が断る条件と同じ
    client
      .from('payment_exceptions')
      .select('order_id')
      .eq('order_id', order.id)
      .eq('reason', 'paid_amount_mismatch')
      .is('resolved_at', null),
    listOrderLineFulfillment(client, [order.id]),
    listOrderFulfillments(client, order.id),
  ]);
  if (itemsResult.error) {
    throw new FulfillmentStoreError('load_order_items', itemsResult.error);
  }
  if (exceptionsResult.error) {
    throw new FulfillmentStoreError('load_payment_exceptions', exceptionsResult.error);
  }

  const counts = new Map((countsByOrder.get(order.id) ?? []).map((row) => [row.orderItemId, row] as const));
  const itemRows = (itemsResult.data ?? []) as MaterialItemRow[];
  // 交換の品の行がある時だけ、返品の一覧を読む（交換の品の無い注文が、返品のために余分に読まないように）。
  // 手数料のお支払いを待っている返品の交換の品は、送れない数として写す
  const heldItemIds = itemRows.some((item) => item.line_kind === 'exchange')
    ? heldExchangeItemIds(await listOrderReturns(client, order.id))
    : new Set<string>();
  const lines = itemRows.flatMap((item): FulfillmentMaterialLine[] => {
    const row = counts.get(item.id);
    if (!row) {
      return [];
    }
    return [{
      orderItemId: item.id,
      name: item.item_name,
      color: item.color,
      size: item.size,
      fulfillmentType: row.fulfillmentType === 'backorder' ? 'backorder' : 'stock',
      quantity: row.quantity,
      shipped: row.shipped,
      inProduction: row.inProduction,
      readyUnshipped: row.readyUnshipped,
      unshipped: row.unshipped,
      lineKind: item.line_kind === 'exchange' ? 'exchange' : 'order',
      // 手数料待ちで止まるのは、その行の未発送の数の全部（一部だけ止まることは無い）
      exchangeOnHold: heldItemIds.has(item.id) ? row.unshipped : 0,
    }];
  });

  const paymentReviewOpen = (exceptionsResult.data ?? []).length > 0;

  return {
    order: { id: order.id, orderNumber: toOrderNumber(order.id), status: order.status, progress: deriveOrderProgress(order.status, lines) },
    blockedReason: blockedReasonOf(order, paymentReviewOpen),
    lines,
    fulfillments: fulfillmentRows.map((row) => ({
      id: row.fulfillmentId,
      number: row.number,
      carrier: row.shippingCarrier,
      trackingNumber: row.trackingNumber,
      shippedAt: row.shippedAt,
      notifyCustomer: row.notifyCustomer,
      completesOrder: row.completesOrder,
      cancelledAt: row.cancelledAt,
      lines: row.lines,
    })),
  };
}

function blockedReasonOf(order: MaterialOrderRow, paymentReviewOpen: boolean): FulfillmentBlockedReason | null {
  if (order.status !== 'paid') {
    return 'not_shippable';
  }
  const missingFields = findMissingShippingFields({
    email: order.shipping_email,
    fullName: order.shipping_full_name,
    kanaName: null,
    postalCode: order.shipping_postal_code,
    prefecture: order.shipping_prefecture,
    city: order.shipping_city,
    address: order.shipping_address,
    building: null,
    phone: order.shipping_phone,
  });
  if (missingFields.length > 0) {
    return 'address_incomplete';
  }
  return paymentReviewOpen ? 'payment_review_required' : null;
}


/**
 * 手数料のお支払いを待っている返品の、交換の品の行の番号。DB の関数 admin_create_fulfillment が FULFILLMENT_EXCHANGE_ON_HOLD で
 * 断る条件と同じ（その返品に払う手数料があり、受け取りの記録も「支払いを待たずに送る」も無い）。
 */
function heldExchangeItemIds(returns: readonly OrderReturnDetail[]): Set<string> {
  return new Set(
    returns
      .filter((detail) => detail.fees.feeDueAmount > 0 && detail.fees.feeReceivedAt === null && detail.fees.exchangeReleasedAt === null)
      .flatMap((detail) => detail.exchangeItems.map((item) => item.orderItemId)),
  );
}
