import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { OrderStatusPublic } from '@/features/order-status/components/OrderStatusPublic';
import { OrderStatusPrivate } from '@/features/order-status/components/OrderStatusPrivate';
import type { CustomerOrderPrivateView, CustomerOrderPublicView, PublicCustomerOrderReturn } from '@/lib/orders/customer-order-view-types';
import { DELIVERY_STATUS_LABELS } from '@/lib/orders/tracking/delivery-messages';
import { ORDER_PROGRESS_LABELS } from '@/lib/orders/order-progress';

jest.mock('next/image', () => ({ src, alt }: { src: string; alt: string }) => React.createElement('img', { src, alt }));
function view(): CustomerOrderPublicView {
  return {
    id: 'order', orderNumber: 'ORD-1234ABCD', orderDate: '2026/10/22 09:00', status: 'paid',
    progress: { key: 'ready', label: '発送準備中', partiallyShipped: true, steps: [
      { key: 'payment', label: 'お支払い', state: 'done' }, { key: 'ready', label: '発送準備中', state: 'current' },
      { key: 'in_transit', label: '配送中', state: 'todo' }, { key: 'delivered', label: '配達済み', state: 'todo' },
    ] },
    items: [{ id: 'item', itemId: 1, variantId: 1, name: 'リネン', imageUrl: null, color: '白', size: 'M', quantity: 3, amount: '¥300', lineKind: 'order', shippedQuantity: 1, refundedQuantity: 1, readyQuantity: 1, inProductionQuantity: 1 }],
    shipments: [{ id: 'shipment', number: 1, shippedAt: '2026-10-21T23:30:00Z', carrier: 'yamato', carrierLabel: 'ヤマト運輸', deliveredAt: null,
      delivery: { status: 'delayed', statusAt: '2026-10-21T23:30:00Z', events: [{ status: 'confirmed', happenedAt: '2026-10-21T23:00:00Z' }] },
      items: [{ orderItemId: 'item', name: 'リネン', color: '白', size: 'M', quantity: 1, lineKind: 'exchange' }] }],
    refunds: [{ id: 'refund', date: '2026/10/22', amount: '¥100', status: 'processing' }, { id: 'refund2', date: '2026/10/22', amount: '¥100', status: 'completed' }], refundTotal: '¥200',
    subtotalAmount: '¥300', shippingAmount: '¥50', discountAmount: '-¥10', totalAmount: '¥340', returnSection: null,
  };
}

test('公開欄には進み具合と商品と金額を出し個人情報の文字が無い', () => {
  const data = { ...view(), shippingPhone: 'PRIVATE_SENTINEL', paymentMethod: 'PRIVATE_SENTINEL' };
  render(<OrderStatusPublic view={data} />);
  expect(screen.getByRole('heading', { name: 'ご注文の状況' })).toBeVisible();
  for (const text of ['注文番号 ORD-1234ABCD', 'ご注文日 2026/10/22 09:00', '一部発送済み', '数量: 3', '返金済み 1点', '白 / M']) expect(screen.getByText(text)).toBeVisible();
  expect(document.body.textContent?.includes('PRIVATE_SENTINEL')).toBe(false);
  for (const name of ['発送準備中の商品', '受注生産中の商品', 'ご注文商品', '支払金額', 'ご返金']) expect(screen.getByRole('heading', { name })).toBeVisible();
  for (const text of ['小計', '送料', 'クーポン値引き', '手続き中', '完了', 'ご返金の合計', '発送日', '配送業者', 'ヤマト運輸', '配送に遅れや問題が出ています。詳しくは配送業者のページをご確認ください', '最後の更新 2026/10/22 08:30']) expect(screen.getByText(text)).toBeVisible();
  expect(screen.getByRole('list', { name: '配送ステータス' }).querySelector('[aria-current="step"]')).toHaveTextContent('発送準備中');
  expect(screen.getByRole('region', { name: '配送情報（1回目）' })).toBeVisible();
  expect(screen.getByRole('heading', { name: '配送の移り変わり' })).toBeVisible();
  expect(screen.queryByRole('link', { name: '配送状況を確認する' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '再度購入' })).not.toBeInTheDocument();
});

test.each(Object.entries(DELIVERY_STATUS_LABELS))('配送%sのラベルを保つ', (status, label) => {
  const data = view(); if (data.shipments[0].delivery) data.shipments[0].delivery.status = status as keyof typeof DELIVERY_STATUS_LABELS;
  render(<OrderStatusPublic view={data} />); expect(screen.getAllByText(label).length > 0).toBe(true);
});

test.each(Object.entries(ORDER_PROGRESS_LABELS).filter(([key]) => !['payment_in_progress', 'abandoned'].includes(key)))('公開進捗%sのラベルを保つ', (key, label) => {
  const data = view(); data.progress = { key: key as keyof typeof ORDER_PROGRESS_LABELS, label: label as CustomerOrderPublicView['progress']['label'], partiallyShipped: false, steps: null };
  render(<OrderStatusPublic view={data} />);
  expect(screen.getAllByText(label).length > 0).toBe(true);
  expect(screen.queryByRole('list', { name: '配送ステータス' })).not.toBeInTheDocument();
});

function returnRow(overrides: Partial<PublicCustomerOrderReturn> = {}): PublicCustomerOrderReturn {
  return { id: 'ret', number: 1, label: 'ORD-1234ABCD-R1', status: 'open', customerStatus: 'accepted', returnMethod: 'not_required', returnShippingPayer: 'shop', returnShippingFee: 0,
    requestedAt: '2026-10-22T00:00:00Z', closedAt: null, lines: [], refundAmount: null, sentBack: [], declineMessage: null, exchangeShipping: 'none', ...overrides };
}
function withReturns(returns: PublicCustomerOrderReturn[]): CustomerOrderPublicView {
  return { ...view(), returnSection: { returns, cancelRequests: [], availability: { returns: 'none', endedOn: null, cancel: false } } };
}
const privateData = (returnAddress: CustomerOrderPrivateView['returns'][number]['returnAddress']): CustomerOrderPrivateView => ({
  shipping: { fullName: 'PRIVATE_SENTINEL', postalCode: '', address: '', phone: '' }, contactEmail: '', paymentMethod: '', shipments: [],
  returns: [{ id: 'ret', returnAddress, sentBack: [] }],
});
const ADDRESS = { name: '返品係', postalCode: 'SYNTHETIC-POST', address: 'SYNTHETIC-ADDRESS', phone: 'SYNTHETIC-PHONE' };

test('確かめる前も返送不要の返品には「品物のご返送は不要です。」を1回だけ出す（J-15）', () => {
  render(<OrderStatusPublic view={withReturns([returnRow()])} />);
  expect(screen.getAllByText('品物のご返送は不要です。')).toHaveLength(1);
  expect(screen.getByRole('heading', { name: '返送のしかた' })).toBeVisible();
});

test('確かめた後も「品物のご返送は不要です。」は公開と個人情報を合わせて1回だけ（J-15）', () => {
  const data = withReturns([returnRow()]);
  render(<><OrderStatusPublic view={data} /><OrderStatusPrivate data={privateData(null)} publicReturns={data.returnSection?.returns ?? []} /></>);
  expect(screen.getAllByText('品物のご返送は不要です。')).toHaveLength(1);
});

test('返送が要る返品は、確かめる前に返送先・返送料・伝票番号を出さず、確かめた後だけ返送先を出す（J-15）', () => {
  const data = withReturns([returnRow({ returnMethod: 'customer_ships' })]);
  const { rerender } = render(<OrderStatusPublic view={data} />);
  expect(screen.queryByText('品物のご返送は不要です。')).not.toBeInTheDocument();
  expect(screen.queryByTestId('order-return-how-to')).not.toBeInTheDocument();
  expect(screen.queryByTestId('order-return-shipping')).not.toBeInTheDocument();
  expect(document.body.textContent?.includes('SYNTHETIC-ADDRESS')).toBe(false);
  rerender(<><OrderStatusPublic view={data} /><OrderStatusPrivate data={privateData(ADDRESS)} publicReturns={data.returnSection?.returns ?? []} /></>);
  expect(within(screen.getByTestId('order-return-address')).getByText('SYNTHETIC-ADDRESS', { exact: false })).toBeVisible();
  expect(screen.getAllByTestId('order-return-how-to')).toHaveLength(1);
  expect(screen.queryByText('品物のご返送は不要です。')).not.toBeInTheDocument();
});

test('返送不要でも、受付済み・一部お受け取り以外の状態では文を出さない（J-15）', () => {
  render(<OrderStatusPublic view={withReturns([returnRow({ id: 'a', customerStatus: 'inspecting' }), returnRow({ id: 'b', customerStatus: 'returned' }), returnRow({ id: 'c', customerStatus: 'requested' })])} />);
  expect(screen.queryByText('品物のご返送は不要です。')).not.toBeInTheDocument();
});

test('届いた日を優先し、空の区分と返金と返品は出さず、壊れた日付はハイフン', () => {
  const data = view(); data.shipments[0].deliveredAt = '2026-10-21T23:30:00Z';
  data.shipments[0].shippedAt = 'invalid'; data.items = []; data.refunds = []; data.refundTotal = null;
  render(<OrderStatusPublic view={data} />);
  const shipment = within(screen.getByRole('region', { name: '配送情報（1回目）' }));
  expect(shipment.getByText('お届け日 10月22日')).toBeVisible(); expect(shipment.getByText('-')).toBeVisible();
  expect(shipment.queryByText('遅れ')).not.toBeInTheDocument();
  for (const name of ['発送準備中の商品', '受注生産中の商品', 'ご返金', '返品・交換']) expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument();
});
