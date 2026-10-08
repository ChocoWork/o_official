import { NextResponse } from 'next/server';
import { mergeGuestShoppingIntoMember } from '@/features/cart/services/guest-shopping-merge';

jest.mock('@/lib/cookie', () => ({
  refreshCookieName: 'refresh',
  accessCookieName: 'access',
  csrfCookieName: 'csrf',
  // ログイン時に session_id を引き直す（セッション固定攻撃対策）ために必要。
  sessionCookieName: 'session_id',
  cookieOptionsForSession: (age: number) => ({ httpOnly: true, maxAge: age }),
  generateSessionId: () => 'rotated-session-id',
  cookieOptionsForRefresh: (age: number) => ({ httpOnly: true, maxAge: age }),
  cookieOptionsForAccess: (age: number) => ({ httpOnly: true, maxAge: age }),
  cookieOptionsForCsrf: (age: number) => ({ httpOnly: false, maxAge: age }),
  // ゲストの印を消す clearGuestShoppingCookies（本物を使う）が読む。
  cartCookieName: 'cart',
  wishlistCookieName: 'wishlist',
  clearCookieOptions: () => ({ httpOnly: true, maxAge: 0 }),
}));

jest.mock('@/features/cart/services/guest-shopping-merge', () => ({ mergeGuestShoppingIntoMember: jest.fn() }));

// 既存の Jest の Response は json() を持たないため、実際の NextResponse を使えるよう補う。
if (typeof Response.json !== 'function') {
  Response.json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

jest.mock('@/lib/csrf', () => ({
  generateCsrfToken: () => 'csrf-token-123',
}));

jest.mock('@/lib/hash', () => ({
  tokenHashSha256: (s: string) => `hash:${s}`,
}));

const mockInsert = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => ({ from: () => ({ insert: mockInsert }) }),
}));

const { persistSessionAndCookies } = require('@/features/auth/services/register');

describe('persistSessionAndCookies', () => {
  beforeEach(() => {
    mockInsert.mockClear();
  });

  it('persists session and sets cookies on success', async () => {
    // mock NextResponse-like object
    const res: any = { cookies: { set: jest.fn() } };

    mockInsert.mockResolvedValue({ data: [{ id: 'row1' }], error: null });

    const session = { refresh_token: 'r1', expires_at: Date.now() + 1000 };
    const user = { id: 'u1', email: 'a@b.c' };

    const result = await persistSessionAndCookies(res as NextResponse, session, user);

    expect(result).toEqual({ ok: true });
    expect(res.cookies.set).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('returns error when DB insert fails', async () => {
    const res: any = { cookies: { set: jest.fn() } };

    mockInsert.mockResolvedValue({ data: null, error: { message: 'dup' } });

    const session = { refresh_token: 'r2', expires_at: Date.now() + 1000 };
    const user = { id: 'u2', email: 'x@y.z' };

    const result = await persistSessionAndCookies(res as NextResponse, session, user);

    expect(result.ok).toBe(false);
    expect(res.cookies.set).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('returns error when session or user missing', async () => {
    const res: any = { cookies: { set: jest.fn() } };
    const result = await persistSessionAndCookies(res as NextResponse, null, null);
    expect(result.ok).toBe(false);
  });
});

// persistSessionAndCookies は上部の require で読み込み済み。
describe('register service', () => {
  test('exports persistSessionAndCookies', async () => {
    expect(typeof persistSessionAndCookies).toBe('function');
  });
});

// ログインでゲストのカートとお気に入りを会員の分へ合わせる（設計書第5章）。
describe('persistSessionAndCookies: ゲストのカートとお気に入りの引き継ぎ', () => {
  const session = { refresh_token: 'r1', expires_at: Date.now() + 1000 };
  const user = { id: 'u1', email: 'a@b.c' };

  beforeEach(() => {
    mockInsert.mockReset();
    mockInsert.mockResolvedValue({ data: [{ id: 'row1' }], error: null });
    (mergeGuestShoppingIntoMember as jest.Mock).mockReset();
  });

  test('ゲストの印があれば、ログインの Cookie を付けた後に合わせ、成功したら cart と wishlist の Cookie を消す', async () => {
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: true, cartLinesMoved: 1, cartLinesDropped: 0, wishlistLinesMoved: 0 });
    const res = NextResponse.json({});
    const result = await persistSessionAndCookies(res, session, user, { cartToken: 'c'.repeat(43), wishlistToken: null });
    expect(result).toEqual({ ok: true });
    expect(mergeGuestShoppingIntoMember).toHaveBeenCalledWith(expect.anything(), { userId: user.id, cartToken: 'c'.repeat(43), wishlistToken: null });
    expect(res.cookies.get('cart')?.value).toBe('');
    expect(res.cookies.get('wishlist')?.value).toBe('');
  });

  test('カートとお気に入りの印が両方あれば、両方を渡す', async () => {
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: true, cartLinesMoved: 0, cartLinesDropped: 0, wishlistLinesMoved: 2 });
    const result = await persistSessionAndCookies(NextResponse.json({}), session, user, { cartToken: 'c'.repeat(43), wishlistToken: 'w'.repeat(43) });
    expect(result).toEqual({ ok: true });
    expect(mergeGuestShoppingIntoMember).toHaveBeenCalledWith(expect.anything(), {
      userId: user.id,
      cartToken: 'c'.repeat(43),
      wishlistToken: 'w'.repeat(43),
    });
  });

  test('合わせるのは、ログインの Cookie とセッションの保存が全部済んだ後', async () => {
    const res = NextResponse.json({});
    let atMerge: { loginCookiesSet: boolean[]; sessionRowSaved: boolean } | undefined;
    (mergeGuestShoppingIntoMember as jest.Mock).mockImplementation(async () => {
      atMerge = {
        loginCookiesSet: ['session_id', 'access', 'refresh', 'csrf'].map((name) => res.cookies.get(name) !== undefined),
        sessionRowSaved: mockInsert.mock.calls.some(([rows]) => rows?.[0]?.refresh_token_hash === 'hash:r1'),
      };
      return { ok: true, cartLinesMoved: 1, cartLinesDropped: 0, wishlistLinesMoved: 0 };
    });

    await persistSessionAndCookies(res, session, user, { cartToken: 'c'.repeat(43), wishlistToken: null });

    expect(atMerge).toEqual({ loginCookiesSet: [true, true, true, true], sessionRowSaved: true });
  });

  test('合わせるのに失敗してもログインは成功し、Cookie を残す', async () => {
    (mergeGuestShoppingIntoMember as jest.Mock).mockResolvedValue({ ok: false });
    const res = NextResponse.json({});
    const result = await persistSessionAndCookies(res, session, user, { cartToken: 'c'.repeat(43), wishlistToken: null });
    expect(result).toEqual({ ok: true });
    // 合わせようとしたうえで失敗したことを確かめる（呼ばれていなくても Cookie は無いため）。
    expect(mergeGuestShoppingIntoMember).toHaveBeenCalledTimes(1);
    expect(res.cookies.get('cart')).toBeUndefined();
    expect(res.cookies.get('wishlist')).toBeUndefined();
    // ログインの Cookie は残る。
    expect(res.cookies.get('refresh')?.value).toBe('r1');
  });

  test('セッションの保存に失敗した時は合わせず、ゲストの Cookie も残す', async () => {
    mockInsert.mockResolvedValue({ data: null, error: { message: 'dup' } });
    const res = NextResponse.json({});
    const result = await persistSessionAndCookies(res, session, user, { cartToken: 'c'.repeat(43), wishlistToken: null });
    expect(result.ok).toBe(false);
    expect(mergeGuestShoppingIntoMember).not.toHaveBeenCalled();
    expect(res.cookies.get('cart')).toBeUndefined();
  });

  test('印が無ければ合わせない', async () => {
    const res = NextResponse.json({});
    await persistSessionAndCookies(res, session, user, { cartToken: null, wishlistToken: null });
    await persistSessionAndCookies(NextResponse.json({}), session, user);
    expect(mergeGuestShoppingIntoMember).not.toHaveBeenCalled();
  });
});
