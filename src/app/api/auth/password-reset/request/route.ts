import { NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { createServiceRoleClient } from '@/lib/supabase/server';
import sendMail from '@/lib/mail';
import { logAudit } from '@/lib/audit';
import { ResetRequestSchema } from '@/features/auth/schemas/password-reset';
import { formatZodError } from '@/features/auth/schemas/common';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = ResetRequestSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

    const { email } = parsed.data;
    const supabase = createServiceRoleClient();

    // Find user by email in users table (if exists)
    const { data: usersData } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    const userId = usersData?.id ?? null;

    // Generate secure token and store its hash
    const token = crypto.randomBytes(32).toString('hex');
    const { tokenHashSha256 } = await import('@/lib/hash');
    const tokenHash = tokenHashSha256(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await supabase.from('password_reset_tokens').insert([
      {
        user_id: userId,
        email,
        token_hash: tokenHash,
        expires_at: expiresAt,
        used: false,
      },
    ]);

    // Send email with reset link
    const base = process.env.NEXT_PUBLIC_BASE_URL || process.env.BASE_URL || 'http://localhost:3000';
    const resetUrl = `${base}/auth/password-reset?token=${token}&email=${encodeURIComponent(email)}`;

    try {
      await sendMail({
        to: email,
        subject: 'Password reset',
        html: `<p>Click to reset your password: <a href="${resetUrl}">Reset password</a></p>`,
        text: `Reset your password: ${resetUrl}`,
      });
    } catch (mailErr) {
      console.warn('Failed to send password reset mail:', mailErr);
    }

    await logAudit({ action: 'password_reset_request', actor_email: email, outcome: 'success', resource_id: userId });

    // Respond 200 even if email not found to avoid enumeration
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error('Password reset request error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
