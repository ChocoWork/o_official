import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShipmentSlipTrackingDialog from '@/components/ShipmentSlipTrackingDialog';
import { clientFetch } from '@/lib/client-fetch';
import type { ShipmentSlipDetail } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SLIP_ID } from '../lib/orders/shipment-slips/shipment-slip-fixtures';

/**
 * 伝票番号を入れる・直すダイアログ（G-3 Task 7 / FREQ-534-AC-01）。窓口（clientFetch）だけを差し替える。
 * 断りの本文はダイアログの中に出して入力を保ち、親に票の読み直しを頼む。送る流れは useDeliverySubmission。
 */
jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_TRACKING = `/api/admin/shipment-slips/${SLIP_ID}/tracking`;
const DESCRIPTION = '票に含まれるすべての注文に反映します。';
const UPDATED = { id: SLIP_ID, version: 3, trackingVersion: 2, replayed: false };
const UNKNOWN = '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Slip = Pick<ShipmentSlipDetail, 'id' | 'version' | 'carrier' | 'trackingNumber'>;
const withNumber = (overrides: Partial<Slip> = {}): Slip => ({ id: SLIP_ID, version: 3, carrier: 'yamato', trackingNumber: 'ab-123', ...overrides });
const withoutNumber = (overrides: Partial<Slip> = {}): Slip => ({ id: SLIP_ID, version: 2, carrier: null, trackingNumber: null, ...overrides });

function setup(slip: Slip = withNumber()) {
  const handlers = { onClose: jest.fn(), onUpdated: jest.fn(), onStale: jest.fn() };
  const view = render(<ShipmentSlipTrackingDialog slip={slip} {...handlers} />);
  const rerenderWith = (next: Slip) => view.rerender(<ShipmentSlipTrackingDialog slip={next} {...handlers} />);
  return { ...handlers, rerenderWith };
}

const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;
const carrierSelect = () => screen.getByLabelText('運送会社') as HTMLSelectElement;
const numberInput = () => screen.getByLabelText('伝票番号') as HTMLInputElement;
const notifyBox = () => screen.getByLabelText('お客様に更新のメールを送る') as HTMLInputElement;
const back = () => screen.getByRole('button', { name: '戻る' });
const submit = (name = '直す') => screen.getByRole('button', { name });

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('ShipmentSlipTrackingDialog: 表示', () => {
  test('FREQ-534-AC-01: 番号がある票は 見出し「伝票番号を直す」・説明・運送会社と伝票番号の今の値・通知オン・ボタン「直す」「戻る」。何も送らない', () => {
    setup();
    expect(screen.getByRole('dialog', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(carrierSelect().value).toBe('yamato');
    expect(Array.from(carrierSelect().options).map((option) => [option.value, option.textContent])).toEqual([
      ['yamato', 'ヤマト運輸'], ['sagawa', '佐川急便'], ['japanpost', '日本郵便'],
    ]);
    expect(numberInput().value).toBe('ab-123');
    expect(notifyBox()).toBeChecked();
    expect(submit()).toBeEnabled();
    expect(back()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '入れる' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('FREQ-534-AC-01: 番号が無い票は 見出し・ボタンが「伝票番号を入れる」「入れる」で、番号は空、運送会社は何も選ばれていない（先頭に「選んでください」）', () => {
    setup(withoutNumber());
    expect(screen.getByRole('dialog', { name: '伝票番号を入れる' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '伝票番号を入れる' })).toBeInTheDocument();
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();
    expect(numberInput().value).toBe('');
    expect(carrierSelect().value).toBe('');
    expect(Array.from(carrierSelect().options).map((option) => [option.value, option.textContent])).toEqual([
      ['', '選んでください'], ['yamato', 'ヤマト運輸'], ['sagawa', '佐川急便'], ['japanpost', '日本郵便'],
    ]);
    expect(notifyBox()).toBeChecked();
    expect(submit('入れる')).toBeEnabled();
    expect(screen.queryByRole('button', { name: '直す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '伝票番号を直す' })).not.toBeInTheDocument();
  });

  test('FREQ-534-AC-01: 番号が無い票で運送会社を選ばずに番号だけ入れて「入れる」を押しても送らない（違う運送会社が全注文に入らない）。選べば送れる', async () => {
    const user = userEvent.setup();
    const { onUpdated } = setup(withoutNumber());
    await user.type(numberInput(), 'jp-9');
    await user.click(submit('入れる'));
    expect(await screen.findByRole('alert')).toHaveTextContent('運送会社と伝票番号は、両方入れるか両方空にしてください。');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(carrierSelect().value).toBe('');
    expect(numberInput().value).toBe('jp-9');

    fetchMock.mockResolvedValueOnce(json(UPDATED));
    await user.selectOptions(carrierSelect(), 'sagawa');
    await user.click(submit('入れる'));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
    expect(bodyOf(0)).toMatchObject({ carrier: 'sagawa', trackingNumber: 'jp-9' });
  });

  test('FREQ-534-AC-01: 運送会社がある票は今の値で始まり、「選んでください」の選択肢は出さない', () => {
    setup(withNumber({ carrier: 'japanpost' }));
    expect(carrierSelect().value).toBe('japanpost');
    expect(Array.from(carrierSelect().options).map((option) => option.value)).toEqual(['yamato', 'sagawa', 'japanpost']);
    expect(screen.queryByRole('option', { name: '選んでください' })).not.toBeInTheDocument();
  });

  test('FREQ-534-AC-01: 「戻る」は何も送らずに閉じる', async () => {
    const user = userEvent.setup();
    const { onClose, onUpdated, onStale } = setup();
    await user.click(back());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onUpdated).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ShipmentSlipTrackingDialog: 直す', () => {
  test('FREQ-534-AC-01: 「直す」で POST …/tracking へ expectedVersion・carrier・trackingNumber・notifyCustomer・requestKey だけを送り、成功したら onUpdated（閉じるのも通知も親）', async () => {
    const user = userEvent.setup();
    const { onUpdated, onClose, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json(UPDATED));
    await user.click(submit());

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(URL_TRACKING);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({ expectedVersion: 3, carrier: 'yamato', trackingNumber: 'ab-123', notifyCustomer: true, requestKey: expect.stringMatching(UUID_PATTERN) });
  });

  test('FREQ-534-AC-01: 番号が無い票へ運送会社と番号を入れ、通知をオフにして「入れる」で送る。番号の前後の空白は取る', async () => {
    const user = userEvent.setup();
    const { onUpdated } = setup(withoutNumber());
    fetchMock.mockResolvedValueOnce(json(UPDATED));
    await user.selectOptions(carrierSelect(), 'japanpost');
    await user.type(numberInput(), '  jp-9  ');
    await user.click(notifyBox());
    expect(notifyBox()).not.toBeChecked();
    await user.click(submit('入れる'));

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(bodyOf(0)).toEqual({ expectedVersion: 2, carrier: 'japanpost', trackingNumber: 'jp-9', notifyCustomer: false, requestKey: expect.stringMatching(UUID_PATTERN) });
  });

  test('FREQ-534-AC-01: 番号を空にしては送れない（空には戻せない）。窓口へは送らず「運送会社と伝票番号は、両方入れるか両方空にしてください。」を出す', async () => {
    const user = userEvent.setup();
    setup();
    await user.clear(numberInput());
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('運送会社と伝票番号は、両方入れるか両方空にしてください。');
    await user.clear(numberInput());
    await user.type(numberInput(), '   ');
    await user.click(submit());
    expect(screen.getByRole('alert')).toHaveTextContent('運送会社と伝票番号は、両方入れるか両方空にしてください。');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '伝票番号を直す' })).toBeInTheDocument();
  });

  test.each(['bad number!', 'ＡＢ１２', 'A'.repeat(65)])('FREQ-534-AC-01: 書式に合わない番号（%s）は窓口へ送らず「入力を確かめてください。」を出し、入力を保つ', async (value) => {
    const user = userEvent.setup();
    setup();
    fireEvent.change(numberInput(), { target: { value } });
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(numberInput().value).toBe(value);
  });

  test('FREQ-534-AC-01: 送信中は「直す」も「戻る」も入力も押せず、閉じられない（Escape も効かない）。二重に押しても通信は1回で、同じ requestKey', async () => {
    const user = userEvent.setup();
    const { onClose, onUpdated } = setup();
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    await user.click(submit());
    expect(submit()).toBeDisabled();
    expect(back()).toBeDisabled();
    expect(numberInput()).toBeDisabled();
    expect(carrierSelect()).toBeDisabled();
    expect(notifyBox()).toBeDisabled();
    await user.click(submit());
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    await act(async () => release(json(UPDATED)));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  test.each([
    ['GROUP_G_SLIP_TRACKING_UNCHANGED', 409, '運送会社も伝票番号も変わっていません。'],
    ['GROUP_G_SLIP_TRACKING_INCOMPLETE', 400, '運送会社と伝票番号は、両方入れるか両方空にしてください。'],
    ['GROUP_G_SLIP_CANCELLED', 409, 'この発送票は取り消されています。'],
    ['GROUP_G_SLIP_NOT_CONFIRMED', 409, '発送が確定した発送票だけで行える操作です。'],
    ['GROUP_G_REQUEST_KEY_CONFLICT', 409, '同じ要求番号で異なる操作は実行できません。'],
  ])('FREQ-534-AC-01: DB の拒否 %s は表の本文をダイアログの中に出し、入力を保って開いたまま親に読み直しを頼む', async (code, status, message) => {
    const user = userEvent.setup();
    const { onUpdated, onClose, onStale } = setup();
    await user.selectOptions(carrierSelect(), 'sagawa');
    fetchMock.mockResolvedValueOnce(json({ code, error: 'PRIVATE-MARKER' }, status));
    await user.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog', { name: '伝票番号を直す' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onUpdated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(carrierSelect().value).toBe('sagawa');
    expect(numberInput().value).toBe('ab-123');
    expect(submit()).toBeEnabled();
    expect(back()).toBeEnabled();
  });

  test('FREQ-534-AC-01: 版が違って断られた（409）時は入力を保ち、読み直した新しい版・新しい requestKey で送り直せる', async () => {
    const user = userEvent.setup();
    const { rerenderWith, onUpdated, onStale } = setup();
    await user.clear(numberInput());
    await user.type(numberInput(), 'KEEP-1');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_SLIP_VERSION_CONFLICT' }, 409));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('発送票が更新されました。内容を確認して、もう一度送ってください。');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(numberInput().value).toBe('KEEP-1');

    rerenderWith(withNumber({ version: 5, carrier: 'sagawa', trackingNumber: 'other-1' }));
    expect(numberInput().value).toBe('KEEP-1');
    fetchMock.mockResolvedValueOnce(json({ ...UPDATED, version: 6 }));
    await user.click(submit());
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toMatchObject({ expectedVersion: 5, trackingNumber: 'KEEP-1' });
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
  });

  test('FREQ-534-AC-01: 処理の前の断り（429）の後の再押下は同じ requestKey・同じ本文で送り、読み直しは頼まない', async () => {
    const user = userEvent.setup();
    const { onUpdated, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({}, 429));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onStale).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(UPDATED));
    await user.click(submit());
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  test('FREQ-540-AC-10: 権限が無い（403）時は固定の文を出し、閉じずに読み直しも頼まない', async () => {
    const user = userEvent.setup();
    const { onStale, onUpdated } = setup();
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.shipping.manage', role: 'supporter' }, 403));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('発送を扱う権限がありません。');
    expect(onStale).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  test('FREQ-534-AC-01: 結果が分からない（500）時は入力を止め、「もう一度確かめる」で同じ requestKey・同じ本文を送り直す。成功で onUpdated', async () => {
    const user = userEvent.setup();
    const { onUpdated, onStale } = setup();
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await user.click(submit());
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '直す' })).not.toBeInTheDocument();
    expect(numberInput()).toBeDisabled();
    expect(carrierSelect()).toBeDisabled();
    expect(notifyBox()).toBeDisabled();
    expect(onStale).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json({ ...UPDATED, replayed: true }));
    await user.click(screen.getByRole('button', { name: 'もう一度確かめる' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
  });

  test('FREQ-534-AC-01: 結果が分からないまま「戻る」を押すと、記録されたかもしれないので親に読み直しを頼んで閉じる', async () => {
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

  test('FREQ-534-AC-01: 通信が切れた時も結果不明として扱い、生の文を出さない', async () => {
    const user = userEvent.setup();
    setup();
    fetchMock.mockRejectedValueOnce(new Error('PRIVATE-MARKER'));
    await user.click(submit());
    expect(await screen.findByText(UNKNOWN)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('PRIVATE-MARKER');
  });
});
