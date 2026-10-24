import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { csrfCookieName, cookieOptionsForCsrf } from '@/lib/cookie';
import { requireCsrfOrDeny } from '@/lib/csrfMiddleware';

const STOCKIST_ADMIN_RATE_LIMIT_WINDOW_SECONDS = 600;
const STOCKIST_ADMIN_READ_LIMIT = 120;
const STOCKIST_ADMIN_MUTATION_LIMIT = 20;

type RotatedCsrfToken = {
  rotatedCsrfToken: string;
};

type MockCsrfDenyResponse = {
  status: number;
  _body: unknown;
  headers?: Headers | Record<string, string>;
};

function hasMockCsrfBody(value: unknown): value is MockCsrfDenyResponse {
  return typeof value === 'object' && value !== null && 'status' in value && '_body' in value;
}

/**
 * CSRF の確かめが回した token を返したかを判定する型ガード。
 *
 * @impl IMPL-STOCKIST-143
 * @design DD-STOCKIST-036
 * @remarks 共有の確かめは今、拒否なら応答を返し、通すなら何も返さない。回した token の入れ物は前の形の名残で、返ってきたらそれと分かるよう中身の形で見分ける。
 */
export function hasRotatedCsrfToken(value: unknown): value is RotatedCsrfToken {
  return typeof value === 'object' && value !== null && 'rotatedCsrfToken' in value;
}

/**
 * 変更の窓口で CSRF の token を確かめ、結果をそのまま返す。
 *
 * @impl IMPL-STOCKIST-144
 * @design DD-STOCKIST-036
 * @remarks 共有の確かめを窓口から直接呼ばず、このファイルを経由させて取扱店の窓口の守りを1か所に集める。2026-04-18 のレビューの P1（CSRF の抜け）を変更の4つの窓口で同じ形に直すため（ARC-STOCKIST-003）。
 */
export async function requireAdminStockistCsrf(): Promise<unknown> {
  return requireCsrfOrDeny();
}

/**
 * CSRF の確かめの結果を、拒否の応答（通すなら null）に変換する。
 *
 * @impl IMPL-STOCKIST-145
 * @design DD-STOCKIST-036
 * @remarks 本番の確かめが返すのは応答か何も無いかだけなので、通常は応答をそのまま返し何も無ければ通す。状態と本文と見出しだけの入れ物は、確かめを差し替えるテストが作る形で、本番の確かめは作らない。差し替えのテストでも拒否の応答として扱えるよう、同じ状態と本文と見出しの応答に直す。知らない形の値は通す。SEC-STOCKIST-004 の「判定できない時は拒む」は満たさない（DD-STOCKIST-036）。
 */
export function toCsrfDenyResponse(value: unknown): Response | null {
  if (!value || hasRotatedCsrfToken(value)) {
    return null;
  }

  if (value instanceof Response) {
    return value;
  }

  if (!hasMockCsrfBody(value)) {
    return null;
  }

  const response = NextResponse.json(value._body, { status: value.status });
  if (value.headers instanceof Headers) {
    value.headers.forEach((headerValue, headerName) => {
      response.headers.set(headerName, headerValue);
    });
  } else if (value.headers) {
    for (const [headerName, headerValue] of Object.entries(value.headers)) {
      response.headers.set(headerName, headerValue);
    }
  }

  return response;
}

/**
 * 回した CSRF の token を Cookie に付け直す。
 *
 * @impl IMPL-STOCKIST-146
 * @design DD-STOCKIST-037
 * @remarks 共有の確かめが前の形（回した token を返す）で結果を返した時の後片付けとして残す。今の共有の確かめはこの形を作らないので、本番の成功の応答には Cookie を付けない。
 */
export function applyRotatedCsrfCookie(response: NextResponse, csrfResult: unknown) {
  if (!hasRotatedCsrfToken(csrfResult)) {
    return;
  }

  response.cookies.set({
    name: csrfCookieName,
    value: csrfResult.rotatedCsrfToken,
    ...cookieOptionsForCsrf(0),
  });
}

async function enforceStockistAdminRateLimit(
  request: Request,
  actorId: string,
  endpoint: string,
  limit: number,
) {
  const ipRateLimitResponse = await enforceRateLimit({
    request,
    endpoint,
    limit,
    windowSeconds: STOCKIST_ADMIN_RATE_LIMIT_WINDOW_SECONDS,
  });
  if (ipRateLimitResponse) {
    return ipRateLimitResponse;
  }

  return enforceRateLimit({
    request,
    endpoint,
    limit,
    windowSeconds: STOCKIST_ADMIN_RATE_LIMIT_WINDOW_SECONDS,
    subject: actorId,
  });
}

/**
 * 一覧・1件の読みの回数を制限する（送り元と操作者の2本）。
 *
 * @impl IMPL-STOCKIST-147
 * @design DD-STOCKIST-038
 * @remarks 漏れた session で短い時間に大量の列挙をさせないため、読みと変更を別の枠で数える（SEC-STOCKIST-007）。
 */
export async function enforceAdminStockistReadRateLimit(request: Request, actorId: string) {
  return enforceStockistAdminRateLimit(request, actorId, 'admin:stockists:read', STOCKIST_ADMIN_READ_LIMIT);
}

/**
 * 作成・更新・切り替え・削除の回数を制限する（送り元と操作者の2本）。
 *
 * @impl IMPL-STOCKIST-148
 * @design DD-STOCKIST-038
 * @remarks 送り元の見出しを変えても操作者の枠で止まるように、2本を別々に数える（SEC-STOCKIST-007）。
 */
export async function enforceAdminStockistMutationRateLimit(request: Request, actorId: string) {
  return enforceStockistAdminRateLimit(request, actorId, 'admin:stockists:mutation', STOCKIST_ADMIN_MUTATION_LIMIT);
}