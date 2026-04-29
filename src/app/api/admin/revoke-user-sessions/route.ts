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
      await logAudit({
        action: 'admin_revoke_user_sessions',
        actor_id: actorId,
        actor_email: actorEmail,
        resource: 'sessions',
        resource_id: user_id,
        outcome: 'success',
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
