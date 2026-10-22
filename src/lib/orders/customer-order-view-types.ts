import type { OrderStatus } from '@/lib/orders/order-payment-types';
import type { OrderProgress, OrderProgressStep } from '@/lib/orders/order-progress';
import type { OrderFulfillmentHistoryRow, OrderLineFulfillmentRow } from '@/lib/orders/fulfillment/fulfillment-store';
import type { OrderRefundRow } from '@/lib/orders/refund/refund-store';
import type { CustomerOrderReturn, CustomerOrderReturns } from '@/lib/orders/returns/customer-return-types';
import type { CustomerDelivery, DeliveryStatus, TrackingState, OrderDeliveryDetail, OrderDeliverySummary } from '@/lib/orders/tracking/delivery-types';

export type CustomerOrderItemRow = {
  id: string; item_id: number | null; variant_id: number | null; item_name: string;
  item_image_url: string | null; color: string | null; size: string | null;
  quantity: number; line_total: number; line_kind: 'order' | 'exchange';
};
export type CustomerOrderPublicRow = {
  id: string; created_at: string; status: Exclude<OrderStatus, 'payment_in_progress' | 'abandoned'>;
  subtotal_amount: number; shipping_amount: number; discount_amount: number;
  total_amount: number; currency: string; order_items: CustomerOrderItemRow[] | null;
};
export type CustomerOrderItem = {
  id: string; itemId: number | null; variantId: number | null; name: string;
  imageUrl: string | null; color: string | null; size: string | null;
  quantity: number; amount: string; lineKind: 'order' | 'exchange';
  shippedQuantity: number; refundedQuantity: number; readyQuantity: number; inProductionQuantity: number;
};
export type CustomerOrderShipment = {
  id: string; number: number; shippedAt: string; carrier: string | null; carrierLabel: string | null;
  trackingNumber: string | null; trackingUrl: string | null; deliveredAt: string | null;
  delivery?: CustomerDelivery;
  items: Array<{ orderItemId: string; name: string; color: string | null; size: string | null; quantity: number; lineKind: 'order' | 'exchange' }>;
};
export type CustomerOrderRefund = {
  id: string; date: string; amount: string; status: 'processing' | 'completed'; customerActionDeadline: string | null;
};
export type PublicCustomerOrderReturn = Omit<CustomerOrderReturn, 'returnAddress' | 'sentBack'> & {
  sentBack: Array<Omit<CustomerOrderReturn['sentBack'][number], 'carrier' | 'trackingNumber'>>;
};
export type PublicCustomerOrderReturns = Omit<CustomerOrderReturns, 'returns'> & { returns: PublicCustomerOrderReturn[] };
export type CustomerOrderPublicView = {
  id: string; orderNumber: string; orderDate: string; status: CustomerOrderPublicRow['status'];
  progress: OrderProgress & { steps: OrderProgressStep[] | null };
  subtotalAmount: string; shippingAmount: string; discountAmount: string; totalAmount: string;
  shipments: Array<Omit<CustomerOrderShipment, 'trackingNumber' | 'trackingUrl'>>;
  refunds: Array<Omit<CustomerOrderRefund, 'customerActionDeadline'>>; refundTotal: string | null;
  returnSection: PublicCustomerOrderReturns | null; items: CustomerOrderItem[];
};
export type OrderStatusPrivateReturn = {
  id: string; returnAddress: CustomerOrderReturn['returnAddress'];
  sentBack: Array<{ index: number; trackingNumber: string | null }>;
};
export type CustomerOrderPrivateView = {
  shipping: { fullName: string; postalCode: string; address: string; phone: string };
  contactEmail: string; paymentMethod: string;
  shipments: Array<Pick<CustomerOrderShipment, 'id' | 'number' | 'trackingNumber' | 'trackingUrl'>>;
  returns: OrderStatusPrivateReturn[];
};
export type CustomerOrderDetailView = Omit<CustomerOrderPublicView, 'shipments' | 'refunds' | 'returnSection'> & {
  paymentMethod: string; shippingFullName: string; shippingEmail: string; shippingPhone: string; shippingAddress: string;
  shipments: CustomerOrderShipment[]; refunds: CustomerOrderRefund[]; returnSection: CustomerOrderReturns | null;
};

export type PublicFulfillmentMaterial = Pick<OrderFulfillmentHistoryRow,
  'fulfillmentId' | 'number' | 'shippingCarrier' | 'shippedAt' | 'cancelledAt' | 'lines'>;
export type PublicDeliveryMaterial = { enabled: boolean; fulfillments: Array<{
  fulfillmentId: string; cancelledAt: string | null; trackingVersion: number; deliveryStatus: DeliveryStatus;
  deliveryStatusAt: string; deliveredAt: string | null;
  registration: { state: TrackingState; everRegistered: boolean } | null;
  events: Array<{ trackingVersion: number; status: DeliveryStatus; happenedAt: string; recordedAt: string }>;
}> };
export type PublicRefundMaterial = Pick<OrderRefundRow, 'refundId' | 'createdAt' | 'amount' | 'status'>;
export type CustomerOrderPublicMaterial = {
  order: CustomerOrderPublicRow; lineRows: OrderLineFulfillmentRow[]; fulfillments: PublicFulfillmentMaterial[];
  deliveryDetail: PublicDeliveryMaterial; deliverySummary: { activeCount: number; deliveredCount: number }; refundRows: PublicRefundMaterial[];
};
export type CustomerOrderPublicInput = CustomerOrderPublicMaterial & {
  returnSection: PublicCustomerOrderReturns | null; trackingKeyConfigured: boolean;
  signImage: (path: string | null) => Promise<string | null>;
};
export type CustomerOrderPrivateInput = {
  order: { shipping_full_name: string | null; shipping_postal_code: string | null; shipping_prefecture: string | null;
    shipping_city: string | null; shipping_address: string | null; shipping_building: string | null;
    shipping_phone: string | null; shipping_email: string | null };
  paymentMethod: string | null;
  fulfillments: Array<Pick<OrderFulfillmentHistoryRow, 'fulfillmentId' | 'number' | 'shippingCarrier' | 'trackingNumber' | 'cancelledAt'>>;
  returnSection: CustomerOrderReturns | null;
};
export type CustomerOrderDetailInput = {
  order: CustomerOrderPublicRow & CustomerOrderPrivateInput['order']; lineRows: OrderLineFulfillmentRow[];
  fulfillments: OrderFulfillmentHistoryRow[]; deliverySummary: OrderDeliverySummary | undefined;
  deliveryDetail: OrderDeliveryDetail; refundRows: OrderRefundRow[]; returnSection: CustomerOrderReturns | null;
  paymentMethod: string | null; trackingKeyConfigured: boolean; signImage: CustomerOrderPublicInput['signImage'];
};
