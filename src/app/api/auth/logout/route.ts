import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';

type CsrfDenyResponse = {
  status: number;
  _body: unknown;
};

type CsrfRotateResult = {
  rotatedCsrfToken: string;
};

function isCsrfDenyResponse(value: unknown): value is CsrfDenyResponse {
  return typeof value === 'object' && value !== null && 'status' in value && '_body' in value;
}

function hasRotatedCsrfToken(value: unknown): value is CsrfRotateResult {
  return typeof value === 'object' && value !== null && 'rotatedCsrfToken' in value;
}

export async function POST() {
  try {
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get('sb-refresh-token')?.value;

    // Prepare variable to capture CSRF middleware result so it's available
    // later when setting rotated CSRF cookie on the response.
    let csrfResult: unknown;

    if (refreshToken) {
      try {
        const service = await createServiceRoleClient();
        const { tokenHashSha256 } = await import('@/lib/hash');
        const hash = await tokenHashSha256(refreshToken);

        // Delegate to reusable middleware helper. It may return a NextResponse
        // on denial/error, or an object with `rotatedCsrfToken` when rotation
        // occurred. We capture the result and apply rotated token to response
        // after creating it below.
        const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
        csrfResult = await requireCsrfOrDeny();
        if (isCsrfDenyResponse(csrfResult)) {
          return csrfResult;
        }

        // Some test mocks return an object where `update()` itself returns
        // a Promise (no `.eq()` chain). Other implementations return a
        // chainable query builder where `.update(...).eq(...)` is valid.
        // Handle both shapes gracefully.
        const updateCall = service.from('sessions').update({ revoked_at: new Date().toISOString() });
        if (updateCall && typeof (updateCall as { eq?: (column: string, value: string) => Promise<unknown> }).eq === 'function') {
          await (updateCall as { eq: (column: string, value: string) => Promise<unknown> }).eq('refresh_token_hash', hash);
        } else {
          // Await the promise-like update result if it's promise-like.
          await updateCall;
        }
      } catch (dbErr) {
        console.error('Failed to mark session revoked:', dbErr);
      }
    }


    const res = NextResponse.json({ ok: true }, { status: 200 });

    // If CSRF rotation returned a new token, set it as a csrf cookie on the response.
    const { refreshCookieName, accessCookieName, csrfCookieName, clearCookieOptions, cookieOptionsForCsrf } = await import('@/lib/cookie');
    if (hasRotatedCsrfToken(csrfResult)) {
      res.cookies.set({ name: csrfCookieName, value: csrfResult.rotatedCsrfToken, ...cookieOptionsForCsrf(0) });
    }

    // Clear cookies using helpers
    res.cookies.set({ name: refreshCookieName, value: '', ...clearCookieOptions() });
    res.cookies.set({ name: accessCookieName, value: '', ...clearCookieOptions() });
    res.cookies.set({ name: csrfCookieName, value: '', ...clearCookieOptions() });

    return res;
  } catch (err) {
    console.error('Logout handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
