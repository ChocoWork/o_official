import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import {
  MANUAL_COMPLETION_DISABLED,
  legacyFulfillmentDisabledBody,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

const RATE_LIMIT = { endpoint: 'admin:orders:completion-cancel', limit: 30, windowSeconds: 600 } as const;

/**
 * 仕上がりの取消（停止前: グループ E-1 設計書 5-2）。G-1 で終了した。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）の後、番号を読まずに 410（MANUAL_COMPLETION_DISABLED）を返す。
 * DB の関数は呼ばない。監査は既存の操作名の failure と固定の記号だけ。
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
  const parsedId = z.string().uuid().safeParse(rawParams.id);
  await logAudit({
    action: 'admin.orders.completion.cancel',
    actor_id: authz.userId,
    resource: 'orders',
    resource_id: parsedId.success ? parsedId.data : null,
    outcome: 'failure',
    detail: 'Manual completion disabled',
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    user_agent: request.headers.get('user-agent') ?? null,
    metadata: { code: MANUAL_COMPLETION_DISABLED },
  });
  return NextResponse.json(legacyFulfillmentDisabledBody(MANUAL_COMPLETION_DISABLED), {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  });
}
