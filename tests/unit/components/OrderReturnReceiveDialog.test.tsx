import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { dialogButtons, footerCloseButton } from './dialog-test-helpers';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderReturnReceiveDialog, {
  receiveNoticeOf,
  type ReceiveDialogResult,
  type ReceiveReturnResponse,
} from '@/components/OrderReturnReceiveDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'ret-0001';
const LABEL = 'ORD-A1B2C3D4-R1';
const TITLE = `受け取る（${LABEL}）`;
const RETURNS_URL = `/api/admin/orders/${ORDER_ID}/returns`;
const RECEIVE_URL = `/api/admin/returns/${RETURN_ID}/receive`;
const CLOSE_MISSING_URL = `/api/admin/returns/${RETURN_ID}/close-missing`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_RECEIVE = '受け取りの結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
/** 回数の制限（429）で処理の前に断られた時の文（E-2 の返金の画面と同じ） */
const RATE_LIMITED = '操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。';
const CONSULT_HINT =
  '着た跡や付属品の不足などで、お客様と相談して額を決める時に選びます。受け取りだけを記録し、返品は「返金待ち」になります。';
const PARTIAL_CONFIRM = (n: number) => `まだ届いていない商品が ${n} 点あります。届いた分だけ記録し、残りは受付中のまま残ります。`;
// 受け取りの後の知らせ（C-5）。画面は onDone に渡し、返品の欄が出す
const NOTICE_RECORDED = '受け取りを記録しました。';
const NOTICE_ACCEPTED = '受け取りを記録し、返金を受け付けました。';
const NOTICE_REFUNDED = '受け取りを記録し、返金しました。';
const NOTICE_CLOSED_MISSING = '「届かない」として返品を終えました。';
const RECEIPT_RECORDED_NOTE = '受け取りは記録しました。返金は、返品の画面の「額を決めて返金する」からやり直してください。';
// 割引・手数料の行の符号は U+2212（ハイフンではなくマイナス記号）
const MINUS = '\u2212';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Progress = OrderReturnLineDetail['progress'];
type Exchange = NonNullable<OrderReturnLineDetail['exchange']>;

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    restocked: 0, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
    processed: 0, unprocessed: 2, exchanged: 0, refundCovered: 0, refundWaived: 0, refundWaiting: 0,
    ...overrides,
  };
}

/** 返金の行。2点とも未処理。k 点を返金した時の商品の額は 12,000 × k。額の列は、同じ注文の商品を指す行を2つ並べる試験では、2行とも同じ列にする（C-2） */
const BLOUSE: OrderReturnLineDetail = {
  id: 'line-blouse', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-blouse',
  itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, reason: 'size_too_small', reasonNote: null,
  resolution: 'refund', exchange: null, progress: progress(),
  refundAmountsByCount: [12000, 24000], refundWaitingAmount: 0, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
};

/** 交換の行。黒 / L のコートを、同じ商品の黒 / XL に替える。1点。額の列は空で、返金に変える試験だけが渡す。同じ交換先の2行を並べる試験（どちらもこのコートの行）は、2行とも空の同じ列のまま */
const COAT: OrderReturnLineDetail = {
  id: 'line-coat', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-coat',
  itemName: 'ウールコート', color: '黒', size: 'L', quantity: 1, reason: 'color', reasonNote: null,
  resolution: 'exchange',
  exchange: { variantId: 501, color: '黒', size: 'XL', method: 'stock', stockQuantity: 3, madeToOrderLeadDays: 14, outOfStockExchange: 'make' },
  progress: progress({ unprocessed: 1 }),
  refundAmountsByCount: [], refundWaitingAmount: 0, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
};

function exchangeLine(exchange: Partial<Exchange> = {}, overrides: Partial<OrderReturnLineDetail> = {}): OrderReturnLineDetail {
  return { ...COAT, ...overrides, exchange: { ...(COAT.exchange as Exchange), ...exchange } };
}

function returnDetail(overrides: Partial<OrderReturnDetail> = {}): OrderReturnDetail {
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
    lines: [BLOUSE], refunds: [], receipts: [], exchangeItems: [],
    ...overrides,
  };
}

function receiveData(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: 'receipt-1', returnStatus: 'open', refundId: null, refundAmount: null, refundStatus: null,
    feeDueAmount: 0, replayed: false,
    ...overrides,
  };
}

type OpenOptions = {
  canRefund?: boolean;
  refundableAmount?: number;
  refundableShipping?: number;
  inspectionEnabled?: boolean;
  /** 窓口が返す返品の一覧。省くと detail だけ */
  returns?: OrderReturnDetail[];
};

/** 注文の返品の窓口（GET）の答え。操作の画面はこれを読んで、returnId の返品を探す（C-3） */
function returnsAnswer(detail: OrderReturnDetail, options: OpenOptions = {}) {
  return json({
    data: {
      returns: options.returns ?? [detail],
      canRefund: options.canRefund ?? true,
      returnableUnits: 0,
      refundableAmount: options.refundableAmount ?? 54800,
      refundableShipping: options.refundableShipping ?? 800,
      ...(options.inspectionEnabled === undefined ? {} : { inspectionEnabled: options.inspectionEnabled }),
    },
  });
}

/** 画面を開き、返品の中身を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(detail: OrderReturnDetail = returnDetail(), options: OpenOptions = {}) {
  mockClientFetch.mockResolvedValueOnce(returnsAnswer(detail, options));
  const props = { onClose: jest.fn(), onDone: jest.fn(), onUncertain: jest.fn() };
  const utils = render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} {...props} />);
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

const unitRows = (dialog: HTMLElement) => within(within(dialog).getByRole('list', { name: '受け取る品' })).getAllByRole('listitem');
/** 確定のボタン（フォームの送信ボタン）。言葉は中身で変わるので、型で探す。答えが分からない時は無い */
const primaryButton = (dialog: HTMLElement) => dialog.querySelector('button[type="submit"]') as HTMLButtonElement;
const amountInput = (dialog: HTMLElement) => within(dialog).getByLabelText('返金額（返せる額: ￥54,800）') as HTMLInputElement;
const shippingInput = (dialog: HTMLElement) => within(dialog).getByLabelText('送料（返せる送料: ￥800）') as HTMLInputElement;

/** 行をチェックして、状態を選ぶ */
function receiveUnit(dialog: HTMLElement, index: number, disposition: string) {
  const row = unitRows(dialog)[index];
  fireEvent.click(within(row).getByRole('checkbox', { name: '届いた' }));
  fireEvent.change(within(row).getByRole('combobox', { name: '品の状態' }), { target: { value: disposition } });
}

function receiveAll(dialog: HTMLElement, disposition: string) {
  unitRows(dialog).forEach((_, index) => receiveUnit(dialog, index, disposition));
}

/** 内訳の1行の文字（「商品￥24,000」のように、名前と金額を続けた物） */
function breakdownRow(dialog: HTMLElement, term: string): string {
  const group = within(dialog).getByRole('group', { name: '返金の内訳' });
  return within(group).getByText(term).parentElement?.textContent ?? '';
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderReturnReceiveDialog の読み込み', () => {
  it('開くと注文の返品の窓口を読み、読み終えるまでは「読み込み中です...」と「閉じる」だけを出す', async () => {
    let resolveGet: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveGet = resolve; }));
    render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);

    const loading = screen.getByRole('dialog', { name: '受け取る' });
    expect(within(loading).getByText('読み込み中です...')).toBeInTheDocument();
    expect(dialogButtons(loading).map((button) => button.textContent)).toEqual(['閉じる']);
    expect(mockClientFetch).toHaveBeenCalledWith(RETURNS_URL, { cache: 'no-store' });

    resolveGet(returnsAnswer(returnDetail()));
    expect(await screen.findByRole('dialog', { name: TITLE })).toBeInTheDocument();
    expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument();
  });

  it('読み込み中に「閉じる」を押すと閉じる（何も送っていないので、一覧の読み直しは頼まない）', () => {
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const onClose = jest.fn();
    const onUncertain = jest.fn();
    render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={onClose} onDone={jest.fn()} onUncertain={onUncertain} />);

    fireEvent.click(footerCloseButton(document.body));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it.each([
    [404, { error: '返品が見つかりません。', code: 'RETURN_NOT_FOUND' }, '返品が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '返品の情報を読み込めませんでした。'],
  ])('返品を読めなかった時（%i）は理由と「閉じる」だけを出す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    const onClose = jest.fn();
    render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={onClose} onDone={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '受け取る' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる']);
    expect(within(dialog).queryByRole('list', { name: '受け取る品' })).not.toBeInTheDocument();

    fireEvent.click(footerCloseButton(dialog));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('窓口の答えの中に開こうとした返品が無い時（取り消された・別の注文の番号など）は、見つからない旨と「閉じる」だけを出す', async () => {
    const other = returnDetail({ id: 'ret-other', number: 2, label: 'ORD-A1B2C3D4-R2' });
    mockClientFetch.mockResolvedValueOnce(returnsAnswer(other));
    render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '受け取る' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返品が見つかりません。');
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる']);
  });

  it('1つの注文に返品が2つ以上ある時は、returnId の返品を開く', async () => {
    const other = returnDetail({ id: 'ret-other', number: 1, label: 'ORD-A1B2C3D4-R1', lines: [COAT] });
    const target = returnDetail({ id: 'ret-target', number: 2, label: 'ORD-A1B2C3D4-R2' });
    mockClientFetch.mockResolvedValueOnce(returnsAnswer(target, { returns: [other, target] }));
    render(<OrderReturnReceiveDialog orderId={ORDER_ID} returnId="ret-target" onClose={jest.fn()} onDone={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '受け取る（ORD-A1B2C3D4-R2）' });
    expect(within(dialog).getAllByRole('group', { name: 'シルクブラウス（白 / M）' })).toHaveLength(2);
    expect(within(dialog).queryByText('ウールコート（黒 / L）')).not.toBeInTheDocument();
  });
});

describe('OrderReturnReceiveDialog の画面の作り', () => {
  it('まだ処理していない品を1点ずつ1行に並べる。最初は何も選ばず、受け取りのボタンは押せない', async () => {
    const { dialog } = await openDialog();

    expect(within(dialog).getByText('2点中0点を確認')).toBeInTheDocument();
    const rows = unitRows(dialog);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).getByText('シルクブラウス（白 / M）')).toBeInTheDocument();
      expect(within(row).getByText('返金')).toBeInTheDocument();
      expect(within(row).getByText('理由: サイズが小さい')).toBeInTheDocument();
      expect(within(row).getByRole('checkbox', { name: '届いた' })).not.toBeChecked();
      expect(within(row).getByRole('combobox', { name: '品の状態' })).toHaveValue('');
      expect(within(row).getByRole('combobox', { name: '品の状態' })).toBeDisabled();
    }
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に知らせる' })).toBeChecked();
    expect(within(dialog).getByRole('button', { name: '残りは届かないものとして返品を終える' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeEnabled();
    expect(primaryButton(dialog)).toBeDisabled();
    // 返金の品がまだ無いので、返金の欄も内訳も出ない
    expect(within(dialog).queryByRole('group', { name: '返金' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();
  });

  it('チェックすると状態を選べて、進み具合が増える。状態は「選択してください」から始まり、選ぶまで押せない', async () => {
    const { dialog } = await openDialog();
    const row = unitRows(dialog)[0];

    fireEvent.click(within(row).getByRole('checkbox', { name: '届いた' }));

    expect(within(dialog).getByText('2点中1点を確認')).toBeInTheDocument();
    const select = within(row).getByRole('combobox', { name: '品の状態' });
    expect(select).toBeEnabled();
    expect(select).toHaveValue('');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '選択してください',
      '在庫に戻す',
      '戻さない',
      '条件に合わないのでお返しする',
    ]);
    expect(primaryButton(dialog)).toBeDisabled();

    fireEvent.change(select, { target: { value: 'restocked' } });
    expect(primaryButton(dialog)).toBeEnabled();
  });

  it('チェックを外すと、選んだ状態も戻る', async () => {
    const { dialog } = await openDialog();
    const row = unitRows(dialog)[0];
    receiveUnit(dialog, 0, 'not_restocked');
    expect(within(row).getByRole('combobox', { name: '品の状態' })).toHaveValue('not_restocked');

    fireEvent.click(within(row).getByRole('checkbox', { name: '届いた' }));

    expect(within(row).getByRole('combobox', { name: '品の状態' })).toHaveValue('');
    expect(within(row).getByRole('combobox', { name: '品の状態' })).toBeDisabled();
    expect(within(dialog).getByText('2点中0点を確認')).toBeInTheDocument();
  });

  it('要検品がオンの時だけ「検品待ち」を選べる（窓口の答えの inspectionEnabled）', async () => {
    const { dialog } = await openDialog(returnDetail(), { inspectionEnabled: true });
    fireEvent.click(within(unitRows(dialog)[0]).getByRole('checkbox', { name: '届いた' }));

    const select = within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' });
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '選択してください',
      '在庫に戻す',
      '戻さない',
      '条件に合わないのでお返しする',
      '検品待ち',
    ]);
  });

  it('前の受け取りで処理した行は固定の行として出し、残りの行だけ選べる。進み具合は前の分を含む', async () => {
    const partlyReceived: OrderReturnLineDetail = {
      ...BLOUSE,
      progress: progress({ restocked: 1, processed: 1, unprocessed: 1 }),
      refundAmountsByCount: [12000],
    };
    const { dialog } = await openDialog(returnDetail({ lines: [partlyReceived], firstReceiptDone: true }));

    expect(within(dialog).getByText('2点中1点を確認')).toBeInTheDocument();
    const [done, open] = unitRows(dialog);
    expect(within(done).getByText('受け取り済み')).toBeInTheDocument();
    expect(within(done).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(open).getByRole('checkbox', { name: '届いた' })).toBeEnabled();

    receiveUnit(dialog, 1, 'restocked');
    expect(within(dialog).getByText('2点中2点を確認')).toBeInTheDocument();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取って ￥12,000 を返金する$/);
  });

  it('届かない・お返し・検品待ちの行も、固定の行にその言葉で出す', async () => {
    const processed: OrderReturnLineDetail = {
      ...BLOUSE,
      quantity: 4,
      progress: progress({ sentBack: 1, pendingInspection: 1, missing: 1, processed: 3, unprocessed: 1 }),
      refundAmountsByCount: [12000],
    };
    const { dialog } = await openDialog(returnDetail({ lines: [processed] }));

    const rows = unitRows(dialog);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]).getByText('検品待ち')).toBeInTheDocument();
    expect(within(rows[1]).getByText('お返し')).toBeInTheDocument();
    expect(within(rows[2]).getByText('届かない')).toBeInTheDocument();
    expect(within(rows[3]).getByRole('checkbox', { name: '届いた' })).toBeEnabled();
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });
});

describe('OrderReturnReceiveDialog の返金の欄', () => {
  it('店長が返金の品を全部受け取ると、計算どおりの返金・内訳・額と送料の入力が出て、ボタンに額が出る', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'restocked');

    const refund = within(dialog).getByRole('group', { name: '返金' });
    expect(within(refund).getByRole('radio', { name: '計算どおり ￥24,000 を返金する' })).toBeChecked();
    expect(within(refund).getByRole('radio', { name: '額を相談してから返金する' })).not.toBeChecked();
    expect(within(dialog).getByText(CONSULT_HINT)).toBeInTheDocument();
    expect(breakdownRow(dialog, '商品')).toBe('商品￥24,000');
    expect(breakdownRow(dialog, '送料')).toBe('送料￥0');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥24,000');
    expect(amountInput(dialog)).toHaveValue(24000);
    expect(shippingInput(dialog)).toHaveValue(0);
    expect(within(dialog).queryByText('返送料')).not.toBeInTheDocument();
    expect(primaryButton(dialog)).toBeEnabled();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取って ￥24,000 を返金する$/);
  });

  it('一部だけ受け取ると、受け取った分の額になり、ボタンは「N点を受け取って」になる', async () => {
    const { dialog } = await openDialog();
    receiveUnit(dialog, 0, 'not_restocked');

    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥12,000 を返金する' })).toBeChecked();
    expect(primaryButton(dialog)).toHaveTextContent(/^1点を受け取って ￥12,000 を返金する$/);
  });

  it('同じ注文の商品を指す2つの行（2回に分けて発送した品）は、数を足してから額の列を引く。別の商品の行は別に引いて足す（DB と同じ額）', async () => {
    // 3,000 円 × 2 点・割引 667 円の注文の商品（Task 4 の試験の値 X と同じ）。1点を返す額は 2,666、2点まとめて返す額は 5,333
    // （1点の額を2回足すと 5,332 で、1円ずれる）。DB は返品の行ごとに、その注文の商品の同じ列（refund_amounts_by_count）を返す
    const amounts = [2666, 5333];
    const first: OrderReturnLineDetail = {
      ...BLOUSE, id: 'line-blouse-1', quantity: 1, progress: progress({ unprocessed: 1 }), refundAmountsByCount: amounts,
    };
    const second: OrderReturnLineDetail = { ...first, id: 'line-blouse-2', fulfillmentId: 'ful-2', fulfillmentNumber: 2 };
    const belt: OrderReturnLineDetail = {
      ...BLOUSE, id: 'line-belt', orderItemId: 'item-belt', itemName: 'レザーベルト', color: '茶', size: null, quantity: 1,
      progress: progress({ unprocessed: 1 }), refundAmountsByCount: [9000],
    };
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [first, second, belt] }));
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData({ refundId: 'refund-1', refundAmount: 14333, refundStatus: 'pending' }) }));

    receiveUnit(dialog, 0, 'restocked');
    expect(breakdownRow(dialog, '商品')).toBe('商品￥2,666');
    receiveUnit(dialog, 1, 'restocked');
    expect(breakdownRow(dialog, '商品')).toBe('商品￥5,333');
    receiveUnit(dialog, 2, 'restocked');
    expect(breakdownRow(dialog, '商品')).toBe('商品￥14,333');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥14,333');
    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥14,333 を返金する' })).toBeChecked();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取って ￥14,333 を返金する$/);

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED));
    // 見込みと同じ額なので、額は送らない（DB が同じ式で計算する）
    expect(requestBodyOf(0)).toMatchObject({
      units: [
        { returnLineId: 'line-blouse-1', disposition: 'restocked', quantity: 1 },
        { returnLineId: 'line-blouse-2', disposition: 'restocked', quantity: 1 },
        { returnLineId: 'line-belt', disposition: 'restocked', quantity: 1 },
      ],
      refundChoice: 'now',
      refundAmount: null,
    });
  });

  it('返金額は手で直せて、上限は返せる額。行や送料を変えると見込みの額に戻る', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'restocked');

    fireEvent.change(amountInput(dialog), { target: { value: '20000' } });
    expect(amountInput(dialog)).toHaveValue(20000);
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取って ￥20,000 を返金する$/);
    // 内訳は、行と送料から出した見込みのまま
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥24,000');
    // 計算どおりの選びの文字も、見込みのまま
    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥24,000 を返金する' })).toBeInTheDocument();

    fireEvent.change(amountInput(dialog), { target: { value: '99999999' } });
    expect(amountInput(dialog)).toHaveValue(54800);

    fireEvent.change(amountInput(dialog), { target: { value: '20000' } });
    fireEvent.click(within(unitRows(dialog)[1]).getByRole('checkbox', { name: '届いた' }));
    expect(amountInput(dialog)).toHaveValue(12000);
  });

  it('送料は 0 から返せる送料までに収まり、内訳と返金額に足される', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'restocked');

    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });
    expect(shippingInput(dialog)).toHaveValue(300);
    expect(breakdownRow(dialog, '送料')).toBe('送料￥300');
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥24,300');
    expect(amountInput(dialog)).toHaveValue(24300);

    fireEvent.change(shippingInput(dialog), { target: { value: '5000' } });
    expect(shippingInput(dialog)).toHaveValue(800);
    fireEvent.change(shippingInput(dialog), { target: { value: '-1' } });
    expect(shippingInput(dialog)).toHaveValue(0);
  });

  it('返せる送料が無い注文では、送料の入力を止める', async () => {
    const { dialog } = await openDialog(returnDetail(), { refundableShipping: 0 });
    receiveAll(dialog, 'restocked');

    expect(within(dialog).getByLabelText('送料（返せる送料: ￥0）')).toBeDisabled();
  });

  it('返金額が送料より小さい間は押せない（DB は送料 ≤ 額を入力の誤りにする）', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'restocked');
    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });

    fireEvent.change(amountInput(dialog), { target: { value: '200' } });
    expect(primaryButton(dialog)).toBeDisabled();

    fireEvent.change(amountInput(dialog), { target: { value: '300' } });
    expect(primaryButton(dialog)).toBeEnabled();
  });

  it('返送料と返品の手数料は、最初の受け取りの内訳から引かれる', async () => {
    const { dialog } = await openDialog(
      returnDetail({
        returnMethod: 'shop_label',
        fees: {
          returnShippingFee: 800, restockingFeePercent: 10, exchangeFee: 0, exchangeShippingFee: 0,
          feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
        },
      }),
    );
    receiveAll(dialog, 'restocked');

    expect(breakdownRow(dialog, '商品')).toBe('商品￥24,000');
    expect(breakdownRow(dialog, '返送料')).toBe(`返送料${MINUS}￥800`);
    expect(breakdownRow(dialog, '返品の手数料')).toBe(`返品の手数料${MINUS}￥2,400`);
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥20,800');
    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥20,800 を返金する' })).toBeChecked();
  });

  it('2回目以降の受け取りには、返送料が付かない（返品の手数料だけ）', async () => {
    const { dialog } = await openDialog(
      returnDetail({
        returnMethod: 'shop_label',
        firstReceiptDone: true,
        fees: {
          returnShippingFee: 800, restockingFeePercent: 10, exchangeFee: 0, exchangeShippingFee: 0,
          feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
        },
      }),
    );
    receiveAll(dialog, 'restocked');

    expect(within(within(dialog).getByRole('group', { name: '返金の内訳' })).queryByText('返送料')).not.toBeInTheDocument();
    expect(breakdownRow(dialog, '返品の手数料')).toBe(`返品の手数料${MINUS}￥2,400`);
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥21,600');
  });

  it('「額を相談してから返金する」を選ぶと、内訳と入力を隠し、ボタンは「受け取りだけ記録する」になる', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'restocked');

    fireEvent.click(within(dialog).getByRole('radio', { name: '額を相談してから返金する' }));

    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('返金額（返せる額: ￥54,800）')).not.toBeInTheDocument();
    expect(primaryButton(dialog)).toHaveTextContent('受け取りだけ記録する（返金は額を決めてから）');
    expect(primaryButton(dialog)).toBeEnabled();
  });

  it('返金の権限が無い人（サポート）には、返金は店長が行う旨だけを出す。選びも入力も出さない', async () => {
    const { dialog } = await openDialog(returnDetail(), { canRefund: false });
    receiveAll(dialog, 'restocked');

    expect(within(dialog).getByText('返金は店長が行います（受け取ると「返金待ち」になります）。')).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: '返金' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: '返金の内訳' })).not.toBeInTheDocument();
    expect(primaryButton(dialog)).toHaveTextContent('受け取りだけ記録する（額は店長が決める）');
    expect(primaryButton(dialog)).toBeEnabled();
  });
});

describe('OrderReturnReceiveDialog の返金額が0円になる受け取り（手数料が商品の額以上。P20）', () => {
  /** 返品の手数料が100%で、返金の商品の額と同じだけ引かれる返品。計算どおりの返金額は0円になる */
  const allFeesDetail = (overrides: Partial<OrderReturnDetail> = {}) =>
    returnDetail({
      fees: {
        returnShippingFee: 0, restockingFeePercent: 100, exchangeFee: 0, exchangeShippingFee: 0,
        feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
      },
      ...overrides,
    });

  it('全部を受け取ると返金額が0円になり、ボタンは「返金なしで記録する」になる。押せる', async () => {
    const { dialog } = await openDialog(allFeesDetail());
    receiveAll(dialog, 'restocked');

    expect(breakdownRow(dialog, '商品')).toBe('商品￥24,000');
    expect(breakdownRow(dialog, '返品の手数料')).toBe(`返品の手数料${MINUS}￥24,000`);
    expect(breakdownRow(dialog, '返金額')).toBe('返金額￥0');
    expect(amountInput(dialog)).toHaveValue(0);
    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥0 を返金する' })).toBeChecked();
    expect(primaryButton(dialog)).toBeEnabled();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取り、返金なしで記録する$/);
  });

  it('一部を受け取った時は「N点を受け取り、返金なしで記録する」になる', async () => {
    const { dialog } = await openDialog(allFeesDetail());
    receiveUnit(dialog, 0, 'restocked');

    expect(primaryButton(dialog)).toHaveTextContent(/^1点を受け取り、返金なしで記録する$/);
  });

  it('交換の品も受け取る時は、言葉の終わりに「交換の品を発送待ちにする」が付く', async () => {
    const oneBlouse: OrderReturnLineDetail = {
      ...BLOUSE, quantity: 1, progress: progress({ unprocessed: 1 }), refundAmountsByCount: [12000],
    };
    const { dialog } = await openDialog(allFeesDetail({ lines: [oneBlouse, COAT] }));
    receiveAll(dialog, 'restocked');

    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取り、返金なしで記録する、交換の品を発送待ちにする$/);
  });

  it('返金なしで記録した答え（返金の番号が null・waived）の知らせは「受け取りを記録しました。」。額は送らない（DB が同じ式で0円にする）', async () => {
    const { dialog, onDone } = await openDialog(allFeesDetail());
    mockClientFetch.mockResolvedValueOnce(
      json({ data: receiveData({ refundId: null, refundAmount: 0, refundStatus: 'waived' }) }),
    );
    receiveAll(dialog, 'restocked');

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ refundChoice: 'now', refundAmount: null, refundShippingAmount: 0 });
    expect(onDone).toHaveBeenCalledWith(NOTICE_RECORDED);
  });

  it('店長が返金額を手で0に直した時も、ボタンは「返金なしで記録する」になり、0円の額を送る', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData({ refundAmount: 0, refundStatus: 'waived' }) }));
    receiveAll(dialog, 'restocked');

    fireEvent.change(amountInput(dialog), { target: { value: '0' } });
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取り、返金なしで記録する$/);
    expect(primaryButton(dialog)).toBeEnabled();
    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_RECORDED));
    expect(requestBodyOf(0)).toMatchObject({ refundChoice: 'now', refundAmount: 0, refundShippingAmount: 0 });
  });

  it('0円に直しても、送料が残っている間は押せない（送料は額の中から返すため）', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'restocked');
    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });

    fireEvent.change(amountInput(dialog), { target: { value: '0' } });

    expect(primaryButton(dialog)).toBeDisabled();
  });
});

describe('OrderReturnReceiveDialog のお支払い待ちの見込み', () => {
  const NOTICE = (amount: string) => 'お支払い待ち ' + amount + '（交換の品は、お支払いを確かめてから送ります）';
  const fees = {
    returnShippingFee: 1500, restockingFeePercent: 0, exchangeFee: 2000, exchangeShippingFee: 800,
    feeDueAmount: 9000, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
  };

  it('返金の品が無い受け取りの手数料の合計を、押す前に内訳の下に出す。既存の未払い額は足さない', async () => {
    const { dialog } = await openDialog(returnDetail({ returnMethod: 'shop_label', fees, lines: [exchangeLine()] }));
    receiveAll(dialog, 'restocked');
    const notice = within(dialog).getByText(NOTICE('￥4,300'));
    const terms = within(dialog).getByText('交換の送料').closest('dl') as HTMLElement;
    expect(terms.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(calledUrls()).toEqual([RETURNS_URL]);
  });

  it('今返金では商品の額から引けない分だけを内訳の直下に出す。相談に変えると消える', async () => {
    const { dialog } = await openDialog(returnDetail({
      returnMethod: 'shop_label', fees: { ...fees, returnShippingFee: 30000 },
    }));
    receiveAll(dialog, 'restocked');
    const notice = within(dialog).getByText(NOTICE('￥6,000'));
    const breakdown = within(dialog).getByRole('group', { name: '返金の内訳' });
    expect(breakdown.nextElementSibling).toBe(notice);
    fireEvent.click(within(dialog).getByRole('radio', { name: '額を相談してから返金する' }));
    expect(within(dialog).queryByText(NOTICE('￥6,000'))).not.toBeInTheDocument();
  });

  it.each(['お返しだけ', '手数料0円', '交換の2回目以降'])('%sは今回のお支払い待ちを出さない', async (scenario) => {
    const detail = returnDetail({
      returnMethod: 'shop_label',
      fees: scenario === '手数料0円' ? { ...fees, returnShippingFee: 0, exchangeFee: 0, exchangeShippingFee: 0 } : fees,
      firstReceiptDone: scenario === '交換の2回目以降',
      firstExchangeReceiptDone: scenario === '交換の2回目以降',
      lines: [exchangeLine()],
    });
    const { dialog } = await openDialog(detail);
    receiveAll(dialog, scenario === 'お返しだけ' ? 'sent_back' : 'restocked');
    expect(within(dialog).queryByText(/お支払い待ち/)).not.toBeInTheDocument();
  });
});

describe('OrderReturnReceiveDialog の交換の品', () => {
  it('在庫から送る交換の品を受け取ると、交換の品の欄に行と在庫を出す。返金の欄は出ず、ボタンは交換の品を発送待ちにする', async () => {
    const { dialog } = await openDialog(returnDetail({ lines: [COAT] }));
    receiveUnit(dialog, 0, 'restocked');

    const exchange = within(dialog).getByRole('region', { name: '交換の品' });
    const row = within(exchange).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' });
    expect(within(row).getByText('在庫から（在庫 3）')).toBeInTheDocument();
    expect(within(dialog).queryByRole('group', { name: '返金' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取り、交換の品を発送待ちにする$/);
  });

it('在庫不足で断られたら返品を読み直し、今の在庫で「作って送る」「返金に変える」を選べるようにする（Review Focus 2）', async () => {
  const enough = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' });
  const short = exchangeLine({ stockQuantity: 0, outOfStockExchange: 'decline' });
  const { dialog, onDone } = await openDialog(returnDetail({ lines: [enough] }));
  const message = '交換の品の在庫が足りません。「作って送る」か「返金に変える」を選んでください。';
  mockClientFetch
    .mockResolvedValueOnce(json({ error: message, code: 'RETURN_EXCHANGE_OUT_OF_STOCK' }, 409))
    .mockResolvedValueOnce(returnsAnswer(returnDetail({ lines: [short] })))
    .mockResolvedValueOnce(json({ data: receiveData() }));
  receiveUnit(dialog, 0, 'restocked');
  expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();

  fireEvent.click(primaryButton(dialog));

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
  const block = within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' });
  const make = await within(block).findByRole('radio', { name: '作って送る' });
  expect(calledUrls()).toEqual([RETURNS_URL, RECEIVE_URL, RETURNS_URL]);
  // 行の選びは残る
  expect(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' })).toHaveValue('restocked');
  expect(primaryButton(dialog)).toBeDisabled();

  fireEvent.click(make);
  fireEvent.click(primaryButton(dialog));

  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  // 呼び出しは 読み込み → 受け取り → 読み直し → 受け取り
  const resent = JSON.parse((mockClientFetch.mock.calls[3][1] as RequestInit).body as string) as Record<string, unknown>;
  expect(resent).toMatchObject({ exchangeOverrides: [{ returnLineId: 'line-coat', action: 'make' }] });
  expect(resent.requestKey).not.toBe(requestBodyOf(0).requestKey);
});

  it('画面を開いた後に在庫が戻り、足りる行へ選びを送って RETURN_ARGUMENT_INVALID で断られたら、返品を読み直し、その行の選びは送らない', async () => {
    const short = exchangeLine({ stockQuantity: 0, outOfStockExchange: 'decline' });
    const enough = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' });
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [short] }));
    const message = '入力を確かめてください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'RETURN_ARGUMENT_INVALID' }, 400))
      .mockResolvedValueOnce(returnsAnswer(returnDetail({ lines: [enough] })))
      .mockResolvedValueOnce(json({ data: receiveData() }));
    receiveUnit(dialog, 0, 'restocked');
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' })).getByRole('radio', { name: '作って送る' }));

    fireEvent.click(primaryButton(dialog));

    // 画面を開いた後に在庫が戻ったので、DB は足りる行への選びを断る。画面は返品を読み直して、今の在庫で数え直す
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    await waitFor(() => expect(calledUrls()).toEqual([RETURNS_URL, RECEIVE_URL, RETURNS_URL]));
    await waitFor(() => expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument());
    expect(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' })).toHaveValue('restocked');
    await waitFor(() => expect(primaryButton(dialog)).toBeEnabled());

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // 呼び出しは 読み込み → 受け取り → 読み直し → 受け取り。足りるようになった行の選び（作って送る）は送らず、番号は作り直す
    expect(requestBodyOf(0)).toMatchObject({ exchangeOverrides: [{ returnLineId: 'line-coat', action: 'make' }] });
    const resent = JSON.parse((mockClientFetch.mock.calls[3][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(resent).toMatchObject({ exchangeOverrides: [] });
    expect(resent.requestKey).not.toBe(requestBodyOf(0).requestKey);
  });

  it('make の理由の2点を店長が返金に変えると、k点の見込み・内訳・ボタン・本文に入る', async () => {
    const line = exchangeLine({ stockQuantity: 0, outOfStockExchange: 'make' }, {
      quantity: 2, progress: progress({ unprocessed: 2 }), refundAmountsByCount: [30000, 50000],
    });
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [line] }));
    receiveAll(dialog, 'restocked');
    const block = within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 2' });
    fireEvent.click(within(block).getByRole('radio', { name: '返金に変える' }));
    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥50,000 を返金する' })).toBeChecked();
    expect(breakdownRow(dialog, '商品')).toBe('商品￥50,000');
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取って ￥50,000 を返金する$/);
    expect(within(block).queryByText('作って送る（お届けの目安 14日）')).not.toBeInTheDocument();
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData({ refundId: 'refund-1', refundAmount: 50000, refundStatus: 'pending' }) }));
    fireEvent.click(primaryButton(dialog));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED));
    expect(requestBodyOf(0)).toMatchObject({
      exchangeOverrides: [{ returnLineId: 'line-coat', action: 'refund' }], refundChoice: 'now', refundAmount: null,
    });
  });

  it('make の理由で返金から作って送るに戻すと、返金の欄が消え、上書きは送らない', async () => {
    const line = exchangeLine({ stockQuantity: 0, outOfStockExchange: 'make' }, { refundAmountsByCount: [30000] });
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [line] }));
    receiveAll(dialog, 'restocked');
    const block = within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' });
    fireEvent.click(within(block).getByRole('radio', { name: '返金に変える' }));
    fireEvent.click(within(block).getByRole('radio', { name: '作って送る' }));
    expect(within(dialog).queryByRole('group', { name: '返金' })).not.toBeInTheDocument();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取り、交換の品を発送待ちにする$/);
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData() }));
    fireEvent.click(primaryButton(dialog));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ exchangeOverrides: [], refundChoice: 'none' });
  });

  it('make の理由の在庫不足は、サポートには文だけで選びを出さず、自動で作って送る', async () => {
    const { dialog, onDone } = await openDialog(returnDetail({
      lines: [exchangeLine({ stockQuantity: 0, outOfStockExchange: 'make' })],
    }), { canRefund: false });
    receiveAll(dialog, 'restocked');
    const block = within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' });
    expect(within(block).getByText('在庫が足りないため、作ってお送りします。')).toBeInTheDocument();
    expect(within(block).queryByRole('radio')).not.toBeInTheDocument();
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData() }));
    fireEvent.click(primaryButton(dialog));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ exchangeOverrides: [], refundChoice: 'none' });
  });

  it('在庫1・同じ交換先の2行はGETの順で割り当て、2行目だけ在庫不足になる。2行目の選びだけ送る', async () => {
    // IDの並びとGETの並びを逆にし、画面がID順に並べ直さないことも確かめる。
    const first = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' }, { id: 'line-z', itemName: '先のコート' });
    const second = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' }, { id: 'line-a', itemName: '後のコート' });
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [first, second] }));
    receiveAll(dialog, 'restocked');
    const firstBlock = within(dialog).getByRole('group', { name: '先のコート（黒 / XL） × 1' });
    const secondBlock = within(dialog).getByRole('group', { name: '後のコート（黒 / XL） × 1' });
    expect(within(firstBlock).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(secondBlock).getByText('在庫が足りません。「作って送る」か「返金に変える」を選んでください。')).toBeInTheDocument();
    expect(primaryButton(dialog)).toBeDisabled();
    fireEvent.click(within(secondBlock).getByRole('radio', { name: '作って送る' }));
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData() }));
    fireEvent.click(primaryButton(dialog));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ exchangeOverrides: [{ returnLineId: 'line-a', action: 'make' }] });
  });

  it('在庫1・同じ交換先の2行は、サポートが1行目を選ぶと2行目をチェックできない', async () => {
    const first = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' }, { id: 'line-z' });
    const second = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' }, { id: 'line-a' });
    const { dialog } = await openDialog(returnDetail({ lines: [first, second] }), { canRefund: false });
    receiveUnit(dialog, 0, 'restocked');
    const secondRow = unitRows(dialog)[1];
    expect(within(secondRow).getByRole('checkbox', { name: '届いた' })).toBeDisabled();
    expect(within(secondRow).getByText('在庫が足りません。この品は店長が受け取ります。')).toBeInTheDocument();
    // 1行目を外せば2行目へ割り当てられる。
    fireEvent.click(within(unitRows(dialog)[0]).getByRole('checkbox', { name: '届いた' }));
    expect(within(secondRow).getByRole('checkbox', { name: '届いた' })).toBeEnabled();
  });

  it('サポートが後の行を先に選んでも、前の行を増やして在庫を超えれば確定できず、後のチェックを外せる', async () => {
    const first = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' }, { id: 'line-z' });
    const second = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' }, { id: 'line-a' });
    const { dialog } = await openDialog(returnDetail({ lines: [first, second] }), { canRefund: false });
    receiveUnit(dialog, 1, 'restocked');
    receiveUnit(dialog, 0, 'restocked');
    expect(primaryButton(dialog)).toBeDisabled();
    const checked = within(unitRows(dialog)[1]).getByRole('checkbox', { name: '届いた' });
    expect(checked).toBeEnabled();
    fireEvent.click(checked);
    expect(primaryButton(dialog)).toBeEnabled();
  });

  it('在庫不足後の読み直し中は確定できず、失敗も表示して入力を保つ。読み直せたら今の在庫で選べる', async () => {
    const enough = exchangeLine({ stockQuantity: 1, outOfStockExchange: 'decline' });
    const short = exchangeLine({ stockQuantity: 0, outOfStockExchange: 'decline' });
    const { dialog } = await openDialog(returnDetail({ lines: [enough] }));
    let resolveRead: (value: Response) => void = () => {};
    mockClientFetch
      .mockResolvedValueOnce(json({ error: '交換の品の在庫が足りません。', code: 'RETURN_EXCHANGE_OUT_OF_STOCK' }, 409))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRead = resolve; }));
    receiveAll(dialog, 'restocked');
    fireEvent.click(primaryButton(dialog));
    await within(dialog).findByText('読み込み中です...');
    expect(primaryButton(dialog)).toBeDisabled();
    resolveRead(json({ error: 'x' }, 500));
    await within(dialog).findByText('返品の情報を読み込めませんでした。');
    expect(primaryButton(dialog)).toBeDisabled();
    expect(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' })).toHaveValue('restocked');
    mockClientFetch.mockResolvedValueOnce(returnsAnswer(returnDetail({ lines: [short] })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度読み込む' }));
    const block = within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' });
    fireEvent.click(await within(block).findByRole('radio', { name: '作って送る' }));
    await waitFor(() => expect(primaryButton(dialog)).toBeEnabled());
    expect(within(dialog).queryByText('返品の情報を読み込めませんでした。')).not.toBeInTheDocument();
  });

  it('作って送る交換の品には、お届けの目安の日数を出す', async () => {
    const { dialog } = await openDialog(returnDetail({ lines: [exchangeLine({ method: 'make' })] }));
    receiveUnit(dialog, 0, 'restocked');

    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' });
    expect(within(row).getByText('作って送る（お届けの目安 14日）')).toBeInTheDocument();
  });

  it('在庫が足りず、設定が「作って送る」なら、自動で作って送るに変わる旨を出す。最初の値で送ると上書きは送らない', async () => {
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [exchangeLine({ stockQuantity: 0, outOfStockExchange: 'make' })] }));
    receiveUnit(dialog, 0, 'restocked');

    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' });
    expect(within(row).getByText('在庫が足りないため、作ってお送りします。')).toBeInTheDocument();
    expect(within(row).getByText('作って送る（お届けの目安 14日）')).toBeInTheDocument();
    expect(within(row).getByRole('radio', { name: '作って送る' })).toBeChecked();
    expect(within(row).getByRole('radio', { name: '返金に変える' })).not.toBeChecked();
    expect(primaryButton(dialog)).toBeEnabled();
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData() }));
    fireEvent.click(primaryButton(dialog));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ exchangeOverrides: [], refundChoice: 'none' });
  });

  it('在庫が足りず、受けない設定なら、店長は作って送るか返金に変えるかを選ぶまで送れない。作って送るを選ぶと選びを送る', async () => {
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [exchangeLine({ stockQuantity: 0, outOfStockExchange: 'decline' })] }));
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData() }));
    receiveUnit(dialog, 0, 'restocked');

    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' });
    expect(within(row).getByText('在庫が足りません。「作って送る」か「返金に変える」を選んでください。')).toBeInTheDocument();
    expect(within(row).getByRole('radio', { name: '作って送る' })).not.toBeChecked();
    expect(within(row).getByRole('radio', { name: '返金に変える' })).not.toBeChecked();
    expect(primaryButton(dialog)).toBeDisabled();

    fireEvent.click(within(row).getByRole('radio', { name: '作って送る' }));
    expect(within(row).getByText('作って送る（お届けの目安 14日）')).toBeInTheDocument();
    expect(primaryButton(dialog)).toBeEnabled();
    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({
      units: [{ returnLineId: 'line-coat', disposition: 'restocked', quantity: 1 }],
      exchangeOverrides: [{ returnLineId: 'line-coat', action: 'make' }],
      refundChoice: 'none',
    });
  });

  it('「返金に変える」を選ぶと、その品を返金の品として数え、返金の欄が出る', async () => {
    // 返金に変えた時の額は、返金の行と同じ k 点ごとの額（refundAmountsByCount）で見込む
    const decline = exchangeLine({ stockQuantity: 0, outOfStockExchange: 'decline' }, { refundAmountsByCount: [30000] });
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [decline] }));
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData({ refundId: 'refund-1', refundAmount: 30000, refundStatus: 'pending' }) }));
    receiveUnit(dialog, 0, 'restocked');
    expect(within(dialog).queryByRole('group', { name: '返金' })).not.toBeInTheDocument();

    fireEvent.click(within(within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 1' })).getByRole('radio', { name: '返金に変える' }));

    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥30,000 を返金する' })).toBeChecked();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取って ￥30,000 を返金する$/);
    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED));
    expect(requestBodyOf(0)).toMatchObject({
      exchangeOverrides: [{ returnLineId: 'line-coat', action: 'refund' }],
      refundChoice: 'now',
      refundAmount: null,
    });
  });

  it('2点とも「返金に変える」にすると、k 点ごとの額の表の2点目の額で見込む', async () => {
    const twoCoats = exchangeLine(
      { stockQuantity: 0, outOfStockExchange: 'decline' },
      { quantity: 2, progress: progress({ unprocessed: 2 }), refundAmountsByCount: [30000, 50000] },
    );
    const { dialog } = await openDialog(returnDetail({ lines: [twoCoats] }));
    receiveAll(dialog, 'restocked');

    fireEvent.click(within(within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 2' })).getByRole('radio', { name: '返金に変える' }));

    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥50,000 を返金する' })).toBeChecked();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取って ￥50,000 を返金する$/);
  });

  it('足りない状態が解けた（受け取る数を減らした）ら、前の選びは送らない', async () => {
    const twoCoats = exchangeLine(
      { stockQuantity: 1, outOfStockExchange: 'decline' },
      { quantity: 2, progress: progress({ unprocessed: 2 }) },
    );
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [twoCoats] }));
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData() }));
    receiveAll(dialog, 'restocked');
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'ウールコート（黒 / XL） × 2' })).getByRole('radio', { name: '作って送る' }));

    fireEvent.click(within(unitRows(dialog)[1]).getByRole('checkbox', { name: '届いた' }));
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    fireEvent.click(primaryButton(dialog));
    // 1点は届いていないので、送る前の確かめが出る
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({
      units: [{ returnLineId: 'line-coat', disposition: 'restocked', quantity: 1 }],
      exchangeOverrides: [],
    });
  });

  it('サポートは、在庫を超える交換の品の行をチェックできない（店長が受け取る旨を出す）', async () => {
    const twoCoats = exchangeLine(
      { stockQuantity: 1, outOfStockExchange: 'decline' },
      { quantity: 2, progress: progress({ unprocessed: 2 }) },
    );
    const { dialog } = await openDialog(returnDetail({ lines: [twoCoats] }), { canRefund: false });

    const [first, second] = unitRows(dialog);
    expect(within(first).getByRole('checkbox', { name: '届いた' })).toBeEnabled();
    expect(within(first).queryByText('在庫が足りません。この品は店長が受け取ります。')).not.toBeInTheDocument();
    expect(within(second).getByRole('checkbox', { name: '届いた' })).toBeDisabled();
    expect(within(second).getByText('在庫が足りません。この品は店長が受け取ります。')).toBeInTheDocument();
  });
});

describe('OrderReturnReceiveDialog のお返し', () => {
  const MESSAGE_LABEL = 'お客様へのメッセージ（必須・お客様に届きます）';

  it('お返しを選ぶと、メッセージ・配送業者・伝票番号の欄が出る。メッセージが無い間は押せず、お知らせは外せない', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'sent_back');

    const sentBack = within(dialog).getByRole('group', { name: 'お返し' });
    expect(within(sentBack).getByRole('textbox', { name: MESSAGE_LABEL })).toHaveValue('');
    const carrier = within(sentBack).getByRole('combobox', { name: '送り返しの配送業者（任意）' });
    expect(within(carrier).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '指定しない',
      'ヤマト運輸',
      '佐川急便',
      '日本郵便',
      'その他',
    ]);
    expect(within(sentBack).getByRole('textbox', { name: '送り返しの伝票番号（任意）' })).toHaveValue('');
    const notify = within(dialog).getByRole('checkbox', { name: 'お客様に知らせる' });
    expect(notify).toBeChecked();
    expect(notify).toBeDisabled();
    // お返しだけなので、返金の欄は出ない
    expect(within(dialog).queryByRole('group', { name: '返金' })).not.toBeInTheDocument();
    expect(primaryButton(dialog)).toHaveTextContent(/^すべて受け取り、品物をお返しする$/);
    expect(primaryButton(dialog)).toBeDisabled();

    fireEvent.change(within(sentBack).getByRole('textbox', { name: MESSAGE_LABEL }), { target: { value: '   ' } });
    expect(primaryButton(dialog)).toBeDisabled();
    fireEvent.change(within(sentBack).getByRole('textbox', { name: MESSAGE_LABEL }), { target: { value: '使用の跡がありました。' } });
    expect(primaryButton(dialog)).toBeEnabled();
  });

  it('伝票番号に使えない字が入っている間は押せず、直すと押せる', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'sent_back');
    fireEvent.change(within(dialog).getByRole('textbox', { name: MESSAGE_LABEL }), { target: { value: '使用の跡がありました。' } });

    fireEvent.change(within(dialog).getByRole('textbox', { name: '送り返しの伝票番号（任意）' }), { target: { value: 'AB 12' } });
    expect(within(dialog).getByText('伝票番号は英数字とハイフンで入力してください。')).toBeInTheDocument();
    expect(primaryButton(dialog)).toBeDisabled();

    fireEvent.change(within(dialog).getByRole('textbox', { name: '送り返しの伝票番号（任意）' }), { target: { value: 'AB-12' } });
    expect(within(dialog).queryByText('伝票番号は英数字とハイフンで入力してください。')).not.toBeInTheDocument();
    expect(primaryButton(dialog)).toBeEnabled();
  });

  it('お返しは送る前に確かめを出し、「お返しする」で送る。メッセージは前後の空白を除き、お知らせは必ず送る', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData({ returnStatus: 'closed' }) }));
    receiveAll(dialog, 'sent_back');
    fireEvent.change(within(dialog).getByRole('textbox', { name: MESSAGE_LABEL }), { target: { value: '  使用の跡がありました。  ' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '送り返しの配送業者（任意）' }), { target: { value: 'yamato' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '送り返しの伝票番号（任意）' }), { target: { value: ' AB-12 ' } });

    fireEvent.click(primaryButton(dialog));

    expect(within(dialog).getByText('お客様にメッセージが届きます。取り消せません。')).toBeInTheDocument();
    expect(within(dialog).queryByText(PARTIAL_CONFIRM(0))).not.toBeInTheDocument();
    expect(calledUrls()).toEqual([RETURNS_URL]);
    expect(within(dialog).getByRole('button', { name: 'お返しする' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'お返しする' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_RECORDED));
    expect(requestBodyOf(0)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      units: [{ returnLineId: 'line-blouse', disposition: 'sent_back', quantity: 2 }],
      exchangeOverrides: [],
      refundChoice: 'none',
      refundAmount: null,
      refundShippingAmount: 0,
      note: null,
      notifyCustomer: true,
      sentBackMessage: '使用の跡がありました。',
      sentBackCarrier: 'yamato',
      sentBackTrackingNumber: 'AB-12',
    });
  });

  it('お返しの確かめで「戻る」を押すと、入力を残したまま元の画面に戻る', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'sent_back');
    fireEvent.change(within(dialog).getByRole('textbox', { name: MESSAGE_LABEL }), { target: { value: '使用の跡がありました。' } });
    fireEvent.click(primaryButton(dialog));

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(within(dialog).queryByText('お客様にメッセージが届きます。取り消せません。')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: MESSAGE_LABEL })).toHaveValue('使用の跡がありました。');
    expect(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' })).toHaveValue('sent_back');
    expect(calledUrls()).toEqual([RETURNS_URL]);
  });

  it('一部をお返し、一部を返金にした時は、返金の欄は返金の品だけの額を出す。お知らせは外せない', async () => {
    const { dialog } = await openDialog();
    receiveUnit(dialog, 0, 'restocked');
    receiveUnit(dialog, 1, 'sent_back');

    expect(within(dialog).getByRole('radio', { name: '計算どおり ￥12,000 を返金する' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に知らせる' })).toBeDisabled();
    expect(within(dialog).getByRole('group', { name: 'お返し' })).toBeInTheDocument();
  });

  it('お返しの行を別の状態に変えると、お返しの欄が消えて、お知らせを外せるようになる', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'sent_back');

    fireEvent.change(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' }), { target: { value: 'restocked' } });
    fireEvent.change(within(unitRows(dialog)[1]).getByRole('combobox', { name: '品の状態' }), { target: { value: 'restocked' } });

    expect(within(dialog).queryByRole('group', { name: 'お返し' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に知らせる' })).toBeEnabled();
  });
});

describe('OrderReturnReceiveDialog の一部の受け取りと、届かない残り', () => {
  it('届いていない品が残る時は、送る前に確かめを出す。「記録する」で届いた分だけ送る', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData({ refundId: 'refund-1', refundAmount: 12000, refundStatus: 'pending' }) }));
    receiveUnit(dialog, 0, 'restocked');

    fireEvent.click(primaryButton(dialog));

    expect(within(dialog).getByText(PARTIAL_CONFIRM(1))).toBeInTheDocument();
    expect(calledUrls()).toEqual([RETURNS_URL]);
    expect(within(dialog).queryByText('お客様にメッセージが届きます。取り消せません。')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: '受け取る品' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED));
    expect(requestBodyOf(0)).toMatchObject({
      units: [{ returnLineId: 'line-blouse', disposition: 'restocked', quantity: 1 }],
      refundChoice: 'now',
      refundAmount: null,
    });
  });

  it('一部の確かめで「戻る」を押すと、選びを残したまま元の画面に戻る', async () => {
    const { dialog } = await openDialog();
    receiveUnit(dialog, 0, 'restocked');
    fireEvent.click(primaryButton(dialog));

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(within(dialog).queryByText(PARTIAL_CONFIRM(1))).not.toBeInTheDocument();
    expect(within(unitRows(dialog)[0]).getByRole('checkbox', { name: '届いた' })).toBeChecked();
    expect(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' })).toHaveValue('restocked');
    expect(calledUrls()).toEqual([RETURNS_URL]);
    expect(primaryButton(dialog)).toHaveTextContent(/^1点を受け取って ￥12,000 を返金する$/);
  });

  it('お返しと一部の受け取りが重なる時は、確かめを1つにまとめ、ボタンは「お返しする」にする', async () => {
    const { dialog } = await openDialog();
    receiveUnit(dialog, 0, 'sent_back');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'お客様へのメッセージ（必須・お客様に届きます）' }), {
      target: { value: '使用の跡がありました。' },
    });

    fireEvent.click(primaryButton(dialog));

    expect(within(dialog).getByText(PARTIAL_CONFIRM(1))).toBeInTheDocument();
    expect(within(dialog).getByText('お客様にメッセージが届きます。取り消せません。')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'お返しする' })).toBeEnabled();
  });

  it('何もチェックしていない間だけ「残りは届かないものとして返品を終える」を出す', async () => {
    const { dialog } = await openDialog();
    const closeMissing = () => within(dialog).queryByRole('button', { name: '残りは届かないものとして返品を終える' });
    expect(closeMissing()).toBeInTheDocument();

    fireEvent.click(within(unitRows(dialog)[0]).getByRole('checkbox', { name: '届いた' }));
    expect(closeMissing()).not.toBeInTheDocument();

    fireEvent.click(within(unitRows(dialog)[0]).getByRole('checkbox', { name: '届いた' }));
    expect(closeMissing()).toBeInTheDocument();
  });

  it('「残りは届かないものとして返品を終える」は確かめを挟み、「返品を終える」で届かない残りの窓口へ送る', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnStatus: 'closed', receiptId: 'receipt-2', replayed: false } }));

    fireEvent.click(within(dialog).getByRole('button', { name: '残りは届かないものとして返品を終える' }));

    expect(
      within(dialog).getByText('届いていない 2 点を「届かない」として返品を終えます。この品は返金も交換もしません。'),
    ).toBeInTheDocument();
    expect(calledUrls()).toEqual([RETURNS_URL]);
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(within(dialog).getByRole('list', { name: '受け取る品' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '残りは届かないものとして返品を終える' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を終える' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_CLOSED_MISSING));
    expect(mockClientFetch).toHaveBeenCalledWith(CLOSE_MISSING_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({ requestKey: expect.stringMatching(UUID_PATTERN) });
  });
});

describe('OrderReturnReceiveDialog の受け取り', () => {
  it('全部を今返金: 窓口の URL・二重防止の番号・中身を送り、受け取りと返金の知らせを親へ渡す。閉じるのは親', async () => {
    const { dialog, onDone, onClose } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(
      json({ data: receiveData({ refundId: 'refund-1', refundAmount: 24000, refundStatus: 'pending' }) }),
    );
    receiveAll(dialog, 'restocked');

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenCalledWith(RECEIVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      units: [{ returnLineId: 'line-blouse', disposition: 'restocked', quantity: 2 }],
      exchangeOverrides: [],
      refundChoice: 'now',
      refundAmount: null,
      refundShippingAmount: 0,
      note: null,
      notifyCustomer: true,
      sentBackMessage: null,
      sentBackCarrier: null,
      sentBackTrackingNumber: null,
    });
    expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('返金が済んでいる答え（succeeded）の知らせは「…返金しました。」', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(
      json({ data: receiveData({ refundId: 'refund-1', refundAmount: 24000, refundStatus: 'succeeded' }) }),
    );
    receiveAll(dialog, 'restocked');

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_REFUNDED));
  });

  it('状態ごとに数をまとめて送る。手で直した額・送料・知らせない選びも、そのまま送る', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData({ refundId: 'refund-1', refundAmount: 20300, refundStatus: 'succeeded' }) }));
    receiveUnit(dialog, 0, 'restocked');
    receiveUnit(dialog, 1, 'not_restocked');
    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });
    fireEvent.change(amountInput(dialog), { target: { value: '20300' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に知らせる' }));

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({
      units: [
        { returnLineId: 'line-blouse', disposition: 'restocked', quantity: 1 },
        { returnLineId: 'line-blouse', disposition: 'not_restocked', quantity: 1 },
      ],
      refundChoice: 'now',
      refundAmount: 20300,
      refundShippingAmount: 300,
      notifyCustomer: false,
    });
  });

  it('額を相談する時は、額も送料も送らない', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData({ returnStatus: 'open' }) }));
    receiveAll(dialog, 'restocked');
    fireEvent.change(shippingInput(dialog), { target: { value: '300' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: '額を相談してから返金する' }));

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_RECORDED));
    expect(requestBodyOf(0)).toMatchObject({ refundChoice: 'consult', refundAmount: null, refundShippingAmount: 0 });
  });

  it('サポートの受け取りは、返金の品があれば相談（返金待ち）として送る', async () => {
    const { dialog, onDone } = await openDialog(returnDetail(), { canRefund: false });
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData() }));
    receiveAll(dialog, 'restocked');

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({ refundChoice: 'consult', refundAmount: null, refundShippingAmount: 0 });
  });

  it('在庫から送る交換の品だけを受け取る時は、返金の選びを none で送る', async () => {
    const { dialog, onDone } = await openDialog(returnDetail({ lines: [COAT] }));
    mockClientFetch.mockResolvedValueOnce(json({ data: receiveData() }));
    receiveUnit(dialog, 0, 'not_restocked');

    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(0)).toMatchObject({
      units: [{ returnLineId: 'line-coat', disposition: 'not_restocked', quantity: 1 }],
      exchangeOverrides: [],
      refundChoice: 'none',
    });
  });

  it('Enter キーでは送らない（額や送料の欄でも、チェックでも）。お返しのメッセージの欄の Enter は改行のまま', async () => {
    const { dialog } = await openDialog();
    receiveAll(dialog, 'restocked');

    // preventDefault されている（フォームの送信にならない）
    expect(fireEvent.keyDown(amountInput(dialog), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(shippingInput(dialog), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(dialog).getByRole('checkbox', { name: 'お客様に知らせる' }), { key: 'Enter' })).toBe(false);
    expect(calledUrls()).toEqual([RETURNS_URL]);

    // 1行目の状態をお返しに変える（行はもうチェック済みなので、選び直すだけ）
    fireEvent.change(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' }), { target: { value: 'sent_back' } });
    // メッセージの欄は改行に使う。ボタンの Enter は押す動き
    expect(
      fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'お客様へのメッセージ（必須・お客様に届きます）' }), { key: 'Enter' }),
    ).toBe(true);
    expect(fireEvent.keyDown(primaryButton(dialog), { key: 'Enter' })).toBe(true);
  });

  it('「戻る」では送らずに閉じる（送信を試みていないので、一覧の読み直しは頼まない）', async () => {
    const { dialog, onClose, onDone, onUncertain } = await openDialog();
    receiveUnit(dialog, 0, 'restocked');

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(calledUrls()).toEqual([RETURNS_URL]);
  });
});

describe('OrderReturnReceiveDialog の窓口の断り', () => {
  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい二重防止の番号にする', async () => {
    const { dialog, onDone } = await openDialog();
    const message = '受け取る数が、残りの数を超えています。画面を開き直してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'RETURN_RECEIPT_EXCEEDS' }, 409))
      .mockResolvedValueOnce(json({ data: receiveData() }));
    receiveAll(dialog, 'restocked');
    fireEvent.click(primaryButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onDone).not.toHaveBeenCalled();
    expect(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' })).toHaveValue('restocked');
    expect(primaryButton(dialog)).toBeEnabled();

    fireEvent.click(primaryButton(dialog));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(1).requestKey).not.toBe(requestBodyOf(0).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

it.each([
  [422, { error: 'Stripe が返金を受け付けませんでした（カードが使えません）。', code: 'stripe_rejected', refundId: 'refund-1', receiptId: 'receipt-1' }],
  [409, { error: 'この注文は返金できません。', code: 'order_not_refundable', receiptId: 'receipt-1' }],
])(
  '受け取りは記録できたのに返金だけ断られた時（%i・受け取りの番号つき）は、文を出して入力を止め、「閉じる」だけにする。もう送れない',
  async (status, body) => {
    const { dialog, onDone, onClose, onUncertain } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    receiveUnit(dialog, 0, 'restocked');
    fireEvent.click(primaryButton(dialog));
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(body.error);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(RECEIPT_RECORDED_NOTE);
    expect(onDone).not.toHaveBeenCalled();
    // 同じ受け取りを新しい番号で送ると、まだ届いていない2点目まで受け取ったことになるので、確定のボタンを出さない
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる']);
    expect(primaryButton(dialog)).toBeNull();

    fireEvent.click(footerCloseButton(dialog));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calledUrls()).toEqual([RETURNS_URL, RECEIVE_URL]);
  },
);

  it('最初の送信が403で処理前に断られても、次の送信は同じ二重防止の番号を使う', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ data: receiveData() }));
    receiveAll(dialog, 'restocked');
    fireEvent.click(primaryButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この操作の権限がありません。');
    expect(primaryButton(dialog)).toBeEnabled();
    fireEvent.click(primaryButton(dialog));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).requestKey).toBe(requestBodyOf(0).requestKey);
  });

  it('権限が無い・認証が切れた時は固定の文、回数の制限（英語の短い文）は回数の制限の固定の文を出す', async () => {
    const { dialog } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));
    receiveAll(dialog, 'restocked');

    fireEvent.click(primaryButton(dialog));
    expect(await within(dialog).findByText('認証が必要です。再ログインしてください。')).toBeInTheDocument();

    fireEvent.click(primaryButton(dialog));
    expect(await within(dialog).findByText(RATE_LIMITED)).toBeInTheDocument();
    expect(within(dialog).queryByText('Too many requests')).not.toBeInTheDocument();
  });

  it('送っている間は押せず、二重に送らない。閉じることもできない（戻るも Esc も背景も効かない）', async () => {
    const { dialog, onClose, onDone } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    receiveAll(dialog, 'restocked');
    fireEvent.click(primaryButton(dialog));

    expect(primaryButton(dialog)).toBeDisabled();
    expect(within(unitRows(dialog)[0]).getByRole('checkbox', { name: '届いた' })).toBeDisabled();
    fireEvent.click(primaryButton(dialog));
    expect(calledUrls()).toEqual([RETURNS_URL, RECEIVE_URL]);
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(dialog.closest('[data-ui-dialog]') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();

    resolvePost(json({ data: receiveData() }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });
});

const UNKNOWN_ANSWERS: Array<[string, () => Promise<unknown>]> = [
  ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '入力を確かめてください。' }, 500))],
  [
    'Stripe の返事を確かめられなかった（502）',
    () => Promise.resolve(json({ error: UNKNOWN_RECEIVE, code: 'unknown_outcome', refundId: 'refund-1' }, 502)),
  ],
  ['成功なのに答えの形が読めない（200）', () => Promise.resolve(json({ data: { receiptId: 'receipt-1' } }))],
];

describe('OrderReturnReceiveDialog の答えが分からない時（今返金を押した後に通信が切れた）', () => {
  it.each(UNKNOWN_ANSWERS)(
    '%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ二重防止の番号・同じ中身で確かめ直す',
    async (_label, firstAnswer) => {
      const { dialog, onDone, onClose, onUncertain } = await openDialog();
      mockClientFetch
        .mockImplementationOnce(firstAnswer)
        .mockResolvedValueOnce(json({ data: receiveData({ refundId: 'refund-1', refundAmount: 24000, refundStatus: 'pending', replayed: true }) }));
      receiveAll(dialog, 'restocked');
      fireEvent.click(primaryButton(dialog));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_RECEIVE);
      // 入力は変えられない
      expect(within(unitRows(dialog)[0]).getByRole('checkbox', { name: '届いた' })).toBeDisabled();
      expect(within(unitRows(dialog)[0]).getByRole('combobox', { name: '品の状態' })).toBeDisabled();
      expect(amountInput(dialog)).toBeDisabled();
      expect(shippingInput(dialog)).toBeDisabled();
      expect(within(dialog).getByRole('radio', { name: '額を相談してから返金する' })).toBeDisabled();
      expect(within(dialog).getByRole('checkbox', { name: 'お客様に知らせる' })).toBeDisabled();
      // 操作は「もう一度確かめる」と「閉じる」だけ
      expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);
      expect(footerCloseButton(dialog)).toBeEnabled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

      await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_ACCEPTED));
      // 同じ二重防止の番号・同じ中身で送り直す（Stripe が返金を作っていても、DB は前の記録を返し、受け取りも返金も1回分のまま）
      expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
      expect(calledUrls()).toEqual([RETURNS_URL, RECEIVE_URL, RECEIVE_URL]);
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
      .mockResolvedValueOnce(json({ data: receiveData({ replayed: true }) }));
    receiveAll(dialog, 'restocked');
    fireEvent.click(primaryButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    // 断りの文の後ろに、答えが分からない時の文を続けて出す（取り消せない操作の結果が分からないことを、断りの文で隠さない）
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(`${message}${UNKNOWN_RECEIVE}`));
    expect(amountInput(dialog)).toBeDisabled();
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);
    expect(calledUrls()).toHaveLength(3);

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
    expect(requestBodyOf(2)).toEqual(requestBodyOf(0));
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it.each([400, 404, 409])(
    '確かめ直しが%iで断られたら、断りの文を出し、入力を戻して新しい番号で送れる。閉じる時は一覧の読み直しを頼む',
    async (status) => {
      const { dialog, onDone, onClose, onUncertain } = await openDialog();
      const message = '返品の状態が変わりました。画面を開き直してください。';
      mockClientFetch
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(json({ error: message, code: 'RETURN_STATE_CONFLICT' }, status))
        .mockResolvedValueOnce(json({ data: receiveData() }));
      receiveAll(dialog, 'restocked');
      fireEvent.click(primaryButton(dialog));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(message));
      expect(within(dialog).getByRole('alert')).not.toHaveTextContent(UNKNOWN_RECEIVE);
      expect(within(unitRows(dialog)[0]).getByRole('checkbox', { name: '届いた' })).toBeEnabled();
      expect(primaryButton(dialog)).toBeEnabled();

      // 状態は変わっているかもしれないので、閉じる時に親へ一覧の読み直しを頼む
      fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
      expect(onUncertain).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onDone).not.toHaveBeenCalled();

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
    receiveAll(dialog, 'restocked');
    fireEvent.click(primaryButton(dialog));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(calledUrls()).toHaveLength(3));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled());

    expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN_RECEIVE);
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
    receiveAll(dialog, 'restocked');
    fireEvent.click(primaryButton(dialog));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onUncertain).toHaveBeenCalledTimes(1);
  });

  it('残りを届かないとして終える操作も、答えが分からない時は同じ番号・同じ中身で確かめ直す', async () => {
    const { dialog, onDone } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ data: { returnStatus: 'closed', receiptId: 'receipt-2', replayed: true } }));
    fireEvent.click(within(dialog).getByRole('button', { name: '残りは届かないものとして返品を終える' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を終える' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_RECEIVE);
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(NOTICE_CLOSED_MISSING));
    expect(calledUrls()).toEqual([RETURNS_URL, CLOSE_MISSING_URL, CLOSE_MISSING_URL]);
    expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
  });
});

describe('receiveNoticeOf（受け取りの後の知らせ）', () => {
  const received = (overrides: Partial<ReceiveReturnResponse> = {}): ReceiveDialogResult => ({
    kind: 'received',
    response: {
      receiptId: 'receipt-1', returnStatus: 'open', refundId: null, refundAmount: null, refundStatus: null,
      feeDueAmount: 0, replayed: false,
      ...overrides,
    },
  });

  it('返金が無ければ「受け取りを記録しました。」', () => {
    expect(receiveNoticeOf(received())).toBe(NOTICE_RECORDED);
  });

  it('Stripe が返金を受け付けた時は「…返金を受け付けました。」', () => {
    expect(receiveNoticeOf(received({ refundId: 'refund-1', refundAmount: 24000, refundStatus: 'pending' }))).toBe(NOTICE_ACCEPTED);
  });

  it('返金が済んだ時は「…返金しました。」', () => {
    expect(receiveNoticeOf(received({ refundId: 'refund-1', refundAmount: 24000, refundStatus: 'succeeded' }))).toBe(NOTICE_REFUNDED);
  });

  it('返金なしで記録した時（返金の番号が null・waived）は「受け取りを記録しました。」', () => {
    expect(receiveNoticeOf(received({ refundId: null, refundAmount: 0, refundStatus: 'waived' }))).toBe(NOTICE_RECORDED);
  });

  it('残りを届かないとして終えた時の知らせ', () => {
    expect(
      receiveNoticeOf({ kind: 'closed_missing', response: { returnStatus: 'closed', receiptId: 'receipt-2', replayed: false } }),
    ).toBe(NOTICE_CLOSED_MISSING);
  });
});
