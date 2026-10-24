import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createPurchaseOrder, PurchaseOrderError } from '@/lib/purchase-orders/purchase-order-store';
import { PURCHASE_ORDER_LIMITS, PURCHASE_ORDER_TEXT } from '@/lib/purchase-orders/purchase-order-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * 発注書の作成（G-2 / FREQ-526）。発注確定で初めて保存する。権限は窓口と DB の関数の両方で
 * 発注の更新の組（admin.purchase_orders.manage + admin.purchase_orders.read）を確かめ、実行者は認可結果の userId だけから渡す。
 * DB の生の誤りは本文にも監査にもログにも出さない。
 */

const { lines, provisionalQuantity, supplierName, memo } = PURCHASE_ORDER_LIMITS;

const bodySchema = z.object({
  supplierName: z.string().trim().min(supplierName.min).max(supplierName.max),
  // 前後の空白を落としてから長さを見る（DB も落としてから数える。空白だけは DB と同じく無しとして扱う）
  memo: z.string().trim().max(memo.max).optional(),
  lines: z.array(z.object({
    variantId: z.number().int().positive().safe(),
    quantity: z.number().int().min(provisionalQuantity.min).max(provisionalQuantity.max),
  })).min(lines.min).max(lines.max).refine(
    (items) => new Set(items.map((item) => item.variantId)).size === items.length,
    { message: 'variantId は重複できません' },
  ),
  requestKey: z.string().uuid(),
});

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** ログに出す誤りの項目は名前と、あれば code だけ（message・details は DB の文を持ちうる）。 */
function describeErrorForLog(error: unknown): [name: string, code: unknown] {
  const { code = null } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown };
  return [error instanceof Error ? error.name : 'UnknownError', code];
}

export async function POST(request: Request): Promise<Response> {
  try {
    const authz = await authorizeAdminPermissions(['admin.purchase_orders.manage', 'admin.purchase_orders.read'], request);
    if (!authz.ok) return noStore(authz.response);

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrfResult = await requireCsrfOrDeny();
    if (csrfResult instanceof Response) return noStore(csrfResult);
    const rate = { endpoint: 'admin.purchase_orders.create', limit: 30, windowSeconds: 600 };
    const ipLimited = await enforceRateLimit({ request, ...rate });
    if (ipLimited) return noStore(ipLimited);
    const actorLimited = await enforceRateLimit({ request, ...rate, subject: authz.userId });
    if (actorLimited) return noStore(actorLimited);

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return noStore(NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 }));
    }
    const input = parsed.data;

    const client = await createServiceRoleClient();
    const audit = (outcome: 'success' | 'failure' | 'error', resourceId: string | null, metadata: Record<string, unknown>) => logAudit({
      action: 'admin.purchase_orders.confirm', actor_id: authz.userId, resource: 'purchase_orders',
      resource_id: resourceId, outcome, metadata: { line_count: input.lines.length, ...metadata },
    });
    try {
      const result = await createPurchaseOrder(client, authz.userId, {
        supplierName: input.supplierName, memo: input.memo || null, lines: input.lines, requestKey: input.requestKey,
      });
      await audit('success', result.id, { replayed: result.replayed });
      return noStore(NextResponse.json(result, { status: 201 }));
    } catch (error) {
      const failure = error instanceof PurchaseOrderError ? error : new PurchaseOrderError();
      await audit(failure.code ? 'failure' : 'error', null, { code: failure.code ?? 'PURCHASE_ORDER_CREATE_FAILED' });
      return noStore(NextResponse.json({ ...(failure.code ? { code: failure.code } : {}), error: failure.message }, { status: failure.status }));
    }
  } catch (error) {
    console.error('POST /api/admin/purchase-orders error:', ...describeErrorForLog(error));
    return noStore(NextResponse.json({ error: PURCHASE_ORDER_TEXT.failed }, { status: 500 }));
  }
}
