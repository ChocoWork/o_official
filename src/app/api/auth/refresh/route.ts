import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logAudit } from '@/lib/audit';

async function clearAuthCookies(response: NextResponse) {
  const {
    refreshCookieName,
    accessCookieName,
    csrfCookieName,
    clearCookieOptions,
  } = await import('@/lib/cookie');

  response.cookies.set({ name: refreshCookieName, value: '', ...clearCookieOptions() });
  response.cookies.set({ name: accessCookieName, value: '', ...clearCookieOptions() });
  response.cookies.set({ name: csrfCookieName, value: '', ...clearCookieOptions() });
}

export async function POST(request: Request) {
  try {
    // Enforce IP-level rate limit for refresh attempts
    try {
      const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
      const rl = await enforceRateLimit({ request, endpoint: 'auth:refresh', limit: 30, windowSeconds: 600 });
      if (rl) return rl;
    } catch (e) {
      console.error('Rate limit middleware error (refresh):', e);
    }
    const cookieStore = await cookies();
    const refreshToken = cookieStore.get('sb-refresh-token')?.value;

    if (!refreshToken) {
      return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
    }

    const sessionService = await import('@/features/auth/services/session');
    const session = await sessionService.findSessionByRefreshHash(refreshToken);

    // 自前テーブルは監査用。行が無いことは「失効の証拠が無い」だけなので拒否しない
    // （取りこぼしで正当なユーザーを締め出さない）。実際の門番は Supabase の token 交換。
    if (!session) {
      console.warn('[auth.refresh] no local session row for the presented refresh token');
    }

    // 明示的な失効記録がある場合だけ拒否する。ログアウトや管理者による強制失効が
    // Supabase 側へ届かなかったときの最後の砦。推測（jti / 旧ハッシュ照合）は行わない
    // ため誤検知しない。リプレイ検出そのものは Supabase Auth が担当する。
    if (session?.revoked_at) {
      await logAudit({
        action: 'refresh',
        actor_id: session.user_id,
        outcome: 'failure',
        detail: 'session_revoked',
      });

      const denied = NextResponse.json({ error: 'Session revoked' }, { status: 401 });
      await clearAuthCookies(denied);
      return denied;
    }

    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    // 更新の印を JSON 本文で送り、更新方法は URL で指定する。
    const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!tokenRes.ok) {
      const failedText = await tokenRes.text();
      console.error('Token refresh failed:', failedText);
      await logAudit({
        action: 'refresh',
        actor_id: session?.user_id,
        outcome: 'failure',
        detail: 'supabase_refresh_failed',
        metadata: { status: tokenRes.status },
      });

      // Supabase が拒否した＝リプレイ検出・セッション終了・期限切れのいずれか。
      // 死んだ Cookie を残すとクライアントが再試行を続けるので消す。
      const denied = NextResponse.json({ error: 'Failed to refresh token' }, { status: 401 });
      await clearAuthCookies(denied);
      return denied;
    }

    const tokenData = await tokenRes.json();
    const newAccessToken = tokenData.access_token;
    const newRefreshToken = tokenData.refresh_token;
    const user = tokenData.user;

    const res = NextResponse.json({ access_token: newAccessToken, user }, { status: 200 });

    // Cookie / CSRF / sessions 行の更新は refresh と MFA 昇格で共通。手順がずれないよう一本化する。
    // DB 記録に失敗しても、発行済みトークンは必ず配る（旧 refresh token は既に無効化されており、
    // ここで 500 を返すとユーザーは死んだトークンだけを持って詰む）。失敗は監査に残す。
    try {
      await sessionService.persistNewSession(res, {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        userId: session?.user_id || user?.id,
        previousSessionId: session?.id ?? null,
        previousRefreshToken: refreshToken,
      });
      await logAudit({
        action: 'refresh',
        actor_id: session?.user_id,
        outcome: 'success',
      });
    } catch (dbErr) {
      console.error('Session DB update error during refresh:', dbErr);
      await logAudit({
        action: 'refresh',
        actor_id: session?.user_id,
        outcome: 'error',
        detail: String(dbErr),
      });
    }

    return res;
  } catch (err) {
    console.error('Refresh handler error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
