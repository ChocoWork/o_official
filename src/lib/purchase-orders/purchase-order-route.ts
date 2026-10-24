import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { PurchaseOrderError } from './purchase-order-store';
import { PURCHASE_ORDER_TEXT } from './purchase-order-types';

/**
 * 発注書1件に対する書込みの窓口（G-2 Task 6: 発注先・メモの訂正、数量の確定・訂正、残りの打切り）が共通で使う流れ。
 * 認可（admin.purchase_orders.manage + admin.purchase_orders.read）→ CSRF → IP の回数制限 → actor の回数制限 → 検証（パスの id・本文）
 * → store → 監査。実行者は認可結果の userId だけから渡す。DB の生の誤りは本文にも監査にもログにも出さない。
 * 監査の metadata は対象 ID・件数・結果コードだけ。パスの id が uuid でなければ resource_id は null（受け取った文字列は残さない）。
 */

type WriteSpec<Body, Result> = {
  request: Request;
  context: { params: Promise<{ id: string }> };
  /** ログの見出し（例: `PATCH /api/admin/purchase-orders/[id]`） */
  label: string;
  /** 監査の action であり、回数制限の endpoint 名でもある */
  action: string;
  rateLimit: number;
  /** 監査の結果コード（DB の誤りが表に無い時） */
  errorCode: string;
  schema: z.ZodType<Body>;
  status: 200 | 201;
  run: (client: SupabaseClient, actorId: string, purchaseOrderId: string, body: Body) => Promise<Result>;
  auditSuccess: (body: Body, result: Result) => Record<string, unknown>;
  auditFailure: (body: Body) => Record<string, unknown>;
};

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** ログに出す誤りの項目は名前と、あれば code だけ（message・details は DB の文を持ちうる）。 */
function describeErrorForLog(error: unknown): [name: string, code: unknown] {
  const { code = null } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown };
  return [error instanceof Error ? error.name : 'UnknownError', code];
}

export async function handlePurchaseOrderWrite<Body, Result>(spec: WriteSpec<Body, Result>): Promise<Response> {
  try {
    const authz = await authorizeAdminPermissions(['admin.purchase_orders.manage', 'admin.purchase_orders.read'], spec.request);
    if (!authz.ok) return noStore(authz.response);

    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrfResult = await requireCsrfOrDeny();
    if (csrfResult instanceof Response) return noStore(csrfResult);
    const rate = { endpoint: spec.action, limit: spec.rateLimit, windowSeconds: 600 };
    const ipLimited = await enforceRateLimit({ request: spec.request, ...rate });
    if (ipLimited) return noStore(ipLimited);
    const actorLimited = await enforceRateLimit({ request: spec.request, ...rate, subject: authz.userId });
    if (actorLimited) return noStore(actorLimited);

    const audit = (outcome: 'success' | 'failure' | 'error', resourceId: string | null, metadata: Record<string, unknown>) => logAudit({
      action: spec.action, actor_id: authz.userId, resource: 'purchase_orders', resource_id: resourceId, outcome, metadata,
    });

    const { id } = await spec.context.params;
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) {
      await audit('failure', null, { code: 'INVALID_REQUEST' });
      return noStore(NextResponse.json({ error: 'Invalid request' }, { status: 400 }));
    }
    const purchaseOrderId = parsedId.data;
    const parsedBody = spec.schema.safeParse(await spec.request.json().catch(() => ({})));
    if (!parsedBody.success) {
      await audit('failure', purchaseOrderId, { code: 'INVALID_REQUEST' });
      return noStore(NextResponse.json({ error: 'Invalid request', details: parsedBody.error.flatten() }, { status: 400 }));
    }
    const body = parsedBody.data;

    const client = await createServiceRoleClient();
    try {
      const result = await spec.run(client, authz.userId, purchaseOrderId, body);
      await audit('success', purchaseOrderId, spec.auditSuccess(body, result));
      return noStore(NextResponse.json(result, { status: spec.status }));
    } catch (error) {
      const failure = error instanceof PurchaseOrderError ? error : new PurchaseOrderError();
      await audit(failure.code ? 'failure' : 'error', purchaseOrderId, { ...spec.auditFailure(body), code: failure.code ?? spec.errorCode });
      return noStore(NextResponse.json({ ...(failure.code ? { code: failure.code } : {}), error: failure.message }, { status: failure.status }));
    }
  } catch (error) {
    console.error(`${spec.label} error:`, ...describeErrorForLog(error));
    return noStore(NextResponse.json({ error: PURCHASE_ORDER_TEXT.failed }, { status: 500 }));
  }
}
