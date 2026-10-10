import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  CreateFulfillmentResponse,
  FulfillmentMaterialLine,
  FulfillmentMaterials,
} from '@/lib/orders/fulfillment/fulfillment-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderShipDialog from '@/components/OrderShipDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENTS_URL = `/api/admin/orders/${ORDER_ID}/fulfillments`;
const COMPLETIONS_URL = `/api/admin/orders/${ORDER_ID}/completions`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_OUTCOME = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 在庫の品。2つとも発送準備中 */
const STOCK_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  quantity: 2, shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
};

/** 受注生産の品。1つとも受注生産中（まだ仕上がっていない） */
const BACKORDER_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-backorder', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  quantity: 1, shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
};

/** 仕上がりを記録した後の受注生産の品 */
const BACKORDER_READY_LINE: FulfillmentMaterialLine = { ...BACKORDER_LINE, inProduction: 0, readyUnshipped: 1 };

function materials(overrides: Partial<FulfillmentMaterials> = {}): FulfillmentMaterials {
  return {
    order: {
      id: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      status: 'paid',
      progress: { key: 'in_production', label: '受注生産中', partiallyShipped: false },
    },
    blockedReason: null,
    lines: [STOCK_LINE, BACKORDER_LINE],
    fulfillments: [],
    ...overrides,
  };
}

function shipped(overrides: Partial<CreateFulfillmentResponse> = {}): CreateFulfillmentResponse {
  return { fulfillmentId: 'fulfillment-1', number: 1, completesOrder: false, orderStatus: 'paid', replayed: false, ...overrides };
}

/** 画面を開き、発送の材料を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(loaded: FulfillmentMaterials = materials()) {
  mockClientFetch.mockResolvedValueOnce(json(loaded));
  const onClose = jest.fn();
  const onShipped = jest.fn();
  const utils = render(<OrderShipDialog orderId={ORDER_ID} onClose={onClose} onShipped={onShipped} />);
  const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, dialog, onClose, onShipped };
}

/** n 番目（0 始まり）の呼び出しが窓口へ送った本文 */
function requestBodyOf(callIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function typeTracking(dialog: HTMLElement, value = '1234-5678') {
  fireEvent.change(within(dialog).getByLabelText('追跡番号'), { target: { value } });
}

/** 商品の行の「今回送る数」の入力。行ごとに同じ名前の入力があるので、行の中で探す（既定は在庫のブラウス） */
function shipQuantityInput(dialog: HTMLElement, groupName = 'シルクブラウス（白 / M）') {
  return within(within(dialog).getByRole('group', { name: groupName })).getByLabelText('今回送る数');
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderShipDialog の材料と最初の数', () => {
  it('開くと発送の材料を読み、商品ごとに印・発送準備中の数・今回送る数を出す（受注生産中の品は送る数に入らない）', async () => {
    const { dialog } = await openDialog();

    expect(mockClientFetch).toHaveBeenCalledWith(FULFILLMENTS_URL, { cache: 'no-store' });
    const stock = within(dialog).getByRole('group', { name: 'シルクブラウス（白 / M）' });
    expect(within(stock).getByText('在庫')).toBeInTheDocument();
    expect(within(stock).getByText('発送準備中')).toBeInTheDocument();
    expect(within(stock).getByLabelText('今回送る数')).toHaveValue(2);
    expect(within(stock).queryByLabelText('仕上がった数')).not.toBeInTheDocument();

    const backorder = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(backorder).getByText('受注生産')).toBeInTheDocument();
    expect(within(backorder).getByText('受注生産中 1')).toBeInTheDocument();
    expect(within(backorder).getByLabelText('今回送る数')).toHaveValue(0);
    expect(within(backorder).getByLabelText('今回送る数')).toBeDisabled();
    expect(within(backorder).getByLabelText('仕上がった数')).toHaveValue(0);
    expect(within(dialog).getByText('今回送る数の合計: 2点')).toBeInTheDocument();
  });

  it('在庫の品だけの注文は、発送準備中の全部が最初から入り、合計に足される', async () => {
    const pants: FulfillmentMaterialLine = {
      ...STOCK_LINE, orderItemId: 'item-pants', name: 'ウールパンツ', color: null, size: '2', quantity: 3, readyUnshipped: 3, unshipped: 3,
    };
    const { dialog } = await openDialog(materials({ lines: [STOCK_LINE, pants] }));

    expect(shipQuantityInput(dialog)).toHaveValue(2);
    expect(shipQuantityInput(dialog, 'ウールパンツ（2）')).toHaveValue(3);
    expect(within(dialog).getByText('今回送る数の合計: 5点')).toBeInTheDocument();
    expect(within(dialog).queryByText(/^受注生産中/)).not.toBeInTheDocument();
  });

  it('仕上がりを記録済みの受注生産の品と、一部を送った品は、発送準備中の数が最初から入る', async () => {
    const partlyShipped: FulfillmentMaterialLine = {
      ...BACKORDER_LINE, quantity: 3, shipped: 1, inProduction: 0, readyUnshipped: 2, unshipped: 2,
    };
    const { dialog } = await openDialog(materials({ lines: [partlyShipped] }));

    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(row).getByLabelText('今回送る数')).toHaveValue(2);
    expect(within(row).getByLabelText('今回送る数')).toBeEnabled();
    expect(within(row).queryByLabelText('仕上がった数')).not.toBeInTheDocument();
  });

  it('もう全部送った商品は並べない', async () => {
    const done: FulfillmentMaterialLine = { ...STOCK_LINE, orderItemId: 'item-done', name: '送り済みのシャツ', shipped: 2, readyUnshipped: 0, unshipped: 0 };
    const { dialog } = await openDialog(materials({ lines: [STOCK_LINE, done] }));

    expect(within(dialog).queryByRole('group', { name: /送り済みのシャツ/ })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('group')).toHaveLength(1);
  });

  it('今回送る数を変えると合計が変わり、発送準備中の数を超える数と負の数は収める', async () => {
    const { dialog } = await openDialog();
    const input = shipQuantityInput(dialog);

    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue(1);
    expect(within(dialog).getByText('今回送る数の合計: 1点')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '9' } });
    expect(input).toHaveValue(2);

    fireEvent.change(input, { target: { value: '-4' } });
    expect(input).toHaveValue(0);
    expect(within(dialog).getByText('今回送る数の合計: 0点')).toBeInTheDocument();
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('閉じて開き直すと、材料を読み直し、配送業者・追跡番号・メールの入力は既定（ヤマト・空・送る）へ戻り、誤りの文も消える', async () => {
    const { rerender, dialog } = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('配送業者'), { target: { value: 'japanpost' } });
    typeTracking(dialog, '12 34');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'お客様に発送のメールを送る' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();

    rerender(<OrderShipDialog orderId={null} onClose={jest.fn()} onShipped={jest.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mockClientFetch.mockResolvedValueOnce(json(materials()));
    rerender(<OrderShipDialog orderId={ORDER_ID} onClose={jest.fn()} onShipped={jest.fn()} />);
    const reopened = await screen.findByRole('dialog', { name: '発送済みにする' });
    await waitFor(() => expect(within(reopened).queryByText('読み込み中です...')).not.toBeInTheDocument());

    expect(mockClientFetch).toHaveBeenCalledTimes(2);
    expect(within(reopened).getByLabelText('配送業者')).toHaveValue('yamato');
    expect(within(reopened).getByLabelText('追跡番号')).toHaveValue('');
    expect(within(reopened).getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeChecked();
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('OrderShipDialog の発送', () => {
  it('発送すると、重複防止キー・配送業者・追跡番号・メール・送る商品を窓口へ送り、結果を親へ渡す', async () => {
    const { dialog, onShipped } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(shipped()));
    fireEvent.change(within(dialog).getByLabelText('配送業者'), { target: { value: 'sagawa' } });
    typeTracking(dialog, ' 1234-5678 ');
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(onShipped).toHaveBeenCalledWith(shipped()));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, FULFILLMENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    // 送る数が 0 の受注生産の品は含めない
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      carrier: 'sagawa',
      trackingNumber: '1234-5678',
      notifyCustomer: true,
      lines: [{ orderItemId: 'item-stock', quantity: 2 }],
    });
  });

  it('「お客様に発送のメールを送る」は最初から入っていて、外すと「送らない」で発送する', async () => {
    const { dialog, onShipped } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(shipped()));
    const checkbox = within(dialog).getByRole('checkbox', { name: 'お客様に発送のメールを送る' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1)).toMatchObject({ carrier: 'yamato', notifyCustomer: false });
  });

  it('一部だけ送る時は、入れた数の商品だけを送る', async () => {
    const { dialog, onShipped } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json(shipped()));
    fireEvent.change(shipQuantityInput(dialog), { target: { value: '1' } });
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).lines).toEqual([{ orderItemId: 'item-stock', quantity: 1 }]);
  });

  it('今回送る数の合計が 0 なら、理由を画面の中に出して送らない', async () => {
    const { dialog, onShipped } = await openDialog();
    fireEvent.change(shipQuantityInput(dialog), { target: { value: '0' } });
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('送る数を入れてください。');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onShipped).not.toHaveBeenCalled();
  });

  it('追跡番号の形が違えば、画面の中で知らせて送らない', async () => {
    const { dialog, onShipped } = await openDialog();
    typeTracking(dialog, '12 34');
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('追跡番号は英数字とハイフンで入力してください。');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onShipped).not.toHaveBeenCalled();
  });

  it('追跡番号の欄は数字キーパッドに限らない（英字も打てる）', async () => {
    const { dialog } = await openDialog();

    expect(within(dialog).getByLabelText('追跡番号')).not.toHaveAttribute('inputmode');
  });

  it('「キャンセル」では送らずに閉じる', async () => {
    const { dialog, onClose, onShipped } = await openDialog();
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onShipped).not.toHaveBeenCalled();
  });

  it('送っている間は発送のボタンを押せず、二重に送らない', async () => {
    const { dialog, onShipped } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeDisabled();
    expect(within(dialog).getByLabelText('追跡番号')).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    resolvePost(json(shipped()));
    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
  });
});

describe('OrderShipDialog の窓口の断り', () => {
  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい重複防止キーにする', async () => {
    const { dialog, onShipped } = await openDialog();
    const message = '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'quantity_exceeds_ready' }, 409))
      .mockResolvedValueOnce(json(shipped()));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onShipped).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('追跡番号')).toHaveValue('1234-5678');
    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('権限が無い・認証が切れた時は固定の文、回数の制限（英語の短い文）は代わりの文を出す', async () => {
    const { dialog } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ error: 'Too many requests' }, 429));
    typeTracking(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    expect(await within(dialog).findByText('この操作の権限がありません。')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    expect(await within(dialog).findByText('発送の記録に失敗しました。')).toBeInTheDocument();
    expect(within(dialog).queryByText('Too many requests')).not.toBeInTheDocument();
  });
});

describe('OrderShipDialog の答えが分からない時', () => {
  it.each([
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '発送の記録に失敗しました。', code: 'failed' }, 500))],
  ])('%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ重複防止キーで確かめ直す', async (_label, firstAnswer) => {
    const { dialog, onShipped, onClose } = await openDialog();
    mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json(shipped({ replayed: true })));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    // 入力は変えられない
    expect(within(dialog).getByLabelText('追跡番号')).toBeDisabled();
    expect(within(dialog).getByLabelText('配送業者')).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'お客様に発送のメールを送る' })).toBeDisabled();
    expect(shipQuantityInput(dialog)).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '仕上がりを記録' })).toBeDisabled();
    // 操作は「もう一度確かめる」と「閉じる」だけ
    expect(within(dialog).queryByRole('button', { name: '発送する' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onShipped).toHaveBeenCalledWith(shipped({ replayed: true })));
    // 同じ重複防止キー・同じ中身で送り直す（サーバーが記録していても、二重にならない）
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('確かめ直しても分からない時は、そのまま止まる。「閉じる」で閉じる', async () => {
    const { dialog, onShipped, onClose } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'もう一度確かめる' })).toBeEnabled());

    expect(within(dialog).getByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(onShipped).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('確かめ直した答えが窓口の断りなら、その文を出して入力を戻し、新しい重複防止キーで送れる', async () => {
    const { dialog, onShipped } = await openDialog();
    const message = '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。';
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ error: message, code: 'quantity_exceeds_ready' }, 409))
      .mockResolvedValueOnce(json(shipped()));
    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('追跡番号')).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(3).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });
});

describe('OrderShipDialog の発送できない注文と読み込み', () => {
  it.each([
    ['not_shippable', '発送できる状態ではありません。一覧を更新してください。'],
    ['address_incomplete', '配送先の必須項目が足りないため発送できません。'],
    ['payment_review_required', '支払額の確認（要対応）が済むまで発送できません。'],
  ] as const)('発送できない理由 %s は画面の中に出し、発送を押せなくする', async (blockedReason, message) => {
    const { dialog } = await openDialog(materials({ blockedReason }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeDisabled();
    expect(within(dialog).getByLabelText('追跡番号')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeEnabled();
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '発送の材料を読み込めませんでした。'],
  ])('材料を読めなかった時（%i）は理由を出し、発送を押せなくする', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    render(<OrderShipDialog orderId={ORDER_ID} onClose={jest.fn()} onShipped={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '発送済みにする' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeEnabled();
  });
});

describe('OrderShipDialog の画面の中での仕上がりの記録', () => {
  it('受注生産中の品は、画面の中で仕上がりを記録でき、記録した数は発送準備中に移って、そのまま送れる', async () => {
    const { dialog, onShipped } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })))
      .mockResolvedValueOnce(json(shipped({ completesOrder: true, orderStatus: 'shipped' })));
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    expect(await within(dialog).findByText('仕上がりを記録しました。')).toBeInTheDocument();
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [{ orderItemId: 'item-backorder', quantity: 1 }],
    });
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, FULFILLMENTS_URL, { cache: 'no-store' });

    // 記録した品は発送準備中に移り、送る数にも足される。受注生産中の表示と仕上がりの入力は消える
    const reloaded = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(reloaded).getByLabelText('今回送る数')).toBeEnabled();
    expect(within(reloaded).getByLabelText('今回送る数')).toHaveValue(1);
    expect(within(reloaded).queryByLabelText('仕上がった数')).not.toBeInTheDocument();
    expect(within(dialog).getByText('今回送る数の合計: 3点')).toBeInTheDocument();

    typeTracking(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '発送する' }));
    await waitFor(() => expect(onShipped).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(3).lines).toEqual([
      { orderItemId: 'item-stock', quantity: 2 },
      { orderItemId: 'item-backorder', quantity: 1 },
    ]);
  });

  it('入れ直した送る数は、仕上がりを記録しても変わらない', async () => {
    const { dialog } = await openDialog();
    mockClientFetch
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })));
    fireEvent.change(shipQuantityInput(dialog), { target: { value: '1' } });
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));
    await within(dialog).findByText('仕上がりを記録しました。');

    expect(shipQuantityInput(dialog)).toHaveValue(1);
    expect(within(dialog).getByText('今回送る数の合計: 2点')).toBeInTheDocument();
  });

  it('仕上がった数が 0 のまま押したら、理由を出して送らない。この欄の Enter は発送ではなく仕上がりの記録になる', async () => {
    const { dialog } = await openDialog();
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('仕上がった数を入れてください。');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);

    mockClientFetch
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })));
    const input = within(row).getByLabelText('仕上がった数');
    fireEvent.change(input, { target: { value: '1' } });
    // preventDefault されている（フォームの送信にならない）
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);

    await within(dialog).findByText('仕上がりを記録しました。');
    expect(mockClientFetch.mock.calls[1][0]).toBe(COMPLETIONS_URL);
    expect((mockClientFetch.mock.calls[1][1] as RequestInit).method).toBe('POST');
    // 発送の窓口へは何も送っていない
    expect(
      mockClientFetch.mock.calls.filter(([url, init]) => url === FULFILLMENTS_URL && (init as RequestInit).method === 'POST'),
    ).toHaveLength(0);
  });

  it('仕上がりの記録を窓口が断ったら、その文を出し、次の記録は新しい重複防止キーにする', async () => {
    const { dialog } = await openDialog();
    const message = '仕上がった数が受注生産中の数を超えています。一覧を更新してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'quantity_exceeds_in_production' }, 409))
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })));
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));
    await within(dialog).findByText('仕上がりを記録しました。');
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });

  it('仕上がりの記録で答えが分からない時も、同じ重複防止キーで確かめ直せる', async () => {
    const { dialog } = await openDialog();
    mockClientFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: true }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, BACKORDER_READY_LINE] })));
    const row = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(within(dialog).queryByRole('button', { name: '発送する' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));

    expect(await within(dialog).findByText('仕上がりを記録しました。')).toBeInTheDocument();
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
    expect(within(dialog).getByRole('button', { name: '発送する' })).toBeEnabled();
  });

  // 受注生産中が2つの品。1つ記録した後は、受注生産中 1・発送準備中 1 になる
  const TWO_IN_PRODUCTION_LINE: FulfillmentMaterialLine = { ...BACKORDER_LINE, quantity: 2, inProduction: 2, unshipped: 2 };
  const ONE_LEFT_IN_PRODUCTION_LINE: FulfillmentMaterialLine = { ...TWO_IN_PRODUCTION_LINE, inProduction: 1, readyUnshipped: 1 };
  const COAT_GROUP = 'ウールコート（黒 / L）';

  it('仕上がりの記録は済んだのに材料の読み直しだけ失敗した時は、知らせを出して入力を空にし、同じ数を押し直しても同じ重複防止キーで送って二重に記録しない', async () => {
    const { dialog } = await openDialog(materials({ lines: [STOCK_LINE, TWO_IN_PRODUCTION_LINE] }));
    mockClientFetch
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json({ error: 'x', code: 'failed' }, 500))
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: true }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, ONE_LEFT_IN_PRODUCTION_LINE] })));
    const row = within(dialog).getByRole('group', { name: COAT_GROUP });
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));

    // 記録は済んでいる。知らせを出し、入力は空に戻す（残すと、押し直しが新しい記録に見える）。読み直せなかった誤りも出す
    expect(await within(dialog).findByText('仕上がりを記録しました。')).toBeInTheDocument();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('発送の材料を読み込めませんでした。');
    expect(mockClientFetch).toHaveBeenNthCalledWith(3, FULFILLMENTS_URL, { cache: 'no-store' });
    expect(within(row).getByLabelText('仕上がった数')).toHaveValue(0);
    // 読み直せていないので、送る数は変わらない
    expect(within(dialog).getByText('今回送る数の合計: 2点')).toBeInTheDocument();

    // 同じ数を入れ直して押す。同じ重複防止キー・同じ中身なので、窓口は前の結果を返し、記録は増えない
    fireEvent.change(within(row).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(row).getByRole('button', { name: '仕上がりを記録' }));
    await within(dialog).findByText('受注生産中 1');
    expect(requestBodyOf(3)).toEqual(requestBodyOf(1));
    // 読み直せた後に、記録した1つが送る数に足される（押し直しても二重には足されない）。誤りは消える
    expect(within(dialog).getByText('今回送る数の合計: 3点')).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('仕上がりを記録して材料を読み直せた後の次の記録は、新しい重複防止キーにする（前の結果が返って記録されないままにならない）', async () => {
    const { dialog } = await openDialog(materials({ lines: [STOCK_LINE, TWO_IN_PRODUCTION_LINE] }));
    mockClientFetch
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, ONE_LEFT_IN_PRODUCTION_LINE] })))
      .mockResolvedValueOnce(json({ completionIds: ['completion-2'], replayed: false }))
      .mockResolvedValueOnce(json(materials({ lines: [STOCK_LINE, { ...TWO_IN_PRODUCTION_LINE, inProduction: 0, readyUnshipped: 2 }] })));
    fireEvent.change(within(within(dialog).getByRole('group', { name: COAT_GROUP })).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(within(dialog).getByRole('group', { name: COAT_GROUP })).getByRole('button', { name: '仕上がりを記録' }));
    await within(dialog).findByText('受注生産中 1');

    fireEvent.change(within(within(dialog).getByRole('group', { name: COAT_GROUP })).getByLabelText('仕上がった数'), { target: { value: '1' } });
    fireEvent.click(within(within(dialog).getByRole('group', { name: COAT_GROUP })).getByRole('button', { name: '仕上がりを記録' }));
    await waitFor(() => expect(mockClientFetch).toHaveBeenCalledTimes(5));

    expect(requestBodyOf(3).requestKey).toMatch(UUID_PATTERN);
    expect(requestBodyOf(3).requestKey).not.toBe(requestBodyOf(1).requestKey);
  });

  it('日本語入力の変換中の Enter は変換の確定なので、仕上がりを記録しない（Dialog が変換中の Escape を閉じる操作にしないのと同じ）', async () => {
    const { dialog } = await openDialog();
    // 記録が送られてしまった時も、プロセスごと落ちず、下の確かめで落ちるようにする（返事を決めていない mock は undefined を返す）
    mockClientFetch.mockRejectedValue(new TypeError('unexpected request'));
    const input = within(within(dialog).getByRole('group', { name: COAT_GROUP })).getByLabelText('仕上がった数');
    fireEvent.change(input, { target: { value: '1' } });

    // preventDefault もしない（変換の確定を邪魔しない）
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);

    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });
});
