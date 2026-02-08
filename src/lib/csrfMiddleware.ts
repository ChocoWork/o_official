import { NextResponse } from 'next/server';
import { headers, cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';

// Verifies X-CSRF-Token header matches the stored csrf_token_hash for the session identified by refresh token cookie.
export async function requireCsrfOrDeny() {
  const cookieStore = cookies();
  const refreshToken = cookieStore.get('sb-refresh-token')?.value;
  if (!refreshToken) return; // no session -> no CSRF required

  const headerToken = headers().get('x-csrf-token');
  if (!headerToken) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { tokenHashSha256 } = await import('@/lib/hash');
  const refreshHash = tokenHashSha256(refreshToken);
  const providedHash = tokenHashSha256(headerToken);

  try {
    const service = createServiceRoleClient();
    const q = await service.from('sessions').select('csrf_token_hash').eq('refresh_token_hash', refreshHash).maybeSingle();
    const storedHash = q?.data?.csrf_token_hash ?? null;
    if (!storedHash || storedHash !== providedHash) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  } catch (err) {
    console.error('CSRF verification DB error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return; // allowed
}
