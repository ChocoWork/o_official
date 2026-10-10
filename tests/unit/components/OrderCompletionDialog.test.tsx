import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FulfillmentMaterialLine, FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';

const mockClientFetch = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockClientFetch(...args) }));

import OrderCompletionDialog from '@/components/OrderCompletionDialog';

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const FULFILLMENTS_URL = `/api/admin/orders/${ORDER_ID}/fulfillments`;
const COMPLETIONS_URL = `/api/admin/orders/${ORDER_ID}/completions`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNKNOWN_OUTCOME = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const STOCK_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-stock', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
  quantity: 2, shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
};

/** 受注生産の品。3つのうち 2つが受注生産中、1つは仕上がって発送準備中 */
const COAT_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-coat', name: 'ウールコート', color: '黒', size: 'L', fulfillmentType: 'backorder',
  quantity: 3, shipped: 0, inProduction: 2, readyUnshipped: 1, unshipped: 3,
};

const SKIRT_LINE: FulfillmentMaterialLine = {
  orderItemId: 'item-skirt', name: 'プリーツスカート', color: null, size: 'S', fulfillmentType: 'backorder',
  quantity: 1, shipped: 0, inProduction: 1, readyUnshipped: 0, unshipped: 1,
};

function materials(overrides: Partial<FulfillmentMaterials> = {}): FulfillmentMaterials {
  return {
    order: {
      id: ORDER_ID,
      orderNumber: 'ORD-A1B2C3D4',
      status: 'paid',
      progress: { key: 'in_production', label: '受注生産中', partiallyShipped: false },
    },
    blockedReason: null,
    lines: [STOCK_LINE, COAT_LINE, SKIRT_LINE],
    fulfillments: [],
    ...overrides,
  };
}

/** 画面を開き、発送の材料を読み終えるまで待つ（読み込み中の文が消える） */
async function openDialog(loaded: FulfillmentMaterials = materials()) {
  mockClientFetch.mockResolvedValueOnce(json(loaded));
  const onClose = jest.fn();
  const onRecorded = jest.fn();
  const utils = render(<OrderCompletionDialog orderId={ORDER_ID} onClose={onClose} onRecorded={onRecorded} />);
  const dialog = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
  await waitFor(() => expect(within(dialog).queryByText('読み込み中です...')).not.toBeInTheDocument());
  return { ...utils, dialog, onClose, onRecorded };
}

function quantityInput(dialog: HTMLElement, groupName: string) {
  return within(within(dialog).getByRole('group', { name: groupName })).getByLabelText('仕上がった数');
}

function requestBodyOf(callIndex: number): Record<string, unknown> {
  const init = mockClientFetch.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  mockClientFetch.mockReset();
});

describe('OrderCompletionDialog の一覧', () => {
  it('受注生産中の数がある商品だけを並べ、仕上がった数は 0 から始まる', async () => {
    const { dialog } = await openDialog();

    expect(mockClientFetch).toHaveBeenCalledWith(FULFILLMENTS_URL, { cache: 'no-store' });
    expect(within(dialog).getAllByRole('group')).toHaveLength(2);
    expect(within(dialog).queryByRole('group', { name: /シルクブラウス/ })).not.toBeInTheDocument();
    const coat = within(dialog).getByRole('group', { name: 'ウールコート（黒 / L）' });
    expect(within(coat).getByText('受注生産中 2')).toBeInTheDocument();
    expect(within(coat).getByLabelText('仕上がった数')).toHaveValue(0);
    const skirt = within(dialog).getByRole('group', { name: 'プリーツスカート（S）' });
    expect(within(skirt).getByText('受注生産中 1')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '記録する' })).toBeEnabled();
  });

  it('入れた数は 0 から受注生産中の数までに収める', async () => {
    const { dialog } = await openDialog();
    const input = quantityInput(dialog, 'ウールコート（黒 / L）');

    fireEvent.change(input, { target: { value: '9' } });
    expect(input).toHaveValue(2);
    fireEvent.change(input, { target: { value: '-1' } });
    expect(input).toHaveValue(0);
    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue(1);
  });

  it('スマホの幅（768px 未満）では画面いっぱいに開く指定を付ける', async () => {
    const { dialog } = await openDialog();

    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });

  it('受注生産中の商品が無い時は、その旨を出して記録できなくする', async () => {
    const { dialog } = await openDialog(materials({ lines: [STOCK_LINE, { ...COAT_LINE, inProduction: 0, readyUnshipped: 3 }] }));

    expect(within(dialog).getByText('受注生産中の商品はありません。')).toBeInTheDocument();
    expect(within(dialog).queryByRole('group')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '記録する' })).toBeDisabled();
  });

  it('決済完了でない注文は、記録できない旨を出して記録できなくする。配送先や支払額の確認は記録を止めない', async () => {
    const blocked = await openDialog(materials({ blockedReason: 'not_shippable' }));
    expect(blocked.dialog).toHaveTextContent('仕上がりを記録できる状態ではありません。一覧を更新してください。');
    expect(within(blocked.dialog).getByRole('button', { name: '記録する' })).toBeDisabled();
    expect(quantityInput(blocked.dialog, 'ウールコート（黒 / L）')).toBeDisabled();
    blocked.unmount();

    const addressMissing = await openDialog(materials({ blockedReason: 'address_incomplete' }));
    expect(within(addressMissing.dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(addressMissing.dialog).getByRole('button', { name: '記録する' })).toBeEnabled();
  });

  it.each([
    [404, { error: '注文が見つかりません。', code: 'order_not_found' }, '注文が見つかりません。'],
    [403, { error: 'Forbidden' }, 'この操作の権限がありません。'],
    [500, { error: 'x', code: 'failed' }, '発送の材料を読み込めませんでした。'],
  ])('材料を読めなかった時（%i）は理由を出し、記録できなくする', async (status, body, message) => {
    mockClientFetch.mockResolvedValueOnce(json(body, status));
    render(<OrderCompletionDialog orderId={ORDER_ID} onClose={jest.fn()} onRecorded={jest.fn()} />);

    const dialog = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getByRole('button', { name: '記録する' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'キャンセル' })).toBeEnabled();
  });
});

describe('OrderCompletionDialog の記録', () => {
  it('記録すると、重複防止キーと、数を入れた商品だけを窓口へ送り、親へ知らせる', async () => {
    const { dialog, onRecorded } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(mockClientFetch).toHaveBeenNthCalledWith(2, COMPLETIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.any(String),
    });
    expect(requestBodyOf(1)).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [{ orderItemId: 'item-coat', quantity: 2 }],
    });
  });

  it('複数の商品を一度に記録できる', async () => {
    const { dialog, onRecorded } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(json({ completionIds: ['completion-1', 'completion-2'], replayed: false }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.change(quantityInput(dialog, 'プリーツスカート（S）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(1).lines).toEqual([
      { orderItemId: 'item-coat', quantity: 1 },
      { orderItemId: 'item-skirt', quantity: 1 },
    ]);
  });

  it('仕上がった数の合計が 0 なら、理由を画面の中に出して送らない', async () => {
    const { dialog, onRecorded } = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('仕上がった数を入れてください。');
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('「キャンセル」では送らずに閉じる', async () => {
    const { dialog, onClose, onRecorded } = await openDialog();
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockClientFetch).toHaveBeenCalledTimes(1);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('送っている間は記録のボタンを押せず、二重に送らない', async () => {
    const { dialog, onRecorded } = await openDialog();
    let resolvePost: (value: Response) => void = () => {};
    mockClientFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePost = resolve; }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(within(dialog).getByRole('button', { name: '記録する' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    expect(mockClientFetch).toHaveBeenCalledTimes(2);

    resolvePost(json({ completionIds: ['completion-1'], replayed: false }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
  });

  it('窓口が断ったら、その文を画面の中に出し、入力は残して、次の送信は新しい重複防止キーにする', async () => {
    const { dialog, onRecorded } = await openDialog();
    const message = '仕上がった数が受注生産中の数を超えています。一覧を更新してください。';
    mockClientFetch
      .mockResolvedValueOnce(json({ error: message, code: 'quantity_exceeds_in_production' }, 409))
      .mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: false }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(onRecorded).not.toHaveBeenCalled();
    expect(quantityInput(dialog, 'ウールコート（黒 / L）')).toHaveValue(2);

    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(requestBodyOf(2).requestKey).not.toBe(requestBodyOf(1).requestKey);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['通信が切れた', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['サーバーが失敗した（500）', () => Promise.resolve(json({ error: '仕上がりの記録に失敗しました。', code: 'failed' }, 500))],
  ])('%s時は、入力を止めて「もう一度確かめる」と「閉じる」だけを出し、同じ重複防止キーで確かめ直す', async (_label, firstAnswer) => {
    const { dialog, onRecorded, onClose } = await openDialog();
    mockClientFetch.mockImplementationOnce(firstAnswer).mockResolvedValueOnce(json({ completionIds: ['completion-1'], replayed: true }));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(UNKNOWN_OUTCOME);
    expect(quantityInput(dialog, 'ウールコート（黒 / L）')).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: '記録する' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '閉じる' })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    // 同じ重複防止キー・同じ中身で送り直す
    expect(requestBodyOf(2)).toEqual(requestBodyOf(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('「閉じる」で閉じる（答えが分からないまま）', async () => {
    const { dialog, onClose, onRecorded } = await openDialog();
    mockClientFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '閉じる' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it('閉じて開き直すと、材料を読み直し、入力は 0 に戻り、誤りの文も消える', async () => {
    const { rerender, dialog } = await openDialog();
    mockClientFetch.mockResolvedValueOnce(
      json({ error: '仕上がりを記録できる状態ではありません。一覧を更新してください。', code: 'not_in_production' }, 409),
    );
    fireEvent.change(quantityInput(dialog, 'ウールコート（黒 / L）'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '記録する' }));
    await within(dialog).findByRole('alert');

    rerender(<OrderCompletionDialog orderId={null} onClose={jest.fn()} onRecorded={jest.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mockClientFetch.mockResolvedValueOnce(json(materials()));
    rerender(<OrderCompletionDialog orderId={ORDER_ID} onClose={jest.fn()} onRecorded={jest.fn()} />);
    const reopened = await screen.findByRole('dialog', { name: '仕上がりを記録する' });
    await waitFor(() => expect(within(reopened).queryByText('読み込み中です...')).not.toBeInTheDocument());

    expect(quantityInput(reopened, 'ウールコート（黒 / L）')).toHaveValue(0);
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
  });
});
