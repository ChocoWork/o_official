import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderReturnReceiveDialog from '@/components/OrderReturnReceiveDialog';

// FREQ-642: 受け取りの画面は、返金の見込みを見込みの窓口の額だけで出し、行ごとに「割引の扱い」を直せる。
// 窓口は実物のまま（デバウンスも実物）。clientFetch だけを URL で振り分ける。

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'ret-0001';
const LABEL = 'ORD-A1B2C3D4-R1';
const RETURNS_URL = `/api/admin/orders/${ORDER_ID}/returns`;
const ESTIMATE_URL = `/api/admin/returns/${RETURN_ID}/receive-estimate`;
const RECEIVE_URL = `/api/admin/returns/${RETURN_ID}/receive`;

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const progress = (): OrderReturnLineDetail['progress'] => ({
  restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
  processed: 0, unprocessed: 2, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
});

const blouse = (overrides: Partial<OrderReturnLineDetail> = {}): OrderReturnLineDetail => ({
  id: 'l1', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-blouse',
  itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, reason: 'size_too_small', reasonNote: null,
  resolution: 'refund', exchange: null, progress: progress(),
  refundAmountsByCount: [12000, 24000], refundWaitingAmount: 0, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
  ...overrides,
});

function returnDetail(lines: OrderReturnLineDetail[]): OrderReturnDetail {
  return {
    id: RETURN_ID, number: 1, label: LABEL, status: 'open', source: 'shop',
    displayStatus: 'in_progress', marks: ['awaiting_items'],
    returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
    fees: {
      returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0,
      feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
    },
    firstReceiptDone: false, firstExchangeReceiptDone: false,
    shopNote: null, notifyCustomer: true, createdAt: '2026-10-12T01:00:00.000Z', createdByEmail: 'admin@example.com',
    closedAt: null, cancelledAt: null, requestedAt: null, approvedAt: null, approvedByEmail: null, declinedAt: null, declineReason: null, declineMessage: null,
    lines, refunds: [], receipts: [], exchangeItems: [],
  };
}

const estimateOf = (overrides: Record<string, unknown> = {}) => ({
  legacy: false, standardRefund: 17000, nowRefund: 17000, consultRefund: 0, feeAmount: 0, fixedFees: 0,
  refundAmount: 17000, refundCap: 17000, consultOutstanding: 0, ...overrides,
});

type Handlers = { estimate: (body: Record<string, unknown>) => Promise<Response>; receive?: () => Promise<Response> };

function install(detail: OrderReturnDetail, handlers: Handlers, canRefund = true) {
  mockClientFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === RETURNS_URL) {
      return json({ data: { returns: [detail], canRefund, returnableUnits: 0, refundableAmount: 54800, refundableShipping: 800 } });
    }
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (url === ESTIMATE_URL) return handlers.estimate(body);
    if (url === RECEIVE_URL) {
      return handlers.receive
        ? handlers.receive()
        : json({ data: { receiptId: 'rc', returnStatus: 'open', refundId: null, refundAmount: null, refundStatus: null, feeDueAmount: 0, replayed: false } });
    }
    throw new Error(`unexpected ${url}`);
  });
}

async function open(detail: OrderReturnDetail, handlers: Handlers, canRefund = true) {
  install(detail, handlers, canRefund);
  render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);
  const dialog = await screen.findByRole('dialog', { name: `受け取る（${LABEL}）` });
  await waitFor(() => expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument());
  return dialog;
}

const rows = (dialog: HTMLElement) => within(within(dialog).getByRole('list', { name: '受け取る品' })).getAllByRole('listitem');
const submit = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
const estimateBodies = () =>
  mockClientFetch.mock.calls.filter(([url]) => url === ESTIMATE_URL).map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);

function receiveUnit(dialog: HTMLElement, index: number, disposition = 'not_restocked') {
  const row = rows(dialog)[index];
  fireEvent.click(within(row).getByRole('checkbox', { name: '届いた' }));
  fireEvent.change(within(row).getByRole('combobox', { name: '品の状態' }), { target: { value: disposition } });
}

beforeEach(() => mockClientFetch.mockReset());

describe('受け取りの画面の見込み（FREQ-642）', () => {
  test('FREQ-642-AC-07: 受け取りの見込みは窓口の額で、送った後の DB の額と同じ（額を直さなければ送らない）', async () => {
    const dialog = await open(returnDetail([blouse()]), { estimate: async () => json({ data: estimateOf() }) });
    receiveUnit(dialog, 0);
    receiveUnit(dialog, 1);
    const group = await within(dialog).findByRole('group', { name: '返金の内訳' });
    expect(within(group).getByText('返金額').parentElement).toHaveTextContent('￥17,000');
    // 画面の計算（1点 12,000円）ではなく窓口の額
    expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(17000);

    await waitFor(() => expect(submit(dialog)).toBeEnabled());
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(mockClientFetch.mock.calls.some(([url]) => url === RECEIVE_URL)).toBe(true));
    const receiveCall = mockClientFetch.mock.calls.find(([url]) => url === RECEIVE_URL)!;
    expect(JSON.parse((receiveCall[1] as RequestInit).body as string)).toMatchObject({ refundAmount: null });
  });

  test('FREQ-642-AC-07: 窓口の上限を超える額は、見込みの額に入れる時も上限で切る', async () => {
    const dialog = await open(returnDetail([blouse()]), {
      estimate: async () => json({ data: estimateOf({ refundAmount: 20000, refundCap: 17000 }) }),
    });
    receiveUnit(dialog, 0);
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(17000));
  });

  test('FREQ-642-AC-25: 割引の扱いは理由から決まった値で始まり、直すと見込みを出し直す', async () => {
    const dialog = await open(returnDetail([blouse()]), { estimate: async () => json({ data: estimateOf() }) });
    receiveUnit(dialog, 0);
    receiveUnit(dialog, 1);
    const select = (await within(dialog).findByRole('combobox', { name: '割引の扱い' })) as HTMLSelectElement;
    expect(select.value).toBe('customer');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['お店の側の事情', 'お客様のご都合']);
    await waitFor(() => expect(estimateBodies()).toHaveLength(1));
    expect(estimateBodies()[0]).not.toHaveProperty('treatments');

    fireEvent.change(select, { target: { value: 'shop' } });
    await waitFor(() => expect(estimateBodies()).toHaveLength(2));
    expect(estimateBodies()[1]).toMatchObject({ treatments: [{ returnLineId: 'l1', treatment: 'shop' }] });

    await waitFor(() => expect(submit(dialog)).toBeEnabled());
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(mockClientFetch.mock.calls.some(([url]) => url === RECEIVE_URL)).toBe(true));
    const receiveCall = mockClientFetch.mock.calls.find(([url]) => url === RECEIVE_URL)!;
    expect(JSON.parse((receiveCall[1] as RequestInit).body as string)).toMatchObject({
      treatments: [{ returnLineId: 'l1', treatment: 'shop' }],
    });
  });

  test('FREQ-642-AC-25: 不良・誤送の理由の行は「お店の側の事情」から始まる', async () => {
    const dialog = await open(returnDetail([blouse({ reason: 'defective' })]), { estimate: async () => json({ data: estimateOf() }) });
    receiveUnit(dialog, 0);
    const select = (await within(dialog).findByRole('combobox', { name: '割引の扱い' })) as HTMLSelectElement;
    expect(select.value).toBe('shop');
  });

  test('FREQ-642-AC-25: 返金の品が無い行（届いていない・お返し）には割引の扱いを出さない', async () => {
    const dialog = await open(returnDetail([blouse()]), { estimate: async () => json({ data: estimateOf() }) });
    expect(within(dialog).queryByRole('combobox', { name: '割引の扱い' })).not.toBeInTheDocument();
    receiveUnit(dialog, 0, 'sent_back');
    expect(within(dialog).queryByRole('combobox', { name: '割引の扱い' })).not.toBeInTheDocument();
  });

  test('FREQ-642-AC-25: 返金の権限が無い人には割引の扱いを出さず、本文にも入れない', async () => {
    const dialog = await open(returnDetail([blouse()]), { estimate: async () => json({ data: estimateOf() }) }, false);
    receiveUnit(dialog, 0);
    await waitFor(() => expect(estimateBodies().length).toBeGreaterThan(0));
    expect(within(dialog).queryByRole('combobox', { name: '割引の扱い' })).not.toBeInTheDocument();
    expect(estimateBodies()[0]).not.toHaveProperty('treatments');
  });

  test('DD-ADMIN-022: 見込みを待つ間は「計算しています」を出し、受け取りのボタンを止める', async () => {
    let resolveEstimate: (value: Response) => void = () => {};
    const dialog = await open(returnDetail([blouse()]), {
      estimate: () => new Promise<Response>((resolve) => { resolveEstimate = resolve; }),
    });
    receiveUnit(dialog, 0);
    expect(within(dialog).getByText('計算しています')).toBeInTheDocument();
    expect(submit(dialog)).toBeDisabled();
    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();

    await waitFor(() => expect(estimateBodies()).toHaveLength(1));
    resolveEstimate(json({ data: estimateOf() }));
    await waitFor(() => expect(within(dialog).queryByText('計算しています')).not.toBeInTheDocument());
    expect(submit(dialog)).toBeEnabled();
  });

  test('DD-ADMIN-022: 選びを変えた後に届いた古い応答は捨てる', async () => {
    const pending: Array<(value: Response) => void> = [];
    const dialog = await open(returnDetail([blouse()]), {
      estimate: () => new Promise<Response>((resolve) => { pending.push(resolve); }),
    });
    receiveUnit(dialog, 0);
    await waitFor(() => expect(pending).toHaveLength(1));
    receiveUnit(dialog, 1);
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1](json({ data: estimateOf({ refundAmount: 34000, refundCap: 34000, nowRefund: 34000 }) }));
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(34000));
    pending[0](json({ data: estimateOf({ refundAmount: 17000 }) }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(34000);
  });

  test('DD-ADMIN-022: 見込みの誤りでは額を出さず、今の誤りの出し方で文を出して受け取りを止める', async () => {
    const dialog = await open(returnDetail([blouse()]), {
      estimate: async () => json({ error: '返金の額の計算を確かめられませんでした。画面を開き直してください。', code: 'UNIT_PRICING_INVALID' }, 409),
    });
    receiveUnit(dialog, 0);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返金の額の計算を確かめられませんでした。画面を開き直してください。');
    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('spinbutton', { name: '返金額' })).not.toBeInTheDocument();
    expect(submit(dialog)).toBeDisabled();
  });

  test('DD-ADMIN-022: 写しのある注文で状態が未定の行がある間は、画面の計算の額を出さず、確定を止める', async () => {
    const dialog = await open(returnDetail([blouse()]), { estimate: async () => json({ data: estimateOf() }) });
    receiveUnit(dialog, 0);
    // 2点目はチェックだけで状態が未定。窓口に聞ける選びではない
    fireEvent.click(within(rows(dialog)[1]).getByRole('checkbox', { name: '届いた' }));
    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('spinbutton', { name: '返金額' })).not.toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/￥12,000|￥24,000/);
    expect(submit(dialog)).toBeDisabled();
    expect(submit(dialog).textContent).not.toMatch(/￥/);
  });

  test('DD-ADMIN-022: 固定の費用は窓口の内訳を legacy と同じ見出しの行で出し、お支払い待ちも窓口の値', async () => {
    const dialog = await open(returnDetail([blouse()]), {
      estimate: async () => json({
        data: estimateOf({
          fixedFees: 1600, fixedFeeParts: { returnShipping: 800, exchangeFee: 500, exchangeShipping: 300 },
          refundAmount: 15400, feeDue: 3000, feePending: 0,
        }),
      }),
    });
    receiveUnit(dialog, 0);
    receiveUnit(dialog, 1);
    const group = await within(dialog).findByRole('group', { name: '返金の内訳' });
    expect(within(group).getByText('返送料').parentElement).toHaveTextContent('−￥800');
    expect(within(group).getByText('交換の手数料').parentElement).toHaveTextContent('−￥500');
    expect(within(group).getByText('交換の送料').parentElement).toHaveTextContent('−￥300');
    expect(within(group).queryByText('返送料・交換の手数料・送料')).not.toBeInTheDocument();
    expect(within(group).getByText('返金額').parentElement).toHaveTextContent('￥15,400');
    expect(within(dialog).getByText(/お支払い待ち ￥3,000/)).toBeInTheDocument();
  });

  test('FREQ-642-AC-20: 写しの無い注文（legacy）は今の画面の計算のまま（1点 12,000円）', async () => {
    const dialog = await open(returnDetail([blouse()]), {
      estimate: async () => json({ data: estimateOf({ legacy: true, nowRefund: 12000, refundAmount: 12000, refundCap: 12000 }) }),
    });
    receiveUnit(dialog, 0);
    await waitFor(() => expect(within(dialog).getByRole('spinbutton', { name: '返金額' })).toHaveValue(12000));
    await waitFor(() => expect(submit(dialog)).toBeEnabled());
  });
});
