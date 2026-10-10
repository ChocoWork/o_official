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
  cancelCompletion,
} from '@/lib/orders/fulfillment/fulfillment-store';

const paramsSchema = z.object({ id: z.string().uuid(), completionId: z.string().uuid() });

const RATE_LIMIT = { endpoint: 'admin:orders:completion-cancel', limit: 30, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * 仕上がりの取消（グループ E-1 設計書 5-2）。その品は受注生産中に戻る。もう送った数を下回る取消は DB が断る。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 番号 → DB の関数の順に確かめる。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; completionId: string }> }) {
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
      action: 'admin.orders.completion.cancel',
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
  const { id: orderId, completionId } = parsedParams.data;

  try {
    const store = await createServiceRoleClient();
    const result = await cancelCompletion(store, { orderId, completionId, actorId: authz.userId });
    await audit(
      'success',
      result.outcome === 'cancelled' ? 'Completion cancelled' : 'Completion was already cancelled',
      { completion_id: completionId, outcome: result.outcome },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfillmentOperationError) {
      const { status } = FULFILLMENT_ERROR_MESSAGES[error.code];
      await audit(status === 409 ? 'conflict' : 'failure', 'Completion cancel refused', { code: error.code });
      return NextResponse.json(fulfillmentErrorBody(error.code), { status });
    }
    console.error('[admin.orders.completion.cancel] Failed to cancel completion', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to cancel completion');
    return NextResponse.json(fulfillmentFailureBody('completion_cancel'), { status: 500 });
  }
}
