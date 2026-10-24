import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminInventorySection from '@/components/AdminInventorySection';
import { clientFetch } from '@/lib/client-fetch';
import type { AdminInventoryRow } from '@/lib/inventory/inventory-list-types';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
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
