import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { dialogButtons, footerCloseButton } from './dialog-test-helpers';
import type { OrderReturnDetail, OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import {
  OrderReturnCancelDialog,
  OrderReturnFeePaymentDialog,
  OrderReturnInspectDialog,
  OrderReturnReleaseExchangeDialog,
  OrderReturnReopenDialog,
} from '@/components/OrderReturnActionDialogs';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'ret-0001';
const LABEL = 'ORD-A1B2C3D4-R1';
const RETURNS_URL = `/api/admin/orders/${ORDER_ID}/returns`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_ACTION = '操作の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
/** 回数の制限（429）で処理の前に断られた時の文（E-2 の返金の画面と同じ） */
const RATE_LIMITED = '操作が続いたため受け付けませんでした。しばらく待ってから、もう一度お試しください。';

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

/** 2点とも検品待ちの品 */
const BLOUSE: OrderReturnLineDetail = {
  id: 'line-blouse', fulfillmentId: 'ful-1', fulfillmentNumber: 1, orderItemId: 'item-blouse',
  itemName: 'シルクブラウス', color: '白', size: 'M', quantity: 2, reason: 'size_too_small', reasonNote: null,
  resolution: 'refund', exchange: null,
  progress: progress({ pendingInspection: 2, processed: 2 }),
  refundAmountsByCount: [], refundWaitingAmount: 0, customerNote: null, requestedResolution: null, requestedExchange: null, photos: [], returnIneligible: false,
};

/** 1点が検品待ちの品。サイズが無い */
const BELT: OrderReturnLineDetail = {
  ...BLOUSE,
  id: 'line-belt', orderItemId: 'item-belt', itemName: 'レザーベルト', color: '茶', size: null, quantity: 1,
  progress: progress({ pendingInspection: 1, processed: 1 }),
};

function returnDetail(overrides: Partial<OrderReturnDetail> = {}): OrderReturnDetail {
  return {
    id: RETURN_ID, number: 1, label: LABEL, status: 'open', source: 'shop',
    displayStatus: 'in_progress', marks: [],
    returnMethod: 'customer_ships', returnShippingPayer: 'customer', returnCarrier: null, returnTrackingNumber: null,
    fees: {
      returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 0, exchangeShippingFee: 0,
      feeDueAmount: 0, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
    },
    firstReceiptDone: false, firstExchangeReceiptDone: false,
    shopNote: null, notifyCustomer: true, createdAt: '2026-10-12T01:00:00.000Z', createdByEmail: 'admin@example.com',
    closedAt: null, cancelledAt: null, requestedAt: null, approvedAt: null, approvedByEmail: null, declinedAt: null, declineReason: null, declineMessage: null,
    lines: [BLOUSE, BELT], refunds: [], receipts: [], exchangeItems: [],
    ...overrides,
  };
}

/** 注文の返品の窓口（GET）の答え。操作の画面はこれを読んで、returnId の返品を探す（C-3） */
function returnsAnswer(detail: OrderReturnDetail) {
  return json({
    data: { returns: [detail], canRefund: true, returnableUnits: 0, refundableAmount: 54800, refundableShipping: 800 },
  });
}

/** 5つの画面は同じ props を受ける */
type ActionDialog = typeof OrderReturnCancelDialog;

/** 画面を開き、返品の中身を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(Dialog: ActionDialog, title: string, detail: OrderReturnDetail = returnDetail()) {
  mockClientFetch.mockResolvedValueOnce(returnsAnswer(detail));
  const props = { onClose: jest.fn(), onDone: jest.fn(), onUncertain: jest.fn() };
  const utils = render(<Dialog orderId={ORDER_ID} returnId={RETURN_ID} {...props} />);
  await waitFor(() => expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument());
  const dialog = screen.getByRole('dialog', { name: title });
  return { ...utils, ...props, props, dialog };
}

/** n 番目（0 始まり）の送信の本文。呼び出しの最初は返品の読み込み（GET）なので、1つ後ろを読む */
function requestBodyOf(sendIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[sendIndex + 1][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const url = (path: string) => `/api/admin/returns/${RETURN_ID}/${path}`;
/** これまでに窓口を呼んだ URL（最初は返品の読み込み） */
const calledUrls = () => mockClientFetch.mock.calls.map(([called]) => called);

beforeEach(() => {
  mockClientFetch.mockReset();
});

/** [名前, 部品, 読み込み中の題, 読み終えた後の題]。検品の画面だけ、読み終えた後の題に返品の番号が付く */
const DIALOGS: Array<[string, ActionDialog, string, string]> = [
  ['OrderReturnInspectDialog', OrderReturnInspectDialog, '検品を終える', `検品を終える（${LABEL}）`],
  ['OrderReturnCancelDialog', OrderReturnCancelDialog, '返品を取り消す', '返品を取り消す'],
  ['OrderReturnReopenDialog', OrderReturnReopenDialog, '返品を開き直す', '返品を開き直す'],
  ['OrderReturnFeePaymentDialog', OrderReturnFeePaymentDialog, '手数料の受け取りを記録する', '手数料の受け取りを記録する'],
  ['OrderReturnReleaseExchangeDialog', OrderReturnReleaseExchangeDialog, '支払いを待たずに送る', '支払いを待たずに送る'],
];

describe('5つの画面に共通の読み込み', () => {
  it.each(DIALOGS)('%s: 開くと注文の返品の窓口を読み、読み終えるまでは「読み込み中です...」と「閉じる」だけを出す', async (_name, Dialog, title) => {
    let resolveGet: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveGet = resolve; }));
    render(<Dialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);

    const loading = screen.getByRole('dialog', { name: title });
    expect(within(loading).getByText('読み込み中です...')).toBeInTheDocument();
    expect(dialogButtons(loading).map((button) => button.textContent)).toEqual(['閉じる']);
    expect(mockClientFetch).toHaveBeenCalledWith(RETURNS_URL, { cache: 'no-store' });

    resolveGet(returnsAnswer(returnDetail()));
    await waitFor(() => expect(screen.queryByText('読み込み中です...')).not.toBeInTheDocument());
  });

  it.each(DIALOGS)('%s: 返品を読めなかった時は理由と「閉じる」だけを出す。閉じても一覧の読み直しは頼まない', async (_name, Dialog, title) => {
    mockClientFetch.mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500));
    const onClose = jest.fn();
    const onUncertain = jest.fn();
    render(<Dialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={onClose} onDone={jest.fn()} onUncertain={onUncertain} />);

    const dialog = await screen.findByRole('dialog', { name: title });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返品の情報を読み込めませんでした。');
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる']);

    fireEvent.click(footerCloseButton(dialog));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it.each(DIALOGS)('%s: 窓口の答えの中に開こうとした返品が無い時は、見つからない旨と「閉じる」だけを出す', async (_name, Dialog, title) => {
    mockClientFetch.mockResolvedValueOnce(returnsAnswer(returnDetail({ id: 'ret-other' })));
    render(<Dialog orderId={ORDER_ID} returnId={RETURN_ID} onClose={jest.fn()} onDone={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: title });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返品が見つかりません。');
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる']);
  });

  it.each(DIALOGS)('%s: スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async (_name, Dialog, _loadingTitle, title) => {
    const { dialog } = await openDialog(Dialog, title);

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });
});

describe('OrderReturnCancelDialog（返品の取消）', () => {
  const TITLE = '返品を取り消す';

  it('文とボタンを出す。押すと取消の窓口へ本文なしの中身を送り、知らせなしで親へ渡す。閉じるのは親', async () => {
    const { dialog, onDone, onClose } = await openDialog(OrderReturnCancelDialog, TITLE);
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnStatus: 'cancelled' } }));
    expect(
      within(dialog).getByText('この返品を取り消します。品はまた返品できるようになります。お客様にメールは送りません。'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith());
    expect(mockClientFetch).toHaveBeenCalledWith(url('cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({});
    expect(onClose).not.toHaveBeenCalled();
  });

  it('「戻る」では送らずに閉じる（送信を試みていないので、一覧の読み直しは頼まない）', async () => {
    const { dialog, onClose, onDone, onUncertain } = await openDialog(OrderReturnCancelDialog, TITLE);

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(calledUrls()).toEqual([RETURNS_URL]);
  });

  it('窓口が断ったら、その文を画面の中に出す。送り直せて、閉じる時は一覧の読み直しを親に頼む', async () => {
    const { dialog, onDone, onClose, onUncertain } = await openDialog(OrderReturnCancelDialog, TITLE);
    const message = '返品の状態が変わりました。画面を開き直してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'RETURN_STATE_CONFLICT' }, 409))
      .mockResolvedValueOnce(json({ data: { returnStatus: 'cancelled' } }));

    fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('権限が無い時は固定の文、回数の制限（英語の短い文）は回数の制限の固定の文を出す', async () => {
    const { dialog } = await openDialog(OrderReturnCancelDialog, TITLE);
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));

    fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));
    expect(await within(dialog).findByText('この操作の権限がありません。')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));

    expect(await within(dialog).findByText(RATE_LIMITED)).toBeInTheDocument();
    expect(within(dialog).queryByText('Too many requests')).not.toBeInTheDocument();
  });

  it('送っている間は押せず、二重に送らない。閉じることもできない', async () => {
    const { dialog, onClose, onDone } = await openDialog(OrderReturnCancelDialog, TITLE);
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));

    expect(within(dialog).getByRole('button', { name: '返品を取り消す' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));
    expect(calledUrls()).toEqual([RETURNS_URL, url('cancel')]);
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    resolvePost(json({ data: { returnStatus: 'cancelled' } }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '入力を確かめてください。' }, 500))],
    ['成功なのに答えの形が読めない（200）', () => Promise.resolve(json({ data: {} }))],
  ] as Array<[string, () => Promise<unknown>]>)(
    '%s時は、「もう一度確かめる」と「閉じる」だけを出し、同じ中身で確かめ直す',
    async (_label, firstAnswer) => {
      const { dialog, onDone, onClose, onUncertain } = await openDialog(OrderReturnCancelDialog, TITLE);
      mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json({ data: { returnStatus: 'cancelled' } }));
      fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_ACTION);
      expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);

      fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
      expect(onClose).not.toHaveBeenCalled();
      expect(onUncertain).not.toHaveBeenCalled();
    },
  );

  it('答えが分からないまま「閉じる」で閉じる時は、一覧の読み直しを親に頼む', async () => {
    const { dialog, onClose, onUncertain } = await openDialog(OrderReturnCancelDialog, TITLE);
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(footerCloseButton(dialog));

    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
it('答えが分からない後の確かめ直しが 409（前の取消が通っていた）なら、その文を出し、閉じる時に一覧の読み直しを親に頼む', async () => {
  const { dialog, onDone, onClose, onUncertain } = await openDialog(OrderReturnCancelDialog, TITLE);
  const message = '返品の状態が変わりました。画面を開き直してください。';
  mockClientFetch
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(json({ error: message, code: 'RETURN_STATE_CONFLICT' }, 409));
  fireEvent.click(within(dialog).getByRole('button', { name: '返品を取り消す' }));
  fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

  await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(message));
  expect(within(dialog).getByRole('alert')).not.toHaveTextContent(UNKNOWN_ACTION);
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));
  expect(onUncertain).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});
});

describe('OrderReturnReopenDialog（返品の開き直し）', () => {
  const TITLE = '返品を開き直す';
  const missingDetail = () =>
    returnDetail({
      status: 'closed',
      lines: [
        { ...BLOUSE, progress: progress({ restocked: 1, missing: 1, processed: 2 }) },
        { ...BELT, progress: progress({ missing: 1, processed: 1 }) },
      ],
    });

  it('「届かない」として終えた点数を出し、押すと二重防止の番号つきで送る', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnReopenDialog, TITLE, missingDetail());
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnStatus: 'open', receiptId: 'receipt-3', replayed: false } }));
    expect(within(dialog).getByText('「届かない」として終えた 2 点を、また受け取れるようにします。')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '開き直す' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith());
    expect(mockClientFetch).toHaveBeenCalledWith(url('reopen'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({ requestKey: expect.stringMatching(UUID_PATTERN) });
  });

  it('答えが分からない時は、同じ二重防止の番号で確かめ直す', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnReopenDialog, TITLE, missingDetail());
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ data: { returnStatus: 'open', receiptId: 'receipt-3', replayed: true } }));
    fireEvent.click(within(dialog).getByRole('button', { name: '開き直す' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_ACTION);

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
  });

  it('処理の中で断られたら、次の送信は新しい二重防止の番号にする。処理の前に断られた時（403）は同じ番号', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnReopenDialog, TITLE, missingDetail());
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: '返品の状態が変わりました。画面を開き直してください。', code: 'RETURN_STATE_CONFLICT' }, 409))
      .mockResolvedValueOnce(json({ data: { returnStatus: 'open' } }));

    fireEvent.click(within(dialog).getByRole('button', { name: '開き直す' }));
    expect(await within(dialog).findByText('この操作の権限がありません。')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '開き直す' }));
    expect(await within(dialog).findByText('返品の状態が変わりました。画面を開き直してください。')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '開き直す' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).requestKey).toBe(requestBodyOf(0).requestKey);
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(0).requestKey);
  });
});

describe('OrderReturnInspectDialog（検品を終える）', () => {
  const TITLE = `検品を終える（${LABEL}）`;
  const rowsOf = (dialog: HTMLElement) => within(within(dialog).getByRole('list', { name: '検品待ちの品' })).getAllByRole('listitem');
  const decide = (dialog: HTMLElement, index: number, value: string) =>
    fireEvent.change(within(rowsOf(dialog)[index]).getByRole('combobox', { name: '品の状態' }), { target: { value } });

  it('検品待ちの品を1点ずつ並べ、状態は「選択してください」から始まる。全部決めるまで押せない', async () => {
    const { dialog } = await openDialog(OrderReturnInspectDialog, TITLE);

    const rows = rowsOf(dialog);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('シルクブラウス（白 / M）')).toBeInTheDocument();
    expect(within(rows[2]).getByText('レザーベルト（茶）')).toBeInTheDocument();
    const select = within(rows[0]).getByRole('combobox', { name: '品の状態' });
    expect(select).toHaveValue('');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '選択してください',
      '在庫に戻す',
      '戻さない',
    ]);
    const button = within(dialog).getByRole('button', { name: '検品を終える' });
    expect(button).toBeDisabled();

    decide(dialog, 0, 'restocked');
    decide(dialog, 1, 'not_restocked');
    expect(button).toBeDisabled();
    decide(dialog, 2, 'restocked');
    expect(button).toBeEnabled();
  });

  it('返品の行ごとに、戻す数と戻さない数をまとめて、二重防止の番号つきで送る', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnInspectDialog, TITLE);
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnStatus: 'closed', receiptId: 'receipt-4', replayed: false } }));
    decide(dialog, 0, 'restocked');
    decide(dialog, 1, 'not_restocked');
    decide(dialog, 2, 'restocked');

    fireEvent.click(within(dialog).getByRole('button', { name: '検品を終える' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith());
    expect(mockClientFetch).toHaveBeenCalledWith(url('inspect'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [
        { returnLineId: 'line-blouse', restocked: 1, notRestocked: 1 },
        { returnLineId: 'line-belt', restocked: 1, notRestocked: 0 },
      ],
    });
  });

  it('検品待ちの品が無い返品は、押せない', async () => {
    const { dialog } = await openDialog(
      OrderReturnInspectDialog,
      TITLE,
      returnDetail({ lines: [{ ...BLOUSE, progress: progress({ restocked: 2, processed: 2 }) }] }),
    );

    expect(within(dialog).getByRole('button', { name: '検品を終える' })).toBeDisabled();
  });

  it('768px 以上では、検品待ちの品の入れ物だけを縦に動かす（品が多くても確定のボタンに届く。T10-14）', async () => {
    const { dialog } = await openDialog(OrderReturnInspectDialog, TITLE);

    const scroller = within(dialog).getByRole('list', { name: '検品待ちの品' }).parentElement;
    expect(scroller).toHaveClass('md:max-h-[60vh]', 'md:overflow-y-auto');
  });

  it('答えが分からない時は、入力を止めて、同じ二重防止の番号・同じ中身で確かめ直す', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnInspectDialog, TITLE);
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ data: { returnStatus: 'closed', receiptId: 'receipt-4', replayed: true } }));
    decide(dialog, 0, 'restocked');
    decide(dialog, 1, 'restocked');
    decide(dialog, 2, 'not_restocked');
    fireEvent.click(within(dialog).getByRole('button', { name: '検品を終える' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_ACTION);
    expect(within(rowsOf(dialog)[0]).getByRole('combobox', { name: '品の状態' })).toBeDisabled();
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
  });
});

describe('OrderReturnFeePaymentDialog（手数料の受け取りを記録する）', () => {
  const TITLE = '手数料の受け取りを記録する';
  const feeDetail = () =>
    returnDetail({
      fees: {
        returnShippingFee: 0, restockingFeePercent: 0, exchangeFee: 2000, exchangeShippingFee: 400,
        feeDueAmount: 2400, feePendingDeduction: 0, feeReceivedAt: null, exchangeReleasedAt: null,
      },
    });

  it('いただく額とメモの欄を出し、「受け取りを記録する」を押すと、メモ（前後の空白を除く）と waive: false を送る。知らせは無い', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnFeePaymentDialog, TITLE, feeDetail());
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnStatus: 'open' } }));
    expect(within(dialog).getByText('いただく額: ￥2,400')).toBeInTheDocument();
    const memo = within(dialog).getByRole('textbox', { name: '受け取りの方法のメモ（お客様には見えません）' });
    expect(memo).toHaveValue('');
    expect(memo).toHaveAttribute('maxlength', '500');
    fireEvent.change(memo, { target: { value: '  店頭で現金で受け取った  ' } });

    fireEvent.click(within(dialog).getByRole('button', { name: '受け取りを記録する' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith());
    expect(mockClientFetch).toHaveBeenCalledWith(url('fee-payment'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({ note: '店頭で現金で受け取った', waive: false });
  });

  it('メモが空なら null を送る（受け取りの記録は waive: false）', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnFeePaymentDialog, TITLE, feeDetail());
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnStatus: 'closed' } }));

    fireEvent.click(within(dialog).getByRole('button', { name: '受け取りを記録する' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith());
    expect(requestBodyOf(0)).toEqual({ note: null, waive: false });
  });

  it('答えが分からない時は、入力を止めて、同じ中身で確かめ直す', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnFeePaymentDialog, TITLE, feeDetail());
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ data: { returnStatus: 'closed' } }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: '受け取りの方法のメモ（お客様には見えません）' }), {
      target: { value: '店頭で現金' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '受け取りを記録する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_ACTION);
    expect(within(dialog).getByRole('textbox', { name: '受け取りの方法のメモ（お客様には見えません）' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
  });

  it('ボタンは、見た目の上から「受け取りを記録する」「いただかないで終える」「戻る」の順（入れ物が縦の逆順なので、並びの順は逆）', async () => {
    const { dialog } = await openDialog(OrderReturnFeePaymentDialog, TITLE, feeDetail());

    const buttons = dialogButtons(dialog);
    expect(buttons.map((button) => button.textContent)).toEqual(['戻る', 'いただかないで終える', '受け取りを記録する']);
    // 3つとも同じ入れ物（縦の逆順）の中にあるので、見た目は C-5 の順になる。フォームの送信は確定だけ
    const container = buttons[0].parentElement as HTMLElement;
    expect(container).toHaveClass('flex-col-reverse');
    expect(buttons.every((button) => button.parentElement === container)).toBe(true);
    expect(buttons.map((button) => button.getAttribute('type'))).toEqual(['button', 'button', 'submit']);
    expect(buttons.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('「いただかないで終える」を押すと、メモ（前後の空白を除く）と waive: true を送り、知らせ「手数料をいただかないことにしました。」を親へ渡す', async () => {
    const { dialog, onDone, onClose } = await openDialog(OrderReturnFeePaymentDialog, TITLE, feeDetail());
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnStatus: 'closed' } }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: '受け取りの方法のメモ（お客様には見えません）' }), {
      target: { value: '  お客様と相談して、いただかないことにした  ' },
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'いただかないで終える' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('手数料をいただかないことにしました。'));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledWith(url('fee-payment'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({ note: 'お客様と相談して、いただかないことにした', waive: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('「いただかないで終える」の答えが分からない時は、入力を止めて、同じ中身（waive: true）と同じ知らせで確かめ直す', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnFeePaymentDialog, TITLE, feeDetail());
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ data: { returnStatus: 'closed' } }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'いただかないで終える' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_ACTION);
    // 確かめ直す間は、別の操作に替えて送らせない（「いただかないで終える」も「受け取りを記録する」も出さない）
    expect(dialogButtons(dialog).map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('手数料をいただかないことにしました。'));
    expect(requestBodyOf(1)).toEqual(requestBodyOf(0));
    expect(requestBodyOf(1)).toEqual({ note: null, waive: true });
  });
});

describe('OrderReturnReleaseExchangeDialog（支払いを待たずに送る）', () => {
  const TITLE = '支払いを待たずに送る';

  it('文とボタンを出す。押すと本文なしの中身を送り、知らせなしで親へ渡す', async () => {
    const { dialog, onDone } = await openDialog(OrderReturnReleaseExchangeDialog, TITLE);
    mockClientFetch.mockResolvedValueOnce(json({ data: { returnStatus: 'open' } }));
    expect(
      within(dialog).getByText('手数料のお支払いを待たずに、交換の品を送れるようにします。手数料はお支払い待ちのまま残ります。'),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '支払いを待たずに送る' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith());
    expect(mockClientFetch).toHaveBeenCalledWith(url('release-exchange'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(0)).toEqual({});
  });

  it('窓口が断ったら、その文を画面の中に出す', async () => {
    const { dialog } = await openDialog(OrderReturnReleaseExchangeDialog, TITLE);
    const message = '返品の状態が変わりました。画面を開き直してください。';
    mockClientFetch.mockResolvedValueOnce(json({ error: message, code: 'RETURN_STATE_CONFLICT' }, 409));

    fireEvent.click(within(dialog).getByRole('button', { name: '支払いを待たずに送る' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
  });
});
