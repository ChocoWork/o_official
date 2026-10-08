import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import WishlistPage from '@/app/wishlist/page';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
const mockUpdateCartCount = jest.fn();
const mockUpdateWishlist = jest.fn();
jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({ updateCartCount: mockUpdateCartCount, updateWishlist: mockUpdateWishlist }),
}));

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    item_id: 7,
    added_at: '2026-10-08T00:00:00Z',
    items: { id: 7, name: 'リネンシャツ', price: 12000, image_url: '/x.png', category: 'TOPS', colors: [{ hex: '#000', name: 'ブラック' }], sizes: ['M'] },
    variants: [
      { id: 71, color: 'ブラック', size: 'M' },
      { id: 72, color: 'アイボリー', size: 'M' },
    ],
    ...overrides,
  };
}

let wishlistBody: unknown;
let addResponse: { status: number; body: unknown };
let csrfSent: Record<string, string | null>;

beforeEach(() => {
  jest.clearAllMocks();
  document.cookie = 'sb-csrf-token=; max-age=0';
  wishlistBody = [row()];
  addResponse = { status: 200, body: { items: [] } };
  csrfSent = {};
  (global as any).fetch = jest.fn(async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    csrfSent[`${method} ${input}`] = new Headers(init?.headers).get('x-csrf-token');
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (input === '/api/wishlist') return json(200, wishlistBody);
    if (input.startsWith('/api/wishlist/') && method === 'DELETE') return json(200, { success: true });
    if (input === '/api/cart/add') return json(addResponse.status, addResponse.body);
    return json(404, {});
  });
});

test('お気に入りのバリアントの番号を /api/cart/add に送る', async () => {
  render(<WishlistPage />);
  fireEvent.click(await screen.findByRole('button', { name: /ADD TO CART/ }));

  expect(await screen.findByText('カートに追加しました。')).toBeInTheDocument();
  const call = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === '/api/cart/add');
  expect(JSON.parse(call[1].body)).toEqual({ items: [{ id: 71, quantity: 1 }] });
  expect(mockUpdateCartCount).toHaveBeenCalled();
});

test('variants が無い行は、送らずに案内を出す', async () => {
  const { variants, ...withoutVariants } = row() as Record<string, unknown>;
  void variants;
  wishlistBody = [withoutVariants];
  render(<WishlistPage />);
  fireEvent.click(await screen.findByRole('button', { name: /ADD TO CART/ }));

  expect(await screen.findByText('選んだ色・サイズは現在お求めいただけません。')).toBeInTheDocument();
  expect((global.fetch as jest.Mock).mock.calls.some(([url]) => url === '/api/cart/add')).toBe(false);
});

test('壊れた variants の要素は捨てて、残りで探す', async () => {
  wishlistBody = [row({ variants: [{ id: 'x' }, null, { id: 71, color: 'ブラック', size: 'M' }] })];
  render(<WishlistPage />);
  fireEvent.click(await screen.findByRole('button', { name: /ADD TO CART/ }));

  expect(await screen.findByText('カートに追加しました。')).toBeInTheDocument();
});

test('窓口の断り（422）は description をそのまま出す', async () => {
  // 断りは画面が console.error に残す（想定どおりの出力なので、試験の出力を汚さないよう黙らせて呼ばれたことだけ見る）
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  addResponse = { status: 422, body: { status: 422, message: 'Cart Error', description: 'カートに入れられるのは50種類までです。' } };
  render(<WishlistPage />);
  fireEvent.click(await screen.findByRole('button', { name: /ADD TO CART/ }));

  expect(await screen.findByText('カートに入れられるのは50種類までです。')).toBeInTheDocument();
  expect(mockUpdateCartCount).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalled();
  consoleError.mockRestore();
});

test('削除は会員なら合言葉を付けて DELETE し、一覧から外す', async () => {
  document.cookie = 'sb-csrf-token=member-token';
  render(<WishlistPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'ウィッシュリストから削除' }));

  await waitFor(() => expect(mockUpdateWishlist).toHaveBeenCalled());
  expect(csrfSent['DELETE /api/wishlist/w1']).toBe('member-token');
  expect(csrfSent['GET /api/wishlist']).toBeNull();
});
