import React from 'react';
import { render, screen } from '@testing-library/react';
import ItemDetailClient from '@/app/item/[id]/ItemDetailClient';

/**
 * 商品のページの返品不可の一文（グループ E-3 段2 P15・C-5）。
 * 商品の窓口 /api/items/[id] の答えが returnIneligible: true の商品にだけ、商品名・価格・納期の直後に一文を出す。
 */

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({
    updateCartCount: jest.fn(),
    wishlistedItems: new Set<number>(),
    toggleWishlist: jest.fn(),
  }),
}));

const NOTE = 'この商品は、初期不良・誤送を除き、返品・交換をお受けしていません';

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

beforeEach(() => {
  itemBody = ITEM;
  window.scrollTo = jest.fn() as unknown as typeof window.scrollTo;
  (global as any).fetch = jest.fn(async (input: string) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (input === '/api/items/101') return json(200, itemBody);
    if (input.startsWith('/api/items?')) return json(200, { items: [] });
    return json(404, {});
  });
});

test('返品不可の印の付いた商品には、商品名・価格・納期の直後に一文を1つ出す', async () => {
  itemBody = { ...ITEM, returnIneligible: true };
  render(<ItemDetailClient id="101" />);

  const note = await screen.findByTestId('item-return-ineligible-note');
  expect(note.textContent).toBe(NOTE);
  expect(screen.getByTestId('item-detail-identity').nextElementSibling).toBe(note);
  expect(screen.getAllByText(NOTE)).toHaveLength(1);
});

test.each<[string, Record<string, unknown>]>([
  ['returnIneligible が false', { returnIneligible: false }],
  ['returnIneligible が無い（印の無い商品・古い答え）', {}],
])('窓口の答えで %s の時は、一文を出さない', async (_label, extra) => {
  itemBody = { ...ITEM, ...extra };
  render(<ItemDetailClient id="101" />);

  await screen.findByTestId('item-detail-price-row');

  expect(screen.queryByTestId('item-return-ineligible-note')).toBeNull();
  expect(screen.queryByText(NOTE)).toBeNull();
});

test('一文を出しても、納期の表示とカートに入れるボタンは今までどおり出る', async () => {
  itemBody = { ...ITEM, returnIneligible: true };
  render(<ItemDetailClient id="101" />);

  await screen.findByTestId('item-return-ineligible-note');

  expect(screen.getAllByTestId('delivery-note')[0]).toHaveTextContent('在庫あり・3〜7営業日で発送');
  expect(screen.getAllByRole('button', { name: /ADD TO CART/ }).length).toBeGreaterThan(0);
});
