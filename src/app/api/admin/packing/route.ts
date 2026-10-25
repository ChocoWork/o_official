import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { listAdminPacking, ShipmentSlipError } from '@/lib/orders/shipment-slips/shipment-slip-store';
import { readShipmentSlipQueryInteger, SHIPMENT_SLIP_LIMITS, SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** ログに出す誤りの項目は名前と、あれば code だけ（message・details は DB の文を持ちうる）。 */
function describeErrorForLog(error: unknown): [name: string, code: unknown] {
  const { code = null } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown };
  return [error instanceof Error ? error.name : 'UnknownError', code];
}

/**
 * 荷作り表（G-3 / FREQ-531）。発送準備中の品物の行を、古い注文から返す（読むだけ）。
 * 窓口でも DB の関数でも admin.shipping.read + admin.orders.read を確かめる（実行者は認可結果の userId だけから渡す）。
 * slipId を付けると、その下書きが選んでいる数と同梱できるかも付く。DB の生の誤りは本文にもログにも出さない。
 */
export async function GET(request: Request): Promise<Response> {
  const authz = await authorizeAdminPermissions(['admin.shipping.read', 'admin.orders.read'], request);
  if (!authz.ok) return noStore(authz.response);

  const params = new URL(request.url).searchParams;
  const limit = readShipmentSlipQueryInteger(params.get('limit'), SHIPMENT_SLIP_LIMITS.packingPage.limit);
  const page = readShipmentSlipQueryInteger(params.get('page'), SHIPMENT_SLIP_LIMITS.packingPage.page);
  const slipId = params.get('slipId');
  if (limit === null || page === null || (slipId !== null && !z.string().uuid().safeParse(slipId).success)) {
    return noStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
  }

  try {
    const client = await createServiceRoleClient();
    const { rows, total } = await listAdminPacking(client, authz.userId, { slipId, limit, page });
    return noStore(NextResponse.json({ rows, total, page, limit }));
  } catch (error) {
    if (error instanceof ShipmentSlipError && error.code) {
      return noStore(NextResponse.json({ code: error.code, error: error.message }, { status: error.status }));
    }
    console.error('GET /api/admin/packing error:', ...describeErrorForLog(error));
    return noStore(NextResponse.json({ error: SHIPMENT_SLIP_TEXT.failed }, { status: 500 }));
  }
}
