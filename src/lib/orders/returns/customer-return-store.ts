import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import {
  CUSTOMER_RETURN_STATUSES,
  type CustomerCancelRequest,
  type CustomerCancelRequestInput,
  type CustomerOrderReturn,
  type CustomerOrderReturns,
  type CustomerRequestedCancel,
  type CustomerRequestedReturn,
  type CustomerReturnLineState,
  type CustomerReturnReason,
  type CustomerReturnRequestInput,
  type CustomerReturnRequestMaterials,
  type ReasonPhotoRule,
  type ReasonResolutions,
  type ReturnRequestAvailability,
} from '@/lib/orders/returns/customer-return-types';
import { formatReturnNumber } from '@/lib/orders/returns/return-messages';
import {
  ReturnStoreError,
  callRpc,
  firstRowOf,
  jsonObjectOf,
  numberOrNull,
  objectOf,
  objectsOf,
  requiredEnum,
  resolutionOrNull,
  textOrNull,
  type JsonObject,
  type ReturnRpcName,
  type ReturnStore,
} from '@/lib/orders/returns/return-store';
import {
  CANCEL_REQUEST_STATUSES,
  type OutOfStockExchange,
  type ReturnCarrier,
  type ReturnMethod,
  type ShippingPayer,
} from '@/lib/orders/returns/return-types';

/**
 * お客様の返品・交換・キャンセルの申し込みの DB の関数を呼ぶ（グループ E-3 段2。共通の約束 C-1・C-2）。お客様の窓口だけが使う。
 * どの関数も、ログインしたお客様の番号（customerId）を渡し、注文の持ち主かどうかを DB が確かめる。
 * 注文が無い・持ち主でない・お客様に隠す状態の注文は、DB が ORDER_NOT_FOUND で断る。
 * 読む関数（材料・注文の画面の返品の欄）は null を返し、書く関数（写真の送り先・返品の申し込み・キャンセルの申し込み）は
 * CustomerOrderNotFoundError を投げる（窓口がどちらも 404「Order not found」にする）。ほかの断りは return-store.ts と同じ ReturnStoreError、
 * 思いがけない失敗は RefundStoreError（DB の文は cause にだけ残す）。
 * DB の関数の jsonb は snake_case。camelCase への直しはこのファイルが行う。お客様に出さない物（店のメモ・お断りの理由の記号・
 * した人のメール・返金の失敗の中身）は、DB が返しても写さない（P19。型にも無い）。
 * サーバーだけで使う（画面から読まない）。単体テストが直接読むので、サーバー専用の印（server-only）は付けない。
 */

/** 注文が無い・持ち主でない・お客様に隠す状態だった（DB の ORDER_NOT_FOUND）。持ち主でない注文の有無を漏らさないため、理由は分けない */
export class CustomerOrderNotFoundError extends Error {
  constructor() {
    super('customer order not found');
    this.name = 'CustomerOrderNotFoundError';
  }
}

/** DB を呼び、ORDER_NOT_FOUND の断りだけを CustomerOrderNotFoundError にする（E-2 の記号 order_not_found の ReturnStoreError から直す） */
async function callOwnedRpc(store: ReturnStore, name: ReturnRpcName, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await callRpc(store, name, args);
  } catch (error) {
    if (error instanceof ReturnStoreError && error.code === 'order_not_found') {
      throw new CustomerOrderNotFoundError();
    }
    throw error;
  }
}

/** 読む関数の入口。注文が無ければ null */
async function readOwnedRpc(store: ReturnStore, name: ReturnRpcName, args: Record<string, unknown>): Promise<JsonObject | null> {
  try {
    const root = jsonObjectOf(await callOwnedRpc(store, name, args));
    if (!root) {
      throw new RefundStoreError(name, null);
    }
    return root;
  } catch (error) {
    if (error instanceof CustomerOrderNotFoundError) {
      return null;
    }
    throw error;
  }
}

const AVAILABILITIES = ['available', 'ended', 'closed', 'none'] as const satisfies readonly ReturnRequestAvailability[];
const LINE_STATES = ['selectable', 'past_deadline', 'requested', 'sent_back', 'unavailable'] as const satisfies readonly CustomerReturnLineState[];
const RETURN_STATUSES_FOR_CUSTOMER = ['requested', 'open', 'closed', 'declined'] as const satisfies readonly CustomerOrderReturn['status'][];
const RESOLUTIONS = ['refund', 'exchange'] as const;

/** 受付の有無。表に無い記号は none（申し込みを出さない側に倒す） */
function availabilityOf(value: unknown): ReturnRequestAvailability {
  return (AVAILABILITIES as readonly unknown[]).includes(value) ? (value as ReturnRequestAvailability) : 'none';
}

/** 品の状態。表に無い記号は unavailable（選べない側に倒す） */
function lineStateOf(value: unknown): CustomerReturnLineState {
  return (LINE_STATES as readonly unknown[]).includes(value) ? (value as CustomerReturnLineState) : 'unavailable';
}

// ---- 申し込みの画面の材料 ----

type RequestShipment = CustomerReturnRequestMaterials['shipments'][number];
type RequestShipmentLine = RequestShipment['lines'][number];
type RequestReason = CustomerReturnRequestMaterials['reasons'][number];
type RequestExchangeOption = CustomerReturnRequestMaterials['exchangeOptions'][number];

function toRequestShipmentLine(line: JsonObject): RequestShipmentLine {
  return {
    orderItemId: String(line.order_item_id),
    itemId: Number(line.item_id),
    itemName: String(line.item_name),
    color: textOrNull(line.color),
    size: textOrNull(line.size),
    lineKind: line.line_kind === 'exchange' ? 'exchange' : 'order',
    quantity: Number(line.quantity),
    selectable: Number(line.selectable),
    state: lineStateOf(line.state),
    returnIneligible: line.return_ineligible === true,
  };
}

function toRequestShipment(shipment: JsonObject): RequestShipment {
  return {
    fulfillmentId: String(shipment.fulfillment_id),
    number: Number(shipment.number),
    shippedAt: String(shipment.shipped_at),
    deadlineDate: textOrNull(shipment.deadline_date),
    pastDeadline: shipment.past_deadline === true,
    lines: objectsOf(shipment.lines).map(toRequestShipmentLine),
  };
}

function toRequestReason(reason: JsonObject): RequestReason {
  return {
    reason: reason.reason as CustomerReturnReason,
    resolutions: reason.resolutions as ReasonResolutions,
    outOfStockExchange: reason.out_of_stock_exchange as OutOfStockExchange,
    photo: reason.photo as ReasonPhotoRule,
    photoInstructions: String(reason.photo_instructions ?? ''),
    shippingPayer: reason.shipping_payer as ShippingPayer,
  };
}

function toRequestExchangeOption(option: JsonObject): RequestExchangeOption {
  return {
    itemId: Number(option.item_id),
    variants: objectsOf(option.variants).map((variant) => ({
      variantId: Number(variant.variant_id),
      color: textOrNull(variant.color),
      size: textOrNull(variant.size),
      stockQuantity: Number(variant.stock_quantity),
      madeToOrderLeadDays: numberOrNull(variant.made_to_order_lead_days),
    })),
  };
}

function toRequestMaterials(root: JsonObject): CustomerReturnRequestMaterials {
  const order = objectOf(root.order);
  const availability = objectOf(root.availability);
  const fees = objectOf(root.fees);
  return {
    order: { id: String(order.id), status: order.status as OrderStatus },
    availability: { returns: availabilityOf(availability.returns), endedOn: textOrNull(availability.ended_on) },
    noticeText: String(root.notice_text ?? ''),
    shipments: objectsOf(root.shipments).map(toRequestShipment),
    reasons: objectsOf(root.reasons).map(toRequestReason),
    exchangeOptions: objectsOf(root.exchange_options).map(toRequestExchangeOption),
    fees: {
      customerPaidMethod: fees.customer_paid_method === 'shop_label' ? 'shop_label' : 'customer_ships',
      shopLabelFee: Number(fees.shop_label_fee),
      restockingFeePercent: Number(fees.restocking_fee_percent),
      exchangeFee: Number(fees.exchange_fee),
      exchangeShippingFee: Number(fees.exchange_shipping_fee),
    },
  };
}

/** 返品・交換の申し込みの画面の材料。注文が無い・持ち主でない時は null */
export async function loadCustomerReturnRequestMaterials(
  store: ReturnStore,
  input: { orderId: string; customerId: string },
): Promise<CustomerReturnRequestMaterials | null> {
  const root = await readOwnedRpc(store, 'get_customer_return_request_materials', {
    _order_id: input.orderId,
    _customer_id: input.customerId,
  });
  return root ? toRequestMaterials(root) : null;
}

// ---- 写真の送り先・返品の申し込み・キャンセルの申し込み ----

/** 写真の送り先を1つ出す（場所は DB が決める）。署名つきの送り先にするのは、呼ぶ側（return-photo-storage.ts） */
export async function createCustomerReturnPhotoUpload(
  store: ReturnStore,
  input: { orderId: string; customerId: string },
): Promise<{ uploadId: string; storagePath: string }> {
  const row = firstRowOf(
    await callOwnedRpc(store, 'customer_create_return_photo_upload', {
      _order_id: input.orderId,
      _customer_id: input.customerId,
    }),
    'customer_create_return_photo_upload',
  );
  return { uploadId: String(row.upload_id), storagePath: String(row.storage_path) };
}

/**
 * 返品・交換を申し込む（状態 requested の返品ができる）。同じ requestKey で同じ中身の送り直しは、前の返品を返す（replayed が true。
 * 通信が切れて答えが分からなかった時の確かめ直し）。違う中身なら RETURN_REQUEST_MISMATCH。
 * status は、送り直しの時に返品が先へ進んでいても、お客様に伝えるのは「受け付けた」ことなので、型のとおり requested に固定する
 */
export async function requestCustomerReturn(
  store: ReturnStore,
  input: CustomerReturnRequestInput,
): Promise<CustomerRequestedReturn> {
  const row = firstRowOf(
    await callOwnedRpc(store, 'customer_request_return', {
      _order_id: input.orderId,
      _customer_id: input.customerId,
      _request_key: input.requestKey,
      _lines: input.lines.map((line) => ({
        fulfillment_id: line.fulfillmentId,
        order_item_id: line.orderItemId,
        quantity: line.quantity,
        reason: line.reason,
        customer_note: line.customerNote,
        requested_resolution: line.requestedResolution,
        requested_exchange_variant_id: line.requestedExchangeVariantId,
        photos: line.photos.map((photo) => ({
          upload_id: photo.uploadId,
          content_type: photo.contentType,
          size_bytes: photo.sizeBytes,
        })),
      })),
    }),
    'customer_request_return',
  );
  return {
    returnId: String(row.return_id),
    number: Number(row.number),
    status: 'requested',
    replayed: row.replayed === true,
  };
}

/** キャンセルを申し込む（未発送の品だけ）。二重防止の扱いは返品の申し込みと同じ */
export async function requestCustomerCancel(
  store: ReturnStore,
  input: CustomerCancelRequestInput,
): Promise<CustomerRequestedCancel> {
  const row = firstRowOf(
    await callOwnedRpc(store, 'customer_request_cancel', {
      _order_id: input.orderId,
      _customer_id: input.customerId,
      _request_key: input.requestKey,
      _lines: input.lines.map((line) => ({ order_item_id: line.orderItemId, quantity: line.quantity })),
      _customer_note: input.customerNote,
    }),
    'customer_request_cancel',
  );
  return {
    cancelRequestId: String(row.cancel_request_id),
    status: 'requested',
    replayed: row.replayed === true,
  };
}

// ---- 注文の画面の返品の欄 ----

type ColorSize = { color: string | null; size: string | null };

function colorSizeOf(value: unknown): ColorSize | null {
  const object = jsonObjectOf(value);
  return object ? { color: textOrNull(object.color), size: textOrNull(object.size) } : null;
}

function exchangeShippingOf(value: unknown): CustomerOrderReturn['exchangeShipping'] {
  return value === 'pending' || value === 'shipped' ? value : 'none';
}

function toCustomerReturn(row: JsonObject, orderId: string): CustomerOrderReturn {
  const operation = 'get_customer_order_returns';
  const address = jsonObjectOf(row.return_address);
  const number = Number(row.number);
  return {
    id: String(row.id),
    number,
    // 番号の文字は DB が作らず、ここで付ける（共通の約束 C-2）
    label: formatReturnNumber(orderId, number),
    status: requiredEnum(row.status, RETURN_STATUSES_FOR_CUSTOMER, operation),
    customerStatus: requiredEnum(row.customer_status, CUSTOMER_RETURN_STATUSES, operation),
    returnMethod: row.return_method as ReturnMethod,
    returnShippingPayer: row.return_shipping_payer as ShippingPayer,
    returnShippingFee: Number(row.return_shipping_fee),
    returnAddress: address
      ? {
          name: String(address.name),
          postalCode: String(address.postal_code),
          address: String(address.address),
          phone: String(address.phone),
        }
      : null,
    requestedAt: textOrNull(row.requested_at),
    closedAt: textOrNull(row.closed_at),
    lines: objectsOf(row.lines).map((line) => ({
      itemName: String(line.item_name),
      color: textOrNull(line.color),
      size: textOrNull(line.size),
      quantity: Number(line.quantity),
      requestedResolution: resolutionOrNull(line.requested_resolution),
      requestedExchange: colorSizeOf(line.requested_exchange),
      resolution: requiredEnum(line.resolution, RESOLUTIONS, operation),
      exchange: colorSizeOf(line.exchange),
    })),
    refundAmount: numberOrNull(row.refund_amount),
    sentBack: objectsOf(row.sent_back).map((item) => ({
      itemName: String(item.item_name),
      color: textOrNull(item.color),
      size: textOrNull(item.size),
      quantity: Number(item.quantity),
      message: textOrNull(item.message),
      carrier: textOrNull(item.carrier) as ReturnCarrier | null,
      trackingNumber: textOrNull(item.tracking_number),
    })),
    declineMessage: textOrNull(row.decline_message),
    exchangeShipping: exchangeShippingOf(row.exchange_shipping),
  };
}

function toCustomerCancelRequest(row: JsonObject): CustomerCancelRequest {
  return {
    id: String(row.id),
    status: requiredEnum(row.status, CANCEL_REQUEST_STATUSES, 'get_customer_order_returns'),
    requestedAt: String(row.requested_at),
    lines: objectsOf(row.lines).map((line) => ({
      itemName: String(line.item_name),
      color: textOrNull(line.color),
      size: textOrNull(line.size),
      quantity: Number(line.quantity),
    })),
    declineMessage: textOrNull(row.decline_message),
  };
}

/**
 * お客様の注文の画面の返品の欄（返品・キャンセルの申し込み・受付の有無）。注文が無い・持ち主でない時は null。
 * 返品は新しい順で、取消の返品は DB が入れない。返送先は受付中の間だけ DB が入れる。番号の文字（label）はここで付ける
 */
export async function loadCustomerOrderReturns(
  store: ReturnStore,
  input: { orderId: string; customerId: string },
): Promise<CustomerOrderReturns | null> {
  const root = await readOwnedRpc(store, 'get_customer_order_returns', {
    _order_id: input.orderId,
    _customer_id: input.customerId,
  });
  if (!root) {
    return null;
  }
  const availability = objectOf(root.availability);
  return {
    returns: objectsOf(root.returns).map((row) => toCustomerReturn(row, input.orderId)),
    cancelRequests: objectsOf(root.cancel_requests).map(toCustomerCancelRequest),
    availability: {
      returns: availabilityOf(availability.returns),
      endedOn: textOrNull(availability.ended_on),
      cancel: availability.cancel === true,
    },
  };
}
