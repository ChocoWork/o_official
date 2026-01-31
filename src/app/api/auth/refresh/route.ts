import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';
import crypto from 'crypto';

const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

export async function POST() {
  try {
    const cookieStore = cookies();
    const refreshToken = cookieStore.get('sb-refresh-token')?.value;

    if (!refreshToken) {
      return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    // Exchange refresh token for new session
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);

    const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      console.error('Token refresh failed:', await tokenRes.text());
      return NextResponse.json({ error: 'Failed to refresh token' }, { status: 401 });
    }

    const tokenData = await tokenRes.json();
    const newAccessToken = tokenData.access_token;
    const newRefreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in; // seconds
    const user = tokenData.user;

    // Set new refresh cookie
    const res = NextResponse.json({ access_token: newAccessToken, user }, { status: 200 });
    res.cookies.set({
      name: 'sb-refresh-token',
      value: newRefreshToken ?? '',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });

    // Update sessions table: revoke old session row(s) and insert new one
    try {
      const service = createServiceRoleClient();
      const oldHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      await service
        .from('sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('refresh_token_hash', oldHash);

      const newHash = crypto.createHash('sha256').update(newRefreshToken ?? '').digest('hex');
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

      await service.from('sessions').insert([
        {
          user_id: user?.id,
          refresh_token_hash: newHash,
          expires_at: expiresAt,
          last_seen_at: new Date().toISOString(),
        },
      ]);
    } catch (dbErr) {
      console.error('Session DB update error during refresh:', dbErr);
    }

    return res;
  } catch (err) {
    console.error('Refresh handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
