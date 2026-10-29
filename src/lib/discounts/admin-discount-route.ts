import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermission, type PermissionCode } from '@/lib/auth/admin-rbac';
import { NO_STORE_CACHE_CONTROL } from '@/lib/http/no-store';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { parseDiscountDetailQuery, parseDiscountListQuery, parseDiscountMemberQuery, uuidSchema } from './admin-discount-schema';
import { AdminDiscountStoreError, getAdminDiscount, listAdminDiscounts, searchAdminDiscountMembers } from './admin-discount-store';
import type { AdminDiscountDetail, DiscountPermissions } from './admin-discount-types';

export type DiscountContext = { params: Promise<{ id: string }> };
export type DiscountAuditAction =
  | 'admin.discounts.create' | 'admin.discounts.update' | 'admin.discounts.stop' | 'admin.discounts.resume'
  | 'admin.discounts.duplicate' | 'admin.discounts.assign' | 'admin.discounts.unassign' | 'admin.discounts.generate_codes';
type AuditMetadata = { changed_count?: number; generated_count?: number; replayed?: boolean; result_code?: string };

const WINDOW_SECONDS = 600;
const READ: PermissionCode = 'admin.discounts.read';
const MANAGE: PermissionCode = 'admin.discounts.manage';

function noStore<T extends Response>(response: T): T {
  response.headers.set('Cache-Control', NO_STORE_CACHE_CONTROL);
  return response;
}
export const json = (body: unknown, status: number): Response => noStore(NextResponse.json(body, { status }));
const failureResponse = (error: AdminDiscountStoreError): Response => json({ ...(error.code ? { code: error.code } : {}), error: error.message }, error.status);
const invalid = (): AdminDiscountStoreError => new AdminDiscountStoreError('GROUP_H_ARGUMENT_INVALID');
const sqlstateOf = (error: unknown): unknown => (error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined);
const asStoreError = (error: unknown): AdminDiscountStoreError => (error instanceof AdminDiscountStoreError ? error : new AdminDiscountStoreError(null, sqlstateOf(error)));
const permissionsOf = (permissions: ReadonlySet<PermissionCode>): DiscountPermissions => ({ read: permissions.has(READ), manage: permissions.has(MANAGE) });

/** 回数制限はIPとactorを別々に数える。IPは getClientIp だけから取られる（enforceRateLimit の内部）。 */
async function limitIpAndActor(request: Request, endpoint: string, limit: number, actorId: string): Promise<Response | undefined> {
  const rate = { request, endpoint, limit, windowSeconds: WINDOW_SECONDS };
  const ip = await enforceRateLimit(rate);
  if (ip) return noStore(ip);
  const actor = await enforceRateLimit({ ...rate, subject: actorId });
  return actor ? noStore(actor) : undefined;
}

function logUnexpected(label: string, failure: AdminDiscountStoreError): void {
  if (failure.status === 500) console.error(`${label} error:`, failure.name, failure.sqlstate ?? null);
}

/** 読取: 認可(read) → 検証 → store。回数制限・CSRF・監査は増やさない。全応答がno-store。 */
export async function handleDiscountList(request: Request): Promise<Response> {
  try {
    const authz = await authorizeAdminPermission(READ, request);
    if (!authz.ok) return noStore(authz.response);
    const query = parseDiscountListQuery(new URL(request.url).searchParams);
    if (!query) throw invalid();
    const data = await listAdminDiscounts(await createServiceRoleClient(), authz.userId, query.filters, query.page);
    return json({ data, permissions: permissionsOf(authz.permissions) }, 200);
  } catch (error) {
    const failure = asStoreError(error);
    logUnexpected('GET /api/admin/discounts', failure);
    return failureResponse(failure);
  }
}

export async function handleDiscountDetail(request: Request, context: DiscountContext): Promise<Response> {
  try {
    const authz = await authorizeAdminPermission(READ, request);
    if (!authz.ok) return noStore(authz.response);
    const id = uuidSchema.safeParse((await context.params).id);
    const query = parseDiscountDetailQuery(new URL(request.url).searchParams);
    if (!id.success || !query) throw invalid();
    const detail = await getAdminDiscount(await createServiceRoleClient(), authz.userId, id.data, query.page);
    const data: AdminDiscountDetail = { ...detail, permissions: permissionsOf(authz.permissions) };
    return json({ data }, 200);
  } catch (error) {
    const failure = asStoreError(error);
    logUnexpected('GET /api/admin/discounts/[id]', failure);
    return failureResponse(failure);
  }
}

/** 会員検索: 認可(manage) → IP/actor制限 → 検証 → store。GETなのでCSRFは不要。 */
export async function handleDiscountMembers(request: Request): Promise<Response> {
  try {
    const authz = await authorizeAdminPermission(MANAGE, request);
    if (!authz.ok) return noStore(authz.response);
    const limited = await limitIpAndActor(request, 'admin.discounts.members', 60, authz.userId);
    if (limited) return limited;
    const query = parseDiscountMemberQuery(new URL(request.url).searchParams);
    if (!query) throw invalid();
    const data = await searchAdminDiscountMembers(await createServiceRoleClient(), authz.userId, query.query);
    return json({ data }, 200);
  } catch (error) {
    const failure = asStoreError(error);
    logUnexpected('GET /api/admin/discounts/members', failure);
    return failureResponse(failure);
  }
}

export type DiscountWriteSpec<B, R> = {
  label: string;
  action: DiscountAuditAction;
  /** true: URLの [id] をUUIDとして検証して run へ渡す。false: 新規作成。 */
  withId: boolean;
  /** codes の追加制限（admin.discounts.codes）。 */
  codesLimit?: boolean;
  codesLimitForBody?: (body: B) => boolean;
  schema: z.ZodType<B>;
  status: 200 | 201;
  run: (client: SupabaseClient, actorId: string, id: string | null, body: B) => Promise<R>;
  /** 成功時に監査へ載せる値。コード・名前・メール・userIds・prefixは載せない。 */
  audit: (result: R, body: B) => AuditMetadata;
  /** 成功時の resource_id。withId=false の作成だけ結果のidを使う。 */
  resultId?: (result: R) => string;
};

/**
 * 書込: 認可(manage) → CSRF → IP制限 → actor制限 →（codesは追加の制限）→ 入力 → store/RPC → 監査 → 応答。
 * 途中で拒否したら以降を呼ばない。actorは認可結果の userId だけで、本文からは受け取らない。
 */
export async function handleDiscountWrite<B, R>(request: Request, context: DiscountContext | null, spec: DiscountWriteSpec<B, R>): Promise<Response> {
  let audit: ((outcome: 'success' | 'failure' | 'error', resourceId: string | null, metadata: AuditMetadata) => Promise<void>) | undefined;
  let discountId: string | null = null;
  try {
    const authz = await authorizeAdminPermission(MANAGE, request);
    if (!authz.ok) return noStore(authz.response);
    const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
    const csrf = await requireCsrfOrDeny();
    if (csrf instanceof Response) return noStore(csrf);
    const limited = await limitIpAndActor(request, 'admin.discounts.write', 30, authz.userId);
    if (limited) return limited;
    if (spec.codesLimit) {
      const codesLimited = await limitIpAndActor(request, 'admin.discounts.codes', 10, authz.userId);
      if (codesLimited) return codesLimited;
    }
    audit = async (outcome, resourceId, metadata) => {
      await logAudit({ action: spec.action, actor_id: authz.userId, resource: 'discounts', resource_id: resourceId, outcome, metadata });
    };
    if (spec.withId) {
      const id = uuidSchema.safeParse((await context?.params)?.id);
      if (!id.success) throw invalid();
      discountId = id.data;
    }
    const body = spec.schema.safeParse(await request.json().catch(() => null));
    if (!body.success) throw invalid();
    if (spec.codesLimitForBody?.(body.data)) {
      const limitedCodes = await limitIpAndActor(request, 'admin.discounts.codes', 10, authz.userId);
      if (limitedCodes) return limitedCodes;
    }
    const result = await spec.run(await createServiceRoleClient(), authz.userId, discountId, body.data);
    // 書込みは済んでいる。監査の障害で成功を500に変えない（logAudit自身も例外を握る）。
    await audit('success', spec.resultId ? spec.resultId(result) : discountId, spec.audit(result, body.data)).catch(() => {});
    return json({ data: result }, spec.status);
  } catch (error) {
    const failure = asStoreError(error);
    logUnexpected(spec.label, failure);
    // 監査の障害でも結果は不明。生の例外をログへ持ち出さない。
    if (audit) await audit(failure.status >= 500 ? 'error' : 'failure', discountId, { result_code: failure.code ?? 'DISCOUNT_FAILED' }).catch(() => {});
    return failureResponse(failure);
  }
}
