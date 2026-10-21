import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const mockSubmitCancelRequest = jest.fn();
jest.mock('@/features/account/returns/customer-return-client', () => ({
  submitCustomerCancelRequest: (...args: unknown[]) => mockSubmitCancelRequest(...args),
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
    quantity: 2, amount: '¥24,000', shippedQuantity: 0, refundedQuantity: 0, readyQuantity: 0, inProductionQuantity: 0,
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1', orderNumber: 'ORD-0001', orderDate: '2026/10/01 09:00', status: 'paid',
    progress: { key: 'ready', label: '発送準備中', partiallyShipped: false, steps: STEPS_READY },
    subtotalAmount: '¥24,000', shippingAmount: '¥0', discountAmount: '¥0', totalAmount: '¥24,000',
    paymentMethod: 'クレジットカード', shippingAddress: '〒1500001 東京都 渋谷区 神宮前1-2-3',
    shipments: [], refunds: [], refundTotal: null, items: [item({ readyQuantity: 2 })], ...overrides,
  };
}

function refund(overrides: Record<string, unknown> = {}) {
  return {
    id: 'refund-1', date: '2026/10/12', amount: '¥10,000', status: 'completed', customerActionDeadline: null,
    ...overrides,
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

describe('お客様の注文の画面の配送の状況と配達済み（グループ E-4 設計書 7-1）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
  });

  const STEPS_DELIVERED = [
    { key: 'payment', label: 'お支払い', state: 'done' },
    { key: 'ready', label: '発送準備中', state: 'done' },
    { key: 'in_transit', label: '配送中', state: 'done' },
    { key: 'delivered', label: '配達済み', state: 'done' },
  ];

  function shipment(overrides: Record<string, unknown> = {}) {
    return {
      id: 'f1', number: 1, shippedAt: '2026-10-05T15:30:00.000Z', carrier: 'yamato', carrierLabel: 'ヤマト運輸',
      trackingNumber: '1234-5678-9012',
      trackingUrl: 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=1234-5678-9012',
      items: [{ orderItemId: 'line-1', name: 'リネンシャツ', color: '白', size: 'M', quantity: 2 }],
      deliveredAt: null,
      ...overrides,
    };
  }

  // 窓口が追跡オン・鍵あり・追跡中の発送に付ける delivery（新しい順の出来事）
  function delivery(overrides: Record<string, unknown> = {}) {
    return {
      status: 'in_transit',
      statusAt: '2026-10-07T01:00:00.000Z',
      events: [
        { status: 'in_transit', happenedAt: '2026-10-07T01:00:00.000Z' },
        { status: 'confirmed', happenedAt: '2026-10-05T15:30:00.000Z' },
      ],
      ...overrides,
    };
  }

  function shippedOrder(shipments: unknown[], overrides: Record<string, unknown> = {}) {
    return order({
      status: 'shipped',
      progress: {
        key: 'in_transit', label: '配送中', partiallyShipped: false,
        steps: [
          { key: 'payment', label: 'お支払い', state: 'done' },
          { key: 'ready', label: '発送準備中', state: 'done' },
          { key: 'in_transit', label: '配送中', state: 'current' },
          { key: 'delivered', label: '配達済み', state: 'todo' },
        ],
      },
      shipments,
      items: [item({ shippedQuantity: 2 })],
      ...overrides,
    });
  }

  const sectionOf = (number: number) => screen.getByRole('region', { name: `配送情報（${number}回目）` });

  it('OFFでも配達済みとお届け日は残す（deliveredAt だけがあり delivery が無い発送）', async () => {
    await renderPage(shippedOrder([shipment({ deliveredAt: '2026-10-20T15:30:00.000Z' })]));

    const section = sectionOf(1);
    expect(screen.getByText('お届け日 10月21日')).toBeVisible();
    expect(within(section).getByTestId('shipment-delivered')).toHaveTextContent('配達済み');
    // 追跡のリンクと伝票番号は今までどおり出る。状況・最後の更新・移り変わりは出さない
    expect(within(section).getByRole('link', { name: '配送状況を確認する' })).toBeInTheDocument();
    expect(section).toHaveTextContent('1234-5678-9012');
    expect(section).not.toHaveTextContent('最後の更新');
    expect(within(section).queryByText('配送の移り変わり')).not.toBeInTheDocument();
    expect(within(section).queryByTestId('shipment-delivery-status')).not.toBeInTheDocument();
  });

  it.each([
    ['日本時間では翌日にあたる時刻', '2026-10-20T15:30:00.000Z', 'お届け日 10月21日'],
    ['日本時間の日の終わり', '2026-10-21T14:59:59.000Z', 'お届け日 10月21日'],
    ['日本時間の日の初め', '2026-10-21T15:00:00.000Z', 'お届け日 10月22日'],
    ['日本時間では翌月にあたる時刻', '2026-10-31T15:30:00.000Z', 'お届け日 11月1日'],
    ['日本時間の日の途中', '2026-10-21T03:00:00.000Z', 'お届け日 10月21日'],
  ])('お届け日は日本時間の「M月D日」で出す（%s）', async (_name, deliveredAt, text) => {
    await renderPage(shippedOrder([shipment({ deliveredAt })]));

    expect(screen.getByText(text)).toBeVisible();
  });

  it('配達済みの発送だけに「配達済み」とお届け日を出す。配達済みでない発送には出さない', async () => {
    await renderPage(
      shippedOrder([
        shipment({ deliveredAt: '2026-10-20T15:30:00.000Z' }),
        shipment({ id: 'f2', number: 2, trackingNumber: 'AB-123', trackingUrl: null }),
      ]),
    );

    expect(within(sectionOf(1)).getByTestId('shipment-delivered')).toBeInTheDocument();
    expect(within(sectionOf(2)).queryByTestId('shipment-delivered')).not.toBeInTheDocument();
    expect(within(sectionOf(2)).queryByText(/お届け日/)).not.toBeInTheDocument();
  });

  it('delivery がある発送は、今の状況・最後の更新（日本時間）・配送の移り変わり（窓口が返した新しい順）を出す', async () => {
    await renderPage(shippedOrder([shipment({ delivery: delivery() })]));

    const section = sectionOf(1);
    expect(within(section).getByTestId('shipment-delivery-status')).toHaveTextContent('輸送中');
    // 01:00（UTC）は日本時間の 10:00
    expect(within(section).getByText('最後の更新 2026/10/07 10:00')).toBeVisible();
    expect(within(section).getByRole('heading', { name: '配送の移り変わり' })).toBeInTheDocument();
    const events = within(section).getAllByTestId('shipment-delivery-event');
    expect(events).toHaveLength(2);
    expect(events[0]).toHaveTextContent('輸送中');
    expect(events[0]).toHaveTextContent('2026/10/07 10:00');
    expect(events[1]).toHaveTextContent('受付済み');
    // 15:30（UTC）は日本時間の翌日 0:30
    expect(events[1]).toHaveTextContent('2026/10/06 00:30');
    // 追跡のリンクは、状況があっても今までどおり出る
    expect(within(section).getByRole('link', { name: '配送状況を確認する' })).toBeInTheDocument();
  });

  it('追跡オフ・登録待ち・鍵なしなどで delivery が無い発送は、今までどおり追跡のリンクだけ（状況・最後の更新・移り変わり・一文を出さない）', async () => {
    await renderPage(shippedOrder([shipment()]));

    const section = sectionOf(1);
    expect(within(section).getByRole('link', { name: '配送状況を確認する' })).toBeInTheDocument();
    expect(within(section).queryByTestId('shipment-delivery-status')).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent('最後の更新');
    expect(within(section).queryByText('配送の移り変わり')).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent('配送に遅れや問題が出ています');
  });

  it('配達済みの時刻と delivery が両方ある発送は、配達済みを1回だけ出す（状況の札は出さず、お届け日が優先）', async () => {
    await renderPage(
      shippedOrder([
        shipment({
          deliveredAt: '2026-10-20T15:30:00.000Z',
          delivery: delivery({
            status: 'delivered',
            statusAt: '2026-10-20T15:30:00.000Z',
            events: [{ status: 'delivered', happenedAt: '2026-10-20T15:30:00.000Z' }, { status: 'in_transit', happenedAt: '2026-10-19T01:00:00.000Z' }],
          }),
        }),
      ]),
    );

    const section = sectionOf(1);
    expect(within(section).getAllByTestId('shipment-delivered')).toHaveLength(1);
    expect(within(section).queryByTestId('shipment-delivery-status')).not.toBeInTheDocument();
    expect(screen.getByText('お届け日 10月21日')).toBeVisible();
    expect(within(section).getAllByTestId('shipment-delivery-event')).toHaveLength(2);
  });

  it.each([
    ['問題あり', 'failure'],
    ['遅れ', 'delayed'],
  ])('状況が%sの時は「配送に遅れや問題が出ています。詳しくは配送業者のページをご確認ください」の一文を出す', async (label, status) => {
    await renderPage(
      shippedOrder([shipment({ delivery: delivery({ status, events: [{ status, happenedAt: '2026-10-07T01:00:00.000Z' }] }) })]),
    );

    const section = sectionOf(1);
    expect(within(section).getByText('配送に遅れや問題が出ています。詳しくは配送業者のページをご確認ください')).toBeVisible();
    expect(within(section).getByTestId('shipment-delivery-status')).toHaveTextContent(label);
  });

  it.each(['confirmed', 'in_transit', 'out_for_delivery', 'attempted_delivery', 'ready_for_pickup'])(
    '状況が %s の時は、遅れや問題の一文を出さない',
    async (status) => {
      await renderPage(shippedOrder([shipment({ delivery: delivery({ status, events: [{ status, happenedAt: '2026-10-07T01:00:00.000Z' }] }) })]));

      expect(sectionOf(1)).not.toHaveTextContent('配送に遅れや問題が出ています');
    },
  );

  it.each([
    ['confirmed', '受付済み'],
    ['in_transit', '輸送中'],
    ['out_for_delivery', '配達中'],
    ['attempted_delivery', '不在で持ち帰り'],
    ['ready_for_pickup', '受け取り待ち'],
    ['delayed', '遅れ'],
    ['failure', '問題あり'],
  ])('状況 %s は「%s」と書く', async (status, label) => {
    await renderPage(shippedOrder([shipment({ delivery: delivery({ status, events: [] }) })]));

    expect(within(sectionOf(1)).getByTestId('shipment-delivery-status')).toHaveTextContent(label);
    // 出来事が無ければ、移り変わりの見出しも出さない
    expect(within(sectionOf(1)).queryByText('配送の移り変わり')).not.toBeInTheDocument();
  });

  it('前からの発送（配送業者・伝票番号が空）と知らない配送業者は、従来の表示のまま。配達済みなら配達済みとお届け日は出る', async () => {
    await renderPage(
      shippedOrder([
        shipment({
          carrier: null, carrierLabel: null, trackingNumber: null, trackingUrl: null, deliveredAt: '2026-10-20T15:30:00.000Z',
        }),
        shipment({ id: 'f2', number: 2, carrier: 'newcarrier', carrierLabel: null, trackingUrl: null }),
      ]),
    );

    const legacy = sectionOf(1);
    expect(legacy).not.toHaveTextContent('配送業者');
    expect(legacy).not.toHaveTextContent('追跡番号');
    expect(within(legacy).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('お届け日 10月21日')).toBeVisible();
    const unknown = sectionOf(2);
    expect(unknown).not.toHaveTextContent('配送業者');
    expect(unknown).toHaveTextContent('1234-5678-9012');
    expect(within(unknown).queryByRole('link')).not.toBeInTheDocument();
    expect(within(unknown).queryByTestId('shipment-delivered')).not.toBeInTheDocument();
  });

  it('deliveredAt を持たない古い形の答えでも、配達済みの欄を出さずに画面が出る', async () => {
    const legacyShipment = Object.fromEntries(Object.entries(shipment()).filter(([key]) => key !== 'deliveredAt'));

    await renderPage(shippedOrder([legacyShipment]));

    expect(within(sectionOf(1)).queryByTestId('shipment-delivered')).not.toBeInTheDocument();
    expect(sectionOf(1)).toHaveTextContent('1234-5678-9012');
  });

  it('全部の発送が配達済みの注文は、状態の言葉が「配達済み」で、進み具合の段は全部済み（今の段の印は付かない）', async () => {
    await renderPage(
      shippedOrder([shipment({ deliveredAt: '2026-10-20T15:30:00.000Z' })], {
        progress: { key: 'delivered', label: '配達済み', partiallyShipped: false, steps: STEPS_DELIVERED },
      }),
    );

    expect(screen.getByTestId('order-progress-status')).toHaveTextContent('配達済み');
    const steps = stepItems();
    expect(steps).toHaveLength(4);
    steps.forEach((step) => expect(step).not.toHaveAttribute('aria-current'));
    expect(within(steps[3]).getByText('配達済み')).toHaveClass('text-black');
  });
});

describe('お客様の注文の画面の返金（グループ E-2）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
  });

  it('返金が無い注文には「ご返金」の欄も返金済みの印も出さない', async () => {
    await renderPage(order());

    expect(screen.queryByRole('region', { name: 'ご返金' })).not.toBeInTheDocument();
    expect(screen.queryByText('ご返金の合計')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('order-item-refunded')).toHaveLength(0);
  });

  it('返金ごとに「ご返金」の行を、日付・額・状態（手続き中・完了）つきで、窓口が返した順に、支払金額の欄の最後に出す', async () => {
    await renderPage(
      order({
        refunds: [
          refund({ id: 'refund-1', date: '2026/10/12', amount: '¥10,000', status: 'completed' }),
          refund({ id: 'refund-2', date: '2026/10/14', amount: '¥14,500', status: 'processing' }),
        ],
        refundTotal: '¥24,500',
      }),
    );

    const payment = screen.getByRole('heading', { name: '支払金額' }).closest('section') as HTMLElement;
    const region = within(payment).getByRole('region', { name: 'ご返金' });
    expect(payment.lastElementChild).toBe(region);

    const rows = within(region).getAllByTestId('order-refund-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('ご返金')).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('2026/10/12 ¥10,000');
    expect(within(rows[0]).getByText('完了')).toBeInTheDocument();
    expect(within(rows[1]).getByText('ご返金')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('2026/10/14 ¥14,500');
    expect(within(rows[1]).getByText('手続き中')).toBeInTheDocument();
  });

  it('コンビニ払いの手続き中の返金には、返金先の口座の入力をお願いする文を期限つきで出す。期限が無い返金には出さない', async () => {
    await renderPage(
      order({
        refunds: [
          refund({ id: 'refund-1', status: 'processing', customerActionDeadline: '11月25日' }),
          refund({ id: 'refund-2', status: 'processing', customerActionDeadline: null }),
        ],
        refundTotal: '¥20,000',
      }),
    );

    const rows = screen.getAllByTestId('order-refund-row');
    expect(
      within(rows[0]).getByText('返金先の口座の入力をお願いしています（11月25日まで）'),
    ).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/返金先の口座/)).not.toBeInTheDocument();
  });

  it('窓口が合計を返した時（返金が2件以上）は、「ご返金の合計」の行を出す', async () => {
    await renderPage(
      order({
        refunds: [refund({ id: 'refund-1' }), refund({ id: 'refund-2', date: '2026/10/14', amount: '¥14,500' })],
        refundTotal: '¥24,500',
      }),
    );

    const total = screen.getByTestId('order-refund-total');
    expect(total).toHaveTextContent('ご返金の合計');
    expect(total).toHaveTextContent('¥24,500');
  });

  it('窓口が合計を返さない時（返金が1件）は、「ご返金の合計」の行を出さない', async () => {
    await renderPage(order({ refunds: [refund()], refundTotal: null }));

    expect(screen.getAllByTestId('order-refund-row')).toHaveLength(1);
    expect(screen.queryByTestId('order-refund-total')).not.toBeInTheDocument();
    expect(screen.queryByText('ご返金の合計')).not.toBeInTheDocument();
  });

  it('返金した数が1以上の商品だけに「返金済み n点」の印を出す', async () => {
    await renderPage(
      order({
        items: [
          item({ id: 'a', name: 'リネンシャツ', quantity: 3, refundedQuantity: 2, readyQuantity: 1 }),
          item({ id: 'b', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, refundedQuantity: 0, readyQuantity: 1 }),
        ],
      }),
    );

    const marks = screen.getAllByTestId('order-item-refunded');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent('返金済み 2点');
    const row = marks[0].closest('.account-order-lines');
    expect(row).toHaveTextContent('リネンシャツ');
    expect(row).not.toHaveTextContent('ウールコート');
  });

  it('キャンセルの手続き中の注文は、その言葉を状態に出し、進み具合の段は出さない（今の動きを固める）', async () => {
    await renderPage(
      order({
        status: 'paid',
        progress: { key: 'cancel_pending', label: 'キャンセルの手続き中', partiallyShipped: false, steps: null },
        items: [item({ refundedQuantity: 2 })],
        refunds: [refund({ status: 'processing', customerActionDeadline: '11月25日' })],
      }),
    );

    expect(screen.getByTestId('order-progress-status')).toHaveTextContent('キャンセルの手続き中');
    expect(screen.queryByRole('list', { name: '配送ステータス' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('region', { name: /^配送情報/ })).toHaveLength(0);
  });
});

describe('お客様の注文の画面の交換の品（グループ E-3）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
  });

  it('ご注文商品の交換の品の行に「交換の品」の印を付け、値段は「—」にする。ふつうの行は金額を出し、印を付けない。「発送準備中の商品」の欄には印を付けない', async () => {
    await renderPage(
      order({
        items: [
          item({ id: 'line-1', quantity: 1, amount: '¥12,000', shippedQuantity: 1, lineKind: 'order' }),
          item({ id: 'line-2', size: 'L', quantity: 1, amount: '¥0', readyQuantity: 1, lineKind: 'exchange' }),
        ],
      }),
    );

    expect(screen.getAllByTestId('order-item-exchange')).toHaveLength(1);
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.account-order-item'));
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).queryByTestId('order-item-exchange')).not.toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('¥12,000');
    expect(rows[0]).not.toHaveTextContent('—');
    expect(within(rows[1]).getByTestId('order-item-exchange')).toHaveTextContent('交換の品');
    expect(within(rows[1]).getByText('—')).toBeInTheDocument();
    expect(rows[1]).not.toHaveTextContent('¥0');
    // 「発送準備中の商品」の欄には印を付けない（T13-5）
    expect(screen.getByRole('region', { name: '発送準備中の商品' })).not.toHaveTextContent('交換の品');
  });

  it('配送情報の交換の品の行に「交換の品」の印を付ける。ふつうの行には付けない', async () => {
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
            trackingNumber: '1234-5678-9012', trackingUrl: null,
            items: [{ orderItemId: 'line-1', name: 'リネンシャツ', color: '白', size: 'M', quantity: 1, lineKind: 'order' }],
          },
          {
            id: 'f2', number: 2, shippedAt: '2026-10-20T00:00:00.000Z', carrier: 'sagawa', carrierLabel: '佐川急便',
            trackingNumber: 'AB-123', trackingUrl: null,
            items: [{ orderItemId: 'line-2', name: 'リネンシャツ', color: '白', size: 'L', quantity: 1, lineKind: 'exchange' }],
          },
        ],
        items: [
          item({ id: 'line-1', quantity: 1, amount: '¥12,000', shippedQuantity: 1 }),
          item({ id: 'line-2', size: 'L', quantity: 1, amount: '¥0', shippedQuantity: 1, lineKind: 'exchange' }),
        ],
      }),
    );

    const first = screen.getByRole('region', { name: '配送情報（1回目）' });
    expect(first).toHaveTextContent('リネンシャツ（白 / M） × 1');
    expect(within(first).queryByTestId('order-shipment-exchange')).not.toBeInTheDocument();

    const second = screen.getByRole('region', { name: '配送情報（2回目）' });
    expect(second).toHaveTextContent('リネンシャツ（白 / L） × 1');
    expect(within(second).getByTestId('order-shipment-exchange')).toHaveTextContent('交換の品');
  });

  it('交換の品の行が無い注文（lineKind を省いた古い形の答えを含む）には、どちらの印も出さない', async () => {
    await renderPage(order());

    expect(screen.queryAllByTestId('order-item-exchange')).toHaveLength(0);
    expect(screen.queryAllByTestId('order-shipment-exchange')).toHaveLength(0);
  });
});

describe('お客様の注文の画面の返品・交換の欄（グループ E-3 段2）', () => {
  beforeEach(() => {
    mockClientFetch.mockReset();
    mockSubmitCancelRequest.mockReset();
  });

  function availability(overrides: Record<string, unknown> = {}) {
    return { returns: 'none', endedOn: null, cancel: false, ...overrides };
  }

  function returnSection(overrides: Record<string, unknown> = {}) {
    return { returns: [], cancelRequests: [], availability: availability(), ...overrides };
  }

  function answer(body: unknown) {
    return { ok: true, json: async () => body };
  }

  it.each([
    ['無い（古い形の答え）', undefined],
    ['null（窓口が読めなかった）', null],
  ])('returnSection が%sの時は、返品・交換の欄を出さない。注文の画面は今までどおり出る', async (_label, value) => {
    await renderPage(order(value === undefined ? {} : { returnSection: value }));

    expect(screen.queryByRole('region', { name: '返品・交換' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'この注文について問い合わせる' })).toBeInTheDocument();
  });

  it('欄は右の列の、支払金額の欄の後・問い合わせのボタンの前に置く。申し込める時は、注文の申し込みの画面へのリンクを出す', async () => {
    await renderPage(order({ returnSection: returnSection({ availability: availability({ returns: 'available' }) }) }));

    const payment = screen.getByRole('heading', { name: '支払金額' }).closest('section') as HTMLElement;
    const card = screen.getByRole('region', { name: '返品・交換' });
    const contact = screen.getByRole('link', { name: 'この注文について問い合わせる' });
    expect(card.closest('aside')).toBe(payment.closest('aside'));
    expect(payment.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(contact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByRole('link', { name: '返品・交換を申し込む' })).toHaveAttribute(
      'href',
      '/account/orders/order-1/return',
    );
  });

  it('キャンセルのお申し込みで選べる品と数は、入金後の注文なら発送準備中と受注生産中の合計。発送した品は選べない', async () => {
    await renderPage(
      order({
        status: 'paid',
        items: [
          item({ id: 'a', name: 'リネンシャツ', quantity: 3, shippedQuantity: 1, readyQuantity: 1, inProductionQuantity: 1 }),
          item({ id: 'b', name: 'ウールコート', color: '黒', size: 'L', quantity: 1, shippedQuantity: 1 }),
        ],
        returnSection: returnSection({ availability: availability({ cancel: true }) }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルを申し込む' }));

    expect(screen.queryByRole('group', { name: 'ウールコート（黒 / L）' })).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'リネンシャツ（白 / M）' });
    fireEvent.click(within(group).getByRole('checkbox'));
    const select = within(group).getByLabelText('数') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['1', '2']);
    expect(select).toHaveValue('2');
  });

  it('キャンセルのお申し込みで選べる数は、未入金の注文なら注文の数（窓口は未入金の注文に段の数を返さない）', async () => {
    await renderPage(
      order({
        status: 'pending',
        items: [item({ id: 'a', name: 'リネンシャツ', quantity: 3 })],
        returnSection: returnSection({ availability: availability({ cancel: true }) }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルを申し込む' }));
    const group = screen.getByRole('group', { name: 'リネンシャツ（白 / M）' });
    fireEvent.click(within(group).getByRole('checkbox'));

    const select = within(group).getByLabelText('数') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['1', '2', '3']);
    expect(select).toHaveValue('3');
  });

  it('キャンセルを申し込むと、注文の答えを読み直す。読み直しの間も今の画面を残し、申し込みの状態を出す。受け付けた文は残り、申し込みのボタンは出ない', async () => {
    const before = order({ returnSection: returnSection({ availability: availability({ cancel: true }) }) });
    const after = order({
      returnSection: returnSection({
        cancelRequests: [
          {
            id: 'cr-1',
            status: 'requested',
            requestedAt: '2026-10-13T01:00:00.000Z',
            lines: [{ itemName: 'リネンシャツ', color: '白', size: 'M', quantity: 2 }],
            declineMessage: null,
          },
        ],
        availability: availability({ cancel: false }),
      }),
    });
    let finishReload: (value: unknown) => void = () => {};
    mockClientFetch.mockResolvedValueOnce(answer(before)).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReload = resolve;
        }),
    );
    mockSubmitCancelRequest.mockResolvedValueOnce({
      kind: 'ok',
      body: { data: { cancelRequestId: 'cr-1', replayed: false } },
    });
    render(<AccountOrderDetailPage />);
    await screen.findByText('ORD-0001');

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルを申し込む' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'リネンシャツ（白 / M）' }));
    fireEvent.click(screen.getByRole('button', { name: '申し込む' }));

    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(2));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, '/api/orders/order-1', { cache: 'no-store' });
    expect(mockSubmitCancelRequest).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ lines: [{ orderItemId: 'line-1', quantity: 2 }], customerNote: null }),
    );
    // 読み直しの間は、今の画面を残す（スケルトンで欄を押し下げない）
    expect(document.querySelector('.animate-pulse')).toBeNull();
    expect(screen.getByText('ORD-0001')).toBeInTheDocument();

    finishReload(answer(after));
    const card = screen.getByRole('region', { name: '返品・交換' });
    expect((await within(card).findByTestId('order-cancel-request-status')).textContent).toBe('キャンセルのお申し込み中');
    expect(within(card).getByTestId('order-cancel-notice')).toHaveTextContent(
      'キャンセルのお申し込みを受け付けました。内容を確かめて、メールでご連絡します。',
    );
    expect(within(card).queryByRole('button', { name: 'キャンセルを申し込む' })).not.toBeInTheDocument();
  });
});
