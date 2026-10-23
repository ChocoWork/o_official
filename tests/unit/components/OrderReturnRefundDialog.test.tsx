import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { dialogButtons, footerCloseButton } from './dialog-test-helpers';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderReturnRefundDialog, { returnRefundNoticeOf, type RefundReturnResponse } from '@/components/OrderReturnRefundDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'ret-0001';
const LABEL = 'ORD-A1B2C3D4-R1';
const TITLE = `額を決めて返金する（${LABEL}）`;
const RETURNS_URL = `/api/admin/orders/${ORDER_ID}/returns`;
const REFUND_URL = `/api/admin/returns/${RETURN_ID}/refund`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_REFUND = '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
/** 回数の制限（429）で処理の前に断られた時の文（E-2 の返金の画面と同じ） */
const RATE_LIMITED = '操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。';
// 額を決めて返金した後の知らせ。画面は onDone に渡し、返品の欄が出す（E-2 の返金の知らせと同じ言葉。0円で終えた時は C-5 の言葉）
const NOTICE_ACCEPTED = '返金を受け付けました。お金が戻ると、注文の状態が変わります。';
const NOTICE_SUCCEEDED = '返金しました。';
const NOTICE_WAIVED = '返金しないで終えました。';
// 割引・手数料の行の符号は U+2212（ハイフンではなくマイナス記号）
const MINUS = '\u2212';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Progress = OrderReturnLineDetail['progress'];

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
    processed: 0, unprocessed: 0, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
    ...overrides,
  };
}

/** 受け取り済みで返金待ちの品。2点（24,000） */
const WAITING_BLOUSE: OrderReturnLineDetail = {
  id: 'line-blouse', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-blouse',
  itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, reason: 'size_too_small', reasonNote: null,
  resolution: 'refund', exchange: null,
  progress: progress({ restocked: 2, processed: 2, refundWaiting: 2 }),
  refundAmountsByCount: [], refundWaitingAmount: 24000, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
};

/** 受け取り済みで返金待ちの品。1点（9,000）。サイズが無い */
const WAITING_BELT: OrderReturnLineDetail = {
  ...WAITING_BLOUSE,
  id: 'line-belt', orderItemId: 'item-belt', itemName: 'レザーベルト', color: '茶', size: null, quantity: 1,
  progress: progress({ notRestocked: 1, processed: 1, refundWaiting: 1 }),
  refundWaitingAmount: 9000,
};

/** もう返金した品（返金待ちではない）。一覧に出ない */
const PAID_PANTS: OrderReturnLineDetail = {
  ...WAITING_BLOUSE,
  id: 'line-pants', orderItemId: 'item-pants', itemName: 'ウールパンツ', color: null, size: '2', quantity: 1,
  progress: progress({ restocked: 1, processed: 1, refundCovered: 1 }),
  refundWaitingAmount: 0,
};

function returnDetail(overrides: Partial<OrderReturnDetail> = {}): OrderReturnDetail {
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
    lines: [WAITING_BLOUSE, WAITING_BELT, PAID_PANTS], refunds: [], receipts: [], exchangeItems: [],
    ...overrides,
  };
}

/** 相談の受け取りで付いた手数料（fee_pending_deduction）を持つ返品 */
function detailWithPendingFee(pending: number): OrderReturnDetail {
  const detail = returnDetail();
  return { ...detail, fees: { ...detail.fees, feePendingDeduction: pending } };
}

function accepted(overrides: Partial<RefundReturnResponse> = {}): RefundReturnResponse {
  return { refundId: 'refund-1', status: 'pending', amount: 33000, replayed: false, ...overrides };
}

/** 返金額が0円で、返金を作らずに終えた答え（P20） */
function waived(overrides: Partial<RefundReturnResponse> = {}): RefundReturnResponse {
  return { refundId: null, status: 'waived', amount: 0, replayed: false, ...overrides };
}

type OpenOptions = { refundableAmount?: number; refundableShipping?: number; returns?: OrderReturnDetail[] };

/** 注文の返品の窓口（GET）の答え。操作の画面はこれを読んで、returnId の返品を探す（C-3） */
function returnsAnswer(detail: OrderReturnDetail, options: OpenOptions = {}) {
  return json({
    data: {
      returns: options.returns ?? [detail],
      canRefund: true,
      returnableUnits: 0,
      refundableAmount: options.refundableAmount ?? 54800,
      refundableShipping: options.refundableShipping ?? 800,
    },
  });
}

/** 画面を開き、返品の中身を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(detail: OrderReturnDetail = returnDetail(), options: OpenOptions = {}) {
  mockClientFetch.mockResolvedValueOnce(returnsAnswer(detail, options));
  const props = { onClose: jest.fn(), onDone: jest.fn(), onUncertain: jest.fn() };
  const utils = render(<OrderReturnRefundDialog orderId={ORDER_ID} returnId={RETURN_ID} {...props} />);
  await waitFor(() => expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument());
  const dialog = screen.getByRole('dialog', { name: TITLE });
  return { ...utils, ...props, props, dialog };
}

/** n 番目（0 始まり）の送信の本文。呼び出しの最初は返品の読み込み（GET）なので、1つ後ろを読む */
function requestBodyOf(sendIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[sendIndex + 1][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** これまでに窓口を呼んだ URL（最初は返品の読み込み） */
const calledUrls = () => mockClientFetch.mock.calls.map(([url]) => url);

/** 確定のボタン（フォームの送信ボタン）。答えが分からない時は無い */
const primaryButton = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
const amountInput = (dialog: HTMLElement) => within(dialog).getByLabelText('返金額（返せる額: ￥54,800）') as HTMLInputElement;
const shippingInput = (dialog: HTMLElement) => within(dialog).getByLabelText('送料（返せる送料: ￥800）') as HTMLInputElement;
const memoInput = (dialog: HTMLElement) => within(dialog).getByRole('textbox', { name: 'メモ（お客様には見えません）' });

/** 内訳の1行の文字（「商品￥33,000」のように、名前と金額を続けた物） */
function breakdownRow(dialog: HTMLElement, term: string): string {
  const group = within(dialog).getByRole('group', { name: '返金の内訳' });
  return within(group).getByText(term).parentElement?.textContent ?? '';
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderReturnRefundDialog の読み込み', () => {
  it('開くと注文の返品の窓口を読み、読み終えるまでは「読み込み中です...」と「閉じる」だけを出す', async () => {
    let resolveGet: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveGet = resolve; }));
    render(<OrderReturnRefundDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);

    const loading = screen.getByRole('dialog', { name: '額を決めて返金する' });
    expect(within(loading).getByText('読み込み中です...')).toBeInTheDocument();
    expect(dialogButtons(loading).map((button) => button.textContent)).toEqual(['閉じる']);
    expect(mockClientFetch).toHaveBeenCalledWith(RETURNS_URL, { cache: 'no-store' });

    resolveGet(returnsAnswer(returnDetail()));
    expect(await screen.findByRole('dialog', { name: TITLE })).toBeInTheDocument();
    expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument();
  });

  it.each([
    [404, { error: '返品が見つかりません。', code: 'RETURN_NOT_FOUND' }, '返品が見つかりません。'],
    [500, { error: 'x', code: 'failed' }, '返品の情報を読み込めませんでした。'],
  ])('返品を読めなかった時（%i）は理由と「閉じる」だけを出す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    const onClose = jest.fn();
    render(<OrderReturnRefundDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={onClose} onDone={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '額を決めて返金する' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる']);
    expect(within(dialog).queryByLabelText(/^返金額/)).not.toBeInTheDocument();

    fireEvent.click(footerCloseButton(dialog));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('窓口の答えの中に開こうとした返品が無い時は、見つからない旨と「閉じる」だけを出す', async () => {
    mockClientFetch.mockResolvedValueOnce(returnsAnswer(returnDetail({ id: 'ret-other' })));
    render(<OrderReturnRefundDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '額を決めて返金する' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返品が見つかりません。');
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる']);
  });
});

describe('OrderReturnRefundDialog の画面の作り', () => {
  it('返金待ちの品・内訳・額と送料の入力・メモ・メールの選び・注意を出す。Stripe の理由は選ばせない', async () => {
    const { dialog } = await openDialog();

    const list = within(dialog).getByRole('list', { name: '返金する品' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'シルクブラウス（白 / M） × 2',
      'レザーベルト（茶） × 1',
    ]);
    expect(breakdownRow(dialog, '商品')).toBe('商品￥33,000');
    expect(breakdownRow(dialog, '送料')).toBe('送料￥0');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥33,000');
    expect(amountInput(dialog)).toHaveValue(33000);
    expect(shippingInput(dialog)).toHaveValue(0);
    expect(memoInput(dialog)).toHaveValue('');
    expect(memoInput(dialog)).toHaveAttribute('maxlength', '500');
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' })).toBeChecked();
    expect(within(dialog).getByText('返金は取り消せません。')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '￥33,000 を返金する' })).toBeEnabled();
  });

  it('完了した返品でも、返金待ちの品があれば開ける（返品の返金が失敗した後の返し直し）', async () => {
    const { dialog } = await openDialog(returnDetail({ status: 'closed', closedAt: '2026-10-12T05:00:00.000Z', lines: [WAITING_BLOUSE] }));

    expect(breakdownRow(dialog, '商品')).toBe('商品￥24,000');
    expect(within(dialog).getByRole('button', { name: '￥24,000 を返金する' })).toBeEnabled();
  });

  it('返金待ちの品が無い返品は、返金のボタンを押せない', async () => {
    const { dialog } = await openDialog(returnDetail({ lines: [PAID_PANTS] }));

    expect(within(dialog).getByRole('button', { name: '￥0 を返金する' })).toBeDisabled();
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });
});

describe('OrderReturnRefundDialog の金額', () => {
  it('返金額は手で直せて、上限は返せる額。送料を変えると見込みの額に戻る', async () => {
    const { dialog } = await openDialog(returnDetail(), { refundableAmount: 40000 });

    fireEvent.change(within(dialog).getByLabelText('返金額（返せる額: ￥40,000）'), { target: { value: '30000' } });
    expect(within(dialog).getByRole('button', { name: '￥30,000 を返金する' })).toBeEnabled();
    // 内訳は、品と送料から出した見込みのまま
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥33,000');

    fireEvent.change(within(dialog).getByLabelText('返金額（返せる額: ￥40,000）'), { target: { value: '99999999' } });
    expect(within(dialog).getByLabelText('返金額（返せる額: ￥40,000）')).toHaveValue(40000);

    fireEvent.change(within(dialog).getByLabelText('送料（返せる送料: ￥800）'), { target: { value: '300' } });
    expect(within(dialog).getByLabelText('返金額（返せる額: ￥40,000）')).toHaveValue(33300);
  });

  it('返せる額が見込みより小さい時は、返せる額までに切る', async () => {
    const { dialog } = await openDialog(returnDetail(), { refundableAmount: 20000 });

    expect(within(dialog).getByLabelText('返金額（返せる額: ￥20,000）')).toHaveValue(20000);
    expect(within(dialog).getByRole('button', { name: '￥20,000 を返金する' })).toBeEnabled();
  });

  it('送料は 0 から返せる送料までに収まり、内訳と返金額に足される', async () => {
    const { dialog } = await openDialog();

    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });
    expect(shippingInput(dialog)).toHaveValue(300);
    expect(breakdownRow(dialog, '送料')).toBe('送料￥300');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥33,300');
    expect(amountInput(dialog)).toHaveValue(33300);

    fireEvent.change(shippingInput(dialog), { target: { value: '5000' } });
    expect(shippingInput(dialog)).toHaveValue(800);
    fireEvent.change(shippingInput(dialog), { target: { value: '-1' } });
    expect(shippingInput(dialog)).toHaveValue(0);
  });

  it('返せる送料が無い注文では、送料の入力を止める', async () => {
    const { dialog } = await openDialog(returnDetail(), { refundableShipping: 0 });

    expect(within(dialog).getByLabelText('送料（返せる送料: ￥0）')).toBeDisabled();
  });

  it('返金額が送料より小さい間は押せない（DB は送料 ≤ 額を入力の誤りにする）', async () => {
    const { dialog } = await openDialog();
    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });

    fireEvent.change(amountInput(dialog), { target: { value: '200' } });
    expect(primaryButton(dialog)).toBeDisabled();

    fireEvent.change(amountInput(dialog), { target: { value: '300' } });
    expect(primaryButton(dialog)).toBeEnabled();
  });

  it('相談の受け取りで付いた手数料は、商品の額から引いて内訳に出す', async () => {
    const { dialog } = await openDialog(detailWithPendingFee(3200));

    expect(breakdownRow(dialog, '商品')).toBe('商品￥33,000');
    expect(breakdownRow(dialog, '受け取りで付いた手数料')).toBe(`受け取りで付いた手数料${MINUS}￥3,200`);
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥29,800');
    expect(amountInput(dialog)).toHaveValue(29800);
    expect(within(dialog).getByRole('button', { name: '￥29,800 を返金する' })).toBeEnabled();
  });

  it('手数料が商品の額より大きい時は、引くのを商品の額までにする（返金額は0円。下の「返金しないで終える」を参照）', async () => {
    const { dialog } = await openDialog(detailWithPendingFee(40000));

    expect(breakdownRow(dialog, '受け取りで付いた手数料')).toBe(`受け取りで付いた手数料${MINUS}￥33,000`);
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥0');
    expect(amountInput(dialog)).toHaveValue(0);
  });

  it('手数料が無い返品には、手数料の行を出さない', async () => {
    const { dialog } = await openDialog();

    expect(within(within(dialog).getByRole('group', { name: '返金の内訳' })).queryByText('受け取りで付いた手数料')).not.toBeInTheDocument();
  });
});

describe('OrderReturnRefundDialog の返金しないで終える（返金額が0円。P20）', () => {
  it('返金額を0に直すと、ボタンは「返金しないで終える」になり、注意の文が替わり、メールの選びが消える', async () => {
    const { dialog } = await openDialog();
    expect(within(dialog).getByText('返金は取り消せません。')).toBeInTheDocument();

    fireEvent.change(amountInput(dialog), { target: { value: '0' } });

    expect(within(dialog).getByRole('button', { name: '返金しないで終える' })).toBeEnabled();
    expect(within(dialog).getByText('返金しないで終えます。お客様に返金のメールは送りません。')).toBeInTheDocument();
    expect(within(dialog).queryByText('返金は取り消せません。')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: 'お客様に返金のメールを送る' })).not.toBeInTheDocument();
    // 内訳は、品と送料から出した見込みのまま
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥33,000');
  });

  it('0円から額を戻すと、返金のボタン・注意の文・メールの選び（外していた状態のまま）に戻る', async () => {
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' }));
    fireEvent.change(amountInput(dialog), { target: { value: '0' } });

    fireEvent.change(amountInput(dialog), { target: { value: '5000' } });

    expect(within(dialog).getByRole('button', { name: '￥5,000 を返金する' })).toBeEnabled();
    expect(within(dialog).getByText('返金は取り消せません。')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' })).not.toBeChecked();
  });

  it('0円に直しても、送料が残っている間は押せない（送料は額の中から返すため）', async () => {
    const { dialog } = await openDialog();
    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });

    fireEvent.change(amountInput(dialog), { target: { value: '0' } });

    expect(within(dialog).getByRole('button', { name: '返金しないで終える' })).toBeDisabled();
  });

  it('0円で終える: 額の 0 とメールを送らない選びを送り、知らせ「返金しないで終えました。」を親へ渡す', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: waived() }));
    fireEvent.change(memoInput(dialog), { target: { value: '  お客様と相談して返金なしにした  ' } });
    fireEvent.change(amountInput(dialog), { target: { value: '0' } });

    fireEvent.click(within(dialog).getByRole('button', { name: '返金しないで終える' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_WAIVED));
    expect(requestBodyOf(0)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      amount: 0,
      shippingAmount: 0,
      note: 'お客様と相談して返金なしにした',
      notifyCustomer: false,
    });
  });

  it('相談の受け取りで付いた手数料が商品の額以上の時は、最初から「返金しないで終える」。額は送らない（DB が同じ式で0円にする）', async () => {
    const { dialog, onDone } = await openDialog(detailWithPendingFee(40000));
    mockClientFetch.mockResolvedValueOnce(json({ data: waived() }));

    expect(within(dialog).getByRole('button', { name: '返金しないで終える' })).toBeEnabled();
    expect(amountInput(dialog)).toHaveValue(0);
    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_WAIVED));
    expect(requestBodyOf(0)).toMatchObject({ amount: null, notifyCustomer: false });
  });

  it('返金しないで終える操作も、答えが分からない時は同じ二重防止の番号・同じ中身で確かめ直す', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ data: waived({ replayed: true }) }));
    fireEvent.change(amountInput(dialog), { target: { value: '0' } });
    fireEvent.click(primaryButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_REFUND);
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_WAIVED));
    expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
  });

  it('返金待ちの品が無い返品は、額が0円でも「返金しないで終える」にならず、押せない', async () => {
    const { dialog } = await openDialog(returnDetail({ lines: [PAID_PANTS] }));

    expect(within(dialog).getByRole('button', { name: '￥0 を返金する' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: '返金しないで終える' })).not.toBeInTheDocument();
  });
});

describe('OrderReturnRefundDialog の返金', () => {
  it('見込みどおりの額で返す: 額は送らず（DB が計算する）、二重防止の番号・送料・メモ・メールの選びを送り、知らせを親へ渡す', async () => {
    const { dialog, onDone, onClose } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: accepted() }));

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED));
    expect(mockClientFetch).toHaveBeenCalledWith(REFUND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      amount: null,
      shippingAmount: 0,
      note: null,
      notifyCustomer: true,
    });
    // 閉じるのは親。画面が自分で閉じることはしない
    expect(onClose).not.toHaveBeenCalled();
  });

  it('額と送料を直し、メモを書き、メールを送らない選びにすると、そのまま送る。返金が済んでいる答えの知らせは「返金しました。」', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: accepted({ status: 'succeeded', amount: 30000 }) }));
    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });
    fireEvent.change(amountInput(dialog), { target: { value: '30000' } });
    fireEvent.change(memoInput(dialog), { target: { value: '  電話で相談して決めた  ' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' }));

    fireEvent.click(within(dialog).getByRole('button', { name: '￥30,000 を返金する' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_SUCCEEDED));
    expect(requestBodyOf(0)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      amount: 30000,
      shippingAmount: 300,
      note: '電話で相談して決めた',
      notifyCustomer: false,
    });
  });

  it('返せる額で切った額は、見込みと違うので額を送る', async () => {
    const { dialog, onDone } = await openDialog(returnDetail(), { refundableAmount: 20000 });
    mockClientFetch.mockResolvedValueOnce(json({ data: accepted({ amount: 20000 }) }));

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ amount: 20000 });
  });

  it('「戻る」では送らずに閉じる（送信を試みていないので、一覧の読み直しは頼まない）', async () => {
    const { dialog, onClose, onDone, onUncertain } = await openDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(calledUrls()).toEqual([RETURNS_URL]);
  });

  it('送っている間は押せず、二重に送らない。閉じることもできない（戻るも Esc も背景も効かない）', async () => {
    const { dialog, onClose, onDone } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    fireEvent.click(primaryButton(dialog));

    expect(primaryButton(dialog)).toBeDisabled();
    expect(amountInput(dialog)).toBeDisabled();
    fireEvent.click(primaryButton(dialog));
    expect(calledUrls()).toEqual([RETURNS_URL, REFUND_URL]);
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(dialog.closest('[data-ui-dialog]') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();

    resolvePost(json({ data: accepted() }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Enter キーでは返金を送らない（額や送料の欄でも、チェックでも）。メモの欄の Enter は改行のまま', async () => {
    const { dialog } = await openDialog();

    // preventDefault されている（フォームの送信にならない）
    expect(fireEvent.keyDown(amountInput(dialog), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(shippingInput(dialog), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' }), { key: 'Enter' })).toBe(false);
    // メモの欄は改行に使う。ボタンの Enter は押す動き
    expect(fireEvent.keyDown(memoInput(dialog), { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(primaryButton(dialog), { key: 'Enter' })).toBe(true);
    expect(calledUrls()).toEqual([RETURNS_URL]);
  });
});

describe('OrderReturnRefundDialog の窓口の断り', () => {
  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい二重防止の番号にする', async () => {
    const { dialog, onDone } = await openDialog();
    const message = '確かめ中の返金があります。先に確かめてください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'AWAITING_REFUND_EXISTS' }, 409))
      .mockResolvedValueOnce(json({ data: accepted() }));
    fireEvent.change(memoInput(dialog), { target: { value: '電話で相談' } });
    fireEvent.click(primaryButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onDone).not.toHaveBeenCalled();
    expect(memoInput(dialog)).toHaveValue('電話で相談');
    expect(primaryButton(dialog)).toBeEnabled();

    fireEvent.click(primaryButton(dialog));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(1).requestKey).not.toBe(requestBodyOf(0).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Stripe が受け付けなかった（422）時も、窓口の文をそのまま出し、新しい二重防止の番号で送り直せる', async () => {
    const { dialog, onDone } = await openDialog();
    const message = 'Stripe が返金を受け付けませんでした（カードが使えません）。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'stripe_rejected', refundId: 'refund-1' }, 422))
      .mockResolvedValueOnce(json({ data: accepted() }));
    fireEvent.click(primaryButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(primaryButton(dialog)).toBeEnabled();
    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).requestKey).not.toBe(requestBodyOf(0).requestKey);
  });

  it('最初の送信が403で処理前に断られても、次の送信は同じ二重防止の番号を使う', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ data: accepted() }));
    fireEvent.click(primaryButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この操作の権限がありません。');
    expect(primaryButton(dialog)).toBeEnabled();
    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).requestKey).toBe(requestBodyOf(0).requestKey);
  });

  it('回数の制限（英語の短い文）は、回数の制限の固定の文を出す', async () => {
    const { dialog } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));

    fireEvent.click(primaryButton(dialog));

    expect(await within(dialog).findByText(RATE_LIMITED)).toBeInTheDocument();
    expect(within(dialog).queryByText('Too many requests')).not.toBeInTheDocument();
  });
});

const UNKNOWN_ANSWERS: Array<[string, () => Promise<unknown>]> = [
  ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '入力を確かめてください。' }, 500))],
  [
    'Stripe の返事を確かめられなかった（502）',
    () => Promise.resolve(json({ error: UNKNOWN_REFUND, code: 'unknown_outcome', refundId: 'refund-1' }, 502)),
  ],
  ['成功なのに答えの形が読めない（200）', () => Promise.resolve(json({ data: { refundId: 'refund-1' } }))],
];

describe('OrderReturnRefundDialog の答えが分からない時', () => {
  it.each(UNKNOWN_ANSWERS)(
    '%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ二重防止の番号・同じ中身で確かめ直す',
    async (_label, firstAnswer) => {
      const { dialog, onDone, onClose, onUncertain } = await openDialog();
      mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json({ data: accepted({ replayed: true }) }));
      fireEvent.change(memoInput(dialog), { target: { value: '電話で相談' } });
      fireEvent.click(primaryButton(dialog));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_REFUND);
      // 入力は変えられない
      expect(amountInput(dialog)).toBeDisabled();
      expect(shippingInput(dialog)).toBeDisabled();
      expect(memoInput(dialog)).toBeDisabled();
      expect(within(dialog).getByRole('checkbox', { name: 'お客様に返金のメールを送る' })).toBeDisabled();
      // 操作は「もう一度確かめる」と「閉じる」だけ
      expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);

      fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

      await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED));
      // 同じ二重防止の番号・同じ中身で送り直す（Stripe が返金を作っていても、DB は前の記録を返し、返金は1件のまま）
      expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
      expect(calledUrls()).toEqual([RETURNS_URL, REFUND_URL, REFUND_URL]);
      expect(onClose).not.toHaveBeenCalled();
      expect(onUncertain).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, '認証が必要です。再ログインしてください。'],
    [403, 'この操作の権限がありません。'],
    [429, RATE_LIMITED],
  ])('確かめ直しが%iで処理前に断られても結果不明のまま、次も同じ番号・同じ中身で送る', async (status, message) => {
    const { dialog, onDone, onUncertain } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'Blocked' }, status))
      .mockResolvedValueOnce(json({ data: accepted({ replayed: true }) }));
    fireEvent.click(primaryButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    // 断りの文の後ろに、答えが分からない時の文を続けて出す（取り消せない操作の結果が分からないことを、断りの文で隠さない）
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(`${message}${UNKNOWN_REFUND}`));
    expect(amountInput(dialog)).toBeDisabled();
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);
    expect(calledUrls()).toHaveLength(3);

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
    expect(requestBodyOf(2)).toEqual(requestBodyOf(0));
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it.each([400, 404, 409, 422])(
    '確かめ直しが%iで断られたら、断りの文を出し、入力を戻して新しい番号で送れる。閉じる時は一覧の読み直しを頼む',
    async (status) => {
      const { dialog, onDone, onClose, onUncertain } = await openDialog();
      const message = '返金の状態が変わりました。';
      mockClientFetch
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(json({ error: message, code: 'x' }, status))
        .mockResolvedValueOnce(json({ data: accepted() }));
      fireEvent.click(primaryButton(dialog));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(message));
      expect(within(dialog).getByRole('alert')).not.toHaveTextContent(UNKNOWN_REFUND);
      expect(amountInput(dialog)).toBeEnabled();
      expect(primaryButton(dialog)).toBeEnabled();

      // 状態は変わっているかもしれないので、閉じる時に親へ一覧の読み直しを頼む
      fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
      expect(onUncertain).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);

      fireEvent.click(primaryButton(dialog));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(0).requestKey);
    },
  );

  it('確かめ直しても分からない時は、そのまま止まる。「閉じる」で閉じる時に、一覧の読み直しを親に頼む', async () => {
    const { dialog, onDone, onClose, onUncertain } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(primaryButton(dialog));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(calledUrls()).toHaveLength(3));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled());

    expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN_REFUND);
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(footerCloseButton(dialog));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape で閉じる。送信を試みた後だけ、一覧の読み直しを親に頼む', async () => {
    const { dialog, onClose, onUncertain } = await openDialog();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();

    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(primaryButton(dialog));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onUncertain).toHaveBeenCalledTimes(1);
  });
});

describe('returnRefundNoticeOf（額を決めて返金した後の知らせ）', () => {
  it('Stripe が受け付けた時は、お金が戻ると注文の状態が変わる旨を出す', () => {
    expect(returnRefundNoticeOf(accepted({ status: 'pending' }))).toBe(NOTICE_ACCEPTED);
  });

  it('返金が済んだ時は「返金しました。」', () => {
    expect(returnRefundNoticeOf(accepted({ status: 'succeeded' }))).toBe(NOTICE_SUCCEEDED);
  });

  it('返金しないで終えた時（waived）は「返金しないで終えました。」', () => {
    expect(returnRefundNoticeOf(waived())).toBe(NOTICE_WAIVED);
  });
});
