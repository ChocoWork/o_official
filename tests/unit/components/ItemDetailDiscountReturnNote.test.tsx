import React from 'react';
import { render, screen } from '@testing-library/react';
import ItemDetailClient from '@/app/item/[id]/ItemDetailClient';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/contexts/CartContext', () => ({
  useCart: () => ({ updateCartCount: jest.fn(), wishlistedItems: new Set<number>(), toggleWishlist: jest.fn() }),
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

beforeEach(() => {
  window.scrollTo = jest.fn() as unknown as typeof window.scrollTo;
  (global as any).fetch = jest.fn(async (input: string) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (input === '/api/items/101') return json(200, ITEM);
    if (input.startsWith('/api/items?')) return json(200, { items: [] });
    return json(404, {});
  });
});

test('FREQ-642-AC-22: 商品ページに割引の扱いの文が出る', async () => {
  render(<ItemDetailClient id="101" />);
  const note = await screen.findByTestId('item-discount-return-note');
  expect(note).toHaveTextContent(/お手元に残る商品の割引後の価格を差し引いて返金いたします/);
});
