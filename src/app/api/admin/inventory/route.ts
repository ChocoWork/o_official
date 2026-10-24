import 'server-only';

import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { AdminInventoryError, listAdminInventory } from '@/lib/inventory/inventory-list-store';
import { INVENTORY_LIST_TEXT } from '@/lib/inventory/inventory-list-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * 在庫一覧表（G-2 / FREQ-525）。読むだけで、variant を作る backfill_item_variants は呼ばない。
 * 窓口でも DB の関数でも admin.stock.read を確かめる（実行者は認可結果の userId だけから渡す）。
 * DB の生の誤りは本文にもログにも出さない。
 */
export async function GET(request: Request): Promise<Response> {
  const authz = await authorizeAdminPermission('admin.stock.read', request);
  if (!authz.ok) return noStore(authz.response);

  try {
    const client = await createServiceRoleClient();
    const rows = await listAdminInventory(client, authz.userId);
    return noStore(NextResponse.json({ rows }));
  } catch (error) {
    if (error instanceof AdminInventoryError) {
      return noStore(NextResponse.json({ error: error.message, code: error.code }, { status: error.status }));
    }
    console.error('[admin.inventory] operation failed');
    return noStore(NextResponse.json({ error: INVENTORY_LIST_TEXT.apiFailed }, { status: 500 }));
  }
}
