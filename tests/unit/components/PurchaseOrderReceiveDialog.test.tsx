import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PurchaseOrderReceiveDialog from '@/components/PurchaseOrderReceiveDialog';
import { clientFetch } from '@/lib/client-fetch';
import type { PurchaseOrderDetail } from '@/lib/purchase-orders/purchase-order-types';
import { confirmedDetail, LINE_1, LINE_2, ORDER_ID, RECEIPT_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RECEIPTS = `/api/admin/purchase-orders/${ORDER_ID}/receipts`;
const NOTE = '検品で不良だった分は入力せず、未納のまま待つか、あとで打ち切ってください。';
const STALE = '発注書が更新されました。内容を確認して、もう一度送ってください。';
const EXCEEDS = '未納の数を超えて受け取ることはできません。先に数量を訂正してください。';
const DATE_INVALID = '受取日は発注日から今日までの日付にしてください。';
const RECEIVE_FORBIDDEN = '受け取りを記録する権限がありません。';
/** 今日(日本時間)は 2026-10-27。confirmedDetail の発注日は 2026-10-25(日本時間) */
const FROZEN_NOW = new Date('2026-10-27T03:00:00.000Z');

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Mode = 'all' | 'part';
function setup(purchaseOrder: PurchaseOrderDetail, mode: Mode) {
  const handlers = { onClose: jest.fn(), onSaved: jest.fn(), onStale: jest.fn() };
  const view = render(<PurchaseOrderReceiveDialog purchaseOrder={purchaseOrder} mode={mode} {...handlers} />);
  const rerenderWith = (next: PurchaseOrderDetail) => view.rerender(<PurchaseOrderReceiveDialog purchaseOrder={next} mode={mode} {...handlers} />);
  return { ...handlers, rerenderWith };
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;
const quantityInputs = () => screen.getAllByRole('spinbutton');
const receivedOn = () => screen.getByLabelText('受取日');
const memo = () => screen.getByRole('textbox', { name: 'メモ' });
const submit = () => screen.getByRole('button', { name: '受け取りを確定' });
const back = () => screen.getByRole('button', { name: '戻る' });

/** 発注書の 2 行目の未納を 0 にする(1 行目だけ未納 3) */
function oneOutstanding(): PurchaseOrderDetail {
  const detail = confirmedDetail();
  return { ...detail, lines: detail.lines.map((line) => (line.id === LINE_2 ? { ...line, receivedQuantity: 3, outstandingQuantity: 0 } : line)) };
}

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  // 日付だけ固定する(タイマーと microtask は本物のまま)
  jest.useFakeTimers({
    now: FROZEN_NOW,
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PurchaseOrderReceiveDialog: 全部を受け取る', () => {
  test('FREQ-529-AC-01: 見出し「全部を受け取る」、説明の文、表の見出し7つ、未納のある行ごとに 発注数量・納品済み・未納 と、今回受け取った数（初期値=未納・変えられない）', () => {
    setup(confirmedDetail(), 'all');
    expect(screen.getByRole('dialog', { name: '全部を受け取る' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '全部を受け取る' })).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '受け取る行' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent))
      .toEqual(['商品名', '色', 'サイズ', '発注数量', '納品済み', '未納', '今回受け取った数']);
    const rows = screen.getAllByTestId('purchase-order-receive-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getAllByRole('cell').slice(0, 6).map((cell) => cell.textContent)).toEqual(['シャツ', 'BLACK', 'M', '5', '2', '3']);
    expect(within(rows[1]).getAllByRole('cell').slice(0, 6).map((cell) => cell.textContent)).toEqual(['パンツ', '—', '—', '3', '0', '3']);
    expect(quantityInputs().map((input) => (input as HTMLInputElement).value)).toEqual(['3', '3']);
    for (const input of quantityInputs()) expect(input).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'メモ' })).toHaveValue('');
    expect(submit()).toBeEnabled();
    expect(back()).toBeEnabled();
  });

  test('FREQ-529-AC-01: 受取日の初期値は今日(日本時間)で、発注日から今日までの範囲。メモは任意', () => {
    setup(confirmedDetail(), 'all');
    expect(receivedOn()).toHaveValue('2026-10-27');
    expect(receivedOn()).toHaveAttribute('type', 'date');
    expect(receivedOn()).toHaveAttribute('min', '2026-10-25');
    expect(receivedOn()).toHaveAttribute('max', '2026-10-27');
    expect(memo()).not.toBeRequired();
  });

  test('FREQ-529-AC-01: 未納のある行だけを並べる(未納が 0 の行は出さない)', () => {
    setup(oneOutstanding(), 'all');
    const rows = screen.getAllByTestId('purchase-order-receive-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('シャツ');
    expect(screen.queryByText('パンツ')).not.toBeInTheDocument();
  });

  test('FREQ-529-AC-01: 「受け取りを確定」で POST /receipts へ expectedVersion・receivedOn・memo・全行の未納・requestKey を送り、成功したら「受け取りを記録しました。」', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onSaved, onClose } = setup(confirmedDetail(), 'all');
    fetchMock.mockResolvedValueOnce(json({ receiptId: RECEIPT_ID, version: 3, allocatedQuantity: 0, replayed: false }, 201));
    await user.type(memo(), ' 午前便 ');
    await user.click(submit());

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('受け取りを記録しました。'));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(URL_RECEIPTS);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({
      expectedVersion: 2, receivedOn: '2026-10-27', memo: '午前便',
      lines: [{ lineId: LINE_1, quantity: 3 }, { lineId: LINE_2, quantity: 3 }], requestKey: expect.stringMatching(UUID_PATTERN),
    });
  });

  test('FREQ-529-AC-01: 未納が読み直しで変わったら、全部の「今回受け取った数」も新しい未納になる', () => {
    const { rerenderWith } = setup(confirmedDetail(), 'all');
    const next = confirmedDetail();
    rerenderWith({ ...next, lines: next.lines.map((line) => (line.id === LINE_1 ? { ...line, receivedQuantity: 4, outstandingQuantity: 1 } : line)) });
    expect(quantityInputs().map((input) => (input as HTMLInputElement).value)).toEqual(['1', '3']);
  });

  test('FREQ-529-AC-01: メモが空なら memo を送らない', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onSaved } = setup(confirmedDetail(), 'all');
    fetchMock.mockResolvedValueOnce(json({ receiptId: RECEIPT_ID, version: 3, allocatedQuantity: 0, replayed: false }, 201));
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(0)).not.toHaveProperty('memo');
  });
});

describe('PurchaseOrderReceiveDialog: 一部を受け取る', () => {
  test('FREQ-529-AC-01: 見出し「一部を受け取る」。今回受け取った数は空欄で始まり、1行も入れない間は「受け取りを確定」を押せない', () => {
    setup(confirmedDetail(), 'part');
    expect(screen.getByRole('dialog', { name: '一部を受け取る' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '一部を受け取る' })).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(quantityInputs().map((input) => (input as HTMLInputElement).value)).toEqual(['', '']);
    for (const input of quantityInputs()) expect(input).not.toHaveAttribute('readonly');
    expect(submit()).toBeDisabled();
  });

  test('FREQ-529-AC-01: 入れた行だけを送る(空欄の行は受け取らない)。1〜未納の範囲で、成功したら「受け取りを記録しました。」', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onSaved } = setup(confirmedDetail(), 'part');
    fetchMock.mockResolvedValueOnce(json({ receiptId: RECEIPT_ID, version: 3, allocatedQuantity: 1, replayed: false }, 201));
    await user.type(quantityInputs()[1], '2');
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('受け取りを記録しました。'));
    expect(bodyOf(0)).toEqual({ expectedVersion: 2, receivedOn: '2026-10-27', lines: [{ lineId: LINE_2, quantity: 2 }], requestKey: expect.stringMatching(UUID_PATTERN) });
  });

  test.each([
    ['未納を超える', '4', EXCEEDS],
    ['0', '0', '入力を確かめてください。'],
    ['負', '-1', '入力を確かめてください。'],
    ['小数', '1.5', '入力を確かめてください。'],
  ])('FREQ-529-AC-01: 今回受け取った数が %s(%s)なら、行の下に文を出して「受け取りを確定」を押せない', async (_name, text, message) => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setup(confirmedDetail(), 'part');
    await user.type(quantityInputs()[0], text);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(quantityInputs()[0]).toHaveAttribute('aria-invalid', 'true');
    expect(submit()).toBeDisabled();
    // 別の行が正しくても、不正な行がある間は送れない
    await user.type(quantityInputs()[1], '1');
    expect(submit()).toBeDisabled();
    // 直すと送れる
    await user.clear(quantityInputs()[0]);
    expect(submit()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-529-AC-01: 未納ちょうどは通る', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onSaved } = setup(confirmedDetail(), 'part');
    fetchMock.mockResolvedValueOnce(json({ receiptId: RECEIPT_ID, version: 3, allocatedQuantity: 0, replayed: false }, 201));
    await user.type(quantityInputs()[0], '3');
    expect(submit()).toBeEnabled();
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).lines).toEqual([{ lineId: LINE_1, quantity: 3 }]);
  });

  test('FREQ-529-AC-01: 入力は版の競合で保たれ、未納が読み直しで減って超えた行は文を出し直す', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { rerenderWith } = setup(confirmedDetail(), 'part');
    await user.type(quantityInputs()[0], '3');
    expect(submit()).toBeEnabled();
    const next = confirmedDetail();
    rerenderWith({ ...next, lines: next.lines.map((line) => (line.id === LINE_1 ? { ...line, receivedQuantity: 4, outstandingQuantity: 1 } : line)) });
    expect(quantityInputs()[0]).toHaveValue(3);
    expect(screen.getByRole('alert')).toHaveTextContent(EXCEEDS);
    expect(submit()).toBeDisabled();
  });
});

describe('PurchaseOrderReceiveDialog: 受取日・送信・失敗・再送・閉じる(全部も一部も同じ)', () => {
  test.each([
    ['発注日より前', '2026-10-24'],
    ['今日より後', '2026-10-28'],
    ['空', ''],
  ])('FREQ-529-AC-01: 受取日が%s(%j)なら、文を出して「受け取りを確定」を押せない', (_name, value) => {
    setup(confirmedDetail(), 'all');
    fireEvent.change(receivedOn(), { target: { value } });
    expect(screen.getByText(DATE_INVALID)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  test.each([['発注日', '2026-10-25'], ['今日', '2026-10-27'], ['その間', '2026-10-26']])('FREQ-529-AC-01: 受取日が%s(%s)なら通り、その日を送る', async (_name, value) => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onSaved } = setup(confirmedDetail(), 'all');
    fireEvent.change(receivedOn(), { target: { value } });
    expect(screen.queryByText(DATE_INVALID)).not.toBeInTheDocument();
    fetchMock.mockResolvedValueOnce(json({ receiptId: RECEIPT_ID, version: 3, allocatedQuantity: 0, replayed: false }, 201));
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).receivedOn).toBe(value);
  });

  test('FREQ-529-AC-01: 送信中は「受け取りを確定」も「戻る」も押せず、閉じられない(Escape も効かない)。二重に押しても通信は1回', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onClose, onSaved } = setup(confirmedDetail(), 'all');
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    await user.click(submit());
    expect(submit()).toBeDisabled();
    expect(back()).toBeDisabled();
    expect(receivedOn()).toBeDisabled();
    expect(memo()).toBeDisabled();
    await user.click(submit());
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    await act(async () => release(json({ receiptId: RECEIPT_ID, version: 3, allocatedQuantity: 0, replayed: false }, 201)));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  test.each(['all', 'part'] as const)('FREQ-529-AC-01: %s は「戻る」と Escape で閉じる(送信中でなければ)。通信はしない', async (mode) => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onClose } = setup(confirmedDetail(), mode);
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
  ])('FREQ-529-AC-02: %s の後の再押下は、同じ requestKey と同じ本文で送る(在庫を二重に増やさない)。失敗の文は固定で、生の文を出さない', async (_name, arrange) => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onSaved } = setup(confirmedDetail(), 'all');
    arrange();
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注の記録に失敗しました$/);
    expect(screen.queryByText(/PRIVATE-MARKER/)).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(submit()).toBeEnabled();

    fetchMock.mockResolvedValueOnce(json({ receiptId: RECEIPT_ID, version: 3, allocatedQuantity: 0, replayed: true }, 201));
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-529-AC-02: 内容(メモ)を変えて送り直すと新しい requestKey になる', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setup(confirmedDetail(), 'all');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(submit());
    await screen.findByRole('alert');
    await user.type(memo(), '午後便');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1).requestKey).toMatch(UUID_PATTERN);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1).memo).toBe('午後便');
  });

  test.each([
    ['GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING', 409, EXCEEDS],
    ['GROUP_G_PO_NOT_CONFIRMED', 409, '数量が確定するまで受け取りはできません。'],
    ['GROUP_G_PO_RECEIVED_ON_INVALID', 400, DATE_INVALID],
    ['GROUP_G_PO_NOT_FOUND', 404, '発注書が見つかりません。'],
  ])('FREQ-529-AC-01: 確定した失敗(%s)は表の本文を出し、入力は保つ。その後の再押下は新しい requestKey', async (code, status, body) => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setup(confirmedDetail(), 'part');
    await user.type(quantityInputs()[0], '2');
    await user.type(memo(), '午前便');
    fetchMock.mockResolvedValueOnce(json({ code, error: body }, status));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(body);
    expect(quantityInputs()[0]).toHaveValue(2);
    expect(memo()).toHaveValue('午前便');
    fetchMock.mockResolvedValueOnce(json({ code, error: body }, status));
    await user.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
  });

  test('FREQ-529-AC-01: 権限の拒否は受け取り用の文「受け取りを記録する権限がありません。」(DB の拒否も、窓口の認可の拒否も)', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setup(confirmedDetail(), 'all');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_FORBIDDEN', error: RECEIVE_FORBIDDEN }, 403));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(RECEIVE_FORBIDDEN);
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.receiving.manage', role: 'supporter' }, 403));
    await user.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(screen.getByRole('alert')).toHaveTextContent(RECEIVE_FORBIDDEN);
    expect(screen.queryByText('発注を扱う権限がありません。')).not.toBeInTheDocument();
  });

  test('FREQ-540-AC-07: CSRF の確かめで断られた403は「権限がありません」と言わず、「再読み込みして、もう一度」の文', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    setup(confirmedDetail(), 'all');
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', reason: 'CSRF validation failed' }, 403));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。');
    expect(screen.getByRole('alert')).not.toHaveTextContent('権限');
  });

  test('FREQ-529-AC-01: 版の競合(409)は表の本文を出して onStale を呼び、ダイアログは開いたまま入力を保つ。読み直しで版が変わったら、次の送信はその版(新しい requestKey)', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { onStale, onSaved, onClose, rerenderWith } = setup(confirmedDetail(), 'part');
    await user.type(quantityInputs()[0], '2');
    await user.type(memo(), '午前便');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_VERSION_CONFLICT', error: STALE }, 409));
    await user.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(STALE);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(quantityInputs()[0]).toHaveValue(2);
    expect(memo()).toHaveValue('午前便');

    rerenderWith({ ...confirmedDetail(), version: 5 });
    fetchMock.mockResolvedValueOnce(json({ receiptId: RECEIPT_ID, version: 6, allocatedQuantity: 0, replayed: false }, 201));
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(1).expectedVersion).toBe(5);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1).lines).toEqual([{ lineId: LINE_1, quantity: 2 }]);
    expect(bodyOf(1).memo).toBe('午前便');
  });

  test('FREQ-529-AC-01: ダイアログは画面いっぱいに開く設定(モバイル)で、行の表は縦横に動く領域に入る', () => {
    setup(confirmedDetail(), 'all');
    expect(screen.getByRole('dialog', { name: '全部を受け取る' }).closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
    const region = screen.getByRole('region', { name: '受け取る行' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toMatch(/overflow-auto/);
    expect(region.className).toMatch(/max-w-full/);
  });
});
