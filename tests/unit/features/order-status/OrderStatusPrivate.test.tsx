import { render, screen, within } from '@testing-library/react';
import { OrderStatusPrivate } from '@/features/order-status/components/OrderStatusPrivate';
import type { CustomerOrderPrivateView, PublicCustomerOrderReturn } from '@/lib/orders/customer-order-view-types';
import { CUSTOMER_RETURN_STATUSES } from '@/lib/orders/returns/customer-return-types';
import { formatYen } from '@/lib/orders/refund/refund-messages';

function orderReturn(): PublicCustomerOrderReturn {
  return { id: 'ret', number: 1, label: 'ORD-1234ABCD-R1', status: 'open', customerStatus: 'accepted', returnMethod: 'customer_ships', returnShippingPayer: 'shop', returnShippingFee: 0,
    requestedAt: '2026-10-22T00:00:00Z', closedAt: null, lines: [], refundAmount: null, sentBack: [{ itemName: 'リネン', color: null, size: null, quantity: 1, message: null }], declineMessage: null, exchangeShipping: 'none' };
}
function data(): CustomerOrderPrivateView {
  return { shipping: { fullName: 'PRIVATE_SENTINEL', postalCode: '', address: '', phone: '' }, contactEmail: '', paymentMethod: '',
    shipments: [{ id: 's1', number: 1, trackingNumber: 'SYNTHETIC-TRACKING', trackingUrl: 'https://example.invalid/tracking' }, { id: 's2', number: 2, trackingNumber: null, trackingUrl: null }],
    returns: [{ id: 'ret', returnAddress: { name: '返品係', postalCode: 'SYNTHETIC-POST', address: 'SYNTHETIC-ADDRESS', phone: 'SYNTHETIC-PHONE' }, sentBack: [{ index: 0, trackingNumber: 'SYNTHETIC-RETURN' }] }] };
}

test('個人情報の全ラベルと空のハイフン、番号ありの行だけを出す', () => {
  render(<OrderStatusPrivate data={data()} publicReturns={[orderReturn()]} />);
  for (const name of ['お届け先', 'ご連絡先', 'お支払い方法', '伝票番号', '返品の返送先・送り返しの伝票番号']) expect(screen.getByRole('heading', { name })).toBeVisible();
  for (const text of ['お名前', '郵便番号', '住所', '電話番号', 'メールアドレス']) expect(screen.getByText(text)).toBeVisible();
  expect(screen.getAllByText('-')).toHaveLength(5);
  expect(screen.getByText('追跡番号 SYNTHETIC-TRACKING')).toBeVisible();
  expect(screen.queryByText('配送情報（2回目）')).not.toBeInTheDocument();
  const link = screen.getByRole('link', { name: '配送状況を確認する' });
  expect(link).toHaveAttribute('href', 'https://example.invalid/tracking'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText('送り返しの伝票番号: SYNTHETIC-RETURN')).toBeVisible();
  expect(screen.queryByText('お返しした商品')).not.toBeInTheDocument();
});

test.each(CUSTOMER_RETURN_STATUSES)('返送先の状態条件を保つ（%s）', (customerStatus) => {
  render(<OrderStatusPrivate data={data()} publicReturns={[{ ...orderReturn(), customerStatus }]} />);
  const addressPresent = document.body.textContent?.includes('SYNTHETIC-ADDRESS');
  expect(addressPresent).toBe(['accepted', 'partially_received'].includes(customerStatus));
  expect(screen.getByText('送り返しの伝票番号: SYNTHETIC-RETURN')).toBeVisible();
});

test('返送不要で送り返しの番号も無い返品は、返品の欄を空で出さない（J-15）', () => {
  const row = orderReturn(); row.returnMethod = 'not_required';
  const value = data(); value.returns[0].sentBack = [];
  render(<OrderStatusPrivate data={value} publicReturns={[row]} />);
  expect(screen.queryByRole('heading', { name: '返品の返送先・送り返しの伝票番号' })).not.toBeInTheDocument();
  expect(screen.queryByText('品物のご返送は不要です。')).not.toBeInTheDocument();
});

test('番号無しと対応する公開返品無しは行を出さず不正な追跡URLを出さない', () => {
  const value = data(); value.shipments[0].trackingUrl = 'javascript:alert(1)'; value.returns[0].sentBack[0].trackingNumber = null;
  render(<OrderStatusPrivate data={value} publicReturns={[]} />);
  expect(screen.queryByRole('link', { name: '配送状況を確認する' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '返品の返送先・送り返しの伝票番号' })).not.toBeInTheDocument();
});

test('返送先も番号も無い返品は空の欄を出さず、配列外の番号を使わない', () => {
  const value = data(); value.returns[0].returnAddress = null;
  value.returns[0].sentBack = [{ index: -1, trackingNumber: 'SYNTHETIC-RETURN' }, { index: 1, trackingNumber: 'SYNTHETIC-RETURN' }, { index: 0, trackingNumber: null }];
  render(<OrderStatusPrivate data={value} publicReturns={[orderReturn()]} />);
  expect(screen.queryByRole('heading', { name: '返品の返送先・送り返しの伝票番号' })).not.toBeInTheDocument();
});

test('返送不要の案内は公開の側に任せて重ねず、返送料の3条件を共有する', () => {
  const row = orderReturn(); row.returnMethod = 'not_required';
  const { rerender } = render(<OrderStatusPrivate data={data()} publicReturns={[row]} />);
  // 返送不要の文は確かめる前から公開の欄に出ている（J-15）。確かめた後に2回目を出さない
  expect(screen.queryByText('品物のご返送は不要です。')).not.toBeInTheDocument();
  expect(screen.queryByText('SYNTHETIC-ADDRESS')).not.toBeInTheDocument();
  expect(screen.getByText('送り返しの伝票番号: SYNTHETIC-RETURN')).toBeVisible();
  for (const [payer, method, fee, text] of [
    ['shop', 'customer_ships', 0, '返送料は当店が負担いたします。着払いでお送りください。'],
    ['customer', 'customer_ships', 0, '恐れ入りますが、返送料はお客様のご負担でお送りください。'],
    ['customer', 'shop_label', 100, `当店がご用意する送り状でお送りください。返送料 ${formatYen(100)} をご返金額から差し引きます。`],
    ['customer', 'shop_label', 0, '当店がご用意する送り状でお送りください。'],
  ] as const) {
    rerender(<OrderStatusPrivate data={data()} publicReturns={[{ ...row, returnMethod: method, returnShippingPayer: payer, returnShippingFee: fee }]} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(within(screen.getByTestId('order-return-address')).getByText('返送先:')).toBeVisible();
  }
});
