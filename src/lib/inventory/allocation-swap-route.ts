import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { AllocationSwapError, listAllocationSwapCandidates, swapOrderAllocations } from './allocation-swap-store';
import { ALLOCATION_SWAP_TEXT, allocationSwapInputSchema } from './allocation-swap-types';

type Context = { params: Promise<{ id: string }> };
const PERMISSIONS = ['admin.orders.allocate', 'admin.orders.read'] as const;
const uuid = z.string().uuid();
const json = (body: unknown, status: number): Response => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failureResponse = (error: AllocationSwapError): Response => json({ ...(error.code ? { code: error.code } : {}), error: error.message }, error.status);

async function authorize(request: Request) {
  const authz = await authorizeAdminPermissions(PERMISSIONS, request);
  if (!authz.ok) {
    authz.response.headers.set('Cache-Control', 'no-store');
    if (authz.response.status === 403) {
      const body: unknown = await authz.response.clone().json().catch(() => null);
      if (body !== null && typeof body === 'object' && 'permission' in body && !('reason' in body)) {
        return { ...authz, response: json({ ...body, error: ALLOCATION_SWAP_TEXT.forbidden }, 403) };
      }
    }
  }
  return authz;
}

/** G-3の汎用handlerは広げず、入替固有の認可→CSRF→IP→actor→検証→RPC→監査を守る。 */
export async function handleAllocationSwap(request: Request, context: Context): Promise<Response> {
  let audit: ((outcome: 'success' | 'failure' | 'error', metadata: Record<string, unknown>) => Promise<void>) | undefined;
  let orderId: string | null = null;
  try {
    const authz = await authorize(request);
    if (!authz.ok) return authz.response;
    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrf = await requireCsrfOrDeny();
    if (csrf instanceof Response) { csrf.headers.set('Cache-Control', 'no-store'); return csrf; }
    const rate = { request, endpoint: 'admin.orders.allocation.swap', limit: 30, windowSeconds: 600 };
    const ip = await enforceRateLimit(rate);
    if (ip) { ip.headers.set('Cache-Control', 'no-store'); return ip; }
    const actor = await enforceRateLimit({ ...rate, subject: authz.userId });
    if (actor) { actor.headers.set('Cache-Control', 'no-store'); return actor; }
    audit = async (outcome, metadata) => { await logAudit({ action: 'admin.orders.allocation.swap', actor_id: authz.userId, resource: 'orders', resource_id: orderId, outcome, metadata }); };
    const parsedId = uuid.safeParse((await context.params).id);
    if (!parsedId.success) throw new AllocationSwapError('GROUP_G_ARGUMENT_INVALID');
    orderId = parsedId.data;
    const body = allocationSwapInputSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      const reasonOnly = body.error.issues.every((issue) => issue.path.length === 1 && issue.path[0] === 'reason' && issue.code === 'too_small' && issue.minimum === 1);
      throw new AllocationSwapError(reasonOnly ? 'GROUP_G_SWAP_REASON_REQUIRED' : 'GROUP_G_ARGUMENT_INVALID');
    }
    const result = await swapOrderAllocations(await createServiceRoleClient(), authz.userId, orderId, body.data);
    await audit('success', { quantity: result.quantity, replayed: result.replayed });
    return json(result, 200);
  } catch (error) {
    const failure = error instanceof AllocationSwapError ? error
      : new AllocationSwapError(undefined, error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined);
    if (failure.status === 500) console.error('POST /api/admin/orders/[id]/allocations/swap error:', failure.name, failure.sqlstate ?? null);
    // 監査の障害でも結果は不明。生の例外をログへ持ち出さない。
    if (audit) await audit(failure.code ? 'failure' : 'error', { code: failure.code ?? 'ALLOCATION_SWAP_FAILED' }).catch(() => {});
    return failureResponse(failure);
  }
}

/** 読取は同じ2権限とUUIDの検査だけ。CSRF・回数制限は不要。 */
export async function handleAllocationSwapCandidates(request: Request, context: Context): Promise<Response> {
  try {
    const authz = await authorize(request);
    if (!authz.ok) return authz.response;
    const orderId = uuid.safeParse((await context.params).id);
    const query = new URL(request.url).searchParams;
    const item = uuid.safeParse(query.get('orderItemId'));
    if (!orderId.success || !item.success || [...query.keys()].some((key) => key !== 'orderItemId') || query.getAll('orderItemId').length !== 1) throw new AllocationSwapError('GROUP_G_ARGUMENT_INVALID');
    const data = await listAllocationSwapCandidates(await createServiceRoleClient(), authz.userId, orderId.data, item.data);
    return json({ data }, 200);
  } catch (error) { return failureResponse(error instanceof AllocationSwapError ? error : new AllocationSwapError()); }
}
