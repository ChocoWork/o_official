import type { LegalArchivePage } from './types';

const ORDER_HEADERS = [
  'order_id', 'order_date', 'payment_intent_id', 'status', 'customer_name',
  'customer_email', 'subtotal_amount', 'shipping_amount', 'discount_amount',
  'gross_amount', 'refunded_amount', 'net_amount', 'currency', 'updated_at',
] as const;
const ITEM_HEADERS = [
  'item_id', 'order_id', 'created_at', 'catalog_item_id', 'item_name',
  'item_price', 'color', 'size', 'quantity', 'line_total', 'item_image_url',
] as const;
const REVISION_HEADERS = [
  'revision_id', 'order_id', 'changed_at', 'operation', 'changed_fields',
  'before_data', 'after_data', 'changed_by', 'reason', 'source_event_id',
] as const;

export function escapeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cell(value: unknown): string {
  const raw = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  const safe = escapeCsvCell(raw);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csv(headers: readonly string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function buildArchiveCsv(pages: LegalArchivePage[]) {
  const orders = pages.flatMap((page) => page.orders);
  const items = pages.flatMap((page) => page.orderItems);
  const revisions = pages.flatMap((page) => page.revisions);
  const totals = orders.reduce(
    (sum, order) => {
      const gross = Number(order.total_amount ?? 0);
      const refunded = Number(order.refunded_amount ?? 0);
      sum.grossAmount += gross;
      sum.refundedAmount += refunded;
      sum.netAmount += gross - refunded;
      return sum;
    },
    { grossAmount: 0, refundedAmount: 0, netAmount: 0 },
  );

  return {
    ordersCsv: csv(ORDER_HEADERS, orders.map((order) => [
      order.id, order.created_at, order.payment_intent_id, order.status,
      order.shipping_full_name, order.shipping_email, order.subtotal_amount,
      order.shipping_amount, order.discount_amount, order.total_amount,
      order.refunded_amount, Number(order.total_amount ?? 0) - Number(order.refunded_amount ?? 0),
      order.currency, order.updated_at,
    ])),
    itemsCsv: csv(ITEM_HEADERS, items.map((item) => [
      item.id, item.order_id, item.created_at, item.item_id, item.item_name,
      item.item_price, item.color, item.size, item.quantity, item.line_total,
      item.item_image_url,
    ])),
    revisionsCsv: csv(REVISION_HEADERS, revisions.map((revision) => [
      revision.id, revision.order_id, revision.changed_at, revision.operation,
      revision.changed_fields, revision.before_data, revision.after_data,
      revision.changed_by, revision.reason, revision.source_event_id,
    ])),
    totals,
    rowCounts: { orders: orders.length, orderItems: items.length, revisions: revisions.length },
  };
}
