import { NextResponse } from 'next/server';
import { checkAuthSessionLiveness, createServiceRoleClient, verifyAccessToken } from '@/lib/supabase/server';

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

    return result;
  } catch (err) {
    console.error('[RBAC.resolveAclPermissions] Exception:', err);
    return new Set<PermissionCode>();
  }
}

export async function authorizeAdminPermission(requiredPermission: PermissionCode, request?: Request): Promise<AuthzResult> {
  try {
    // ここだけ authenticateRequest を使わず内訳を展開している。
    // verifyAccessToken は JWKS によるローカル検証で往復が無いため、claims を得た後の
    // 「セッション失効の確認」と「ACL の照会」は互いに独立で同時に投げられる。
    // authenticateRequest 経由だと失効確認を待ってから ACL を引くことになり、
    // 管理 API 1 リクエストあたり往復が 1 回増える。
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

    const [liveness, aclPermissions] = await Promise.all([
      checkAuthSessionLiveness(claims.session_id),
      resolveAclPermissions(userId),
    ]);

    if (liveness !== 'active') {
      console.warn(`[RBAC] Session not active for ${userId}: ${liveness}`);

      // 「失効しているか確認できなかった」を 401 で返すと、クライアントは
      // 「トークンが古い」と解釈してセッション更新を撃つ。DB 障害の最中に
      // refresh が殺到して障害を増幅するので、503 として区別する。
      // アクセスを拒否する点は 401 と変わらないので fail-closed は保たれる。
      if (liveness === 'unavailable') {
        return {
          ok: false,
          response: NextResponse.json(
            { error: 'Service temporarily unavailable' },
            { status: 503, headers: { 'Retry-After': '30' } },
          ),
        };
      }

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
      // 内部エラー文字列は外部に出さない（情報露出）。詳細は上の console.error に残る。
      response: NextResponse.json({ error: 'Internal server error' }, { status: 500 }),
    };
  }
}
