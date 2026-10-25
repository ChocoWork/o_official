import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { canCorrectShipmentDate, getAdminShipmentSlip, ShipmentSlipError } from '@/lib/orders/shipment-slips/shipment-slip-store';
import { SHIPMENT_SLIP_TEXT } from '@/lib/orders/shipment-slips/shipment-slip-types';
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
 * 発送票1件の詳細（G-3 / FREQ-531）。読むだけで、全注文の品物と送り先・荷物の情報・履歴を返す（お客様には見せない管理の画面用）。
 * 窓口でも DB の関数でも admin.shipping.read + admin.orders.read を確かめる（実行者は認可結果の userId だけから渡す）。
 * id が uuid でなければ400、無ければ404。DB の生の誤りは本文にもログにも出さない。
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const authz = await authorizeAdminPermissions(['admin.shipping.read', 'admin.orders.read'], request);
  if (!authz.ok) return noStore(authz.response);

  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return noStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
  }

  try {
    const client = await createServiceRoleClient();
    // 表示用の不足を認可拒否としてログに残さない。書込み時の窓口・DBの再認可が最終判断。
    const canCorrectDate = await canCorrectShipmentDate(client, authz.userId);
    const slip = await getAdminShipmentSlip(client, authz.userId, id);
    return noStore(NextResponse.json({ slip, canCorrectDate }));
  } catch (error) {
    if (error instanceof ShipmentSlipError && error.code) {
      return noStore(NextResponse.json({ code: error.code, error: error.message }, { status: error.status }));
    }
    console.error('GET /api/admin/shipment-slips/[id] error:', ...describeErrorForLog(error));
    return noStore(NextResponse.json({ error: SHIPMENT_SLIP_TEXT.failed }, { status: 500 }));
  }
}
