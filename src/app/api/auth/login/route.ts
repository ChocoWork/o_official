import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';
import { LoginRequestSchema } from '@/features/auth/schemas/login';
import { formatZodError } from '@/features/auth/schemas/common';
import crypto from 'crypto';

const ACCESS_TOKEN_MAX_AGE = 15 * 60; // 15 minutes
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(formatZodError(parsed.error), { status: 400 });
    }

    const { email, password } = parsed.data;

    const supabase = await createClient();

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      await logAudit({ action: 'login', actor_email: email, outcome: 'failure', detail: error?.message || 'invalid credentials' });
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const session = data.session;

    // Return access token in JSON; set refresh token only as HttpOnly cookie
    const res = NextResponse.json({ access_token: session.access_token, user: data.user }, { status: 200 });

    res.cookies.set({
      name: 'sb-refresh-token',
      value: session.refresh_token ?? '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });

    // Persist hashed refresh token into sessions table using service role client
    try {
      const service = createServiceRoleClient();
      const refreshToken = session.refresh_token ?? '';
      const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');

      const expiresAt = session.expires_at ? new Date(session.expires_at).toISOString() : null;

      await service.from('sessions').insert([
        {
          user_id: data.user?.id,
          refresh_token_hash: hash,
          expires_at: expiresAt,
          last_seen_at: new Date().toISOString(),
        },
      ]);
    } catch (dbErr) {
      console.error('Failed to persist session row:', dbErr);
    }

    await logAudit({ action: 'login', actor_email: email, outcome: 'success', resource_id: data.user?.id });

    return res;
  } catch (err) {
    console.error('Login handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
