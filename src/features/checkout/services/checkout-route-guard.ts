import { NextRequest, NextResponse } from 'next/server';
import { cookieOptionsForCsrf, csrfCookieName } from '@/lib/cookie';

/** Stripe の Checkout Session の ID（受け付け・入り直しの要求で受け取る） */
export const CHECKOUT_SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]+$/;

export type CheckoutRateLimit = { endpoint: string; limit: number; windowSeconds: number };

export type CheckoutGuardConfig = {
  /** IP 単位の上限。時間枠ごとに数え直すので、キーは時間枠ごとに分ける */
  ipLimits: readonly CheckoutRateLimit[];
  /** session_id Cookie 単位の上限（Cookie を捨てれば回避できるので、1つのブラウザでの連打を止めるためのもの） */
  sessionLimit: CheckoutRateLimit;
};

export type CheckoutGuardResult =
  | {
      ok: true;
      sessionId: string;
      clientIp: string | null;
      userAgent: string | null;
      /** CSRF の合言葉が入れ替わったときに、応答へ新しい Cookie を付ける */
      finish(response: NextResponse): NextResponse;
    }
  | { ok: false; response: Response };

/** 割引コードの「適用」。コードの総当たりを止めるため、create-session と同じ上限にする */
export const PROMOTION_CODE_GUARD: CheckoutGuardConfig = {
  ipLimits: [
    { endpoint: 'checkout:promotion-code:ip-10s', limit: 10, windowSeconds: 10 },
    { endpoint: 'checkout:promotion-code:ip-10m', limit: 60, windowSeconds: 600 },
  ],
  sessionLimit: { endpoint: 'checkout:promotion-code', limit: 10, windowSeconds: 60 },
};

/** 「注文する」の受け付け */
export const PLACE_ORDER_GUARD: CheckoutGuardConfig = {
  ipLimits: [
    { endpoint: 'checkout:place-order:ip-10s', limit: 10, windowSeconds: 10 },
    { endpoint: 'checkout:place-order:ip-10m', limit: 60, windowSeconds: 600 },
  ],
  sessionLimit: { endpoint: 'checkout:place-order', limit: 10, windowSeconds: 60 },
};

/** 入り直し。決済の画面を開くたびに呼ぶので、ほかより緩める */
export const RESUME_GUARD: CheckoutGuardConfig = {
  ipLimits: [
    { endpoint: 'checkout:resume:ip-10s', limit: 20, windowSeconds: 10 },
    { endpoint: 'checkout:resume:ip-10m', limit: 120, windowSeconds: 600 },
  ],
  sessionLimit: { endpoint: 'checkout:resume', limit: 20, windowSeconds: 60 },
};

// E2E はすべてのリクエストが 127.0.0.1 から来るので、本番の上限では足りない。
// scripts/e2e-server.mjs が起動するサーバーだけ、この倍率で IP 単位の上限を引き上げる（FREQ-362）。
const IP_LIMIT_MULTIPLIER_ENV = 'E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER';
const IP_LIMIT_MULTIPLIER_MAX = 30;
const RATE_LIMITED_MESSAGE =
  'アクセスが集中しているため、手続きを一時的に止めています。少し時間をおいてから、もう一度お試しください。';

/**
 * E2E 用の倍率を決める（FREQ-362）。
 *
 * 引き上げは Vercel 以外（手元の E2E サーバー）でだけ効かせる。E2E は next start で動くので
 * NODE_ENV では区別できない。Vercel に誤って環境変数を設定しても本番の上限は緩めず、
 * 倍率にも上限を設ける。
 */
export function resolveCheckoutIpLimitMultiplier(): number {
  const raw = process.env[IP_LIMIT_MULTIPLIER_ENV];
  if (process.env.VERCEL === '1' || !raw || !/^[0-9]+$/.test(raw)) {
    return 1;
  }

  return Math.min(Math.max(Number(raw), 1), IP_LIMIT_MULTIPLIER_MAX);
}

export function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

type CsrfDenyResponse = {
  status: number;
  _body: unknown;
  headers?: Headers | Record<string, string>;
};

function isCsrfDenyResponse(value: unknown): value is CsrfDenyResponse {
  return typeof value === 'object' && value !== null && 'status' in value && '_body' in value;
}

function hasRotatedCsrfToken(value: unknown): value is { rotatedCsrfToken: string } {
  return typeof value === 'object' && value !== null && 'rotatedCsrfToken' in value;
}

function toCsrfDenyResponse(csrfResult: CsrfDenyResponse): Response {
  const response = NextResponse.json(csrfResult._body, { status: csrfResult.status });
  if (csrfResult.headers instanceof Headers) {
    csrfResult.headers.forEach((value, name) => response.headers.set(name, value));
  } else if (csrfResult.headers) {
    for (const [name, value] of Object.entries(csrfResult.headers)) {
      response.headers.set(name, value);
    }
  }
  return response;
}

/**
 * 上限到達（429）を、時間をおいて試すよう案内する応答に置き換える。
 * 回数制限を判定できなかった応答（503）は上限到達ではないので、そのまま返す。
 */
function toRateLimitedResponse(limited: Response): Response {
  if (limited.status !== 429) {
    return limited;
  }

  const retryAfter = limited.headers?.get?.('Retry-After');
  return NextResponse.json(
    { error: 'rate_limited', message: RATE_LIMITED_MESSAGE, retryable: true },
    { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : undefined },
  );
}

/**
 * 決済の新しい入口（割引コード・受け付け・入り直し）の共通の守り（グループ F 設計書 6-1）。
 *
 * ゲスト購入を受ける公開の入口なので、推測できない session_id Cookie でお客様を分け、
 * IP とセッションの二段で回数を数え、ログイン客には CSRF の合言葉を求める。
 * 送信元（Origin）の確かめは src/proxy.ts が /api の全 POST に掛ける。
 */
export async function guardCheckoutPost(req: NextRequest, config: CheckoutGuardConfig): Promise<CheckoutGuardResult> {
  const sessionId = req.cookies.get('session_id')?.value;
  if (!sessionId) {
    return { ok: false, response: NextResponse.json({ error: 'session_not_found' }, { status: 400 }) };
  }

  const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
  const multiplier = resolveCheckoutIpLimitMultiplier();
  for (const { endpoint, limit, windowSeconds } of config.ipLimits) {
    const limited = await enforceRateLimit({ request: req, endpoint, limit: limit * multiplier, windowSeconds });
    if (limited) {
      return { ok: false, response: toRateLimitedResponse(limited) };
    }
  }

  const bySession = await enforceRateLimit({
    request: req,
    endpoint: config.sessionLimit.endpoint,
    limit: config.sessionLimit.limit,
    windowSeconds: config.sessionLimit.windowSeconds,
    subject: sessionId,
  });
  if (bySession) {
    return { ok: false, response: toRateLimitedResponse(bySession) };
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  // requireCsrfOrDeny は拒否時に NextResponse を返すため、実物の Response も判定する。
  if (csrfResult instanceof Response) {
    return { ok: false, response: csrfResult };
  }
  if (isCsrfDenyResponse(csrfResult)) {
    return { ok: false, response: toCsrfDenyResponse(csrfResult) };
  }

  return {
    ok: true,
    sessionId,
    clientIp: getClientIp(req),
    userAgent: req.headers.get('user-agent'),
    finish(response) {
      if (hasRotatedCsrfToken(csrfResult)) {
        response.cookies.set({ name: csrfCookieName, value: csrfResult.rotatedCsrfToken, ...cookieOptionsForCsrf(0) });
      }
      return response;
    },
  };
}
