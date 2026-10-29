import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ORDER_STATUSES } from '@/lib/orders/order-payment-types';
import { ADMIN_ORDER_ERRORS, ADMIN_ORDER_TEXT, ORDER_ITEM_EXPORT_MAX_ROWS, ORDER_ITEM_PAGE_SIZE, ORDER_ITEM_STATUS_ORDER, type AdminOrderDetailCore, type AdminOrderExportRow, type AdminOrderItemFilters, type AdminOrderItemPage, type OrderHistoryItemStateEntry } from './admin-order-types';
import { adminOrderBlockedReasonsSchema, adminOrderExportRowSchema, adminOrderIntegerSchema as integer, adminOrderTimestampSchema as timestamp, parseOrderItemListResult, toFilterPayload } from './admin-order-query';
import { itemStateHistoryDbRowSchema, mapItemStateHistoryRows } from './admin-order-history';
import { AdminDiscountStoreError } from '@/lib/discounts/admin-discount-store';
import { GROUP_H_ERRORS, type GroupHErrorCode } from '@/lib/discounts/admin-discount-types';

const discountAttentionRow = z.object({ orderId: z.string().uuid(), kind: z.enum(['discount_limit_exceeded', 'discount_reconciliation_recovered']), openedAt: z.string().datetime({ offset: true }) }).strict();
async function discountAttentionRpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  let response;
  try { response = await client.rpc(name, args); } catch { throw new AdminDiscountStoreError(); }
  if (response.error) {
    const { message, code } = response.error;
    throw new AdminDiscountStoreError(Object.hasOwn(GROUP_H_ERRORS, message) && GROUP_H_ERRORS[message as GroupHErrorCode][0] === code ? message : null, code);
  }
  return response.data as unknown;
}
export async function listAdminDiscountAttention(client: SupabaseClient, actorId: string, limit = 100) {
  const raw = await discountAttentionRpc(client, 'list_admin_discount_attention', { _limit: limit, _actor_id: actorId });
  const result = z.object({ rows: z.array(discountAttentionRow).max(100), truncated: z.boolean() }).strict().safeParse(raw);
  if (!result.success) throw new AdminDiscountStoreError();
  return result.data;
}
export async function resolveAdminDiscountAttention(client: SupabaseClient, actorId: string, orderId: string) {
  const raw = await discountAttentionRpc(client, 'admin_resolve_discount_attention', { _order_id: orderId, _actor_id: actorId });
  const result = z.object({ resolved: z.boolean() }).strict().safeParse(raw);
  if (!result.success) throw new AdminDiscountStoreError();
  return result.data;
}

/** messageとSQLSTATEが一致した業務エラーだけを保持する。DBの文・causeは持たない。 */
export class AdminOrderError extends Error {
  readonly code?: string;
  readonly status: number;
  constructor(status = 500, code?: string) {
    const known = code !== undefined && Object.hasOwn(ADMIN_ORDER_ERRORS, code) && ADMIN_ORDER_ERRORS[code][1] === status ? ADMIN_ORDER_ERRORS[code] : null;
    super(known ? known[2] : ADMIN_ORDER_TEXT.failed);
    this.name = 'AdminOrderError'; this.status = known ? known[1] : 500;
    if (known) this.code = code;
  }
}

function classify(error: unknown): AdminOrderError {
  if (error === null || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string' || !Object.hasOwn(ADMIN_ORDER_ERRORS, error.message)) return new AdminOrderError();
  const [sqlstate, status] = ADMIN_ORDER_ERRORS[error.message];
  return 'code' in error && error.code === sqlstate ? new AdminOrderError(status, error.message) : new AdminOrderError();
}
async function callRpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  let result;
  try { result = await client.rpc(name, args); } catch { throw new AdminOrderError(); }
  if (result.error) throw classify(result.error);
  return result.data as unknown;
}
function guarded<T>(read: () => T): T {
  try { return read(); } catch { throw new AdminOrderError(); }
}

export async function listAdminOrderItemRows(client: SupabaseClient, actorId: string, filters: AdminOrderItemFilters, page: number): Promise<AdminOrderItemPage> {
  const data = await callRpc(client, 'list_admin_order_item_rows', { _filters: toFilterPayload(filters), _limit: ORDER_ITEM_PAGE_SIZE, _offset: (page - 1) * ORDER_ITEM_PAGE_SIZE, _actor_id: actorId });
  return guarded(() => parseOrderItemListResult(data, page));
}
const exportSchema = z.object({ rowCount: integer.nonnegative().max(ORDER_ITEM_EXPORT_MAX_ROWS), orderCount: integer.nonnegative(), rows: z.array(adminOrderExportRowSchema).max(ORDER_ITEM_EXPORT_MAX_ROWS) }).refine((value) => value.rowCount === value.rows.length && value.orderCount === new Set(value.rows.map((row) => row.orderId)).size);
export async function exportAdminOrderItemRows(client: SupabaseClient, actorId: string, filters: AdminOrderItemFilters): Promise<{ rowCount: number; orderCount: number; rows: AdminOrderExportRow[] }> {
  const data = await callRpc(client, 'export_admin_order_item_rows', { _filters: toFilterPayload(filters), _actor_id: actorId });
  return guarded(() => exportSchema.parse(data));
}

const nullableText = z.string().nullable();
const money = integer.nonnegative();
const detailSchema = z.object({
  order: z.object({
    id: z.string().uuid(), status: z.enum(ORDER_STATUSES), createdAt: timestamp, paidAt: timestamp.nullable(), customerKind: z.enum(['guest', 'member']), customerName: nullableText, customerEmail: nullableText, currency: z.string().min(1),
    shipTo: z.object({ fullName: nullableText, postalCode: nullableText, prefecture: nullableText, city: nullableText, address: nullableText, building: nullableText, phone: nullableText }),
  }),
  amounts: z.object({ productNet: money, discount: money, shipping: money, total: money, paidAmount: money.nullable(), refundedAmount: money, refundAttachedToRows: money, refundNotAttached: integer, refundProcessingAmount: money }),
  rows: z.array(adminOrderExportRowSchema.omit({ orderId: true, orderCreatedAt: true, customerName: true, customerEmail: true }).extend({ statusRank: integer.min(1).max(12), blockedReasons: adminOrderBlockedReasonsSchema }).refine((row) => ORDER_ITEM_STATUS_ORDER[row.statusRank - 1] === row.status)),
  attention: z.object({
    paymentExceptions: z.array(z.object({ id: z.string().uuid(), reason: z.string(), detectionCount: integer.positive(), firstDetectedAt: timestamp })),
    review: z.object({ reason: z.string(), markedAt: timestamp.nullable() }).nullable(),
    deliveries: z.array(z.object({ fulfillmentId: z.string().uuid(), kind: z.string(), openedAt: timestamp })),
    discounts: z.array(discountAttentionRow).max(1).optional(),
  }),
  permissions: z.object({ read: z.boolean(), manage: z.boolean(), refund: z.boolean(), return: z.boolean(), allocate: z.boolean(), shippingRead: z.boolean() }),
});
export async function getAdminOrderDetailCore(client: SupabaseClient, actorId: string, orderId: string): Promise<AdminOrderDetailCore> {
  const data = await callRpc(client, 'get_admin_order_detail', { _order_id: orderId, _actor_id: actorId });
  return guarded(() => detailSchema.parse(data));
}

/** 既存履歴routeは同じメール解決関数を渡せる。単独のstore呼出しにも安全な既定を備える。 */
export async function listAdminOrderItemStateHistory(client: SupabaseClient, actorId: string, orderId: string, actorEmailOf?: (actorId: string) => Promise<string | null>): Promise<{ entries: OrderHistoryItemStateEntry[]; truncated: boolean }> {
  const data = await callRpc(client, 'list_admin_order_item_state_history', { _order_id: orderId, _actor_id: actorId });
  const rows = guarded(() => z.array(itemStateHistoryDbRowSchema).max(301).parse(data));
  const visible = rows.slice(0, 300);
  const ids = [...new Set(visible.flatMap((row) => row.actor_id === null ? [] : [row.actor_id]))];
  try {
    const emails = new Map(await Promise.all(ids.map(async (id) => {
      if (actorEmailOf) return [id, await actorEmailOf(id)] as const;
      const result = await client.auth.admin.getUserById(id);
      if (result.error && result.error.status !== 404) throw new AdminOrderError();
      return [id, result.error ? null : result.data.user?.email ?? null] as const;
    })));
    return { entries: mapItemStateHistoryRows(visible, (id) => emails.get(id) ?? null), truncated: rows.length > 300 };
  } catch { throw new AdminOrderError(); }
}
