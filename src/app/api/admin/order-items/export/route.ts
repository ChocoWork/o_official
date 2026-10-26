import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { parseOrderItemQuery, toFilterPayload } from '@/lib/orders/admin-orders/admin-order-query';
import { buildOrderItemCsv, orderItemCsvFilename } from '@/lib/orders/admin-orders/admin-order-csv';
import { AdminOrderError, exportAdminOrderItemRows } from '@/lib/orders/admin-orders/admin-order-store';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store'); return response;
}
/** 認可→IP→actor→検証→全行のRPC→CSV→監査。GETなのでCSRF検証は不要。検索語を監査しない。 */
export async function GET(request: Request): Promise<Response> {
  try {
    const authz = await authorizeAdminPermission('admin.orders.read', request);
    if (!authz.ok) return noStore(authz.response);
    const rate = { request, endpoint: 'admin.orders.export', limit: 20, windowSeconds: 600 };
    const ipLimited = await enforceRateLimit(rate);
    if (ipLimited) return noStore(ipLimited);
    const actorLimited = await enforceRateLimit({ ...rate, subject: authz.userId });
    if (actorLimited) return noStore(actorLimited);
    const audit = (outcome: 'success' | 'failure' | 'error', metadata: Record<string, unknown>) => logAudit({ action: 'admin.orders.export', actor_id: authz.userId, resource: 'orders', resource_id: null, outcome, metadata });
    const params = new URL(request.url).searchParams;
    const parsed = parseOrderItemQuery(params);
    if (params.has('page') || !parsed.ok) {
      await audit('failure', { code: 'INVALID_QUERY' });
      return noStore(NextResponse.json({ error: 'Invalid query' }, { status: 400 }));
    }
    try {
      const client = await createServiceRoleClient();
      const result = await exportAdminOrderItemRows(client, authz.userId, parsed.filters);
      const csv = buildOrderItemCsv(result.rows);
      await audit('success', { row_count: result.rowCount, order_count: result.orderCount, filter_keys: Object.keys(toFilterPayload(parsed.filters)) });
      return new Response(csv, { status: 200, headers: {
        'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${orderItemCsvFilename(new Date())}"`, 'Cache-Control': 'no-store',
      } });
    } catch (error) {
      const failure = error instanceof AdminOrderError ? error : new AdminOrderError();
      await audit(failure.code ? 'failure' : 'error', { code: failure.code ?? 'ADMIN_ORDER_EXPORT_FAILED' });
      return noStore(NextResponse.json({ ...(failure.code ? { code: failure.code } : {}), error: failure.message }, { status: failure.status }));
    }
  } catch (error) {
    console.error('[admin.order-items.export] Failed to export', error instanceof Error ? error.name : 'UnknownError', null);
    return noStore(NextResponse.json({ error: new AdminOrderError().message }, { status: 500 }));
  }
}
