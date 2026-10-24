import { render, screen, within } from '@testing-library/react';
import PurchaseOrderDetailSection from '@/components/PurchaseOrderDetailSection';
import { clientFetch } from '@/lib/client-fetch';
import type { PurchaseOrderDetail } from '@/lib/purchase-orders/purchase-order-types';
import { confirmedDetail, orderedDetail, ORDER_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const LINE_HEADERS = ['商品名', '色', 'サイズ', '仮数量', '発注数量', '納品済み', '未納', '単価（円）'];
const NOTICE = '発注書 PO-20261025-0001 を作成しました。数量が確定するまで受け取りはできません。';

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

async function loaded(detail: PurchaseOrderDetail = confirmedDetail(), created = false) {
  fetchMock.mockResolvedValueOnce(json({ purchaseOrder: detail }));
  render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} created={created} />);
  await screen.findByRole('heading', { level: 1, name: `発注書 ${detail.number}` });
}

/** 行の表（見出し「商品名」を持つ表） */
const linesTable = () => screen.getByRole('table', { name: '明細' });

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PurchaseOrderDetailSection', () => {
  test('FREQ-526-AC-05: 窓口を発注書の id で no-store の GET 1回だけ読み、h1「発注書 ${number}」を出す', async () => {
    await loaded();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/purchase-orders/${ORDER_ID}`, { cache: 'no-store' });
    expect(screen.getByRole('heading', { level: 1, name: '発注書 PO-20261025-0001' })).toBeInTheDocument();
  });

  test('FREQ-526-AC-05: 読込中は「読み込み中...」を role=status で出し、発注書の中身を出さない', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} created />);
    expect(screen.getByRole('status')).toHaveTextContent(/^読み込み中\.\.\.$/);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '明細' })).not.toBeInTheDocument();
    release(json({ purchaseOrder: confirmedDetail() }));
    await screen.findByRole('table', { name: '明細' });
    expect(screen.getByRole('status')).toHaveTextContent(NOTICE);
  });

  test('FREQ-526-AC-05: 発注先・メモ・発注日（日本時間 YYYY/MM/DD）・段階（表示段階の日本語）を出す', async () => {
    await loaded({ ...confirmedDetail(), orderedAt: '2026-10-25T15:30:00+00:00' });
    expect(screen.getByText('発注先').nextElementSibling).toHaveTextContent('工場A');
    expect(screen.getByText('メモ').nextElementSibling).toHaveTextContent('春の追加分');
    expect(screen.getByText('発注日').nextElementSibling).toHaveTextContent(/^2026\/10\/26$/);
    expect(screen.getByText('段階').nextElementSibling).toHaveTextContent('一部受け取り済み');
  });

  test.each([
    ['ordered', '数量確定待ち'], ['quantity_confirmed', '数量確定済み・受け取り待ち'], ['partially_received', '一部受け取り済み'],
    ['received', '受け取り完了'], ['closed', '完了（残りを打ち切り）'],
  ] as const)('FREQ-526-AC-05: 表示段階 %s は「%s」と出す', async (displayStage, label) => {
    const base = displayStage === 'ordered' ? orderedDetail() : confirmedDetail();
    await loaded({ ...base, displayStage });
    expect(screen.getByText('段階').nextElementSibling).toHaveTextContent(label);
  });

  test('FREQ-526-AC-05: メモが無ければ「—」', async () => {
    await loaded({ ...confirmedDetail(), memo: null });
    expect(screen.getByText('メモ').nextElementSibling).toHaveTextContent(/^—$/);
  });

  test('FREQ-526-AC-05: 行の表は 商品名・色・サイズ・仮数量・発注数量・納品済み・未納・単価（円）の8列を line_no 順に出す。単価が NULL は「未登録」', async () => {
    await loaded();
    expect(within(linesTable()).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(LINE_HEADERS);
    const rows = within(linesTable()).getAllByTestId('purchase-order-line');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]).getAllByRole('cell').map((cell) => cell.textContent);
    expect(first).toEqual(['シャツ', 'BLACK', 'M', '5', '5', '2', '3', '1,200']);
    const second = within(rows[1]).getAllByRole('cell').map((cell) => cell.textContent);
    expect(second).toEqual(['パンツ', '—', '—', '4', '3', '0', '3', '未登録']);
  });

  test('FREQ-526-AC-05: 行は応答の並び（line_no 順）のまま出す', async () => {
    const detail = confirmedDetail();
    await loaded({ ...detail, lines: [detail.lines[1], detail.lines[0]] });
    const names = within(linesTable()).getAllByTestId('purchase-order-line').map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(['パンツ', 'シャツ']);
  });

  test('FREQ-526-AC-05: 数量確定前の行は 発注数量 と 未納 が「数量未確定」で、単価は「未登録」', async () => {
    await loaded(orderedDetail());
    const cells = within(within(linesTable()).getAllByTestId('purchase-order-line')[0]).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['シャツ', 'BLACK', 'M', '5', '数量未確定', '0', '数量未確定', '未登録']);
  });

  test('FREQ-526-AC-05: 数量確定後は 単価未登録・証憑未添付 のバッジを flags どおりに出し、見込額「発注見込額 ¥6,000」と「税の扱いは書類に従います」を並べる', async () => {
    await loaded({ ...confirmedDetail(), flags: { unitPriceMissing: true, documentMissing: true } });
    expect(screen.getByText('単価未登録')).toBeInTheDocument();
    expect(screen.getByText('証憑未添付')).toBeInTheDocument();
    expect(screen.getByText('発注見込額 ¥6,000')).toBeInTheDocument();
    expect(screen.getByText('税の扱いは書類に従います')).toBeInTheDocument();
    expect(screen.getByText('発注見込額 ¥6,000').parentElement).toContainElement(screen.getByText('税の扱いは書類に従います'));
  });

  test('FREQ-526-AC-05: flags が偽のバッジは出さない（単価未登録だけ・証憑未添付だけ）', async () => {
    await loaded({ ...confirmedDetail(), flags: { unitPriceMissing: true, documentMissing: false } });
    expect(screen.getByText('単価未登録')).toBeInTheDocument();
    expect(screen.queryByText('証憑未添付')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-05: どちらも偽ならバッジは出さない', async () => {
    await loaded({ ...confirmedDetail(), flags: { unitPriceMissing: false, documentMissing: false } });
    expect(screen.queryByText('単価未登録')).not.toBeInTheDocument();
    expect(screen.queryByText('証憑未添付')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-05: 見込額が NULL（全行が単価未登録）なら「発注見込額」も注記も出さない', async () => {
    await loaded({ ...confirmedDetail(), estimatedAmountYen: null });
    expect(screen.queryByText(/発注見込額/)).not.toBeInTheDocument();
    expect(screen.queryByText('税の扱いは書類に従います')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-05: 数量確定前（ordered）は、flags や見込額が入っていてもバッジも見込額も出さない（数量確定後だけ）', async () => {
    await loaded({ ...orderedDetail(), flags: { unitPriceMissing: true, documentMissing: true }, estimatedAmountYen: 6000 });
    expect(screen.queryByText('単価未登録')).not.toBeInTheDocument();
    expect(screen.queryByText('証憑未添付')).not.toBeInTheDocument();
    expect(screen.queryByText(/発注見込額/)).not.toBeInTheDocument();
    expect(screen.queryByText('税の扱いは書類に従います')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-05: 履歴の節「数量の履歴」「受け取りの履歴」「取引書類」を h2 で出す', async () => {
    await loaded();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['数量の履歴', '受け取りの履歴', '取引書類']);
  });

  test('FREQ-526-AC-05: 数量の履歴は 版・日時（日本時間）・種類・対象・変更・理由 を版の順に出す', async () => {
    await loaded();
    const table = screen.getByRole('table', { name: '数量の履歴' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['版', '日時', '種類', '対象', '変更', '理由']);
    const rows = within(table).getAllByTestId('purchase-order-revision').map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['1', '2026/10/25 23:30', '発注', '発注書', '発注先 工場A・メモ 春の追加分', '—'],
      ['1', '2026/10/25 23:30', '発注', 'シャツ BLACK M', '数量 5', '—'],
      ['2', '2026/10/26 10:00', '数量の確定・訂正', 'パンツ', '数量 4 → 3', '工場の都合'],
    ]);
  });

  test('FREQ-526-AC-05: 受け取りの履歴は 日付・種類・メモ・理由と、受取行の商品と数量を出す。無ければ「受け取りの記録はありません。」', async () => {
    await loaded();
    const history = screen.getByRole('region', { name: '受け取りの履歴' });
    expect(history).toHaveTextContent('2026/10/26');
    expect(history).toHaveTextContent('受け取り');
    expect(history).toHaveTextContent('午前便');
    expect(within(history).getByText('シャツ BLACK M')).toBeInTheDocument();
    expect(within(history).getByText('+2')).toBeInTheDocument();
  });

  test('FREQ-526-AC-05: 取消の受取行は 負の数量と理由を出す', async () => {
    const detail = confirmedDetail();
    await loaded({
      ...detail,
      receipts: [
        ...detail.receipts,
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', kind: 'reverse', receivedOn: '2026-10-27', memo: null, reason: '数え間違い',
          actorId: detail.createdBy, createdAt: '2026-10-27T01:00:00+00:00',
          lines: [{ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', lineId: detail.lines[0].id, quantity: -1, reversesReceiptLineId: detail.receipts[0].lines[0].id, reversibleQuantity: 0 }],
        },
      ],
    });
    const history = screen.getByRole('region', { name: '受け取りの履歴' });
    expect(history).toHaveTextContent('受け取りの取消');
    expect(history).toHaveTextContent('数え間違い');
    expect(within(history).getByText('-1')).toBeInTheDocument();
  });

  test('FREQ-526-AC-05: 受け取りが無ければ「受け取りの記録はありません。」', async () => {
    await loaded(orderedDetail());
    expect(screen.getByRole('region', { name: '受け取りの履歴' })).toHaveTextContent('受け取りの記録はありません。');
  });

  test('FREQ-526-AC-05: 取引書類の節は見出しだけ（書類の一覧・無効の印・保存途中の予約・操作は Task 8）。書類や予約があっても、ファイル名も保存先の鍵も出さない', async () => {
    const detail = confirmedDetail();
    const [attachment] = detail.attachments;
    await loaded({
      ...detail,
      attachments: [attachment, { ...attachment, id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', fileName: 'old.pdf', current: { ...attachment.current, voided: true, reason: '誤り', revisionNo: 2 }, revisionCount: 2 }],
    });
    const documents = screen.getByRole('region', { name: '取引書類' });
    expect(within(documents).getByRole('heading', { level: 2, name: '取引書類' })).toBeInTheDocument();
    expect(documents.textContent).toBe('取引書類');
    expect(within(documents).queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('無効')).not.toBeInTheDocument();
    for (const text of ['invoice.pdf', 'old.pdf', 'quote.pdf', 'storage']) expect(document.body.textContent).not.toContain(text);
  });

  test('FREQ-526-AC-05: 表は見出しを保ったスクロール領域に入り、頁全体を横に広げない', async () => {
    await loaded();
    const region = screen.getByRole('region', { name: '明細' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toMatch(/overflow-auto/);
    expect(region.className).toMatch(/max-w-full/);
    expect(within(region).getByRole('table', { name: '明細' })).toBeInTheDocument();
    for (const header of within(linesTable()).getAllByRole('columnheader')) expect(header.className).toMatch(/sticky/);
    expect(region.parentElement?.className).toMatch(/min-w-0/);
  });

  test('FREQ-526-AC-05: 「発注一覧表に戻る」(/admin/purchase-orders) のリンクを出す', async () => {
    await loaded();
    expect(screen.getByRole('link', { name: '発注一覧表に戻る' })).toHaveAttribute('href', '/admin/purchase-orders');
  });

  // ---- 作成の通知（Task 4 から引き継いだ義務。16_admin.md「発注書の頁への引き継ぎ」） ----

  test('FREQ-526-AC-01: 目印（created）がある時は、読み込んだ発注書の番号で「発注書 ○○ を作成しました。数量が確定するまで受け取りはできません。」を role=status で出す', async () => {
    await loaded(confirmedDetail(), true);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(NOTICE);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  test('FREQ-526-AC-01: 通知の番号は props ではなく読み込んだ発注書の物（別の番号の発注書なら、その番号）', async () => {
    await loaded({ ...confirmedDetail(), number: 'PO-20270102-0042' }, true);
    expect(screen.getByRole('status')).toHaveTextContent('発注書 PO-20270102-0042 を作成しました。数量が確定するまで受け取りはできません。');
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-01: 目印が無い時は通知を出さない（role=status の要素も無い）', async () => {
    await loaded(confirmedDetail(), false);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/を作成しました/)).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-01: created を渡さない既定も通知を出さない', async () => {
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: confirmedDetail() }));
    render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} />);
    await screen.findByRole('heading', { level: 1, name: '発注書 PO-20261025-0001' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test.each([
    [404, { error: '発注書が見つかりません。' }],
    [403, { error: 'Forbidden', permission: 'admin.purchase_orders.read' }],
    [403, { error: 'Forbidden', reason: 'MFA required' }],
    [401, { error: 'Unauthorized' }],
    [500, { error: '発注書を読み込めませんでした。' }],
  ])('FREQ-526-AC-01: 発注書が読めない（%i）時は、目印があっても通知を出さない', async (status, body) => {
    fetchMock.mockResolvedValueOnce(json(body, status));
    render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} created />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/を作成しました/)).not.toBeInTheDocument();
  });

  // ---- 失敗の見せ方 ----

  test('FREQ-526-AC-05: 404 は「発注書が見つかりません。」を role=alert で出し、表も履歴も出さない', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: '発注書が見つかりません。' }, 404));
    render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注書が見つかりません。$/);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '発注一覧表に戻る' })).toBeInTheDocument();
  });

  test('FREQ-540-AC-07: 403 は「発注書を見る権限がありません。」、2要素認証なしの403は「2要素認証が必要です」、401 は「ログインし直してください。」', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', permission: 'admin.purchase_orders.read' }, 403));
    const { unmount } = render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注書を見る権限がありません。$/);
    unmount();

    fetchMock.mockResolvedValueOnce(json({ error: 'Forbidden', reason: 'MFA required' }, 403));
    const second = render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^2要素認証が必要です$/);
    second.unmount();

    fetchMock.mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401));
    render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^ログインし直してください。$/);
  });

  test.each([
    ['500', () => fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 500))],
    ['応答が読めない', () => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE-MARKER'); } } as unknown as Response)],
    ['purchaseOrder が無い', () => fetchMock.mockResolvedValueOnce(json({}))],
    ['発注書の形が崩れている', () => fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), stage: 'draft' } }))],
    ['別の発注書が返った', () => fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), id: '99999999-9999-4999-8999-999999999999' } }))],
    ['通信の失敗', () => fetchMock.mockRejectedValueOnce(new TypeError('PRIVATE-MARKER'))],
  ])('FREQ-526-AC-05: 失敗（%s）は「発注書を読み込めませんでした。時間をおいて再度お試しください。」を role=alert で出し、生の文は出さない', async (_name, arrange) => {
    arrange();
    render(<PurchaseOrderDetailSection purchaseOrderId={ORDER_ID} created />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注書を読み込めませんでした。時間をおいて再度お試しください。$/);
    expect(document.body.textContent).not.toContain('PRIVATE-MARKER');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('FREQ-526-AC-05: id は URL に使える形にして窓口へ渡す', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'x' }, 400));
    render(<PurchaseOrderDetailSection purchaseOrderId="a/b?c" />);
    await screen.findByRole('alert');
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/purchase-orders/a%2Fb%3Fc', { cache: 'no-store' });
  });
});
