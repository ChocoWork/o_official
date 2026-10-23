import { toOrderNumber } from '@/lib/orders/order-number';
import { buildOrderProgressSteps, deriveOrderProgress } from '@/lib/orders/order-progress';
import { SHIPPING_CARRIERS, isShippingCarrierId } from '@/lib/orders/shipping-carriers';
import { konbiniDeadlineLastDay } from '@/lib/orders/refund/refund-messages';
import { mapPaymentMethodLabel } from '@/features/checkout/services/payment-method.service';
import type {
  CustomerOrderPublicInput, CustomerOrderPublicView, CustomerOrderPrivateInput, CustomerOrderPrivateView,
  CustomerOrderDetailInput, CustomerOrderDetailView, PublicDeliveryMaterial, PublicRefundMaterial, PublicCustomerOrderReturns,
} from '@/lib/orders/customer-order-view-types';

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `¥${amount.toLocaleString('ja-JP')}`;
  }
}

function formatOrderDateTime(dateText: string) {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo',
  }).format(date);
}

function formatRefundDate(dateText: string) {
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Tokyo' }).format(date);
}

function toCustomerDelivery(detail: PublicDeliveryMaterial['fulfillments'][number]) {
  return {
    status: detail.deliveryStatus,
    statusAt: detail.deliveryStatusAt,
    events: detail.events
      .filter((event) => event.trackingVersion === detail.trackingVersion)
      .sort((a, b) => Date.parse(b.happenedAt) - Date.parse(a.happenedAt) || Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
      .map((event) => ({ status: event.status, happenedAt: event.happenedAt })),
  };
}

function toShipments(input: CustomerOrderPublicInput): CustomerOrderPublicView['shipments'] {
  const itemById = new Map((input.order.order_items ?? []).map((item) => [item.id, item]));
  const deliveryByFulfillment = new Map(input.deliveryDetail.fulfillments
    .filter((detail) => detail.cancelledAt === null).map((detail) => [detail.fulfillmentId, detail]));
  const canShowDelivery = input.deliveryDetail.enabled && input.trackingKeyConfigured;
  return input.fulfillments.filter((row) => row.cancelledAt === null).sort((a, b) => a.number - b.number).map((row) => {
    const carrier = isShippingCarrierId(row.shippingCarrier) ? SHIPPING_CARRIERS[row.shippingCarrier] : null;
    const delivery = deliveryByFulfillment.get(row.fulfillmentId);
    const registration = delivery?.registration;
    const trackedByProvider = registration?.state === 'registered' || (registration?.state === 'stopped' && registration.everRegistered);
    return {
      id: row.fulfillmentId, number: row.number, shippedAt: row.shippedAt, carrier: row.shippingCarrier, carrierLabel: carrier?.label ?? null,
      deliveredAt: delivery?.deliveredAt ?? null,
      ...(canShowDelivery && delivery && trackedByProvider ? { delivery: toCustomerDelivery(delivery) } : {}),
      items: row.lines.flatMap((line) => {
        const item = itemById.get(line.orderItemId);
        return item ? [{ orderItemId: item.id, name: item.item_name, color: item.color, size: item.size, quantity: line.quantity, lineKind: item.line_kind }] : [];
      }),
    };
  });
}

const CUSTOMER_REFUND_STATUSES: Partial<Record<PublicRefundMaterial['status'], 'processing' | 'completed'>> = {
  awaiting_response: 'processing', pending: 'processing', succeeded: 'completed',
};

function toCustomerRefunds(rows: readonly PublicRefundMaterial[], currency: string) {
  const shown = rows.flatMap((row) => {
    const status = CUSTOMER_REFUND_STATUSES[row.status];
    return status ? [{ row, status }] : [];
  }).sort((a, b) => Date.parse(a.row.createdAt) - Date.parse(b.row.createdAt));
  return {
    refunds: shown.map(({ row, status }) => ({ id: row.refundId, date: formatRefundDate(row.createdAt), amount: formatCurrency(row.amount, currency), status })),
    refundTotal: shown.length >= 2 ? formatCurrency(shown.reduce((total, { row }) => total + row.amount, 0), currency) : null,
  };
}

// 公開の返品は入れ子も名指しする。型より多いキーが材料にあっても公開しない。
function toPublicReturns(section: PublicCustomerOrderReturns | null): PublicCustomerOrderReturns | null {
  if (!section) return null;
  const exchange = (value: { color: string | null; size: string | null } | null) => value ? { color: value.color, size: value.size } : null;
  return {
    returns: section.returns.map((row) => ({
      id: row.id, number: row.number, label: row.label, status: row.status, customerStatus: row.customerStatus,
      returnMethod: row.returnMethod, returnShippingPayer: row.returnShippingPayer, returnShippingFee: row.returnShippingFee,
      requestedAt: row.requestedAt, closedAt: row.closedAt,
      lines: row.lines.map((line) => ({ itemName: line.itemName, color: line.color, size: line.size, quantity: line.quantity,
        requestedResolution: line.requestedResolution, requestedExchange: exchange(line.requestedExchange), resolution: line.resolution, exchange: exchange(line.exchange) })),
      refundAmount: row.refundAmount,
      sentBack: row.sentBack.map((line) => ({ itemName: line.itemName, color: line.color, size: line.size, quantity: line.quantity, message: line.message })),
      declineMessage: row.declineMessage, exchangeShipping: row.exchangeShipping,
    })),
    cancelRequests: section.cancelRequests.map((row) => ({ id: row.id, status: row.status, requestedAt: row.requestedAt,
      lines: row.lines.map((line) => ({ itemName: line.itemName, color: line.color, size: line.size, quantity: line.quantity })), declineMessage: row.declineMessage })),
    availability: { returns: section.availability.returns, endedOn: section.availability.endedOn, cancel: section.availability.cancel },
  };
}

export async function buildCustomerOrderPublicView(input: CustomerOrderPublicInput): Promise<CustomerOrderPublicView> {
  const { order, lineRows } = input;
  const hasOpenRefund = input.refundRows.some((row) => row.status === 'awaiting_response' || row.status === 'pending');
  const progress = deriveOrderProgress(order.status, lineRows, { hasOpenRefund, delivery: input.deliverySummary });
  const lineByItemId = new Map(lineRows.map((row) => [row.orderItemId, row]));
  const showStages = order.status === 'paid' || order.status === 'shipped';
  const { refunds, refundTotal } = toCustomerRefunds(input.refundRows, order.currency);
  return {
    id: order.id, orderNumber: toOrderNumber(order.id), orderDate: formatOrderDateTime(order.created_at), status: order.status,
    progress: { ...progress, steps: buildOrderProgressSteps(progress, lineRows) },
    subtotalAmount: formatCurrency(order.subtotal_amount, order.currency), shippingAmount: order.shipping_amount > 0 ? formatCurrency(order.shipping_amount, order.currency) : '無料',
    discountAmount: order.discount_amount > 0 ? `-${formatCurrency(order.discount_amount, order.currency)}` : formatCurrency(0, order.currency),
    totalAmount: formatCurrency(order.total_amount, order.currency),
    shipments: toShipments(input), refunds, refundTotal, returnSection: toPublicReturns(input.returnSection),
    items: await Promise.all((order.order_items ?? []).map(async (item) => {
      const line = lineByItemId.get(item.id);
      return {
        id: item.id, itemId: item.item_id, variantId: item.variant_id ?? null, name: item.item_name,
        imageUrl: await input.signImage(item.item_image_url), color: item.color, size: item.size, quantity: item.quantity,
        amount: formatCurrency(item.line_total, order.currency), lineKind: item.line_kind,
        shippedQuantity: line?.shipped ?? 0, refundedQuantity: (line?.refundedBeforeShipment ?? 0) + (line?.refundedAfterShipment ?? 0),
        readyQuantity: showStages ? (line?.readyUnshipped ?? 0) : 0, inProductionQuantity: showStages ? (line?.inProduction ?? 0) : 0,
      };
    })),
  };
}

export function buildCustomerOrderPrivateView(input: CustomerOrderPrivateInput): CustomerOrderPrivateView {
  const order = input.order;
  return {
    shipping: { fullName: order.shipping_full_name ?? '', postalCode: order.shipping_postal_code ?? '',
      address: [order.shipping_prefecture ?? '', order.shipping_city ?? '', order.shipping_address ?? '', order.shipping_building ?? ''].filter(Boolean).join(' ').trim(),
      phone: order.shipping_phone ?? '' },
    contactEmail: order.shipping_email ?? '', paymentMethod: mapPaymentMethodLabel(input.paymentMethod),
    shipments: input.fulfillments.filter((row) => row.cancelledAt === null).sort((a, b) => a.number - b.number).map((row) => {
      const carrier = isShippingCarrierId(row.shippingCarrier) ? SHIPPING_CARRIERS[row.shippingCarrier] : null;
      return { id: row.fulfillmentId, number: row.number, trackingNumber: row.trackingNumber,
        trackingUrl: carrier && row.trackingNumber ? carrier.trackingUrl(row.trackingNumber) : null };
    }),
    returns: (input.returnSection?.returns ?? []).map((row) => ({ id: row.id,
      returnAddress: row.returnAddress ? { name: row.returnAddress.name, postalCode: row.returnAddress.postalCode, address: row.returnAddress.address, phone: row.returnAddress.phone } : null,
      sentBack: row.sentBack.map((line, index) => ({ index, trackingNumber: line.trackingNumber })) })),
  };
}

// 会員のキー順・null・省略キーは元のAPIに合わせる。公開版の計算に会員だけの情報を戻す。
export async function buildCustomerOrderDetailView(input: CustomerOrderDetailInput): Promise<CustomerOrderDetailView> {
  const publicView = await buildCustomerOrderPublicView({ ...input, deliverySummary: input.deliverySummary ?? { activeCount: 0, deliveredCount: 0 } });
  const privateView = buildCustomerOrderPrivateView(input);
  const privateShipments = new Map(privateView.shipments.map((row) => [row.id, row]));
  const refundsById = new Map(input.refundRows.map((row) => [row.refundId, row]));
  return {
    id: publicView.id, orderNumber: publicView.orderNumber, orderDate: publicView.orderDate, status: publicView.status,
    progress: publicView.progress, subtotalAmount: publicView.subtotalAmount, shippingAmount: publicView.shippingAmount,
    discountAmount: publicView.discountAmount, totalAmount: publicView.totalAmount,
    paymentMethod: privateView.paymentMethod, shippingFullName: privateView.shipping.fullName,
    shippingEmail: privateView.contactEmail, shippingPhone: privateView.shipping.phone,
    shippingAddress: [input.order.shipping_postal_code ? `〒${input.order.shipping_postal_code}` : '',
      input.order.shipping_prefecture ?? '', input.order.shipping_city ?? '', input.order.shipping_address ?? '', input.order.shipping_building ?? ''].filter(Boolean).join(' ').trim(),
    shipments: publicView.shipments.map((row) => {
      const privateShipment = privateShipments.get(row.id)!;
      return { id: row.id, number: row.number, shippedAt: row.shippedAt, carrier: row.carrier, carrierLabel: row.carrierLabel,
        trackingNumber: privateShipment.trackingNumber, trackingUrl: privateShipment.trackingUrl, deliveredAt: row.deliveredAt,
        ...(row.delivery ? { delivery: row.delivery } : {}), items: row.items };
    }),
    refunds: publicView.refunds.map((row) => {
      const material = refundsById.get(row.id)!;
      const deadline = material.status === 'pending' && material.paymentMethodType === 'konbini' && material.customerActionExpiresAt
        ? konbiniDeadlineLastDay(material.customerActionExpiresAt) : null;
      return { ...row, customerActionDeadline: deadline ? `${deadline.month}月${deadline.day}日` : null };
    }),
    refundTotal: publicView.refundTotal, returnSection: input.returnSection, items: publicView.items,
  };
}
