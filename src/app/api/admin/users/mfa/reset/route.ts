import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { resetPrivilegedMfaVerification } from '@/features/auth/services/mfa-metadata';

const resetMfaBodySchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
  confirm: z.literal('RESET_MFA'),
});

type AppRole = 'admin' | 'supporter' | 'user';

function resolveRoleFromAppMetadata(appMetadata: unknown): AppRole {
  if (!appMetadata || typeof appMetadata !== 'object') {
    return 'user';
  }

  const role = (appMetadata as Record<string, unknown>).role;
  return role === 'admin' || role === 'supporter' || role === 'user' ? role : 'user';
}

function isMfaFactorList(value: unknown): value is Array<{ id: string; factor_type?: string; status?: string; friendly_name?: string | null }> {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.every((factor) => {
    if (!factor || typeof factor !== 'object') {
      return false;
    }

    const id = (factor as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0;
  });
}

export async function POST(request: Request) {
  try {
    const authResult = await authorizeAdminPermission('admin.users.manage', request);
    if (!authResult.ok) {
      return authResult.response;
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const body = await request.json().catch(() => ({}));
    const parsed = resetMfaBodySchema.safeParse(body);
    const requestedUserId = typeof body?.userId === 'string' ? body.userId : null;

    if (!parsed.success) {
      await logAudit({
        action: 'admin.users.mfa.reset',
        actor_id: authResult.userId,
        actor_email: authResult.actorEmail,
        resource: 'users',
        resource_id: requestedUserId,
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          requested_user_id: requestedUserId,
        },
      });

      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const { userId, reason } = parsed.data;

    if (userId === authResult.userId) {
      await logAudit({
        action: 'admin.users.mfa.reset',
        actor_id: authResult.userId,
        actor_email: authResult.actorEmail,
        resource: 'users',
        resource_id: userId,
        outcome: 'failure',
        detail: 'Self-reset is not allowed',
        ip: clientIp,
        user_agent: userAgent,
      });

      return NextResponse.json({ error: 'Self-reset is not allowed' }, { status: 400 });
    }

    const service = await createServiceRoleClient();
    const { data: targetData, error: getTargetError } = await service.auth.admin.getUserById(userId);

    if (getTargetError || !targetData.user) {
      await logAudit({
        action: 'admin.users.mfa.reset',
        actor_id: authResult.userId,
        actor_email: authResult.actorEmail,
        resource: 'users',
        resource_id: userId,
        outcome: 'failure',
        detail: 'Target user not found',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          reason,
        },
      });

      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const targetUser = targetData.user;
    const targetRole = resolveRoleFromAppMetadata(targetUser.app_metadata);

    if (targetRole !== 'admin' && targetRole !== 'supporter') {
      await logAudit({
        action: 'admin.users.mfa.reset',
        actor_id: authResult.userId,
        actor_email: authResult.actorEmail,
        resource: 'users',
        resource_id: userId,
        outcome: 'failure',
        detail: 'Target user is not privileged',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          reason,
          target_role: targetRole,
        },
      });

      return NextResponse.json({ error: 'MFA reset is available only for privileged users' }, { status: 400 });
    }

    const { data: listFactorsData, error: listFactorsError } = await service.auth.admin.mfa.listFactors({ userId });

    if (listFactorsError) {
      await logAudit({
        action: 'admin.users.mfa.reset',
        actor_id: authResult.userId,
        actor_email: authResult.actorEmail,
        resource: 'users',
        resource_id: userId,
        outcome: 'error',
        detail: 'Failed to list target MFA factors',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          reason,
          error_message: listFactorsError.message,
        },
      });

      return NextResponse.json({ error: 'Failed to list target MFA factors' }, { status: 500 });
    }

    const factors = isMfaFactorList(listFactorsData?.factors) ? listFactorsData.factors : [];
    const deleteErrors: Array<{ factorId: string; message: string }> = [];

    for (const factor of factors) {
      const { error: deleteError } = await service.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
      if (deleteError) {
        deleteErrors.push({ factorId: factor.id, message: deleteError.message ?? 'failed_to_delete_factor' });
      }
    }

    if (deleteErrors.length > 0) {
      await logAudit({
        action: 'admin.users.mfa.reset',
        actor_id: authResult.userId,
        actor_email: authResult.actorEmail,
        resource: 'users',
        resource_id: userId,
        outcome: 'error',
        detail: 'Failed to delete one or more factors',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          reason,
          total_factors: factors.length,
          delete_errors: deleteErrors,
        },
      });

      return NextResponse.json({ error: 'Failed to delete one or more MFA factors' }, { status: 500 });
    }

    const resetResult = await resetPrivilegedMfaVerification(service, {
      id: targetUser.id,
      app_metadata: targetUser.app_metadata,
    });

    if (!resetResult.ok) {
      await logAudit({
        action: 'admin.users.mfa.reset',
        actor_id: authResult.userId,
        actor_email: authResult.actorEmail,
        resource: 'users',
        resource_id: userId,
        outcome: 'error',
        detail: 'Failed to reset MFA verification metadata',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          reason,
          total_factors: factors.length,
          metadata_error: resetResult.error,
        },
      });

      return NextResponse.json({ error: 'Failed to reset MFA metadata' }, { status: 500 });
    }

    await logAudit({
      action: 'admin.users.mfa.reset',
      actor_id: authResult.userId,
      actor_email: authResult.actorEmail,
      resource: 'users',
      resource_id: userId,
      outcome: 'success',
      detail: 'Admin reset user MFA factors',
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        reason,
        target_role: targetRole,
        target_email: targetUser.email ?? null,
        deleted_factor_count: factors.length,
      },
    });

    return NextResponse.json(
      {
        success: true,
        deletedFactorCount: factors.length,
        message: 'MFA factors were reset. The user must sign in again and enroll MFA.',
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('POST /api/admin/users/mfa/reset error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}