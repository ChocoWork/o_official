import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderProgress } from '@/lib/orders/order-progress';
import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';

/**
 * 発送と仕上がりの窓口の形と誤りの記号（グループ E-1 設計書 3〜7 章）。窓口・DB の呼び出し・画面が同じ型を使うので、
 * 画面からも読む。サーバーだけの物を import しない。
 */
export type FulfillmentLineQuantity = { orderItemId: string; quantity: number };

export type FulfillmentMaterialLine = {
  orderItemId: string;
  name: string;
  color: string | null;
  size: string | null;
  fulfillmentType: 'stock' | 'backorder';
  quantity: number;
  shipped: number;
  inProduction: number;
  readyUnshipped: number;
  unshipped: number;
};

export type FulfillmentRecordSummary = {
  id: string;
  number: number;
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: string;
  notifyCustomer: boolean;
  completesOrder: boolean;
  cancelledAt: string | null;
  lines: FulfillmentLineQuantity[];
};

export type FulfillmentBlockedReason = 'not_shippable' | 'address_incomplete' | 'payment_review_required';

export type FulfillmentMaterials = {
  order: { id: string; orderNumber: string; status: OrderStatus; progress: OrderProgress };
  blockedReason: FulfillmentBlockedReason | null;
  lines: FulfillmentMaterialLine[];
  fulfillments: FulfillmentRecordSummary[];
};

export type CreateFulfillmentRequest = {
  requestKey: string;
  carrier: ShippingCarrierId;
  trackingNumber: string;
  notifyCustomer: boolean;
  lines: FulfillmentLineQuantity[];
};

export type CreateFulfillmentResponse = {
  fulfillmentId: string;
  number: number;
  completesOrder: boolean;
  orderStatus: OrderStatus;
  replayed: boolean;
};

export type CancelFulfillmentResponse = { outcome: 'cancelled' | 'already_cancelled'; orderStatus: OrderStatus };

export type RecordCompletionRequest = { requestKey: string; lines: FulfillmentLineQuantity[] };

export type RecordCompletionResponse = { completionIds: string[]; replayed: boolean };

export type CancelCompletionResponse = { outcome: 'cancelled' | 'already_cancelled' };

export const FULFILLMENT_ERROR_CODES = [
  'order_not_found',
  'not_shippable',
  'address_incomplete',
  'payment_review_required',
  'quantity_exceeds_ready',
  'fulfillment_request_mismatch',
  'invalid_argument',
  'fulfillment_not_found',
  'fulfillment_cancel_not_allowed',
  'not_in_production',
  'quantity_exceeds_in_production',
  'completion_request_mismatch',
  'completion_not_found',
  'completion_already_shipped',
] as const;
export type FulfillmentErrorCode = (typeof FULFILLMENT_ERROR_CODES)[number];

export type FulfillmentErrorResponse = { error: string; code: FulfillmentErrorCode | 'invalid_request' | 'failed' };

/** 発送の画面の最初の数: 未発送が1以上の商品ごとに、発送準備中の数の全部（受注生産中は入らない） */
export function initialShipQuantities(lines: readonly FulfillmentMaterialLine[]): Record<string, number> {
  const quantities: Record<string, number> = {};
  for (const line of lines) {
    if (line.unshipped >= 1) {
      quantities[line.orderItemId] = line.readyUnshipped;
    }
  }
  return quantities;
}

/** 入れた数の合計 */
export function totalQuantity(quantities: Record<string, number>): number {
  return Object.values(quantities).reduce((total, quantity) => total + quantity, 0);
}
