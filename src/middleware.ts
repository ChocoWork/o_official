import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function generateNonce(): string {
  // Use Web Crypto API for Edge Runtime compatibility
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function buildCsp(nonce: string) {
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
  ].filter(Boolean).join(' ');

  return [
    "default-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: https://placehold.co https://*.supabase.co",
    `style-src 'self' https://cdn.jsdelivr.net`,
    "font-src 'self' https://cdn.jsdelivr.net",
    `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net https://challenges.cloudflare.com`,
    "frame-src https://challenges.cloudflare.com",
    `connect-src ${connectSources}`,
    "manifest-src 'self'",
    "upgrade-insecure-requests",
    "block-all-mixed-content",
  ].join('; ');
}

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const nonce = generateNonce();

  response.headers.set('Content-Security-Policy', buildCsp(nonce));
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  response.headers.set('x-nonce', nonce);

  return response;
}

export const config = {
  matcher: ['/:path*'],
};
