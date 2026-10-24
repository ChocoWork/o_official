import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PurchaseOrderQuantityDialog from '@/components/PurchaseOrderQuantityDialog';
import { clientFetch } from '@/lib/client-fetch';
import type { PurchaseOrderDetail } from '@/lib/purchase-orders/purchase-order-types';
import { confirmedDetail, LINE_1, LINE_2, orderedDetail, ORDER_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_QUANTITIES = `/api/admin/purchase-orders/${ORDER_ID}/quantities`;
const PRICE_HELP = '未入力は「単価未登録」、0 は 0 円として保存します。';
const BELOW = '納品済みの数より少ない数量には訂正できません。';
const STALE = '発注書が更新されました。内容を確認して、もう一度送ってください。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Handlers = { onClose: jest.Mock; onSaved: jest.Mock; onStale: jest.Mock };
function setup(purchaseOrder: PurchaseOrderDetail) {
  const handlers: Handlers = { onClose: jest.fn(), onSaved: jest.fn(), onStale: jest.fn() };
  const view = render(<PurchaseOrderQuantityDialog purchaseOrder={purchaseOrder} {...handlers} />);
  const rerenderWith = (next: PurchaseOrderDetail) => view.rerender(<PurchaseOrderQuantityDialog purchaseOrder={next} {...handlers} />);
  return { ...handlers, rerenderWith };
}

const rows = () => screen.getAllByTestId('purchase-order-quantity-row');
const quantityInput = (index: number) => within(rows()[index]).getByRole('spinbutton', { name: '数量' });
const priceInput = (index: number) => within(rows()[index]).getByRole('spinbutton', { name: '単価（円）' });
const submit = () => screen.getByRole('button', { name: '確定する' });
const back = () => screen.getByRole('button', { name: '戻る' });
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PurchaseOrderQuantityDialog: 数量の確定（段階が数量確定待ち）', () => {
  test('FREQ-527-AC-01: 見出し「数量の確定」。行ごとに「数量」（初期値=仮数量）と「単価（円）」（空欄）、説明の文、理由は任意、ボタンは「確定する」「戻る」', () => {
    setup(orderedDetail());
    expect(screen.getByRole('dialog', { name: '数量の確定' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '数量の確定' })).toBeInTheDocument();
    expect(rows()).toHaveLength(2);
    expect(quantityInput(0)).toHaveDisplayValue('5');
    expect(quantityInput(1)).toHaveDisplayValue('4');
    expect(priceInput(0)).toHaveDisplayValue('');
    expect(priceInput(1)).toHaveDisplayValue('');
    expect(rows()[0]).toHaveTextContent('シャツ BLACK M');
    expect(rows()[1]).toHaveTextContent('パンツ');
    expect(screen.getByText(PRICE_HELP)).toBeInTheDocument();
    expect(priceInput(0)).toHaveAccessibleDescription(expect.stringContaining(PRICE_HELP));
    expect(screen.getByRole('textbox', { name: '理由（任意）' })).toBeInTheDocument();
    expect(submit()).toBeEnabled();
    expect(back()).toBeEnabled();
  });

  test('FREQ-527-AC-01: 最初の確定は理由が空でも送れる。POST /quantities へ expectedVersion・全行・requestKey を送り（理由が空なら reason は送らない）、成功したら onSaved に「数量を確定しました。」を渡す', async () => {
    const user = userEvent.setup();
    const { onSaved, onStale, onClose } = setup(orderedDetail());
    fetchMock.mockResolvedValueOnce(json({ version: 2, changedLines: 1, replayed: false }, 201));
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '4');
    await user.type(priceInput(0), '1200');
    await user.type(priceInput(1), '0');
    await user.click(submit());

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('数量を確定しました。'));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(URL_QUANTITIES);
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({
      expectedVersion: 1,
      lines: [{ lineId: LINE_1, quantity: 4, unitPriceYen: 1200 }, { lineId: LINE_2, quantity: 4, unitPriceYen: 0 }],
      requestKey: expect.stringMatching(UUID_PATTERN),
    });
  });

  test('FREQ-527-AC-01: 単価の空欄は null（単価未登録）、0 は 0 円として送り、区別する。数量 0 も送れる', async () => {
    const user = userEvent.setup();
    const { onSaved } = setup(orderedDetail());
    fetchMock.mockResolvedValueOnce(json({ version: 2, changedLines: 2, replayed: false }, 201));
    await user.clear(quantityInput(1));
    await user.type(quantityInput(1), '0');
    await user.type(priceInput(0), '0');
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).lines).toEqual([{ lineId: LINE_1, quantity: 5, unitPriceYen: 0 }, { lineId: LINE_2, quantity: 0, unitPriceYen: null }]);
  });

  test('FREQ-527-AC-01: 理由を入れれば前後の空白を落として reason として送る', async () => {
    const user = userEvent.setup();
    const { onSaved } = setup(orderedDetail());
    fetchMock.mockResolvedValueOnce(json({ version: 2, changedLines: 0, replayed: false }, 201));
    await user.type(screen.getByRole('textbox', { name: '理由（任意）' }), '  工場から連絡  ');
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).reason).toBe('工場から連絡');
  });
});

describe('PurchaseOrderQuantityDialog: 数量の訂正（確定後）', () => {
  test('FREQ-527-AC-01: 見出し「数量の訂正」。初期値は確定数量と登録済みの単価（無ければ空欄）。理由は必須（「理由」）', () => {
    setup(confirmedDetail());
    expect(screen.getByRole('dialog', { name: '数量の訂正' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '数量の確定' })).not.toBeInTheDocument();
    expect(quantityInput(0)).toHaveDisplayValue('5');
    expect(quantityInput(1)).toHaveDisplayValue('3');
    expect(priceInput(0)).toHaveDisplayValue('1200');
    expect(priceInput(1)).toHaveDisplayValue('');
    const reason = screen.getByRole('textbox', { name: '理由' });
    expect(reason).toBeRequired();
    expect(screen.queryByRole('textbox', { name: '理由（任意）' })).not.toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  test('FREQ-527-AC-01: 理由が空・空白だけの間は「確定する」を押せない。入れると押せ、POST は expectedVersion（発注書の版）・reason つきで、成功したら「数量を訂正しました。」', async () => {
    const user = userEvent.setup();
    const { onSaved } = setup(confirmedDetail());
    fetchMock.mockResolvedValueOnce(json({ version: 3, changedLines: 1, replayed: false }, 201));
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '2');
    expect(submit()).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: '理由' }), '   ');
    expect(submit()).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: '理由' }), ' 納品済みまで減らす ');
    expect(submit()).toBeEnabled();
    await user.click(submit());

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('数量を訂正しました。'));
    expect(bodyOf(0)).toEqual({
      expectedVersion: 2,
      lines: [{ lineId: LINE_1, quantity: 2, unitPriceYen: 1200 }, { lineId: LINE_2, quantity: 3, unitPriceYen: null }],
      reason: '納品済みまで減らす',
      requestKey: expect.stringMatching(UUID_PATTERN),
    });
  });

  test('FREQ-527-AC-01: 納品済み未満の数量は、その行の下に「納品済みの数より少ない数量には訂正できません。」を出して送れない。納品済みちょうどなら出ない', async () => {
    const user = userEvent.setup();
    setup(confirmedDetail());
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    expect(screen.queryByText(BELOW)).not.toBeInTheDocument();
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '1');
    expect(within(rows()[0]).getByText(BELOW)).toBeInTheDocument();
    expect(within(rows()[1]).queryByText(BELOW)).not.toBeInTheDocument();
    expect(quantityInput(0)).toBeInvalid();
    expect(submit()).toBeDisabled();
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '2');
    expect(screen.queryByText(BELOW)).not.toBeInTheDocument();
    expect(submit()).toBeEnabled();
    expect(posts()).toHaveLength(0);
  });

  test.each([
    ['数量が空', 0, ''], ['数量が負', 0, '-1'], ['数量が小数', 0, '1.5'], ['数量が100000', 0, '100000'], ['数量が先頭0', 0, '01'],
  ])('FREQ-527-AC-01: %s は送れない', async (_name, index, value) => {
    const user = userEvent.setup();
    setup(confirmedDetail());
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    await user.clear(quantityInput(index));
    if (value) await user.type(quantityInput(index), value);
    expect(submit()).toBeDisabled();
  });

  test.each([['単価が負', '-1'], ['単価が小数', '1.5'], ['単価が10000000', '10000000']])('FREQ-527-AC-01: %s は送れない。9999999 と 0 と空欄は送れる', async (_name, value) => {
    const user = userEvent.setup();
    setup(confirmedDetail());
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    for (const ok of ['9999999', '0', '']) {
      await user.clear(priceInput(1));
      if (ok) await user.type(priceInput(1), ok);
      expect(submit()).toBeEnabled();
    }
    await user.clear(priceInput(1));
    await user.type(priceInput(1), value);
    expect(submit()).toBeDisabled();
  });
});

describe('PurchaseOrderQuantityDialog: 送信・失敗・再送・閉じる', () => {
  test('FREQ-527-AC-01: 送信中は「確定する」と「戻る」を押せず、閉じられない（Escape も効かない）。二重に押しても通信は1回', async () => {
    const user = userEvent.setup();
    const { onClose, onSaved } = setup(confirmedDetail());
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    await user.clear(quantityInput(1));
    await user.type(quantityInput(1), '4');
    await user.click(submit());
    expect(submit()).toBeDisabled();
    expect(back()).toBeDisabled();
    await user.click(submit());
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1);
    await act(async () => release(json({ version: 3, changedLines: 1, replayed: false }, 201)));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  test('FREQ-527-AC-01: 「戻る」と Escape で閉じる（送信中でなければ）。通信はしない', async () => {
    const user = userEvent.setup();
    const { onClose } = setup(confirmedDetail());
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
  ])('FREQ-527-AC-01: %s の後の再押下は、同じ requestKey と同じ本文で送る（二重に確定しない）。失敗の文は固定で、生の文を出さない', async (_name, arrange) => {
    const user = userEvent.setup();
    const { onSaved } = setup(confirmedDetail());
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '4');
    arrange();
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注の記録に失敗しました$/);
    expect(screen.queryByText(/PRIVATE-MARKER/)).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(submit()).toBeEnabled();

    fetchMock.mockResolvedValueOnce(json({ version: 3, changedLines: 1, replayed: true }, 201));
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-527-AC-01: 内容（数量・単価・理由）を変えて送り直すと新しい requestKey になる', async () => {
    const user = userEvent.setup();
    setup(confirmedDetail());
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '4');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(submit());
    await screen.findByRole('alert');

    await user.type(screen.getByRole('textbox', { name: '理由' }), 'です');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1).requestKey).toMatch(UUID_PATTERN);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1)).toMatchObject({ reason: '訂正です' });
  });

  test('FREQ-527-AC-02: 確定した失敗（4xx）の後の再押下は新しい requestKey。表の本文（理由が要る・納品済み未満・権限）をそのまま出す', async () => {
    const user = userEvent.setup();
    setup(confirmedDetail());
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '4');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_QUANTITY_BELOW_RECEIVED', error: BELOW }, 409));
    await user.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(BELOW);
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_FORBIDDEN', error: '発注を扱う権限がありません。' }, 403));
    await user.click(submit());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('発注を扱う権限がありません。'));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
  });

  test('FREQ-527-AC-02: 版の競合（409）は表の本文を出して onStale を呼び、ダイアログは開いたまま入力を保つ。発注書の読み直しで版が変わったら、次の送信はその版（新しい requestKey）', async () => {
    const user = userEvent.setup();
    const { onStale, onSaved, onClose, rerenderWith } = setup(confirmedDetail());
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '4');
    await user.type(priceInput(1), '500');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_VERSION_CONFLICT', error: STALE }, 409));
    await user.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(STALE);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(quantityInput(0)).toHaveDisplayValue('4');
    expect(priceInput(1)).toHaveDisplayValue('500');
    expect(screen.getByRole('textbox', { name: '理由' })).toHaveDisplayValue('訂正');

    // 親が発注書を読み直した（版 5）。入力は保たれ、送信は新しい版と新しい requestKey
    rerenderWith({ ...confirmedDetail(), version: 5 });
    expect(quantityInput(0)).toHaveDisplayValue('4');
    fetchMock.mockResolvedValueOnce(json({ version: 6, changedLines: 2, replayed: false }, 201));
    await user.click(submit());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(bodyOf(1).expectedVersion).toBe(5);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1).lines).toEqual([{ lineId: LINE_1, quantity: 4, unitPriceYen: 1200 }, { lineId: LINE_2, quantity: 3, unitPriceYen: 500 }]);
  });

  test('FREQ-527-AC-01: 通信が途中で切れた後の再押下は、発注書の版が読み直しで進んでいても、最初と同じ本文（最初の expectedVersion）と同じ requestKey で送る', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = setup(confirmedDetail());
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    await user.clear(quantityInput(0));
    await user.type(quantityInput(0), '4');
    fetchMock.mockRejectedValueOnce(new TypeError('network'));
    await user.click(submit());
    await screen.findByRole('alert');
    rerenderWith({ ...confirmedDetail(), version: 3 });
    fetchMock.mockResolvedValueOnce(json({ version: 3, changedLines: 1, replayed: true }, 201));
    await user.click(submit());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(bodyOf(1).expectedVersion).toBe(2);
  });

  test('FREQ-527-AC-01: ダイアログは画面いっぱいに開く設定（モバイル）で、行は縦に並ぶ一覧', () => {
    setup(confirmedDetail());
    const dialog = screen.getByRole('dialog', { name: '数量の訂正' });
    expect(dialog.closest('[data-ui-dialog]')).toHaveAttribute('data-ui-dialog-fullscreen', 'mobile');
    expect(within(dialog).getByRole('list')).toBeInTheDocument();
  });
});
