import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { getAdminPurchaseOrder, PurchaseOrderError } from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_DETAIL_TEXT } from '@/lib/purchase-orders/purchase-order-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * 発注書1件の詳細（G-2 / FREQ-526。この Task は GET だけ）。読むだけで、保存先の鍵と内部の操作 ID は返さない。
 * 窓口でも DB の関数でも admin.purchase_orders.read を確かめる（実行者は認可結果の userId だけから渡す）。
 * id が uuid でなければ400、無ければ404。DB の生の誤りは本文にもログにも出さない。
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const authz = await authorizeAdminPermission('admin.purchase_orders.read', request);
  if (!authz.ok) return noStore(authz.response);

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return noStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
  }

  try {
    const client = await createServiceRoleClient();
    const purchaseOrder = await getAdminPurchaseOrder(client, authz.userId, id);
    if (purchaseOrder === null) {
      return noStore(NextResponse.json({ error: PURCHASE_ORDER_DETAIL_TEXT.notFound }, { status: 404 }));
    }
    return noStore(NextResponse.json({ purchaseOrder }));
  } catch (error) {
    if (error instanceof PurchaseOrderError && error.code) {
      return noStore(NextResponse.json({ code: error.code, error: error.message }, { status: error.status }));
    }
    console.error('[admin.purchase_orders] detail failed');
    return noStore(NextResponse.json({ error: PURCHASE_ORDER_DETAIL_TEXT.apiFailed }, { status: 500 }));
  }
}
