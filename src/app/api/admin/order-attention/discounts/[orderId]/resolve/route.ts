import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { getClientIp } from '@/lib/request-ip';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { resolveAdminDiscountAttention } from '@/lib/orders/admin-orders/admin-order-store';
import { AdminDiscountStoreError } from '@/lib/discounts/admin-discount-store';

const emptyBody = z.object({}).strict();
const NO_STORE = 'no-store';

/** 認可・CSRF・回数制限が返す応答も含め、全ての応答を保存させない */
function noStore<T extends Response>(response: T): T {
  try { response.headers.set('Cache-Control', NO_STORE); } catch { /* 変更できない応答はそのまま返す */ }
  return response;
}

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.manage', request);
  if (!authz.ok) return noStore(authz.response);
  const csrf = await requireCsrfOrDeny();
  if (csrf instanceof Response) return noStore(csrf);
  const rule = { request, endpoint: 'admin:orders:discount-attention-resolve', limit: 30, windowSeconds: 600 };
  const ipDenied = await enforceRateLimit({ ...rule, subject: getClientIp(request) });
  if (ipDenied) return noStore(ipDenied);
  const actorDenied = await enforceRateLimit({ ...rule, subject: authz.userId });
  if (actorDenied) return noStore(actorDenied);
  const { orderId } = await params;
  if (!z.string().uuid().safeParse(orderId).success || !emptyBody.safeParse(await request.json().catch(() => null)).success) {
    return noStore(NextResponse.json({ error: '入力を確かめてください。', code: 'GROUP_H_ARGUMENT_INVALID' }, { status: 400 }));
  }
  let result: { resolved: boolean };
  try {
    result = await resolveAdminDiscountAttention(await createServiceRoleClient(), authz.userId, orderId);
  } catch (error) {
    const known = error instanceof AdminDiscountStoreError ? error : new AdminDiscountStoreError();
    return noStore(NextResponse.json({ error: known.message, ...(known.code ? { code: known.code } : {}) }, { status: known.status }));
  }
  // 確認は既にDBで済んでいる。監査の書込みが失敗しても成功を失敗に変えない（固定の記号だけをログに残す）
  try {
    await logAudit({ action: 'admin.orders.discount_attention.resolve', actor_id: authz.userId, resource: 'orders', resource_id: orderId,
      outcome: 'success', metadata: { orderId, resolved: result.resolved } });
  } catch {
    console.error('discount_attention_resolve_audit_failed');
  }
  return noStore(NextResponse.json({ data: result }));
}
