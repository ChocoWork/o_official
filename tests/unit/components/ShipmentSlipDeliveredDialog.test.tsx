import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShipmentSlipDeliveredDialog from '@/components/ShipmentSlipDeliveredDialog';
import { clientFetch } from '@/lib/client-fetch';
import { SLIP_ID } from '../lib/orders/shipment-slips/shipment-slip-fixtures';

/**
 * 手動の配達済みのダイアログ（G-3 Task 7 / FREQ-534-AC-02）。窓口（clientFetch）だけを差し替える。
 * 断りの本文はダイアログの中に出して入力を保ち、親に票の読み直しを頼む。送る流れは useDeliverySubmission。
 */
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_DELIVERED = `/api/admin/shipment-slips/${SLIP_ID}/delivered`;
const DESCRIPTION = '票に含まれるすべての注文を配達済みにします。';
const DELIVERED = { id: SLIP_ID, version: 3, deliveredAt: '2026-10-25T03:00:00.000Z', replayed: false };
const UNKNOWN = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';
const todayJst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Slip = { id: string; version: number };
const slipOf = (overrides: Partial<Slip> = {}): Slip => ({ id: SLIP_ID, version: 2, ...overrides });

function setup(slip: Slip = slipOf()) {
  const handlers = { onClose: jest.fn(), onDelivered: jest.fn(), onStale: jest.fn() };
  const view = render(<ShipmentSlipDeliveredDialog slip={slip} {...handlers} />);
  const rerenderWith = (next: Slip) => view.rerender(<ShipmentSlipDeliveredDialog slip={next} {...handlers} />);
  return { ...handlers, rerenderWith };
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;
const dateInput = () => screen.getByLabelText('届いた日') as HTMLInputElement;
const notifyBox = () => screen.getByLabelText('お客様に配達済みのメールを送る') as HTMLInputElement;
const back = () => screen.getByRole('button', { name: '戻る' });
const submit = () => screen.getByRole('button', { name: '配達済みにする' });

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('ShipmentSlipDeliveredDialog: 表示', () => {
  test('FREQ-534-AC-02: 見出し「配達済みにする」・説明・届いた日（初期値は今日）・通知オン・ボタン「配達済みにする」「戻る」。何も送らない', () => {
    setup();
    expect(screen.getByRole('dialog', { name: '配達済みにする' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '配達済みにする' })).toBeInTheDocument();
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(dateInput().type).toBe('date');
    expect(dateInput().value).toBe(todayJst());
    expect(dateInput().max).toBe(todayJst());
    expect(notifyBox()).toBeChecked();
    expect(submit()).toBeEnabled();
    expect(back()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('FREQ-534-AC-02: 「戻る」は何も送らずに閉じる', async () => {
    const user = userEvent.setup();
    const { onClose, onDelivered, onStale } = setup();
    await user.click(back());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelivered).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ShipmentSlipDeliveredDialog: 配達済みにする', () => {
  test('FREQ-534-AC-02: 「配達済みにする」で POST …/delivered へ expectedVersion・deliveredOn・notifyCustomer・requestKey だけを送り、成功したら onDelivered（閉じるのも通知も親）', async () => {
    const user = userEvent.setup();
    const { onDelivered, onClose, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json(DELIVERED));
    await user.click(submit());

    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(URL_DELIVERED);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({ expectedVersion: 2, deliveredOn: todayJst(), notifyCustomer: true, requestKey: expect.stringMatching(UUID_PATTERN) });
  });

  test('FREQ-534-AC-02: 届いた日を変え、通知をオフにして送ると、その値が本文に入る', async () => {
    const user = userEvent.setup();
    const { onDelivered } = setup();
    fetchMock.mockResolvedValueOnce(json(DELIVERED));
    fireEvent.change(dateInput(), { target: { value: '2026-10-20' } });
    await user.click(notifyBox());
    await user.click(submit());
    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    expect(bodyOf(0)).toMatchObject({ deliveredOn: '2026-10-20', notifyCustomer: false });
  });

  test('FREQ-534-AC-02: 届いた日が空なら窓口へ送らず「入力を確かめてください。」を出す', async () => {
    const user = userEvent.setup();
    setup();
    fireEvent.change(dateInput(), { target: { value: '' } });
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('FREQ-534-AC-02: 送信中は「配達済みにする」も「戻る」も入力も押せず、閉じられない（Escape も効かない）。二重に押しても通信は1回', async () => {
    const user = userEvent.setup();
    const { onClose, onDelivered } = setup();
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    await user.click(submit());
    expect(submit()).toBeDisabled();
    expect(back()).toBeDisabled();
    expect(dateInput()).toBeDisabled();
    expect(notifyBox()).toBeDisabled();
    await user.click(submit());
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    await act(async () => release(json(DELIVERED)));
    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  test.each([
    ['GROUP_G_SLIP_ALREADY_DELIVERED', 409, 'この発送票はすでに配達済みです。'],
    ['GROUP_G_SLIP_DELIVERY_DATE_INVALID', 400, '届いた日は、発送した日から今日までの日付にしてください。'],
    ['GROUP_G_SLIP_CANCELLED', 409, 'この発送票は取り消されています。'],
    ['GROUP_G_SLIP_NOT_CONFIRMED', 409, '発送が確定した発送票だけで行える操作です。'],
  ])('FREQ-534-AC-02: DB の拒否 %s は表の本文をダイアログの中に出し、入力を保って開いたまま親に読み直しを頼む', async (code, status, message) => {
    const user = userEvent.setup();
    const { onDelivered, onClose, onStale } = setup();
    fireEvent.change(dateInput(), { target: { value: '2026-10-20' } });
    fetchMock.mockResolvedValueOnce(json({ code, error: 'PRIVATE-MARKER' }, status));
    await user.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: '配達済みにする' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onDelivered).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dateInput().value).toBe('2026-10-20');
    expect(submit()).toBeEnabled();
    expect(back()).toBeEnabled();
  });

  test('FREQ-534-AC-02: 版が違って断られた（409）時は入力を保ち、読み直した新しい版・新しい requestKey で送り直せる', async () => {
    const user = userEvent.setup();
    const { rerenderWith, onDelivered, onStale } = setup();
    fireEvent.change(dateInput(), { target: { value: '2026-10-21' } });
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_SLIP_VERSION_CONFLICT' }, 409));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('発送票が更新されました。内容を確認して、もう一度送ってください。');
    expect(onStale).toHaveBeenCalledTimes(1);

    rerenderWith(slipOf({ version: 5 }));
    expect(dateInput().value).toBe('2026-10-21');
    fetchMock.mockResolvedValueOnce(json({ ...DELIVERED, version: 6 }));
    await user.click(submit());
    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toMatchObject({ expectedVersion: 5, deliveredOn: '2026-10-21' });
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
  });

  test('FREQ-534-AC-02: 処理の前の断り（429）の後の再押下は同じ requestKey・同じ本文で送り、読み直しは頼まない', async () => {
    const user = userEvent.setup();
    const { onDelivered, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({}, 429));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onStale).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(DELIVERED));
    await user.click(submit());
    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  test('FREQ-540-AC-10: 権限が無い（403）時は固定の文を出し、閉じずに読み直しも頼まない', async () => {
    const user = userEvent.setup();
    const { onStale, onDelivered } = setup();
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.shipping.manage', role: 'supporter' }, 403));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('発送を扱う権限がありません。');
    expect(onStale).not.toHaveBeenCalled();
    expect(onDelivered).not.toHaveBeenCalled();
  });

  test('FREQ-534-AC-02: 結果が分からない（500）時は入力を止め、「もう一度確かめる」で同じ requestKey・同じ本文を送り直す。成功で onDelivered', async () => {
    const user = userEvent.setup();
    const { onDelivered, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await user.click(submit());
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '配達済みにする' })).not.toBeInTheDocument();
    expect(dateInput()).toBeDisabled();
    expect(notifyBox()).toBeDisabled();
    expect(onStale).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json({ ...DELIVERED, replayed: true }));
    await user.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onDelivered).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  test('FREQ-534-AC-02: 結果が分からないまま「戻る」を押すと、記録されたかもしれないので親に読み直しを頼んで閉じる', async () => {
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

  test('FREQ-534-AC-02: 通信が切れた時も結果不明として扱い、生の文を出さない', async () => {
    const user = userEvent.setup();
    setup();
    fetchMock.mockRejectedValueOnce(new Error('PRIVATE-MARKER'));
    await user.click(submit());
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
  });
});
