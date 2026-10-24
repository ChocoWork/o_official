import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PurchaseOrderShortCloseDialog from '@/components/PurchaseOrderShortCloseDialog';
import { clientFetch } from '@/lib/client-fetch';
import type { PurchaseOrderDetail } from '@/lib/purchase-orders/purchase-order-types';
import { confirmedDetail, LINE_1, LINE_2, orderedDetail, ORDER_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_CLOSURES = `/api/admin/purchase-orders/${ORDER_ID}/short-closures`;
const CLOSE_NOTE = '入庫は起こりません。打ち切った数は発注数量から引かれ、発注必要数が増えることがあります。';
const CANCEL_NOTE = '数量は確定していないため、全ての行を 0 にして完了にします。入庫は起こりません。';
const STALE = '発注書が更新されました。内容を確認して、もう一度送ってください。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Mode = 'close' | 'cancel';
function setup(purchaseOrder: PurchaseOrderDetail, mode: Mode, lineIds: readonly string[] = []) {
  const handlers = { onClose: jest.fn(), onSaved: jest.fn(), onStale: jest.fn() };
  const view = render(<PurchaseOrderShortCloseDialog purchaseOrder={purchaseOrder} mode={mode} lineIds={lineIds} {...handlers} />);
  const rerenderWith = (next: PurchaseOrderDetail) =>
    view.rerender(<PurchaseOrderShortCloseDialog purchaseOrder={next} mode={mode} lineIds={lineIds} {...handlers} />);
  return { ...handlers, rerenderWith };
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;
const reason = () => screen.getByRole('textbox', { name: '理由' });
const back = () => screen.getByRole('button', { name: '戻る' });

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PurchaseOrderShortCloseDialog: 残りを打ち切る（確定後）', () => {
  test('FREQ-528-AC-01: 見出し「残りを打ち切る」。選んだ行ごとに「未納 ${n} → 0」、説明の文、理由は必須、ボタンは「打ち切る」「戻る」', () => {
    setup(confirmedDetail(), 'close', [LINE_1, LINE_2]);
    expect(screen.getByRole('dialog', { name: '残りを打ち切る' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '残りを打ち切る' })).toBeInTheDocument();
    const items = screen.getAllByTestId('purchase-order-close-row');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('シャツ BLACK M');
    expect(within(items[0]).getByText('未納 3 → 0')).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('パンツ');
    expect(within(items[1]).getByText('未納 3 → 0')).toBeInTheDocument();
    expect(screen.getByText(CLOSE_NOTE)).toBeInTheDocument();
    expect(reason()).toBeRequired();
    expect(screen.getByRole('button', { name: '打ち切る' })).toBeDisabled();
    expect(back()).toBeEnabled();
  });

  test('FREQ-528-AC-01: 選んだ行だけを並べ、選んでいない行は出さない。並びは発注書の行の並び（選んだ順ではない）', () => {
    setup(confirmedDetail(), 'close', [LINE_2]);
    const items = screen.getAllByTestId('purchase-order-close-row');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('パンツ');
    expect(screen.queryByText('シャツ BLACK M')).not.toBeInTheDocument();
  });

  test('FREQ-528-AC-01: 理由が空・空白だけの間は「打ち切る」を押せない。入れると POST /short-closures へ expectedVersion・lineIds・reason・requestKey を送り、成功したら「残りを打ち切りました。」', async () => {
    const user = userEvent.setup();
    const { onSaved, onClose } = setup(confirmedDetail(), 'close', [LINE_1, LINE_2]);
    fetchMock.mockResolvedValueOnce(json({ version: 3, closedQuantity: 6, replayed: false }, 201));
    await user.type(reason(), '   ');
    expect(screen.getByRole('button', { name: '打ち切る' })).toBeDisabled();
    await user.type(reason(), ' 工場の都合 ');
    await user.click(screen.getByRole('button', { name: '打ち切る' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('残りを打ち切りました。'));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(URL_CLOSURES);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({ expectedVersion: 2, lineIds: [LINE_1, LINE_2], reason: '工場の都合', requestKey: expect.stringMatching(UUID_PATTERN) });
  });

  test('FREQ-528-AC-01: 未納が読み直しで変わったら、行の「未納 ${n} → 0」も新しい値になる', () => {
    const { rerenderWith } = setup(confirmedDetail(), 'close', [LINE_1]);
    expect(screen.getByText('未納 3 → 0')).toBeInTheDocument();
    const next = confirmedDetail();
    rerenderWith({ ...next, lines: next.lines.map((line) => (line.id === LINE_1 ? { ...line, receivedQuantity: 4, outstandingQuantity: 1 } : line)) });
    expect(screen.getByText('未納 1 → 0')).toBeInTheDocument();
  });
});

describe('PurchaseOrderShortCloseDialog: 発注の取消（数量確定前）', () => {
  test('FREQ-528-AC-02: 見出し「発注の取消」。説明の文、理由は必須、ボタンは「取り消す」「戻る」。行の一覧は出さない', () => {
    setup(orderedDetail(), 'cancel');
    expect(screen.getByRole('dialog', { name: '発注の取消' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '発注の取消' })).toBeInTheDocument();
    expect(screen.getByText(CANCEL_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(/未納/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '残りを打ち切る' })).not.toBeInTheDocument();
    expect(reason()).toBeRequired();
    expect(screen.getByRole('button', { name: '取り消す' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '打ち切る' })).not.toBeInTheDocument();
    expect(back()).toBeEnabled();
  });

  test('FREQ-528-AC-02: 取り消すと、同じ /short-closures に発注書の全行を渡し、成功したら「発注を取り消しました。」', async () => {
    const user = userEvent.setup();
    const { onSaved } = setup(orderedDetail(), 'cancel');
    fetchMock.mockResolvedValueOnce(json({ version: 2, closedQuantity: 9, replayed: false }, 201));
    await user.type(reason(), '発注をやめる');
    await user.click(screen.getByRole('button', { name: '取り消す' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('発注を取り消しました。'));
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(URL_CLOSURES);
    expect(bodyOf(0)).toEqual({ expectedVersion: 1, lineIds: [LINE_1, LINE_2], reason: '発注をやめる', requestKey: expect.stringMatching(UUID_PATTERN) });
  });

  test('FREQ-528-AC-02: 取消では props の lineIds を使わず、常に発注書の全行（props に一部を渡されても全行）', async () => {
    const user = userEvent.setup();
    const { onSaved } = setup(orderedDetail(), 'cancel', [LINE_1]);
    fetchMock.mockResolvedValueOnce(json({ version: 2, closedQuantity: 9, replayed: false }, 201));
    await user.type(reason(), 'やめる');
    await user.click(screen.getByRole('button', { name: '取り消す' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).lineIds).toEqual([LINE_1, LINE_2]);
  });
});

describe('PurchaseOrderShortCloseDialog: 送信・失敗・再送・閉じる（打切りも取消も同じ）', () => {
  test('FREQ-528-AC-01: 送信中は「打ち切る」も「戻る」も押せず、閉じられない（Escape も効かない）。二重に押しても通信は1回', async () => {
    const user = userEvent.setup();
    const { onClose, onSaved } = setup(confirmedDetail(), 'close', [LINE_1]);
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    await user.type(reason(), '打切り');
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    expect(screen.getByRole('button', { name: '打ち切る' })).toBeDisabled();
    expect(back()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    await act(async () => release(json({ version: 3, closedQuantity: 3, replayed: false }, 201)));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  test.each<Mode>(['close', 'cancel'])('FREQ-528-AC-01: %s は「戻る」と Escape で閉じる（送信中でなければ）。通信はしない', async (mode) => {
    const user = userEvent.setup();
    const { onClose } = setup(mode === 'close' ? confirmedDetail() : orderedDetail(), mode, [LINE_1]);
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
  ])('FREQ-528-AC-01: %s の後の再押下は、同じ requestKey と同じ本文で送る（二重に打ち切らない）。失敗の文は固定で、生の文を出さない', async (_name, arrange) => {
    const user = userEvent.setup();
    const { onSaved } = setup(confirmedDetail(), 'close', [LINE_1, LINE_2]);
    await user.type(reason(), '打切り');
    arrange();
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注の記録に失敗しました$/);
    expect(screen.queryByText(/PRIVATE-MARKER/)).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '打ち切る' })).toBeEnabled();

    fetchMock.mockResolvedValueOnce(json({ version: 3, closedQuantity: 6, replayed: true }, 201));
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-528-AC-01: 理由を変えて送り直すと新しい requestKey になる', async () => {
    const user = userEvent.setup();
    setup(confirmedDetail(), 'close', [LINE_1]);
    await user.type(reason(), '打切り');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    await screen.findByRole('alert');
    await user.type(reason(), 'です');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1).requestKey).toMatch(UUID_PATTERN);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1).reason).toBe('打切りです');
  });

  test('FREQ-528-AC-02: 確定した失敗（4xx）は表の本文を出し、その後の再押下は新しい requestKey', async () => {
    const user = userEvent.setup();
    setup(confirmedDetail(), 'close', [LINE_1]);
    await user.type(reason(), '打切り');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_NOTHING_TO_CLOSE', error: '打ち切る未納がありません。' }, 409));
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('打ち切る未納がありません。');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_FORBIDDEN', error: '発注を扱う権限がありません。' }, 403));
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('発注を扱う権限がありません。'));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
  });

  test('FREQ-528-AC-02: 版の競合（409）は表の本文を出して onStale を呼び、ダイアログは開いたまま理由を保つ。読み直しで版が変わったら、次の送信はその版（新しい requestKey）', async () => {
    const user = userEvent.setup();
    const { onStale, onSaved, onClose, rerenderWith } = setup(confirmedDetail(), 'close', [LINE_1]);
    await user.type(reason(), '打切り');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_VERSION_CONFLICT', error: STALE }, 409));
    await user.click(screen.getByRole('button', { name: '打ち切る' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(STALE);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(reason()).toHaveDisplayValue('打切り');

    rerenderWith({ ...confirmedDetail(), version: 5 });
    fetchMock.mockResolvedValueOnce(json({ version: 6, closedQuantity: 3, replayed: false }, 201));
    await user.click(screen.getByRole('button', { name: '打ち切る' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(1).expectedVersion).toBe(5);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1).reason).toBe('打切り');
  });

  test('FREQ-528-AC-01: ダイアログは画面いっぱいに開く設定（モバイル）', () => {
    setup(confirmedDetail(), 'close', [LINE_1]);
    expect(screen.getByRole('dialog', { name: '残りを打ち切る' }).closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
  });
});
