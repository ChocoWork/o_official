import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminInventorySection from '@/components/AdminInventorySection';
import { clientFetch } from '@/lib/client-fetch';
import type { AdminInventoryRow } from '@/lib/inventory/inventory-list-types';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
const fetchMock = jest.mocked(clientFetch);

const ACTIVE: AdminInventoryRow = {
  variantId: 11, itemId: 7, itemName: 'シャツ', colorName: 'BLACK', sizeLabel: 'M', isActive: true,
  free: 0, paidAllocated: 2, paymentHeld: 1, onHand: 3, orderQuantity: 5, onOrder: 1, required: 1,
};
const RETIRED: AdminInventoryRow = {
  variantId: 12, itemId: 7, itemName: 'シャツ', colorName: null, sizeLabel: null, isActive: false,
  free: 4, paidAllocated: 0, paymentHeld: 0, onHand: 4, orderQuantity: 0, onOrder: 0, required: 0,
};
const HEADERS = ['商品名', '色', 'サイズ', '注文数', '在庫', '発注済み', '発注必要数'];

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function loaded(rows: AdminInventoryRow[] = [ACTIVE, RETIRED]) {
  fetchMock.mockResolvedValueOnce(json({ rows }));
  render(<AdminInventorySection />);
  await screen.findByRole('table');
}

beforeEach(() => {
  fetchMock.mockReset();
  mockPush.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('AdminInventorySection', () => {
  test('FREQ-525-AC-01: 見出しの h1 と「管理画面に戻る」(/admin) を出し、窓口を no-store で1回だけ読む', async () => {
    await loaded();
    expect(screen.getByRole('heading', { level: 1, name: '在庫一覧表' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '管理画面に戻る' })).toHaveAttribute('href', '/admin');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/inventory', { cache: 'no-store' });
  });

  test('FREQ-525-AC-01: 読込中は「読み込み中...」を role=status で出し、表を出さない', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    render(<AdminInventorySection />);
    expect(screen.getByRole('status')).toHaveTextContent(/^読み込み中\.\.\.$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    release(json({ rows: [ACTIVE] }));
    await screen.findByRole('table');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('FREQ-525-AC-01: 列見出しは「商品名・色・サイズ・注文数・在庫・発注済み・発注必要数」の7つがこの順', async () => {
    await loaded();
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader');
    expect(headers.map((header) => header.textContent)).toEqual(HEADERS);
  });

  test('FREQ-525-AC-01: 行は商品名・色・サイズ・注文数・在庫(onHand)・発注済み・発注必要数の順に値を出す', async () => {
    await loaded();
    const [first] = screen.getAllByTestId('inventory-row');
    const cells = within(first).getAllByRole('cell');
    expect(cells).toHaveLength(7);
    expect(cells[0]).toHaveTextContent('シャツ');
    expect(cells[1]).toHaveTextContent('BLACK');
    expect(cells[2]).toHaveTextContent('M');
    expect(cells[3]).toHaveTextContent(/^5$/);
    expect(cells[4]).toHaveTextContent(/^3/);
    expect(cells[5]).toHaveTextContent(/^1$/);
    expect(cells[6]).toHaveTextContent(/^1$/);
  });

  test('FREQ-525-AC-02: 色・サイズが無い variant は「—」で出し、停止した variant も同じ7つのセルの行で出る', async () => {
    await loaded();
    const [, second] = screen.getAllByTestId('inventory-row');
    const cells = within(second).getAllByRole('cell');
    expect(cells).toHaveLength(7);
    expect(cells[0]).toHaveTextContent(/^シャツ$/);
    expect(cells[1]).toHaveTextContent('—');
    expect(cells[2]).toHaveTextContent('—');
  });

  test('FREQ-525-AC-01: 「在庫の内訳」ボタンで 空き・入金済みの割当・支払い前の仮確保 を行ごとに開閉する', async () => {
    const user = userEvent.setup();
    await loaded();
    const buttons = screen.getAllByRole('button', { name: '在庫の内訳' });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/空き \d+/)).not.toBeInTheDocument();

    await user.click(buttons[0]);
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('空き 0・入金済みの割当 2・支払い前の仮確保 1')).toBeVisible();
    // 開いたのは1行だけ
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('空き 4・入金済みの割当 0・支払い前の仮確保 0')).not.toBeInTheDocument();

    await user.click(buttons[1]);
    expect(screen.getByText('空き 4・入金済みの割当 0・支払い前の仮確保 0')).toBeVisible();

    await user.click(buttons[0]);
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('空き 0・入金済みの割当 2・支払い前の仮確保 1')).not.toBeInTheDocument();
  });

  test('FREQ-525-AC-01: キーボードの Enter・Space で内訳を開け、行そのものは押しても何も起きない', async () => {
    const user = userEvent.setup();
    await loaded();
    const [button] = screen.getAllByRole('button', { name: '在庫の内訳' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getAllByTestId('inventory-row')[0]);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('FREQ-525-AC-01: 表は見出しを保ったスクロール領域に入り、頁全体を横に広げない', async () => {
    await loaded();
    const region = screen.getByRole('region', { name: '在庫一覧表' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toMatch(/overflow-auto/);
    expect(region.className).toMatch(/max-w-full/);
    expect(region.className).toMatch(/max-h-/);
    expect(within(region).getByRole('table')).toBeInTheDocument();
    for (const header of screen.getAllByRole('columnheader')) expect(header.className).toMatch(/sticky/);
    expect(region.parentElement?.className).toMatch(/min-w-0/);
  });

  test('FREQ-525-AC-01: 行が無ければ「表示する商品がありません。」だけで、表もボタンも出さない', async () => {
    fetchMock.mockResolvedValueOnce(json({ rows: [] }));
    render(<AdminInventorySection />);
    expect(await screen.findByText('表示する商品がありません。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '在庫一覧表' })).toBeInTheDocument();
  });

  test('FREQ-540-AC-07: 403 は「在庫一覧を見る権限がありません。」を role=alert で出し、表もボタンも出さない', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.stock.read' }, 403));
    render(<AdminInventorySection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^在庫一覧を見る権限がありません。$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('表示する商品がありません。')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '管理画面に戻る' })).toHaveAttribute('href', '/admin');
  });

  test('FREQ-540-AC-07: DB が断った 403（本文が日本語）も同じ文', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: '在庫一覧を見る権限がありません。', code: 'GROUP_G_FORBIDDEN' }, 403));
    render(<AdminInventorySection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^在庫一覧を見る権限がありません。$/);
  });

  test('FREQ-540-AC-07: 2要素認証が無い 403 は「権限がありません」ではなく「2要素認証が必要です」', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', reason: 'MFA required' }, 403));
    render(<AdminInventorySection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^2要素認証が必要です$/);
    expect(screen.queryByText('在庫一覧を見る権限がありません。')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('FREQ-540-AC-07: 401 は「ログインし直してください。」', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401));
    render(<AdminInventorySection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^ログインし直してください。$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test.each([
    ['500', () => fetchMock.mockResolvedValueOnce(json({ error: '在庫一覧を読み込めませんでした。' }, 500))],
    ['通信の失敗', () => fetchMock.mockRejectedValueOnce(new TypeError('PRIVATE-MARKER'))],
    ['rows が無い 200', () => fetchMock.mockResolvedValueOnce(json({}))],
    ['rows が配列でない 200', () => fetchMock.mockResolvedValueOnce(json({ rows: 'x' }))],
    ['本文が JSON でない 200', () => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE-MARKER'); } } as unknown as Response)],
  ])('FREQ-525-AC-01: 失敗(%s)は「在庫一覧を読み込めませんでした。時間をおいて再度お試しください。」で、生の文を出さない', async (_name, arrange) => {
    arrange();
    render(<AdminInventorySection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^在庫一覧を読み込めませんでした。時間をおいて再度お試しください。$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE-MARKER/)).not.toBeInTheDocument();
  });
});

const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const PO_NUMBER = 'PO-20261025-0001';
const QTY_ACTIVE = 'シャツ BLACK M の発注数量';
const QTY_RETIRED = 'シャツ の発注数量';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATED = { id: ORDER_ID, number: PO_NUMBER, version: 1, replayed: false };

describe('AdminInventorySection: 発注（入力 → 確認 → 確定）', () => {
  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;
  type User = ReturnType<typeof userEvent.setup>;

  async function startOrder(user: User) {
    await loaded();
    await user.click(screen.getByRole('button', { name: '発注' }));
  }

  /** 入力の段で、最初の行に 5 を入れて確認の段へ進む */
  async function toConfirm(user: User) {
    await startOrder(user);
    await user.type(screen.getByRole('spinbutton', { name: QTY_ACTIVE }), '5');
    await user.click(screen.getByRole('button', { name: '発注書確認' }));
    await screen.findByRole('heading', { level: 2, name: '発注書の確認' });
  }

  const confirmButton = () => screen.getByRole('button', { name: '発注確定' });

  test('FREQ-526-AC-01: 「発注」で発注モードに入り、各行に空欄の「発注数量」入力が出る。発注必要数の列は見えたまま', async () => {
    const user = userEvent.setup();
    await startOrder(user);
    expect(screen.getByRole('spinbutton', { name: QTY_ACTIVE })).toHaveDisplayValue('');
    expect(screen.getByRole('spinbutton', { name: QTY_RETIRED })).toHaveDisplayValue('');
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2);
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual([...HEADERS, '発注数量']);
    const [first] = screen.getAllByTestId('inventory-row');
    expect(within(first).getAllByRole('cell')[6]).toHaveTextContent(/^1$/);
    expect(screen.getByRole('button', { name: '発注書確認' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '発注' })).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-01: 発注モードに入る前は入力欄も「発注書確認」も出ない', async () => {
    await loaded();
    expect(screen.getByRole('button', { name: '発注' })).toBeEnabled();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '発注書確認' })).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-01: 「発注書確認」は正の整数（1〜99999）が1行以上ある時だけ押せる', async () => {
    const user = userEvent.setup();
    await startOrder(user);
    const first = screen.getByRole('spinbutton', { name: QTY_ACTIVE });
    const confirm = screen.getByRole('button', { name: '発注書確認' });
    for (const invalid of ['0', '-1', '1.5', '100000']) {
      await user.clear(first);
      await user.type(first, invalid);
      expect(confirm).toBeDisabled();
    }
    await user.clear(first);
    await user.type(first, '5');
    expect(confirm).toBeEnabled();
    await user.clear(first);
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('spinbutton', { name: QTY_RETIRED }), '99999');
    expect(confirm).toBeEnabled();
  });

  test('FREQ-526-AC-01: 入力した発注数量は、他の列の操作（在庫の内訳の開閉）で消えない', async () => {
    const user = userEvent.setup();
    await startOrder(user);
    const first = screen.getByRole('spinbutton', { name: QTY_ACTIVE });
    await user.type(first, '5');
    await user.click(screen.getAllByRole('button', { name: '在庫の内訳' })[0]);
    expect(screen.getByRole('spinbutton', { name: QTY_ACTIVE })).toHaveDisplayValue('5');
    await user.click(screen.getAllByRole('button', { name: '在庫の内訳' })[0]);
    expect(screen.getByRole('spinbutton', { name: QTY_ACTIVE })).toHaveDisplayValue('5');
    expect(screen.getByRole('button', { name: '発注書確認' })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('FREQ-526-AC-01: 「キャンセル」で発注モードを抜け、入れ直すと空欄から始まる', async () => {
    const user = userEvent.setup();
    await startOrder(user);
    await user.type(screen.getByRole('spinbutton', { name: QTY_ACTIVE }), '5');
    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '発注' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '発注' }));
    expect(screen.getByRole('spinbutton', { name: QTY_ACTIVE })).toHaveDisplayValue('');
    expect(posts()).toHaveLength(0);
  });

  test('FREQ-526-AC-01: 確認の段は「発注書の確認」の見出しで、正の整数を入れた行だけを一覧し、納期の欄は無い', async () => {
    const user = userEvent.setup();
    await startOrder(user);
    await user.type(screen.getByRole('spinbutton', { name: QTY_ACTIVE }), '5');
    await user.type(screen.getByRole('spinbutton', { name: QTY_RETIRED }), '0');
    await user.click(screen.getByRole('button', { name: '発注書確認' }));

    expect(await screen.findByRole('heading', { level: 2, name: '発注書の確認' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['商品名', '色', 'サイズ', '発注数量']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['シャツ', 'BLACK', 'M', '5']);
    expect(screen.getByRole('textbox', { name: '発注先' })).toHaveAttribute('maxlength', '100');
    expect(screen.getByRole('textbox', { name: '発注先' })).toBeRequired();
    expect(screen.getByRole('textbox', { name: 'メモ' })).toHaveAttribute('maxlength', '500');
    expect(screen.queryByText(/納期/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/納期/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '発注確定' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '戻る' })).toBeEnabled();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('FREQ-526-AC-01: 確認の段の色・サイズが無い行は、有る部分だけを出す', async () => {
    const user = userEvent.setup();
    await startOrder(user);
    await user.type(screen.getByRole('spinbutton', { name: QTY_RETIRED }), '2');
    await user.click(screen.getByRole('button', { name: '発注書確認' }));
    const row = within(await screen.findByRole('table')).getAllByRole('row')[1];
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['シャツ', '—', '—', '2']);
  });

  test('FREQ-526-AC-01: 「戻る」で入力の段に戻り、入れた発注数量はそのまま残る', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    await user.click(screen.getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('heading', { name: '発注書の確認' })).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: QTY_ACTIVE })).toHaveDisplayValue('5');
    expect(screen.getByRole('spinbutton', { name: QTY_RETIRED })).toHaveDisplayValue('');
    expect(posts()).toHaveLength(0);
  });

  test.each([['空', ''], ['空白だけ', '   ']])('FREQ-526-AC-01: 発注先が%sなら「発注先を入力してください。」で、通信しない', async (_name, value) => {
    const user = userEvent.setup();
    await toConfirm(user);
    if (value) await user.type(screen.getByRole('textbox', { name: '発注先' }), value);
    await user.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注先を入力してください。$/);
    expect(posts()).toHaveLength(0);
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('FREQ-526-AC-01: 発注確定で /api/admin/purchase-orders へ POST し、成功したら目印 created=1 を付けて発注書の頁へ移る（通知は移動先の頁が出すので、この部品には出さない）', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    fetchMock.mockResolvedValueOnce(json(CREATED, 201));
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '  工場A  ');
    await user.type(screen.getByRole('textbox', { name: 'メモ' }), '春の追加分');
    await user.click(confirmButton());

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/admin/purchase-orders/${ORDER_ID}?created=1`));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe('/api/admin/purchase-orders');
    expect(posts()[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({
      supplierName: '工場A', memo: '春の追加分', lines: [{ variantId: 11, quantity: 5 }], requestKey: expect.stringMatching(UUID_PATTERN),
    });
    // 移動で消える通知はここには置かない（発注書の頁が created=1 を見て出す）
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/を作成しました/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-02: メモが空なら memo の項目は送らない', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    fetchMock.mockResolvedValueOnce(json(CREATED, 201));
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    await user.click(confirmButton());
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(Object.keys(bodyOf(0))).toEqual(['supplierName', 'lines', 'requestKey']);
  });

  test('FREQ-526-AC-02: 送信中は「発注確定」を押せず、二重に押しても通信は1回', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    await user.click(confirmButton());
    expect(confirmButton()).toBeDisabled();
    await user.click(confirmButton());
    await user.keyboard('{Enter}');
    expect(posts()).toHaveLength(1);
    await act(async () => release(json(CREATED, 201)));
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  test.each([
    ['通信の失敗', () => fetchMock.mockRejectedValueOnce(new TypeError('PRIVATE-MARKER'))],
    ['500', () => fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500))],
    ['201 だが本文が読めない', () => fetchMock.mockResolvedValueOnce(json({}, 201))],
  ])('FREQ-526-AC-03: %s の後の再押下は、同じ requestKey と同じ本文で送る（二重に作らない）', async (_name, arrange) => {
    const user = userEvent.setup();
    await toConfirm(user);
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    arrange();
    await user.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注の記録に失敗しました$/);
    expect(screen.queryByText(/PRIVATE-MARKER/)).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
    expect(confirmButton()).toBeEnabled();

    fetchMock.mockResolvedValueOnce(json({ ...CREATED, replayed: true }, 201));
    await user.click(confirmButton());
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-03: 内容を変えて送り直すと、新しい requestKey になる', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(confirmButton());
    await screen.findByRole('alert');

    await user.type(screen.getByRole('textbox', { name: 'メモ' }), '追記');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(confirmButton());
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(1).requestKey).toMatch(UUID_PATTERN);
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1)).toMatchObject({ supplierName: '工場A', memo: '追記' });
  });

  test('FREQ-526-AC-03: 入力の段で数量を変えて確認し直しても新しい requestKey になる', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(confirmButton());
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: '戻る' }));
    await user.clear(screen.getByRole('spinbutton', { name: QTY_ACTIVE }));
    await user.type(screen.getByRole('spinbutton', { name: QTY_ACTIVE }), '6');
    await user.click(screen.getByRole('button', { name: '発注書確認' }));
    await user.type(await screen.findByRole('textbox', { name: '発注先' }), '工場A');
    fetchMock.mockResolvedValueOnce(json(CREATED, 201));
    await user.click(confirmButton());
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect(bodyOf(1)).toMatchObject({ lines: [{ variantId: 11, quantity: 6 }] });
  });

  test('FREQ-526-AC-02: 明細は画面の並びのまま、正の整数の行だけを variantId と quantity で送る', async () => {
    const user = userEvent.setup();
    await startOrder(user);
    await user.type(screen.getByRole('spinbutton', { name: QTY_RETIRED }), '2');
    await user.type(screen.getByRole('spinbutton', { name: QTY_ACTIVE }), '5');
    await user.click(screen.getByRole('button', { name: '発注書確認' }));
    await user.type(await screen.findByRole('textbox', { name: '発注先' }), '工場A');
    fetchMock.mockResolvedValueOnce(json(CREATED, 201));
    await user.click(confirmButton());
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(bodyOf(0).lines).toEqual([{ variantId: 11, quantity: 5 }, { variantId: 12, quantity: 2 }]);
  });

  test('FREQ-540-AC-07: 403 は「発注を扱う権限がありません。」を role=alert で出し、発注書へは移らない', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.purchase_orders.manage' }, 403));
    await user.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注を扱う権限がありません。$/);
    expect(mockPush).not.toHaveBeenCalled();
    expect(confirmButton()).toBeEnabled();
  });

  test('FREQ-540-AC-07: 2要素認証が無い 403 は「権限がありません」ではなく「2要素認証が必要です」', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', reason: 'MFA required' }, 403));
    await user.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/^2要素認証が必要です$/);
    expect(screen.queryByText('発注を扱う権限がありません。')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-02: DB のエラー（同じ要求番号で別の内容）は表の本文を出す。400 は「入力を確かめてください。」', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_REQUEST_KEY_CONFLICT', error: '同じ要求番号で異なる操作は実行できません。' }, 409));
    await user.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/^同じ要求番号で異なる操作は実行できません。$/);

    fetchMock.mockResolvedValueOnce(json({ error: 'Invalid request', details: { fieldErrors: {} } }, 400));
    await user.click(confirmButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^入力を確かめてください。$/));
    expect(screen.queryByText('Invalid request')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-03: 確定済みの応答（4xx）の後は新しい requestKey で送る（前の要求を引きずらない）', async () => {
    const user = userEvent.setup();
    await toConfirm(user);
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場A');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_ARGUMENT_INVALID', error: '入力を確かめてください。' }, 400));
    await user.click(confirmButton());
    await screen.findByRole('alert');
    fetchMock.mockResolvedValueOnce(json(CREATED, 201));
    await user.click(confirmButton());
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    expect(bodyOf(1).requestKey).not.toBe(bodyOf(0).requestKey);
    expect({ ...bodyOf(1), requestKey: null }).toEqual({ ...bodyOf(0), requestKey: null });
  });
});
