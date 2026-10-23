import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AppRole, PermissionCode } from '@/lib/auth/admin-rbac';
import { ROLE_PERMISSION_CATALOG } from '@/lib/auth/role-permission-catalog';
import type { PermissionRoleState, PermissionsMatrix, RolePermissionChange, RolePermissionChangeResult } from '@/lib/auth/role-permission-types';

const refusalSqlstates: Readonly<Record<string, string>> = {
  ROLE_PERMISSION_ARGUMENT_INVALID: '22023',
  ROLE_PERMISSION_FORBIDDEN: '42501',
  ROLE_PERMISSION_FIXED: '42501',
  ROLE_PERMISSION_VERSION_CONFLICT: 'P0001',
  ROLE_PERMISSION_REQUEST_KEY_CONFLICT: 'P0001',
  LAST_ADMIN_REQUIRED: 'P0001',
  SELF_ROLE_CHANGE_FORBIDDEN: '42501',
  USER_NOT_FOUND: 'P0002',
};
const managedCodes = new Set<string>(ROLE_PERMISSION_CATALOG.map((permission) => permission.code));
const permissionSchema = z.custom<PermissionCode>((value) => typeof value === 'string' && managedCodes.has(value));
const codesSchema = z.array(permissionSchema).max(30).refine((codes) => new Set(codes).size === codes.length);
const versionSchema = z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)
  .refine((version) => version.length < 19 || version <= '9223372036854775807');
const roleSchema = z.object({
  code: z.enum(['admin', 'supporter']),
  version: versionSchema,
  permissionCodes: codesSchema,
});
const matrixSchema = z.object({
  permissionCodes: codesSchema.refine((codes) => codes.length === managedCodes.size),
  roles: z.array(roleSchema).length(2).refine((roles) => new Set(roles.map((role) => role.code)).size === 2),
});
const changeResultSchema = z.object({ role: roleSchema, changedCount: z.number().int().min(0).max(30) });
const userRoleResultSchema = z.object({ previousRole: z.string(), role: z.enum(['admin', 'supporter', 'user']) });

export class RolePermissionStoreError extends Error {
  readonly code: string | null;

  constructor(code: string | null = null) {
    super('Role permission operation failed');
    this.name = 'RolePermissionStoreError';
    this.code = code;
  }
}

function refusalCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { message, code } = error as { message?: unknown; code?: unknown };
  return typeof message === 'string' && typeof code === 'string'
    && Object.prototype.hasOwnProperty.call(refusalSqlstates, message)
    && refusalSqlstates[message] === code ? message : null;
}

// PostgREST の詳細・hint・通信例外を呼出元に持ち出さない。
async function callRpc(client: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  let result;
  try {
    result = await client.rpc(name, args);
  } catch {
    throw new RolePermissionStoreError();
  }
  if (result.error) throw new RolePermissionStoreError(refusalCode(result.error));
  return result.data;
}

function toRoleState(role: z.infer<typeof roleSchema>): PermissionRoleState {
  return { code: role.code, label: role.code === 'admin' ? '店長' : 'サポーター', version: role.version, permissionCodes: [...role.permissionCodes] };
}

/** 一つのRPCスナップショットを検証し、表示ラベルだけを補う。 */
export async function getPermissionsMatrix(client: SupabaseClient, actorId: string): Promise<PermissionsMatrix> {
  const parsed = matrixSchema.safeParse(await callRpc(client, 'admin_get_permissions', { _actor_id: actorId }));
  if (!parsed.success) throw new RolePermissionStoreError();
  return {
    permissions: ROLE_PERMISSION_CATALOG.map((permission) => ({ ...permission, requires: [...permission.requires] })),
    roles: [...parsed.data.roles].sort((a, b) => a.code === b.code ? 0 : a.code === 'admin' ? -1 : 1).map(toRoleState),
  };
}

/** 版と要求キーは文字列のまま渡し、bigint の精度を保つ。 */
export async function setRolePermissions(client: SupabaseClient, actorId: string, change: RolePermissionChange): Promise<RolePermissionChangeResult> {
  const parsed = changeResultSchema.safeParse(await callRpc(client, 'admin_set_role_permissions', {
    _actor_id: actorId,
    _role_code: change.roleCode,
    _permission_codes: change.permissionCodes,
    _expected_version: change.expectedVersion,
    _request_key: change.requestKey,
  }));
  if (!parsed.success || parsed.data.role.code !== change.roleCode) throw new RolePermissionStoreError();
  return { role: toRoleState(parsed.data.role), changedCount: parsed.data.changedCount };
}

/** ACL と Auth metadata はDBの一つの取引で更新する。 */
export async function setUserRole(client: SupabaseClient, actorId: string, userId: string, role: AppRole): Promise<{ previousRole: string; role: AppRole }> {
  const parsed = userRoleResultSchema.safeParse(await callRpc(client, 'admin_set_user_role', {
    _actor_id: actorId, _user_id: userId, _role_code: role,
  }));
  if (!parsed.success || parsed.data.role !== role) throw new RolePermissionStoreError();
  return parsed.data;
}
