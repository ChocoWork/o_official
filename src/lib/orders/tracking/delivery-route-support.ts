import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { DELIVERY_ERROR_MESSAGES } from '@/lib/orders/tracking/delivery-messages';
import { DeliveryOperationError, DeliveryStoreError } from '@/lib/orders/tracking/delivery-store';
import type { DeliveryErrorCode } from '@/lib/orders/tracking/delivery-types';
import { getClientIp } from '@/lib/request-ip';

// 伝票番号の訂正（tracking）と手動の配達済み（delivered）の窓口は G-4 Task 8 で撤去した。残る書き込みの窓口は resolve だけ
const RULES = {
  resolve: { endpoint: 'admin:orders:delivery-resolve', limit: 60, windowSeconds: 600 },
} as const;
const ACTIONS = {
  resolve: 'admin.orders.delivery_attention.resolve',
} as const;
type Endpoint = keyof typeof RULES;

export async function guardDeliveryAdminWrite(
  request: Request, endpoint: Endpoint,
): Promise<{ ok: true; actorId: string } | { ok: false; response: Response }> {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) return { ok: false, response: authz.response };
  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrf = await requireCsrfOrDeny();
  if (csrf instanceof Response) return { ok: false, response: csrf };
  const ip = await enforceRateLimit({ request, ...RULES[endpoint] });
  if (ip) return { ok: false, response: ip };
  const actor = await enforceRateLimit({ request, ...RULES[endpoint], subject: authz.userId });
  if (actor) return { ok: false, response: actor };
  return { ok: true, actorId: authz.userId };
}

export function deliveryErrorReply(error: unknown): { status: number; body: { error: string; code?: DeliveryErrorCode } } {
  if (error instanceof DeliveryOperationError) {
    const { status, message } = DELIVERY_ERROR_MESSAGES[error.code];
    return { status, body: { error: message, code: error.code } };
  }
  return { status: 500, body: { error: '配送の記録を保存できませんでした。時間をおいて、もう一度お試しください。' } };
}

export const deliveryUuid = z.string().uuid();
export const deliveryDate = z.string().refine((value) => {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

/** C-3 の操作名と許可した metadata だけを各窓口から受け取る。本文や例外の文は渡さない。 */
export function createDeliveryAudit(request: Request, actorId: string, endpoint: Endpoint, resourceId: string | null) {
  return (outcome: 'success' | 'failure' | 'conflict' | 'error', metadata: Record<string, unknown> | null = null) => logAudit({
    action: ACTIONS[endpoint], actor_id: actorId,
    resource: 'order_fulfillment_attention', resource_id: resourceId,
    outcome, metadata,
    ip: getClientIp(request),
    user_agent: request.headers.get('user-agent') ?? null,
  });
}

export async function respondToDeliveryError(error: unknown, audit: ReturnType<typeof createDeliveryAudit>): Promise<Response> {
  const reply = deliveryErrorReply(error);
  if (reply.status === 500) {
    console.error('[admin.orders.delivery] Failed to save delivery', error instanceof Error ? error.name : 'UnknownError',
      ...(error instanceof DeliveryStoreError && error.code ? [error.code] : []));
  }
  await audit(reply.status === 500 ? 'error' : reply.status === 409 ? 'conflict' : 'failure');
  return NextResponse.json(reply.body, { status: reply.status });
}
