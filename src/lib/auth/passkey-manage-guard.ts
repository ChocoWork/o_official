import { NextResponse } from 'next/server';
import { logAudit } from '@/lib/audit';
import { withNoStore } from '@/lib/http/no-store';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import { extractAuthToken } from '@/lib/auth/request-token';

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

/**
 * 一覧・名前の変更・削除の入口の確かめ。回数の制限（IP ごと 60回／600秒）→ 認証 → CSRF（状態を変える窓口だけ）の順。
 *
 * @impl IMPL-AUTH-292
 * @design DD-AUTH-057
 * @remarks 外れたら `{ ok: false, response }`（GoTrue はまだ呼ばれていない）。回数の枠は窓口ごとに分ける（一覧の読みで削除の枠を使い切らないため）。
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
