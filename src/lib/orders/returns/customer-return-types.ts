import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type {
  CancelRequestStatus,
  OutOfStockExchange,
  ReturnCarrier,
  ReturnMethod,
  ReturnReason,
  ReturnResolution,
  ShippingPayer,
} from '@/lib/orders/returns/return-types';

/**
 * お客様の返品・交換の申し込みの形（グループ E-3 段2。共通の約束 C-2）。お客様の窓口・DB の呼び出し・お客様の画面が同じ型を使うので、画面からも読む。
 * サーバーだけの物を import しない（型だけの import に限る）。
 * DB の関数が返す jsonb は、ここの型のキーを snake_case にした形（fulfillment_id・deadline_date・customer_status など）。
 * camelCase への直しは customer-return-store.ts だけが行う。
 * お客様に出さない物（店のメモ・お断りの理由の記号・した人のメール・返金の失敗の中身）は、型にも持たない（P19）。
 */
export const CUSTOMER_RETURN_STATUSES = [
  'requested', 'accepted', 'partially_received', 'inspecting', 'awaiting_fee', 'refund_preparing', 'returned', 'declined',
] as const;
export type CustomerReturnStatus = (typeof CUSTOMER_RETURN_STATUSES)[number];
export type CustomerReturnLineState = 'selectable' | 'past_deadline' | 'requested' | 'sent_back' | 'unavailable';
export type ReturnRequestAvailability = 'available' | 'ended' | 'closed' | 'none';
export type CustomerReturnReason = Exclude<ReturnReason, 'unknown'>;
export type ReasonResolutions = 'refund_and_exchange' | 'exchange_only' | 'refund_only';
export type ReasonPhotoRule = 'none' | 'optional' | 'required';

export type CustomerReturnRequestMaterials = {
  order: { id: string; status: OrderStatus };
  availability: { returns: ReturnRequestAvailability; endedOn: string | null };
  noticeText: string;
  shipments: Array<{
    fulfillmentId: string;
    number: number;
    shippedAt: string;
    deadlineDate: string | null;
    pastDeadline: boolean;
    lines: Array<{
      orderItemId: string;
      itemId: number;
      itemName: string;
      color: string | null;
      size: string | null;
      lineKind: 'order' | 'exchange';
      quantity: number;
      selectable: number;
      state: CustomerReturnLineState;
      returnIneligible: boolean;
    }>;
  }>;
  reasons: Array<{
    reason: CustomerReturnReason;
    resolutions: ReasonResolutions;
    outOfStockExchange: OutOfStockExchange;
    photo: ReasonPhotoRule;
    photoInstructions: string;
    shippingPayer: ShippingPayer;
  }>;
  exchangeOptions: Array<{
    itemId: number;
    variants: Array<{ variantId: number; color: string | null; size: string | null; stockQuantity: number; madeToOrderLeadDays: number | null }>;
  }>;
  fees: {
    customerPaidMethod: 'customer_ships' | 'shop_label';
    shopLabelFee: number;
    restockingFeePercent: number;
    exchangeFee: number;
    exchangeShippingFee: number;
  };
};

export type ReturnPhotoMeta = { uploadId: string; contentType: 'image/jpeg' | 'image/png'; sizeBytes: number };
export type CustomerReturnRequestLineInput = {
  fulfillmentId: string;
  orderItemId: string;
  quantity: number;
  reason: CustomerReturnReason;
  customerNote: string | null;
  requestedResolution: ReturnResolution;
  requestedExchangeVariantId: number | null;
  photos: ReturnPhotoMeta[];
};
export type CustomerReturnRequestInput = {
  orderId: string;
  customerId: string;
  requestKey: string;
  lines: CustomerReturnRequestLineInput[];
};
export type CustomerRequestedReturn = { returnId: string; number: number; status: 'requested'; replayed: boolean };

export type CustomerOrderReturn = {
  id: string;
  number: number;
  label: string;
  status: 'requested' | 'open' | 'closed' | 'declined';
  customerStatus: CustomerReturnStatus;
  returnMethod: ReturnMethod;
  returnShippingPayer: ShippingPayer;
  returnShippingFee: number;
  returnAddress: { name: string; postalCode: string; address: string; phone: string } | null;
  requestedAt: string | null;
  closedAt: string | null;
  lines: Array<{
    itemName: string;
    color: string | null;
    size: string | null;
    quantity: number;
    requestedResolution: ReturnResolution | null;
    requestedExchange: { color: string | null; size: string | null } | null;
    resolution: ReturnResolution;
    exchange: { color: string | null; size: string | null } | null;
  }>;
  refundAmount: number | null;
  sentBack: Array<{
    itemName: string;
    color: string | null;
    size: string | null;
    quantity: number;
    message: string | null;
    carrier: ReturnCarrier | null;
    trackingNumber: string | null;
  }>;
  declineMessage: string | null;
  exchangeShipping: 'none' | 'pending' | 'shipped';
};
export type CustomerCancelRequest = {
  id: string;
  status: CancelRequestStatus;
  requestedAt: string;
  lines: Array<{ itemName: string; color: string | null; size: string | null; quantity: number }>;
  declineMessage: string | null;
};
export type CustomerOrderReturns = {
  returns: CustomerOrderReturn[];
  cancelRequests: CustomerCancelRequest[];
  availability: { returns: ReturnRequestAvailability; endedOn: string | null; cancel: boolean };
};
export type CustomerCancelRequestInput = {
  orderId: string;
  customerId: string;
  requestKey: string;
  lines: Array<{ orderItemId: string; quantity: number }>;
  customerNote: string | null;
};
export type CustomerRequestedCancel = { cancelRequestId: string; status: 'requested'; replayed: boolean };
