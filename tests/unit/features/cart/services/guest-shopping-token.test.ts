/** @jest-environment node */
import { NextResponse } from 'next/server';
import {
  clearGuestShoppingCookies,
  generateGuestShoppingToken,
  hashGuestShoppingToken,
  parseGuestShoppingToken,
  readGuestShoppingTokens,
  setGuestShoppingCookie,
} from '@/features/cart/services/guest-shopping-token';

const originalResponseJson = Response.json;
beforeAll(() => {
  // 共通の node-fetch ポリフィルに静的 json が無いため、この試験内だけ実際の応答を扱えるように補う。
  Response.json = (body: unknown, init?: ResponseInit): Response => {
    const headers = new Headers(init?.headers);
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify(body), { ...init, headers });
  };
});
afterAll(() => {
  Response.json = originalResponseJson;
});

describe('ゲストの印', () => {
  test('256ビットの乱数を43文字の base64url にする', () => {
    const token = generateGuestShoppingToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateGuestShoppingToken()).not.toBe(token);
  });

  test('形の違う印は印なしとして扱う', () => {
    expect(parseGuestShoppingToken('x'.repeat(43))).toBe('x'.repeat(43));
    for (const value of [undefined, null, '', 'short', 'x'.repeat(44), `${'x'.repeat(42)}=`, `${'x'.repeat(42)}/`]) {
      expect(parseGuestShoppingToken(value)).toBeNull();
    }
  });

  test('ハッシュは SHA-256 の64桁の16進', async () => {
    expect(await hashGuestShoppingToken('a'.repeat(43))).toMatch(/^[0-9a-f]{64}$/);
  });

  test('Cookie の見出しから2つの印を読み、形の違う値は空にする', () => {
    const cart = 'c'.repeat(43);
    expect(readGuestShoppingTokens(`session_id=s; cart=${cart}; wishlist=bad`)).toEqual({ cartToken: cart, wishlistToken: null });
    expect(readGuestShoppingTokens(null)).toEqual({ cartToken: null, wishlistToken: null });
  });

  test('Cookie は HttpOnly・SameSite=Lax・Path=/・2週間で付け、消す時は2つとも消す', () => {
    const res = NextResponse.json({});
    setGuestShoppingCookie(res, 'cart', 'c'.repeat(43));
    const cookie = res.cookies.get('cart');
    expect(cookie).toMatchObject({ value: 'c'.repeat(43), httpOnly: true, sameSite: 'lax', path: '/', maxAge: 1209600 });
    clearGuestShoppingCookies(res);
    expect(res.cookies.get('cart')).toMatchObject({ value: '', maxAge: 0, path: '/' });
    expect(res.cookies.get('wishlist')).toMatchObject({ value: '', maxAge: 0, path: '/' });
  });
});
