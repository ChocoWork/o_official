/** @jest-environment node */
import { NextRequest, NextResponse } from 'next/server';
import { openShoppingContext, findCartIdForBuyer } from '@/features/cart/services/shopping-context';
import { resolveCheckoutBuyer } from '@/features/checkout/services/checkout-buyer';
import { mergeGuestShoppingIntoMember } from '@/features/cart/services/guest-shopping-merge';
import { ensureOwnerRowId, findOwnerRowId } from '@/features/cart/services/shopping-owner.repository';
import { maskAuditEvent } from '@/lib/audit';

jest.mock('@/features/checkout/services/checkout-buyer', () => {
  const actual = jest.requireActual('@/features/checkout/services/checkout-buyer');
  return { ...actual, resolveCheckoutBuyer: jest.fn() };
});
jest.mock('@/features/cart/services/guest-shopping-merge', () => ({ mergeGuestShoppingIntoMember: jest.fn() }));
jest.mock('@/features/cart/services/shopping-owner.repository', () => ({
  findOwnerRowId: jest.fn(),
  ensureOwnerRowId: jest.fn(),
}));

const CART = 'c'.repeat(43);
const WISHLIST = 'w'.repeat(43);
const CART_HASH = '0c49d89230696ff3c031ca5a128a4e121e3589bf872c17fa04487ed0cc245d21';
const WISHLIST_HASH = '93147f94c8b2a78b727a78b80ddaea9f90cd3f095b8aee658833dce614c87222';
const supabase = {} as never;

function requestWithCookie(cookie?: string) {
  return new NextRequest('http://localhost:3000/api/cart', { headers: cookie ? { cookie } : {} });
}

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

describe('openShoppingContext', () => {
  beforeEach(() => jest.clearAllMocks());

  test('印の期限切れは 401 auth_expired、障害は 503 を返し、DB に触れない', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValueOnce({ kind: 'expired' });
    const expired = await openShoppingContext(requestWithCookie(`cart=${CART}; wishlist=${WISHLIST}`), 'cart', supabase, { write: true });
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.response.status).toBe(401);
      await expect(expired.response.json()).resolves.toEqual({ error: 'auth_expired' });
    }
    expect(findOwnerRowId).not.toHaveBeenCalled();
    expect(mergeGuestShoppingIntoMember).not.toHaveBeenCalled();
    expect(ensureOwnerRowId).not.toHaveBeenCalled();
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValueOnce({ kind: 'unavailable' });
    const unavailable = await openShoppingContext(requestWithCookie(`cart=${CART}; wishlist=${WISHLIST}`), 'cart', supabase, { write: true });
    expect(!unavailable.ok && unavailable.response.status).toBe(503);
    expect(findOwnerRowId).not.toHaveBeenCalled();
    expect(mergeGuestShoppingIntoMember).not.toHaveBeenCalled();
    expect(ensureOwnerRowId).not.toHaveBeenCalled();
  });

  test('会員は会員の ID で引き、残っていたゲストの印を合わせて Cookie を消す', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'member', userId: 'u1', email: 'a@example.com' });
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: true, cartLinesMoved: 1, cartLinesDropped: 0, wishlistLinesMoved: 0 });
    (findOwnerRowId as jest.Mock).mockResolvedValue('member-cart');
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.owner).toEqual({ kind: 'member', userId: 'u1' });
    expect(opened.context.rateLimitSubject).toBe('member:u1');
    await expect(opened.context.findOwnerId()).resolves.toBe('member-cart');
    expect(findOwnerRowId).toHaveBeenCalledWith(supabase, 'carts', { kind: 'member', userId: 'u1' });
    expect(mergeGuestShoppingIntoMember).toHaveBeenCalledWith(supabase, { userId: 'u1', cartToken: CART, wishlistToken: null });
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')?.value).toBe('');
  });

  test('合わせるのに失敗したら Cookie を残す（次の要求でもう一度合わせる）', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'member', userId: 'u1', email: null });
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: false });
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')).toBeUndefined();
  });

  test('会員の ensureOwnerId は会員の ID で作り、Cookie を付けない', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'member', userId: 'u1', email: null });
    (ensureOwnerRowId as jest.Mock).mockResolvedValue('member-cart');
    const opened = await openShoppingContext(requestWithCookie(), 'cart', supabase, { write: true });
    if (!opened.ok) throw new Error('opened');
    await expect(opened.context.ensureOwnerId()).resolves.toBe('member-cart');
    expect(ensureOwnerRowId).toHaveBeenCalledWith(supabase, 'carts', { kind: 'member', userId: 'u1' });
    expect(opened.context.finish(new NextResponse(null)).cookies.getAll()).toEqual([]);
  });

  test('ゲストで形の違う印は印なし。読むだけなら持ち主は無く、Cookie を付けない', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    const opened = await openShoppingContext(requestWithCookie('cart=broken'), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.owner).toBeNull();
    expect(opened.context.rateLimitSubject).toBeNull();
    await expect(opened.context.findOwnerId()).resolves.toBeNull();
    expect(findOwnerRowId).not.toHaveBeenCalled();
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')).toBeUndefined();
  });

  test('印の無いゲストが書く時は、新しい印で持ち主を作り Cookie を付ける', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    (ensureOwnerRowId as jest.Mock).mockResolvedValue('new-cart');
    const opened = await openShoppingContext(requestWithCookie(), 'cart', supabase, { write: true });
    if (!opened.ok) throw new Error('opened');
    await expect(opened.context.ensureOwnerId()).resolves.toBe('new-cart');
    expect(ensureOwnerRowId).toHaveBeenCalledWith(supabase, 'carts', { kind: 'guest', tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('印のあるゲストが書く時は、同じ印の Cookie を2週間に延ばす', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: true });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.rateLimitSubject).toMatch(/^guest:[0-9a-f]{64}$/);
    const res = opened.context.finish(new (await import('next/server')).NextResponse(null));
    expect(res.cookies.get('cart')).toMatchObject({ value: CART, maxAge: 1209600 });
  });

  test('監査の持ち主の情報に印そのものを入れない', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.auditOwner).toEqual({ owner: 'guest', guest_hash_prefix: '0c49d8923069' });
    expect(JSON.stringify(opened.context.auditOwner)).not.toContain(CART);
  });

  test('ゲストの監査情報は maskAuditEvent に渡してもハッシュの先頭12桁が伏せられない', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'cart', supabase, { write: false });
    if (!opened.ok) throw new Error('opened');
    const masked = maskAuditEvent({ action: 'cart.read', outcome: 'success', metadata: opened.context.auditOwner });
    expect(masked.metadata).toEqual({ owner: 'guest', guest_hash_prefix: '0c49d8923069' });
  });

  test('wishlist はお気に入りの印で wishlists を使い、wishlist の Cookie を更新する', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    (findOwnerRowId as jest.Mock).mockResolvedValue('guest-wishlist');
    (ensureOwnerRowId as jest.Mock).mockResolvedValue('guest-wishlist');
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}; wishlist=${WISHLIST}`), 'wishlist', supabase, { write: true });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.owner).toEqual({ kind: 'guest', tokenHash: WISHLIST_HASH });
    await expect(opened.context.findOwnerId()).resolves.toBe('guest-wishlist');
    expect(findOwnerRowId).toHaveBeenCalledWith(supabase, 'wishlists', { kind: 'guest', tokenHash: WISHLIST_HASH });
    await expect(opened.context.ensureOwnerId()).resolves.toBe('guest-wishlist');
    expect(ensureOwnerRowId).toHaveBeenCalledWith(supabase, 'wishlists', { kind: 'guest', tokenHash: WISHLIST_HASH });
    const res = opened.context.finish(new NextResponse(null));
    expect(res.cookies.get('wishlist')).toMatchObject({ value: WISHLIST, maxAge: 1209600 });
    expect(res.cookies.get('cart')).toBeUndefined();
  });

  test('wishlist の印が無い時は wishlists の持ち主を作り、wishlist の Cookie を発行する', async () => {
    (resolveCheckoutBuyer as jest.Mock).mockResolvedValue({ kind: 'guest' });
    (ensureOwnerRowId as jest.Mock).mockResolvedValue('new-wishlist');
    const opened = await openShoppingContext(requestWithCookie(`cart=${CART}`), 'wishlist', supabase, { write: true });
    if (!opened.ok) throw new Error('opened');
    expect(opened.context.owner).toBeNull();
    await expect(opened.context.ensureOwnerId()).resolves.toBe('new-wishlist');
    expect(ensureOwnerRowId).toHaveBeenCalledWith(supabase, 'wishlists', { kind: 'guest', tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const res = opened.context.finish(new NextResponse(null));
    expect(res.cookies.get('wishlist')?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.cookies.get('cart')).toBeUndefined();
  });
});

describe('findCartIdForBuyer', () => {
  beforeEach(() => jest.clearAllMocks());

  test('会員は残ったゲストの印を合わせてから会員のカートを引く', async () => {
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: true, cartLinesMoved: 0, cartLinesDropped: 0, wishlistLinesMoved: 0 });
    (findOwnerRowId as jest.Mock).mockResolvedValue('member-cart');
    await expect(findCartIdForBuyer(supabase, requestWithCookie(`cart=${CART}`), { kind: 'member', userId: 'u1', email: null })).resolves.toBe('member-cart');
    expect(mergeGuestShoppingIntoMember).toHaveBeenCalled();
    expect(findOwnerRowId).toHaveBeenCalledWith(supabase, 'carts', { kind: 'member', userId: 'u1' });
  });

  test('ゲストは cart の印で引き、印が無ければ null', async () => {
    (findOwnerRowId as jest.Mock).mockResolvedValue('guest-cart');
    await expect(findCartIdForBuyer(supabase, requestWithCookie(`cart=${CART}`), { kind: 'guest' })).resolves.toBe('guest-cart');
    expect(findOwnerRowId).toHaveBeenCalledWith(supabase, 'carts', { kind: 'guest', tokenHash: CART_HASH });
    await expect(findCartIdForBuyer(supabase, requestWithCookie(), { kind: 'guest' })).resolves.toBeNull();
    expect(findOwnerRowId).toHaveBeenCalledTimes(1);
  });
});
