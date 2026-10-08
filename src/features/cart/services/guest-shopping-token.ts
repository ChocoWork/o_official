import type { NextResponse } from 'next/server';
import { extractCookieValue } from '@/lib/auth/request-token';
import {
  cartCookieName,
  clearCookieOptions,
  cookieOptionsForGuestShopping,
  wishlistCookieName,
} from '@/lib/cookie';
import { tokenHashSha256 } from '@/lib/hash';

export type GuestShoppingKind = 'cart' | 'wishlist';
export type GuestShoppingTokens = { cartToken: string | null; wishlistToken: string | null };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function cookieNameOf(kind: GuestShoppingKind): string {
  return kind === 'cart' ? cartCookieName : wishlistCookieName;
}

/** 256 ビットの乱数を base64url（43文字）にした印。DB には SHA-256 だけを入れる（設計書 4-1） */
export function generateGuestShoppingToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 形の正しい印だけを返す。壊れた値は「印なし」として扱い、DB に問い合わせない */
export function parseGuestShoppingToken(value: string | null | undefined): string | null {
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
}

export function hashGuestShoppingToken(token: string): Promise<string> {
  return tokenHashSha256(token);
}

export function readGuestShoppingTokens(cookieHeader: string | null): GuestShoppingTokens {
  return {
    cartToken: parseGuestShoppingToken(extractCookieValue(cookieHeader, cartCookieName)),
    wishlistToken: parseGuestShoppingToken(extractCookieValue(cookieHeader, wishlistCookieName)),
  };
}

export function setGuestShoppingCookie(res: NextResponse, kind: GuestShoppingKind, token: string): void {
  res.cookies.set({ name: cookieNameOf(kind), value: token, ...cookieOptionsForGuestShopping() });
}

/** ログインで合わせ終えた時とログアウトの時に、この端末のゲストの印を2つとも消す（設計書 4-1・4-3） */
export function clearGuestShoppingCookies(res: NextResponse): void {
  for (const name of [cartCookieName, wishlistCookieName]) {
    res.cookies.set({ name, value: '', ...clearCookieOptions() });
  }
}
