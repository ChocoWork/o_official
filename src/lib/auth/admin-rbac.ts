import { NextResponse } from 'next/server';
import { createServiceRoleClient, verifyAccessToken } from '@/lib/supabase/server';

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
  | 'admin.contact.read'
  | 'admin.contact.manage'
  | 'admin.finance.read'
  | 'admin.finance.manage'
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
export const legacyPermissionMap: Record<AppRole, Set<PermissionCode>> = {
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
    'admin.contact.read',
    'admin.contact.manage',
    'admin.finance.read',
    'admin.finance.manage',
    'admin.audit.read',
  ]),
  supporter: new Set<PermissionCode>([
    'admin.orders.read',
    'admin.orders.manage',
    'admin.users.read',
    'admin.contact.read',
    'admin.contact.manage',
  ]),
  user: new Set<PermissionCode>([]),
};

function isAppRole(role: unknown): role is AppRole {
  return role === 'admin' || role === 'supporter' || role === 'user';
}

// The role is read from the already-verified access token (app_metadata).
// Avoid a second Auth Admin API round-trip: authorization is decided by the DB ACL below,
// and this value is only carried through for responses and audit logs.
function resolveTokenRole(user: { app_metadata?: unknown } | null | undefined): AppRole {
  if (!user || typeof user !== 'object') {
    return 'user';
  }

  const appMetadata = user.app_metadata;
  if (!appMetadata || typeof appMetadata !== 'object') {
    return 'user';
  }

  const rawRole = (appMetadata as Record<string, unknown>)['role'];
  return isAppRole(rawRole) ? rawRole : 'user';
}

async function isAuthSessionActive(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) {
    return false;
  }

  try {
    const service = await createServiceRoleClient();
    const { data, error } = await service.rpc('is_auth_session_active', { p_session_id: sessionId });

    if (error) {
      console.error('[RBAC.isAuthSessionActive] RPC error:', error);
      return false;
    }

    return data === true;
  } catch (err) {
    console.error('[RBAC.isAuthSessionActive] Exception:', err);
    return false;
  }
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
    const verified = await verifyAccessToken(request);

    if (!verified.ok) {
      console.warn(`[RBAC] Access token rejected: ${verified.reason}`);
      return {
        ok: false,
        response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      };
    }

    const { claims } = verified;
    const userId = claims.sub;

    const tokenRole = resolveTokenRole({ app_metadata: claims.app_metadata });

    const [aclPermissions, sessionActive] = await Promise.all([
      resolveAclPermissions(userId),
      isAuthSessionActive(claims.session_id),
    ]);

    if (!sessionActive) {
      console.warn(`[RBAC] Session revoked for ${userId}: ${claims.session_id}`);
      return {
        ok: false,
        response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      };
    }

    if (!aclPermissions.has(requiredPermission)) {
      console.warn(`[RBAC] Permission denied for ${userId}: ${requiredPermission}`);
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Forbidden', permission: requiredPermission, role: tokenRole },
          { status: 403 }
        ),
      };
    }

    // MFA はセッション単位の性質。app_metadata のフラグはユーザー単位で永続してしまうため、
    // JWT の aal クレーム（Supabase 標準）で判定する。
    if (claims.aal !== 'aal2') {
      console.warn(`[RBAC] MFA required for ${userId}: ${requiredPermission}`);
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'Forbidden', reason: 'MFA required', permission: requiredPermission, role: tokenRole },
          { status: 403 }
        ),
      };
    }

    return {
      ok: true,
      userId,
      role: tokenRole,
      actorEmail: claims.email ?? null,
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
