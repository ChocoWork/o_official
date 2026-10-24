import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PurchaseOrderReceiptReverseDialog from '@/components/PurchaseOrderReceiptReverseDialog';
import { clientFetch } from '@/lib/client-fetch';
import type { PurchaseOrderDetail, PurchaseOrderReceipt } from '@/lib/purchase-orders/purchase-order-types';
import { confirmedDetail, LINE_1, LINE_2, ORDER_ID, RECEIPT_ID, RECEIPT_LINE_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_REVERSALS = `/api/admin/purchase-orders/${ORDER_ID}/receipts/${RECEIPT_ID}/reversals`;
const RECEIPT_LINE_2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const OFFSET_LINE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';
const NEW_RECEIPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
const NOTE = '受け取りで入った在庫を、まず空き在庫から減らします。足りない時は、支払い済みの注文の割当を新しい注文から外します。';
const CONFIRMATION = { code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', error: '割り当て済みの品を外す必要があります。数量を確認してください。' };
const STALE = '発注書が更新されました。内容を確認して、もう一度送ってください。';
const EXCEEDS = '取り消せる数を超えています。';
const INSUFFICIENT = '在庫が足りないため取り消せません。取り消す数が、空き在庫と外せる割当の合計を超えています。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
const saved = (releasedQuantity = 0) => json({ receiptId: NEW_RECEIPT_ID, version: 3, releasedQuantity, replayed: false }, 201);
const confirmation = (releasedQuantity: number) => json({ ...CONFIRMATION, releasedQuantity }, 409);

/** 2 行の受取(1 行目は 2 点・取り消せる数 2、2 行目は 4 点のうち 1 点を相殺済みで取り消せる数 3)と、その相殺の行 */
function twoLineDetail(): PurchaseOrderDetail {
  const detail = confirmedDetail();
  const receipt: PurchaseOrderReceipt = {
    ...detail.receipts[0],
    lines: [
      { id: RECEIPT_LINE_ID, lineId: LINE_1, quantity: 2, reversesReceiptLineId: null, reversibleQuantity: 2 },
      { id: RECEIPT_LINE_2, lineId: LINE_2, quantity: 4, reversesReceiptLineId: null, reversibleQuantity: 3 },
    ],
  };
  return { ...detail, receipts: [receipt] };
}

type Mode = 'cancel' | 'correct';
function setup(purchaseOrder: PurchaseOrderDetail, mode: Mode, receiptOf: (detail: PurchaseOrderDetail) => PurchaseOrderReceipt = (detail) => detail.receipts[0]) {
  const handlers = { onClose: jest.fn(), onSaved: jest.fn(), onStale: jest.fn() };
  const view = render(<PurchaseOrderReceiptReverseDialog purchaseOrder={purchaseOrder} receipt={receiptOf(purchaseOrder)} mode={mode} {...handlers} />);
  const rerenderWith = (next: PurchaseOrderDetail) => view.rerender(
    <PurchaseOrderReceiptReverseDialog purchaseOrder={next} receipt={receiptOf(next)} mode={mode} {...handlers} />,
  );
  return { ...handlers, rerenderWith };
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;
const reason = () => screen.getByRole('textbox', { name: '理由' });
const back = () => screen.getByRole('button', { name: '戻る' });
const quantities = () => screen.getAllByLabelText('取り消す数') as HTMLInputElement[];
const submitName = (mode: Mode) => (mode === 'cancel' ? '取り消す' : '訂正する');
const submit = (mode: Mode) => screen.getByRole('button', { name: submitName(mode) });

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PurchaseOrderReceiptReverseDialog: 受け取りの取消', () => {
  test('FREQ-529-AC-04: 見出し「受け取りの取消」、説明の文、取り消せる数が残る行ごとに 取り消せる数 と 取り消す数(初期値=取り消せる数・変えられない)、理由は必須、ボタンは「取り消す」「戻る」', () => {
    setup(twoLineDetail(), 'cancel');
    expect(screen.getByRole('dialog', { name: '受け取りの取消' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '受け取りの取消' })).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    const rows = screen.getAllByTestId('purchase-order-reverse-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('シャツ BLACK M');
    expect(within(rows[0]).getByText('取り消せる数 2')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('パンツ');
    expect(within(rows[1]).getByText('取り消せる数 3')).toBeInTheDocument();
    expect(quantities().map((input) => input.value)).toEqual(['2', '3']);
    for (const input of quantities()) expect(input).toHaveAttribute('readonly');
    expect(reason()).toBeRequired();
    expect(submit('cancel')).toBeDisabled();
    expect(back()).toBeEnabled();
    expect(screen.queryByTestId('purchase-order-release-confirmation')).not.toBeInTheDocument();
  });

  test('FREQ-529-AC-04: 取り消せる数が残らない行(相殺の行・取り消し済みの行)は並べない', () => {
    const detail = twoLineDetail();
    const receipt: PurchaseOrderReceipt = {
      ...detail.receipts[0],
      lines: [
        { id: RECEIPT_LINE_ID, lineId: LINE_1, quantity: 2, reversesReceiptLineId: null, reversibleQuantity: 0 },
        { id: RECEIPT_LINE_2, lineId: LINE_2, quantity: 4, reversesReceiptLineId: null, reversibleQuantity: 3 },
        { id: OFFSET_LINE, lineId: LINE_2, quantity: -1, reversesReceiptLineId: RECEIPT_LINE_2, reversibleQuantity: 0 },
      ],
    };
    setup({ ...detail, receipts: [receipt] }, 'cancel');
    expect(screen.getAllByTestId('purchase-order-reverse-row')).toHaveLength(1);
    expect(screen.getByTestId('purchase-order-reverse-row')).toHaveTextContent('パンツ');
    expect(quantities().map((input) => input.value)).toEqual(['3']);
  });

  test('FREQ-529-AC-04: 理由が空・空白だけの間は「取り消す」を押せない。入れると POST /receipts/[receiptId]/reversals へ expectedVersion・全行を取り消せる数ぜんぶ・reason・requestKey を送り(確認の数は付けない)、成功したら「受け取りを取り消しました。」', async () => {
    const user = userEvent.setup();
    const { onSaved, onClose } = setup(twoLineDetail(), 'cancel');
    fetchMock.mockResolvedValueOnce(saved());
    await user.type(reason(), '   ');
    expect(submit('cancel')).toBeDisabled();
    await user.type(reason(), ' 数え間違い ');
    await user.click(submit('cancel'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('受け取りを取り消しました。'));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(URL_REVERSALS);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({
      expectedVersion: 2, lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: 2 }, { receiptLineId: RECEIPT_LINE_2, quantity: 3 }],
      reason: '数え間違い', requestKey: expect.stringMatching(UUID_PATTERN),
    });
    expect(bodyOf(0)).not.toHaveProperty('expectedReleaseQuantity');
  });

  test('FREQ-529-AC-04: 取り消せる数が読み直しで変わったら、取消の「取り消す数」も新しい値になる', () => {
    const { rerenderWith } = setup(twoLineDetail(), 'cancel');
    const next = twoLineDetail();
    rerenderWith({ ...next, receipts: [{ ...next.receipts[0], lines: next.receipts[0].lines.map((line) => (line.id === RECEIPT_LINE_2 ? { ...line, reversibleQuantity: 1 } : line)) }] });
    expect(quantities().map((input) => input.value)).toEqual(['2', '1']);
  });
});

describe('PurchaseOrderReceiptReverseDialog: 受け取り数量の訂正', () => {
  test('FREQ-529-AC-04: 見出し「受け取り数量の訂正」、取り消す数は空欄で始まり、1行も入れない間は「訂正する」を押せない', () => {
    setup(twoLineDetail(), 'correct');
    expect(screen.getByRole('dialog', { name: '受け取り数量の訂正' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '受け取り数量の訂正' })).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(quantities().map((input) => input.value)).toEqual(['', '']);
    for (const input of quantities()) expect(input).not.toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: '取り消す' })).not.toBeInTheDocument();
    expect(submit('correct')).toBeDisabled();
  });

  test('FREQ-529-AC-04: 入れた行だけを送る(空欄の行は取り消さない)。理由が要る。成功したら「受け取り数量を訂正しました。」', async () => {
    const user = userEvent.setup();
    const { onSaved } = setup(twoLineDetail(), 'correct');
    fetchMock.mockResolvedValueOnce(saved());
    await user.type(quantities()[1], '2');
    expect(submit('correct')).toBeDisabled();
    await user.type(reason(), '1点多く数えた');
    expect(submit('correct')).toBeEnabled();
    await user.click(submit('correct'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('受け取り数量を訂正しました。'));
    expect(bodyOf(0)).toEqual({
      expectedVersion: 2, lines: [{ receiptLineId: RECEIPT_LINE_2, quantity: 2 }], reason: '1点多く数えた', requestKey: expect.stringMatching(UUID_PATTERN),
    });
  });

  test.each([
    ['取り消せる数を超える', '3', EXCEEDS],
    ['0', '0', '入力を確かめてください。'],
    ['負', '-1', '入力を確かめてください。'],
    ['小数', '1.5', '入力を確かめてください。'],
  ])('FREQ-529-AC-05: 取り消す数が %s(%s)なら、行の下に文を出して「訂正する」を押せない', async (_name, text, message) => {
    const user = userEvent.setup();
    setup(twoLineDetail(), 'correct');
    await user.type(reason(), '訂正');
    await user.type(quantities()[0], text);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(quantities()[0]).toHaveAttribute('aria-invalid', 'true');
    expect(submit('correct')).toBeDisabled();
    await user.type(quantities()[1], '1');
    expect(submit('correct')).toBeDisabled();
    await user.clear(quantities()[0]);
    expect(submit('correct')).toBeEnabled();
  });

  test('FREQ-529-AC-04: 取り消せる数ちょうどは通る', async () => {
    const user = userEvent.setup();
    const { onSaved } = setup(twoLineDetail(), 'correct');
    fetchMock.mockResolvedValueOnce(saved());
    await user.type(reason(), '訂正');
    await user.type(quantities()[0], '2');
    await user.click(submit('correct'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).lines).toEqual([{ receiptLineId: RECEIPT_LINE_ID, quantity: 2 }]);
  });
});

describe.each<Mode>(['cancel', 'correct'])('PurchaseOrderReceiptReverseDialog: 確認の段(%s)', (mode) => {
  const arrange = async (user: ReturnType<typeof userEvent.setup>) => {
    const handlers = setup(twoLineDetail(), mode);
    await user.type(reason(), '数え間違い');
    if (mode === 'correct') await user.type(quantities()[0], '2');
    return handlers;
  };

  test('FREQ-529-AC-04: 外す割当があると最初の送信は409になり、見出しはそのまま本文「割り当て済みの品を${n}点外し、受注生産中に戻します。」を出す(失敗の文は出さない)。ボタンは同じ名前のまま、保存はされない', async () => {
    const user = userEvent.setup();
    const { onSaved, onClose, onStale } = await arrange(user);
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));

    expect(await screen.findByTestId('purchase-order-release-confirmation')).toHaveTextContent('割り当て済みの品を3点外し、受注生産中に戻します。');
    expect(screen.getByRole('heading', { name: mode === 'cancel' ? '受け取りの取消' : '受け取り数量の訂正' })).toBeInTheDocument();
    expect(screen.queryByText(CONFIRMATION.error)).not.toBeInTheDocument();
    expect(submit(mode)).toBeEnabled();
    expect(back()).toBeEnabled();
    // 確認中は行の数を変えられない(確認した数と送る数がずれないように)
    for (const input of quantities()) expect(input).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
  });

  test('FREQ-529-AC-04: 確認の後の送信は新しい requestKey と expectedReleaseQuantity(その点数)で送り、成功したら通知を出す。最初の本文と行・理由は同じ', async () => {
    const user = userEvent.setup();
    const { onSaved } = await arrange(user);
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));
    await screen.findByTestId('purchase-order-release-confirmation');
    fetchMock.mockResolvedValueOnce(saved(3));
    await user.click(submit(mode));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(mode === 'cancel' ? '受け取りを取り消しました。' : '受け取り数量を訂正しました。'));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(0)).not.toHaveProperty('expectedReleaseQuantity');
    expect(bodyOf(1).expectedReleaseQuantity).toBe(3);
    expect(bodyOf(1).requestKey).toMatch(UUID_PATTERN);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect({ ...bodyOf(1), requestKey: undefined, expectedReleaseQuantity: undefined }).toEqual({ ...bodyOf(0), requestKey: undefined, expectedReleaseQuantity: undefined });
  });

  test('FREQ-529-AC-04: 確認の数が変わっていれば(再び409)、本文を新しい点数で出し直し、次の送信はその点数と、また新しい requestKey', async () => {
    const user = userEvent.setup();
    const { onSaved } = await arrange(user);
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));
    await screen.findByTestId('purchase-order-release-confirmation');
    fetchMock.mockResolvedValueOnce(confirmation(2));
    await user.click(submit(mode));
    await waitFor(() => expect(screen.getByTestId('purchase-order-release-confirmation')).toHaveTextContent('割り当て済みの品を2点外し、受注生産中に戻します。'));
    expect(onSaved).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(saved(2));
    await user.click(submit(mode));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(3);
    expect(bodyOf(1).expectedReleaseQuantity).toBe(3);
    expect(bodyOf(2).expectedReleaseQuantity).toBe(2);
    expect(new Set([bodyOf(0).requestKey, bodyOf(1).requestKey, bodyOf(2).requestKey]).size).toBe(3);
  });

  test('FREQ-529-AC-04: 外す点数が 0 になっていたら(確認の数が古い)確認の段を出さず(「0点外し」とは見せない)、確認の数なしの新しい要求で自動で送り直す', async () => {
    const user = userEvent.setup();
    const { onSaved } = await arrange(user);
    // 1回目: 外す割当あり(3点) → 確認の段
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));
    await screen.findByTestId('purchase-order-release-confirmation');
    // 2回目: 確認の数 3 で送ったが、空き在庫が増えて外す点数は 0 になった → 確認の段を出さずに送り直す
    fetchMock.mockResolvedValueOnce(confirmation(0));
    fetchMock.mockResolvedValueOnce(saved(0));
    await user.click(submit(mode));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(3);
    expect(bodyOf(1).expectedReleaseQuantity).toBe(3);
    expect(bodyOf(2)).not.toHaveProperty('expectedReleaseQuantity');
    expect(new Set([bodyOf(0).requestKey, bodyOf(1).requestKey, bodyOf(2).requestKey]).size).toBe(3);
    expect(screen.queryByTestId('purchase-order-release-confirmation')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('0点外し');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test.each([
    ['通信の失敗', () => fetchMock.mockRejectedValueOnce(new TypeError('PRIVATE-MARKER'))],
    ['500', () => fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500))],
  ])('FREQ-529-AC-04: 確認の後の送信が %s で終わったら、同じ確定送信の再押下は同じ requestKey と同じ本文(同じ確認の数)で送る', async (_name, failure) => {
    const user = userEvent.setup();
    const { onSaved } = await arrange(user);
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));
    await screen.findByTestId('purchase-order-release-confirmation');
    failure();
    await user.click(submit(mode));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注の記録に失敗しました$/);
    expect(screen.queryByText(/PRIVATE-MARKER/)).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(saved(3));
    await user.click(submit(mode));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(3);
    expect(bodyOf(2)).toEqual(bodyOf(1));
    expect(bodyOf(1).expectedReleaseQuantity).toBe(3);
  });

  test('FREQ-529-AC-04: 確認の段の「戻る」は入力の段に戻り(閉じない・入力は保つ)、もう一度「戻る」で閉じる。戻った後の送信は確認の数なしの新しい要求', async () => {
    const user = userEvent.setup();
    const { onClose } = await arrange(user);
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));
    await screen.findByTestId('purchase-order-release-confirmation');
    await user.click(back());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('purchase-order-release-confirmation')).not.toBeInTheDocument();
    expect(reason()).toHaveValue('数え間違い');
    for (const input of quantities()) expect(input).toBeEnabled();
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));
    await screen.findByTestId('purchase-order-release-confirmation');
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).not.toHaveProperty('expectedReleaseQuantity');
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    await user.click(back());
    expect(onClose).not.toHaveBeenCalled();
    await user.click(back());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('FREQ-529-AC-04: 確認の段で理由が空になっていたら、送らずに「理由を入力してください。」を出す。入れ直すと文は消えて送れる', async () => {
    const user = userEvent.setup();
    const { onSaved } = await arrange(user);
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));
    await screen.findByTestId('purchase-order-release-confirmation');
    await user.clear(reason());
    expect(submit(mode)).toBeEnabled();
    await user.click(submit(mode));
    expect(screen.getByRole('alert')).toHaveTextContent('理由を入力してください。');
    expect(posts()).toHaveLength(1);
    expect(screen.getByTestId('purchase-order-release-confirmation')).toBeInTheDocument();
    await user.type(reason(), '別の理由');
    expect(screen.queryByText('理由を入力してください。')).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(saved(3));
    await user.click(submit(mode));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(1).reason).toBe('別の理由');
    expect(bodyOf(1).expectedReleaseQuantity).toBe(3);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
  });

  test('FREQ-529-AC-05: 確認の後に在庫が足りないと断られたら、表の本文を出し、入力と確認の段は保つ(新しい requestKey で送り直せる)', async () => {
    const user = userEvent.setup();
    await arrange(user);
    fetchMock.mockResolvedValueOnce(confirmation(3));
    await user.click(submit(mode));
    await screen.findByTestId('purchase-order-release-confirmation');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT', error: INSUFFICIENT }, 409));
    await user.click(submit(mode));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(INSUFFICIENT));
    expect(reason()).toHaveValue('数え間違い');
    expect(screen.getByTestId('purchase-order-release-confirmation')).toBeInTheDocument();
    expect(posts()).toHaveLength(2);
  });
});

describe('PurchaseOrderReceiptReverseDialog: 送信・失敗・再送・閉じる(取消も訂正も同じ)', () => {
  test('FREQ-529-AC-04: 送信中は「取り消す」も「戻る」も押せず、閉じられない(Escape も効かない)。二重に押しても通信は1回', async () => {
    const user = userEvent.setup();
    const { onClose, onSaved } = setup(twoLineDetail(), 'cancel');
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    await user.type(reason(), '数え間違い');
    await user.click(submit('cancel'));
    expect(submit('cancel')).toBeDisabled();
    expect(back()).toBeDisabled();
    expect(reason()).toBeDisabled();
    await user.click(submit('cancel'));
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    await act(async () => release(saved()));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  test.each<Mode>(['cancel', 'correct'])('FREQ-529-AC-04: %s は「戻る」と Escape で閉じる(送信中でなければ)。通信はしない', async (mode) => {
    const user = userEvent.setup();
    const { onClose } = setup(twoLineDetail(), mode);
    await user.click(back());
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['通信の失敗', () => fetchMock.mockRejectedValueOnce(new TypeError('PRIVATE-MARKER'))],
    ['500', () => fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500))],
    ['201 だが本文が読めない', () => fetchMock.mockResolvedValueOnce(json({}, 201))],
  ])('FREQ-529-AC-04: %s の後の再押下は、同じ requestKey と同じ本文で送る(在庫を二重に減らさない)。失敗の文は固定で、生の文を出さない', async (_name, arrange) => {
    const user = userEvent.setup();
    const { onSaved } = setup(twoLineDetail(), 'cancel');
    await user.type(reason(), '数え間違い');
    arrange();
    await user.click(submit('cancel'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注の記録に失敗しました$/);
    expect(screen.queryByText(/PRIVATE-MARKER/)).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(submit('cancel')).toBeEnabled();

    fetchMock.mockResolvedValueOnce(json({ receiptId: NEW_RECEIPT_ID, version: 3, releasedQuantity: 0, replayed: true }, 201));
    await user.click(submit('cancel'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-529-AC-04: 理由を変えて送り直すと新しい requestKey になる', async () => {
    const user = userEvent.setup();
    setup(twoLineDetail(), 'cancel');
    await user.type(reason(), '数え間違い');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(submit('cancel'));
    await screen.findByRole('alert');
    await user.type(reason(), 'です');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(submit('cancel'));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1).reason).toBe('数え間違いです');
  });

  test.each([
    ['GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED', 409, EXCEEDS],
    ['GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT', 409, INSUFFICIENT],
    ['GROUP_G_PO_REASON_REQUIRED', 400, '理由を入力してください。'],
    ['GROUP_G_PO_NOT_FOUND', 404, '発注書が見つかりません。'],
  ])('FREQ-529-AC-05: 確定した失敗(%s)は表の本文を出し、入力は保つ。その後の再押下は新しい requestKey', async (code, status, body) => {
    const user = userEvent.setup();
    setup(twoLineDetail(), 'correct');
    await user.type(reason(), '訂正');
    await user.type(quantities()[0], '2');
    fetchMock.mockResolvedValueOnce(json({ code, error: body }, status));
    await user.click(submit('correct'));
    expect(await screen.findByRole('alert')).toHaveTextContent(body);
    expect(quantities()[0]).toHaveValue(2);
    expect(reason()).toHaveValue('訂正');
    fetchMock.mockResolvedValueOnce(json({ code, error: body }, status));
    await user.click(submit('correct'));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
  });

  test('FREQ-529-AC-04: 権限の拒否は受け取り用の文、CSRF の拒否は「再読み込みして、もう一度」の文', async () => {
    const user = userEvent.setup();
    setup(twoLineDetail(), 'cancel');
    await user.type(reason(), '数え間違い');
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.receiving.manage', role: 'supporter' }, 403));
    await user.click(submit('cancel'));
    expect(await screen.findByRole('alert')).toHaveTextContent('受け取りを記録する権限がありません。');
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', reason: 'CSRF validation failed' }, 403));
    await user.click(submit('cancel'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('権限');
  });

  test('FREQ-529-AC-04: 版の競合(409)は表の本文を出して onStale を呼び、ダイアログは開いたまま入力を保つ。読み直しで版が変わったら、次の送信はその版(新しい requestKey)', async () => {
    const user = userEvent.setup();
    const { onStale, onSaved, onClose, rerenderWith } = setup(twoLineDetail(), 'correct');
    await user.type(reason(), '訂正');
    await user.type(quantities()[1], '2');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_VERSION_CONFLICT', error: STALE }, 409));
    await user.click(submit('correct'));

    expect(await screen.findByRole('alert')).toHaveTextContent(STALE);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(reason()).toHaveValue('訂正');
    expect(quantities()[1]).toHaveValue(2);

    rerenderWith({ ...twoLineDetail(), version: 5 });
    fetchMock.mockResolvedValueOnce(saved());
    await user.click(submit('correct'));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(1).expectedVersion).toBe(5);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1).lines).toEqual([{ receiptLineId: RECEIPT_LINE_2, quantity: 2 }]);
  });

  test('FREQ-529-AC-04: ダイアログは画面いっぱいに開く設定(モバイル)', () => {
    setup(twoLineDetail(), 'cancel');
    expect(screen.getByRole('dialog', { name: '受け取りの取消' }).closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });
});
