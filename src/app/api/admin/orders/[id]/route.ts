import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { AdminOrderError, getAdminOrderDetailCore } from '@/lib/orders/admin-orders/admin-order-store';
import { buildAdminOrderSummary, type AdminOrderSummaryInput } from '@/lib/orders/admin-orders/admin-order-summary';
import type { AdminOrderDetail, AdminOrderSummary } from '@/lib/orders/admin-orders/admin-order-types';
import { listOrderFulfillments } from '@/lib/orders/fulfillment/fulfillment-store';
import { listAdminOrderShipmentSlips, ShipmentSlipError } from '@/lib/orders/shipment-slips/shipment-slip-store';
import type { ShipmentSlipLink } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { DeliveryStoreError, getOrderDeliveryDetail } from '@/lib/orders/tracking/delivery-store';
import type { OrderDeliveryDetail } from '@/lib/orders/tracking/delivery-types';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store'); return response;
}
async function loadSummary(client: SupabaseClient, orderId: string): Promise<AdminOrderSummary> {
  const { data, error } = await client.from('orders').select(`
    id, payment_intent_id, checkout_session_id, review_reason, reviewed_at, status, total_amount, refunded_amount, currency,
    shipping_full_name, shipping_email, shipping_postal_code, shipping_prefecture, shipping_city, shipping_address, shipping_phone,
    created_at, shipped_at, shipping_carrier, tracking_number,
    order_items (id, item_name, color, size, quantity, fulfillment_type, line_kind)
  `).eq('id', orderId).maybeSingle<AdminOrderSummaryInput>();
  if (error) throw new AdminOrderError();
  if (!data) throw new AdminOrderError(404, 'GROUP_G_ORDER_NOT_FOUND');
  return buildAdminOrderSummary(client, data);
}
/** 票のリンクは補助情報。権限不足は静かにnull、ほかの失敗は名前とcodeだけを残す。 */
async function loadSlipLinks(client: SupabaseClient, actorId: string, orderId: string): Promise<ReadonlyMap<string, ShipmentSlipLink> | null> {
  try {
    return await listAdminOrderShipmentSlips(client, actorId, orderId);
  } catch (error) {
    if (!(error instanceof ShipmentSlipError && error.code === 'GROUP_G_FORBIDDEN')) console.error('[admin.orders.detail] Failed to load shipment slip links', error instanceof Error ? error.name : 'UnknownError', error instanceof ShipmentSlipError ? error.code ?? null : null);
    return null;
  }
}
/** 配送は配達日時を補う情報。読めなくても注文の詳細は返す。 */
async function loadDeliveryDetail(client: SupabaseClient, orderId: string): Promise<OrderDeliveryDetail | null> {
  try {
    return await getOrderDeliveryDetail(client, orderId);
  } catch (error) {
    console.error('[admin.orders.detail] Failed to load delivery detail', error instanceof Error ? error.name : 'UnknownError', error instanceof DeliveryStoreError ? error.code : null);
    return null;
  }
}
/** 認可→UUID検証→core・既存summary・発送・票を並行して読み、公開する欄だけを返す。 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const authz = await authorizeAdminPermission('admin.orders.read', request);
    if (!authz.ok) return noStore(authz.response);
    const parsed = z.string().uuid().safeParse((await context.params).id);
    if (!parsed.success) return noStore(NextResponse.json({ error: 'Invalid order id' }, { status: 400 }));
    const client = await createServiceRoleClient(); const id = parsed.data;
    const [core, summary, fulfillments, slipLinks, delivery] = await Promise.all([
      getAdminOrderDetailCore(client, authz.userId, id), loadSummary(client, id), listOrderFulfillments(client, id), loadSlipLinks(client, authz.userId, id), loadDeliveryDetail(client, id),
    ]);
    const deliveredAt = new Map((delivery?.fulfillments ?? []).map((row) => [row.fulfillmentId, row.deliveredAt]));
    const slips = slipLinks === null ? null : [...new Map([...slipLinks.values()].map((link) => [link.slipId, link])).values()];
    const data: AdminOrderDetail = { ...core, summary, fulfillments: fulfillments.map((row) => ({
      id: row.fulfillmentId, number: row.number, shippedAt: row.shippedAt, deliveredAt: deliveredAt.get(row.fulfillmentId) ?? null,
      cancelledAt: row.cancelledAt, carrier: row.shippingCarrier, trackingNumber: row.trackingNumber,
      slipId: slipLinks?.get(row.fulfillmentId)?.slipId ?? null, slipNumber: slipLinks?.get(row.fulfillmentId)?.number ?? null,
    })), slips };
    return noStore(NextResponse.json({ data }));
  } catch (error) {
    const failure = error instanceof AdminOrderError ? error : new AdminOrderError();
    if (!failure.code) console.error('[admin.orders.detail] Failed to load', error instanceof Error ? error.name : 'UnknownError', null);
    return noStore(NextResponse.json({ ...(failure.code ? { code: failure.code } : {}), error: failure.message }, { status: failure.status }));
  }
}
