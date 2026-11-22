/**
 * 2本の登録の終わりの窓口（src/app/api/auth/staff/register/complete/route.ts）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-376
 * @design DD-AUTH-080
 * @remarks 本文なしの POST。順番: 回数（IP）→ 認証（署名・生きたセッション）→ CSRF → 回数（本人）→ アプリに結び付いたセッションか →
 * `activateStaffRole`（鍵がすべて窓の中で認めた鍵で、本数が下限以上かは DB が確かめる）→ 成功したら、そのセッションと本人の全ログインを終わらせ、
 * 認証の Cookie を消して `{ redirectTo: '/login' }`。役割が有効になった後は、このセッションで入った状態を残さない（パスキーのログインだけが入口）。
 * 理由の写し: keys_short・keys_not_window は 409、窓が閉じた・招待が無効は 403 `window_closed`、そのほかは 500。応答に鍵の ID を載せない。応答は no-store。
 * ログインの終了だけが落ちた時は、役割はもう有効なので 200 で Cookie を消し、監査に error を残す。
 */
import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { activateStaffRole } from '@/features/auth/staff/staff-invite-store';
import { authenticateRequest, authFailureResponse, checkAuthSessionLiveness } from '@/lib/auth/authenticate';
import { endAuthSession } from '@/lib/auth/passkey-auth-session-end';
import { extractAuthToken } from '@/lib/auth/request-token';
import { revokeAllSessionsForUser } from '@/lib/auth/revoke-user-sessions';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { withNoStore } from '@/lib/http/no-store';
import { createServiceRoleClient } from '@/lib/supabase/server';

const AUDIT_ACTION = 'auth.staff.register.complete';
const ENDPOINT = 'auth:staff:register:complete';

function json(body: unknown, status: number): NextResponse {
  return withNoStore(
    new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

async function clearAuthCookies(response: NextResponse): Promise<void> {
  const {
    refreshCookieName,
    accessCookieName,
    csrfCookieName,
    sessionCookieName,
    returnIntentCookieName,
    clearCookieOptions,
  } = await import('@/lib/cookie');
  for (const name of [
    sessionCookieName,
    refreshCookieName,
    accessCookieName,
    csrfCookieName,
    returnIntentCookieName,
  ]) {
    response.cookies.set({ name, value: '', ...clearCookieOptions() });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const limitedByIp = await enforceRateLimit({ request, endpoint: ENDPOINT, limit: 20, windowSeconds: 600 });
    if (limitedByIp) return limitedByIp;

    const auth = await authenticateRequest(request);
    if (!auth.ok) return withNoStore(authFailureResponse(auth.reason));
    const userId = auth.claims.sub;
    const sessionId = auth.claims.session_id;
    const accessToken = extractAuthToken(request);
    if (!userId || !sessionId || !accessToken) return withNoStore(authFailureResponse('invalid'));

    const csrf = await requireCsrfOrDeny();
    if (csrf instanceof Response) return withNoStore(csrf);

    const limitedByUser = await enforceRateLimit({
      request,
      endpoint: ENDPOINT,
      limit: 10,
      windowSeconds: 600,
      subject: userId,
    });
    if (limitedByUser) return limitedByUser;

    // 旗に関わらず、アプリに結び付いた生きたセッションだけ（登録の窓口と同じ）。
    const liveness = await checkAuthSessionLiveness(sessionId, true);
    if (liveness === 'unavailable') return withNoStore(authFailureResponse('unavailable'));
    if (liveness !== 'active') return withNoStore(authFailureResponse('invalid'));

    const deny = async (detail: string, body: unknown, status: number) => {
      await logAudit({ action: AUDIT_ACTION, outcome: 'failure', detail, actor_id: userId });
      return json(body, status);
    };

    const service = await createServiceRoleClient();
    const activated = await activateStaffRole({ rpc: (name, args) => service.rpc(name, args) }, userId, sessionId);
    if (!activated.ok) {
      switch (activated.reason) {
        case 'keys_short':
          return await deny('keys_short', { error: 'keys_short' }, 409);
        case 'keys_not_window':
          return await deny('keys_not_window', { error: 'keys_not_window' }, 409);
        case 'invite_invalid':
        case 'no_window':
          return await deny(activated.reason, { error: 'window_closed' }, 403);
        default:
          return await deny('activate_failed', { error: 'register_complete_failed' }, 500);
      }
    }

    // 役割は有効になった。この招待のセッションと本人の全ログインを終わらせる（パスキーのログインだけが入口）。
    const inviteEnded = await endAuthSession(accessToken);
    let ended = false;
    try {
      await revokeAllSessionsForUser(userId);
      ended = true;
    } catch {
      console.error('staff register complete: session revocation failed');
    }
    await logAudit(
      ended
        ? { action: AUDIT_ACTION, outcome: 'success', detail: 'role_activated', actor_id: userId }
        : {
            action: AUDIT_ACTION,
            outcome: 'error',
            detail: inviteEnded ? 'session_revocation_failed' : 'session_revocation_failed_invite_alive',
            actor_id: userId,
          },
    );

    const response = json({ redirectTo: '/login' }, 200);
    await clearAuthCookies(response);
    return response;
  } catch {
    console.error('staff register complete handler error');
    await logAudit({ action: AUDIT_ACTION, outcome: 'error', detail: 'unexpected_error' });
    return json({ error: 'Internal server error' }, 500);
  }
}
