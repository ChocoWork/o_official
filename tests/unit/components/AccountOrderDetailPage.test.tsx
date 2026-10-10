import React from 'react';
import { render, screen, within } from '@testing-library/react';
import AccountOrderDetailPage from '@/app/account/orders/[id]/page';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'order-1' }) }));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: true, isAuthResolved: true }),
}));
jest.mock('@/features/account/hooks/useReorder', () => ({
  useReorder: () => ({ reorderingItemId: null, reorder: jest.fn() }),
}));
const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) => mockClientFetch(...args),
}));

const STEPS_READY = [
  { key: 'payment', label: 'お支払い', state: 'done' },
  { key: 'ready', label: '発送準備中', state: 'current' },
  { key: 'in_transit', label: '配送中', state: 'todo' },
  { key: 'delivered', label: '配達済み', state: 'todo' },
];

const STEPS_IN_PRODUCTION = [
  { key: 'payment', label: 'お支払い', state: 'done' },
  { key: 'in_production', label: '受注生産中', state: 'current' },
  { key: 'ready', label: '発送準備中', state: 'todo' },
  { key: 'in_transit', label: '配送中', state: 'todo' },
  { key: 'delivered', label: '配達済み', state: 'todo' },
];

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1', itemId: 10, variantId: 101, name: 'リネンシャツ', imageUrl: null, color: '白', size: 'M',
    quantity: 2, amount: '¥24,000', shippedQuantity: 0, readyQuantity: 0, inProductionQuantity: 0, ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1', orderNumber: 'ORD-0001', orderDate: '2026/10/01 09:00', status: 'paid',
    progress: { key: 'ready', label: '発送準備中', partiallyShipped: false, steps: STEPS_READY },
    subtotalAmount: '¥24,000', shippingAmount: '¥0', discountAmount: '¥0', totalAmount: '¥24,000',
    paymentMethod: 'クレジットカード', shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
    shipments: [], items: [item({ readyQuantity: 2 })], ...overrides,
  };
}

async function renderPage(body: unknown) {
  mockClientFetch.mockResolvedValue({ ok: true, json: async () => body });
  render(<AccountOrderDetailPage />);
  await screen.findByText('ORD-0001');
}

function stepItems() {
  return within(screen.getByRole('list', { name: '配送ステータス' })).getAllByRole('listitem');
}

describe('お客様の注文の画面（グループ E-1）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
  });

  it('在庫の品だけの注文は4段で、今の段に aria-current が付き、済んだ段だけ塗る。状態の言葉も出る', async () => {
    await renderPage(order());

    const steps = stepItems();
    expect(steps).toHaveLength(4);
    ['お支払い', '発送準備中', '配送中', '配達済み'].forEach((label, index) => {
      expect(steps[index]).toHaveTextContent(label);
    });
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).not.toHaveAttribute('aria-current');
    expect(within(steps[0]).getByText('お支払い')).toHaveClass('text-black');
    expect(within(steps[1]).getByText('発送準備中')).toHaveClass('text-black');
    expect(within(steps[2]).getByText('配送中')).toHaveClass('text-[#999]');
    expect(screen.getByTestId('order-progress-status')).toHaveTextContent('発送準備中');
    expect(screen.queryByText('一部発送済み')).not.toBeInTheDocument();
  });

  it('受注生産の品を含む注文は5段で、一部発送済みの印と、受注生産中の商品を出す', async () => {
    await renderPage(
      order({
        progress: { key: 'in_production', label: '受注生産中', partiallyShipped: true, steps: STEPS_IN_PRODUCTION },
        items: [
          item({ shippedQuantity: 2 }),
          item({ id: 'line-2', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, inProductionQuantity: 1 }),
        ],
      }),
    );

    expect(stepItems()).toHaveLength(5);
    const status = screen.getByTestId('order-progress-status');
    expect(status).toHaveTextContent('受注生産中');
    expect(status).toHaveTextContent('一部発送済み');
    expect(screen.getByRole('region', { name: '受注生産中の商品' })).toHaveTextContent('ウールコート（黒 / L） × 1');
    expect(screen.queryByRole('region', { name: '発送準備中の商品' })).not.toBeInTheDocument();
  });

  it('発送準備中の商品・受注生産中の商品には、その数が1以上の商品だけを並べる', async () => {
    await renderPage(
      order({
        items: [
          item({ id: 'a', name: 'リネンシャツ', quantity: 3, shippedQuantity: 1, readyQuantity: 2 }),
          item({ id: 'b', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, inProductionQuantity: 1 }),
          item({ id: 'c', name: 'シルクスカーフ', color: null, size: null, quantity: 1, shippedQuantity: 1 }),
        ],
      }),
    );

    const ready = screen.getByRole('region', { name: '発送準備中の商品' });
    expect(ready).toHaveTextContent('リネンシャツ（白 / M） × 2');
    expect(ready).not.toHaveTextContent('ウールコート');
    expect(ready).not.toHaveTextContent('シルクスカーフ');
    const inProduction = screen.getByRole('region', { name: '受注生産中の商品' });
    expect(inProduction).toHaveTextContent('ウールコート（黒 / L） × 1');
    expect(inProduction).not.toHaveTextContent('リネンシャツ');
  });

  it('発送準備中も受注生産中も無い注文には、その見出しを出さない', async () => {
    await renderPage(order({ items: [item({ shippedQuantity: 2 })] }));

    expect(screen.queryByRole('region', { name: '発送準備中の商品' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '受注生産中の商品' })).not.toBeInTheDocument();
  });

  it('キャンセルの注文は進み具合の段を出さず、言葉だけ出す', async () => {
    await renderPage(
      order({
        status: 'cancelled',
        progress: { key: 'cancelled', label: 'キャンセル', partiallyShipped: false, steps: null },
        items: [item()],
      }),
    );

    expect(screen.queryByRole('list', { name: '配送ステータス' })).not.toBeInTheDocument();
    expect(screen.getByTestId('order-progress-status')).toHaveTextContent('キャンセル');
  });

  it('発送ごとに「配送情報（n回目）」を出し、発送日・配送業者・追跡番号・リンク・その発送の商品を並べる', async () => {
    await renderPage(
      order({
        status: 'shipped',
        progress: {
          key: 'in_transit',
          label: '配送中',
          partiallyShipped: false,
          steps: [
            { key: 'payment', label: 'お支払い', state: 'done' },
            { key: 'ready', label: '発送準備中', state: 'done' },
            { key: 'in_transit', label: '配送中', state: 'current' },
            { key: 'delivered', label: '配達済み', state: 'todo' },
          ],
        },
        shipments: [
          {
            id: 'f1', number: 1, shippedAt: '2026-10-05T15:30:00.000Z', carrier: 'yamato', carrierLabel: 'ヤマト運輸',
            trackingNumber: '1234-5678-9012',
            trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012',
            items: [{ orderItemId: 'line-1', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2 }],
          },
          {
            id: 'f2', number: 2, shippedAt: '2026-10-20T00:00:00.000Z', carrier: 'sagawa', carrierLabel: '佐川急便',
            trackingNumber: 'AB-123',
            trackingUrl: 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=AB-123',
            items: [{ orderItemId: 'line-2', name: 'ウールコート', color: '黒', size: 'L', quantity: 1 }],
          },
        ],
        items: [item({ shippedQuantity: 2 })],
      }),
    );

    const first = screen.getByRole('region', { name: '配送情報（1回目）' });
    // 15:30（UTC）は日本時間の翌日 0:30 なので、発送日は 10/06
    expect(first).toHaveTextContent('2026/10/06');
    expect(first).toHaveTextContent('ヤマト運輸');
    expect(first).toHaveTextContent('1234-5678-9012');
    expect(first).toHaveTextContent('リネンシャツ（白 / M） × 2');
    const firstLink = within(first).getByRole('link', { name: '配送状況を確認する' });
    expect(firstLink).toHaveAttribute('href', 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012');
    expect(firstLink).toHaveAttribute('target', '_blank');
    expect(firstLink).toHaveAttribute('rel', 'noopener noreferrer');

    const second = screen.getByRole('region', { name: '配送情報（2回目）' });
    expect(second).toHaveTextContent('2026/10/20');
    expect(second).toHaveTextContent('佐川急便');
    expect(second).toHaveTextContent('ウールコート（黒 / L） × 1');
    expect(second).not.toHaveTextContent('リネンシャツ');
    expect(within(second).getByRole('link', { name: '配送状況を確認する' })).toHaveAttribute(
      'href',
      'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=AB-123',
    );
  });

  it('発送が無い注文には配送情報を出さない', async () => {
    await renderPage(order());

    expect(screen.queryAllByRole('region', { name: /配送情報/ })).toHaveLength(0);
  });

  it('前からの発送の記録で配送業者・追跡番号が空でも、発送日と商品は出し、リンクは出さない', async () => {
    await renderPage(
      order({
        status: 'shipped',
        shipments: [
          {
            id: 'f1', number: 1, shippedAt: '2026-08-05T00:00:00.000Z', carrier: null, carrierLabel: null,
            trackingNumber: null, trackingUrl: null,
            items: [{ orderItemId: 'line-1', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2 }],
          },
        ],
        items: [item({ shippedQuantity: 2 })],
      }),
    );

    const section = screen.getByRole('region', { name: '配送情報（1回目）' });
    expect(section).toHaveTextContent('2026/08/05');
    expect(section).toHaveTextContent('リネンシャツ（白 / M） × 2');
    expect(section).not.toHaveTextContent('配送業者');
    expect(section).not.toHaveTextContent('追跡番号');
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
  });
});
