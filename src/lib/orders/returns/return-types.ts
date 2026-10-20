import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderRefundStatus } from '@/lib/orders/refund/refund-types';

/**
 * 返品の窓口の形と記号（グループ E-3 設計書 3〜8 章）。窓口・DB の呼び出し・画面が同じ型を使うので、画面からも読む。
 * サーバーだけの物を import しない（型だけの import に限る）。
 * DB の関数が返す jsonb は、ここの型のキーを snake_case にした形（fulfillment_id・deadline_date・refund_amounts_by_count など）。
 * camelCase への直しは return-store.ts だけが行う。
 */
export const RETURN_STATUSES = ['requested', 'open', 'closed', 'cancelled', 'declined'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export const RETURN_DISPLAY_STATUSES = ['requested', 'in_progress', 'refund_waiting', 'returned'] as const;
export type ReturnDisplayStatus = (typeof RETURN_DISPLAY_STATUSES)[number];
export const RETURN_MARKS = ['awaiting_items', 'partially_received', 'pending_inspection', 'awaiting_fee'] as const;
export type ReturnMark = (typeof RETURN_MARKS)[number];
export const RETURN_NEXT_ACTIONS = ['review_request', 'refund', 'receive', 'none'] as const;
export type ReturnNextAction = (typeof RETURN_NEXT_ACTIONS)[number];
export const RETURN_REASONS = ['defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style', 'not_as_described', 'unwanted', 'other', 'unknown'] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export type ReturnResolution = 'refund' | 'exchange';
export type ExchangeMethod = 'stock' | 'make';
export type ReturnMethod = 'customer_ships' | 'shop_label' | 'not_required';
export type ShippingPayer = 'shop' | 'customer';
export const RETURN_CARRIERS = ['yamato', 'sagawa', 'japanpost', 'other'] as const;
export type ReturnCarrier = (typeof RETURN_CARRIERS)[number];
export type ReceiptDisposition = 'restocked' | 'not_restocked' | 'pending_inspection' | 'sent_back';
export type RefundChoice = 'now' | 'consult' | 'none';
export type OutOfStockExchange = 'make' | 'decline';
// 返品・キャンセルの申し込みのお断りの理由（お店の中だけで使う。お客様には出さない）と、キャンセルの申し込みの状態（段2）
export const RETURN_DECLINE_REASONS = ['window_passed', 'final_sale', 'other'] as const;
export type ReturnDeclineReason = (typeof RETURN_DECLINE_REASONS)[number];
export const CANCEL_REQUEST_STATUSES = ['requested', 'resolved', 'declined', 'closed'] as const;
export type CancelRequestStatus = (typeof CANCEL_REQUEST_STATUSES)[number];
export const RETURN_ERROR_CODES = [
  'RETURN_NOT_FOUND', 'RETURN_ARGUMENT_INVALID', 'RETURN_QUANTITY_EXCEEDS', 'RETURN_EXCHANGE_VARIANT_INVALID',
  'RETURN_ADDRESS_REQUIRED', 'RETURN_STATE_CONFLICT', 'RETURN_RECEIPT_EXCEEDS', 'RETURN_EXCHANGE_OUT_OF_STOCK',
  'RETURN_FORBIDDEN', 'RETURN_REQUEST_MISMATCH', 'RETURN_REASON_NOTE_REQUIRED', 'RETURN_SENT_BACK_MESSAGE_REQUIRED',
  'RETURN_FEE_INVALID', 'RETURN_REFUND_AMOUNT_INVALID', 'RETURN_NOTHING_TO_REFUND', 'FULFILLMENT_HAS_RETURN',
  'FULFILLMENT_EXCHANGE_ON_HOLD', 'ORDER_NOT_RETURNABLE',
  // 段2: お客様の申し込み・お断り・キャンセルの申し込み
  'RETURN_NOT_ELIGIBLE', 'RETURN_REQUESTS_CLOSED', 'RETURN_PHOTO_INVALID', 'RETURN_CUSTOMER_NOTE_REQUIRED',
  'RETURN_DECLINE_MESSAGE_REQUIRED', 'CANCEL_REQUEST_NOT_FOUND', 'CANCEL_REQUEST_EXISTS', 'CANCEL_REQUEST_NOT_ELIGIBLE',
  'CANCEL_REQUEST_QUANTITY_EXCEEDS', 'CANCEL_REQUEST_STATE_CONFLICT', 'CANCEL_REQUEST_RESOLUTION_INVALID',
] as const;
export type ReturnErrorCode = (typeof RETURN_ERROR_CODES)[number];

export type ShopReturnSettings = {
  requestsEnabled: boolean; requestTypes: 'returns_and_cancellations' | 'returns_only' | 'cancellations_only';
  noticeText: string; windowDays: number | null; windowStart: 'each_item' | 'last_item'; deliveryBufferDays: number;
  returnAddress: { name: string; postalCode: string; address: string; phone: string } | null;
  customerPaidMethod: 'customer_ships' | 'shop_label'; shopLabelFee: number; noReturnNeededEnabled: boolean;
  restockingFeeEnabled: boolean; restockingFeePercent: number;
  exchangeFeesEnabled: boolean; exchangeFee: number; exchangeShippingFee: number;
  inspectionEnabled: boolean;
  reasons: Array<{ reason: ReturnReason; shown: boolean; resolutions: 'refund_and_exchange' | 'exchange_only' | 'refund_only';
                   outOfStockExchange: OutOfStockExchange; photo: 'none' | 'optional' | 'required'; photoInstructions: string;
                   shippingPayer: ShippingPayer }>;
  updated: Record<'requests' | 'window' | 'shipping' | 'reasons' | 'fees' | 'receiving', { at: string | null; byEmail: string | null }>;
};
export type ReturnCreateMaterials = {
  order: { id: string; status: OrderStatus; hasAwaitingRefund: boolean };
  shipments: Array<{
    fulfillmentId: string; number: number; shippedAt: string; deadlineDate: string | null; pastDeadline: boolean;
    lines: Array<{ orderItemId: string; itemId: number; variantId: number | null; itemName: string; color: string | null; size: string | null;
                   lineKind: 'order' | 'exchange'; quantity: number; returnable: number; returnIneligible: boolean }>;
  }>;
  exchangeOptions: Array<{ itemId: number; variants: Array<{ variantId: number; color: string | null; size: string | null;
                                                             isActive: boolean; stockQuantity: number; madeToOrderLeadDays: number | null }> }>;
  settings: { returnAddressSet: boolean; noReturnNeededEnabled: boolean; customerPaidMethod: 'customer_ships' | 'shop_label'; shopLabelFee: number;
              restockingFeeEnabled: boolean; restockingFeePercent: number; exchangeFeesEnabled: boolean; exchangeFee: number; exchangeShippingFee: number;
              reasonShippingPayers: Record<ReturnReason, ShippingPayer>; reasonOutOfStockExchange: Record<ReturnReason, OutOfStockExchange> };
};
export type OrderReturnLineDetail = {
  id: string; fulfillmentId: string; fulfillmentNumber: number; orderItemId: string; itemName: string; color: string | null; size: string | null;
  quantity: number; reason: ReturnReason; reasonNote: string | null; resolution: ReturnResolution;
  exchange: { variantId: number; color: string | null; size: string | null; method: ExchangeMethod; stockQuantity: number;
              madeToOrderLeadDays: number | null; outOfStockExchange: OutOfStockExchange } | null;
  progress: { restocked: number; notRestocked: number; pendingInspection: number; sentBack: number; missing: number;
              processed: number; unprocessed: number; exchanged: number; refundCovered: number; refundWaived: number; refundWaiting: number };
  refundAmountsByCount: number[];   // 今から k 点を返金した時の、その注文の商品の額（添字 k−1、長さはこの返品でその注文の商品を指す行の未処理の数の合計。同じ注文の商品の行は同じ列。DB の受け取りが注文の商品ごとに数を足して1回で額を出すのに合わせる）。交換の予定の行も入れる（受け取りで「返金に変える」時の見込みに使う）。受付中でない返品は []
  refundWaitingAmount: number;      // rw の品の商品の額（額を決めて返金の見込み）
  customerNote: string | null;      // お客様の詳しい内容（お客様の申し込みの行だけ。お店が作った行は null）
  requestedResolution: ReturnResolution | null;   // お客様のご希望（申し込みの行だけ）。承認で決める resolution とは別に持つ
  requestedExchange: { variantId: number; color: string | null; size: string | null } | null;   // ご希望の交換の色・サイズ
  photos: Array<{ id: string; purged: boolean }>;   // 申し込みの写真。置き場から消した物は purged
  returnIneligible: boolean;        // 商品が返品不可の印を持つか（items.return_ineligible）。止めずに警告だけ出す
};
export type OrderReturnDetail = {
  id: string; number: number; label: string; status: ReturnStatus; source: 'customer_request' | 'shop';
  displayStatus: ReturnDisplayStatus | null; marks: ReturnMark[];
  returnMethod: ReturnMethod; returnShippingPayer: ShippingPayer; returnCarrier: ReturnCarrier | null; returnTrackingNumber: string | null;
  fees: { returnShippingFee: number; restockingFeePercent: number; exchangeFee: number; exchangeShippingFee: number;
          feeDueAmount: number; feePendingDeduction: number; feeReceivedAt: string | null; exchangeReleasedAt: string | null };
  firstReceiptDone: boolean; firstExchangeReceiptDone: boolean;
  shopNote: string | null; notifyCustomer: boolean; createdAt: string; createdByEmail: string | null;
  closedAt: string | null; cancelledAt: string | null;
  requestedAt: string | null; approvedAt: string | null; approvedByEmail: string | null;
  declinedAt: string | null; declineReason: ReturnDeclineReason | null; declineMessage: string | null;
  lines: OrderReturnLineDetail[];
  refunds: Array<{ id: string; amount: number; status: OrderRefundStatus; createdAt: string }>;
  receipts: Array<{ id: string; kind: 'receive' | 'inspect' | 'close_missing' | 'reopen' | 'waive_refund'; refundChoice: RefundChoice | null;
                    createdAt: string; actorEmail: string | null }>;
  exchangeItems: Array<{ orderItemId: string; itemName: string; color: string | null; size: string | null; quantity: number;
                         fulfillmentType: 'stock' | 'backorder'; shipped: number }>;
};
export type OrderReturnSummary = {
  orderId: string; displayStatus: ReturnDisplayStatus | null; marks: ReturnMark[]; nextAction: ReturnNextAction;
  hasReturnable: boolean; refundWaitingReturns: number; requestedReturns: number;
};

/**
 * 設定の窓口（PUT /api/admin/settings/shop の returns）へ送る返品の設定。キーは ShopReturnSettings と同じ。
 * 段1の画面（ショップの設定の「返品」の欄。P14）が出す欄に、段2の欄（申し込み・種類・注意書き・理由ごとの出す／ご希望／写真と案内の文）を足した形。
 * 段2の欄は任意（?）。渡さない欄は DB が今の値のままにする（設定の窓口も同じ。段2の画面は全部を送る）。
 * windowDays の null は無制限、returnAddress の null は4つとも空に戻す。reasons は理由ごとの行（返送料の負担と在庫の無い交換。段2は出す／ご希望／写真と案内の文）
 */
export type ShopReturnSettingsUpdate = {
  returnAddress: ShopReturnSettings['returnAddress'];
  customerPaidMethod: ShopReturnSettings['customerPaidMethod'];
  shopLabelFee: number;
  noReturnNeededEnabled: boolean;
  windowDays: number | null;
  windowStart: ShopReturnSettings['windowStart'];
  deliveryBufferDays: number;
  reasons: Array<{
    reason: ReturnReason; shippingPayer: ShippingPayer; outOfStockExchange: OutOfStockExchange;
    shown?: boolean; resolutions?: 'refund_and_exchange' | 'exchange_only' | 'refund_only';
    photo?: 'none' | 'optional' | 'required'; photoInstructions?: string;
  }>;
  restockingFeeEnabled: boolean;
  restockingFeePercent: number;
  exchangeFeesEnabled: boolean;
  exchangeFee: number;
  exchangeShippingFee: number;
  inspectionEnabled: boolean;
  requestsEnabled?: boolean;
  requestTypes?: ShopReturnSettings['requestTypes'];
  noticeText?: string;
};

// ---- 段2: 申し込みの承認・写真・キャンセルの申し込み（お店の側） ----

export type ApproveReturnLineInput = {
  returnLineId: string;
  resolution: ReturnResolution;
  exchangeVariantId: number | null;
  exchangeMethod: ExchangeMethod | null;
};
export type ApproveReturnInput = {
  returnId: string;
  actorId: string;
  lines: ApproveReturnLineInput[];
  returnMethod: ReturnMethod;
  returnShippingPayer: ShippingPayer;
  returnCarrier: ReturnCarrier | null;
  returnTrackingNumber: string | null;
  returnShippingFee: number;
  restockingFeePercent: number;
  exchangeFee: number;
  exchangeShippingFee: number;
  shopNote: string | null;
  notifyCustomer: boolean;
};
export type ReturnPhotoRef = { photoId: string; returnLineId: string; storagePath: string; purged: boolean };
export type AdminCancelRequest = {
  id: string;
  status: CancelRequestStatus;
  requestedAt: string;
  customerNote: string | null;
  lines: Array<{ orderItemId: string; itemName: string; color: string | null; size: string | null; quantity: number; unshipped: number }>;
  declineReason: ReturnDeclineReason | null;
  declineMessage: string | null;
  declinedAt: string | null;
  declinedByEmail: string | null;
  resolvedAt: string | null;
  resolvedByEmail: string | null;
  resolvedRefundId: string | null;
  resolvedByCancelAt: string | null;
  closedAt: string | null;
  closedByEmail: string | null;
};
