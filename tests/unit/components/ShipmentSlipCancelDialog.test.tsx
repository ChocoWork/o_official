import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShipmentSlipCancelDialog from '@/components/ShipmentSlipCancelDialog';
import { clientFetch } from '@/lib/client-fetch';
import { toOrderNumber } from '@/lib/orders/order-number';
import type { ShipmentSlipCancelBlocker } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { ORDER_ID, ORDER_ID_2, SLIP_ID } from '../lib/orders/shipment-slips/shipment-slip-fixtures';

/**
 * 発送の取消のダイアログ（G-3 Task 6 / FREQ-533-AC-04・FREQ-534-AC-03）。
 * 窓口（clientFetch）だけを差し替える。断りの本文はダイアログの中に出し、票は変えない。
 */
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_CANCEL = `/api/admin/shipment-slips/${SLIP_ID}/cancel`;
const DESCRIPTION = '票に含まれるすべての注文の発送を取り消し、品物を発送準備中に戻します。';
const CANCELLED = { id: SLIP_ID, version: 3, restoredQuantity: 4, replayed: false };
const UNKNOWN = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Slip = { id: string; version: number; cancelBlockers: ShipmentSlipCancelBlocker[] };
const slipOf = (overrides: Partial<Slip> = {}): Slip => ({ id: SLIP_ID, version: 2, cancelBlockers: [], ...overrides });

function setup(slip: Slip = slipOf()) {
  const handlers = { onClose: jest.fn(), onCancelled: jest.fn(), onStale: jest.fn() };
  const view = render(<ShipmentSlipCancelDialog slip={slip} {...handlers} />);
  const rerenderWith = (next: Slip) => view.rerender(<ShipmentSlipCancelDialog slip={next} {...handlers} />);
  return { ...handlers, rerenderWith };
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;
const submit = () => screen.getByRole('button', { name: '取り消す' });
const back = () => screen.getByRole('button', { name: '戻る' });

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('ShipmentSlipCancelDialog: 表示', () => {
  test('FREQ-533-AC-04: 見出し「発送を取り消す」・説明・ボタン「取り消す」「戻る」。何も送らない', () => {
    setup();
    expect(screen.getByRole('dialog', { name: '発送を取り消す' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '発送を取り消す' })).toBeInTheDocument();
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(submit()).toBeEnabled();
    expect(back()).toBeEnabled();
    expect(screen.queryByTestId('slip-cancel-blockers')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('FREQ-534-AC-03: cancelBlockers を持つ票は、ボタンの上に 返品の対象です・発送後に返金済みです・取り消せない状態です を注文番号つきで先に出す', () => {
    setup(slipOf({ cancelBlockers: [
      { orderId: ORDER_ID, reason: 'has_return' },
      { orderId: ORDER_ID_2, reason: 'refunded' },
      { orderId: ORDER_ID_2, reason: 'not_cancellable' },
    ] }));
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      `注文 ${toOrderNumber(ORDER_ID)} は返品の対象です`,
      `注文 ${toOrderNumber(ORDER_ID_2)} は発送後に返金済みです`,
      `注文 ${toOrderNumber(ORDER_ID_2)} は取り消せない状態です`,
    ]);
    // ボタンより前の位置に出る
    const list = screen.getByTestId('slip-cancel-blockers');
    expect(list.compareDocumentPosition(submit()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('FREQ-533-AC-04: 「戻る」は何も送らずに閉じる', async () => {
    const user = userEvent.setup();
    const { onClose, onCancelled, onStale } = setup();
    await user.click(back());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ShipmentSlipCancelDialog: 取り消す', () => {
  test('FREQ-533-AC-04: 「取り消す」で POST …/cancel へ expectedVersion・requestKey だけを送り、成功したら onCancelled（閉じるのも通知も親）', async () => {
    const user = userEvent.setup();
    const { onCancelled, onClose, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json(CANCELLED));
    await user.click(submit());

    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(URL_CANCEL);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({ expectedVersion: 2, requestKey: expect.stringMatching(UUID_PATTERN) });
  });

  test('FREQ-533-AC-04: 送信中は「取り消す」も「戻る」も押せず、閉じられない（Escape も効かない）。二重に押しても通信は1回', async () => {
    const user = userEvent.setup();
    const { onClose, onCancelled } = setup();
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    await user.click(submit());
    expect(submit()).toBeDisabled();
    expect(back()).toBeDisabled();
    await user.click(submit());
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    await act(async () => release(json(CANCELLED)));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  test.each([
    ['GROUP_G_SLIP_HAS_RETURN', '返品の対象になっている注文があるため、発送を取り消せません。'],
    ['GROUP_G_SLIP_REFUNDED', '発送後に返金した注文があるため、発送を取り消せません。'],
    ['GROUP_G_SLIP_CANCEL_NOT_ALLOWED', '取り消せない状態の注文があるため、発送を取り消せません。'],
    ['GROUP_G_SLIP_CANCELLED', 'この発送票は取り消されています。'],
  ])('FREQ-534-AC-03: DB の拒否 %s は表の本文をダイアログの中に出し、開いたまま親に読み直しを頼む（票は変えない）', async (code, message) => {
    const user = userEvent.setup();
    const { onCancelled, onClose, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({ code, error: 'PRIVATE-MARKER' }, 409));
    await user.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: '発送を取り消す' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(submit()).toBeEnabled();
    expect(back()).toBeEnabled();
  });

  test('FREQ-533-AC-04: 版が違って断られた（409）時は表の文を出して親に読み直しを頼む。次に押すと読み直した新しい版・新しい requestKey で送る', async () => {
    const user = userEvent.setup();
    const { rerenderWith, onCancelled, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_SLIP_VERSION_CONFLICT' }, 409));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('発送票が更新されました。内容を確認して、もう一度送ってください。');
    expect(onStale).toHaveBeenCalledTimes(1);

    rerenderWith(slipOf({ version: 5 }));
    fetchMock.mockResolvedValueOnce(json({ ...CANCELLED, version: 6 }));
    await user.click(submit());
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1).expectedVersion).toBe(5);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
  });

  test('FREQ-533-AC-04: 処理の前の断り（429）の後の再押下は同じ requestKey・同じ本文で送る', async () => {
    const user = userEvent.setup();
    const { onCancelled, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({}, 429));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onStale).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(CANCELLED));
    await user.click(submit());
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  test('FREQ-540-AC-10: 権限が無い（403）時は固定の文を出し、閉じずに読み直しも頼まない', async () => {
    const user = userEvent.setup();
    const { onStale, onCancelled } = setup();
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.shipping.manage', role: 'supporter' }, 403));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('発送を扱う権限がありません。');
    expect(onStale).not.toHaveBeenCalled();
    expect(onCancelled).not.toHaveBeenCalled();
  });

  test('FREQ-533-AC-04: 結果が分からない（500）時は入力を止め、「もう一度確かめる」で同じ requestKey・同じ本文を送り直す。成功で onCancelled', async () => {
    const user = userEvent.setup();
    const { onCancelled, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await user.click(submit());
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取り消す' })).not.toBeInTheDocument();
    expect(onStale).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json({ ...CANCELLED, replayed: true }));
    await user.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  test('FREQ-533-AC-04: 結果が分からないまま「戻る」を押すと、記録されたかもしれないので親に読み直しを頼んで閉じる', async () => {
    const user = userEvent.setup();
    const { onClose, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await user.click(submit());
    await screen.findByText(UNKNOWN);
    await user.click(back());
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
  });

  test('FREQ-533-AC-04: 通信が切れた時も結果不明として扱い、生の文を出さない', async () => {
    const user = userEvent.setup();
    setup();
    fetchMock.mockRejectedValueOnce(new Error('PRIVATE-MARKER'));
    await user.click(submit());
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
  });
});
