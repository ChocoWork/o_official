import 'server-only';
import crypto from 'crypto';
import { getBaseCookieOptions } from '@/lib/cookie';
import { isOrderStatusToken } from '@/lib/orders/status/status-token';
import type { OrderStatusSession } from '@/lib/orders/status/status-types';

/**
 * 電話番号の下4桁で確かめた印（Cookie）。形は base64url(JSON).base64url(HMAC-SHA256)（共通の約束 C-2）。
 * login-2fa-session.ts と同じ組み立て（署名 → 照合の順）だが、あちらの関数は呼ばない。
 * 生のトークンも電話番号も入れない。トークンは SHA-256 の16進の先頭16文字だけを入れ、読む側が渡されたトークンから作り直して比べる。
 * Cookie は注文ごとの path で出し、別の注文へ移しても通らない（注文・トークン・DB の期限を読む時に全て照合する）。
 */
export const ORDER_STATUS_SESSION_COOKIE_NAME = 'sb-order-status';
export const ORDER_STATUS_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

const PURPOSE = 'order_status';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_HASH_PREFIX_PATTERN = /^[0-9a-f]{16}$/;
// segment はちょうど2つ。パディング（=）・記号・余分な segment をここで落とす
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SIGNATURE_BYTES = 32;

/** 印を作れない・確かめられない。鍵・トークン・注文を文に入れない（理由は reason にだけ持つ） */
export class OrderStatusSessionError extends Error {
  constructor(readonly reason: 'secret_missing' | 'input_invalid') {
    super('order status session unavailable');
    this.name = 'OrderStatusSessionError';
  }
}

// 鍵は呼び出しのたびに読む（import 時に固定しない）。専用の鍵 → JWT_SECRET の順で、空文字は無いものとして扱う
function secret(): string {
  const value = process.env.ORDER_STATUS_SESSION_SECRET || process.env.JWT_SECRET;
  if (!value) {
    throw new OrderStatusSessionError('secret_missing');
  }
  return value;
}

function sign(payloadSegment: string): Buffer {
  return crypto.createHmac('sha256', secret()).update(payloadSegment).digest();
}

function tokenHashPrefix(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * 印を作る。exp は「発行から24時間」と「DB の期限」の早い方（秒に切り捨てて比べる）。exp が iat 以前（期限がもう無い）なら作らない。
 */
export function createOrderStatusSession(input: {
  orderId: string;
  token: string;
  verifyUntil: string;
  now?: Date;
}): { value: string; session: OrderStatusSession } {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const verifyUntilSeconds = Math.floor(Date.parse(input.verifyUntil) / 1000);
  if (!UUID_PATTERN.test(input.orderId) || !isOrderStatusToken(input.token) || !Number.isFinite(iat) || !Number.isFinite(verifyUntilSeconds)) {
    throw new OrderStatusSessionError('input_invalid');
  }
  const exp = Math.min(iat + ORDER_STATUS_SESSION_MAX_AGE_SECONDS, verifyUntilSeconds);
  if (exp <= iat) {
    throw new OrderStatusSessionError('input_invalid');
  }

  const session: OrderStatusSession = {
    purpose: PURPOSE,
    orderId: input.orderId,
    tokenHashPrefix: tokenHashPrefix(input.token),
    iat,
    exp,
  };
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  return { value: `${payload}.${sign(payload).toString('base64url')}`, session };
}

/**
 * 印を読む。署名・purpose・注文・トークン・時刻・DB の期限を全て照合し、1つでも合わなければ null。
 * iat <= 今 < exp で、exp - iat は24時間以下、DB の期限が未来で exp は DB の期限以前
 * （DB の期限が後から延びても、発行済みの印の exp は延びない。短くなれば印は通らない）。
 * 鍵が無い時は、値が来ていても確かめられないので OrderStatusSessionError を投げる（未確認として黙って通さない）。
 */
export function readOrderStatusSession(
  value: string | undefined,
  input: { orderId: string; token: string; verifyUntil: string | null; now?: Date },
): OrderStatusSession | null {
  if (typeof value !== 'string' || !COOKIE_VALUE_PATTERN.test(value)) {
    return null;
  }
  const [payloadSegment, signatureSegment] = value.split('.');

  const actual = Buffer.from(signatureSegment, 'base64url');
  if (actual.length !== SIGNATURE_BYTES || actual.toString('base64url') !== signatureSegment) {
    return null;
  }
  if (!crypto.timingSafeEqual(sign(payloadSegment), actual)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 5) {
    return null;
  }
  const { purpose, orderId, tokenHashPrefix: prefix, iat, exp } = parsed as Record<string, unknown>;
  if (
    purpose !== PURPOSE ||
    typeof orderId !== 'string' ||
    !UUID_PATTERN.test(orderId) ||
    typeof prefix !== 'string' ||
    !TOKEN_HASH_PREFIX_PATTERN.test(prefix) ||
    typeof iat !== 'number' ||
    !Number.isSafeInteger(iat) ||
    typeof exp !== 'number' ||
    !Number.isSafeInteger(exp)
  ) {
    return null;
  }

  const now = (input.now ?? new Date()).getTime();
  const nowSeconds = Math.floor(now / 1000);
  if (iat > nowSeconds || nowSeconds >= exp || exp - iat > ORDER_STATUS_SESSION_MAX_AGE_SECONDS) {
    return null;
  }

  if (orderId !== input.orderId || !isOrderStatusToken(input.token) || prefix !== tokenHashPrefix(input.token)) {
    return null;
  }

  if (input.verifyUntil === null) {
    return null;
  }
  const verifyUntil = Date.parse(input.verifyUntil);
  if (!Number.isFinite(verifyUntil) || verifyUntil <= now || exp > Math.floor(verifyUntil / 1000)) {
    return null;
  }

  return { purpose: PURPOSE, orderId, tokenHashPrefix: prefix, iat, exp };
}

/**
 * 印の Cookie の属性。path をこの注文の窓口（/api/order-status/{token}）に絞り、sameSite は strict、Domain は指定しない。
 * 24時間と DB の期限の早い方で切れる（maxAge と expires は exp と同じ時刻）。
 */
export function orderStatusCookieOptions(
  token: string,
  session: OrderStatusSession,
): { httpOnly: true; secure: boolean; sameSite: 'strict'; path: string; maxAge: number; expires: Date } {
  if (!isOrderStatusToken(token)) {
    throw new OrderStatusSessionError('input_invalid');
  }
  return {
    httpOnly: true,
    secure: getBaseCookieOptions().secure,
    sameSite: 'strict',
    path: `/api/order-status/${token}`,
    maxAge: session.exp - session.iat,
    expires: new Date(session.exp * 1000),
  };
}
