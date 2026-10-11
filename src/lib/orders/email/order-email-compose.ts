import type { SupabaseClient } from '@supabase/supabase-js';
import { toOrderNumber } from '@/lib/orders/order-number';
import {
  formatCurrency,
  formatItemLines,
  formatShipmentItemLines,
  itemLabel,
  type ConfirmationItem,
  type OrderEmailRow,
} from '@/lib/orders/order-confirmation-email';
import { listOrderLineFulfillment } from '@/lib/orders/fulfillment/fulfillment-store';
import type { CancelReason, OrderStatus } from '@/lib/orders/order-payment-types';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import type { OrderEmailKind, OrderEmailVariant, RefundEmailVariant } from '@/lib/orders/email/order-email-types';

/**
 * 注文のメールの材料を読み、件名と本文を作る（グループ D 設計書 4-2）。
 * 文面は今までのメール（注文確認・入金待ち・期限切れ・取消・発送）と同じにする。
 * 件名は固定の文と注文番号だけで組み、氏名や商品名は本文にだけ入れる（メールの見出しへの差し込みを防ぐ）。
 * 発送のメールは発送ごとに作り、その発送の商品と数・配送業者・伝票番号を発送の記録から読む（グループ E-1 設計書 8-1）。
 * 返金のお知らせと、支払い済みの注文のキャンセルのお知らせは返金ごとに作り、額・戻る時期・商品を返金の記録から読む（グループ E-2 設計書 8-1・8-2）。
 */
const SHOP_NAME = 'Le Fil des Heures';

// 配送業者と伝票番号は注文の行から読まない。注文の行の組は「全部を送った時の値」で、一部だけ送った間は空になるため
const MATERIAL_ORDER_COLUMNS =
  'id, status, shipping_email, shipping_full_name, subtotal_amount, shipping_amount, discount_amount, total_amount, currency, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, shipping_phone, review_reason';

const MATERIAL_FULFILLMENT_COLUMNS = 'number, shipping_carrier, tracking_number, completes_order, cancelled_at';
const MATERIAL_FULFILLMENT_LINE_COLUMNS = 'quantity, order_items(item_name, color, size)';

const MATERIAL_REFUND_COLUMNS = 'amount, shipping_amount, payment_method_type, customer_action_expires_at, cancel_reason';
// 商品の並び（作った時刻、同じなら番号）に使うので、商品の作った時刻も読む
const MATERIAL_REFUND_LINE_COLUMNS = 'order_item_id, quantity, before_shipment, order_items(item_name, color, size, created_at)';

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

/** 在庫の品と受注生産の品が両方ある注文の確認に添える1行（グループ E-1 設計書 8-3） */
const SPLIT_SHIPMENT_NOTICE = '在庫の品を先にお送りし、受注生産の品は仕上がり次第お送りします。';

/** 未発送の品が残る発送のメールに添える1行（グループ E-1 設計書 8-1） */
const REMAINING_ITEMS_NOTICE = '残りの商品は、準備ができ次第お送りします。';

/** 返金のお知らせの文（グループ E-2 設計書 8-1）。発送前の商品を返金した時／これから送る商品が残っている時／未入金のうちに取り消した注文へ後から入金があって全額を返した時（自動の返金①） */
const REFUND_NOT_SHIPPING_NOTICE = '返金した商品はお送りしません。';
const REFUND_STILL_SHIPPING_NOTICE = 'ほかの商品はこれまでどおりお送りします。';
const REFUND_AFTER_CANCEL_NOTICE = 'このご注文はお支払いの前に取り消し済みのため、お支払いいただいた金額を全額返金いたします。';

/** お金が戻る時期の文（グループ E-2 設計書 8-3） */
const REFUND_TIMING_CARD = 'ご返金は、カード会社によって5〜10営業日ほどで反映されます。';
const REFUND_TIMING_PAYPAY = 'ご返金は、PayPay 残高にすぐ反映されます。';
const REFUND_TIMING_UNKNOWN = 'ご返金が反映されるまでの日数は、お支払いの方法によって異なります。';
const refundTimingKonbini = (deadline: string) =>
  `Stripe（決済代行会社）から、返金先の口座を入力していただくためのメールが届きます。${deadline}までにご入力ください。期限を過ぎると返金できなくなります。`;

/** 支払い済みのキャンセルのお知らせの理由の文（グループ E-2 設計書 8-2）。不正の疑いは相手に知らせないため、その他と同じ文にする */
const PAID_CANCEL_LEAD_DEFAULT = 'ご注文を取り消しました。';
const PAID_CANCEL_LEADS: Record<CancelReason, string> = {
  stock_unavailable: '商品をご用意できなくなったため、ご注文を取り消しました。',
  customer_request: 'ご依頼により、ご注文を取り消しました。',
  suspected_fraud: PAID_CANCEL_LEAD_DEFAULT,
  other: PAID_CANCEL_LEAD_DEFAULT,
};

export type OrderEmailMaterialRow = OrderEmailRow & { status: OrderStatus };

/**
 * 発送のメールの材料。発送の記録から読む。
 * 取り消した発送も読み、取消済みの印を付ける（送るかどうかは worker が決める）。
 */
export type OrderEmailFulfillmentMaterial = {
  number: number;
  carrier: string | null;
  trackingNumber: string | null;
  completesOrder: boolean;
  cancelled: boolean;
  lines: Array<{ item_name: string; color: string | null; size: string | null; quantity: number }>;
};

/**
 * 返金のお知らせと、支払い済みのキャンセルのお知らせの材料。返金の記録から読む。
 * 商品の行は、同じ商品の発送前と発送後を1行にまとめた形。stillShipping は、返金の後もこれから送る商品が残っているか。
 */
export type OrderEmailRefundMaterial = {
  amount: number;
  shippingAmount: number;
  paymentMethodType: string | null;
  customerActionExpiresAt: string | null;
  cancelReason: CancelReason | null;
  lines: Array<{ item_name: string; color: string | null; size: string | null; quantity: number; before_shipment: boolean }>;
  stillShipping: boolean;
};

export type OrderEmailMaterial = {
  order: OrderEmailMaterialRow;
  items: ConfirmationItem[];
  /** 発送のメールの時だけ読む。ほかの種類は null */
  fulfillment: OrderEmailFulfillmentMaterial | null;
  /** 返金のお知らせと、支払い済みのキャンセルのお知らせの時だけ読む。ほかの種類は null */
  refund: OrderEmailRefundMaterial | null;
};

export type ComposeRequest = {
  kind: OrderEmailKind;
  variant: OrderEmailVariant | null;
  /** 期限切れのメールを実際に送ったか。送っていなければ、期限切れの後の入金も普通の文面にする（設計書 4-1） */
  paymentExpiredSent: boolean;
};

export type ComposedOrderEmail = { subject: string; text: string };

/** 材料を読めなかった（DB の失敗）。worker は一時的な失敗としてやり直す。table は読んだ表か、DB の関数の名前 */
export class OrderEmailMaterialError extends Error {
  constructor(
    readonly table:
      | 'orders'
      | 'order_items'
      | 'order_fulfillments'
      | 'order_fulfillment_lines'
      | 'order_refunds'
      | 'order_refund_lines'
      | 'list_order_line_fulfillment',
    options?: { cause?: unknown },
  ) {
    super(`order email material could not be read: ${table}`, options);
    this.name = 'OrderEmailMaterialError';
  }
}

type FulfillmentRow = {
  number: number;
  shipping_carrier: string | null;
  tracking_number: string | null;
  completes_order: boolean;
  cancelled_at: string | null;
};

type FulfillmentLineRow = {
  quantity: number;
  order_items: { item_name: string; color: string | null; size: string | null };
};

type RefundRow = {
  amount: number;
  shipping_amount: number;
  payment_method_type: string | null;
  customer_action_expires_at: string | null;
  cancel_reason: CancelReason | null;
};

type RefundLineRow = {
  order_item_id: string;
  quantity: number;
  before_shipment: boolean;
  order_items: { item_name: string; color: string | null; size: string | null; created_at: string };
};

/** その注文の発送と発送の商品を読む。発送が無い・発送の商品が0件なら null（送れない）。取り消した発送も読む */
async function loadFulfillmentMaterial(
  store: Pick<SupabaseClient, 'from'>,
  orderId: string,
  fulfillmentId: string,
): Promise<OrderEmailFulfillmentMaterial | null> {
  // 注文の番号でも絞る。取り出した行の注文と発送の組が食い違っても、ほかの注文の発送の中身をこの注文のお客様へ送らない
  const { data: fulfillment, error: fulfillmentError } = await store
    .from('order_fulfillments')
    .select(MATERIAL_FULFILLMENT_COLUMNS)
    .eq('id', fulfillmentId)
    .eq('order_id', orderId)
    .maybeSingle<FulfillmentRow>();
  if (fulfillmentError) {
    throw new OrderEmailMaterialError('order_fulfillments', { cause: fulfillmentError });
  }
  if (!fulfillment) {
    return null;
  }

  const { data, error: linesError } = await store
    .from('order_fulfillment_lines')
    .select(MATERIAL_FULFILLMENT_LINE_COLUMNS)
    .eq('fulfillment_id', fulfillmentId);
  if (linesError) {
    throw new OrderEmailMaterialError('order_fulfillment_lines', { cause: linesError });
  }
  const lines = (data ?? []) as unknown as FulfillmentLineRow[];
  if (lines.length === 0) {
    return null;
  }

  return {
    number: fulfillment.number,
    carrier: fulfillment.shipping_carrier,
    trackingNumber: fulfillment.tracking_number,
    completesOrder: fulfillment.completes_order,
    cancelled: fulfillment.cancelled_at !== null,
    lines: lines.map((line) => ({
      item_name: line.order_items.item_name,
      color: line.order_items.color,
      size: line.order_items.size,
      quantity: line.quantity,
    })),
  };
}

/**
 * 返金の商品の行を、お客様に見せる形にする。同じ商品の発送前と発送後の行は1行にまとめ（数は足し、発送前の印は1つでもあれば付ける）、
 * 商品の登録順（作った時刻、同じなら番号。管理画面の材料と同じ並び）に並べる。DB が行を返す順には頼らない
 */
function toRefundMaterialLines(rows: readonly RefundLineRow[]): OrderEmailRefundMaterial['lines'] {
  const byItem = new Map<string, RefundLineRow>();
  for (const row of rows) {
    const same = byItem.get(row.order_item_id);
    byItem.set(
      row.order_item_id,
      same
        ? { ...same, quantity: same.quantity + row.quantity, before_shipment: same.before_shipment || row.before_shipment }
        : row,
    );
  }
  return [...byItem.values()]
    .sort(
      (a, b) =>
        Date.parse(a.order_items.created_at) - Date.parse(b.order_items.created_at)
        || a.order_item_id.localeCompare(b.order_item_id),
    )
    .map((row) => ({
      item_name: row.order_items.item_name,
      color: row.order_items.color,
      size: row.order_items.size,
      quantity: row.quantity,
      before_shipment: row.before_shipment,
    }));
}

/**
 * 返金の後も、これから送る商品が残っているか。数え方は DB の1か所（list_order_line_fulfillment の未発送）に任せる。
 * 決済完了の注文だけ数える: DB の未発送は注文の状態を見ず、取り消した注文の商品も数えるので、
 * 取り消した注文（自動の返金①など）に「ほかの商品はお送りします」と書かないため
 */
async function hasItemsToShip(store: Pick<SupabaseClient, 'rpc'>, order: OrderEmailMaterialRow): Promise<boolean> {
  if (order.status !== 'paid') {
    return false;
  }
  try {
    const countsByOrder = await listOrderLineFulfillment(store, [order.id]);
    return (countsByOrder.get(order.id) ?? []).some((line) => line.unshipped > 0);
  } catch (error) {
    throw new OrderEmailMaterialError('list_order_line_fulfillment', { cause: error });
  }
}

/** その注文の返金の額・送料・支払い方法・商品の行を読む。返金の記録が無ければ null（送れない）。商品の行が0件（額だけの返金）は材料にする */
async function loadRefundMaterial(
  store: Pick<SupabaseClient, 'from' | 'rpc'>,
  order: OrderEmailMaterialRow,
  refundId: string,
): Promise<OrderEmailRefundMaterial | null> {
  // 注文の番号でも絞る。取り出した行の注文と返金の組が食い違っても、ほかの注文の返金の中身をこの注文のお客様へ送らない
  const { data: refund, error: refundError } = await store
    .from('order_refunds')
    .select(MATERIAL_REFUND_COLUMNS)
    .eq('id', refundId)
    .eq('order_id', order.id)
    .maybeSingle<RefundRow>();
  if (refundError) {
    throw new OrderEmailMaterialError('order_refunds', { cause: refundError });
  }
  if (!refund) {
    return null;
  }

  const { data, error: linesError } = await store
    .from('order_refund_lines')
    .select(MATERIAL_REFUND_LINE_COLUMNS)
    .eq('refund_id', refundId);
  if (linesError) {
    throw new OrderEmailMaterialError('order_refund_lines', { cause: linesError });
  }

  return {
    amount: refund.amount,
    shippingAmount: refund.shipping_amount,
    paymentMethodType: refund.payment_method_type,
    customerActionExpiresAt: refund.customer_action_expires_at,
    cancelReason: refund.cancel_reason,
    lines: toRefundMaterialLines((data ?? []) as unknown as RefundLineRow[]),
    stillShipping: await hasItemsToShip(store, order),
  };
}

/**
 * 注文行と明細を読む。発送の番号があれば、その発送も読む。返金の番号があれば、その返金も読む。
 * 注文が無い・明細が0件・発送が無い・発送の商品が0件・返金の記録が無ければ null（送れない）。読めなければ OrderEmailMaterialError を投げる
 */
export async function loadOrderEmailMaterial(
  store: Pick<SupabaseClient, 'from' | 'rpc'>,
  orderId: string,
  fulfillmentId: string | null = null,
  refundId: string | null = null,
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

  let fulfillment: OrderEmailFulfillmentMaterial | null = null;
  if (fulfillmentId !== null) {
    fulfillment = await loadFulfillmentMaterial(store, orderId, fulfillmentId);
    if (!fulfillment) {
      return null;
    }
  }

  let refund: OrderEmailRefundMaterial | null = null;
  if (refundId !== null) {
    refund = await loadRefundMaterial(store, order, refundId);
    if (!refund) {
      return null;
    }
  }

  return { order, items: items as ConfirmationItem[], fulfillment, refund };
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

/** 在庫の品と受注生産の品が両方ある注文だけ、先に在庫の品を送る案内を出す（グループ E-1 設計書 8-3） */
function hasStockAndBackorder(items: ConfirmationItem[]): boolean {
  return items.some((item) => item.fulfillment_type === 'stock') && items.some((item) => item.fulfillment_type === 'backorder');
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
  // お届けの目安も、先に在庫の品を送る案内も書かない。
  const canPromiseDelivery = order.review_reason !== 'stock_not_reserved';
  const itemLines = formatItemLines(items, order.currency, { withFulfillment: canPromiseDelivery });
  const showSplitShipmentNotice = canPromiseDelivery && hasStockAndBackorder(items);

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
    ...(showSplitShipmentNotice ? ['', SPLIT_SHIPMENT_NOTICE] : []),
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

/** 取消のお知らせの件名。未入金の取消と支払い済みのキャンセルで同じ（グループ E-2 設計書 8-2） */
function canceledSubject(orderId: string): string {
  return `【${SHOP_NAME}】ご注文取消のお知らせ（${toOrderNumber(orderId)}）`;
}

function composeCanceled(material: OrderEmailMaterial, previousStatus: 'payment_in_progress' | 'pending'): ComposedOrderEmail {
  const { order } = material;
  const lead =
    previousStatus === 'payment_in_progress'
      ? 'お手続き中のご注文を取り消しました。'
      : 'お支払い待ちのご注文を取り消しました。';
  return {
    subject: canceledSubject(order.id),
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

/** 日本時間の YYYY年M月D日。日本に夏時間は無いので、世界標準時に9時間を足して年月日を読む。読めなければ null */
function formatJstDate(value: string): string | null {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return null;
  }
  const jst = new Date(time + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`;
}

/**
 * お金が戻る時期の文（グループ E-2 設計書 8-3）。支払い方法は返金の記録の値（Stripe の支払いから読んだ値）で決める。
 * コンビニ払いは、口座を入力する期限が分からなければ日付を書けないので、分からない時の文にする
 */
function refundTimingLine(refund: OrderEmailRefundMaterial): string {
  switch (refund.paymentMethodType) {
    case 'card':
    case 'link':
      return REFUND_TIMING_CARD;
    case 'paypay':
      return REFUND_TIMING_PAYPAY;
    case 'konbini': {
      const deadline = refund.customerActionExpiresAt ? formatJstDate(refund.customerActionExpiresAt) : null;
      return deadline ? refundTimingKonbini(deadline) : REFUND_TIMING_UNKNOWN;
    }
    default:
      return REFUND_TIMING_UNKNOWN;
  }
}

/**
 * 返金のお知らせ（グループ E-2 設計書 8-1）。返金1件ごとに1通。返金の材料が無ければ作らない（送れない材料の不足）。
 * 商品の行は、返金した商品がある時だけ。値段は書かない（返金額は上の1行に書く）。
 * 金額は注文の内容・合計と同じ formatCurrency で出す（Global Constraints「金額の書き方」。1通の中で全角と半角の円記号を混ぜない）
 */
function composeRefund(material: OrderEmailMaterial, variant: RefundEmailVariant): ComposedOrderEmail | null {
  const { order, refund } = material;
  if (!refund) {
    return null;
  }
  const orderNumber = toOrderNumber(order.id);
  const shippingPart =
    refund.shippingAmount > 0 ? `（うち送料 ${formatCurrency(refund.shippingAmount, order.currency)}）` : '';
  return {
    subject: `【${SHOP_NAME}】ご返金のお知らせ（${orderNumber}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      `ご注文（${orderNumber}）の返金の手続きをいたしました。`,
      '',
      `返金額: ${formatCurrency(refund.amount, order.currency)}${shippingPart}`,
      ...(refund.lines.length > 0
        ? ['返金した商品:', ...refund.lines.map((line) => `・${itemLabel(line)} × ${line.quantity}`)]
        : []),
      ...(refund.lines.some((line) => line.before_shipment) ? [REFUND_NOT_SHIPPING_NOTICE] : []),
      ...(refund.stillShipping ? [REFUND_STILL_SHIPPING_NOTICE] : []),
      ...(variant === 'after_cancel' ? [REFUND_AFTER_CANCEL_NOTICE] : []),
      '',
      refundTimingLine(refund),
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

/**
 * 支払い済みの注文のキャンセルのお知らせ（グループ E-2 設計書 8-2）。返金ごとに1通。返金の材料が無ければ作らない。
 * 未入金の取消と違い、お支払いは発生している。「お支払いは発生していません。」は書かない
 */
function composePaidCanceled(material: OrderEmailMaterial): ComposedOrderEmail | null {
  const { order, refund } = material;
  if (!refund) {
    return null;
  }
  return {
    subject: canceledSubject(order.id),
    text: [
      greeting(order.shipping_full_name),
      '',
      refund.cancelReason ? PAID_CANCEL_LEADS[refund.cancelReason] : PAID_CANCEL_LEAD_DEFAULT,
      `お支払いいただいた ${formatCurrency(refund.amount, order.currency)}（全額）を返金いたします。`,
      '',
      refundTimingLine(refund),
      '',
      ...orderSummaryLines(material),
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

/**
 * 発送の材料が無い・配送業者か伝票番号が無ければ作らない（送れない材料の不足）。
 * 値段は書かない。一部だけ送ると、注文の行の値段と送った数が合わなくなるため（グループ E-1 設計書 8-1）。
 * 発送の取消は、ここでなく worker が先に見る。
 */
function composeShipped({ order, fulfillment }: OrderEmailMaterial): ComposedOrderEmail | null {
  const trackingNumber = fulfillment?.trackingNumber?.trim();
  if (!fulfillment || !isShippingCarrierId(fulfillment.carrier) || !trackingNumber) {
    return null;
  }
  const orderNumber = toOrderNumber(order.id);
  const carrier = SHIPPING_CARRIERS[fulfillment.carrier];
  return {
    subject: `【Le Fil des Heures】商品を発送いたしました（${orderNumber}）`,
    text: [
      greeting(order.shipping_full_name),
      '',
      'ご注文の商品を発送いたしました。',
      '',
      `注文番号: ${orderNumber}`,
      '',
      '発送した商品:',
      ...formatShipmentItemLines(fulfillment.lines),
      '',
      `配送業者: ${carrier.label}`,
      `追跡番号: ${trackingNumber}`,
      `追跡はこちら: ${carrier.trackingUrl(trackingNumber)}`,
      '',
      '※ 追跡情報は反映までに数時間かかる場合があります。',
      // 未発送の品が残る発送だけ、残りの案内を添える
      ...(fulfillment.completesOrder ? [] : [REMAINING_ITEMS_NOTICE]),
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
      // 支払い済みのキャンセル（書き分け paid）は返金の記録から書く。未入金の取消は今のまま、前の状態で書き出しが変わる
      if (request.variant === 'paid') {
        return composePaidCanceled(material);
      }
      return composeCanceled(material, request.variant === 'payment_in_progress' ? 'payment_in_progress' : 'pending');
    case 'shipped':
      return composeShipped(material);
    case 'refund':
      return composeRefund(material, request.variant === 'after_cancel' ? 'after_cancel' : 'standard');
  }
}
