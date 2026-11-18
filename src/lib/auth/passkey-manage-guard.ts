import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { withNoStore } from '@/lib/http/no-store';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { extractAuthToken } from '@/lib/auth/request-token';
import { isStaff } from '@/lib/auth/passkey-approval-rpc';
import { checkStaffIdle, staffIdleDeps } from '@/lib/auth/staff-passkey-idle';
import { endAuthSessionById } from '@/lib/auth/passkey-auth-session-end';
import { STAFF_MIN_APPROVED_PASSKEYS, evaluateStaffEntry } from '@/lib/auth/staff-passkey';

export type ManageGuardResult =
  | { ok: true; userId: string; accessToken: string }
  | { ok: false; response: Response };

/**
 * 本文を JSON にして、no-store を付けて返す（一覧・名前の変更・削除の窓口で共通）。
 *
 * @impl IMPL-AUTH-293
 * @design DD-AUTH-057
 */
export function manageJson(body: unknown, status: number): NextResponse {
  return withNoStore(
    new NextResponse(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

const UNAVAILABLE_BODY = { error: 'passkey_manage_unavailable', message: 'しばらくしてからお試しください。' };

/**
 * 店員の無操作1時間と、パスキーのログインから24時間を確かめる。通せば null、断る時は応答（401 `session_idle`・503）を返す。
 *
 * @impl IMPL-AUTH-382
 * @design DD-AUTH-081
 * @remarks 24時間は、パスキーのログインの印がある時だけ見る（招待の窓の中のセッションにはその印が無い）。超えた・無操作を過ぎた時は GoTrue のセッションを終わらせる。確かめの失敗は 503（終わらせない）。
 */
export async function denyIdleStaff(claims: { session_id?: string; amr?: unknown }, userId: string): Promise<Response | null> {
  const sessionId = claims.session_id;
  if (!sessionId) return authFailureResponse('invalid');
  const entry = evaluateStaffEntry(claims, STAFF_MIN_APPROVED_PASSKEYS, Date.now() / 1000);
  const idle = entry.ok || entry.reason !== 'passkey_expired' ? await checkStaffIdle(staffIdleDeps, sessionId, userId) : 'idle';
  if (idle === 'error') return manageJson(UNAVAILABLE_BODY, 503);
  if (idle === 'idle') {
    await endAuthSessionById(sessionId);
    return manageJson({ error: 'session_idle' }, 401);
  }
  return null;
}

/**
 * 一覧・名前の変更・削除の入口の確かめ。回数の制限（IP ごと 60回／600秒）→ 認証 → CSRF（状態を変える窓口だけ）の順。
 *
 * @impl IMPL-AUTH-292
 * @design DD-AUTH-057
 * @remarks 外れたら `{ ok: false, response }`（GoTrue はまだ呼ばれていない）。回数の枠は窓口ごとに分ける（一覧の読みで削除の枠を使い切らないため）。
 * 店員だけは最後に、無操作1時間（時刻を進める `staff_idle_check`）と、パスキーのログインから24時間を確かめる（SR-AUTH-028）。
 * 超えたら 401 `session_idle` でセッションを終わらせ、確かめの失敗は 503 で閉じる側に倒す。お客さんには当てない。
 */
export async function guardPasskeyManage(
  request: Request,
  input: { endpoint: string; csrf: boolean },
): Promise<ManageGuardResult> {
  const limited = await enforceRateLimit({ request, endpoint: input.endpoint, limit: 60, windowSeconds: 600 });
  if (limited) return { ok: false, response: limited };

  const auth = await authenticateRequest(request);
  if (!auth.ok) return { ok: false, response: authFailureResponse(auth.reason) };
  const userId = auth.claims.sub;
  const accessToken = extractAuthToken(request);
  if (!userId || !accessToken) return { ok: false, response: authFailureResponse('invalid') };

  if (input.csrf) {
    const csrf = await requireCsrfOrDeny();
    if (csrf instanceof Response) return { ok: false, response: csrf };
  }

  const staff = await isStaff(userId);
  if (!staff.ok) return { ok: false, response: manageJson(UNAVAILABLE_BODY, 503) };
  if (staff.value) {
    const denied = await denyIdleStaff(auth.claims, userId);
    if (denied) return { ok: false, response: denied };
  }

  return { ok: true, userId, accessToken };
}

/**
 * 失敗を監査に残して、JSON の断りを返す。監査には固定の符号と行為者の ID だけを残す。
 *
 * @impl IMPL-AUTH-294
 * @design DD-AUTH-057
 */
export async function manageDeny(
  auditAction: string,
  detail: string,
  userId: string,
  body: unknown,
  status: number,
): Promise<NextResponse> {
  await logAudit({ action: auditAction, outcome: 'failure', detail, actor_id: userId });
  return manageJson(body, status);
}
