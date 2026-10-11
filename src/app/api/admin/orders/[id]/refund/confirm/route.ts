import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { INVALID_REQUEST_BODY, refundFailureBody } from '@/lib/orders/refund/refund-messages';
import { refundErrorLogFields, toRefundReply } from '@/lib/orders/refund/refund-route-support';
import { confirmAwaitingRefund, createDefaultRefundServiceDeps } from '@/lib/orders/refund/refund-service';

const bodySchema = z.object({ refundId: z.string().uuid() });

// 返金の窓口と同じ鍵で数える。確かめ直しの連打で、返金の回数の制限を逃れさせない（P24）
const RATE_LIMIT = { endpoint: 'admin:orders:refund-create', limit: 30, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/**
 * 返事待ちの返金を、記録の番号で確かめ直す（グループ E-2 設計書 5-1、本計画 P24）。
 * 返金の画面を開き直すと二重防止の番号も中身も残っていないので、「確かめ中の返金があります」の
 * 「もう一度確かめる」はこの窓口を呼ぶ。記録がこの注文の物でなければ 404、返事待ちでなければ今の状態を返す。
 * 答えは返金の窓口と同じ形。権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 注文の番号 → 中身の順に確かめる。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.refund', request);
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
      action: 'admin.orders.refund.confirm',
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
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const { refundId } = parsedBody.data;

  try {
    const deps = await createDefaultRefundServiceDeps();
    const result = await confirmAwaitingRefund(deps, { orderId: parsedId.data, refundId });
    const reply = toRefundReply(result);
    await audit(reply.audit.outcome, reply.audit.detail, { refund_id: refundId, ...reply.audit.metadata });
    return NextResponse.json(reply.body, { status: reply.status });
  } catch (error) {
    console.error('[admin.orders.refund.confirm] Failed to confirm refund', ...refundErrorLogFields(error));
    await audit('error', 'Failed to confirm refund', { refund_id: refundId });
    return NextResponse.json(refundFailureBody('create'), { status: 500 });
  }
}
