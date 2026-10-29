import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { LEGACY_ORDER_DISCOUNT_NAME, MAX_DISCOUNT_AMOUNT, type AdminOrderDiscountBreakdown } from './discount-types';

/**
 * Reads the discount breakdown frozen on one order (service role only, via `get_order_discount_breakdown`).
 * The caller is responsible for authorization: member routes check ownership first, the public status page uses its
 * token/session, admin uses `authorizeAdminPermission`. The SQL sentinel name stays as returned; surfaces convert it with
 * `toCustomerOrderDiscounts` / `displayOrderDiscountName` in `discount-types.ts`.
 * A malformed answer or any DB failure becomes a fixed error that carries no DB text.
 * Import from `order-discount-store.ts` in route handlers and pages (it adds the server-only guard).
 */
export class OrderDiscountStoreError extends Error {
  readonly code = 'ORDER_DISCOUNT_STORE_FAILED' as const;

  constructor(readonly operation: string) {
    super('order discount store failed');
    this.name = 'OrderDiscountStoreError';
  }
}

const OPERATION = 'get_order_discount_breakdown';
const amount = z.number().int().min(1).max(MAX_DISCOUNT_AMOUNT);
const rowSchema = z.object({
  name: z.string().min(1),
  amount,
  discountId: z.string().uuid().nullable(),
  code: z.string().nullable(),
  lineAllocations: z.array(z.object({ orderItemId: z.string().uuid(), amount }).strict()),
}).strict();

/**
 * Rows of one order: either one legacy total row (no discount id, no code, no allocations, the SQL sentinel name),
 * or current rows that all carry a distinct discount id.
 */
export const orderDiscountRowsSchema = z.array(rowSchema).max(50).superRefine((rows, ctx) => {
  const legacy = rows.some(row => row.discountId === null);
  const valid = legacy
    ? rows.length === 1 && rows[0].code === null && rows[0].lineAllocations.length === 0 && rows[0].name === LEGACY_ORDER_DISCOUNT_NAME
    : new Set(rows.map(row => row.discountId)).size === rows.length;
  if (!valid) ctx.addIssue({ code: 'custom', message: 'invalid' });
});
const resultSchema = z.object({ rows: orderDiscountRowsSchema, legacy: z.boolean() }).strict().superRefine((value, ctx) => {
  // A legacy answer has at most one total row; a current answer never contains the legacy total row.
  const hasLegacyRow = value.rows.some(row => row.discountId === null);
  if (value.legacy ? value.rows.length > 0 && !hasLegacyRow : hasLegacyRow) ctx.addIssue({ code: 'custom', message: 'invalid' });
});

export async function getOrderDiscountBreakdown(
  client: Pick<SupabaseClient, 'rpc'>, orderId: string,
): Promise<{ rows: AdminOrderDiscountBreakdown[]; legacy: boolean }> {
  let response: { data: unknown; error: unknown };
  try {
    response = await client.rpc(OPERATION, { _order_id: orderId });
  } catch {
    throw new OrderDiscountStoreError(OPERATION);
  }
  if (response.error) throw new OrderDiscountStoreError(OPERATION);
  const parsed = resultSchema.safeParse(response.data);
  if (!parsed.success) throw new OrderDiscountStoreError(OPERATION);
  return parsed.data;
}
