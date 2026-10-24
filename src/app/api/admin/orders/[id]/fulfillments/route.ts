import { NextResponse } from 'next/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import {
  LEGACY_FULFILLMENT_DISABLED,
  legacyFulfillmentDisabledBody,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

const RATE_LIMIT = { endpoint: 'admin:orders:fulfillment-create', limit: 60, windowSeconds: 600 } as const;

/** 止めた操作の固定の答え（G-1 Task 14）。本文は全文固定で、入力にかかわらず同じ */
function disabledResponse(): Response {
  return NextResponse.json(legacyFulfillmentDisabledBody(LEGACY_FULFILLMENT_DISABLED), {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * 発送の画面の材料（停止前: グループ E-1 設計書 6-2）。G-1 で旧の発送を止めたので、認可の後は材料を読まずに 410 を返す
 * （LEGACY_FULFILLMENT_DISABLED）。G-3 の新しい発送票へ移る。読むだけなので CSRF と回数の制限は通さない。
 */
export async function GET(request: Request) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) {
    return authz.response;
  }
  return disabledResponse();
}

/**
 * 発送する（停止前: グループ E-1 設計書 6-2）。G-1 で止めた。権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）の後、
 * 入力を読まずに 410（LEGACY_FULFILLMENT_DISABLED）を返す。DB の関数は呼ばない。監査は既存の操作名の failure と固定の記号だけ。
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
  await logAudit({
    action: 'admin.orders.fulfillment.create',
    actor_id: authz.userId,
    resource: 'orders',
    resource_id: id,
    outcome: 'failure',
    detail: 'Legacy fulfillment disabled',
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    user_agent: request.headers.get('user-agent') ?? null,
    metadata: { code: LEGACY_FULFILLMENT_DISABLED },
  });
  return disabledResponse();
}
