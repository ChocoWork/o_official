import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { getClientIp } from '@/lib/request-ip';
import { RolePermissionStoreError, setUserRole } from '@/lib/auth/role-permission-store';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { issueAndSendStaffInvite } from '@/features/auth/staff/staff-invite-send';
import { auditStaffAction, staffInviteReasonResponse } from '@/features/auth/staff/staff-invite-http';
import { demoteStaff, hasOpenStaffInvite } from '@/features/auth/staff/staff-invite-store';

const roleSchema = z.enum(['admin', 'supporter', 'user']);

const patchBodySchema = z.object({
  userId: z.string().uuid(),
  role: roleSchema,
});

function toDisplayRole(role: string | undefined): 'Admin' | 'Support' | 'User' {
  if (role === 'admin') {
    return 'Admin';
  }

  if (role === 'supporter') {
    return 'Support';
  }

  return 'User';
}

function extractRoleCode(roles: unknown): string | undefined {
  const roleRecord = Array.isArray(roles) ? roles[0] : roles;

  if (!roleRecord || typeof roleRecord !== 'object') {
    return undefined;
  }

  const roleCode = 'code' in roleRecord ? (roleRecord as { code?: unknown }).code : undefined;
  return typeof roleCode === 'string' ? roleCode : undefined;
}

function toJstDateTime(dateText: string | null): string {
  if (!dateText) {
    return '-';
  }

  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export async function GET(request: Request) {
  try {
    const authResult = await authorizeAdminPermission('admin.users.read', request);
    if (!authResult.ok) {
      return authResult.response;
    }

    const supabase = await createServiceRoleClient();

    const { data: authData, error: listError } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });

    if (listError) {
      console.error('Failed to list auth users:', listError);
      return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
    }

    const authUsers = authData.users;
    const userIds = authUsers.map((user) => user.id);

    const profileNameMap = new Map<string, string>();
    const aclRoleMap = new Map<string, string>();

    if (userIds.length > 0) {
      const { data: profileRows, error: profileError } = await supabase
        .from('profiles')
        .select('user_id, optional_name, display_name')
        .in('user_id', userIds);

      if (profileError) {
        const errorCode = 'code' in profileError ? profileError.code : undefined;
        if (errorCode === '42703') {
          const { data: fallbackRows, error: fallbackError } = await supabase
            .from('profiles')
            .select('user_id, display_name')
            .in('user_id', userIds);

          if (fallbackError) {
            console.error('Failed to fetch profiles for users (fallback):', fallbackError);
            return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
          }

          for (const row of fallbackRows ?? []) {
            const name = (row.display_name ?? '').trim();
            if (name) {
              profileNameMap.set(row.user_id, name);
            }
          }
        } else {
          console.error('Failed to fetch profiles for users:', profileError);
          return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
        }
      } else {
        for (const row of profileRows ?? []) {
          const name = (row.optional_name ?? row.display_name ?? '').trim();
          if (name) {
            profileNameMap.set(row.user_id, name);
          }
        }
      }

      const { data: aclRows, error: aclError } = await supabase
        .from('user_roles')
        .select('user_id, assigned_at, expires_at, roles!inner(code)')
        .in('user_id', userIds)
        .eq('active', true)
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
        .order('assigned_at', { ascending: false });

      if (aclError) {
        console.error('Failed to fetch ACL roles for users:', aclError);
        return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 });
      }

      for (const row of aclRows ?? []) {
        if (aclRoleMap.has(row.user_id)) {
          continue;
        }

        const roleCode = extractRoleCode(row.roles);

        if (typeof roleCode === 'string') {
          aclRoleMap.set(row.user_id, roleCode);
        }
      }
    }

    // 認めたパスキーの本数（店員だけ）と、開いている招待（店員でない人だけ）。店員の判定は上の役割と同じ。
    const approvedPasskeyMap = new Map<string, number>();
    const invitePendingSet = new Set<string>();
    const staffIds = authUsers.filter((user) => ['admin', 'supporter'].includes(aclRoleMap.get(user.id) ?? '')).map((user) => user.id);
    const nonStaffIds = authUsers.map((user) => user.id).filter((id) => !staffIds.includes(id));
    for (let index = 0; index < staffIds.length; index += 20) {
      await Promise.all(staffIds.slice(index, index + 20).map(async (id) => {
        const { data: count, error: countError } = await supabase.rpc('passkey_approved_count', { p_user_id: id });
        approvedPasskeyMap.set(id, !countError && typeof count === 'number' && Number.isInteger(count) ? count : 0);
      }));
    }
    for (let index = 0; index < nonStaffIds.length; index += 20) {
      await Promise.all(nonStaffIds.slice(index, index + 20).map(async (id) => {
        if (await hasOpenStaffInvite(supabase, id)) invitePendingSet.add(id);
      }));
    }

    const data = authUsers.map((user) => {
      const metadataName =
        typeof user.user_metadata?.display_name === 'string' ? user.user_metadata.display_name : '';
      const fallbackName = user.email ?? user.id;
      const tokenRole = typeof user.app_metadata?.role === 'string' ? user.app_metadata.role : undefined;
      const roleRaw = aclRoleMap.get(user.id) ?? tokenRole;

      return {
        id: user.id,
        name: profileNameMap.get(user.id) ?? metadataName ?? fallbackName,
        email: user.email ?? '-',
        role: toDisplayRole(roleRaw),
        roleValue: roleSchema.safeParse(roleRaw).success ? roleRaw : 'user',
        lastLogin: toJstDateTime(user.last_sign_in_at ?? null),
        status: user.last_sign_in_at ? 'アクティブ' : '非アクティブ',
        approvedPasskeys: approvedPasskeyMap.get(user.id) ?? 0,
        invitePending: invitePendingSet.has(user.id),
      };
    });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/users error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const noStore = (response: Response): Response => {
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  try {
    const authz = await authorizeAdminPermission('admin.users.manage', request);
    if (!authz.ok) return noStore(authz.response);
    const csrfResult = await requireCsrfOrDeny();
    if (csrfResult instanceof Response) return noStore(csrfResult);
    const rateLimit = { endpoint: 'admin:users:role-update', limit: 30, windowSeconds: 600 };
    const ipLimited = await enforceRateLimit({ request, ...rateLimit });
    if (ipLimited) return noStore(ipLimited);
    const actorLimited = await enforceRateLimit({ request, ...rateLimit, subject: authz.userId });
    if (actorLimited) return noStore(actorLimited);

    let targetUserId: string | null = null;
    const audit = async (outcome: string, detail: string, metadata: Record<string, unknown>): Promise<void> => {
      try {
        await logAudit({
          action: 'admin.users.role.update', actor_id: authz.userId,
          resource: 'users', resource_id: targetUserId, outcome, detail,
          ip: getClientIp(request),
          user_agent: request.headers.get('user-agent') ?? null,
          metadata,
        });
      } catch {
        console.error('[admin.permissions] operation failed');
      }
    };
    const parsed = patchBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      await audit('failure', 'Invalid request body', {});
      return noStore(NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 }));
    }

    const { userId, role } = parsed.data;
    targetUserId = userId;
    try {
      const client = await createServiceRoleClient();
      const actor = { actorId: authz.userId, actorEmail: authz.actorEmail ?? null };
      if (role === 'user') {
        // 降格は招待も取り消す staff_demote で行う（admin_set_user_role の user への変更は使わない）。
        const demoted = await demoteStaff(client, authz.userId, userId);
        if (!demoted.ok) {
          const refused: Record<string, { status: number; error: string; code?: string }> = {
            last_admin: { status: 409, error: '店長を1人以上残してください。', code: 'LAST_ADMIN_REQUIRED' },
            self: { status: 403, error: '自分自身の役割は変更できません。', code: 'SELF_ROLE_CHANGE_FORBIDDEN' },
            forbidden: { status: 403, error: 'Forbidden' },
            not_found: { status: 404, error: 'User not found' },
          };
          const mapped = refused[demoted.reason];
          await auditStaffAction(request, actor, {
            action: 'admin.staff.demote', resourceId: userId, outcome: demoted.reason === 'last_admin' ? 'conflict' : 'failure',
            detail: 'Staff demote refused', metadata: { requested_role: role, result_code: demoted.reason },
          });
          if (!mapped) return noStore(NextResponse.json({ error: 'Internal server error' }, { status: 500 }));
          return noStore(NextResponse.json(mapped.code ? { error: mapped.error, code: mapped.code } : { error: mapped.error }, { status: mapped.status }));
        }
        try {
          await revokeAllSessionsForUser(userId);
        } catch {
          console.error('[admin.permissions] operation failed');
          await auditStaffAction(request, actor, { action: 'admin.staff.demote', resourceId: userId, outcome: 'error', detail: 'session_revocation_failed' });
          return noStore(staffInviteReasonResponse('revoke_failed'));
        }
        await auditStaffAction(request, actor, {
          action: 'admin.staff.demote', resourceId: userId, outcome: 'success', detail: 'Staff demoted',
          metadata: { requested_role: role, assigned_by: authz.userId },
        });
        return noStore(NextResponse.json({ success: true }, { status: 200 }));
      }
      // DB が最後の店長・自己変更を判定し、ACL と metadata を同時に保存する。
      // 今の店員でない人（お客さん・期限切れ・無効だった人）は DB が STAFF_INVITE_REQUIRED で断り、招待の道に落とす。
      let result: Awaited<ReturnType<typeof setUserRole>>;
      try {
        result = await setUserRole(client, authz.userId, userId, role);
      } catch (error) {
        if (!(error instanceof RolePermissionStoreError) || error.code !== 'STAFF_INVITE_REQUIRED') throw error;
        const { data: target, error: targetError } = await client.auth.admin.getUserById(userId);
        const email = target?.user?.email;
        if (targetError || !email) {
          await auditStaffAction(request, actor, { action: 'admin.staff.promote', resourceId: userId, outcome: 'failure', detail: 'Target user not found' });
          return noStore(staffInviteReasonResponse('not_found'));
        }
        const invited = await issueAndSendStaffInvite(client, {
          userId, email, role, kind: 'promote', issuedBy: authz.userId, reason: null, hadPasskeys: true,
        });
        if (!invited.ok) {
          await auditStaffAction(request, actor, {
            action: 'admin.staff.promote', resourceId: userId, outcome: invited.reason === 'last_admin' ? 'conflict' : 'failure',
            detail: 'Staff promote invite refused', metadata: { requested_role: role, result_code: invited.reason },
          });
          return noStore(staffInviteReasonResponse(invited.reason));
        }
        await auditStaffAction(request, actor, {
          action: 'admin.staff.promote', resourceId: userId, outcome: 'success', detail: 'Staff promote invite sent',
          metadata: { requested_role: role, assigned_by: authz.userId },
        });
        return noStore(NextResponse.json({ success: true, invited: true }, { status: 200 }));
      }
      await audit('success', 'User role updated', {
        previous_role: result.previousRole, requested_role: role, assigned_by: authz.userId,
      });
      return noStore(NextResponse.json({ success: true }, { status: 200 }));
    } catch (error) {
      const code = error instanceof RolePermissionStoreError ? error.code : null;
      if (code === 'LAST_ADMIN_REQUIRED' || code === 'SELF_ROLE_CHANGE_FORBIDDEN') {
        const status = code === 'LAST_ADMIN_REQUIRED' ? 409 : 403;
        await audit(status === 409 ? 'conflict' : 'failure', 'User role change refused', {
          requested_role: role, result_code: code,
        });
        return noStore(NextResponse.json({
          error: code === 'LAST_ADMIN_REQUIRED' ? '店長を1人以上残してください。' : '自分自身の役割は変更できません。', code,
        }, { status }));
      }
      if (code === 'USER_NOT_FOUND') {
        await audit('failure', 'User not found', { requested_role: role, requested_user_id: userId });
        return noStore(NextResponse.json({ error: 'User not found' }, { status: 404 }));
      }
      if (code === 'ROLE_PERMISSION_FORBIDDEN' || code === 'ROLE_PERMISSION_ARGUMENT_INVALID') {
        await audit('failure', 'User role change refused', { requested_role: role, result_code: code });
        return noStore(NextResponse.json({ error: code === 'ROLE_PERMISSION_FORBIDDEN' ? 'Forbidden' : 'Invalid request' }, {
          status: code === 'ROLE_PERMISSION_FORBIDDEN' ? 403 : 400,
        }));
      }
      console.error('[admin.permissions] operation failed');
      await audit('error', 'Failed to update user role', { requested_role: role });
      return noStore(NextResponse.json({ error: 'Internal server error' }, { status: 500 }));
    }
  } catch {
    console.error('[admin.permissions] operation failed');
    return noStore(NextResponse.json({ error: 'Internal server error' }, { status: 500 }));
  }
}
