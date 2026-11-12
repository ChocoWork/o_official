import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

test('FREQ-642-AC-36: 初めは要約の行が見え、割引の扱いの全文は見えない', async () => {
  render(<ItemDetailClient id="101" />);

  expect(await screen.findByText('割引のあるご注文の返品・交換について')).toBeVisible();
  expect(screen.getByText('詳しく')).toBeVisible();
  expect(screen.getByTestId('item-discount-return-note')).not.toBeVisible();
});

test('FREQ-642-AC-36: お客様が詳しくを開くと割引の扱いの全文が見える', async () => {
  const user = userEvent.setup();
  render(<ItemDetailClient id="101" />);
  const note = await screen.findByTestId('item-discount-return-note');

  expect(note).not.toBeVisible();
  await user.click(screen.getByText('詳しく'));

  expect(note).toBeVisible();
  expect(note).toHaveTextContent('割引（2着目割引・セット割引・割引コードなど）が付いたご注文で一部の商品を返品され、割引の条件を満たさなくなる場合は、お手元に残る商品の割引後の価格を差し引いて返金いたします。以前のご注文の商品を返品され、その後のご注文の2着目割引の条件を満たさなくなる場合も、その分を差し引いて返金いたします。初期不良・誤送は、同じ商品の交換でお応えします（在庫が無い場合はお作りしてお送りします）。どうしてもお送りできない場合に限り返金し、その時はお手元に残る商品の価格は上がりません。返金額がマイナスになることはありません。');
});
