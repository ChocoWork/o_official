import type { SupabaseClient } from '@supabase/supabase-js';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  formatCurrency,
  formatItemLines,
  type ConfirmationItem,
  type OrderEmailRow,
} from '@/lib/orders/order-confirmation-email';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import type { OrderEmailKind, OrderEmailVariant } from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの材料を読み、件名と本文を作る（グループ D 設計書 4-2）。
 * 文面は今までのメール（注文確認・入金待ち・期限切れ・取消・発送）と同じにする。
 * 件名は固定の文と注文番号だけで組み、氏名や商品名は本文にだけ入れる（メールの見出しへの差し込みを防ぐ）。
 */
const SHOP_NAME = 'Le Fil des Heures';

const MATERIAL_ORDER_COLUMNS =
  'id, status, shipping_email, shipping_full_name, subtotal_amount, shipping_amount, discount_amount, total_amount, currency, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, shipping_phone, review_reason, shipping_carrier, tracking_number';

const PAID_LEAD = ['この度はご注文いただき誠にありがとうございます。', 'ご注文を承りました。'];

const PAID_AFTER_EXPIRY_LEAD = [
  'お支払い期限が過ぎたためご注文の取り消しをご案内しましたが、その後にお支払いを確認しました。',
  'ご注文は有効です。このまま商品をお届けします。',
];

const AWAITING_LEAD = [
  'ご注文を承りました。まだお支払いは完了していません。',
  'お支払い手続きの案内は、決済画面および Stripe からのメールをご確認ください。',
  'ご入金の確認後、あらためて確認メールをお送りします。',
];

export type OrderEmailMaterialRow = OrderEmailRow & {
  status: OrderStatus;
  shipping_carrier: string | null;
  tracking_number: string | null;
};

export type OrderEmailMaterial = { order: OrderEmailMaterialRow; items: ConfirmationItem[] };

export type ComposeRequest = {
  kind: OrderEmailKind;
  variant: OrderEmailVariant | null;
  /** 期限切れのメールを実際に送ったか。送っていなければ、期限切れの後の入金も普通の文面にする（設計書 4-1） */
  paymentExpiredSent: boolean;
};

export type ComposedOrderEmail = { subject: string; text: string };

/** 材料を読めなかった（DB の失敗）。worker は一時的な失敗としてやり直す */
export class OrderEmailMaterialError extends Error {
  constructor(
    readonly table: 'orders' | 'order_items',
    options?: { cause?: unknown },
  ) {
    super(`order email material could not be read: ${table}`, options);
    this.name = 'OrderEmailMaterialError';
  }
}

/** 注文行と明細を読む。注文が無い・明細が0件なら null（送れない）。読めなければ OrderEmailMaterialError を投げる */
export async function loadOrderEmailMaterial(
  store: Pick<SupabaseClient, 'from'>,
  orderId: string,
): Promise<OrderEmailMaterial | null> {
  const { data: order, error: orderError } = await store
    .from('orders')
    .select(MATERIAL_ORDER_COLUMNS)
    .eq('id', orderId)
    .maybeSingle<OrderEmailMaterialRow>();
  if (orderError) {
    throw new OrderEmailMaterialError('orders', { cause: orderError });
  }
  if (!order) {
    return null;
  }

  const { data: items, error: itemsError } = await store
    .from('order_items')
    .select('item_name, color, size, quantity, line_total, fulfillment_type')
    .eq('order_id', orderId);
  if (itemsError) {
    throw new OrderEmailMaterialError('order_items', { cause: itemsError });
  }
  if (!items || items.length === 0) {
    return null;
  }

  return { order, items: items as ConfirmationItem[] };
}

export function greeting(fullName: string | null): string {
  return fullName ? `${fullName} 様` : 'お客様';
}

function contactLine(orderId: string): string {
  return `お問い合わせの際は、注文番号（${toOrderNumber(orderId)}）をお問い合わせフォームにご入力ください。`;
}

function orderSummaryLines({ order, items }: OrderEmailMaterial): string[] {
  return [
    `注文番号: ${toOrderNumber(order.id)}`,
    '',
    'ご注文内容:',
    ...formatItemLines(items, order.currency),
    '',
    `合計: ${formatCurrency(order.total_amount, order.currency)}`,
  ];
}

function composeConfirmation(
  { order, items }: OrderEmailMaterial,
  state: 'paid' | 'awaiting_payment',
  leadLines: string[],
): ComposedOrderEmail {
  const orderNumber = toOrderNumber(order.id);
  const subject =
    state === 'awaiting_payment'
      ? `【お支払い待ち】ご注文を承りました（${orderNumber}）`
      : `【Le Fil des Heures】ご注文ありがとうございます（${orderNumber}）`;

  // 入金時に在庫を確保し直せなかった注文は、fulfillment_type が stock のままでも引渡しの時期を約束できない。
  const itemLines = formatItemLines(items, order.currency, { withFulfillment: order.review_reason !== 'stock_not_reserved' });

  // 空の項目で空行が出ないよう、値のある行だけを積む。
  const shippingLines = [
    order.shipping_full_name ? `${order.shipping_full_name} 様` : null,
    order.shipping_postal_code ? `〒${order.shipping_postal_code}` : null,
    [order.shipping_prefecture, order.shipping_city, order.shipping_address].filter(Boolean).join('') || null,
    order.shipping_building || null,
    order.shipping_phone || null,
  ].filter((line): line is string => Boolean(line));

  // 注文確定の RPC の COALESCE と同じく、取れないときは 0 として扱う。
  const discountAmount = order.discount_amount ?? 0;

  const text = [
    greeting(order.shipping_full_name),
    '',
    ...leadLines,
    '',
    `注文番号: ${orderNumber}`,
    '',
    'ご注文内容:',
    ...itemLines,
    '',
    `小計: ${formatCurrency(order.subtotal_amount, order.currency)}`,
    `送料: ${order.shipping_amount > 0 ? formatCurrency(order.shipping_amount, order.currency) : '無料'}`,
    // 値引があるときだけ出す。書き方は注文詳細（/api/orders/[id]）と同じ「-￥1,000」（FREQ-396）
    ...(discountAmount > 0 ? [`割引: -${formatCurrency(discountAmount, order.currency)}`] : []),
    `合計: ${formatCurrency(order.total_amount, order.currency)}`,
    '',
    'お届け先:',
    ...shippingLines,
    '',
    contactLine(order.id),
    '',
    SHOP_NAME,
  ].join('\n');

  return { subject, text };
}

function composeExpired(material: OrderEmailMaterial): ComposedOrderEmail {
  const { order } = material;
  return {
    subject: `【${SHOP_NAME}】お支払い期限切れのお知らせ（${toOrderNumber(order.id)}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      'お支払い期限が過ぎたため、ご注文を取り消しました。',
      'お支払いは発生していません。引き続きご購入を希望される場合は、あらためてご注文ください。',
      '',
      ...orderSummaryLines(material),
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

function composeCanceled(material: OrderEmailMaterial, previousStatus: 'payment_in_progress' | 'pending'): ComposedOrderEmail {
  const { order } = material;
  const lead =
    previousStatus === 'payment_in_progress'
      ? 'お手続き中のご注文を取り消しました。'
      : 'お支払い待ちのご注文を取り消しました。';
  return {
    subject: `【${SHOP_NAME}】ご注文取消のお知らせ（${toOrderNumber(order.id)}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      lead,
      'お支払いは発生していません。',
      '',
      ...orderSummaryLines(material),
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

/** 配送業者か伝票番号が無ければ作らない（送れない材料の不足） */
function composeShipped({ order }: OrderEmailMaterial): ComposedOrderEmail | null {
  const trackingNumber = order.tracking_number?.trim();
  if (!isShippingCarrierId(order.shipping_carrier) || !trackingNumber) {
    return null;
  }
  const orderNumber = toOrderNumber(order.id);
  const carrier = SHIPPING_CARRIERS[order.shipping_carrier];
  return {
    subject: `【Le Fil des Heures】商品を発送いたしました（${orderNumber}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      'ご注文の商品を発送いたしました。',
      '',
      `注文番号: ${orderNumber}`,
      '',
      `配送業者: ${carrier.label}`,
      `追跡番号: ${trackingNumber}`,
      `追跡はこちら: ${carrier.trackingUrl(trackingNumber)}`,
      '',
      '※ 追跡情報は反映までに数時間かかる場合があります。',
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

/** 件名と本文を作る。材料が足りなければ null */
export function composeOrderEmail(material: OrderEmailMaterial, request: ComposeRequest): ComposedOrderEmail | null {
  switch (request.kind) {
    case 'awaiting_payment':
      return composeConfirmation(material, 'awaiting_payment', AWAITING_LEAD);
    case 'paid':
      return composeConfirmation(
        material,
        'paid',
        request.variant === 'payment_received_after_expiry' && request.paymentExpiredSent ? PAID_AFTER_EXPIRY_LEAD : PAID_LEAD,
      );
    case 'payment_expired':
      return composeExpired(material);
    case 'canceled':
      return composeCanceled(material, request.variant === 'payment_in_progress' ? 'payment_in_progress' : 'pending');
    case 'shipped':
      return composeShipped(material);
  }
}
