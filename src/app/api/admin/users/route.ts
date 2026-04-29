import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';

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
      };
    });

    return NextResponse.json({ data }, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/users error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const authResult = await authorizeAdminPermission('admin.users.manage', request);
    if (!authResult.ok) {
      return authResult.response;
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const body = await request.json().catch(() => ({}));
    const parsed = patchBodySchema.safeParse(body);
    const requestedRole = typeof body?.role === 'string' ? body.role : null;
    const requestedUserId = typeof body?.userId === 'string' ? body.userId : null;

    if (!parsed.success) {
      await logAudit({
        action: 'admin.users.role.update',
        actor_id: authResult.userId,
        resource: 'users',
        resource_id: requestedUserId ?? null,
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          requested_role: requestedRole,
          requested_user_id: requestedUserId,
        },
      });

      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const { userId, role } = parsed.data;
    const supabase = await createServiceRoleClient();

    const { data: userData, error: getUserError } = await supabase.auth.admin.getUserById(userId);
    if (getUserError || !userData.user) {
      console.error('Failed to get user by id:', getUserError);
      await logAudit({
        action: 'admin.users.role.update',
        actor_id: authResult.userId,
        resource: 'users',
        resource_id: userId,
        outcome: 'failure',
        detail: 'User not found',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          requested_role: role,
          requested_user_id: userId,
        },
      });
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const currentAppMetadata = userData.user.app_metadata ?? {};
    const previousRole = typeof currentAppMetadata.role === 'string' ? currentAppMetadata.role : 'unknown';

    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...currentAppMetadata,
        role,
      },
    });

    if (updateError) {
      console.error('Failed to update user role:', updateError);
      await logAudit({
        action: 'admin.users.role.update',
        actor_id: authResult.userId,
        resource: 'users',
        resource_id: userId,
        outcome: 'error',
        detail: 'Failed to update auth metadata',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          previous_role: previousRole,
          requested_role: role,
        },
      });
      return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
    }

    const { data: roleRow, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('code', role)
      .single();

    if (roleError || !roleRow) {
      console.error('Failed to resolve role id:', roleError);
      await logAudit({
        action: 'admin.users.role.update',
        actor_id: authResult.userId,
        resource: 'users',
        resource_id: userId,
        outcome: 'error',
        detail: 'Failed to resolve role id',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          previous_role: previousRole,
          requested_role: role,
        },
      });
      return NextResponse.json({ error: 'Failed to update ACL role' }, { status: 500 });
    }

    const { error: deactivateError } = await supabase
      .from('user_roles')
      .update({ active: false })
      .eq('user_id', userId)
      .eq('active', true);

    if (deactivateError) {
      console.error('Failed to deactivate existing ACL roles:', deactivateError);
      await logAudit({
        action: 'admin.users.role.update',
        actor_id: authResult.userId,
        resource: 'users',
        resource_id: userId,
        outcome: 'error',
        detail: 'Failed to deactivate existing ACL roles',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          previous_role: previousRole,
          requested_role: role,
        },
      });
      return NextResponse.json({ error: 'Failed to update ACL role' }, { status: 500 });
    }

    const { error: upsertAclError } = await supabase
      .from('user_roles')
      .upsert(
        {
          user_id: userId,
          role_id: roleRow.id,
          active: true,
          assigned_by: authResult.userId,
          assigned_at: new Date().toISOString(),
          expires_at: null,
        },
        { onConflict: 'user_id,role_id' },
      );

    if (upsertAclError) {
      console.error('Failed to upsert ACL role:', upsertAclError);
      await logAudit({
        action: 'admin.users.role.update',
        actor_id: authResult.userId,
        resource: 'users',
        resource_id: userId,
        outcome: 'error',
        detail: 'Failed to write ACL role',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          previous_role: previousRole,
          requested_role: role,
        },
      });
      return NextResponse.json({ error: 'Failed to update ACL role' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.users.role.update',
      actor_id: authResult.userId,
      resource: 'users',
      resource_id: userId,
      outcome: 'success',
      detail: 'User role updated',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        previous_role: previousRole,
        requested_role: role,
        assigned_by: authResult.userId,
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/admin/users error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
