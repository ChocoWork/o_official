import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { countReturnAttention } from '@/lib/orders/returns/return-store';
import { countOrdersWithOpenCancelRequest } from '@/lib/orders/returns/cancel-request-reads';
import { parseOrderItemQuery } from '@/lib/orders/admin-orders/admin-order-query';
import { AdminOrderError, listAdminOrderItemRows } from '@/lib/orders/admin-orders/admin-order-store';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store'); return response;
}
/** 認可→問合せの検証→単一スナップショットの一覧→件数。上限到達は正常な200。 */
export async function GET(request: Request): Promise<Response> {
  try {
    const authz = await authorizeAdminPermission('admin.orders.read', request);
    if (!authz.ok) return noStore(authz.response);
    const parsed = parseOrderItemQuery(new URL(request.url).searchParams);
    if (!parsed.ok) return noStore(NextResponse.json({ error: 'Invalid query' }, { status: 400 }));
    const client = await createServiceRoleClient();
    const [data, returnAttention, cancelRequestAttention] = await Promise.all([
      listAdminOrderItemRows(client, authz.userId, parsed.filters, parsed.page),
      countReturnAttention(client), countOrdersWithOpenCancelRequest(client),
    ]);
    return noStore(NextResponse.json({ data, returnAttention, cancelRequestAttention }));
  } catch (error) {
    const failure = error instanceof AdminOrderError ? error : new AdminOrderError();
    if (!failure.code) console.error('[admin.order-items] Failed to load', error instanceof Error ? error.name : 'UnknownError', null);
    return noStore(NextResponse.json({ ...(failure.code ? { code: failure.code } : {}), error: failure.message }, { status: failure.status }));
  }
}
