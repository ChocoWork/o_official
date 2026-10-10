import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import {
  FULFILLMENT_ERROR_MESSAGES,
  INVALID_REQUEST_BODY,
  fulfillmentErrorBody,
  fulfillmentFailureBody,
} from '@/lib/orders/fulfillment/fulfillment-messages';
import {
  FulfillmentOperationError,
  FulfillmentStoreError,
  cancelFulfillment,
  listOrderFulfillments,
  type FulfillmentStore,
} from '@/lib/orders/fulfillment/fulfillment-store';

const paramsSchema = z.object({ id: z.string().uuid(), fulfillmentId: z.string().uuid() });

const RATE_LIMIT = { endpoint: 'admin:orders:fulfillment-cancel', limit: 30, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/** 監査に「何回目か」を残すための読み取り。引けなくても、取消の結果は変えない */
async function findFulfillmentSequence(store: FulfillmentStore, orderId: string, fulfillmentId: string): Promise<number | null> {
  try {
    const rows = await listOrderFulfillments(store, orderId);
    return rows.find((row) => row.fulfillmentId === fulfillmentId)?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * 発送の取消（グループ E-1 設計書 7-2）。その商品は発送準備中に戻り、全部を送っていた注文は決済完了に戻る。
 * お客様にメールは送らない（送った発送のメールは、店から連絡する）。まだ送っていない発送のメールは DB の関数が取りやめにする。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 番号 → DB の関数の順に確かめる。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; fulfillmentId: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const ipLimited = await enforceRateLimit({ request, ...RATE_LIMIT });
  if (ipLimited) {
    return ipLimited;
  }
  const actorLimited = await enforceRateLimit({ request, ...RATE_LIMIT, subject: authz.userId });
  if (actorLimited) {
    return actorLimited;
  }

  const rawParams = await params;
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.orders.fulfillment.cancel',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: rawParams.id,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedParams = paramsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    await audit('failure', 'Invalid id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { id: orderId, fulfillmentId } = parsedParams.data;

  try {
    const store = await createServiceRoleClient();
    const result = await cancelFulfillment(store, { orderId, fulfillmentId, actorId: authz.userId });
    await audit(
      'success',
      result.outcome === 'cancelled' ? 'Fulfillment cancelled' : 'Fulfillment was already cancelled',
      {
        fulfillment_id: fulfillmentId,
        sequence: await findFulfillmentSequence(store, orderId, fulfillmentId),
        outcome: result.outcome,
        order_status: result.orderStatus,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfillmentOperationError) {
      const { status } = FULFILLMENT_ERROR_MESSAGES[error.code];
      await audit(status === 409 ? 'conflict' : 'failure', 'Fulfillment cancel refused', { code: error.code });
      return NextResponse.json(fulfillmentErrorBody(error.code), { status });
    }
    console.error('[admin.orders.fulfillment.cancel] Failed to cancel fulfillment', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to cancel fulfillment');
    return NextResponse.json(fulfillmentFailureBody('cancel'), { status: 500 });
  }
}
