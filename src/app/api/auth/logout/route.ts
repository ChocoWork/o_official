import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';

type CsrfDenyResponse = {
  status: number;
  _body: unknown;
  headers?: Record<string, string>;
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

        // CSRF が有効な場合のみサーバ側セッションを失効させる。
        // 失効可否に関わらず Cookie は必ずクリアし、ユーザーが確実にログアウトできるようにする
        // （ログアウトは冪等で、CSRF 拒否でも Cookie が残らないようにする）。
        if (!isCsrfDenyResponse(csrfResult)) {
          await service
            .from('sessions')
            .update({ revoked_at: new Date().toISOString() })
            .eq('refresh_token_hash', hash);
        }
      } catch (dbErr) {
        console.error('Failed to mark session revoked:', dbErr);
      }
    }


    const res = NextResponse.json({ ok: true }, { status: 200 });

    // If CSRF rotation returned a new token, set it as a csrf cookie on the response.
    const {
      refreshCookieName,
      accessCookieName,
      csrfCookieName,
      sessionCookieName,
      loginTwoFactorSessionCookieName,
      passwordResetSessionCookieName,
      clearCookieOptions,
      cookieOptionsForCsrf,
    } = await import('@/lib/cookie');
    if (hasRotatedCsrfToken(csrfResult)) {
      res.cookies.set({ name: csrfCookieName, value: csrfResult.rotatedCsrfToken, ...cookieOptionsForCsrf(0) });
    }

    // アプリ独自の認証 Cookie をクリア
    for (const name of [
      sessionCookieName,
      refreshCookieName,
      accessCookieName,
      csrfCookieName,
      loginTwoFactorSessionCookieName,
      passwordResetSessionCookieName,
    ]) {
      res.cookies.set({ name, value: '', ...clearCookieOptions() });
    }

    // Google OAuth ログインが設定する @supabase/ssr の認証 Cookie（sb-<ref>-auth-token[.N]）もクリアする。
    // これを残すと、独自の access-token Cookie を消してもリロード時に SSR クライアントが
    // 当該 Cookie を読んで再認証してしまい、ログアウトが効かなくなる。
    for (const cookie of cookieStore.getAll()) {
      if (/^sb-.*-auth-token(\.\d+)?$/.test(cookie.name)) {
        res.cookies.set({ name: cookie.name, value: '', ...clearCookieOptions() });
      }
    }

    return res;
  } catch (err) {
    console.error('Logout handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
