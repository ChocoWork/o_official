import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { handlePurchaseOrderWrite } from '@/lib/purchase-orders/purchase-order-route';
import { getAdminPurchaseOrder, PurchaseOrderError, updatePurchaseOrderHeader } from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_DETAIL_TEXT, PURCHASE_ORDER_LIMITS } from '@/lib/purchase-orders/purchase-order-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

const { supplierName, memo, reason } = PURCHASE_ORDER_LIMITS;

const headerSchema = z.object({
  expectedVersion: z.number().int().min(1).max(2147483647),
  supplierName: z.string().trim().min(supplierName.min).max(supplierName.max),
  // 前後の空白を落としてから長さを見る（DB も落としてから数える）。省くか空白だけならメモを空にする
  memo: z.string().trim().max(memo.max).optional(),
  reason: z.string().trim().min(reason.min).max(reason.max),
  requestKey: z.string().uuid(),
});

/**
 * 発注先・メモの訂正（G-2 / FREQ-527）。理由が必須で、版が古ければ 409。成功は200で { version, replayed } をそのまま返す。
 * 流れは handlePurchaseOrderWrite（認可 → CSRF → 回数制限 → 検証 → DB の関数 → 監査 admin.purchase_orders.header.update）。
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handlePurchaseOrderWrite({
    request,
    context,
    label: 'PATCH /api/admin/purchase-orders/[id]',
    action: 'admin.purchase_orders.header.update',
    rateLimit: 30,
    errorCode: 'PURCHASE_ORDER_HEADER_UPDATE_FAILED',
    schema: headerSchema,
    status: 200,
    run: (client, actorId, purchaseOrderId, body) => updatePurchaseOrderHeader(client, actorId, {
      purchaseOrderId,
      expectedVersion: body.expectedVersion,
      supplierName: body.supplierName,
      memo: body.memo || null,
      reason: body.reason,
      requestKey: body.requestKey,
    }),
    auditSuccess: (_body, result) => ({ replayed: result.replayed }),
    auditFailure: () => ({}),
  });
}

/**
 * 発注書1件の詳細（G-2 / FREQ-526）。読むだけで、保存先の鍵と内部の操作 ID は返さない。
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
