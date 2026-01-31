import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';
import crypto from 'crypto';

export async function POST() {
  try {
    const cookieStore = cookies();
    const refreshToken = cookieStore.get('sb-refresh-token')?.value;

    if (refreshToken) {
      try {
        const service = createServiceRoleClient();
        const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await service
          .from('sessions')
          .update({ revoked_at: new Date().toISOString() })
          .eq('refresh_token_hash', hash);
      } catch (dbErr) {
        console.error('Failed to mark session revoked:', dbErr);
      }
    }

    const res = NextResponse.json({ ok: true }, { status: 200 });

    // Clear cookies
    res.cookies.set({
      name: 'sb-refresh-token',
      value: '',
      path: '/',
      maxAge: 0,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });

    res.cookies.set({
      name: 'sb-access-token',
      value: '',
      path: '/',
      maxAge: 0,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });

    return res;
  } catch (err) {
    console.error('Logout handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
