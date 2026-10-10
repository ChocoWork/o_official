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
  recordCompletion,
} from '@/lib/orders/fulfillment/fulfillment-store';

const bodySchema = z.object({
  requestKey: z.string().uuid(),
  lines: z
    .array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100)
    .refine((lines) => new Set(lines.map((line) => line.orderItemId)).size === lines.length),
});

const RATE_LIMIT = { endpoint: 'admin:orders:completion-record', limit: 60, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * 受注生産の品の仕上がりを記録する（グループ E-1 設計書 5-2）。記録すると、その数が発送準備中に移る。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 注文の番号 → 中身 → DB の関数の順に確かめる。
 * お客様にメールは送らない（Shopify も、発送の保留を外した時に知らせない）ので、worker は動かさない。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params;
  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.orders.completion.record',
      actor_id: authz.userId,
      resource: 'orders',
      resource_id: id,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    await audit('failure', 'Invalid order id');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細は残さず、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { requestKey, lines } = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const result = await recordCompletion(store, { orderId: parsedId.data, actorId: authz.userId, requestKey, lines });
    await audit('success', 'Completion recorded', {
      line_count: lines.length,
      total_quantity: lines.reduce((total, line) => total + line.quantity, 0),
      replayed: result.replayed,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FulfillmentOperationError) {
      const { status } = FULFILLMENT_ERROR_MESSAGES[error.code];
      await audit(status === 409 ? 'conflict' : 'failure', 'Completion refused', { code: error.code });
      return NextResponse.json(fulfillmentErrorBody(error.code), { status });
    }
    console.error('[admin.orders.completion.record] Failed to record completion', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof FulfillmentStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to record completion');
    return NextResponse.json(fulfillmentFailureBody('completion'), { status: 500 });
  }
}
