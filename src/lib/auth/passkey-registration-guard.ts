import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { withNoStore } from '@/lib/http/no-store';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { authenticateRequest, authFailureResponse, checkAuthSessionLiveness } from '@/lib/auth/authenticate';
import { extractAuthToken } from '@/lib/auth/request-token';
import { approvedCount, isStaff, windowIsOpen } from '@/lib/auth/passkey-approval-rpc';
import { evaluateRegistrationAccess, type RegistrationMode } from '@/lib/auth/passkey-recent-auth';

export type RegistrationGuardResult =
  | { ok: true; userId: string; accessToken: string; isStaff: boolean; mode: RegistrationMode }
  | { ok: false; response: Response };

/**
 * 本文を `{ error, ... }` の JSON にして、no-store を付けて返す。
 *
 * @impl IMPL-AUTH-289
 * @design DD-AUTH-056
 */
export function registrationJson(body: unknown, status: number): NextResponse {
  return withNoStore(
    new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

/**
 * 登録の始め・終わりが、呼ばれるたびにやり直す確かめ（設計 6-2）。回数の制限（IP）→ 認証 → CSRF → 回数の制限（本人）→
 * 店員かの確かめ（店員は旗 `AUTH_REQUIRE_APP_SESSION` に関わらず、結び付いた生きたセッションだけ）→ 窓・認めた鍵の本数 → 入り直しの判定、の順。
 *
 * @impl IMPL-AUTH-286
 * @design DD-AUTH-056
 * @remarks 外れたら `{ ok: false, response }`（GoTrue はまだ呼ばれていない）。監査には固定の符号と行為者の ID だけを残し、トークン・`challenge_id` は残さない。
 * 店員の判定の DB が使えない時・窓・本数が読めない時は 503（閉じる側）。
 */
export async function guardPasskeyRegistration(
  request: Request,
  input: { auditAction: string; endpoint: string },
): Promise<RegistrationGuardResult> {
  const deny = async (detail: string, body: unknown, status: number, actorId: string) => {
    await logAudit({ action: input.auditAction, outcome: 'failure', detail, actor_id: actorId });
    return { ok: false, response: registrationJson(body, status) } as const;
  };

  const limitedByIp = await enforceRateLimit({ request, endpoint: input.endpoint, limit: 20, windowSeconds: 600 });
  if (limitedByIp) return { ok: false, response: limitedByIp };

  const auth = await authenticateRequest(request);
  if (!auth.ok) return { ok: false, response: authFailureResponse(auth.reason) };
  const { claims } = auth;
  const userId = claims.sub;
  const accessToken = extractAuthToken(request);
  if (!userId || !accessToken) return { ok: false, response: authFailureResponse('invalid') };

  const csrf = await requireCsrfOrDeny();
  if (csrf instanceof Response) return { ok: false, response: csrf };

  const limitedByUser = await enforceRateLimit({
    request,
    endpoint: input.endpoint,
    limit: 10,
    windowSeconds: 600,
    subject: userId,
  });
  if (limitedByUser) return { ok: false, response: limitedByUser };

  const staff = await isStaff(userId);
  if (!staff.ok) return deny('staff_check_unavailable', { error: 'passkey_register_unavailable' }, 503, userId);

  let windowOpen = false;
  let count = 0;
  if (staff.value) {
    // 旗に関わらず、アプリに結び付いた生きたセッションだけ（admin-rbac と同じ。SEC-AUTH-045）。
    const liveness = await checkAuthSessionLiveness(claims.session_id, true);
    if (liveness === 'unavailable') return deny('session_check_unavailable', { error: 'Service temporarily unavailable' }, 503, userId);
    if (liveness !== 'active' || !claims.session_id) return deny('app_session_required', { error: 'Unauthorized' }, 401, userId);

    const [opened, counted] = await Promise.all([windowIsOpen(userId, claims.session_id), approvedCount(userId)]);
    if (!opened.ok || !counted.ok) return deny('window_check_unavailable', { error: 'passkey_register_unavailable' }, 503, userId);
    windowOpen = opened.value;
    count = counted.value;
  }

  const access = evaluateRegistrationAccess({
    claims: claims as { amr?: unknown },
    isStaff: staff.value,
    windowOpen,
    approvedCount: count,
    nowSeconds: Date.now() / 1000,
  });
  if (!access.ok) {
    return deny(`registration_not_allowed:${access.reason}`, { error: 'registration_not_allowed', reason: access.reason }, 403, userId);
  }

  return { ok: true, userId, accessToken, isStaff: staff.value, mode: access.mode };
}
