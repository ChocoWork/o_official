import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ItemDetailClient from '@/app/item/[id]/ItemDetailClient';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
const mockUpdateCartCount = jest.fn();
jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({
    updateCartCount: mockUpdateCartCount,
    wishlistedItems: new Set<number>(),
    toggleWishlist: jest.fn(),
  }),
}));

const ITEM = {
  id: 101,
  name: 'Silk Blouse',
  description: 'desc',
  price: 12000,
  category: 'TOPS',
  image_url: '/images/1.jpg',
  image_urls: ['/images/1.jpg'],
  colors: [{ hex: '#000', name: 'Black' }],
  sizes: ['M'],
  product_details: [],
  madeToOrder: false,
  variantAvailability: [{ colorName: 'Black', sizeLabel: 'M', inStock: true, variantId: 11 }],
};

let itemBody: unknown;
let addResponse: { status: number; body: unknown };

beforeEach(() => {
  jest.clearAllMocks();
  document.cookie = 'sb-csrf-token=; max-age=0';
  itemBody = ITEM;
  addResponse = { status: 200, body: { items: [] } };
  window.scrollTo = jest.fn() as unknown as typeof window.scrollTo;
  (global as any).fetch = jest.fn(async (input: string) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (input === '/api/items/101') return json(200, itemBody);
    if (input.startsWith('/api/items?')) return json(200, { items: [] });
    if (input === '/api/cart/add') return json(addResponse.status, addResponse.body);
    return json(404, {});
  });
});

async function clickAdd() {
  const buttons = await screen.findAllByRole('button', { name: /ADD TO CART/ });
  fireEvent.click(buttons[0]);
}

test('選んだ色・サイズのバリアントの番号を /api/cart/add に送る', async () => {
  render(<ItemDetailClient id="101" />);
  await clickAdd();

  await waitFor(() => expect(mockUpdateCartCount).toHaveBeenCalled());
  const call = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === '/api/cart/add');
  expect(call[1].method).toBe('POST');
  expect(JSON.parse(call[1].body)).toEqual({ items: [{ id: 11, quantity: 1 }] });
});

test('在庫を読み込めずバリアントが空なら、送らずに時間をおいた再試行を案内する', async () => {
  itemBody = { ...ITEM, variantAvailability: [] };
  render(<ItemDetailClient id="101" />);
  await clickAdd();

  expect((await screen.findAllByText('在庫を確かめられませんでした。少し時間をおいてから、もう一度お試しください。')).length).toBeGreaterThan(0);
  expect(screen.queryByTestId('delivery-note')).toBeNull();
  expect((global.fetch as jest.Mock).mock.calls.some(([url]) => url === '/api/cart/add')).toBe(false);
  expect(mockUpdateCartCount).not.toHaveBeenCalled();
});

test('組み合わせはあるが選んだバリアントが無ければ、送らずに取り扱い終了を案内し納期を出さない', async () => {
  itemBody = { ...ITEM, variantAvailability: [{ colorName: 'Ivory', sizeLabel: 'M', inStock: false, variantId: 12 }] };
  render(<ItemDetailClient id="101" />);
  await clickAdd();

  expect((await screen.findAllByText('選んだ色・サイズは現在お求めいただけません。')).length).toBeGreaterThan(0);
  expect(screen.queryByTestId('delivery-note')).toBeNull();
  expect((global.fetch as jest.Mock).mock.calls.some(([url]) => url === '/api/cart/add')).toBe(false);
  expect(mockUpdateCartCount).not.toHaveBeenCalled();
});

test('窓口の断り（422）は description をそのまま出す', async () => {
  // 断りは画面が console.error に残す（想定どおりの出力なので、試験の出力を汚さないよう黙らせて呼ばれたことだけ見る）
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  addResponse = { status: 422, body: { status: 422, message: 'Cart Error', description: '1つの商品は20個までです。' } };
  render(<ItemDetailClient id="101" />);
  await clickAdd();

  expect((await screen.findAllByText('1つの商品は20個までです。')).length).toBeGreaterThan(0);
  expect(mockUpdateCartCount).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalled();
  consoleError.mockRestore();
});
