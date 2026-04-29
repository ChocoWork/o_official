import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient, extractBearerToken } from '@/lib/supabase/server';

export type AppRole = 'admin' | 'supporter' | 'user';
export type PermissionCode =
  | 'admin.users.read'
  | 'admin.users.manage'
  | 'admin.items.read'
  | 'admin.items.manage'
  | 'admin.news.read'
  | 'admin.news.manage'
  | 'admin.looks.read'
  | 'admin.looks.manage'
  | 'admin.stockists.read'
  | 'admin.stockists.manage'
  | 'admin.orders.read'
  | 'admin.orders.manage'
  | 'admin.audit.read';

type AuthzSuccess = {
  ok: true;
  userId: string;
  role: AppRole;
  actorEmail: string | null;
};

type AuthzFailure = {
  ok: false;
  response: NextResponse;
};

export type AuthzResult = AuthzSuccess | AuthzFailure;

// Legacy role-to-permission map is preserved for UI/consistency checks only.
// Authorization decisions are made from DB ACL permissions, not from app_metadata.role.
const legacyPermissionMap: Record<AppRole, Set<PermissionCode>> = {
  admin: new Set<PermissionCode>([
    'admin.users.read',
    'admin.users.manage',
    'admin.items.read',
    'admin.items.manage',
    'admin.news.read',
    'admin.news.manage',
    'admin.looks.read',
    'admin.looks.manage',
    'admin.stockists.read',
    'admin.stockists.manage',
    'admin.orders.read',
    'admin.orders.manage',
    'admin.audit.read',
  ]),
  supporter: new Set<PermissionCode>(['admin.orders.read', 'admin.orders.manage', 'admin.users.read']),
  user: new Set<PermissionCode>([]),
};

function isAppRole(role: unknown): role is AppRole {
  return role === 'admin' || role === 'supporter' || role === 'user';
}

async function resolveTokenRole(userId: string): Promise<AppRole> {
  try {
    const service = await createServiceRoleClient();
    const { data, error } = await service.auth.admin.getUserById(userId);

    if (error || !data.user) {
      console.error('[RBAC.resolveTokenRole] Error fetching user:', error);
      return 'user';
    }

    const rawRole = data.user.app_metadata?.role;
    const role = isAppRole(rawRole) ? rawRole : 'user';
    console.log(`[RBAC.resolveTokenRole] User ${userId} -> role: ${role} (raw: ${rawRole})`);
    return role;
  } catch (err) {
    console.error('[RBAC.resolveTokenRole] Exception:', err);
    return 'user';
  }
}

function isMfaVerified(user: { app_metadata?: unknown } | null | undefined): boolean {
  if (!user || typeof user !== 'object') {
    return false;
  }

  const appMetadata = user.app_metadata;
  if (!appMetadata || typeof appMetadata !== 'object') {
    return false;
  }

  const metadata = appMetadata as Record<string, unknown>;
  return metadata['admin_mfa_verified'] === true || metadata['mfa_verified'] === true;
}

async function resolveAclPermissions(userId: string): Promise<Set<PermissionCode>> {
  try {
    const service = await createServiceRoleClient();

    const { data, error } = await service
      .from('user_roles')
      .select('roles!inner(role_permissions!inner(permissions!inner(code)))')
      .eq('user_id', userId)
      .eq('active', true)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

    if (error) {
      console.error('[RBAC.resolveAclPermissions] Query error:', error);
      return new Set<PermissionCode>();
    }

    if (!data) {
      console.warn('[RBAC.resolveAclPermissions] No user_roles found for user:', userId);
      return new Set<PermissionCode>();
    }

    const result = new Set<PermissionCode>();

    for (const row of data as unknown[]) {
      const roleObj = (row as { roles?: unknown }).roles;
      if (!roleObj || typeof roleObj !== 'object') {
        continue;
      }

      const rolePermissions = (roleObj as { role_permissions?: unknown }).role_permissions;
      if (!Array.isArray(rolePermissions)) {
        continue;
      }

      for (const rp of rolePermissions) {
        const permissionsObj = (rp as { permissions?: unknown }).permissions;
        const code =
          permissionsObj && typeof permissionsObj === 'object'
            ? (permissionsObj as { code?: unknown }).code
            : undefined;

        if (typeof code === 'string') {
          result.add(code as PermissionCode);
        }
      }
    }

    console.log(`[RBAC.resolveAclPermissions] User ${userId} -> permissions: ${Array.from(result).join(', ')}`);
    return result;
  } catch (err) {
    console.error('[RBAC.resolveAclPermissions] Exception:', err);
    return new Set<PermissionCode>();
  }
}

export async function authorizeAdminPermission(requiredPermission: PermissionCode, request?: Request): Promise<AuthzResult> {
  try {
    const client = await createClient(request);
    const bearerToken = extractBearerToken(request);
    const {
      data: { user },
      error,
    } = bearerToken ? await client.auth.getUser(bearerToken) : await client.auth.getUser();

    if (error || !user) {
      console.error('[RBAC] User not found:', error);
      return {
        ok: false,
        response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      };
    }

    console.log(`[RBAC] Authorizing ${user.id} for ${requiredPermission}`);

    const tokenRole = await resolveTokenRole(user.id);
    console.log(`[RBAC] Token role: ${tokenRole}`);

    const aclPermissions = await resolveAclPermissions(user.id);
    console.log(`[RBAC] ACL permissions: ${Array.from(aclPermissions).join(', ')}`);

    const hasAclPermission = aclPermissions.has(requiredPermission);
    console.log(`[RBAC] ACL check: ${hasAclPermission}`);

    if (!hasAclPermission) {
      console.warn(`[RBAC] Permission denied for ${user.id}: ${requiredPermission}`);
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Forbidden', permission: requiredPermission, role: tokenRole },
          { status: 403 }
        ),
      };
    }

    if (!isMfaVerified(user)) {
      console.warn(`[RBAC] MFA required for ${user.id}: ${requiredPermission}`);
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Forbidden', reason: 'MFA required', permission: requiredPermission, role: tokenRole },
          { status: 403 }
        ),
      };
    }

    console.log(`[RBAC] Permission granted for ${user.id}: ${requiredPermission}`);
    return {
      ok: true,
      userId: user.id,
      role: tokenRole,
      actorEmail: user.email ?? null,
    };
  } catch (err) {
    console.error('[RBAC] Authorization error:', err);
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Internal server error', details: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      ),
    };
  }
}
