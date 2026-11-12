import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderReturnRefundDialog from '@/components/OrderReturnRefundDialog';

// FREQ-642: 額を決めて返金（相談の返金）の標準の額は、見込みの窓口の「相談の残り」（consultOutstanding）だけから出す。
// 窓口は受け取りの見込みの窓口を、品を選ばない本文で呼んで使う（読むだけ。新しい窓口は足さない）。

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'ret-0001';
const LABEL = 'ORD-A1B2C3D4-R1';
const RETURNS_URL = `/api/admin/orders/${ORDER_ID}/returns`;
const ESTIMATE_URL = `/api/admin/returns/${RETURN_ID}/receive-estimate`;
const REFUND_URL = `/api/admin/returns/${RETURN_ID}/refund`;

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const WAITING_BLOUSE: OrderReturnLineDetail = {
  id: 'line-blouse', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-blouse',
  itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, reason: 'size_too_small', reasonNote: null,
  resolution: 'refund', exchange: null,
  progress: {
    restocked: 2, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
    processed: 2, unprocessed: 0, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 2,
  },
  refundAmountsByCount: [], refundWaitingAmount: 24000, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
};

function returnDetail(): OrderReturnDetail {
  return {
    id: RETURN_ID, number: 1, label: LABEL, status: 'open', source: 'shop',
    displayStatus: 'refund_waiting', marks: [],
    returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
    fees: {
      returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0,
      feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
    },
    firstReceiptDone: true, firstExchangeReceiptDone: false,
    shopNote: null, notifyCustomer: true, createdAt: '2026-10-12T01:00:00.000Z', createdByEmail: 'admin@example.com',
    closedAt: null, cancelledAt: null, requestedAt: null, approvedAt: null, approvedByEmail: null, declinedAt: null, declineReason: null, declineMessage: null,
    lines: [WAITING_BLOUSE], refunds: [], receipts: [], exchangeItems: [],
  };
}

const estimateOf = (overrides: Record<string, unknown> = {}) => ({
  legacy: false, standardRefund: 0, nowRefund: 0, consultRefund: 0, feeAmount: 0, fixedFees: 0,
  refundAmount: 0, refundCap: 0, consultOutstanding: 17000, ...overrides,
});

function install(estimate: () => Promise<Response>) {
  mockClientFetch.mockImplementation(async (url: string) => {
    if (url === RETURNS_URL) {
      return json({ data: { returns: [returnDetail()], canRefund: true, returnableUnits: 0, refundableAmount: 54800, refundableShipping: 800 } });
    }
    if (url === ESTIMATE_URL) return estimate();
    if (url === REFUND_URL) return json({ data: { refundId: 'refund-1', amount: 17000, status: 'pending', replayed: false } });
    throw new Error(`unexpected ${url}`);
  });
}

async function open(estimate: () => Promise<Response>) {
  install(estimate);
  render(<OrderReturnRefundDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);
  return screen.findByRole('dialog', { name: `額を決めて返金する（${LABEL}）` });
}

const submit = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
const breakdown = async (dialog: HTMLElement, term: string) =>
  within(await within(dialog).findByRole('group', { name: '返金の内訳' })).getByText(term).parentElement?.textContent ?? '';

beforeEach(() => mockClientFetch.mockReset());

describe('額を決めて返金の標準の額（FREQ-642）', () => {
  test('DD-ADMIN-023: 標準の額は窓口の相談の残りで、画面の待ち額（24,000円）ではない', async () => {
    const dialog = await open(async () => json({ data: estimateOf() }));
    expect(await breakdown(dialog, '商品')).toBe('商品￥17,000');
    expect(await breakdown(dialog, '返金額')).toBe('返金額￥17,000');
    expect(within(dialog).getByRole('spinbutton', { name: /返金額/ })).toHaveValue(17000);
    // 窓口へは、品を選ばない本文で聞く
    const [, init] = mockClientFetch.mock.calls.find(([url]) => url === ESTIMATE_URL)!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      units: [], exchangeOverrides: [], refundChoice: 'none', refundShippingAmount: 0,
    });
    await waitFor(() => expect(submit(dialog)).toBeEnabled());
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(mockClientFetch.mock.calls.some(([url]) => url === REFUND_URL)).toBe(true));
    // 見込みと同じ額なら額を送らない（DB が同じ式で計算する）
    const [, refundInit] = mockClientFetch.mock.calls.find(([url]) => url === REFUND_URL)!;
    expect(JSON.parse((refundInit as RequestInit).body as string)).toMatchObject({ amount: null });
  });

  test('DD-ADMIN-023: 相談の出来事が全部返金済みなら 0円で、返金しないで終える', async () => {
    const dialog = await open(async () => json({ data: estimateOf({ consultOutstanding: 0 }) }));
    expect(await breakdown(dialog, '商品')).toBe('商品￥0');
    expect(submit(dialog)).toHaveTextContent('返金しないで終える');
  });

  test('DD-ADMIN-023: 見込みを待つ間は「計算しています」を出し、返金のボタンを止める', async () => {
    let resolveEstimate: (value: Response) => void = () => {};
    const dialog = await open(() => new Promise<Response>((resolve) => { resolveEstimate = resolve; }));
    expect(within(dialog).getByText('計算しています')).toBeInTheDocument();
    expect(submit(dialog)).toBeDisabled();
    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();
    await waitFor(() => expect(mockClientFetch.mock.calls.some(([url]) => url === ESTIMATE_URL)).toBe(true));
    resolveEstimate(json({ data: estimateOf() }));
    await waitFor(() => expect(submit(dialog)).toBeEnabled());
  });

  test('DD-ADMIN-023: 見込みの誤りでは額を出さず、文を出して返金を止める', async () => {
    const dialog = await open(async () => json({ error: '返金の額の計算を確かめられませんでした。画面を開き直してください。', code: 'UNIT_PRICING_INVALID' }, 409));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返金の額の計算を確かめられませんでした。画面を開き直してください。');
    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();
    expect(submit(dialog)).toBeDisabled();
  });

  test('FREQ-642-AC-37: 送料の欄は、返し直す今すぐの分の失敗した返金の送料（500円）で始まり、額を送らずに送料を送る', async () => {
    const dialog = await open(async () => json({ data: estimateOf({ retryShipping: 500 }) }));
    expect(await breakdown(dialog, '送料')).toBe('送料￥500');
    expect(await breakdown(dialog, '返金額')).toBe('返金額￥17,500');
    expect(within(dialog).getByRole('spinbutton', { name: /^送料/ })).toHaveValue(500);
    await waitFor(() => expect(submit(dialog)).toBeEnabled());
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(mockClientFetch.mock.calls.some(([url]) => url === REFUND_URL)).toBe(true));
    const [, refundInit] = mockClientFetch.mock.calls.find(([url]) => url === REFUND_URL)!;
    expect(JSON.parse((refundInit as RequestInit).body as string)).toMatchObject({ amount: null, shippingAmount: 500 });
  });

  test('FREQ-642-AC-37: 送料の初めの値は返せる送料（800円）を超えず、店長が変えられる', async () => {
    const dialog = await open(async () => json({ data: estimateOf({ retryShipping: 1100 }) }));
    expect(await breakdown(dialog, '送料')).toBe('送料￥800');
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /^送料/ }), { target: { value: '0' } });
    expect(await breakdown(dialog, '送料')).toBe('送料￥0');
    expect(await breakdown(dialog, '返金額')).toBe('返金額￥17,000');
  });

  test('FREQ-642-AC-37: 送料の初めの値が入ったまま返金額を0にすると、押せない理由（返金額と送料をどちらも0円に）を出す', async () => {
    const dialog = await open(async () => json({ data: estimateOf({ retryShipping: 500 }) }));
    await waitFor(() => expect(submit(dialog)).toBeEnabled());
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /^返金額/ }), { target: { value: '0' } });
    expect(within(dialog).getByText('返金しないで終えるには、返金額と送料をどちらも0円にしてください。')).toBeInTheDocument();
    expect(submit(dialog)).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /^送料/ }), { target: { value: '0' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: /^返金額/ }), { target: { value: '0' } });
    expect(within(dialog).queryByText('返金しないで終えるには、返金額と送料をどちらも0円にしてください。')).not.toBeInTheDocument();
    expect(within(dialog).getByText('返金しないで終えます。お客様に返金のメールは送りません。')).toBeInTheDocument();
    expect(submit(dialog)).toBeEnabled();
    expect(submit(dialog)).toHaveTextContent('返金しないで終える');
  });

  test('FREQ-642-AC-37: 返し直す今すぐの分が無ければ、送料の欄は 0 で始まる（今までどおり）', async () => {
    const dialog = await open(async () => json({ data: estimateOf({ retryShipping: 0 }) }));
    expect(await breakdown(dialog, '送料')).toBe('送料￥0');
  });

  test('FREQ-642-AC-20: 写しの無い注文（legacy）は今の画面の計算（待ち額 24,000円）のまま', async () => {
    const dialog = await open(async () => json({ data: estimateOf({ legacy: true, consultOutstanding: undefined }) }));
    expect(await breakdown(dialog, '商品')).toBe('商品￥24,000');
    await waitFor(() => expect(submit(dialog)).toBeEnabled());
  });
});
