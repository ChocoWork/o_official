import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';
import crypto from 'crypto';

export async function POST() {
  try {
    const cookieStore = cookies();
    const refreshToken = cookieStore.get('sb-refresh-token')?.value;

    if (refreshToken) {
      try {
        const service = createServiceRoleClient();
        const { tokenHashSha256 } = await import('@/lib/hash');
        const { refreshCookieName, csrfCookieName } = await import('@/lib/cookie');
        const hash = tokenHashSha256(refreshToken);

        // Delegate to reusable middleware helper
        const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
        const denial = await requireCsrfOrDeny();
        if (denial) return denial;

        await service
          .from('sessions')
          .update({ revoked_at: new Date().toISOString() })
          .eq('refresh_token_hash', hash);
      } catch (dbErr) {
        console.error('Failed to mark session revoked:', dbErr);
      }
    }

    const res = NextResponse.json({ ok: true }, { status: 200 });

    // Clear cookies using helpers
    const { refreshCookieName, csrfCookieName, clearCookieOptions } = await import('@/lib/cookie');
    res.cookies.set({ name: refreshCookieName, value: '', ...clearCookieOptions() });
    res.cookies.set({ name: 'sb-access-token', value: '', ...clearCookieOptions() });
    res.cookies.set({ name: csrfCookieName, value: '', ...clearCookieOptions() });

    return res;
  } catch (err) {
    console.error('Logout handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
