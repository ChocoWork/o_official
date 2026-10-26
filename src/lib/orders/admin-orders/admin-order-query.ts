import { z } from 'zod';
import { toOrderNumber } from '@/lib/orders/order-number';
import { ORDER_ITEM_PAGE_SIZE, ORDER_ITEM_LIST_ORDER_CAP, ORDER_ITEM_STATUS_ORDER, type AdminOrderItemFilters, type AdminOrderItemPage } from './admin-order-types';

const text = z.string().trim().min(1).max(200);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const filtersSchema = z.object({
  dateFrom: date.optional(), dateTo: date.optional(),
  orderNumber: text.refine((value) => /^pi_[a-z0-9_]{1,197}$/i.test(value) || /^(?:ORD-)?[a-f0-9][a-f0-9-]*$/i.test(value)).optional(),
  customer: text.optional(), email: text.optional(), product: text.optional(), color: text.optional(), size: text.optional(),
  statuses: z.array(z.enum(ORDER_ITEM_STATUS_ORDER)).max(12).optional(), attention: z.boolean().optional(),
}).strict().refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo);

/** 受け付ける名前を限定し、複数指定はstatusだけにする。検索語はログ・エラーに残さない。 */
export function parseOrderItemQuery(searchParams: URLSearchParams): { ok: true; filters: AdminOrderItemFilters; page: number } | { ok: false } {
  const allowed = ['dateFrom', 'dateTo', 'orderNumber', 'customer', 'email', 'product', 'color', 'size', 'status', 'attention', 'page'];
  const input: Record<string, unknown> = {};
  for (const key of new Set(searchParams.keys())) {
    if (!allowed.includes(key) || (key !== 'status' && searchParams.getAll(key).length !== 1)) return { ok: false };
    if (key === 'page') continue;
    if (key === 'status') input.statuses = searchParams.getAll(key);
    else if (key === 'attention') {
      if (searchParams.get(key) !== '1') return { ok: false };
      input.attention = true;
    } else input[key] = searchParams.get(key);
  }
  const pageText = searchParams.get('page') ?? '1';
  if (!/^\d+$/.test(pageText)) return { ok: false };
  const page = Number(pageText);
  const parsed = filtersSchema.safeParse(input);
  if (!parsed.success || !Number.isSafeInteger(page) || page < 1 || page > 100000) return { ok: false };
  return { ok: true, filters: parsed.data, page };
}

export function toFilterPayload(filters: AdminOrderItemFilters): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
}

/** 画面の絞り込みを窓口の問合せにする（parseOrderItemQuery の逆）。空の値・偽の旗は載せず、statusは繰り返す。pageは渡した時だけ載せる。 */
export function toSearchParams(filters: AdminOrderItemFilters, page?: number): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ['dateFrom', 'dateTo', 'orderNumber', 'customer', 'email', 'product', 'color', 'size'] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  for (const status of filters.statuses ?? []) params.append('status', status);
  if (filters.attention) params.set('attention', '1');
  if (page !== undefined) params.set('page', String(page));
  return params;
}

export const adminOrderIntegerSchema = z.number().int().safe();
export const adminOrderTimestampSchema = z.string().datetime({ offset: true });
export const adminOrderExportRowSchema = z.object({
  orderId: z.string().uuid(), orderCreatedAt: adminOrderTimestampSchema, customerName: z.string().nullable(), customerEmail: z.string().nullable(),
  orderItemId: z.string().uuid(), itemName: z.string(), color: z.string().nullable(), size: z.string().nullable(), isExchange: z.boolean(),
  status: z.enum(ORDER_ITEM_STATUS_ORDER), quantity: adminOrderIntegerSchema.positive().max(2147483647), unitPrice: adminOrderIntegerSchema.nonnegative(), lineAmount: adminOrderIntegerSchema.nonnegative(), refundAmount: adminOrderIntegerSchema.nonnegative(),
});
export const adminOrderBlockedReasonsSchema = z.array(z.enum(['variant_missing', 'payment_review', 'exchange_fee_waiting', 'cancel_requested', 'refund_processing', 'stock_shortage']));
const listSchema = z.object({
  ordersCapped: z.boolean(), ordersCap: adminOrderIntegerSchema.positive().max(ORDER_ITEM_LIST_ORDER_CAP), totalRows: adminOrderIntegerSchema.nonnegative(), totalOrders: adminOrderIntegerSchema.nonnegative(),
  rows: z.array(adminOrderExportRowSchema.extend({ blockedReasons: adminOrderBlockedReasonsSchema, needsAttention: z.boolean() })).max(ORDER_ITEM_PAGE_SIZE),
}).refine((value) => value.totalRows >= value.rows.length && value.totalOrders <= value.totalRows && value.totalOrders <= value.ordersCap);

/** 単一スナップショットの件数・capを保持し、UIと試験の橋渡しが同じ検査を使う。 */
export function parseOrderItemListResult(raw: unknown, page: number): AdminOrderItemPage {
  const data = listSchema.parse(raw);
  return { ...data, rows: data.rows.map((row) => ({ ...row, orderNumber: toOrderNumber(row.orderId) })), page, pageSize: ORDER_ITEM_PAGE_SIZE, totalPages: Math.max(1, Math.ceil(data.totalRows / ORDER_ITEM_PAGE_SIZE)) };
}
