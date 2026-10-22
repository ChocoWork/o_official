import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { extractAuthToken } from '@/lib/auth/request-token';
import { refreshCookieName } from '@/lib/cookie';
import { buildCustomerOrderPrivateView } from '@/lib/orders/customer-order-view';
import { ORDER_STATUS_ERROR_MESSAGES } from '@/lib/orders/status/status-messages';
import { ORDER_STATUS_SESSION_COOKIE_NAME, readOrderStatusSession } from '@/lib/orders/status/status-session';
import {
  OrderStatusStoreError,
  getOrderStatusLink,
  loadOrderStatusPrivateInput,
  orderStatusVerification,
  type OrderStatusStore,
} from '@/lib/orders/status/status-store';
import { isOrderStatusToken } from '@/lib/orders/status/status-token';
import type { OrderStatusErrorCode, OrderStatusErrorResponse, OrderStatusLink, OrderStatusPrivateResponse } from '@/lib/orders/status/status-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

// 成功・拒否・例外の全ての応答に付ける
const RESPONSE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;

function errorResponse(status: number, code: OrderStatusErrorCode, extraHeaders: Record<string, string> = {}): NextResponse {
  const body: OrderStatusErrorResponse = { error: ORDER_STATUS_ERROR_MESSAGES[code], code };
  return NextResponse.json(body, { status, headers: { ...RESPONSE_HEADERS, ...extraHeaders } });
}

function notFound(): NextResponse {
  return errorResponse(404, 'ORDER_STATUS_NOT_FOUND');
}

// 記録するのは固定の記号だけ（トークン・印・DB の文・鍵・個人情報を出さない）
function internalError(): NextResponse {
  console.error('ORDER_STATUS_FAILED');
  return errorResponse(500, 'ORDER_STATUS_FAILED');
}

// DB 専用の誤り（ORDER_STATUS_ARGUMENT_INVALID / 22023 と ORDER_NOT_FOUND / P0002）は store の cause にだけ入っている
function databaseErrorKind(error: OrderStatusStoreError): 'argument' | 'not_found' | null {
  const { message, code } = (typeof error.cause === 'object' && error.cause !== null ? error.cause : {}) as {
    message?: unknown;
    code?: unknown;
  };
  const text = typeof message === 'string' ? message : '';
  if (text.includes('ORDER_STATUS_ARGUMENT_INVALID') || code === '22023') return 'argument';
  if (text.includes('ORDER_NOT_FOUND') || code === 'P0002') return 'not_found';
  return null;
}

function failure(error: unknown): NextResponse {
  const kind = error instanceof OrderStatusStoreError ? databaseErrorKind(error) : null;
  if (kind === 'argument') return errorResponse(400, 'ORDER_STATUS_INPUT_INVALID');
  if (kind === 'not_found') return notFound();
  return internalError();
}

// 認可されていない答え。確認できるかどうか（verifiable / reason）以外は何も足さない
function noAccess(link: OrderStatusLink): NextResponse {
  const body: OrderStatusPrivateResponse = { access: 'none', ...orderStatusVerification(link) };
  return NextResponse.json(body, { headers: RESPONSE_HEADERS });
}

// ログインの印を持ち込んだのに確かめられなかった。401 で更新の機会を作る（公開の部分は呼び出し側が残す）
function authRequired(link: OrderStatusLink): NextResponse {
  const body: OrderStatusPrivateResponse & OrderStatusErrorResponse = {
    access: 'none',
    ...orderStatusVerification(link),
    error: 'Unauthorized',
    code: 'ORDER_STATUS_AUTH_REQUIRED',
  };
  return NextResponse.json(body, { status: 401, headers: RESPONSE_HEADERS });
}

// 認可の後だけ呼ぶ。個人情報の組み立てが失敗したら呼び出し側の catch が 500 にする（空の成功にしない）
async function grantedResponse(
  store: OrderStatusStore,
  orderId: string,
  grant: { access: 'member'; expiresAt: null } | { access: 'verified'; expiresAt: string },
): Promise<NextResponse> {
  const input = await loadOrderStatusPrivateInput(store, orderId);
  if (input === null) {
    return notFound();
  }
  const data = buildCustomerOrderPrivateView(input);
  const body: OrderStatusPrivateResponse =
    grant.access === 'verified'
      ? { access: 'verified', data, expiresAt: grant.expiresAt }
      : { access: 'member', data, expiresAt: null };
  return NextResponse.json(body, { headers: RESPONSE_HEADERS });
}

/**
 * 個人情報の読み出し（グループ E-5。共通の約束 C-3・P25）。トークンの形 → リンク → 有効な確認印 → 持ち主の認証 → none の順。
 * 確認印か持ち主のどちらかで認可されたら読む。確認印が有効なら、古いログイン印が残っていても401にしない。
 * ログインの印の持ち込みは、Authorization・アクセスの Cookie・refresh の Cookie の有無だけで見る（中身は未検証のまま信用しない）。
 * 認可の前に個人情報の表と完全な返品は読まない。query で認可の情報は受け取らない。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  try {
    const { token } = await context.params;
    if (!isOrderStatusToken(token)) {
      return notFound();
    }
    const store = await createServiceRoleClient();
    const link = await getOrderStatusLink(store, token);
    if (!link) {
      return notFound();
    }

    // DB の期限と印の期限は毎回照合する（延びた期限でも、縮んだ期限でも、古い印を通さない）
    const stamp = readOrderStatusSession(request.cookies.get(ORDER_STATUS_SESSION_COOKIE_NAME)?.value, {
      orderId: link.orderId,
      token,
      verifyUntil: link.verifyUntil,
    });
    if (stamp) {
      return await grantedResponse(store, link.orderId, { access: 'verified', expiresAt: new Date(stamp.exp * 1000).toISOString() });
    }

    const loginMarkPresent = Boolean(extractAuthToken(request)) || Boolean(request.cookies.get(refreshCookieName)?.value);
    if (!loginMarkPresent) {
      return noAccess(link);
    }

    const auth = await authenticateRequest(request);
    if (!auth.ok) {
      // 確認できなかった（unavailable）は、更新を誘う 401 にせず 503 にする
      return auth.reason === 'unavailable'
        ? errorResponse(503, 'ORDER_STATUS_TEMPORARILY_UNAVAILABLE', { 'Retry-After': '30' })
        : authRequired(link);
    }
    if (link.customerId !== null && auth.claims.sub === link.customerId) {
      // 持ち主は、確認の期限に関係なく見られる
      return await grantedResponse(store, link.orderId, { access: 'member', expiresAt: null });
    }
    return noAccess(link);
  } catch (error) {
    return failure(error);
  }
}
