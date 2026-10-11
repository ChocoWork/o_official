import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RefundAcceptedResponse, RefundMaterialLine, RefundMaterials } from '@/lib/orders/refund/refund-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderPaidCancelDialog from '@/components/OrderPaidCancelDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const REFUND_URL = `/api/admin/orders/${ORDER_ID}/refund`;
const CONFIRM_URL = `${REFUND_URL}/confirm`;
const STATUS_URL = `/api/admin/orders/${ORDER_ID}/status`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_OUTCOME = '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
const SUBMIT = '注文をキャンセルして ￥54,800 を返金する';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 在庫の品。2つとも未発送 */
const STOCK_LINE: RefundMaterialLine = {
  orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  itemPrice: 12000, quantity: 2, lineTotal: 24000, shipped: 0, unshipped: 2,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 2,
  lineDiscount: 0, refundedUnits: 0,
};

/** 受注生産の品。1つとも未発送（在庫は確保していない） */
const BACKORDER_LINE: RefundMaterialLine = {
  orderItemId: 'item-backorder', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  itemPrice: 30000, quantity: 1, lineTotal: 30000, shipped: 0, unshipped: 1,
  refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 0,
  lineDiscount: 0, refundedUnits: 0,
};

/** 何も発送していないカードの注文（ブラウス 2・コート 1・送料 800 で 54,800） */
const BASE_ORDER: RefundMaterials['order'] = {
  id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid', paymentMethod: 'card',
  totalAmount: 54800, shippingAmount: 800, discountAmount: 0, paidAmount: 54800,
  succeededAmount: 0, openAmount: 0, refundableAmount: 54800, refundedShipping: 0, refundableShipping: 800,
  shippedTotal: 0, unshippedTotal: 3,
};

type MaterialsOverrides = {
  order?: Partial<RefundMaterials['order']>;
  lines?: RefundMaterialLine[];
  awaitingRefund?: RefundMaterials['awaitingRefund'];
};

function materials({ order = {}, lines = [STOCK_LINE, BACKORDER_LINE], awaitingRefund = null }: MaterialsOverrides = {}): RefundMaterials {
  return { order: { ...BASE_ORDER, ...order }, lines, awaitingRefund };
}

function accepted(overrides: Partial<RefundAcceptedResponse> = {}): RefundAcceptedResponse {
  return { refundId: 'refund-1', status: 'pending', amount: 54800, replayed: false, ...overrides };
}

/** 画面を開き、返金の材料を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(loaded: RefundMaterials = materials()) {
  mockClientFetch.mockResolvedValueOnce(json(loaded));
  const props = { onClose: jest.fn(), onCancelled: jest.fn(), onUncertain: jest.fn() };
  const utils = render(<OrderPaidCancelDialog orderId={ORDER_ID} {...props} />);
  const dialog = await screen.findByRole('dialog', { name: '注文をキャンセルする' });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, ...props, props, dialog };
}

/** n 番目（0 始まり）の呼び出しが窓口へ送った本文 */
function requestBodyOf(callIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const reasonSelect = (dialog: HTMLElement) => within(dialog).getByRole('combobox', { name: '取消の理由' });
const chooseReason = (dialog: HTMLElement, reason: string) =>
  fireEvent.change(reasonSelect(dialog), { target: { value: reason } });
const submitButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: SUBMIT });

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderPaidCancelDialog の材料と入力', () => {
  it('開くと返金の材料を読み、返金する額（全額）・内訳・支払い方法の案内を出す。最初は理由が空で、押せない', async () => {
    const { dialog } = await openDialog();

    expect(mockClientFetch).toHaveBeenCalledWith(REFUND_URL, { cache: 'no-store' });
    expect(within(dialog).getByText('返金する額: ￥54,800（全額）')).toBeInTheDocument();
    const breakdown = within(dialog).getByRole('list', { name: '返金の内訳' });
    expect(within(breakdown).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['商品 ￥54,000', '送料 ￥800']);
    expect(within(dialog).getByText('お金はカード会社によって、5〜10営業日ほどで戻ります。')).toBeInTheDocument();
    expect(reasonSelect(dialog)).toHaveValue('');
    expect(within(dialog).getByRole('textbox', { name: 'メモ（任意・店内のみ）' })).toHaveValue('');
    expect(within(dialog).getByRole('checkbox', { name: 'お客様にキャンセルのお知らせを送る' })).toBeChecked();
    expect(within(dialog).getByText('キャンセルと返金は取り消せません。')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeEnabled();
    expect(submitButton(dialog)).toBeDisabled();
  });

  it('前に一部を返金していれば、その残りの全額と内訳を出す', async () => {
    const { dialog } = await openDialog(
      materials({
        lines: [BACKORDER_LINE],
        order: { succeededAmount: 24800, refundableAmount: 30000, refundableShipping: 0 },
      }),
    );

    expect(within(dialog).getByText('返金する額: ￥30,000（全額）')).toBeInTheDocument();
    const breakdown = within(dialog).getByRole('list', { name: '返金の内訳' });
    expect(within(breakdown).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['商品 ￥30,000', '送料 ￥0']);
    chooseReason(dialog, 'customer_request');
    expect(within(dialog).getByRole('button', { name: '注文をキャンセルして ￥30,000 を返金する' })).toBeEnabled();
  });

  it('返せる額が返せる送料より小さい時は、送料を返せる額までにして内訳を出す（DB が全部を返す時の送料と同じ）', async () => {
    const { dialog } = await openDialog(
      materials({
        lines: [{ ...STOCK_LINE, itemPrice: 500, quantity: 1, lineTotal: 500, unshipped: 1, restockable: 1 }],
        order: {
          totalAmount: 1000, shippingAmount: 500, paidAmount: 1000, succeededAmount: 700,
          refundableAmount: 300, refundableShipping: 500, shippedTotal: 0, unshippedTotal: 1,
        },
      }),
    );

    expect(within(dialog).getByText('返金する額: ￥300（全額）')).toBeInTheDocument();
    const breakdown = within(dialog).getByRole('list', { name: '返金の内訳' });
    expect(within(breakdown).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['商品 ￥0', '送料 ￥300']);
  });

  it('コンビニ払いの注文には、返金先の口座を入れてもらう案内を出す', async () => {
    const { dialog } = await openDialog(materials({ order: { paymentMethod: 'konbini' } }));

    expect(
      within(dialog).getByText(
        'コンビニ払いの返金は、お客様に返金先の口座を入れてもらう必要があります（Stripe からお客様にメールが届きます。45日以内）。',
      ),
    ).toBeInTheDocument();
  });

  it('理由を選ぶまでキャンセルのボタンを押せない。理由は今の4つ', async () => {
    const { dialog } = await openDialog();

    expect(within(reasonSelect(dialog)).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '選んでください',
      '在庫切れ',
      'お客様の依頼',
      '不正の疑い',
      'その他',
    ]);
    expect(submitButton(dialog)).toBeDisabled();

    chooseReason(dialog, 'customer_request');
    expect(submitButton(dialog)).toBeEnabled();
  });

  it('「その他」はメモが要る（空白だけでは足りない）', async () => {
    const { dialog } = await openDialog();

    chooseReason(dialog, 'other');
    expect(submitButton(dialog)).toBeDisabled();
    const memo = within(dialog).getByRole('textbox', { name: 'メモ（必須・店内のみ）' });

    fireEvent.change(memo, { target: { value: '   ' } });
    expect(submitButton(dialog)).toBeDisabled();
    fireEvent.change(memo, { target: { value: '電話で依頼' } });
    expect(submitButton(dialog)).toBeEnabled();
  });

  it('「在庫に戻す」は、未発送の在庫の品がある時に出て、最初から入っている', async () => {
    const { dialog } = await openDialog();

    expect(within(dialog).getByRole('checkbox', { name: '在庫に戻す' })).toBeChecked();
  });

  it('「在庫に戻す」は、受注生産の品だけの注文や、在庫の品が全部返金・発送済みの注文には出さない', async () => {
    const { dialog } = await openDialog(
      materials({
        lines: [BACKORDER_LINE, { ...STOCK_LINE, unshipped: 0, refundedBeforeShipment: 2, restockable: 0 }],
        order: { refundableAmount: 30800 },
      }),
    );

    expect(within(dialog).queryByRole('checkbox', { name: '在庫に戻す' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'お客様にキャンセルのお知らせを送る' })).toBeChecked();
  });

  it('「在庫に戻す」は、在庫に戻せる数が 0 の品（在庫を確保できなかった注文）だけの注文には出さない', async () => {
    const { dialog } = await openDialog(materials({ lines: [{ ...STOCK_LINE, restockable: 0 }, BACKORDER_LINE] }));

    expect(within(dialog).queryByRole('checkbox', { name: '在庫に戻す' })).not.toBeInTheDocument();
  });
});

describe('OrderPaidCancelDialog のキャンセル', () => {
  it('理由・メモ・在庫に戻す・お知らせを、二重防止の番号つきで状態の窓口へ送り、結果を親へ渡す', async () => {
    const { dialog, onCancelled, onClose } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(accepted()));
    chooseReason(dialog, 'stock_unavailable');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（任意・店内のみ）' }), { target: { value: '  在庫を確認した  ' } });
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(accepted()));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, STATUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(1)).toEqual({
      status: 'cancelled',
      requestKey: expect.stringMatching(UUID_PATTERN),
      reason: 'stock_unavailable',
      note: '在庫を確認した',
      restock: true,
      notifyCustomer: true,
    });
    // 閉じるのは親。画面が自分で閉じることはしない
    expect(onClose).not.toHaveBeenCalled();
  });

  it('「在庫に戻す」と「お知らせ」を外すと false で送る。メモが空なら本文に含めない', async () => {
    const { dialog, onCancelled } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(accepted({ status: 'succeeded' })));
    chooseReason(dialog, 'customer_request');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '在庫に戻す' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様にキャンセルのお知らせを送る' }));
    fireEvent.click(submitButton(dialog));

    await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(accepted({ status: 'succeeded' })));
    expect(requestBodyOf(1)).toEqual({
      status: 'cancelled',
      requestKey: expect.stringMatching(UUID_PATTERN),
      reason: 'customer_request',
      restock: false,
      notifyCustomer: false,
    });
    expect(requestBodyOf(1)).not.toHaveProperty('note');
  });

  it('「戻る」では送らずに閉じる（答えが分からない状態ではないので、一覧の読み直しは頼まない）', async () => {
    const { dialog, onClose, onCancelled, onUncertain } = await openDialog();
    chooseReason(dialog, 'customer_request');
    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUncertain).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('送っている間はボタンを押せず、二重に送らない。画面も閉じられない', async () => {
    const { dialog, onCancelled, onClose } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    chooseReason(dialog, 'customer_request');
    fireEvent.click(submitButton(dialog));

    expect(submitButton(dialog)).toBeDisabled();
    expect(reasonSelect(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '戻る' })).toBeDisabled();
    fireEvent.click(submitButton(dialog));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();

    resolvePost(json(accepted()));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
  });

  it('Enter キーでは送らない（選択でも、チェックでも）。メモの欄の Enter は改行のまま', async () => {
    const { dialog } = await openDialog();
    chooseReason(dialog, 'customer_request');

    // preventDefault されている（フォームの送信にならない）
    expect(fireEvent.keyDown(reasonSelect(dialog), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(dialog).getByRole('checkbox', { name: '在庫に戻す' }), { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(dialog).getByRole('textbox', { name: 'メモ（任意・店内のみ）' }), { key: 'Enter' })).toBe(true);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい二重防止の番号にする', async () => {
    const { dialog, onCancelled } = await openDialog();
    const message = '発送した商品がある注文はキャンセルできません。返金の画面を使ってください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'order_not_cancellable' }, 409))
      .mockResolvedValueOnce(json(accepted()));
    chooseReason(dialog, 'customer_request');
    fireEvent.click(submitButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onCancelled).not.toHaveBeenCalled();
    expect(reasonSelect(dialog)).toHaveValue('customer_request');
    expect(submitButton(dialog)).toBeEnabled();

    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});

const UNKNOWN_ANSWERS: Array<[string, () => Promise<unknown>]> = [
  ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
  ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '注文のキャンセルに失敗しました。', code: 'failed' }, 500))],
  [
    'Stripe の返事を確かめられなかった（502）',
    () => Promise.resolve(json({ error: UNKNOWN_OUTCOME, code: 'unknown_outcome', refundId: 'refund-1' }, 502)),
  ],
];

describe('OrderPaidCancelDialog の処理前の断りと再送後の読み直し', () => {
  it('最初の送信が403で処理前に断られても、次の送信は同じ二重防止の番号を使う', async () => {
    const { dialog, onCancelled } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json(accepted()));
    chooseReason(dialog, 'customer_request');
    fireEvent.click(submitButton(dialog));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('この操作の権限がありません。');
    expect(reasonSelect(dialog)).toBeEnabled();
    fireEvent.click(submitButton(dialog));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).toBe(requestBodyOf(1).requestKey);
  });

  it.each([
    [401, '認証が必要です。再ログインしてください。'],
    [403, 'この操作の権限がありません。'],
    [429, '注文のキャンセルに失敗しました。'],
  ])('再送が%iで処理前に断られても結果不明のまま、次も同じ番号・同じ本文で送る', async (status, message) => {
    const { dialog, onCancelled, onUncertain } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'Blocked' }, status))
      .mockResolvedValueOnce(json(accepted({ replayed: true })));
    chooseReason(dialog, 'customer_request');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（任意・店内のみ）' }), { target: { value: '電話で依頼' } });
    fireEvent.click(submitButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(message));
    expect(reasonSelect(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('textbox', { name: 'メモ（任意・店内のみ）' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: SUBMIT })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();
    expect(mockClientFetch).toHaveBeenCalledTimes(3);

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(accepted({ replayed: true })));
    expect(mockClientFetch.mock.calls.slice(1).map(([url, init]) => [url, (init as RequestInit).body])).toEqual([
      [STATUS_URL, (mockClientFetch.mock.calls[1][1] as RequestInit).body],
      [STATUS_URL, (mockClientFetch.mock.calls[1][1] as RequestInit).body],
      [STATUS_URL, (mockClientFetch.mock.calls[1][1] as RequestInit).body],
    ]);
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it('結果不明の再送が403で処理前に断られた後に閉じても、一覧の読み直しを親に頼む', async () => {
    const { dialog, onClose, onUncertain } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    chooseReason(dialog, 'customer_request');
    fireEvent.click(submitButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('この操作の権限がありません。'));

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 409, 422])('再送が%iで断られたら、材料を読み直し、入力を戻して新しい番号で送れる', async (status) => {
    const { dialog, onCancelled } = await openDialog();
    const message = '注文の状態が変わりました。';
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: message }, status))
      .mockResolvedValueOnce(json(materials({ order: { refundableAmount: 10000 } })))
      .mockResolvedValueOnce(json(accepted()));
    chooseReason(dialog, 'customer_request');
    fireEvent.click(submitButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    const submit = await within(dialog).findByRole('button', { name: '注文をキャンセルして ￥10,000 を返金する' });
    await waitFor(() => expect(submit).toBeEnabled());
    expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    expect(mockClientFetch).toHaveBeenNthCalledWith(4, REFUND_URL, { cache: 'no-store' });
    expect(reasonSelect(dialog)).toHaveValue('customer_request');
    fireEvent.click(submit);
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(4).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });

  it('再送が409で断られた後の材料の読み直しが失敗したら、その文を出す', async () => {
    const { dialog, onCancelled } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: '注文の状態が変わりました。' }, 409))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    chooseReason(dialog, 'customer_request');
    fireEvent.click(submitButton(dialog));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('この操作の権限がありません。'));
    expect(mockClientFetch).toHaveBeenNthCalledWith(4, REFUND_URL, { cache: 'no-store' });
    expect(reasonSelect(dialog)).toBeEnabled();
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it('confirmが断られた後の材料の読み直しが失敗したら、その文を出す', async () => {
    const { dialog, onCancelled } = await openDialog(
      materials({ awaitingRefund: { id: 'refund-awaiting', amount: 54800, createdAt: '2026-10-11T01:00:00.000Z' } }),
    );
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Stripe が返金を受け付けませんでした。' }, 422))
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('この操作の権限がありません。'));
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, REFUND_URL, { cache: 'no-store' });
    expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled();
    expect(onCancelled).not.toHaveBeenCalled();
  });
});

describe('OrderPaidCancelDialog の答えが分からない時', () => {
  it.each(UNKNOWN_ANSWERS)(
    '%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ二重防止の番号・同じ中身で確かめ直す',
    async (_label, firstAnswer) => {
      const { dialog, onCancelled, onClose, onUncertain } = await openDialog();
      mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json(accepted({ replayed: true })));
      chooseReason(dialog, 'customer_request');
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'メモ（任意・店内のみ）' }), { target: { value: '電話で依頼' } });
      fireEvent.click(submitButton(dialog));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
      // 入力は変えられない
      expect(reasonSelect(dialog)).toBeDisabled();
      expect(within(dialog).getByRole('textbox', { name: 'メモ（任意・店内のみ）' })).toBeDisabled();
      expect(within(dialog).getByRole('checkbox', { name: '在庫に戻す' })).toBeDisabled();
      expect(within(dialog).getByRole('checkbox', { name: 'お客様にキャンセルのお知らせを送る' })).toBeDisabled();
      // 操作は「もう一度確かめる」と「閉じる」だけ
      expect(within(dialog).queryByRole('button', { name: '戻る' })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: SUBMIT })).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
      await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(accepted({ replayed: true })));
      // 同じ二重防止の番号・同じ中身で送り直す（Stripe が返金を作っていても、DB は前の記録を返し、返金は1件のまま）
      expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
      expect(onClose).not.toHaveBeenCalled();
      expect(onUncertain).not.toHaveBeenCalled();
    },
  );

  it('確かめ直しても分からない時は、そのまま止まる。「閉じる」で閉じる時に、一覧の読み直しを親に頼む', async () => {
    const { dialog, onCancelled, onClose, onUncertain } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    chooseReason(dialog, 'customer_request');
    fireEvent.click(submitButton(dialog));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled());

    expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(onCancelled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onUncertain).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('OrderPaidCancelDialog の材料を読めない時と確かめ中の返金', () => {
  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '返金の材料を読み込めませんでした。'],
  ])('材料を読めなかった時（%i）は理由と「閉じる」だけを出す', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    const onClose = jest.fn();
    render(<OrderPaidCancelDialog orderId={ORDER_ID} onClose={onClose} onCancelled={jest.fn()} onUncertain={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '注文をキャンセルする' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['閉じる']);
    expect(within(dialog).queryByRole('combobox', { name: '取消の理由' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('確かめ中の返金がある注文は、入力を出さず、文と「もう一度確かめる」「閉じる」だけを出す。確かめ直しの窓口へ記録の番号を送る', async () => {
    const { dialog, onCancelled } = await openDialog(
      materials({ awaitingRefund: { id: 'refund-awaiting', amount: 54800, createdAt: '2026-10-11T01:00:00.000Z' } }),
    );

    expect(within(dialog).getByText('確かめ中の返金があります（￥54,800）。')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: '取消の理由' })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(['閉じる', 'もう一度確かめる']);

    mockClientFetch.mockResolvedValueOnce(json(accepted({ refundId: 'refund-awaiting', replayed: true })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    await waitFor(() => expect(onCancelled).toHaveBeenCalledWith(accepted({ refundId: 'refund-awaiting', replayed: true })));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, CONFIRM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refundId: 'refund-awaiting' }),
    });
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('orderId が null の間は閉じていて、窓口を読まない', () => {
    render(<OrderPaidCancelDialog orderId={null} onClose={jest.fn()} onCancelled={jest.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockClientFetch).not.toHaveBeenCalled();
  });
});
