/**
 * 管理者が利用者のセッションを強制的に失効させる窓口（src/app/api/admin/revoke-user-sessions/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-ADMIN-103
 * @design DD-ADMIN-003
 * @remarks 自前の sessions 表だけを直しても Auth 側のセッションと発行済みのアクセストークンが生き残るので、自前の表に失効の時刻を入れ、Auth のセッションも消す。人のセッションを切る操作は悪用もできるため、権限の無い試みも IP とブラウザの情報付きで監査に残す。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';

const bodySchema = z.object({ user_id: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const authResult = await authorizeAdminPermission('admin.users.manage', request);
    if (!authResult.ok) {
      await logAudit({
        action: 'admin_revoke_user_sessions',
        actor_id: null,
        actor_email: null,
        resource: 'sessions',
        outcome: 'unauthorized',
        detail: 'Unauthorized access to revoke user sessions',
        ip: clientIp,
        user_agent: userAgent,
      });
      return authResult.response;
    }

    const actorId = authResult.userId;
    const actorEmail = authResult.actorEmail;

    const body = await request.json();
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

    try {
      const service = await createServiceRoleClient();
      await service.from('sessions').update({ revoked_at: new Date().toISOString() }).eq('user_id', user_id);

      // 自前テーブルだけ更新しても Supabase 側のセッションは生き残り、発行済み
      // access token が exp まで通ってしまう。Auth 側のセッションも削除する。
      const { data: revokedCount, error: revokeError } = await service.rpc(
        'revoke_auth_sessions_for_user',
        { p_user_id: user_id },
      );

      if (revokeError) {
        console.error('Failed to revoke Supabase sessions:', revokeError);
        await logAudit({
          action: 'admin_revoke_user_sessions',
          actor_id: actorId,
          actor_email: actorEmail,
          resource: 'sessions',
          resource_id: user_id,
          outcome: 'error',
          detail: 'auth_session_revocation_failed',
        });
        return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
      }

      await logAudit({
        action: 'admin_revoke_user_sessions',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'sessions',
        resource_id: user_id,
        outcome: 'success',
        metadata: { auth_sessions_deleted: revokedCount ?? 0 },
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    } catch (dbErr) {
      console.error('Failed to revoke sessions:', dbErr);
      await logAudit({
        action: 'admin_revoke_user_sessions',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'sessions',
        resource_id: user_id,
        outcome: 'error',
        detail: String(dbErr),
      });
      return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
    }
  } catch (err) {
    console.error('Admin revoke handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
