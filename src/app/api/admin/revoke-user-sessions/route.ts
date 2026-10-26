/**
 * 管理者が利用者のセッションを強制的に失効させる窓口（src/app/api/admin/revoke-user-sessions/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-103
 * @design DD-ADMIN-003
 * @remarks 自前の sessions 表だけを直しても Auth 側のセッションと発行済みのアクセストークンが生き残るので、両方を失効する部品（revokeAllSessionsForUser）を使う。人のセッションを切る操作は悪用もできるため、権限の無い試みも監査に残すが、無限に増えないよう全体で10分に20行までとし、超えたらまとめの1行にする（ADR-0460）。回数の枠は管理者単位で、検証済みの管理者 ID だけで数える。自分自身と存在しない利用者は断る。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { incrementCounter } from '@/features/auth/ratelimit';

const bodySchema = z.object({ user_id: z.string().uuid().transform((value) => value.toLowerCase()) });

const REVOKE_RATE_LIMIT = { endpoint: 'admin:users:revoke-sessions', limit: 20, windowSeconds: 600 } as const;

const UNAUTHORIZED_AUDIT_ENDPOINT = 'admin_revoke_unauthorized_audit';
const UNAUTHORIZED_AUDIT_LIMIT = 20;
const UNAUTHORIZED_AUDIT_WINDOW_SECONDS = 600;

/**
 * 認可に失敗した要求の監査を、全体で10分に20行まで書く。21回目はまとめの1行、それ以降は書かない。
 * 数えるのに失敗した時は書かない（監査の補助なので fail-open。窓口の応答は変えない）。
 */
async function auditUnauthorized(clientIp: string | null, userAgent: string | null): Promise<void> {
  try {
    const windowMs = UNAUTHORIZED_AUDIT_WINDOW_SECONDS * 1000;
    const bucket = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
    const count = await incrementCounter({ endpoint: UNAUTHORIZED_AUDIT_ENDPOINT, bucket, subject: 'all' });

    if (count > UNAUTHORIZED_AUDIT_LIMIT + 1) {
      return;
    }

    const base = {
      action: 'admin_revoke_user_sessions',
      actor_id: null,
      actor_email: null,
      resource: 'sessions',
      ip: clientIp,
      user_agent: userAgent,
    };
    if (count === UNAUTHORIZED_AUDIT_LIMIT + 1) {
      await logAudit({
        ...base,
        outcome: 'unauthorized_burst',
        detail: 'further attempts suppressed for this window',
      });
      return;
    }
    await logAudit({
      ...base,
      outcome: 'unauthorized',
      detail: 'Unauthorized access to revoke user sessions',
    });
  } catch (error) {
    console.error('Admin revoke unauthorized audit skipped:', error);
  }
}

function isTargetNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 404 || code === 'user_not_found';
}

export async function POST(request: Request) {
  try {
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const authResult = await authorizeAdminPermission('admin.users.manage', request);
    if (!authResult.ok) {
      await auditUnauthorized(clientIp, userAgent);
      return authResult.response;
    }

    const actorId = authResult.userId;
    const actorEmail = authResult.actorEmail;

    const limited = await enforceRateLimit({ request, ...REVOKE_RATE_LIMIT, subject: actorId });
    if (limited) {
      return limited;
    }

    const audit = (outcome: 'success' | 'failure' | 'error', detail: string | null, extra: { resource_id?: string; metadata?: Record<string, unknown> } = {}) =>
      logAudit({
        action: 'admin_revoke_user_sessions',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'sessions',
        outcome,
        ...(detail ? { detail } : {}),
        ...extra,
      });

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      await logAudit({
        action: 'admin_revoke_user_sessions',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'sessions',
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { user_id } = parsed.data;

    if (user_id === actorId) {
      await audit('failure', 'self_revocation_rejected', { resource_id: user_id });
      return NextResponse.json({ error: 'Cannot revoke your own sessions' }, { status: 400 });
    }

    try {
      const service = await createServiceRoleClient();

      const { data: targetData, error: targetError } = await service.auth.admin.getUserById(user_id);
      if (targetError || !targetData?.user) {
        if (!targetError || isTargetNotFound(targetError)) {
          await audit('failure', 'target_not_found', { resource_id: user_id });
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        console.error('Failed to look up the revoke target:', { code: (targetError as { code?: string }).code });
        await audit('error', 'target_lookup_failed', { resource_id: user_id });
        return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
      }

      const { authSessionsDeleted } = await revokeAllSessionsForUser(user_id);

      await audit('success', null, { resource_id: user_id, metadata: { auth_sessions_deleted: authSessionsDeleted } });
      return NextResponse.json({ ok: true }, { status: 200 });
    } catch (dbErr) {
      console.error('Failed to revoke sessions:', dbErr);
      await audit('error', 'revoke_failed', { resource_id: user_id });
      return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
    }
  } catch (err) {
    console.error('Admin revoke handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
