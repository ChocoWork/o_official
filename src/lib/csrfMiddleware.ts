import { NextResponse } from 'next/server';
import { headers, cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';

// Keep the legacy success shape in the return contract while callers migrate
// away from per-request rotation. This middleware no longer produces it.
type LegacyCsrfRotationResult = { rotatedCsrfToken: string };

// Verifies X-CSRF-Token header matches the stored csrf_token_hash for the session
// identified by refresh token cookie. Rotation is intentionally limited to
// login/session refresh so failed mutations cannot desynchronize cookie and DB.
export async function requireCsrfOrDeny(): Promise<Response | LegacyCsrfRotationResult | undefined> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('sb-refresh-token')?.value;
  if (!refreshToken) return; // no session -> no CSRF required

  const headerToken = (await headers()).get('x-csrf-token');
  if (!headerToken) return NextResponse.json(
    { error: 'Forbidden', reason: 'CSRF validation failed' },
    { status: 403 },
  );

  const { tokenHashSha256 } = await import('@/lib/hash');
  const normalizedHeaderToken = (() => {
    try {
      return decodeURIComponent(headerToken);
    } catch {
      return headerToken;
    }
  })();
  const refreshHash = await tokenHashSha256(refreshToken);
  const providedHash = await tokenHashSha256(normalizedHeaderToken);

  try {
    const service = await createServiceRoleClient();
    const q = await service.from('sessions').select('csrf_token_hash').eq('refresh_token_hash', refreshHash).maybeSingle();
    const storedHash = q?.data?.csrf_token_hash ?? null;
    if (!storedHash || storedHash !== providedHash) {
      return NextResponse.json(
        { error: 'Forbidden', reason: 'CSRF validation failed' },
        { status: 403 },
      );
    }

    return;
  } catch (err) {
    console.error('CSRF verification DB error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
