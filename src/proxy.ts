import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  cookieOptionsForSession,
  generateSessionId,
  sessionCookieName,
} from '@/lib/cookie';

const STATE_CHANGING_PATH_PREFIXES = ['/api/cart', '/api/checkout/create-session', '/api/checkout/complete', '/api/wishlist'] as const;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function generateNonce(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildCsp(nonce: string): string {
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
    supabaseOrigin,
    'https://*.supabase.co',
    'https://challenges.cloudflare.com',
    'https://api.stripe.com',
    'https://r.stripe.com',
    'https://m.stripe.network',
    'https://q.stripe.com',
  ].filter(Boolean).join(' ');

  return [
    "default-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: https://placehold.co https://*.supabase.co https://q.stripe.com https://*.stripe.com",
    "style-src 'self' https://cdn.jsdelivr.net",
    "font-src 'self' https://cdn.jsdelivr.net",
    `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net https://challenges.cloudflare.com https://js.stripe.com`,
    "frame-src https://challenges.cloudflare.com https://js.stripe.com https://hooks.stripe.com https://www.google.com https://maps.google.com",
    `connect-src ${connectSources}`,
    "manifest-src 'self'",
    'upgrade-insecure-requests',
    'block-all-mixed-content',
  ].join('; ');
}

function resolveRequestOrigin(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

function isProtectedStateChangingApiRequest(request: NextRequest): boolean {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) {
    return false;
  }

  const pathname = request.nextUrl.pathname;
  return STATE_CHANGING_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isSameOriginRequest(request: NextRequest): boolean {
  const expectedOrigin = resolveRequestOrigin(request);
  const originHeader = request.headers.get('origin');
  const refererHeader = request.headers.get('referer');

  if (originHeader) {
    return originHeader === expectedOrigin;
  }

  if (refererHeader) {
    try {
      return new URL(refererHeader).origin === expectedOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

export function proxy(request: NextRequest) {
  if (isProtectedStateChangingApiRequest(request) && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'Forbidden origin' }, { status: 403 });
  }

  const response = NextResponse.next();
  const nonce = generateNonce();

  let sessionId = request.cookies.get(sessionCookieName)?.value;
  if (!sessionId) {
    sessionId = generateSessionId();
    response.cookies.set(sessionCookieName, sessionId, cookieOptionsForSession(SESSION_COOKIE_MAX_AGE));
  }

  response.headers.set('Content-Security-Policy', buildCsp(nonce));
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