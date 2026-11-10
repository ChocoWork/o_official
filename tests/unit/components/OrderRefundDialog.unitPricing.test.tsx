import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RefundMaterialLine, RefundMaterials } from '@/lib/orders/refund/refund-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderRefundDialog from '@/components/OrderRefundDialog';

// FREQ-642: 発送前の品を選ぶ返金の標準の額は、見込みの窓口（refund-estimate）の額。画面の計算は使わない。
// 発送後の品だけの返金は、窓口へ聞かず今の計算のまま（着の状態も E も変わらない。AC-28）。

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const TITLE = '返金（注文 ORD-A1B2C3D4）';
const REFUND_URL = `/api/admin/orders/${ORDER_ID}/refund`;
const ESTIMATE_URL = `/api/admin/orders/${ORDER_ID}/refund-estimate`;

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const STOCK_LINE: RefundMaterialLine = {
  orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  itemPrice: 12000, quantity: 2, lineTotal: 24000, shipped: 0, unshipped: 2,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 2,
  lineDiscount: 0, availableUnitAmounts: null, refundedUnits: 0,
};
const SHIPPED_LINE: RefundMaterialLine = {
  orderItemId: 'item-shipped', name: 'レザーベルト', color: '茶', size: null, fulfillmentType: 'stock',
  itemPrice: 9000, quantity: 1, lineTotal: 9000, shipped: 1, unshipped: 0,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 1, restockable: 0,
  lineDiscount: 0, availableUnitAmounts: null, refundedUnits: 0,
};

const MATERIALS: RefundMaterials = {
  order: {
    id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid', paymentMethod: 'card',
    totalAmount: 33800, shippingAmount: 800, discountAmount: 0, paidAmount: 33800,
    succeededAmount: 0, openAmount: 0, refundableAmount: 33800, refundedShipping: 0, refundableShipping: 800,
    shippedTotal: 1, unshippedTotal: 2,
  },
  lines: [STOCK_LINE, SHIPPED_LINE],
  awaitingRefund: null,
};

const estimateOf = (overrides: Record<string, unknown> = {}) => ({
  legacy: false, suggestedAmount: 17000, itemsAmount: 17000, refundCap: 33800, changesUnits: true, ...overrides,
});

function install(estimate: () => Promise<Response>) {
  mockClientFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === REFUND_URL && init?.method !== 'POST') return json(MATERIALS);
    if (url === ESTIMATE_URL) return estimate();
    if (url === REFUND_URL) return json({ refundId: 'refund-1', status: 'pending', amount: 17000, replayed: false });
    throw new Error(`unexpected ${url}`);
  });
}

async function open(estimate: () => Promise<Response>) {
  install(estimate);
  render(<OrderRefundDialog orderId={ORDER_ID} onClose={jest.fn()} onRefunded={jest.fn()} />);
  const dialog = await screen.findByRole('dialog', { name: TITLE });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return dialog;
}

const submit = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
const estimateCalls = () => mockClientFetch.mock.calls.filter(([url]) => url === ESTIMATE_URL);
const setQuantity = (dialog: HTMLElement, id: string, value: number) =>
  fireEvent.change(within(dialog).getByLabelText('返金する数', { selector: `#${id}` }), { target: { value: String(value) } });

beforeEach(() => mockClientFetch.mockReset());

describe('返金の画面の見込み（FREQ-642）', () => {
  test('DD-ADMIN-023: 発送前の品を選ぶ返金の見込みは窓口の額（画面の計算 12,800円ではない）', async () => {
    const dialog = await open(async () => json({ data: estimateOf() }));
    setQuantity(dialog, 'refund-quantity-item-stock-before', 1);
    const group = await within(dialog).findByRole('group', { name: '返金の内訳' });
    expect(within(group).getByText('返金額').parentElement).toHaveTextContent('￥17,000');
    expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(17000);
    // 商品の行は窓口の itemsAmount
    expect(within(group).getByText('商品').parentElement).toHaveTextContent('￥17,000');

    expect(estimateCalls()).toHaveLength(1);
    expect(JSON.parse((estimateCalls()[0][1] as RequestInit).body as string)).toEqual({
      lines: [{ orderItemId: 'item-stock', quantity: 1, beforeShipment: true }],
      shippingAmount: 0,
    });
    await waitFor(() => expect(submit(dialog)).toBeEnabled());
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(mockClientFetch.mock.calls.some(([url, init]) => url === REFUND_URL && (init as RequestInit)?.method === 'POST')).toBe(true));
    const [, init] = mockClientFetch.mock.calls.find(([url, i]) => url === REFUND_URL && (i as RequestInit)?.method === 'POST')!;
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ amount: 17000 });
  });

  test('DD-ADMIN-023: 窓口の標準の額が返せる額や窓口の上限を超える時は、上限で切る', async () => {
    const dialog = await open(async () => json({ data: estimateOf({ suggestedAmount: 40000, refundCap: 30000 }) }));
    setQuantity(dialog, 'refund-quantity-item-stock-before', 1);
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(30000));
  });

  test('DD-ADMIN-023: 手で入れた返金額は、選びを変えた後の新しい窓口の額を上書きしない（上限で切る）', async () => {
    let n = 0;
    const dialog = await open(async () => json({ data: n++ === 0 ? estimateOf() : estimateOf({ suggestedAmount: 34000, itemsAmount: 34000 }) }));
    setQuantity(dialog, 'refund-quantity-item-stock-before', 1);
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(17000));
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '返金額' }), { target: { value: '5000' } });
    expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(5000);

    setQuantity(dialog, 'refund-quantity-item-stock-before', 2);
    // 新しい窓口の額（34,000円を窓口の上限 33,800円で切った額）が出る。前に入れた 5,000円は残らない
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(33800));
  });

  test('DD-ADMIN-023: 送料を直すと見込みを出し直す', async () => {
    const dialog = await open(async () => json({ data: estimateOf() }));
    setQuantity(dialog, 'refund-quantity-item-stock-before', 1);
    await waitFor(() => expect(estimateCalls()).toHaveLength(1));
    fireEvent.change(within(dialog).getByLabelText('送料', { selector: '#refund-shipping' }), { target: { value: '800' } });
    await waitFor(() => expect(estimateCalls()).toHaveLength(2));
    expect(JSON.parse((estimateCalls()[1][1] as RequestInit).body as string)).toMatchObject({ shippingAmount: 800 });
  });

  test('DD-ADMIN-023: 見込みを待つ間は「計算しています」を出し、返金のボタンを止める', async () => {
    let resolveEstimate: (value: Response) => void = () => {};
    const dialog = await open(() => new Promise<Response>((resolve) => { resolveEstimate = resolve; }));
    setQuantity(dialog, 'refund-quantity-item-stock-before', 1);
    expect(within(dialog).getByText('計算しています')).toBeInTheDocument();
    expect(submit(dialog)).toBeDisabled();
    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();
    await waitFor(() => expect(estimateCalls()).toHaveLength(1));
    resolveEstimate(json({ data: estimateOf() }));
    await waitFor(() => expect(submit(dialog)).toBeEnabled());
  });

  test('DD-ADMIN-023: 見込みの誤りでは額を出さず、文を出して返金を止める', async () => {
    const dialog = await open(async () => json({ error: '返金の額の計算を確かめられませんでした。画面を開き直してください。' }, 409));
    setQuantity(dialog, 'refund-quantity-item-stock-before', 1);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返金の額の計算を確かめられませんでした。画面を開き直してください。');
    expect(within(dialog).queryByRole('spinbutton', { name: '返金額' })).not.toBeInTheDocument();
    expect(submit(dialog)).toBeDisabled();
  });

  test('FREQ-642-AC-28: 発送後の品だけの返金は窓口へ聞かず、今の計算のまま（9,000円）', async () => {
    const dialog = await open(async () => json({ data: estimateOf() }));
    setQuantity(dialog, 'refund-quantity-item-shipped-after', 1);
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(9000));
    expect(estimateCalls()).toHaveLength(0);
    expect(submit(dialog)).toBeEnabled();
  });

  test('FREQ-642-AC-20: 写しの無い注文（legacy）は窓口の額が画面の計算と同じ（12,000円）', async () => {
    const dialog = await open(async () => json({ data: estimateOf({ legacy: true, suggestedAmount: 12000, changesUnits: false }) }));
    setQuantity(dialog, 'refund-quantity-item-stock-before', 1);
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(12000));
    const group = within(dialog).getByRole('group', { name: '返金の内訳' });
    expect(within(group).getByText('商品').parentElement).toHaveTextContent('￥12,000');
  });
});
