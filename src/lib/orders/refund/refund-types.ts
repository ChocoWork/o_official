import type { CancelReason, OrderStatus } from '@/lib/orders/order-payment-types';

/**
 * 返金の窓口の形と記号（グループ E-2 設計書 3〜5 章）。窓口・DB の呼び出し・画面が同じ型を使うので、
 * 画面からも読む。サーバーだけの物を import しない。
 */
export const ORDER_REFUND_SOURCES = [
  'admin', 'order_cancel', 'stripe_dashboard', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'legacy',
  // 返品の返金（受け取りで今返金・額を決めて返金。グループ E-3）。返金の記録は返品の番号 order_refunds.return_id を持つ
  'return',
] as const;
export type OrderRefundSource = (typeof ORDER_REFUND_SOURCES)[number];
export const ORDER_REFUND_STATUSES = ['awaiting_response', 'error', 'pending', 'succeeded', 'failed'] as const;
export type OrderRefundStatus = (typeof ORDER_REFUND_STATUSES)[number];
export const STRIPE_REFUND_REASONS = ['requested_by_customer', 'duplicate', 'fraudulent'] as const;
export type StripeRefundReason = (typeof STRIPE_REFUND_REASONS)[number];
export type RefundPaymentMethod = 'card' | 'link' | 'paypay' | 'konbini' | 'unknown';
export type RefundLineRequest = { orderItemId: string; quantity: number; beforeShipment: boolean };
/**
 * 返金の画面の商品の行。shippedRefundable は、ふつうの返金の画面で選べる発送済みの数（発送した数 − 発送後に返金した数 −
 * 申し込み中・受付中・返金待ち・交換にした返品の数。グループ E-3 の4-8）。DB の load_order_refund_materials が数えるので、
 * ここで shipped − refundedAfterShipment と数え直さない。
 * exchangePaidAmount は、交換の品の行（返品の交換で足した行。値段は0）だけが持つ、元の品のその数の分の支払額（ほかの行は null）。
 * 返す額はこれを数で累積に割り振る（refund-allocation.ts。本計画 P22）。省ける形なのは、今の見本を書き換えずに済ませるため。窓口は必ず返す
 */
export type RefundMaterialLine = {
  orderItemId: string; name: string; color: string | null; size: string | null; fulfillmentType: 'stock' | 'backorder';
  itemPrice: number; quantity: number; lineTotal: number; shipped: number; unshipped: number;
  refundedBeforeShipment: number; refundedAfterShipment: number; shippedRefundable: number; restockable: number;
  lineDiscount: number; refundedUnits: number; exchangePaidAmount?: number | null;
};
export type RefundMaterials = {
  order: {
    id: string; orderNumber: string; status: OrderStatus; paymentMethod: RefundPaymentMethod;
    totalAmount: number; shippingAmount: number; discountAmount: number; paidAmount: number;
    succeededAmount: number; openAmount: number; refundableAmount: number; refundedShipping: number;
    refundableShipping: number; shippedTotal: number; unshippedTotal: number;
  };
  lines: RefundMaterialLine[];
  awaitingRefund: { id: string; amount: number; createdAt: string } | null;
};
export type CreateRefundRequest = {
  requestKey: string; lines: RefundLineRequest[]; restock: boolean; shippingAmount: number; amount: number;
  note: string | null; stripeReason: StripeRefundReason; notifyCustomer: boolean;
};
export type PaidCancelRequest = {
  requestKey: string; reason: CancelReason; note: string | null; restock: boolean; notifyCustomer: boolean;
};
export type RefundAcceptedResponse = { refundId: string; status: 'pending' | 'succeeded'; amount: number; replayed: boolean };
export const REFUND_ERROR_CODES = [
  'order_not_found', 'order_not_refundable', 'order_not_cancellable', 'awaiting_refund_exists', 'refund_request_mismatch',
  'refund_line_not_in_order', 'quantity_exceeds_unshipped', 'quantity_exceeds_shipped', 'shipping_exceeds',
  'exceeds_refundable', 'must_include_unshipped', 'must_be_full', 'invalid_argument',
] as const;
export type RefundErrorCode = (typeof REFUND_ERROR_CODES)[number];
export type RefundErrorResponse = {
  error: string;
  code: RefundErrorCode | 'invalid_request' | 'failed' | 'stripe_rejected' | 'unknown_outcome';
  refundId?: string;
};
export type ShopSettingToggle = { enabled: boolean; updatedAt: string | null; updatedByEmail: string | null };
export type ShopSettings = { autoRefundCancelledOrderPayment: ShopSettingToggle; autoCancelAmountMismatch: ShopSettingToggle };
export type UpdateShopSettingsRequest = { autoRefundCancelledOrderPayment: boolean; autoCancelAmountMismatch: boolean };
