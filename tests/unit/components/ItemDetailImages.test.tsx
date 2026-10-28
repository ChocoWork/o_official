import React from 'react';
import { render, screen } from '@testing-library/react';
import ItemDetailClient from '@/app/item/[id]/ItemDetailClient';

/**
 * 商品のページの画像（署名できない画像は null で届く。波 3 の Task 2）。
 * null の 1 枚をサムネイルに足さず、1 枚も無い時は「No Image」の枠を残して落ちない。
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

test('image_url が null で image_urls が空でも落ちず、「No Image」の枠を出す', async () => {
  itemBody = { ...ITEM, image_url: null, image_urls: [] };
  render(<ItemDetailClient id="101" />);

  await screen.findByTestId('item-detail-price-row');

  expect(screen.getAllByText('No Image').length).toBeGreaterThan(0);
  expect(screen.queryByTestId('item-detail-thumbnail-list')).toBeNull();
});

test('image_url が null で image_urls が 2 枚の時は、サムネイルが 2 枚（null の 1 枚を足さない）', async () => {
  itemBody = { ...ITEM, image_url: null, image_urls: ['/images/a.jpg', '/images/b.jpg'] };
  render(<ItemDetailClient id="101" />);

  const list = await screen.findByTestId('item-detail-thumbnail-list');

  expect(list.querySelectorAll('button')).toHaveLength(2);
  expect(screen.getAllByTestId('item-detail-carousel-slide')).toHaveLength(2);
});
