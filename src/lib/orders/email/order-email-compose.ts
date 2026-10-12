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
import { konbiniDeadlineLastDay } from '@/lib/orders/refund/refund-messages';
import type { OrderRefundStatus } from '@/lib/orders/refund/refund-types';
import { formatReturnNumber, RETURN_CARRIER_LABELS } from '@/lib/orders/returns/return-messages';
import {
  RETURN_CARRIERS,
  type RefundChoice,
  type ReturnCarrier,
  type ReturnMethod,
  type ShippingPayer,
} from '@/lib/orders/returns/return-types';

/**
 * 注文のメールの材料を読み、件名と本文を作る（グループ D 設計書 4-2）。
 * 文面は今までのメール（注文確認・入金待ち・期限切れ・取消・発送）と同じにする。
 * 件名は固定の文と注文番号だけで組み、氏名や商品名は本文にだけ入れる（メールの見出しへの差し込みを防ぐ）。
 * 発送のメールは発送ごとに作り、その発送の商品と数・配送業者・伝票番号を発送の記録から読む（グループ E-1 設計書 8-1）。
 * 返金のお知らせと、支払い済みの注文のキャンセルのお知らせは返金ごとに作り、額・戻る時期・商品を返金の記録から読む（グループ E-2 設計書 8-1・8-2）。
 * 返品のメール（受付・受け取り・お返し・店への知らせ）は返品・受け取りごとに作り、品・手数料・返送先・お返しのメッセージを返品の記録から読む。
 * 返品の返金のお知らせ（返金の書き分け return）は、返金の記録が指す返品と、その返金を始めた受け取りも読む（グループ E-3 設計書 9 章）。
 */
const SHOP_NAME = 'Le Fil des Heures';

// 配送業者と伝票番号は注文の行から読まない。注文の行の組は「全部を送った時の値」で、一部だけ送った間は空になるため
const MATERIAL_ORDER_COLUMNS =
  'id, status, shipping_email, shipping_full_name, subtotal_amount, shipping_amount, discount_amount, total_amount, paid_amount, currency, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_building, shipping_phone, review_reason';

const MATERIAL_FULFILLMENT_COLUMNS = 'number, shipping_carrier, tracking_number, completes_order, cancelled_at';
// line_kind は、交換の品の行に（交換の品）の印を付けるために読む（グループ E-3 設計書 9-1 の7）
const MATERIAL_FULFILLMENT_LINE_COLUMNS = 'quantity, order_items(item_name, color, size, line_kind)';

// status は送る前の取りやめの判断に使う（予定を書いた後に返金が失敗・エラーになっていないか）
const MATERIAL_REFUND_COLUMNS = 'status, amount, shipping_amount, payment_method_type, customer_action_expires_at, cancel_reason';
// 商品の並び（作った時刻、同じなら番号）に使うので、商品の作った時刻も読む
const MATERIAL_REFUND_LINE_COLUMNS = 'order_item_id, quantity, before_shipment, order_items(item_name, color, size, created_at)';

// 返品のメールの材料（グループ E-3 設計書 9 章）。表と列は計画 C-0 のとおり
const MATERIAL_RETURN_COLUMNS =
  'number, return_method, return_shipping_payer, return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee, fee_due_amount, fee_pending_deduction, fee_received_at, exchange_released_at';
const MATERIAL_RETURN_LINE_COLUMNS = 'id, order_item_id, quantity, resolution, exchange_variant_id, exchange_method';
// refund_id は、受け取りと一緒に始めた返金が Stripe に受け付けられたかを見るために読む（本計画 P25）
const MATERIAL_RETURN_RECEIPT_COLUMNS =
  'id, return_id, refund_choice, refund_id, actor_can_refund, sent_back_message, sent_back_carrier, sent_back_tracking_number';
const MATERIAL_RETURN_RECEIPT_LINE_COLUMNS = 'return_line_id, disposition, quantity, resolution, exchange_method';
// 返品の行の元の品の名前・色・サイズ。並び（作った時刻、同じなら番号）にも使う
const MATERIAL_RETURN_ITEM_COLUMNS = 'id, item_name, color, size, created_at';
const MATERIAL_RETURN_VARIANT_COLUMNS = 'id, item_id, item_colors(name), item_sizes(label)';
const MATERIAL_RETURN_ADDRESS_COLUMNS =
  'return_address_name, return_address_postal_code, return_address_line, return_address_phone';

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

/** 発送のお知らせの交換の一文（グループ E-3 設計書 9-1 の7）。発送の品に交換の品の行がある時だけ、冒頭の次の行に書く */
const SHIPPED_EXCHANGE_NOTICE = 'ご返品いただいた品の、交換の品をお送りしました。';

/** 返品のメールの決まった文（グループ E-3 設計書 9 章。計画 C-6 と一字も違えない） */
const RETURN_ACCEPTED_CLOSING = '商品が届きましたら、確かめてご連絡いたします。';
const RETURN_EXCHANGE_MAKE_SUFFIX = '（お作りしてお送りします）';
const returnReceivedLead = (label: string) => `ご返品いただいた商品をお受け取りしました（返品番号 ${label}）。`;
const returnRefundLaterLead = (label: string) => `ご返品いただいた商品のご返金です（返品番号 ${label}）。`;
/** 作って送る交換の品の次の行。お届けの目安は、商品に目安の日数がある時だけ書く */
const returnExchangeMakeNotice = (leadDays: number | null) =>
  leadDays !== null && leadDays > 0 ? `お作りしてお送りします。お届けの目安は ${leadDays}日ほどです。` : 'お作りしてお送りします。';
const RETURN_NO_SHIPPING_NEEDED = '品物のご返送は不要です。';
const RETURN_SEND_TO = '下記の返送先へお送りください。';
const RETURN_SHIPPING_SHOP_PAYS = '返送料は当店が負担いたします。着払いでお送りください。';
const RETURN_SHIPPING_CUSTOMER_PAYS = '恐れ入りますが、返送料はお客様のご負担でお送りください。';
const returnShippingShopLabel = (fee: string) =>
  `当店がご用意する送り状でお送りください。返送料 ${fee} をご返金額から差し引きます。`;
const RETURN_FEE_NOTICE = '手数料はご返金から差し引きます。差し引けない分は、別にご案内いたします。';
const RETURN_REFUND_CONSULT_NOTICE = 'ご返金の額は、確かめてから改めてご連絡いたします。';
/** 受け取りの中で返金が0円になった時の一文（本計画 P24。返金のお知らせが届かないので、お客様を待たせない） */
const RETURN_REFUND_WAIVED_NOTICE = '今回のご返品では、ご返金の額が0円のため、ご返金はございません。';
const returnFeeWaitingNotice = (fee: string) =>
  `交換の品は、手数料 ${fee} のお支払いを確かめてからお送りします。お支払いの方法は、別にご案内いたします。`;
const RETURN_SHOP_ACTION = '管理画面の注文の一覧で「額を決めて返金する」を押して、返金してください。';
/** 店への知らせの「受け取った人」。この知らせは返金できない人（サポート）の受け取りにだけ書かれる */
const RETURN_SHOP_RECEIVER = 'サポート';

export type OrderEmailMaterialRow = OrderEmailRow & { status: OrderStatus; paid_amount?: number | null };

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
  /** exchange は、交換の品の行か（グループ E-3）。読み込みは必ず true か false を入れる。無ければ交換の品でない */
  lines: Array<{ item_name: string; color: string | null; size: string | null; quantity: number; exchange?: boolean }>;
};

/**
 * 返金のお知らせと、支払い済みのキャンセルのお知らせの材料。返金の記録から読む。
 * 商品の行は、同じ商品の発送前と発送後を1行にまとめた形。stillShipping は、返金の後もこれから送る商品が残っているか。
 * status は材料を読んだ時の返金の状態。予定は Stripe が返金を受け付けた時に書かれ、送るのは後になる。その間に失敗・エラーに
 * なった返金には送らない（worker が決める。設計書 8-1・8-2）。
 */
export type OrderEmailRefundMaterial = {
  status: OrderRefundStatus;
  amount: number;
  shippingAmount: number;
  paymentMethodType: string | null;
  customerActionExpiresAt: string | null;
  cancelReason: CancelReason | null;
  lines: Array<{ item_name: string; color: string | null; size: string | null; quantity: number; before_shipment: boolean }>;
  stillShipping: boolean;
};

/** 返品のメールの品の行（品名・色・サイズ・数）。注文の商品ごとにまとめた形 */
export type OrderEmailReturnItem = { item_name: string; color: string | null; size: string | null; quantity: number };

/**
 * 交換で届ける品。method は stock（在庫から）か make（作って送る）。
 * leadDays は商品の受注生産のお届けの目安の日数（受け取りで足した品だけ。受付のお知らせの予定の品と、目安の無い品は null）
 */
export type OrderEmailExchangeItem = OrderEmailReturnItem & { method: 'stock' | 'make'; leadDays: number | null };

export type OrderEmailReturnAddress = { name: string; postalCode: string; address: string; phone: string };

/**
 * 1回の受け取りの材料。received は受け取った品（在庫に戻す・戻さない・検品待ち）、sentBack はお返しする品。
 * exchanges は、この受け取りで実際に決まった交換の品（受け取りの行の解決で数える。在庫が足りずに作って送るへ変わった品は make、
 * 店長が返金に変えた分は含まない）。
 * pendingRefund は返金できない人（サポート）の受け取りの時だけ読む、返金待ちの品と計算どおりの額。
 * refundWaived は、この受け取りで返金が0円になったか（受け取りの行に refund_waived がある。本計画 P20・P24）。
 * refundNotAccepted は、この受け取りと一緒に始めた返金（今返金）が Stripe に受け付けられていないか
 * （受け取りの記録の refund_id の返金がエラー・失敗。本計画 P25）
 */
export type OrderEmailReturnReceipt = {
  refundChoice: RefundChoice | null;
  received: OrderEmailReturnItem[];
  sentBack: OrderEmailReturnItem[];
  sentBackMessage: string | null;
  sentBackCarrier: ReturnCarrier | null;
  sentBackTrackingNumber: string | null;
  exchanges: OrderEmailExchangeItem[];
  pendingRefund: { items: OrderEmailReturnItem[]; amount: number } | null;
  refundWaived: boolean;
  refundNotAccepted: boolean;
};

/**
 * 返品のメールの材料。number は返品の番号（画面の「注文番号-R{n}」の n）。
 * items・exchangePlan・hasRefundLines・returnAddress は返品の受付のお知らせだけが読む（ほかは [] / false / null）。
 * feeWaitingAmount は、手数料のお支払い待ちで交換の品が止まっている間だけ手数料の額（受け取り済み・支払いを待たずに送る、のどちらかなら 0）
 */
export type OrderEmailReturnMaterial = {
  number: number;
  returnMethod: ReturnMethod;
  returnShippingPayer: ShippingPayer;
  returnShippingFee: number;
  restockingFeePercent: number;
  exchangeFee: number;
  exchangeShippingFee: number;
  feeWaitingAmount: number;
  returnAddress: OrderEmailReturnAddress | null;
  items: OrderEmailReturnItem[];
  exchangePlan: OrderEmailExchangeItem[];
  hasRefundLines: boolean;
  receipt: OrderEmailReturnReceipt | null;
};

export type OrderEmailMaterial = {
  order: OrderEmailMaterialRow;
  items: ConfirmationItem[];
  /** 発送のメールの時だけ読む。ほかの種類は null */
  fulfillment: OrderEmailFulfillmentMaterial | null;
  /** 返金のお知らせと、支払い済みのキャンセルのお知らせの時だけ読む。ほかの種類は null */
  refund: OrderEmailRefundMaterial | null;
  /** 返品のメール4種類と、返品の返金のお知らせ（書き分け return）の時だけ読む。ほかの種類は null（グループ E-3 設計書 9 章） */
  orderReturn: OrderEmailReturnMaterial | null;
};

export type ComposeRequest = {
  kind: OrderEmailKind;
  variant: OrderEmailVariant | null;
  /** 期限切れのメールを実際に送ったか。送っていなければ、期限切れの後の入金も普通の文面にする（設計書 4-1） */
  paymentExpiredSent: boolean;
};

export type ComposedOrderEmail = { subject: string; text: string };

/** 材料を読んだ表か、DB の関数の名前 */
export type OrderEmailMaterialTable =
  | 'orders'
  | 'order_items'
  | 'order_fulfillments'
  | 'order_fulfillment_lines'
  | 'order_refunds'
  | 'order_refund_lines'
  | 'list_order_line_fulfillment'
  | 'order_returns'
  | 'order_return_lines'
  | 'order_return_receipts'
  | 'order_return_receipt_lines'
  | 'item_variants'
  | 'items'
  | 'shop_return_settings'
  | 'list_order_returns';

/** 材料を読めなかった（DB の失敗）。worker は一時的な失敗としてやり直す。table は読んだ表か、DB の関数の名前 */
export class OrderEmailMaterialError extends Error {
  constructor(
    readonly table: OrderEmailMaterialTable,
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
  order_items: { item_name: string; color: string | null; size: string | null; line_kind?: 'order' | 'exchange' };
};

type RefundRow = {
  status: OrderRefundStatus;
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
      exchange: line.order_items.line_kind === 'exchange',
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
    status: refund.status,
    amount: refund.amount,
    shippingAmount: refund.shipping_amount,
    paymentMethodType: refund.payment_method_type,
    customerActionExpiresAt: refund.customer_action_expires_at,
    cancelReason: refund.cancel_reason,
    lines: toRefundMaterialLines((data ?? []) as unknown as RefundLineRow[]),
    stillShipping: await hasItemsToShip(store, order),
  };
}

type QueryResult = PromiseLike<{ data: unknown; error: unknown }>;

/** 複数行を返す問い合わせの答えを読む。読めなければ OrderEmailMaterialError を投げる */
async function readRows<T>(query: QueryResult, table: OrderEmailMaterialTable): Promise<T[]> {
  const { data, error } = await query;
  if (error) {
    throw new OrderEmailMaterialError(table, { cause: error });
  }
  return (data ?? []) as T[];
}

/** 1行を返す問い合わせの答えを読む。行が無ければ null。読めなければ OrderEmailMaterialError を投げる */
async function readRow<T>(query: QueryResult, table: OrderEmailMaterialTable): Promise<T | null> {
  const { data, error } = await query;
  if (error) {
    throw new OrderEmailMaterialError(table, { cause: error });
  }
  return (data ?? null) as T | null;
}

type ReturnRow = {
  number: number;
  return_method: ReturnMethod;
  return_shipping_payer: ShippingPayer;
  return_shipping_fee: number;
  restocking_fee_percent: number;
  exchange_fee: number;
  exchange_shipping_fee: number;
  fee_due_amount: number;
  fee_pending_deduction: number;
  fee_received_at: string | null;
  exchange_released_at: string | null;
};

type ReturnLineRow = {
  id: string;
  order_item_id: string;
  quantity: number;
  resolution: 'refund' | 'exchange';
  exchange_variant_id: number | null;
  exchange_method: 'stock' | 'make' | null;
};

type ReturnReceiptRow = {
  id: string;
  return_id: string;
  refund_choice: RefundChoice | null;
  refund_id: string | null;
  actor_can_refund: boolean | null;
  sent_back_message: string | null;
  sent_back_carrier: string | null;
  sent_back_tracking_number: string | null;
};

/** resolution と exchange_method は、その受け取りで実際に決まった解決（返品の行の予定ではない。計画 C-0） */
type ReturnReceiptLineRow = {
  return_line_id: string;
  disposition: string;
  quantity: number;
  resolution: 'refund' | 'exchange' | null;
  exchange_method: 'stock' | 'make' | null;
};

type ReturnItemRow = { id: string; item_name: string; color: string | null; size: string | null; created_at: string };

type ReturnVariantRow = {
  id: number;
  item_id: number;
  item_colors: { name: string } | null;
  item_sizes: { label: string } | null;
};

type ReturnLeadDaysRow = { id: number; made_to_order_lead_days: number | null };

type ReturnAddressRow = {
  return_address_name: string | null;
  return_address_postal_code: string | null;
  return_address_line: string | null;
  return_address_phone: string | null;
};

/** list_order_returns の答え（計画 C-2 の型のキーを snake_case にした形）のうち、店への知らせが読む所 */
type ReturnDetailJson = {
  id: string;
  lines: Array<{
    order_item_id: string;
    item_name: string;
    color: string | null;
    size: string | null;
    progress: { refund_waiting: number };
    refund_waiting_amount: number;
  }>;
};

/**
 * お客様に「受け取った」と伝える扱い。お返し（sent_back）は別の節に分ける。
 * 返金しないことにした数（refund_waived）・検品の決め直し・届かないは、受け取りの品の数に足さない
 */
const RECEIVED_DISPOSITIONS: ReadonlySet<string> = new Set(['restocked', 'not_restocked', 'pending_inspection']);

function isReturnCarrier(value: unknown): value is ReturnCarrier {
  return typeof value === 'string' && (RETURN_CARRIERS as readonly string[]).includes(value);
}

/** 注文の商品の並び（作った時刻、同じなら番号）。返金の商品の行と同じ順に、返品の品を並べる */
function compareOrderItems(a: ReturnItemRow, b: ReturnItemRow): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id);
}

/** 同じ注文の商品の数を足して1行にまとめ、商品の並びで返す。DB が行を返す順には頼らない */
function toReturnItems(entries: ReadonlyArray<{ item: ReturnItemRow; quantity: number }>): OrderEmailReturnItem[] {
  const merged = new Map<string, { item: ReturnItemRow; quantity: number }>();
  for (const entry of entries) {
    const same = merged.get(entry.item.id);
    merged.set(entry.item.id, same ? { item: same.item, quantity: same.quantity + entry.quantity } : entry);
  }
  return [...merged.values()]
    .sort((a, b) => compareOrderItems(a.item, b.item))
    .map(({ item, quantity }) => ({ item_name: item.item_name, color: item.color, size: item.size, quantity }));
}

/** 品名・色・サイズ・送り方が同じ交換の品の数を足して1行にまとめる。元の品の並びで返す */
function toExchangeItems(
  entries: ReadonlyArray<{ original: ReturnItemRow; exchange: OrderEmailExchangeItem }>,
): OrderEmailExchangeItem[] {
  const merged = new Map<string, { original: ReturnItemRow; exchange: OrderEmailExchangeItem }>();
  for (const entry of entries) {
    const key = [entry.exchange.item_name, entry.exchange.color, entry.exchange.size, entry.exchange.method].join('\u0000');
    const same = merged.get(key);
    merged.set(
      key,
      same
        ? { original: same.original, exchange: { ...same.exchange, quantity: same.exchange.quantity + entry.exchange.quantity } }
        : entry,
    );
  }
  return [...merged.values()].sort((a, b) => compareOrderItems(a.original, b.original)).map((entry) => entry.exchange);
}

/**
 * 交換で届ける品。品名は元の品の名前（注文した時の名前）、色・サイズは交換の色・サイズ。
 * 返品の行は作った後に変えないので、交換の色・サイズは返品の行の予定の値のまま。送り方は呼び出し側が決める
 */
function toExchangeItem(
  original: ReturnItemRow,
  variant: ReturnVariantRow,
  quantity: number,
  method: 'stock' | 'make',
  leadDays: number | null,
): OrderEmailExchangeItem {
  return {
    item_name: original.item_name,
    color: variant.item_colors?.name ?? null,
    size: variant.item_sizes?.label ?? null,
    quantity,
    method,
    leadDays,
  };
}

/** 交換の色・サイズ（item_variants）を読む。読む番号が無ければ読まない */
async function readExchangeVariants(
  store: Pick<SupabaseClient, 'from'>,
  variantIds: ReadonlyArray<number | null>,
): Promise<Map<number, ReturnVariantRow>> {
  const ids = [...new Set(variantIds.filter((id): id is number => id !== null))];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await readRows<ReturnVariantRow>(
    store.from('item_variants').select(MATERIAL_RETURN_VARIANT_COLUMNS).in('id', ids),
    'item_variants',
  );
  return new Map(rows.map((row) => [Number(row.id), row] as const));
}

/** 商品の受注生産のお届けの目安の日数（items.made_to_order_lead_days）。読む商品が無ければ読まない */
async function readLeadDays(store: Pick<SupabaseClient, 'from'>, itemIds: readonly number[]): Promise<Map<number, number | null>> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await readRows<ReturnLeadDaysRow>(
    store.from('items').select('id, made_to_order_lead_days').in('id', ids),
    'items',
  );
  return new Map(rows.map((row) => [Number(row.id), row.made_to_order_lead_days] as const));
}

/** ショップの設定の返送先。4つとも入っている時だけ返送先にする（空の間は返品を作れない。DB の CHECK も4つ揃って空か入っているかを守る） */
async function readReturnAddress(store: Pick<SupabaseClient, 'from'>): Promise<OrderEmailReturnAddress | null> {
  const row = await readRow<ReturnAddressRow>(
    store.from('shop_return_settings').select(MATERIAL_RETURN_ADDRESS_COLUMNS).eq('id', 1).maybeSingle<ReturnAddressRow>(),
    'shop_return_settings',
  );
  if (!row?.return_address_name || !row.return_address_postal_code || !row.return_address_line || !row.return_address_phone) {
    return null;
  }
  return {
    name: row.return_address_name,
    postalCode: row.return_address_postal_code,
    address: row.return_address_line,
    phone: row.return_address_phone,
  };
}

/**
 * 返金待ちの品と、計算どおりの額（店への知らせ用）。数え方と商品の額は DB の1か所（list_order_returns の返金待ちの数と額）に任せ、
 * TS で数え直さない。返品の行の予定の解決は見ない（予定が交換でも、受け取りで返金に変えた分は返金待ちの数に入る）。
 * 額は、商品の額の合計から、返品の fee_pending_deduction（相談の受け取りで付いた手数料）を引いた額で、0未満にしない
 * （額を決めて返金の計算どおりの額と同じ。送料は店長が決めるので含めない）。
 * 品の並びは list_order_returns の行の並び（発送の番号 → 注文の商品の登録順 → 注文の商品 → 解決 → 行）で、
 * 同じ注文の商品は最初に出た所にまとめる。返品が見つからなければ null
 */
async function readPendingRefund(
  store: Pick<SupabaseClient, 'rpc'>,
  orderId: string,
  returnId: string,
  feePendingDeduction: number,
): Promise<{ items: OrderEmailReturnItem[]; amount: number } | null> {
  const { data, error } = await store.rpc('list_order_returns', { _order_id: orderId });
  if (error) {
    throw new OrderEmailMaterialError('list_order_returns', { cause: error });
  }
  const detail = (Array.isArray(data) ? (data as ReturnDetailJson[]) : []).find((entry) => entry.id === returnId);
  if (!detail) {
    return null;
  }
  const waiting = detail.lines.filter((line) => line.progress.refund_waiting > 0);
  const items = new Map<string, OrderEmailReturnItem>();
  for (const line of waiting) {
    const same = items.get(line.order_item_id);
    items.set(line.order_item_id, {
      item_name: line.item_name,
      color: line.color,
      size: line.size,
      quantity: (same?.quantity ?? 0) + line.progress.refund_waiting,
    });
  }
  const goodsAmount = waiting.reduce((sum, line) => sum + line.refund_waiting_amount, 0);
  return { items: [...items.values()], amount: Math.max(goodsAmount - feePendingDeduction, 0) };
}

/**
 * 受け取りと一緒に始めた返金（今返金）が、Stripe に受け付けられていないか（本計画 P25）。
 * エラー・失敗ならお金は戻っていないので true。保留・成功なら false（受け付けられた返金には、返金のお知らせが別に届く）。
 * 注文の番号でも絞る。返金の記録が無ければ null（送れない）。読めなければ OrderEmailMaterialError を投げる
 */
async function readReceiptRefundNotAccepted(
  store: Pick<SupabaseClient, 'from'>,
  orderId: string,
  refundId: string,
): Promise<boolean | null> {
  const row = await readRow<{ status: OrderRefundStatus }>(
    store
      .from('order_refunds')
      .select('status')
      .eq('id', refundId)
      .eq('order_id', orderId)
      .maybeSingle<{ status: OrderRefundStatus }>(),
    'order_refunds',
  );
  if (!row) {
    return null;
  }
  return row.status === 'error' || row.status === 'failed';
}

/** どこまで読むか。number は返品の番号と手数料の状態だけ、accepted は受付のお知らせの中身、receipt はその受け取りの中身 */
type ReturnScope = { kind: 'number' } | { kind: 'accepted' } | { kind: 'receipt'; receipt: ReturnReceiptRow };

/**
 * 返品の材料を読む。返品の記録が無い・返品の行が無い・返品の行の商品がこの注文に無い・交換の色・サイズが読めない時は null（送れない）。
 * 注文の番号でも絞る: 取り出した行の注文と返品の組が食い違っても、ほかの注文の返品の中身をこの注文のお客様へ送らない
 */
async function loadReturnMaterial(
  store: Pick<SupabaseClient, 'from' | 'rpc'>,
  orderId: string,
  returnId: string,
  scope: ReturnScope,
): Promise<OrderEmailReturnMaterial | null> {
  const row = await readRow<ReturnRow>(
    store.from('order_returns').select(MATERIAL_RETURN_COLUMNS).eq('id', returnId).eq('order_id', orderId).maybeSingle<ReturnRow>(),
    'order_returns',
  );
  if (!row) {
    return null;
  }
  const base: OrderEmailReturnMaterial = {
    number: row.number,
    returnMethod: row.return_method,
    returnShippingPayer: row.return_shipping_payer,
    returnShippingFee: row.return_shipping_fee,
    restockingFeePercent: row.restocking_fee_percent,
    exchangeFee: row.exchange_fee,
    exchangeShippingFee: row.exchange_shipping_fee,
    // 手数料の受け取りの記録も、支払いを待たずに送るも無い間だけ、交換の品が止まっている
    feeWaitingAmount:
      row.fee_due_amount > 0 && row.fee_received_at === null && row.exchange_released_at === null ? row.fee_due_amount : 0,
    returnAddress: null,
    items: [],
    exchangePlan: [],
    hasRefundLines: false,
    receipt: null,
  };
  if (scope.kind === 'number') {
    return base;
  }

  // 返品の行は番号の順に並べる（同じ商品を別々の解決にした行の並びが、DB の返す順で変わらないように）
  const lines = [
    ...(await readRows<ReturnLineRow>(
      store.from('order_return_lines').select(MATERIAL_RETURN_LINE_COLUMNS).eq('return_id', returnId),
      'order_return_lines',
    )),
  ].sort((a, b) => a.id.localeCompare(b.id));
  if (lines.length === 0) {
    return null;
  }
  const orderItems = await readRows<ReturnItemRow>(
    store
      .from('order_items')
      .select(MATERIAL_RETURN_ITEM_COLUMNS)
      .eq('order_id', orderId)
      .in('id', [...new Set(lines.map((line) => line.order_item_id))]),
    'order_items',
  );
  const itemById = new Map(orderItems.map((item) => [item.id, item] as const));
  if (lines.some((line) => !itemById.has(line.order_item_id))) {
    return null;
  }
  const lineById = new Map(lines.map((line) => [line.id, line] as const));
  const originalOf = (line: ReturnLineRow) => itemById.get(line.order_item_id) as ReturnItemRow;

  if (scope.kind === 'accepted') {
    const planned = lines.filter((line) => line.resolution === 'exchange');
    const variantById = await readExchangeVariants(store, planned.map((line) => line.exchange_variant_id));
    const plan: Array<{ original: ReturnItemRow; exchange: OrderEmailExchangeItem }> = [];
    for (const line of planned) {
      const variant = line.exchange_variant_id === null ? undefined : variantById.get(line.exchange_variant_id);
      if (!variant || !line.exchange_method) {
        return null;
      }
      plan.push({ original: originalOf(line), exchange: toExchangeItem(originalOf(line), variant, line.quantity, line.exchange_method, null) });
    }
    return {
      ...base,
      items: toReturnItems(lines.map((line) => ({ item: originalOf(line), quantity: line.quantity }))),
      exchangePlan: toExchangeItems(plan),
      hasRefundLines: lines.some((line) => line.resolution === 'refund'),
      // 返送不要の返品には返送先を書かないので、設定を読まない
      returnAddress: row.return_method === 'not_required' ? null : await readReturnAddress(store),
    };
  }

  const receipt = scope.receipt;
  const receiptLines = await readRows<ReturnReceiptLineRow>(
    store.from('order_return_receipt_lines').select(MATERIAL_RETURN_RECEIPT_LINE_COLUMNS).eq('receipt_id', receipt.id),
    'order_return_receipt_lines',
  );
  const received: Array<{ item: ReturnItemRow; quantity: number }> = [];
  const sentBack: Array<{ item: ReturnItemRow; quantity: number }> = [];
  const exchangeUnits: Array<{ line: ReturnLineRow; quantity: number; method: 'stock' | 'make' }> = [];
  for (const receiptLine of receiptLines) {
    const line = lineById.get(receiptLine.return_line_id);
    if (!line) {
      return null;
    }
    const entry = { item: originalOf(line), quantity: receiptLine.quantity };
    if (RECEIVED_DISPOSITIONS.has(receiptLine.disposition)) {
      received.push(entry);
      // 交換の品は、返品の行の予定ではなく、その受け取りで実際に決まった解決（作って送るへの変更・返金への変更を含む）で数える
      if (receiptLine.resolution === 'exchange') {
        if (!receiptLine.exchange_method) {
          return null;
        }
        exchangeUnits.push({ line, quantity: receiptLine.quantity, method: receiptLine.exchange_method });
      }
    } else if (receiptLine.disposition === 'sent_back') {
      sentBack.push(entry);
    }
  }

  const variantById = await readExchangeVariants(store, exchangeUnits.map((unit) => unit.line.exchange_variant_id));
  const exchangeVariants: Array<ReturnVariantRow | undefined> = exchangeUnits.map((unit) =>
    unit.line.exchange_variant_id === null ? undefined : variantById.get(unit.line.exchange_variant_id),
  );
  if (exchangeVariants.some((variant) => !variant)) {
    return null;
  }
  const leadDaysByItem = await readLeadDays(
    store,
    exchangeUnits.flatMap((unit, index) => (unit.method === 'make' ? [(exchangeVariants[index] as ReturnVariantRow).item_id] : [])),
  );
  const exchanges = toExchangeItems(
    exchangeUnits.map((unit, index) => {
      const variant = exchangeVariants[index] as ReturnVariantRow;
      return {
        original: originalOf(unit.line),
        exchange: toExchangeItem(
          originalOf(unit.line),
          variant,
          unit.quantity,
          unit.method,
          unit.method === 'make' ? (leadDaysByItem.get(variant.item_id) ?? null) : null,
        ),
      };
    }),
  );

  // 今返金が受け付けられなかったか（本計画 P25）。受け取りと一緒に始めた返金の、今の状態で決める
  let refundNotAccepted = false;
  if (receipt.refund_id !== null) {
    const notAccepted = await readReceiptRefundNotAccepted(store, orderId, receipt.refund_id);
    if (notAccepted === null) {
      return null;
    }
    refundNotAccepted = notAccepted;
  }

  // 返金できない人（サポート）の受け取りだけ、店への知らせのために返金待ちの品と額を読む
  const pendingRefund =
    receipt.actor_can_refund === false ? await readPendingRefund(store, orderId, returnId, row.fee_pending_deduction) : null;
  return {
    ...base,
    receipt: {
      refundChoice: receipt.refund_choice,
      received: toReturnItems(received),
      sentBack: toReturnItems(sentBack),
      sentBackMessage: receipt.sent_back_message,
      sentBackCarrier: isReturnCarrier(receipt.sent_back_carrier) ? receipt.sent_back_carrier : null,
      sentBackTrackingNumber: receipt.sent_back_tracking_number,
      exchanges,
      pendingRefund,
      // 受け取りの中で返金が0円になった数の行（本計画 P20・P24）。受け取った品の数には足さない
      refundWaived: receiptLines.some((line) => line.disposition === 'refund_waived'),
      refundNotAccepted,
    },
  };
}

/**
 * 返品のメールの行（返品の番号・受け取りの番号）から、返品の材料を読む。
 * 受け取りの番号があれば、その受け取りを読む（受け取りと一緒の返金のお知らせの行も、受け取りの番号を持つ）。
 * 受け取りの番号が無く返金の番号がある行は、額を決めて後で返した返金のお知らせなので、返品の番号だけを読む。
 * どちらも無く返品の番号だけの行は、返品の受付のお知らせ
 */
async function loadReturnForEmail(
  store: Pick<SupabaseClient, 'from' | 'rpc'>,
  orderId: string,
  ids: { returnId: string | null; returnReceiptId: string | null; hasRefund: boolean },
): Promise<OrderEmailReturnMaterial | null> {
  if (ids.returnReceiptId !== null) {
    const receipt = await readRow<ReturnReceiptRow>(
      store
        .from('order_return_receipts')
        .select(MATERIAL_RETURN_RECEIPT_COLUMNS)
        .eq('id', ids.returnReceiptId)
        .maybeSingle<ReturnReceiptRow>(),
      'order_return_receipts',
    );
    return receipt ? loadReturnMaterial(store, orderId, receipt.return_id, { kind: 'receipt', receipt }) : null;
  }
  if (ids.returnId !== null) {
    return loadReturnMaterial(store, orderId, ids.returnId, ids.hasRefund ? { kind: 'number' } : { kind: 'accepted' });
  }
  return null;
}

/**
 * 注文行と明細を読む。発送の番号があれば、その発送も読む。返金の番号があれば、その返金も読む。
 * 返品の番号・受け取りの番号があれば、その返品も読む（返品の返金のお知らせの行も、この2つを持つ）。
 * 注文が無い・明細が0件・発送が無い・発送の商品が0件・返金の記録が無い・返品の記録が無ければ null（送れない）。読めなければ OrderEmailMaterialError を投げる
 */
export async function loadOrderEmailMaterial(
  store: Pick<SupabaseClient, 'from' | 'rpc'>,
  orderId: string,
  fulfillmentId: string | null = null,
  refundId: string | null = null,
  returnId: string | null = null,
  returnReceiptId: string | null = null,
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

  let orderReturn: OrderEmailReturnMaterial | null = null;
  if (returnId !== null || returnReceiptId !== null) {
    orderReturn = await loadReturnForEmail(store, orderId, { returnId, returnReceiptId, hasRefund: refundId !== null });
    if (!orderReturn) {
      return null;
    }
  }

  return { order, items: items as ConfirmationItem[], fulfillment, refund, orderReturn };
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

/**
 * 共通の部品で出した、口座の入力が間に合う最後の日を YYYY年M月D日で書く。読めなければ null
 */
function formatKonbiniDeadlineDate(value: string): string | null {
  const deadline = konbiniDeadlineLastDay(value);
  return deadline ? `${deadline.year}年${deadline.month}月${deadline.day}日` : null;
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
      const deadline = refund.customerActionExpiresAt ? formatKonbiniDeadlineDate(refund.customerActionExpiresAt) : null;
      return deadline ? refundTimingKonbini(deadline) : REFUND_TIMING_UNKNOWN;
    }
    default:
      return REFUND_TIMING_UNKNOWN;
  }
}

/** 空でない段落（行のまとまり）を、空行をはさんで並べる。返品のメールの本文は、段落を空行で区切って組む */
function paragraphs(...blocks: string[][]): string[] {
  return blocks.filter((block) => block.length > 0).flatMap((block, index) => (index === 0 ? block : ['', ...block]));
}

/** 返品のメールの品の行。返金のお知らせの商品の行と同じ書き方（・品名（色 / サイズ） × 数。値段は書かない） */
function returnItemLine(item: OrderEmailReturnItem): string {
  return `・${itemLabel(item)} × ${item.quantity}`;
}

/**
 * 「交換の品をお送りします」の節。作って送る品の行の次に、作ってお送りする旨を書く。
 * お届けの目安は、商品に目安の日数がある時だけ書く（受付のお知らせ・返金のお知らせの受け取りの文と同じ節）
 */
function exchangeSectionLines(exchanges: readonly OrderEmailExchangeItem[]): string[] {
  if (exchanges.length === 0) {
    return [];
  }
  return [
    '交換の品をお送りします:',
    ...exchanges.flatMap((item) => [
      returnItemLine(item),
      ...(item.method === 'make' ? [returnExchangeMakeNotice(item.leadDays)] : []),
    ]),
  ];
}

/**
 * お返しの節（お返しする品・お店のメッセージ・伝票番号）。お返しの品が無ければ []。
 * お返しの品があるのにメッセージが無ければ null（お返しにはメッセージが必須。DB も断る。メッセージ無しでは送らない）。
 * メッセージはお店が書いた文をそのまま入れる（メールは文字だけ）。伝票番号は配送業者が分かれば業者名を前に付ける
 */
function sentBackSectionLines(receipt: OrderEmailReturnReceipt): string[] | null {
  if (receipt.sentBack.length === 0) {
    return [];
  }
  if (!receipt.sentBackMessage) {
    return null;
  }
  const carrier = receipt.sentBackCarrier ? RETURN_CARRIER_LABELS[receipt.sentBackCarrier] : null;
  return paragraphs(
    ['お返しする商品:', ...receipt.sentBack.map(returnItemLine)],
    ['当店より:', receipt.sentBackMessage],
    receipt.sentBackTrackingNumber
      ? [`送り返しの伝票番号: ${carrier ? `${carrier} ` : ''}${receipt.sentBackTrackingNumber}`]
      : [],
  );
}

/** 返金のお知らせの返品の書き分けの、2行目。受け取りと一緒の返金か、額を決めて後で返した返金か */
function returnRefundLead(orderId: string, orderReturn: OrderEmailReturnMaterial): string {
  const label = formatReturnNumber(orderId, orderReturn.number);
  return orderReturn.receipt ? returnReceivedLead(label) : returnRefundLaterLead(label);
}

/**
 * 返金のお知らせ（グループ E-2 設計書 8-1）。返金1件ごとに1通。返金の材料が無ければ作らない（送れない材料の不足）。
 * 商品の行は、返金した商品がある時だけ。値段は書かない（返金額は上の1行に書く）。
 * 金額は注文の内容・合計と同じ formatCurrency で出す（Global Constraints「金額の書き方」。1通の中で全角と半角の円記号を混ぜない）。
 * 書き分け return は返品の返金（グループ E-3 設計書 9-1 の4）: 返金の手続きの文の次の行に返品番号つきの文を足し、
 * 受け取りと一緒の返金なら、商品の行の後に交換の品の節とお返しの節（ある時）を足す。発送前の返金ではないので「お送りしません」の文は書かない。
 * 返品の材料が無い・お返しのメッセージが無ければ作らない
 */
function composeRefund(material: OrderEmailMaterial, variant: RefundEmailVariant): ComposedOrderEmail | null {
  const { order, refund, orderReturn } = material;
  if (!refund) {
    return null;
  }
  const returnPart = variant === 'return' ? orderReturn : null;
  if (variant === 'return' && !returnPart) {
    return null;
  }
  const exchange = returnPart?.receipt ? exchangeSectionLines(returnPart.receipt.exchanges) : [];
  const sentBack = returnPart?.receipt ? sentBackSectionLines(returnPart.receipt) : [];
  if (sentBack === null) {
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
      ...(returnPart ? [returnRefundLead(order.id, returnPart)] : []),
      '',
      `返金額: ${formatCurrency(refund.amount, order.currency)}${shippingPart}`,
      ...(refund.lines.length > 0
        ? ['返金した商品:', ...refund.lines.map((line) => `・${itemLabel(line)} × ${line.quantity}`)]
        : []),
      ...(!returnPart && refund.lines.some((line) => line.before_shipment) ? [REFUND_NOT_SHIPPING_NOTICE] : []),
      ...(refund.stillShipping ? [REFUND_STILL_SHIPPING_NOTICE] : []),
      ...(variant === 'after_cancel' ? [REFUND_AFTER_CANCEL_NOTICE] : []),
      ...(exchange.length > 0 ? ['', ...exchange] : []),
      ...(sentBack.length > 0 ? ['', ...sentBack] : []),
      '',
      refundTimingLine(refund),
      '',
      contactLine(order.id),
      '',
      SHOP_NAME,
    ].join('\n'),
  };
}

/** 受付のお知らせの返送のしかた。返送先が要るのに設定に無ければ null（送れない） */
function returnShippingLines(orderReturn: OrderEmailReturnMaterial, currency: string): string[] | null {
  if (orderReturn.returnMethod === 'not_required') {
    return [RETURN_NO_SHIPPING_NEEDED];
  }
  const address = orderReturn.returnAddress;
  if (!address) {
    return null;
  }
  // お店の負担を先に見る。お客様の負担でお店の送り状（shop_label）の時だけ、返送料を返金から差し引く
  const burden =
    orderReturn.returnShippingPayer === 'shop'
      ? RETURN_SHIPPING_SHOP_PAYS
      : orderReturn.returnMethod === 'shop_label'
        ? returnShippingShopLabel(formatCurrency(orderReturn.returnShippingFee, currency))
        : RETURN_SHIPPING_CUSTOMER_PAYS;
  return [RETURN_SEND_TO, burden, '返送先:', address.name, `〒${address.postalCode} ${address.address}`, address.phone];
}

/**
 * 受付のお知らせの手数料の行。使う物（0より大きい物）だけ書き、書く物が無ければ段落ごと書かない。
 * この返品に当たらない手数料は書かない: 返金の品が無いのに返品の手数料、交換の品が無いのに交換の手数料と送料
 */
function returnFeeLines(orderReturn: OrderEmailReturnMaterial, currency: string): string[] {
  const hasExchange = orderReturn.exchangePlan.length > 0;
  const lines = [
    orderReturn.hasRefundLines && orderReturn.restockingFeePercent > 0
      ? `返品の手数料: ご返金の商品の額の ${orderReturn.restockingFeePercent}%`
      : null,
    hasExchange && orderReturn.exchangeFee > 0 ? `交換の手数料: ${formatCurrency(orderReturn.exchangeFee, currency)}` : null,
    hasExchange && orderReturn.exchangeShippingFee > 0
      ? `交換の送料: ${formatCurrency(orderReturn.exchangeShippingFee, currency)}`
      : null,
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? [...lines, RETURN_FEE_NOTICE] : [];
}

/** 返品の受付のお知らせ（グループ E-3 設計書 9-1 の2）。返品1件ごとに1通。返品の材料・返送先（返送が要る時）が無ければ作らない */
function composeReturnAccepted(material: OrderEmailMaterial): ComposedOrderEmail | null {
  const { order, orderReturn } = material;
  if (!orderReturn || orderReturn.items.length === 0) {
    return null;
  }
  const shipping = returnShippingLines(orderReturn, order.currency);
  if (!shipping) {
    return null;
  }
  const orderNumber = toOrderNumber(order.id);
  return {
    subject: `【${SHOP_NAME}】返品の受付のお知らせ（${orderNumber}）`,
    text: paragraphs(
      [greeting(order.shipping_full_name)],
      [`ご注文（${orderNumber}）の返品を承りました（返品番号 ${formatReturnNumber(order.id, orderReturn.number)}）。`],
      ['ご返送いただく商品:', ...orderReturn.items.map(returnItemLine)],
      orderReturn.exchangePlan.length > 0
        ? [
            '交換でお届けする商品:',
            ...orderReturn.exchangePlan.map(
              (item) => `${returnItemLine(item)}${item.method === 'make' ? RETURN_EXCHANGE_MAKE_SUFFIX : ''}`,
            ),
          ]
        : [],
      shipping,
      returnFeeLines(orderReturn, order.currency),
      [RETURN_ACCEPTED_CLOSING],
      [contactLine(order.id)],
      [SHOP_NAME],
    ).join('\n'),
  };
}

/**
 * 返品の受け取りのお知らせ（件名は「返品をお受け取りしました」。グループ E-3 設計書 9-1 の5）。今は返金しない受け取り（交換だけ・額を相談・お返しを含む）、
 * 今返金で返金が0円になった受け取り（本計画 P24）、今返金が Stripe に受け付けられなかった受け取り（本計画 P25）に1通。
 * 受け取りの材料・受け取った品が無い、お返しのメッセージが無ければ作らない
 */
function composeReturnReceived(material: OrderEmailMaterial): ComposedOrderEmail | null {
  const { order, orderReturn } = material;
  const receipt = orderReturn?.receipt;
  if (!orderReturn || !receipt || receipt.received.length === 0) {
    return null;
  }
  const sentBack = sentBackSectionLines(receipt);
  if (sentBack === null) {
    return null;
  }
  return {
    subject: `【${SHOP_NAME}】返品をお受け取りしました（${toOrderNumber(order.id)}）`,
    text: paragraphs(
      [greeting(order.shipping_full_name)],
      [returnReceivedLead(formatReturnNumber(order.id, orderReturn.number))],
      ['お受け取りした商品:', ...receipt.received.map(returnItemLine)],
      exchangeSectionLines(receipt.exchanges),
      // 額を相談する時と、今返金が受け付けられなかった時（本計画 P25）は、額を改めて伝える
      receipt.refundChoice === 'consult' || receipt.refundNotAccepted ? [RETURN_REFUND_CONSULT_NOTICE] : [],
      receipt.refundWaived ? [RETURN_REFUND_WAIVED_NOTICE] : [],
      receipt.exchanges.length > 0 && orderReturn.feeWaitingAmount > 0
        ? [returnFeeWaitingNotice(formatCurrency(orderReturn.feeWaitingAmount, order.currency))]
        : [],
      sentBack,
      [contactLine(order.id)],
      [SHOP_NAME],
    ).join('\n'),
  };
}

/**
 * 品物のお返しのお知らせ（件名は「品物をお返しします」。グループ E-3 設計書 9-1 の6）。受け取った品を全部お返しする受け取りに1通。
 * 受け取りの材料・お返しの品が無い、お返しのメッセージが無ければ作らない
 */
function composeReturnSentBack(material: OrderEmailMaterial): ComposedOrderEmail | null {
  const { order, orderReturn } = material;
  const receipt = orderReturn?.receipt;
  if (!orderReturn || !receipt) {
    return null;
  }
  const sentBack = sentBackSectionLines(receipt);
  if (!sentBack || sentBack.length === 0) {
    return null;
  }
  return {
    subject: `【${SHOP_NAME}】品物をお返しします（${toOrderNumber(order.id)}）`,
    text: paragraphs(
      [greeting(order.shipping_full_name)],
      [
        `ご返品いただいた商品を確かめましたが、返品・交換をお受けできませんでした（返品番号 ${formatReturnNumber(order.id, orderReturn.number)}）。品物はお返しいたします。`,
      ],
      sentBack,
      [contactLine(order.id)],
      [SHOP_NAME],
    ).join('\n'),
  };
}

/**
 * 店への知らせ（返金待ち。グループ E-3 設計書 9-2 の11）。サポートの受け取りで返金待ちになった時の、店あてのメール。
 * お客様の氏名・住所・メールは入れない（宛先は worker が店のアドレスにする）。返金待ちの品が無ければ作らない
 */
function composeReturnRefundPendingShop(material: OrderEmailMaterial): ComposedOrderEmail | null {
  const { order, orderReturn } = material;
  const pending = orderReturn?.receipt?.pendingRefund;
  if (!orderReturn || !pending || pending.items.length === 0) {
    return null;
  }
  return {
    subject: `【要対応】返金待ちの返品があります（${toOrderNumber(order.id)}）`,
    text: paragraphs(
      [`返品 ${formatReturnNumber(order.id, orderReturn.number)} の品を受け取りました（受け取った人: ${RETURN_SHOP_RECEIVER}）。`],
      [
        '受け取った返金の品:',
        ...pending.items.map(returnItemLine),
        `計算どおりの額: ${formatCurrency(pending.amount, order.currency)}`,
      ],
      [RETURN_SHOP_ACTION],
    ).join('\n'),
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
  const paidAmount = order.paid_amount ?? order.total_amount;
  const refundAmount = formatCurrency(refund.amount, order.currency);
  const refundNotice = refund.amount < paidAmount
    ? `お支払いいただいた金額のうち、残りの ${refundAmount} を返金いたします。`
    : `お支払いいただいた ${refundAmount}（全額）を返金いたします。`;
  return {
    subject: canceledSubject(order.id),
    text: [
      greeting(order.shipping_full_name),
      '',
      refund.cancelReason ? PAID_CANCEL_LEADS[refund.cancelReason] : PAID_CANCEL_LEAD_DEFAULT,
      refundNotice,
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
      // 交換の品の行がある発送だけ、冒頭の次の行に交換の一文を書く（グループ E-3 設計書 9-1 の7）
      ...(fulfillment.lines.some((line) => line.exchange) ? [SHIPPED_EXCHANGE_NOTICE] : []),
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
      return composeRefund(
        material,
        request.variant === 'after_cancel' ? 'after_cancel' : request.variant === 'return' ? 'return' : 'standard',
      );
    case 'return_accepted':
      return composeReturnAccepted(material);
    case 'return_received':
      return composeReturnReceived(material);
    case 'return_sent_back':
      return composeReturnSentBack(material);
    case 'return_refund_pending_shop':
      return composeReturnRefundPendingShop(material);
  }
}
