import { NextResponse, type NextRequest } from 'next/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { denyIfCsrfInvalid } from '@/features/cart/services/shopping-context';
import { ORDER_STATUS_ERROR_MESSAGES } from '@/lib/orders/status/status-messages';
import { parseOrderStatusLastFour } from '@/lib/orders/status/status-phone';
import {
  ORDER_STATUS_SESSION_COOKIE_NAME,
  createOrderStatusSession,
  orderStatusCookieOptions,
} from '@/lib/orders/status/status-session';
import { OrderStatusStoreError, getOrderStatusLink, verifyOrderStatusPhone } from '@/lib/orders/status/status-store';
import { isOrderStatusToken } from '@/lib/orders/status/status-token';
import type {
  OrderStatusErrorCode,
  OrderStatusErrorResponse,
  OrderStatusPhoneResult,
  OrderStatusVerifyResponse,
} from '@/lib/orders/status/status-types';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const RATE_LIMIT_ENDPOINT = 'order-status:verify';
// 送信元ごと: 10分に30回。注文ごと（DB で得た注文の UUID）: 15分に5回
const IP_LIMIT = { limit: 30, windowSeconds: 600 };
const ORDER_LIMIT = { limit: 5, windowSeconds: 900 };
// 確認できる期間の失敗の合計がここに達したら、その回の答えで欄を止める（DB の CHECK・store と同じ20回）
const LOCKED_AT_FAILED_ATTEMPTS = 20;

// 成功・拒否・例外の全ての応答に付ける
const RESPONSE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;

type ErrorDetail = Pick<OrderStatusErrorResponse, 'verifiable' | 'reason'>;

function errorResponse(
  status: number,
  code: OrderStatusErrorCode,
  detail: ErrorDetail = {},
  extraHeaders: Record<string, string> = {},
): NextResponse {
  const body: OrderStatusErrorResponse = { error: ORDER_STATUS_ERROR_MESSAGES[code], code, ...detail };
  return NextResponse.json(body, { status, headers: { ...RESPONSE_HEADERS, ...extraHeaders } });
}

function notFound(): NextResponse {
  return errorResponse(404, 'ORDER_STATUS_NOT_FOUND');
}

// 記録するのは固定の記号だけ（トークン・下4桁・DB の文・鍵・Cookie を出さない）
function internalError(): NextResponse {
  console.error('ORDER_STATUS_FAILED');
  return errorResponse(500, 'ORDER_STATUS_FAILED');
}

// 既存の CSRF・回数制限の応答を、この窓口の固定の JSON へ写す（Retry-After は保つ）
function fromGuardResponse(guard: Response): NextResponse {
  const retryAfter = guard.headers.get('Retry-After');
  const extraHeaders: Record<string, string> = retryAfter ? { 'Retry-After': retryAfter } : {};
  if (guard.status === 403) {
    return errorResponse(403, 'ORDER_STATUS_FORBIDDEN');
  }
  if (guard.status === 429) {
    return errorResponse(429, 'ORDER_STATUS_RATE_LIMITED', {}, extraHeaders);
  }
  if (guard.status === 503) {
    return errorResponse(503, 'ORDER_STATUS_TEMPORARILY_UNAVAILABLE', {}, extraHeaders);
  }
  return internalError();
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

// 本文は { lastFour: string } だけ。他のキーは禁止
async function readLastFour(request: NextRequest): Promise<string | null> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'lastFour') {
    return null;
  }
  return parseOrderStatusLastFour((body as { lastFour: unknown }).lastFour);
}

function respondToAnswer(answer: OrderStatusPhoneResult, orderId: string, token: string): NextResponse {
  switch (answer.result) {
    case 'ok': {
      if (answer.verifyUntil === null) {
        throw new OrderStatusStoreError('verify_order_status_phone');
      }
      // 期限の早い方（発行から24時間と DB の期限）の印を、成功の時だけ発行する
      const { value, session } = createOrderStatusSession({ orderId, token, verifyUntil: answer.verifyUntil });
      const body: OrderStatusVerifyResponse = { ok: true, expiresAt: new Date(session.exp * 1000).toISOString() };
      const response = NextResponse.json(body, { headers: RESPONSE_HEADERS });
      response.cookies.set(ORDER_STATUS_SESSION_COOKIE_NAME, value, orderStatusCookieOptions(token, session));
      return response;
    }
    case 'mismatch':
      // 20回目の不一致は、その答えで欄を止める
      return answer.failedAttempts >= LOCKED_AT_FAILED_ATTEMPTS
        ? errorResponse(400, 'ORDER_STATUS_MISMATCH', { verifiable: false, reason: 'locked' })
        : errorResponse(400, 'ORDER_STATUS_MISMATCH', { verifiable: true, reason: null });
    case 'locked':
      return errorResponse(423, 'ORDER_STATUS_LOCKED', { verifiable: false, reason: 'locked' });
    case 'unavailable':
      return errorResponse(409, 'ORDER_STATUS_UNAVAILABLE', { verifiable: false, reason: 'unavailable' });
    case 'expired':
      return errorResponse(410, 'ORDER_STATUS_EXPIRED', { verifiable: false, reason: 'expired' });
  }
}

/**
 * 電話番号の下4桁の確認（グループ E-5。共通の約束 C-3・P20）。ゲストにログインを求めない。
 * Origin は proxy が先に確かめる。ここでは CSRF → 送信元の枠 → トークンの形・存在 → 注文の枠 → 入力 → DB の比較 → 印の順。
 * 存在しない・隠す・形の違うトークンは同じ404。入力が不正でも注文の枠は消費するが、失敗の合計（DB）は増やさない。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  try {
    const { token } = await context.params;

    const csrf = await denyIfCsrfInvalid();
    if (csrf) {
      return fromGuardResponse(csrf);
    }

    const ipLimited = await enforceRateLimit({ request, endpoint: RATE_LIMIT_ENDPOINT, ...IP_LIMIT });
    if (ipLimited) {
      return fromGuardResponse(ipLimited);
    }

    if (!isOrderStatusToken(token)) {
      return notFound();
    }
    const store = await createServiceRoleClient();
    const link = await getOrderStatusLink(store, token);
    if (!link) {
      return notFound();
    }

    // 注文の枠の subject は、DB で得た注文の UUID（トークンや利用者の入力は使わない）
    const orderLimited = await enforceRateLimit({
      request,
      endpoint: RATE_LIMIT_ENDPOINT,
      ...ORDER_LIMIT,
      subject: link.orderId,
    });
    if (orderLimited) {
      return fromGuardResponse(orderLimited);
    }

    const lastFour = await readLastFour(request);
    if (lastFour === null) {
      return errorResponse(400, 'ORDER_STATUS_INPUT_INVALID');
    }

    const answer = await verifyOrderStatusPhone(store, { token, lastFour });
    if (answer === null) {
      // 比較の間に消えた・隠された
      return notFound();
    }
    return respondToAnswer(answer, link.orderId, token);
  } catch (error) {
    return failure(error);
  }
}
