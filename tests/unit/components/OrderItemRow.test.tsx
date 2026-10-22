import React from 'react';
import { render, screen } from '@testing-library/react';
import { OrderItemRow, type OrderLineItem } from '@/features/account/components/OrderItemRow';

jest.mock('next/link', () => ({ href, children, ...props }: any) => (
  <a href={href} {...props}>
    {children}
  </a>
));
jest.mock('next/image', () => ({ src, alt }: any) => React.createElement('img', { src, alt }));

function lineItem(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    id: 'line-1', itemId: 10, variantId: 101, name: 'リネンシャツ', imageUrl: null, color: '白', size: 'M',
    quantity: 3, amount: '¥36,000', ...overrides,
  };
}

function renderRow(overrides: Partial<OrderLineItem> = {}) {
  render(<OrderItemRow item={lineItem(overrides)} isReordering={false} onReorder={jest.fn()} />);
}

test('readOnlyの商品は購入と予約注文を出さない', () => {
  const { rerender } = render(<OrderItemRow item={lineItem()} readOnly />);
  expect(screen.queryByRole('button', { name: '再度購入' })).not.toBeInTheDocument();
  rerender(<OrderItemRow item={lineItem({ stockStatus: 'sold_out' })} readOnly />);
  expect(screen.queryByRole('link', { name: '予約注文' })).not.toBeInTheDocument();
  expect(screen.getByText('リネンシャツ')).toBeVisible();
});

describe('OrderItemRow の返金済みの印（グループ E-2）', () => {
  it('返金した数が1以上なら、数量の下に「返金済み n点」の印を出す', () => {
    renderRow({ refundedQuantity: 2 });

    expect(screen.getByTestId('order-item-refunded')).toHaveTextContent('返金済み 2点');
    expect(screen.getByText('数量: 3')).toBeInTheDocument();
  });

  it('返金した数が0なら印を出さない', () => {
    renderRow({ refundedQuantity: 0 });

    expect(screen.queryByTestId('order-item-refunded')).not.toBeInTheDocument();
    expect(screen.queryByText(/返金済み/)).not.toBeInTheDocument();
  });

  it('返金した数の欄を省いた商品（欄を足す前の呼び出し）は、印を出さず、今の表示のまま', () => {
    renderRow();

    expect(screen.queryByTestId('order-item-refunded')).not.toBeInTheDocument();
    expect(screen.getByText('リネンシャツ')).toBeInTheDocument();
    expect(screen.getByText('白 / M')).toBeInTheDocument();
    expect(screen.getByText('数量: 3')).toBeInTheDocument();
    expect(screen.getByText('¥36,000')).toBeInTheDocument();
    // 再度購入のボタンは、小さい画面用（情報の列の中）と sm 以上用（右端）の2か所に置く（jsdom は CSS を当てないので両方が見える）
    expect(screen.getAllByRole('button', { name: '再度購入' })).toHaveLength(2);
  });
});

describe('OrderItemRow の交換の品の印（グループ E-3）', () => {
  it('交換の品の行は、数量の下に「交換の品」の印を出し、値段を「—」にする（¥0 と出さない）', () => {
    renderRow({ lineKind: 'exchange', quantity: 1, amount: '¥0' });

    expect(screen.getByTestId('order-item-exchange')).toHaveTextContent('交換の品');
    expect(screen.getByText('数量: 1')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('¥0')).not.toBeInTheDocument();
  });

  it('ふつうの行（lineKind が order）は、印を出さず、金額をそのまま出す', () => {
    renderRow({ lineKind: 'order' });

    expect(screen.queryByTestId('order-item-exchange')).not.toBeInTheDocument();
    expect(screen.queryByText('交換の品')).not.toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    expect(screen.getByText('¥36,000')).toBeInTheDocument();
  });

  it('交換の品の行に返金した数が付いた時は、2つの印を並べて出す（T13-7）', () => {
    renderRow({ lineKind: 'exchange', amount: '¥0', refundedQuantity: 1 });

    expect(screen.getByTestId('order-item-exchange')).toHaveTextContent('交換の品');
    expect(screen.getByTestId('order-item-refunded')).toHaveTextContent('返金済み 1点');
  });
});
