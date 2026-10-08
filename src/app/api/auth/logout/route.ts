import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { verifyAccessToken } from '@/lib/auth/authenticate';
import { logAudit } from '@/lib/audit';

// PUBLIC: 未認証でも 200 を返す。ログアウトが 401 だと「まだ有効なセッション」を漏らすため。
// 実際の失効は verifyAccessToken(allowExpired) で取れた session_id を使い、CSRF トークンも要求する。

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

/**
 * Supabase 側のセッションを終了させる。
 *
 * 公式の auth.admin.signOut は対象ユーザーの**有効な** JWT を要求するため、access token が
 * 期限切れ・欠落していると呼べない。その状態でも refresh Cookie は生きているので、
 * 何もしないと auth.sessions の行が残り、流出済みの refresh token がそのまま有効になる。
 * そこで access token の有効性に依存しない経路を使う:
 *   1. JWT の session_id クレーム（期限切れでも署名は検証する）→ revoke_auth_session
 *   2. session_id が取れないときは自前 sessions 行の user_id → revoke_auth_sessions_for_user
 * 2 は全端末を落とすが、ログアウト要求に対して生きたサーバセッションを残すよりは良い。
 */
async function terminateSupabaseSession(
  service: SupabaseClient,
  revokedRows: Array<{ user_id: string }> | null,
): Promise<void> {
  const verified = await verifyAccessToken(undefined, { allowExpired: true });

  if (verified.ok && verified.claims.session_id) {
    const { error } = await service.rpc('revoke_auth_session', {
      p_session_id: verified.claims.session_id,
    });

    if (!error) {
      return;
    }

    console.error('[auth.logout] revoke_auth_session failed:', error);
  }

  const userId = revokedRows?.[0]?.user_id;
  if (!userId) {
    await logAudit({
      action: 'logout',
      outcome: 'error',
      detail: 'auth_session_not_identified',
    });
    return;
  }

  const { error: fallbackError } = await service.rpc('revoke_auth_sessions_for_user', {
    p_user_id: userId,
  });

  if (fallbackError) {
    console.error('[auth.logout] revoke_auth_sessions_for_user failed:', fallbackError);
    await logAudit({
      action: 'logout',
      actor_id: userId,
      outcome: 'error',
      detail: 'auth_session_revocation_failed',
    });
    return;
  }

  await logAudit({
    action: 'logout',
    actor_id: userId,
    outcome: 'success',
    detail: 'revoked_all_sessions_session_id_unavailable',
  });
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
          const { data: revokedRows } = await service
            .from('sessions')
            .update({ revoked_at: new Date().toISOString() })
            .eq('refresh_token_hash', hash)
            .select('user_id');

          await terminateSupabaseSession(service, revokedRows);
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
      cartCookieName,
      wishlistCookieName,
      clearCookieOptions,
      cookieOptionsForCsrf,
    } = await import('@/lib/cookie');
    if (hasRotatedCsrfToken(csrfResult)) {
      res.cookies.set({ name: csrfCookieName, value: csrfResult.rotatedCsrfToken, ...cookieOptionsForCsrf(0) });
    }

    // アプリ独自の認証 Cookie をクリア。
    // この端末のゲストのカート・お気に入りの印も消す。会員の分はサーバーに残り、次のログインで戻る（設計書 4-3）
    for (const name of [
      sessionCookieName,
      refreshCookieName,
      accessCookieName,
      csrfCookieName,
      loginTwoFactorSessionCookieName,
      passwordResetSessionCookieName,
      cartCookieName,
      wishlistCookieName,
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
