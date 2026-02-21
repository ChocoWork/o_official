import { NextResponse } from 'next/server';
import { headers, cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';

// Verifies X-CSRF-Token header matches the stored csrf_token_hash for the session
// identified by refresh token cookie. On success it will attempt to rotate the
// CSRF token (store a new hash) and return the new raw token to the caller so
// the route can set it as a non-HttpOnly cookie.
export async function requireCsrfOrDeny() {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('sb-refresh-token')?.value;
  if (!refreshToken) return; // no session -> no CSRF required

  const headerToken = (await headers()).get('x-csrf-token');
  if (!headerToken) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { tokenHashSha256 } = await import('@/lib/hash');
  const refreshHash = await tokenHashSha256(refreshToken);
  const providedHash = await tokenHashSha256(headerToken);

  try {
    const service = await createServiceRoleClient();
    const q = await service.from('sessions').select('csrf_token_hash').eq('refresh_token_hash', refreshHash).maybeSingle();
    const storedHash = q?.data?.csrf_token_hash ?? null;
    if (!storedHash || storedHash !== providedHash) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Verified. Rotate CSRF token and persist the new hash.
    const { verifyAndRotateCsrf } = await import('@/lib/csrf');

    const storeNewHash = async (nextHash: string) => {
      try {
        // Try updating both current and prev hash (if prev column exists).
        await service
          .from('sessions')
          .update({ csrf_token_hash: nextHash, csrf_prev_token_hash: storedHash })
          .eq('refresh_token_hash', refreshHash);
      } catch (e) {
        // If schema doesn't have csrf_prev_token_hash, fallback to updating only current.
        try {
          await service
            .from('sessions')
            .update({ csrf_token_hash: nextHash })
            .eq('refresh_token_hash', refreshHash);
        } catch (e2) {
          console.error('Failed to persist rotated CSRF hash:', e2);
        }
      }
    };

    const rotation = await verifyAndRotateCsrf(headerToken, storedHash, storeNewHash);
    if (rotation && (rotation as any).rotated && (rotation as any).nextToken) {
      return { rotatedCsrfToken: (rotation as any).nextToken };
    }

    return; // allowed, no rotation
  } catch (err) {
    console.error('CSRF verification DB error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
