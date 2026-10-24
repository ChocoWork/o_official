import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PurchaseOrderListSection from '@/components/PurchaseOrderListSection';
import { clientFetch } from '@/lib/client-fetch';
import type { PurchaseOrderListRow } from '@/lib/purchase-orders/purchase-order-types';
import { LINE_2, listRow, ORDER_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const HEADERS = ['発注書番号', '商品名', '色', 'サイズ', '発注数量', '納品済み', '未納'];
const CONFIRMED = listRow();
const UNCONFIRMED = listRow({
  purchaseOrderId: '33333333-3333-4333-8333-333333333334', number: 'PO-20261025-0002', displayStage: 'ordered',
  lineId: LINE_2, itemName: 'パンツ', colorName: null, sizeLabel: null, provisionalQuantity: 4,
  orderQuantity: null, receivedQuantity: 0, outstandingQuantity: null,
});

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** 一覧の応答。total が行数より多い時は、頁の途中を見ている形になる */
function page(rows: PurchaseOrderListRow[], total = rows.length, number = 1, limit = 20) {
  return json({ rows, total, page: number, limit });
}

/** 明細の行をn件作る（頁送りの試験用） */
function manyRows(count: number, from = 0): PurchaseOrderListRow[] {
  return Array.from({ length: count }, (_, index) => listRow({
    lineId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(from + index).padStart(12, '0')}`, lineNo: index + 1, itemName: `商品${from + index + 1}`,
  }));
}

async function loaded(rows: PurchaseOrderListRow[] = [CONFIRMED, UNCONFIRMED]) {
  fetchMock.mockResolvedValueOnce(page(rows));
  render(<PurchaseOrderListSection />);
  await screen.findByRole('table');
}

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PurchaseOrderListSection', () => {
  test('FREQ-526-AC-04: h1「発注一覧表」と、リンク「取引書類を検索」「在庫一覧表」「管理画面に戻る」を出し、窓口を no-store で1回だけ読む（1頁20行）', async () => {
    await loaded();
    expect(screen.getByRole('heading', { level: 1, name: '発注一覧表' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '取引書類を検索' })).toHaveAttribute('href', '/admin/purchase-orders/documents');
    expect(screen.getByRole('link', { name: '在庫一覧表' })).toHaveAttribute('href', '/admin/inventory');
    expect(screen.getByRole('link', { name: '管理画面に戻る' })).toHaveAttribute('href', '/admin');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/purchase-orders?limit=20&page=1', { cache: 'no-store' });
  });

  test('FREQ-526-AC-04: 読込中は「読み込み中...」を role=status で出し、表を出さない', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    render(<PurchaseOrderListSection />);
    expect(screen.getByRole('status')).toHaveTextContent(/^読み込み中\.\.\.$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    release(page([CONFIRMED]));
    await screen.findByRole('table');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-04: 列は「発注書番号・商品名・色・サイズ・発注数量・納品済み・未納」の7つだけがこの順で、「打切り」の列は無い', async () => {
    await loaded();
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual(HEADERS);
    expect(headers).not.toContain('打切り');
    expect(screen.queryByText('打切り')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-04: 発注書番号は発注書の頁（/admin/purchase-orders/[id]）へのリンクで、行は番号・商品名・色・サイズ・発注数量・納品済み・未納の順に値を出す', async () => {
    await loaded();
    const [first] = screen.getAllByTestId('purchase-order-row');
    const cells = within(first).getAllByRole('cell');
    expect(cells).toHaveLength(7);
    expect(within(cells[0]).getByRole('link', { name: 'PO-20261025-0001' })).toHaveAttribute('href', `/admin/purchase-orders/${ORDER_ID}`);
    expect(cells[1]).toHaveTextContent('シャツ');
    expect(cells[2]).toHaveTextContent('BLACK');
    expect(cells[3]).toHaveTextContent('M');
    expect(cells[4]).toHaveTextContent(/^5$/);
    expect(cells[5]).toHaveTextContent(/^2$/);
    expect(cells[6]).toHaveTextContent(/^3$/);
  });

  test('FREQ-526-AC-04: 数量確定前の行は「発注数量」と「未納」が「数量未確定」（納品済みは0のまま）。色・サイズが無ければ「—」', async () => {
    await loaded();
    const [, second] = screen.getAllByTestId('purchase-order-row');
    const cells = within(second).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('PO-20261025-0002');
    expect(cells[2]).toHaveTextContent('—');
    expect(cells[3]).toHaveTextContent('—');
    expect(cells[4]).toHaveTextContent(/^数量未確定$/);
    expect(cells[5]).toHaveTextContent(/^0$/);
    expect(cells[6]).toHaveTextContent(/^数量未確定$/);
    // 数量確定後の行には出ない
    const [first] = screen.getAllByTestId('purchase-order-row');
    expect(within(first).queryByText('数量未確定')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-04: 行はAPIの並びのまま出す（画面で並べ替えない）', async () => {
    await loaded([UNCONFIRMED, CONFIRMED]);
    const numbers = screen.getAllByTestId('purchase-order-row').map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(numbers).toEqual(['PO-20261025-0002', 'PO-20261025-0001']);
  });

  test('FREQ-526-AC-04: 表は見出しを保ったスクロール領域に入り、頁全体を横に広げない', async () => {
    await loaded();
    const region = screen.getByRole('region', { name: '発注一覧表' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toMatch(/overflow-auto/);
    expect(region.className).toMatch(/max-w-full/);
    expect(region.className).toMatch(/max-h-/);
    expect(within(region).getByRole('table')).toBeInTheDocument();
    for (const header of screen.getAllByRole('columnheader')) expect(header.className).toMatch(/sticky/);
    expect(region.parentElement?.className).toMatch(/min-w-0/);
  });

  test('FREQ-526-AC-04: 頁送り「前へ」「次へ」と「1〜20 / 45」。最初の頁では「前へ」を押せず、次へで page=2 を読む', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(page(manyRows(20), 45, 1));
    render(<PurchaseOrderListSection />);
    await screen.findByRole('table');
    expect(screen.getByText('1〜20 / 45')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前へ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '次へ' })).toBeEnabled();

    fetchMock.mockResolvedValueOnce(page(manyRows(20, 20), 45, 2));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await waitFor(() => expect(screen.getByText('21〜40 / 45')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/purchase-orders?limit=20&page=2', { cache: 'no-store' });
    expect(screen.getByRole('button', { name: '前へ' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '次へ' })).toBeEnabled();

    fetchMock.mockResolvedValueOnce(page(manyRows(5, 40), 45, 3));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    await waitFor(() => expect(screen.getByText('41〜45 / 45')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '次へ' })).toBeDisabled();

    fetchMock.mockResolvedValueOnce(page(manyRows(20, 20), 45, 2));
    await user.click(screen.getByRole('button', { name: '前へ' }));
    await waitFor(() => expect(screen.getByText('21〜40 / 45')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith('/api/admin/purchase-orders?limit=20&page=2', { cache: 'no-store' });
  });

  test('FREQ-526-AC-04: 全行がちょうど1頁に収まる時は、範囲「1〜2 / 2」を出して「前へ」「次へ」はどちらも押せない', async () => {
    await loaded();
    expect(screen.getByText('1〜2 / 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前へ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '次へ' })).toBeDisabled();
  });

  test('FREQ-526-AC-04: 行が無ければ「発注書はまだありません。」だけで、表も頁送りも出さない（リンクは残る）', async () => {
    fetchMock.mockResolvedValueOnce(page([]));
    render(<PurchaseOrderListSection />);
    expect(await screen.findByText('発注書はまだありません。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '前へ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '次へ' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '発注一覧表' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '在庫一覧表' })).toBeInTheDocument();
  });

  test('FREQ-540-AC-07: 403 は「発注一覧を見る権限がありません。」を role=alert で出し、表も頁送りも出さない', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.purchase_orders.read' }, 403));
    render(<PurchaseOrderListSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('発注一覧を見る権限がありません。');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '次へ' })).not.toBeInTheDocument();
  });

  test('FREQ-540-AC-07: DB が断った403（code 付き）も同じ権限の文', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_FORBIDDEN', error: '発注を扱う権限がありません。' }, 403));
    render(<PurchaseOrderListSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('発注一覧を見る権限がありません。');
  });

  test('FREQ-540-AC-07: 2要素認証なしの403は「権限がありません」ではなく「2要素認証が必要です」', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', reason: 'MFA required' }, 403));
    render(<PurchaseOrderListSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^2要素認証が必要です$/);
  });

  test('FREQ-540-AC-07: 401 は「ログインし直してください。」', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401));
    render(<PurchaseOrderListSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^ログインし直してください。$/);
  });

  test.each([
    ['500', () => fetchMock.mockResolvedValueOnce(json({ error: '発注一覧を読み込めませんでした。' }, 500))],
    ['応答が読めない', () => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE-MARKER'); } } as unknown as Response)],
    ['rows が配列でない', () => fetchMock.mockResolvedValueOnce(json({ rows: 'x', total: 1, page: 1, limit: 20 }))],
    ['行の形が崩れている', () => fetchMock.mockResolvedValueOnce(json({ rows: [{ ...CONFIRMED, displayStage: 'draft' }], total: 1, page: 1, limit: 20 }))],
    ['total が無い', () => fetchMock.mockResolvedValueOnce(json({ rows: [CONFIRMED] }))],
    ['通信の失敗', () => fetchMock.mockRejectedValueOnce(new TypeError('PRIVATE-MARKER'))],
  ])('FREQ-526-AC-04: 失敗（%s）は「発注一覧を読み込めませんでした。時間をおいて再度お試しください。」を role=alert で出し、生の文は出さない', async (_name, arrange) => {
    arrange();
    render(<PurchaseOrderListSection />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^発注一覧を読み込めませんでした。時間をおいて再度お試しください。$/);
    expect(document.body.textContent).not.toContain('PRIVATE-MARKER');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-04: 次の頁の読込に失敗したら失敗の文を出し、表は消える', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(page(manyRows(20), 45, 1));
    render(<PurchaseOrderListSection />);
    await screen.findByRole('table');
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 500));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('発注一覧を読み込めませんでした。時間をおいて再度お試しください。');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-04: 発注書番号のリンクはキーボードで焦点を当てて開ける通常のリンクで、行そのものを押しても何も読み込まない', async () => {
    const user = userEvent.setup();
    await loaded();
    const link = screen.getByRole('link', { name: 'PO-20261025-0001' });
    expect(link.tagName).toBe('A');
    expect(link).not.toHaveAttribute('tabindex', '-1');
    link.focus();
    expect(link).toHaveFocus();
    await user.click(screen.getAllByTestId('purchase-order-row')[1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
