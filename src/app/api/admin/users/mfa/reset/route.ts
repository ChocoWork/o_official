/**
 * 特権の利用者（管理者・サポート担当）の2要素の登録を管理者が消す窓口（src/app/api/admin/users/mfa/reset/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-105
 * @design DD-ADMIN-005
 * @remarks 2要素の登録を消す機能は Auth の管理の機能で service role でしか呼べないので、権限と aal2 の確認を通した後にだけ使う。取り返しがつかないため、確認の語と理由の文を求め、自分自身と特権でない利用者を断る。対象の役割は古くなりうる app_metadata ではなく user_roles（DB の ACL）で決める。要素を消した後は対象の自前と Auth の session を全部失効させ、奪われた session をリセットの後に生かさない。監査には理由の文・対象のメール・誤りの文を残さず、理由は長さとハッシュだけを残す（ADR-0461）。
 */
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { logAudit } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';

const resetMfaBodySchema = z.object({
  userId: z.string().uuid().transform((value) => value.toLowerCase()),
  reason: z.string().trim().min(10).max(500),
  confirm: z.literal('RESET_MFA'),
});

const MFA_RESET_RATE_LIMIT = { endpoint: 'admin:users:mfa-reset', limit: 10, windowSeconds: 600 } as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PrivilegedRole = 'admin' | 'supporter';

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

function readRoleCode(row: unknown): string | null {
  const roles = (row as { roles?: unknown } | null)?.roles;
  const role = Array.isArray(roles) ? roles[0] : roles;
  const code = (role as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

function resolvePrivilegedRole(rows: unknown[]): PrivilegedRole | null {
  const codes = rows.map(readRoleCode);
  if (codes.includes('admin')) {
    return 'admin';
  }
  return codes.includes('supporter') ? 'supporter' : null;
}

export async function POST(request: Request) {
  try {
    const authResult = await authorizeAdminPermission('admin.users.manage', request);
    if (!authResult.ok) {
      return authResult.response;
    }

    const limited = await enforceRateLimit({ request, ...MFA_RESET_RATE_LIMIT, subject: authResult.userId });
    if (limited) {
      return limited;
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const audit = (
      outcome: 'success' | 'failure' | 'error',
      detail: string,
      resourceId: string | null,
      metadata?: Record<string, unknown>,
    ) =>
      logAudit({
        action: 'admin.users.mfa.reset',
        actor_id: authResult.userId,
        actor_email: authResult.actorEmail,
        resource: 'users',
        resource_id: resourceId,
        outcome,
        detail,
        ip: clientIp,
        user_agent: userAgent,
        ...(metadata ? { metadata } : {}),
      });

    const body = await request.json().catch(() => ({}));
    const parsed = resetMfaBodySchema.safeParse(body);

    if (!parsed.success) {
      // 確かめていない任意の長さの文字を監査に入れないよう、UUID の形の時だけ残す
      const rawUserId = typeof body?.userId === 'string' ? body.userId : null;
      const requestedUserId = rawUserId !== null && UUID_PATTERN.test(rawUserId) ? rawUserId : null;

      await audit('failure', 'Invalid request body', requestedUserId, { requested_user_id: requestedUserId });

      return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
    }

    const { userId, reason } = parsed.data;
    const reasonAudit = {
      reason_length: reason.length,
      reason_sha256: createHash('sha256').update(reason).digest('hex'),
    };

    if (userId === authResult.userId) {
      await audit('failure', 'Self-reset is not allowed', userId, { ...reasonAudit });

      return NextResponse.json({ error: 'Self-reset is not allowed' }, { status: 400 });
    }

    const service = await createServiceRoleClient();
    const { data: targetData, error: getTargetError } = await service.auth.admin.getUserById(userId);

    if (getTargetError || !targetData.user) {
      await audit('failure', 'Target user not found', userId, { ...reasonAudit });

      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { data: roleRows, error: roleError } = await service
      .from('user_roles')
      .select('roles!inner(code)')
      .eq('user_id', userId)
      .eq('active', true)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);

    if (roleError) {
      console.error('POST /api/admin/users/mfa/reset role lookup failed:', { code: (roleError as { code?: string }).code });
      await audit('error', 'role_lookup_failed', userId, { ...reasonAudit });

      return NextResponse.json({ error: 'Failed to resolve target role' }, { status: 500 });
    }

    const targetRole = resolvePrivilegedRole(Array.isArray(roleRows) ? roleRows : []);

    if (!targetRole) {
      await audit('failure', 'target_not_privileged', userId, { ...reasonAudit });

      return NextResponse.json({ error: 'MFA reset is available only for privileged users' }, { status: 400 });
    }

    const { data: listFactorsData, error: listFactorsError } = await service.auth.admin.mfa.listFactors({ userId });

    if (listFactorsError) {
      console.error('POST /api/admin/users/mfa/reset list factors failed:', listFactorsError);
      await audit('error', 'Failed to list target MFA factors', userId, { ...reasonAudit, target_role: targetRole });

      return NextResponse.json({ error: 'Failed to list target MFA factors' }, { status: 500 });
    }

    const factors = isMfaFactorList(listFactorsData?.factors) ? listFactorsData.factors : [];
    const deleteErrorFactorIds: string[] = [];

    for (const factor of factors) {
      const { error: deleteError } = await service.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
      if (deleteError) {
        console.error('POST /api/admin/users/mfa/reset delete factor failed:', deleteError);
        deleteErrorFactorIds.push(factor.id);
      }
    }

    if (deleteErrorFactorIds.length > 0) {
      await audit('error', 'Failed to delete one or more factors', userId, {
        ...reasonAudit,
        target_role: targetRole,
        total_factors: factors.length,
        delete_error_factor_ids: deleteErrorFactorIds,
      });

      return NextResponse.json({ error: 'Failed to delete one or more MFA factors' }, { status: 500 });
    }

    // 要素は既に消えている。失効が失敗しても戻さず、再実行すれば要素 0 件で失効だけをやり直せる。
    try {
      await revokeAllSessionsForUser(userId);
    } catch (revokeError) {
      console.error('POST /api/admin/users/mfa/reset session revocation failed:', revokeError);
      await audit('error', 'session_revocation_failed', userId, {
        ...reasonAudit,
        target_role: targetRole,
        deleted_factor_count: factors.length,
      });

      return NextResponse.json({ error: 'Failed to revoke target sessions' }, { status: 500 });
    }

    await audit('success', 'Admin reset user MFA factors', userId, {
      ...reasonAudit,
      target_role: targetRole,
      deleted_factor_count: factors.length,
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
