import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

const bodySchema = z.object({
  token: z.string().min(1),
  email: z.string().email(),
  new_password: z.string().min(8),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

    const { token, email, new_password } = parsed.data;
    const supabase = createServiceRoleClient();

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Find valid token
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('password_reset_tokens')
      .select('*')
      .eq('token_hash', tokenHash)
      .eq('email', email)
      .gte('expires_at', new Date().toISOString())
      .eq('used', false)
      .maybeSingle();

    if (tokenErr) {
      console.error('Token lookup error:', tokenErr);
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
    }

    if (!tokenRow) {
      await logAudit({ action: 'password_reset_confirm', actor_email: email, outcome: 'failure', detail: 'invalid_or_expired_token' });
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 400 });
    }

    // Update user's password — attempt to find user id
    let userId = tokenRow.user_id;
    if (!userId) {
      const { data: u } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
      userId = u?.id ?? null;
    }

    if (!userId) {
      await logAudit({ action: 'password_reset_confirm', actor_email: email, outcome: 'error', detail: 'user_not_found' });
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Use Supabase Admin API to update user's password
    try {
      await supabase.auth.admin.updateUserById(userId, { password: new_password });
    } catch (updErr) {
      console.error('Failed to update user password:', updErr);
      await logAudit({ action: 'password_reset_confirm', actor_email: email, outcome: 'error', detail: String(updErr) });
      return NextResponse.json({ error: 'Failed to update password' }, { status: 500 });
    }

    // Mark token used
    await supabase.from('password_reset_tokens').update({ used: true }).eq('id', tokenRow.id);

    await logAudit({ action: 'password_reset_confirm', actor_email: email, outcome: 'success', resource_id: userId });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error('Password reset confirm error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
