import 'server-only';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import type { PermissionCode } from '@/lib/auth/admin-rbac';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';
import { RolePermissionStoreError, setRolePermissions } from '@/lib/auth/role-permission-store';
import type { RolePermissionChange } from '@/lib/auth/role-permission-types';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { createServiceRoleClient } from '@/lib/supabase/server';

const RATE_LIMIT = { endpoint: 'admin:role-permissions:update', limit: 30, windowSeconds: 600 };
const codes = new Set<string>(ROLE_PERMISSION_CATALOG.map((permission) => permission.code));
const bodySchema = z.object({
  roleCode: z.enum(['admin', 'supporter']),
  permissionCodes: z.array(z.custom<PermissionCode>((value) => typeof value === 'string' && codes.has(value)))
    .max(30).refine((values) => new Set(values).size === values.length),
  expectedVersion: z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)
    .refine((version) => version.length < 19 || version <= '9223372036854775807'),
  requestKey: z.string().uuid(),
}).strict();
const refusals: Readonly<Record<string, { status: number; error: string }>> = {
  ROLE_PERMISSION_ARGUMENT_INVALID: { status: 400, error: '入力を確かめてください。' },
  ROLE_PERMISSION_FORBIDDEN: { status: 403, error: '権限を変更する権限がありません。' },
  ROLE_PERMISSION_FIXED: { status: 403, error: '権限管理と利用者管理は店長のみ・変更不可です。' },
  LAST_ADMIN_REQUIRED: { status: 409, error: '店長を1人以上残してください。' },
  SELF_ROLE_CHANGE_FORBIDDEN: { status: 403, error: '自分自身の役割は変更できません。' },
  ROLE_PERMISSION_VERSION_CONFLICT: { status: 409, error: 'ほかの人が権限を変更しました。現在の設定を読み直してください。' },
  ROLE_PERMISSION_REQUEST_KEY_CONFLICT: { status: 409, error: '同じ要求番号で異なる変更は保存できません。現在の設定を読み直してください。' },
};

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** actor は認可結果のみから取り、保存の前に副作用のない検証を済ませる。 */
export async function POST(request: Request): Promise<Response> {
  const authz = await authorizeAdminPermission('admin.permissions.manage', request);
  if (!authz.ok) return noStore(authz.response);
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) return noStore(csrfResult);
  const ipLimited = await enforceRateLimit({ request, ...RATE_LIMIT });
  if (ipLimited) return noStore(ipLimited);
  const actorLimited = await enforceRateLimit({ request, ...RATE_LIMIT, subject: authz.userId });
  if (actorLimited) return noStore(actorLimited);

  let change: RolePermissionChange | null = null;
  const audit = async (outcome: string, detail: string, resultCode: string, changedCount?: number): Promise<void> => {
    try {
      await logAudit({
        action: 'admin.permissions.update', actor_id: authz.userId,
        resource: 'role_permissions', resource_id: change?.roleCode ?? null, outcome, detail,
        ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        user_agent: request.headers.get('user-agent') ?? null,
        metadata: {
          ...(change ? { role_code: change.roleCode, request_key: change.requestKey } : {}),
          ...(changedCount === undefined ? {} : { changed_count: changedCount }), result_code: resultCode,
        },
      });
    } catch {
      console.error('[admin.permissions] operation failed');
    }
  };
  const refuse = async (code: string): Promise<Response> => {
    const reply = refusals[code];
    await audit(reply.status === 409 ? 'conflict' : 'failure', 'Role permissions refused', code);
    return noStore(NextResponse.json({ error: reply.error, code }, { status: reply.status }));
  };

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return refuse('ROLE_PERMISSION_ARGUMENT_INVALID');
  change = parsed.data;
  try {
    const client = await createServiceRoleClient();
    const data = await setRolePermissions(client, authz.userId, change);
    await audit('success', 'Role permissions saved', 'OK', data.changedCount);
    return noStore(NextResponse.json({ data }));
  } catch (error) {
    if (error instanceof RolePermissionStoreError && error.code && Object.prototype.hasOwnProperty.call(refusals, error.code)) {
      return refuse(error.code);
    }
    console.error('[admin.permissions] operation failed');
    await audit('error', 'Failed to save role permissions', 'PERMISSION_UPDATE_FAILED');
    return noStore(NextResponse.json({ error: '権限を保存できませんでした。', code: 'PERMISSION_UPDATE_FAILED' }, { status: 500 }));
  }
}
