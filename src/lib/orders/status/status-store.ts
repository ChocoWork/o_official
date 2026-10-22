import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CustomerOrderItemRow,
  CustomerOrderPrivateInput,
  CustomerOrderPublicMaterial,
  CustomerOrderPublicRow,
  PublicCustomerOrderReturns,
} from '@/lib/orders/customer-order-view-types';
import type { OrderLineFulfillmentRow } from '@/lib/orders/fulfillment/fulfillment-store';
import { HIDDEN_ORDER_STATUSES, HIDDEN_ORDER_STATUS_FILTER, ORDER_STATUSES } from '@/lib/orders/order-payment-types';
import { ORDER_REFUND_STATUSES } from '@/lib/orders/refund/refund-types';
import { parseCustomerOrderReturns, parsePublicCustomerOrderReturns } from '@/lib/orders/returns/customer-return-store';
import {
  CUSTOMER_RETURN_STATUSES,
  type CustomerOrderReturns,
  type CustomerReturnStatus,
  type ReturnRequestAvailability,
} from '@/lib/orders/returns/customer-return-types';
import {
  CANCEL_REQUEST_STATUSES,
  RETURN_CARRIERS,
  type ReturnMethod,
  type ReturnResolution,
  type ShippingPayer,
} from '@/lib/orders/returns/return-types';
import { isOrderStatusToken } from '@/lib/orders/status/status-token';
import type { OrderStatusLink, OrderStatusPhoneResult, OrderStatusVerification } from '@/lib/orders/status/status-types';
import { DELIVERY_STATUSES, TRACKING_STATES } from '@/lib/orders/tracking/delivery-types';

/**
 * 注文の状況の頁（グループ E-5。共通の約束 C-1・C-2）の DB の読み出し。
 * 新しい DB の関数の答えは、使う項目を名指しして厳密に直す。数字・列挙・日付・配列の形が壊れた答えを、
 * String(undefined) や空の配列で成功にせず、固定の OrderStatusStoreError で止める。
 * 電話番号の比べ合わせは DB の中だけで済ませる。ここは入力の下4桁を DB へ渡し、DB の判定を受け取るだけで、保存済みの電話を持ち帰らない。
 * 秘密の値・電話・トークン・DB の文は、エラーの文にもログにも出さない（元の DB の誤りは cause にだけ残す）。
 * 公開の読み出し（公開材料・返品 false）は個人情報の表を読まない。個人情報の読み出し（loadOrderStatusPrivateInput）は認可を内包しない。
 * 呼ぶ側は、確認印か持ち主の認証を通した後だけ呼ぶ。
 */
export type OrderStatusStore = Pick<SupabaseClient, 'rpc' | 'from'>;

/** DB の呼び出しの失敗・壊れた答え。message は固定で、DB の文・値を入れない。元の誤りは cause にだけ残す */
export class OrderStatusStoreError extends Error {
  readonly code = 'ORDER_STATUS_STORE_FAILED' as const;

  constructor(
    readonly operation: string,
    cause?: unknown,
  ) {
    super('order status store failed', cause === undefined ? undefined : { cause });
    this.name = 'OrderStatusStoreError';
  }
}

// DB の CHECK（order_status_links_failed_attempts_check）と、20回で止める決まりに合わせる
const MAX_FAILED_ATTEMPTS = 20;

// ---- 厳密な読み取りの道具 ----

type Row = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgREST が返す offset 付きの時刻だけを受ける
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(operation: string): never {
  throw new OrderStatusStoreError(operation);
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function row(value: unknown, operation: string): Row {
  if (!isRow(value)) fail(operation);
  return value;
}

function list(value: unknown, operation: string): unknown[] {
  if (!Array.isArray(value)) fail(operation);
  return value;
}

function text(value: unknown, operation: string): string {
  if (typeof value !== 'string') fail(operation);
  return value;
}

function textOrNull(value: unknown, operation: string): string | null {
  return value === null ? null : text(value, operation);
}

function uuid(value: unknown, operation: string): string {
  const result = text(value, operation);
  if (!UUID_PATTERN.test(result)) fail(operation);
  return result;
}

function uuidOrNull(value: unknown, operation: string): string | null {
  return value === null ? null : uuid(value, operation);
}

function bool(value: unknown, operation: string): boolean {
  if (typeof value !== 'boolean') fail(operation);
  return value;
}

function integer(value: unknown, operation: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(operation);
  return value;
}

function integerOrNull(value: unknown, operation: string): number | null {
  return value === null ? null : integer(value, operation);
}

function oneOf<const Values extends readonly string[]>(value: unknown, allowed: Values, operation: string): Values[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(operation);
  return value as Values[number];
}

function oneOfOrNull<const Values extends readonly string[]>(value: unknown, allowed: Values, operation: string): Values[number] | null {
  return value === null ? null : oneOf(value, allowed, operation);
}

/** 2月30日のような存在しない日も拒む（Date.parse は補正してしまうため） */
function timestamp(value: unknown, operation: string): string {
  const result = text(value, operation);
  const parts = TIMESTAMP_PATTERN.exec(result);
  if (!parts || !Number.isFinite(Date.parse(result))) fail(operation);
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) {
    fail(operation);
  }
  return result;
}

function timestampOrNull(value: unknown, operation: string): string | null {
  return value === null ? null : timestamp(value, operation);
}

// ---- DB の呼び出し ----

async function callRpc(store: OrderStatusStore, operation: string, args: Record<string, unknown>): Promise<unknown> {
  let response: { data: unknown; error: unknown };
  try {
    response = await store.rpc(operation, args);
  } catch (error) {
    throw new OrderStatusStoreError(operation, error);
  }
  if (response.error) {
    throw new OrderStatusStoreError(operation, response.error);
  }
  return response.data;
}

/** 表の読み取り。関数の中で store を呼ぶので、store の例外も固定のエラーにする */
async function readTable(operation: string, run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<unknown> {
  let response: { data: unknown; error: unknown };
  try {
    response = await run();
  } catch (error) {
    throw new OrderStatusStoreError(operation, error);
  }
  if (response.error) {
    throw new OrderStatusStoreError(operation, response.error);
  }
  return response.data;
}

// ---- リンクと確かめ ----

/** 注文のトークンを用意する（無ければ作り、あれば保存済みの値を返す。再発行しない） */
export async function ensureOrderStatusLink(store: OrderStatusStore, orderId: string): Promise<string> {
  const operation = 'ensure_order_status_link';
  const token = await callRpc(store, operation, { _order_id: orderId });
  if (!isOrderStatusToken(token)) fail(operation);
  return token;
}

/** トークンから注文のリンクを引く。形が違う・存在しない・お客様に隠す状態の注文は null（形が違えば DB を呼ばない） */
export async function getOrderStatusLink(store: OrderStatusStore, token: string): Promise<OrderStatusLink | null> {
  if (!isOrderStatusToken(token)) {
    return null;
  }
  const operation = 'get_order_status_link';
  const rows = list(await callRpc(store, operation, { _token: token }), operation);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) fail(operation);
  const link = row(rows[0], operation);
  return {
    orderId: uuid(link.order_id, operation),
    customerId: uuidOrNull(link.customer_id, operation),
    verifyUntil: timestampOrNull(link.verify_until, operation),
    failedAttempts: integer(link.failed_attempts, operation, 0, MAX_FAILED_ATTEMPTS),
    phoneAvailable: bool(link.phone_available, operation),
  };
}

/**
 * 電話番号の下4桁を DB で比べる（比較と失敗の数の加算は DB の同じ取引の中。ここでは電話を比べ直さない）。
 * 形が違う・存在しない・お客様に隠す状態の注文は null。入力の形（数字4桁）は呼ぶ側が確かめてから渡す
 */
export async function verifyOrderStatusPhone(
  store: OrderStatusStore,
  input: { token: string; lastFour: string },
): Promise<OrderStatusPhoneResult | null> {
  if (!isOrderStatusToken(input.token)) {
    return null;
  }
  const operation = 'verify_order_status_phone';
  const rows = list(await callRpc(store, operation, { _token: input.token, _last_four: input.lastFour }), operation);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1) fail(operation);
  const answer = row(rows[0], operation);
  return {
    result: oneOf(answer.result, ['ok', 'mismatch', 'locked', 'unavailable', 'expired'] as const, operation),
    verifyUntil: timestampOrNull(answer.verify_until, operation),
    failedAttempts: integer(answer.failed_attempts, operation, 0, MAX_FAILED_ATTEMPTS),
  };
}

/**
 * リンクの期限・電話の有無・失敗の数だけから、電話番号の下4桁で確かめられるかを決める。
 * 判定の順は 期限切れ（期限が無い・同時刻を含む） → 利用不可（電話が無い） → ロック（失敗20回）（P19）
 */
export function orderStatusVerification(link: OrderStatusLink, now: Date = new Date()): OrderStatusVerification {
  const verifyUntil = link.verifyUntil === null ? Number.NaN : Date.parse(link.verifyUntil);
  if (!(verifyUntil > now.getTime())) {
    return { verifiable: false, reason: 'expired' };
  }
  if (!link.phoneAvailable) {
    return { verifiable: false, reason: 'unavailable' };
  }
  if (link.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    return { verifiable: false, reason: 'locked' };
  }
  return { verifiable: true, reason: null };
}

// ---- 公開材料 ----

const PUBLIC_MATERIAL_OPERATION = 'get_order_status_public_material';
const PUBLIC_ORDER_STATUSES = ORDER_STATUSES.filter(
  (status): status is CustomerOrderPublicRow['status'] => !(HIDDEN_ORDER_STATUSES as readonly string[]).includes(status),
);

function toOrderItem(value: unknown): CustomerOrderItemRow {
  const operation = PUBLIC_MATERIAL_OPERATION;
  const item = row(value, operation);
  return {
    id: uuid(item.id, operation),
    item_id: integerOrNull(item.item_id, operation),
    variant_id: integerOrNull(item.variant_id, operation),
    item_name: text(item.item_name, operation),
    item_image_url: textOrNull(item.item_image_url, operation),
    color: textOrNull(item.color, operation),
    size: textOrNull(item.size, operation),
    quantity: integer(item.quantity, operation),
    line_total: integer(item.line_total, operation),
    line_kind: oneOf(item.line_kind, ['order', 'exchange'] as const, operation),
  };
}

function toLineRow(value: unknown): OrderLineFulfillmentRow {
  const operation = PUBLIC_MATERIAL_OPERATION;
  const line = row(value, operation);
  return {
    orderId: uuid(line.order_id, operation),
    orderItemId: uuid(line.order_item_id, operation),
    variantId: integerOrNull(line.variant_id, operation),
    fulfillmentType: text(line.fulfillment_type, operation),
    quantity: integer(line.quantity, operation),
    shipped: integer(line.shipped, operation),
    completed: integer(line.completed, operation),
    refundedBeforeShipment: integer(line.refunded_before_shipment, operation),
    refundedAfterShipment: integer(line.refunded_after_shipment, operation),
    inProduction: integer(line.in_production, operation),
    readyUnshipped: integer(line.ready_unshipped, operation),
    unshipped: integer(line.unshipped, operation),
  };
}

function toFulfillment(value: unknown): CustomerOrderPublicMaterial['fulfillments'][number] {
  const operation = PUBLIC_MATERIAL_OPERATION;
  const fulfillment = row(value, operation);
  return {
    fulfillmentId: uuid(fulfillment.fulfillment_id, operation),
    number: integer(fulfillment.number, operation, 1),
    shippingCarrier: textOrNull(fulfillment.shipping_carrier, operation),
    shippedAt: timestamp(fulfillment.shipped_at, operation),
    cancelledAt: timestampOrNull(fulfillment.cancelled_at, operation),
    lines: list(fulfillment.lines, operation).map((entry) => {
      const line = row(entry, operation);
      return { orderItemId: uuid(line.order_item_id, operation), quantity: integer(line.quantity, operation, 1) };
    }),
  };
}

function toDeliveryDetail(value: unknown): CustomerOrderPublicMaterial['deliveryDetail'] {
  const operation = PUBLIC_MATERIAL_OPERATION;
  const detail = row(value, operation);
  return {
    enabled: bool(detail.enabled, operation),
    fulfillments: list(detail.fulfillments, operation).map((entry) => {
      const delivery = row(entry, operation);
      const registration = delivery.registration === null ? null : row(delivery.registration, operation);
      return {
        fulfillmentId: uuid(delivery.fulfillment_id, operation),
        cancelledAt: timestampOrNull(delivery.cancelled_at, operation),
        trackingVersion: integer(delivery.tracking_version, operation, 1),
        deliveryStatus: oneOf(delivery.delivery_status, DELIVERY_STATUSES, operation),
        deliveryStatusAt: timestamp(delivery.delivery_status_at, operation),
        deliveredAt: timestampOrNull(delivery.delivered_at, operation),
        registration: registration
          ? { state: oneOf(registration.state, TRACKING_STATES, operation), everRegistered: bool(registration.ever_registered, operation) }
          : null,
        events: list(delivery.events, operation).map((event) => {
          const record = row(event, operation);
          return {
            trackingVersion: integer(record.tracking_version, operation, 1),
            status: oneOf(record.status, DELIVERY_STATUSES, operation),
            happenedAt: timestamp(record.happened_at, operation),
            recordedAt: timestamp(record.recorded_at, operation),
          };
        }),
      };
    }),
  };
}

function toRefund(value: unknown): CustomerOrderPublicMaterial['refundRows'][number] {
  const operation = PUBLIC_MATERIAL_OPERATION;
  const refund = row(value, operation);
  return {
    refundId: uuid(refund.refund_id, operation),
    createdAt: timestamp(refund.created_at, operation),
    amount: integer(refund.amount, operation),
    status: oneOf(refund.status, ORDER_REFUND_STATUSES, operation),
  };
}

function toPublicMaterial(value: unknown): CustomerOrderPublicMaterial {
  const operation = PUBLIC_MATERIAL_OPERATION;
  const root = row(value, operation);
  const order = row(root.order, operation);
  const summary = row(root.delivery_summary, operation);
  const activeCount = integer(summary.active_count, operation);
  const deliveredCount = integer(summary.delivered_count, operation);
  if (deliveredCount > activeCount) fail(operation);
  return {
    order: {
      id: uuid(order.id, operation),
      created_at: timestamp(order.created_at, operation),
      status: oneOf(order.status, PUBLIC_ORDER_STATUSES, operation),
      subtotal_amount: integer(order.subtotal_amount, operation),
      shipping_amount: integer(order.shipping_amount, operation),
      discount_amount: integer(order.discount_amount, operation),
      total_amount: integer(order.total_amount, operation),
      currency: text(order.currency, operation),
      order_items: list(order.order_items, operation).map(toOrderItem),
    },
    lineRows: list(root.line_rows, operation).map(toLineRow),
    fulfillments: list(root.fulfillments, operation).map(toFulfillment),
    deliveryDetail: toDeliveryDetail(root.delivery_detail),
    deliverySummary: { activeCount, deliveredCount },
    refundRows: list(root.refund_rows, operation).map(toRefund),
  };
}

/**
 * 注文の公開の材料（個人情報・支払方法・伝票番号を DB が最初から返さない）。注文が無い・お客様に隠す状態は null。
 * 認可は要らない（トークンを知っていれば見られる範囲だけ）。電話・住所・伝票番号の表は読まない
 */
export async function loadOrderStatusPublicMaterial(store: OrderStatusStore, orderId: string): Promise<CustomerOrderPublicMaterial | null> {
  const data = await callRpc(store, PUBLIC_MATERIAL_OPERATION, { _order_id: orderId });
  return data === null ? null : toPublicMaterial(data);
}

// ---- 返品 ----

const RETURNS_OPERATION = 'get_order_status_returns';
const RETURN_METHODS = ['customer_ships', 'shop_label', 'not_required'] as const satisfies readonly ReturnMethod[];
const SHIPPING_PAYERS = ['shop', 'customer'] as const satisfies readonly ShippingPayer[];
const RETURN_STATUSES = ['requested', 'open', 'closed', 'declined'] as const;
const RETURN_RESOLUTIONS = ['refund', 'exchange'] as const satisfies readonly ReturnResolution[];
const EXCHANGE_SHIPPING_STATES = ['none', 'pending', 'shipped'] as const;
const RETURN_AVAILABILITIES = ['available', 'ended', 'closed', 'none'] as const satisfies readonly ReturnRequestAvailability[];

function checkColorSize(value: unknown, operation: string): void {
  if (value === null) return;
  const entry = row(value, operation);
  textOrNull(entry.color, operation);
  textOrNull(entry.size, operation);
}

/**
 * 返品の欄の jsonb の形を厳密に確かめる（会員の画面の変換と共有する変換は、足りない値を String(undefined) などで埋める許容を持つため、
 * 新しい読み出しでは先にここで止める）。includePrivate の時だけ、返送先（null か4項目）と送り返しの業者・伝票番号のキーを要る
 */
function assertReturnsShape(value: unknown, includePrivate: boolean): void {
  const operation = RETURNS_OPERATION;
  const root = row(value, operation);
  for (const entry of list(root.returns, operation)) {
    const record = row(entry, operation);
    uuid(record.id, operation);
    integer(record.number, operation, 1);
    oneOf(record.status, RETURN_STATUSES, operation);
    oneOf(record.customer_status, CUSTOMER_RETURN_STATUSES, operation);
    oneOf(record.return_method, RETURN_METHODS, operation);
    oneOf(record.return_shipping_payer, SHIPPING_PAYERS, operation);
    integer(record.return_shipping_fee, operation);
    timestampOrNull(record.requested_at, operation);
    timestampOrNull(record.closed_at, operation);
    for (const lineEntry of list(record.lines, operation)) {
      const line = row(lineEntry, operation);
      text(line.item_name, operation);
      textOrNull(line.color, operation);
      textOrNull(line.size, operation);
      integer(line.quantity, operation);
      oneOfOrNull(line.requested_resolution, RETURN_RESOLUTIONS, operation);
      checkColorSize(line.requested_exchange, operation);
      oneOf(line.resolution, RETURN_RESOLUTIONS, operation);
      checkColorSize(line.exchange, operation);
    }
    integerOrNull(record.refund_amount, operation);
    for (const sentEntry of list(record.sent_back, operation)) {
      const sent = row(sentEntry, operation);
      text(sent.item_name, operation);
      textOrNull(sent.color, operation);
      textOrNull(sent.size, operation);
      integer(sent.quantity, operation);
      textOrNull(sent.message, operation);
      if (includePrivate) {
        oneOfOrNull(sent.carrier, RETURN_CARRIERS, operation);
        textOrNull(sent.tracking_number, operation);
      }
    }
    textOrNull(record.decline_message, operation);
    oneOf(record.exchange_shipping, EXCHANGE_SHIPPING_STATES, operation);
    if (includePrivate && record.return_address !== null) {
      // キーが無い（undefined）時も、ここで row() が断る
      const address = row(record.return_address, operation);
      text(address.name, operation);
      text(address.postal_code, operation);
      text(address.address, operation);
      text(address.phone, operation);
    }
  }
  for (const entry of list(root.cancel_requests, operation)) {
    const request = row(entry, operation);
    uuid(request.id, operation);
    oneOf(request.status, CANCEL_REQUEST_STATUSES, operation);
    timestamp(request.requested_at, operation);
    for (const lineEntry of list(request.lines, operation)) {
      const line = row(lineEntry, operation);
      text(line.item_name, operation);
      textOrNull(line.color, operation);
      textOrNull(line.size, operation);
      integer(line.quantity, operation);
    }
    textOrNull(request.decline_message, operation);
  }
  const availability = row(root.availability, operation);
  oneOf(availability.returns, RETURN_AVAILABILITIES, operation);
  textOrNull(availability.ended_on, operation);
  bool(availability.cancel, operation);
}

/**
 * 注文の返品の欄を、注文の番号で読む（持ち主の条件は無い）。注文が無い・お客様に隠す状態は null。
 * includePrivate が false なら、返送先と送り返しの業者・伝票番号を DB が作らない公開の形で、結果にもそのキーを作らない。
 * true は会員の画面と同じ形（個人情報を含むので、認可の後だけ呼ぶ）
 */
export async function loadOrderStatusReturns(
  store: OrderStatusStore,
  input: { orderId: string; includePrivate: false },
): Promise<PublicCustomerOrderReturns | null>;
export async function loadOrderStatusReturns(
  store: OrderStatusStore,
  input: { orderId: string; includePrivate: true },
): Promise<CustomerOrderReturns | null>;
export async function loadOrderStatusReturns(
  store: OrderStatusStore,
  input: { orderId: string; includePrivate: boolean },
): Promise<PublicCustomerOrderReturns | CustomerOrderReturns | null> {
  const data = await callRpc(store, RETURNS_OPERATION, { _order_id: input.orderId, _include_private: input.includePrivate });
  if (data === null) {
    return null;
  }
  assertReturnsShape(data, input.includePrivate);
  const parsed = input.includePrivate
    ? parseCustomerOrderReturns(data, input.orderId)
    : parsePublicCustomerOrderReturns(data, input.orderId);
  return parsed ?? fail(RETURNS_OPERATION);
}

// ---- 個人情報（認可の後だけ） ----

const PRIVATE_ORDER_COLUMNS =
  'shipping_full_name,shipping_postal_code,shipping_prefecture,shipping_city,shipping_address,shipping_building,shipping_phone,shipping_email,payment_intent_id';
const PRIVATE_FULFILLMENT_COLUMNS = 'id,number,shipping_carrier,tracking_number,cancelled_at';
// 返送のしかた（返送先）を案内するのは、これから送る間だけ（会員の注文の画面と同じ）
const RETURN_ADDRESS_STATUSES: readonly CustomerReturnStatus[] = ['accepted', 'partially_received'];

/** 支払方法の記録（checkout_drafts）は、注文確定時の payment_intent_id で引く。会員の画面と同じ */
async function loadPaymentMethod(store: OrderStatusStore, paymentIntentId: string | null): Promise<string | null> {
  if (!paymentIntentId) {
    return null;
  }
  const operation = 'checkout_drafts';
  const data = await readTable(operation, () =>
    store.from('checkout_drafts').select('payment_method').eq('payment_intent_id', paymentIntentId).limit(1).maybeSingle(),
  );
  return data === null ? null : textOrNull(row(data, operation).payment_method, operation);
}

/** 取消でない発送の伝票番号。番号の昇順 */
async function loadPrivateFulfillments(store: OrderStatusStore, orderId: string): Promise<CustomerOrderPrivateInput['fulfillments']> {
  const operation = 'order_fulfillments';
  const data = await readTable(operation, () =>
    store
      .from('order_fulfillments')
      .select(PRIVATE_FULFILLMENT_COLUMNS)
      .eq('order_id', orderId)
      .is('cancelled_at', null)
      .order('number', { ascending: true }),
  );
  return list(data, operation).map((entry) => {
    const fulfillment = row(entry, operation);
    return {
      fulfillmentId: uuid(fulfillment.id, operation),
      number: integer(fulfillment.number, operation, 1),
      shippingCarrier: textOrNull(fulfillment.shipping_carrier, operation),
      trackingNumber: textOrNull(fulfillment.tracking_number, operation),
      cancelledAt: timestampOrNull(fulfillment.cancelled_at, operation),
    };
  });
}

/**
 * お届け先・連絡先メール・支払方法・発送の伝票番号・返品の返送先と送り返しの伝票番号を読む。認可を内包しない。
 * 呼ぶ側は、有効な確認印か持ち主の認証を通した後だけ呼ぶ。注文が無い・お客様に隠す状態（読む間に隠れた場合を含む）は null。
 * 返送先は accepted / partially_received の返品だけに残し、送り返しは DB の並び（元の配列のindex）のまま渡す。
 */
export async function loadOrderStatusPrivateInput(store: OrderStatusStore, orderId: string): Promise<CustomerOrderPrivateInput | null> {
  const operation = 'orders';
  const data = await readTable(operation, () =>
    store
      .from('orders')
      .select(PRIVATE_ORDER_COLUMNS)
      .eq('id', orderId)
      .not('status', 'in', HIDDEN_ORDER_STATUS_FILTER)
      .maybeSingle(),
  );
  if (data === null) {
    return null;
  }
  const order = row(data, operation);
  const shipping: CustomerOrderPrivateInput['order'] = {
    shipping_full_name: textOrNull(order.shipping_full_name, operation),
    shipping_postal_code: textOrNull(order.shipping_postal_code, operation),
    shipping_prefecture: textOrNull(order.shipping_prefecture, operation),
    shipping_city: textOrNull(order.shipping_city, operation),
    shipping_address: textOrNull(order.shipping_address, operation),
    shipping_building: textOrNull(order.shipping_building, operation),
    shipping_phone: textOrNull(order.shipping_phone, operation),
    shipping_email: textOrNull(order.shipping_email, operation),
  };
  const paymentIntentId = textOrNull(order.payment_intent_id, operation);

  const [paymentMethod, fulfillments, returnSection] = await Promise.all([
    loadPaymentMethod(store, paymentIntentId),
    loadPrivateFulfillments(store, orderId),
    loadOrderStatusReturns(store, { orderId, includePrivate: true }),
  ]);
  if (returnSection === null) {
    return null;
  }

  return {
    order: shipping,
    paymentMethod,
    fulfillments,
    returnSection: {
      ...returnSection,
      returns: returnSection.returns.map((entry) =>
        RETURN_ADDRESS_STATUSES.includes(entry.customerStatus) ? entry : { ...entry, returnAddress: null },
      ),
    },
  };
}
