import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  cookieOptionsForSession,
  generateSessionId,
  sessionCookieName,
} from '@/lib/cookie';
import { hasExplicitOriginConfig, isAllowedOrigin } from '@/lib/redirect';

// SameSite=Lax は多層防御であって設計上の制御ではない（OWASP CSRF Cheat Sheet）ので、
// 状態を変える API は Origin も見る。検査は POST/PUT/PATCH/DELETE 限定なので
// OAuth コールバック等の GET には影響しない。
//
// 対象は /api 配下の状態変更リクエスト**すべて**。以前は保護するパスを列挙する
// 許可リストだったが、それでは新しく作ったルートが黙って無防備になる（実際に
// /api/contact 配下が漏れ、/api/contact/threads/[id]/reply は Origin 検査も
// CSRF トークンも無い状態だった）。セキュリティ制御を opt-in で回すと漏れが
// 検知されないので、既定を「検査する」にして除外だけを明示する。
//
// 除外してよいのは「Origin を持たない正当な外部 POST」で、かつ別の手段で
// 発信元を検証しているものだけ。増やすときはその検証手段をコメントに書くこと。
const ORIGIN_CHECK_PATH_PREFIX = '/api';
const ORIGIN_CHECK_EXEMPT_PREFIXES = [
  '/api/webhook',         // Stripe（constructEvent）・Resend の配達の知らせ（Svix）: 署名検証
  '/api/contact/inbound', // Resend: Svix 署名検証
  '/api/cron',            // スケジューラ: Bearer シークレット
] as const;

/**
 * パスの前方一致をセグメント境界で判定する。
 *
 * 素の startsWith だと '/api' が '/apidocs' に、'/api/webhook' が
 * '/api/webhookfoo' に当たる。前者は検査漏れ、後者は除外の誤爆で、
 * どちらも Origin 検査をすり抜ける経路を作る。
 */
function matchesPathSegment(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** 許可オリジン未設定の警告はプロセスにつき 1 回。毎リクエスト出すとログが埋まる。 */
let unconfiguredOriginWarned = false;

function generateNonce(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildCsp(nonce: string): string {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseOrigin = (() => {
    if (!supabaseUrl) return '';

    try {
      return new URL(supabaseUrl).origin;
    } catch {
      return '';
    }
  })();

  const connectSources = [
    "'self'",
    ...(isDevelopment ? ['ws:', 'wss:'] : []),
    supabaseOrigin,
    'https://*.supabase.co',
    'https://challenges.cloudflare.com',
    'https://api.stripe.com',
    'https://r.stripe.com',
    'https://m.stripe.network',
    'https://q.stripe.com',
  ].filter(Boolean).join(' ');

  const imgSources = [
    "'self'",
    'data:',
    'https://placehold.co',
    'https://readdy.ai',
    'https://*.readdy.ai',
    'https://*.supabase.co',
    'https://q.stripe.com',
    'https://*.stripe.com',
  ].join(' ');

  // React の style={{}} は style *属性* になる。属性は nonce では許可できず
  // 'unsafe-inline' しか手段がないため、style-src には常に付ける。
  // 代わりに style-src-elem を分けて <style> / <link> は 'self' のまま締める。
  // 属性セレクタ + background-image で値を抜く CSS exfiltration は攻撃者が
  // <style> を注入できることが前提なので、要素側さえ塞げば成立しない。
  const styleSources = ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'].join(' ');

  const styleElemSources = [
    "'self'",
    // dev の Next（Turbopack HMR）は <style> をインラインで差し込む
    ...(isDevelopment ? ["'unsafe-inline'"] : []),
    'https://cdn.jsdelivr.net',
  ].join(' ');

  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
    'https://cdn.jsdelivr.net',
    'https://challenges.cloudflare.com',
    'https://js.stripe.com',
  ].join(' ');

  return [
    "default-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `img-src ${imgSources}`,
    `style-src ${styleSources}`,
    `style-src-elem ${styleElemSources}`,
    "font-src 'self' https://cdn.jsdelivr.net",
    `script-src ${scriptSources}`,
    "frame-src https://challenges.cloudflare.com https://js.stripe.com https://hooks.stripe.com https://www.google.com https://maps.google.com",
    `connect-src ${connectSources}`,
    "manifest-src 'self'",
    'upgrade-insecure-requests',
    'block-all-mixed-content',
  ].join('; ');
}

/**
 * 許可オリジンが未設定のときだけ使う退避。リクエストヘッダから期待値を組み立てる。
 *
 * クライアントが指定しうる値（x-forwarded-host）を自分で信頼するので検査としては
 * 循環しているが、ブラウザからは迂回できない。X-Forwarded-Host はカスタムヘッダなので
 * クロスサイトの fetch は preflight が必要になり、フォーム POST では付けられない。
 */
function fallbackRequestOrigin(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

function isProtectedStateChangingApiRequest(request: NextRequest): boolean {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) {
    return false;
  }

  const pathname = request.nextUrl.pathname;
  if (!matchesPathSegment(pathname, ORIGIN_CHECK_PATH_PREFIX)) {
    return false;
  }

  return !ORIGIN_CHECK_EXEMPT_PREFIXES.some((prefix) => matchesPathSegment(pathname, prefix));
}

/**
 * OWASP CSRF Cheat Sheet に従い、Origin / Referer を「既知の」オリジンと照合する。
 *
 * 期待値は環境変数の許可リスト（APP_ALLOWED_ORIGINS ほか。@/lib/redirect と共通）から取る。
 * 以前はリクエストヘッダから期待値を組み立てており、攻撃者が指定できる値を
 * 自分で信頼する形になっていた。
 */
function isAllowedOriginRequest(request: NextRequest): boolean {
  const originHeader = request.headers.get('origin');
  const refererHeader = request.headers.get('referer');

  const candidate = (() => {
    if (originHeader) return originHeader;
    if (!refererHeader) return null;
    try {
      return new URL(refererHeader).origin;
    } catch {
      return null;
    }
  })();

  // Origin も Referer も無い状態変更リクエストは通さない。
  if (!candidate) {
    return false;
  }

  if (hasExplicitOriginConfig()) {
    return isAllowedOrigin(candidate);
  }

  // 許可リストが未設定。ここで全拒否すると設定漏れだけで機能停止するため退避する。
  // 状態変更リクエストのたびに出すとログが埋まるので、プロセスにつき 1 回だけ知らせる。
  if (!unconfiguredOriginWarned) {
    unconfiguredOriginWarned = true;
    console.warn(
      '[proxy] APP_ALLOWED_ORIGINS 等が未設定のため、Origin 検査をリクエスト由来の値で行っています。' +
        '本番では許可オリジンを明示してください。',
    );
  }
  try {
    return new URL(candidate).origin === fallbackRequestOrigin(request);
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest) {
  if (isProtectedStateChangingApiRequest(request) && !isAllowedOriginRequest(request)) {
    return NextResponse.json({ error: 'Forbidden origin' }, { status: 403 });
  }

  const nonce = generateNonce();
  const csp = buildCsp(nonce);

  // CSP はリクエストヘッダーにも載せる。Next.js はここから nonce を読み取って
  // 自前のインラインスクリプト（ハイドレーション用）に nonce 属性を付与する。
  // レスポンスにしか設定しないと Next は nonce の存在を知れず、本番ビルドで
  // 全インラインスクリプトが CSP に弾かれてハイドレートしなくなる。
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  let sessionId = request.cookies.get(sessionCookieName)?.value;
  if (!sessionId) {
    sessionId = generateSessionId();
    response.cookies.set(sessionCookieName, sessionId, cookieOptionsForSession(SESSION_COOKIE_MAX_AGE));
  }

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  response.headers.set('x-nonce', nonce);

  return response;
}

export const config = {
  matcher: ['/:path*'],
};