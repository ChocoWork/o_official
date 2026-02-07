import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const bodySchema = z.object({ user_id: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const adminToken = request.headers.get('x-admin-token');
    if (!adminToken || adminToken !== process.env.ADMIN_API_KEY) {
      await logAudit({ action: 'admin_revoke_user_sessions', actor_email: null, outcome: 'unauthorized', detail: 'Missing or invalid admin token' });
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const { user_id } = parsed.data;

    try {
      const service = createServiceRoleClient();
      await service.from('sessions').update({ revoked_at: new Date().toISOString() }).eq('user_id', user_id);
      await logAudit({ action: 'admin_revoke_user_sessions', actor_email: null, outcome: 'success', resource_id: user_id });
      return NextResponse.json({ ok: true }, { status: 200 });
    } catch (dbErr) {
      console.error('Failed to revoke sessions:', dbErr);
      await logAudit({ action: 'admin_revoke_user_sessions', actor_email: null, outcome: 'error', detail: String(dbErr) });
      return NextResponse.json({ error: 'Failed to revoke sessions' }, { status: 500 });
    }
  } catch (err) {
    console.error('Admin revoke handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
