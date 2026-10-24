import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('PurchaseOrderDetailSection: 数量の確定・訂正・打切り・取消・発注先の訂正（Task 6）', () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH');
  const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method === undefined);
  const bodyOf = (index: number) => JSON.parse(String(posts()[index][1]?.body)) as Record<string, unknown>;
  const button = (name: string) => screen.getByRole('button', { name });
  const queryButton = (name: string) => screen.queryByRole('button', { name });
  /** 完了の表示段階の発注書（数量の確定は済み、未納がない行がある）。2行目だけ未納がある */
  const oneOutstanding = (): PurchaseOrderDetail => {
    const detail = confirmedDetail();
    return {
      ...detail,
      lines: detail.lines.map((line) => (line.id === detail.lines[0].id ? { ...line, receivedQuantity: 5, outstandingQuantity: 0 } : line)),
    };
  };

  test('FREQ-527-AC-01: 数量確定待ち（ordered）のボタンは「数量確定」「発注を取り消す」「発注先・メモを訂正」で、訂正と打切りは出ない', async () => {
    await loaded(orderedDetail());
    expect(button('数量確定')).toBeEnabled();
    expect(button('発注を取り消す')).toBeEnabled();
    expect(button('発注先・メモを訂正')).toBeEnabled();
    for (const name of ['数量を訂正', '残りを打ち切る', '未納のある行をすべて選ぶ']) expect(queryButton(name)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  test('FREQ-527-AC-01: 数量確定後のボタンは「数量を訂正」「発注先・メモを訂正」と「未納のある行をすべて選ぶ」。「数量確定」「発注を取り消す」は出ない。行を選ぶまで「残りを打ち切る」は出ない', async () => {
    await loaded(confirmedDetail());
    expect(button('数量を訂正')).toBeEnabled();
    expect(button('発注先・メモを訂正')).toBeEnabled();
    expect(button('未納のある行をすべて選ぶ')).toBeEnabled();
    for (const name of ['数量確定', '発注を取り消す', '残りを打ち切る']) expect(queryButton(name)).not.toBeInTheDocument();
  });

  test('FREQ-528-AC-01: 未納のある行だけに選ぶ欄が出る（未納0の行には出ない）。表の列と各セルの文字は変わらない', async () => {
    await loaded(oneOutstanding());
    const rows = within(linesTable()).getAllByTestId('purchase-order-line');
    expect(within(rows[0]).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(rows[1]).getByRole('checkbox', { name: 'パンツ を選ぶ' })).not.toBeChecked();
    expect(within(linesTable()).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(LINE_HEADERS);
    expect(within(rows[1]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['パンツ', '—', '—', '4', '3', '0', '3', '未登録']);
  });

  test('FREQ-528-AC-01: 行を選ぶと「残りを打ち切る」が出て、外すと消える。「未納のある行をすべて選ぶ」は未納のある行を全部選ぶ', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(screen.getByRole('checkbox', { name: 'シャツ BLACK M を選ぶ' }));
    expect(button('残りを打ち切る')).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'シャツ BLACK M を選ぶ' }));
    expect(queryButton('残りを打ち切る')).not.toBeInTheDocument();
    await user.click(button('未納のある行をすべて選ぶ'));
    expect(screen.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(button('残りを打ち切る')).toBeEnabled();
  });

  test('FREQ-527-AC-01: 「数量確定」で「数量の確定」のダイアログが開き、「戻る」で閉じる（通信しない）。「数量を訂正」は「数量の訂正」', async () => {
    const user = userEvent.setup();
    await loaded(orderedDetail());
    await user.click(button('数量確定'));
    expect(screen.getByRole('dialog', { name: '数量の確定' })).toBeInTheDocument();
    await user.click(button('戻る'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('FREQ-527-AC-01: 「数量を訂正」で「数量の訂正」のダイアログが開く', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(button('数量を訂正'));
    expect(screen.getByRole('dialog', { name: '数量の訂正' })).toBeInTheDocument();
  });

  test('FREQ-528-AC-02: 「発注を取り消す」で「発注の取消」のダイアログが開く', async () => {
    const user = userEvent.setup();
    await loaded(orderedDetail());
    await user.click(button('発注を取り消す'));
    expect(screen.getByRole('dialog', { name: '発注の取消' })).toBeInTheDocument();
  });

  test('FREQ-528-AC-01: 「残りを打ち切る」で、選んだ行だけを並べた「残りを打ち切る」のダイアログが開く', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(screen.getByRole('checkbox', { name: 'パンツ を選ぶ' }));
    await user.click(button('残りを打ち切る'));
    const dialog = screen.getByRole('dialog', { name: '残りを打ち切る' });
    expect(within(dialog).getAllByTestId('purchase-order-close-row')).toHaveLength(1);
    expect(within(dialog).getByText('パンツ')).toBeInTheDocument();
  });

  test('FREQ-527-AC-01: 数量の確定が成功したら、ダイアログを閉じて「数量を確定しました。」を role=status で出し、発注書を読み直す（同じ id の GET をもう1回）', async () => {
    const user = userEvent.setup();
    await loaded(orderedDetail(), true);
    expect(screen.getByRole('status')).toHaveTextContent('を作成しました');
    await user.click(button('数量確定'));
    fetchMock.mockResolvedValueOnce(json({ version: 2, changedLines: 0, replayed: false }, 201));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: confirmedDetail() }));
    await user.click(button('確定する'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/^数量を確定しました。$/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    await waitFor(() => expect(gets()).toHaveLength(2));
    expect(gets()[1]).toEqual([`/api/admin/purchase-orders/${ORDER_ID}`, { cache: 'no-store' }]);
    // 読み直した発注書が出る（数量確定後のボタン）
    expect(await screen.findByRole('button', { name: '数量を訂正' })).toBeInTheDocument();
    expect(queryButton('数量確定')).not.toBeInTheDocument();
    expect(posts()[0][0]).toBe(`/api/admin/purchase-orders/${ORDER_ID}/quantities`);
  });

  test.each([
    ['訂正', '数量を訂正しました。'],
  ])('FREQ-527-AC-01: 数量の%sが成功したら「%s」を出す', async (_name, notice) => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(button('数量を訂正'));
    fetchMock.mockResolvedValueOnce(json({ version: 3, changedLines: 1, replayed: false }, 201));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), version: 3 } }));
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    await user.clear(within(screen.getAllByTestId('purchase-order-quantity-row')[0]).getByRole('spinbutton', { name: '数量' }));
    await user.type(within(screen.getAllByTestId('purchase-order-quantity-row')[0]).getByRole('spinbutton', { name: '数量' }), '4');
    await user.click(button('確定する'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(notice);
  });

  test('FREQ-528-AC-01: 打切りが成功したら、ダイアログを閉じて選びを解き、「残りを打ち切りました。」を出して発注書を読み直す', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(button('未納のある行をすべて選ぶ'));
    await user.click(button('残りを打ち切る'));
    fetchMock.mockResolvedValueOnce(json({ version: 3, closedQuantity: 6, replayed: false }, 201));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), version: 3, displayStage: 'closed' } }));
    await user.type(screen.getByRole('textbox', { name: '理由' }), '工場の都合');
    await user.click(button('打ち切る'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/^残りを打ち切りました。$/);
    expect(posts()[0][0]).toBe(`/api/admin/purchase-orders/${ORDER_ID}/short-closures`);
    expect(bodyOf(0)).toMatchObject({ expectedVersion: 2, lineIds: [confirmedDetail().lines[0].id, confirmedDetail().lines[1].id], reason: '工場の都合' });
    await waitFor(() => expect(gets()).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByRole('checkbox').every((box) => !(box as HTMLInputElement).checked)).toBe(true));
    expect(queryButton('残りを打ち切る')).not.toBeInTheDocument();
  });

  test('FREQ-528-AC-02: 確定前の取消が成功したら「発注を取り消しました。」を出す', async () => {
    const user = userEvent.setup();
    await loaded(orderedDetail());
    await user.click(button('発注を取り消す'));
    fetchMock.mockResolvedValueOnce(json({ version: 2, closedQuantity: 9, replayed: false }, 201));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), displayStage: 'closed' } }));
    await user.type(screen.getByRole('textbox', { name: '理由' }), 'やめる');
    await user.click(button('取り消す'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/^発注を取り消しました。$/);
  });

  test('FREQ-527-AC-02: ダイアログが版の競合（409）を受けたら、発注書を読み直す（GET をもう1回）。ダイアログは開いたまま、入力は保たれる', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(button('数量を訂正'));
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_VERSION_CONFLICT', error: '発注書が更新されました。内容を確認して、もう一度送ってください。' }, 409));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), version: 7 } }));
    await user.click(button('確定する'));

    expect(await screen.findByRole('alert')).toHaveTextContent('発注書が更新されました。内容を確認して、もう一度送ってください。');
    await waitFor(() => expect(gets()).toHaveLength(2));
    expect(screen.getByRole('dialog', { name: '数量の訂正' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '理由' })).toHaveDisplayValue('訂正');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // 読み直した版（7）で送り直せる
    fetchMock.mockResolvedValueOnce(json({ version: 8, changedLines: 1, replayed: false }, 201));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), version: 8 } }));
    await user.clear(within(screen.getAllByTestId('purchase-order-quantity-row')[1]).getByRole('spinbutton', { name: '数量' }));
    await user.type(within(screen.getAllByTestId('purchase-order-quantity-row')[1]).getByRole('spinbutton', { name: '数量' }), '2');
    await user.click(button('確定する'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodyOf(1).expectedVersion).toBe(7);
  });

  test('FREQ-527-AC-01: 「発注先・メモを訂正」で、発注先とメモの現在の値を入れた「発注先・メモの訂正」のダイアログが開く。理由が必須で、空の間は「訂正する」を押せない', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(button('発注先・メモを訂正'));
    expect(screen.getByRole('dialog', { name: '発注先・メモの訂正' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '発注先' })).toHaveDisplayValue('工場A');
    expect(screen.getByRole('textbox', { name: 'メモ' })).toHaveDisplayValue('春の追加分');
    expect(screen.getByRole('textbox', { name: '理由' })).toBeRequired();
    expect(button('訂正する')).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: '理由' }), '社名変更');
    expect(button('訂正する')).toBeEnabled();
    await user.clear(screen.getByRole('textbox', { name: '発注先' }));
    expect(button('訂正する')).toBeDisabled();
    await user.click(button('戻る'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('FREQ-527-AC-01: 発注先・メモの訂正は PATCH で expectedVersion・発注先・メモ・理由・requestKey を送り、成功したら「発注先・メモを訂正しました。」を出して発注書を読み直す。メモを空にすると memo は送らない', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(button('発注先・メモを訂正'));
    fetchMock.mockResolvedValueOnce(json({ version: 3, replayed: false }));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), version: 3, supplierName: '工場B', memo: null } }));
    await user.clear(screen.getByRole('textbox', { name: '発注先' }));
    await user.type(screen.getByRole('textbox', { name: '発注先' }), ' 工場B ');
    await user.clear(screen.getByRole('textbox', { name: 'メモ' }));
    await user.type(screen.getByRole('textbox', { name: '理由' }), ' 社名変更 ');
    await user.click(button('訂正する'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(`/api/admin/purchase-orders/${ORDER_ID}`);
    expect(posts()[0][1]).toMatchObject({ method: 'PATCH', headers: { 'Content-Type': 'application/json' } });
    expect(bodyOf(0)).toEqual({ expectedVersion: 2, supplierName: '工場B', reason: '社名変更', requestKey: expect.stringMatching(UUID_PATTERN) });
    expect(screen.getByRole('status')).toHaveTextContent(/^発注先・メモを訂正しました。$/);
    await waitFor(() => expect(screen.getByText('発注先').nextElementSibling).toHaveTextContent('工場B'));
  });

  test('FREQ-527-AC-01: 発注先・メモの訂正が通信の失敗や500のとき、再押下は同じ requestKey と本文。版の競合は読み直して入力を保つ', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(button('発注先・メモを訂正'));
    await user.type(screen.getByRole('textbox', { name: '理由' }), '社名変更');
    await user.type(screen.getByRole('textbox', { name: 'メモ' }), '追記');
    fetchMock.mockResolvedValueOnce(json({ error: '発注の記録に失敗しました' }, 500));
    await user.click(button('訂正する'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^発注の記録に失敗しました$/);

    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_VERSION_CONFLICT', error: '発注書が更新されました。内容を確認して、もう一度送ってください。' }, 409));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...confirmedDetail(), version: 6 } }));
    await user.click(button('訂正する'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('発注書が更新されました。'));
    expect(posts()).toHaveLength(2);
    expect(bodyOf(1)).toEqual(bodyOf(0));
    await waitFor(() => expect(gets()).toHaveLength(2));
    expect(screen.getByRole('textbox', { name: '理由' })).toHaveDisplayValue('社名変更');
    expect(screen.getByRole('dialog', { name: '発注先・メモの訂正' })).toBeInTheDocument();
  });

  test('FREQ-527-AC-01: 作成直後の通知は、操作の通知が出たら入れ替わる（role=status は常に1つ）', async () => {
    const user = userEvent.setup();
    await loaded(orderedDetail(), true);
    await user.click(button('発注先・メモを訂正'));
    fetchMock.mockResolvedValueOnce(json({ version: 2, replayed: false }));
    fetchMock.mockResolvedValueOnce(json({ purchaseOrder: { ...orderedDetail(), version: 2, supplierName: '工場B' } }));
    await user.clear(screen.getByRole('textbox', { name: '発注先' }));
    await user.type(screen.getByRole('textbox', { name: '発注先' }), '工場B');
    await user.type(screen.getByRole('textbox', { name: '理由' }), '改称');
    await user.click(button('訂正する'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('発注先・メモを訂正しました。'));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.queryByText(/を作成しました/)).not.toBeInTheDocument();
  });

  test('FREQ-527-AC-01: 数量の履歴の「変更」は、値が変わった項目だけを出す（単価だけの訂正は before_quantity = after_quantity なので数量は出さず、発注先が同じ訂正は発注先を出さない）', async () => {
    const detail = confirmedDetail();
    const base = detail.revisions[2];
    await loaded({
      ...detail,
      revisions: [
        ...detail.revisions,
        { ...base, id: 'f0000000-0000-4000-8000-000000000004', revisionNo: 3, beforeQuantity: 3, afterQuantity: 3, beforeUnitPriceYen: null, afterUnitPriceYen: 500, reason: '単価の登録' },
        { ...base, id: 'f0000000-0000-4000-8000-000000000005', revisionNo: 4, beforeQuantity: 3, afterQuantity: 3, beforeUnitPriceYen: 500, afterUnitPriceYen: 650, reason: '値上がり' },
        {
          ...base, id: 'f0000000-0000-4000-8000-000000000006', lineId: null, revisionNo: 5, kind: 'header', beforeQuantity: null, afterQuantity: null,
          beforeSupplierName: '工場A', afterSupplierName: '工場A', beforeMemo: '春の追加分', afterMemo: null, reason: 'メモを消す',
        },
      ],
    });
    const table = screen.getByRole('table', { name: '数量の履歴' });
    const rows = within(table).getAllByTestId('purchase-order-revision').map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows.slice(3).map((cells) => [cells[0], cells[4], cells[5]])).toEqual([
      ['3', '単価 500', '単価の登録'],
      ['4', '単価 500 → 650', '値上がり'],
      ['5', 'メモ 春の追加分 → —', 'メモを消す'],
    ]);
  });

  test('FREQ-527-AC-01: 読み直しに失敗しても、いま見ている発注書と開いているダイアログは消えない', async () => {
    const user = userEvent.setup();
    await loaded(confirmedDetail());
    await user.click(button('数量を訂正'));
    await user.type(screen.getByRole('textbox', { name: '理由' }), '訂正');
    fetchMock.mockResolvedValueOnce(json({ code: 'GROUP_G_PO_VERSION_CONFLICT', error: 'x' }, 409));
    fetchMock.mockRejectedValueOnce(new TypeError('PRIVATE-MARKER'));
    await user.click(button('確定する'));
    await waitFor(() => expect(gets()).toHaveLength(2));
    expect(screen.getByRole('dialog', { name: '数量の訂正' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: '発注書 PO-20261025-0001' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('PRIVATE-MARKER');
  });
});
