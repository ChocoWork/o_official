import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PurchaseOrderDocumentSearchPage from '@/app/admin/purchase-orders/documents/page';
import PurchaseOrderDocumentSearchSection from '@/components/PurchaseOrderDocumentSearchSection';
import { clientFetch } from '@/lib/client-fetch';
import type { PurchaseOrderDocumentSearchRow } from '@/lib/purchase-orders/purchase-order-types';
import { ATTACHMENT_ID, ORDER_ID } from '../lib/purchase-orders/purchase-order-fixtures';

jest.mock('@/lib/client-fetch', () => ({ clientFetch: jest.fn() }));
const fetchMock = jest.mocked(clientFetch);

const COLUMNS = ['発注書番号', '種類', 'ファイル名', '取引日', '金額（円）', '取引先', '状態', '原本'];
const SIGNED_VIEW = 'https://storage.example.test/object/sign/purchase-order-documents/SECRET-VIEW-TOKEN';
const URL_ENDPOINT = (orderId: string, attachmentId: string) => `/api/admin/purchase-orders/${orderId}/attachments/${attachmentId}/url`;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function row(overrides: Partial<PurchaseOrderDocumentSearchRow> = {}): PurchaseOrderDocumentSearchRow {
  return {
    attachmentId: ATTACHMENT_ID, purchaseOrderId: ORDER_ID, purchaseOrderNumber: 'PO-20261025-0001', kind: 'invoice', fileName: 'invoice.pdf',
    mimeType: 'application/pdf', sizeBytes: 2048, revisionNo: 1, isCurrent: true, transactionDate: '2026-10-26', amountYen: 6000, currency: 'JPY',
    counterparty: '工場A', voided: false, reason: null, replacesAttachmentId: null, createdAt: '2026-10-26T03:00:00+00:00', ...overrides,
  };
}

/** window.open が返す空のタブの代わり（クリックの中で開き、リンクが取れたら location.href を替え、取れなければ close する） */
function mockNewTab() {
  const tab = { close: jest.fn(), opener: {} as unknown, location: { href: '' } };
  const open = jest.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
  return { open, tab };
}

const page = (rows: PurchaseOrderDocumentSearchRow[], total = rows.length) => json({ rows, total, page: 1, limit: 50 });
const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)?.[0]), 'https://example.test');

async function loaded(rows: PurchaseOrderDocumentSearchRow[] = [row()], total = rows.length) {
  fetchMock.mockResolvedValueOnce(page(rows, total));
  render(<PurchaseOrderDocumentSearchSection />);
  await screen.findByRole('table', { name: '検索結果' });
}

beforeEach(() => {
  fetchMock.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('PurchaseOrderDocumentSearchSection', () => {
  test('FREQ-530-AC-02: h1「取引書類の検索」と、条件（取引日・金額・取引先・発注書番号・種類・訂正前の情報も探す）とボタン（検索・条件をクリア・印刷）を出す', async () => {
    await loaded();
    expect(screen.getByRole('heading', { level: 1, name: '取引書類の検索' })).toBeInTheDocument();
    for (const label of ['取引日（から）', '取引日（まで）', '金額（円）（から）', '金額（円）（まで）', '取引先', '発注書番号', '種類']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('checkbox', { name: '訂正前の情報も探す' })).not.toBeChecked();
    expect(within(screen.getByLabelText('種類')).getAllByRole('option').map((option) => option.textContent)).toEqual(['すべて', '見積書', '請求書']);
    for (const name of ['検索', '条件をクリア', '印刷']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '発注一覧表に戻る' })).toHaveAttribute('href', '/admin/purchase-orders');
  });

  test('FREQ-530-AC-02: 最初は条件なしで1頁目を読み込む（no-store の GET 1回。page=1 だけ）', async () => {
    await loaded();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: 'no-store' });
    expect(lastUrl().pathname).toBe('/api/admin/purchase-order-documents');
    expect(lastUrl().search).toBe('?page=1');
  });

  test('FREQ-530-AC-02: 結果の列は 発注書番号・種類・ファイル名・取引日・金額（円）・取引先・状態・原本。発注書番号は発注書の頁へのリンク、原本の列は各行の「原本を見る」', async () => {
    await loaded();
    const table = screen.getByRole('table', { name: '検索結果' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(COLUMNS);
    const cells = within(within(table).getAllByTestId('purchase-order-document-row')[0]).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['PO-20261025-0001', '請求書', 'invoice.pdf', '2026/10/26', '6,000', '工場A', '有効', '原本を見る']);
    expect(within(table).getByRole('link', { name: 'PO-20261025-0001' })).toHaveAttribute('href', `/admin/purchase-orders/${ORDER_ID}`);
    expect(within(table).getByRole('button', { name: '原本を見る' })).toBeEnabled();
  });

  test('FREQ-530-AC-02: 結果の各行（有効・無効・訂正前の行とも）に「原本を見る」が1つずつある', async () => {
    await loaded([row(), row({ voided: true, revisionNo: 2 }), row({ isCurrent: false, revisionNo: 1, counterparty: '旧工場' })].map((item, index) => ({ ...item, attachmentId: `dddddddd-dddd-4ddd-8ddd-ddddddddddd${index + 1}` })));
    expect(screen.getAllByRole('button', { name: '原本を見る' })).toHaveLength(3);
    for (const item of screen.getAllByTestId('purchase-order-document-row')) expect(within(item).getAllByRole('button')).toHaveLength(1);
  });

  describe('原本を見る', () => {
    test('FREQ-530-AC-02: 押すとその行の発注書・添付の窓口（GET …/attachments/[attachmentId]/url。no-store・表示用）から60秒の署名つきリンクをもらい、新しいタブで開く。リンクは画面に出さない', async () => {
      const user = userEvent.setup();
      const { open, tab } = mockNewTab();
      const other = '99999999-9999-4999-8999-999999999991';
      const otherOrder = '88888888-8888-4888-8888-888888888881';
      await loaded([row(), row({ attachmentId: other, purchaseOrderId: otherOrder, fileName: 'other.pdf' })]);
      fetchMock.mockResolvedValueOnce(json({ url: SIGNED_VIEW, expiresInSeconds: 60 }));
      const second = screen.getAllByTestId('purchase-order-document-row')[1];
      await user.click(within(second).getByRole('button', { name: '原本を見る' }));
      await waitFor(() => expect(tab.location.href).toBe(SIGNED_VIEW));
      expect(open).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenLastCalledWith(URL_ENDPOINT(otherOrder, other), { cache: 'no-store' });
      // 空のタブを先に開き、opener を切ってから、リンクが取れたタブを移す（リンクは window.open の引数に渡さない）
      expect(open).toHaveBeenCalledWith('', '_blank');
      expect(tab.opener).toBeNull();
      expect(tab.close).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('SECRET-VIEW-TOKEN');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // 開いた後はまた押せる
      await waitFor(() => expect(within(second).getByRole('button', { name: '原本を見る' })).toBeEnabled());
    });

    test.each([
      ['置き場に無い（404）', 404, { code: 'DOCUMENT_NOT_FOUND', error: 'x' }, '原本を取得できません。'],
      ['置き場の不調（503）', 503, { code: 'DOCUMENT_STORAGE_UNAVAILABLE', error: 'x' }, 'ファイルの保存先に接続できません。時間をおいて再度お試しください。'],
      ['権限が無い（403）', 403, { code: 'GROUP_G_FORBIDDEN', error: 'x' }, '発注を扱う権限がありません。'],
      ['2要素認証が無い', 403, { error: 'Forbidden', reason: 'MFA required' }, '2要素認証が必要です'],
      ['ログインが切れた（401）', 401, { error: 'Unauthorized' }, 'ログインし直してください。'],
      ['想定外の失敗（500）', 500, { error: 'x' }, '発注の記録に失敗しました'],
    ])('FREQ-530-AC-02: リンクをもらえない（%s）時は発注書の頁と同じ文を role=alert で出し、先に開いた空のタブを閉じて、原本へは移さない', async (_name, status, body, message) => {
      const user = userEvent.setup();
      const { tab } = mockNewTab();
      await loaded();
      fetchMock.mockResolvedValueOnce(json(body, status));
      await user.click(screen.getByRole('button', { name: '原本を見る' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(tab.close).toHaveBeenCalledTimes(1);
      expect(tab.location.href).toBe('');
      expect(screen.getByRole('button', { name: '原本を見る' })).toBeEnabled();
    });

    test('FREQ-530-AC-02: リンクの応答が崩れている・通信が失敗した時は「原本を取得できません。」で、空のタブを閉じる。次に成功すれば文は消える', async () => {
      const user = userEvent.setup();
      const { open, tab } = mockNewTab();
      await loaded();
      fetchMock.mockResolvedValueOnce(json({}));
      await user.click(screen.getByRole('button', { name: '原本を見る' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('原本を取得できません。');
      fetchMock.mockRejectedValueOnce(new Error('network'));
      await user.click(screen.getByRole('button', { name: '原本を見る' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(await screen.findByRole('alert')).toHaveTextContent('原本を取得できません。');
      await waitFor(() => expect(tab.close).toHaveBeenCalledTimes(2));
      expect(tab.location.href).toBe('');
      fetchMock.mockResolvedValueOnce(json({ url: SIGNED_VIEW, expiresInSeconds: 60 }));
      await user.click(screen.getByRole('button', { name: '原本を見る' }));
      await waitFor(() => expect(tab.location.href).toBe(SIGNED_VIEW));
      expect(open).toHaveBeenCalledTimes(3);
      expect(tab.close).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    test('FREQ-530-AC-02: 新しいタブはリンクを待つ前に（クリックの中で）開く。リンクが取れるまでタブは空のまま', async () => {
      const user = userEvent.setup();
      const { open, tab } = mockNewTab();
      await loaded();
      let release: (value: Response) => void = () => undefined;
      fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
      await user.click(screen.getByRole('button', { name: '原本を見る' }));
      // 窓口の応答はまだ無い。その時点で空のタブは開いていて、まだ移していない
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith('', '_blank');
      expect(tab.location.href).toBe('');
      release(json({ url: SIGNED_VIEW, expiresInSeconds: 60 }));
      await waitFor(() => expect(tab.location.href).toBe(SIGNED_VIEW));
    });

    test('FREQ-530-AC-02: ブラウザが新しいタブを止めた時は、role=alert で止められたことを知らせ、リンクは取りに行かない', async () => {
      const user = userEvent.setup();
      const open = jest.spyOn(window, 'open').mockImplementation(() => null);
      await loaded();
      await user.click(screen.getByRole('button', { name: '原本を見る' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('新しいタブがブラウザに止められました。このサイトのポップアップを許可して、もう一度押してください。');
      expect(open).toHaveBeenCalledTimes(1);
      // 取りに行くのは最初の検索の1回だけ。署名つきリンクの窓口は呼んでいない
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: '原本を見る' })).toBeEnabled();
    });

    test('FREQ-530-AC-02: リンクをもらう間は全行のボタンを押せず、二重に取りに行かない', async () => {
      const user = userEvent.setup();
      const { open } = mockNewTab();
      await loaded([row(), row({ attachmentId: '99999999-9999-4999-8999-999999999991', fileName: 'other.pdf' })]);
      let release: (value: Response) => void = () => undefined;
      fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
      const buttons = screen.getAllByRole('button', { name: '原本を見る' });
      await user.click(buttons[0]);
      await waitFor(() => expect(buttons[1]).toBeDisabled());
      expect(buttons[0]).toBeDisabled();
      fireEvent.click(buttons[1]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(1);
      release(json({ url: SIGNED_VIEW, expiresInSeconds: 60 }));
      await waitFor(() => expect(buttons[0]).toBeEnabled());
    });

    test('FREQ-530-AC-02: 新しく検索すると、前の「原本を見る」の失敗の文は消える', async () => {
      const user = userEvent.setup();
      mockNewTab();
      await loaded();
      fetchMock.mockResolvedValueOnce(json({ code: 'DOCUMENT_NOT_FOUND', error: 'x' }, 404));
      await user.click(screen.getByRole('button', { name: '原本を見る' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('原本を取得できません。');
      fetchMock.mockResolvedValueOnce(page([row()]));
      await user.click(screen.getByRole('button', { name: '検索' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    });
  });

  test('FREQ-530-AC-02: 状態は 最新の有効な版が「有効」、無効が「無効」、訂正前の版が「訂正前」', async () => {
    await loaded([row(), row({ voided: true, revisionNo: 2 }), row({ isCurrent: false, revisionNo: 1, counterparty: '旧工場' })].map((item, index) => ({ ...item, attachmentId: `dddddddd-dddd-4ddd-8ddd-ddddddddddd${index + 1}` })));
    const states = screen.getAllByTestId('purchase-order-document-row').map((item) => within(item).getAllByRole('cell')[6].textContent);
    expect(states).toEqual(['有効', '無効', '訂正前']);
  });

  test('FREQ-530-AC-02: 検索を押すと、入れた条件だけを query にして1頁目を読み直す。入力中の条件は検索を押すまで効かない', async () => {
    const user = userEvent.setup();
    await loaded();
    fetchMock.mockResolvedValueOnce(page([row()]));
    fireEvent.change(screen.getByLabelText('取引日（から）'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('取引日（まで）'), { target: { value: '2026-10-31' } });
    await user.type(screen.getByLabelText('金額（円）（から）'), '1000');
    await user.type(screen.getByLabelText('金額（円）（まで）'), '9000');
    await user.type(screen.getByLabelText('取引先'), ' 工場 ');
    await user.type(screen.getByLabelText('発注書番号'), 'PO-2026');
    await user.selectOptions(screen.getByLabelText('種類'), '請求書');
    await user.click(screen.getByRole('checkbox', { name: '訂正前の情報も探す' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '検索' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const params = lastUrl().searchParams;
    expect(Object.fromEntries(params)).toEqual({
      dateFrom: '2026-10-01', dateTo: '2026-10-31', amountMin: '1000', amountMax: '9000', counterparty: '工場', number: 'PO-2026', kind: 'invoice',
      includeHistory: '1', page: '1',
    });
  });

  test('FREQ-530-AC-02: 金額に数字以外を入れて検索すると、読み込まずに「入力を確かめてください。」', async () => {
    const user = userEvent.setup();
    await loaded();
    await user.type(screen.getByLabelText('金額（円）（から）'), '1,000');
    await user.click(screen.getByRole('button', { name: '検索' }));
    expect(screen.getByRole('alert')).toHaveTextContent('入力を確かめてください。');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('FREQ-530-AC-02: 条件をクリアすると入力欄を空に戻し、条件なしで読み直す', async () => {
    const user = userEvent.setup();
    await loaded();
    fetchMock.mockResolvedValueOnce(page([row()])).mockResolvedValueOnce(page([row()]));
    await user.type(screen.getByLabelText('取引先'), '工場');
    await user.click(screen.getByRole('checkbox', { name: '訂正前の情報も探す' }));
    await user.click(screen.getByRole('button', { name: '検索' }));
    await waitFor(() => expect(lastUrl().searchParams.get('counterparty')).toBe('工場'));
    await user.click(screen.getByRole('button', { name: '条件をクリア' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(lastUrl().search).toBe('?page=1');
    expect(screen.getByLabelText('取引先')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: '訂正前の情報も探す' })).not.toBeChecked();
  });

  test('FREQ-530-AC-02: 結果が空なら「該当する書類はありません。」', async () => {
    fetchMock.mockResolvedValueOnce(page([]));
    render(<PurchaseOrderDocumentSearchSection />);
    expect(await screen.findByText('該当する書類はありません。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('FREQ-540-AC-07: 403 は「取引書類を見る権限がありません。」、2要素認証が無い 403 と 401 は共通の文、他の失敗は読み込めなかった文', async () => {
    for (const [status, body, message] of [
      [403, { code: 'GROUP_G_FORBIDDEN', error: 'x' }, '取引書類を見る権限がありません。'],
      [403, { error: 'Forbidden', reason: 'MFA required' }, '2要素認証が必要です'],
      [401, { error: 'Unauthorized' }, 'ログインし直してください。'],
      [500, { error: 'x' }, '取引書類を読み込めませんでした。時間をおいて再度お試しください。'],
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(json(body, status));
      const view = render(<PurchaseOrderDocumentSearchSection />);
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      view.unmount();
    }
  });

  test.each([
    ['通信が失敗した', () => fetchMock.mockRejectedValueOnce(new Error('network'))],
    ['応答が崩れている（行の種類）', () => fetchMock.mockResolvedValueOnce(page([row({ kind: 'memo' as never })]))],
    ['全件があるのに頁が空', () => fetchMock.mockResolvedValueOnce(json({ rows: [], total: 3, page: 1, limit: 50 }))],
    ['合計が行数より少ない', () => fetchMock.mockResolvedValueOnce(json({ rows: [row()], total: 0, page: 1, limit: 50 }))],
  ])('FREQ-530-AC-02: %s時は読み込めなかった文（表は出さない）', async (_name, arrange) => {
    arrange();
    render(<PurchaseOrderDocumentSearchSection />);
    expect(await screen.findByRole('alert')).toHaveTextContent('取引書類を読み込めませんでした。時間をおいて再度お試しください。');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('FREQ-530-AC-02: 50件ずつ頁を送る。「次へ」「前へ」は同じ条件で page を変えて読み直し、範囲の表示は 51〜100 / 120', async () => {
    const user = userEvent.setup();
    const rows = (count: number) => Array.from({ length: count }, (_, index) => row({ attachmentId: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}` }));
    await loaded(rows(50), 120);
    expect(screen.getByText('1〜50 / 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前へ' })).toBeDisabled();
    fetchMock.mockResolvedValueOnce(page(rows(50), 120));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(await screen.findByText('51〜100 / 120')).toBeInTheDocument();
    expect(lastUrl().searchParams.get('page')).toBe('2');
    fetchMock.mockResolvedValueOnce(page(rows(20), 120));
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(await screen.findByText('101〜120 / 120')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '次へ' })).toBeDisabled();
    fetchMock.mockResolvedValueOnce(page(rows(50), 120));
    await user.click(screen.getByRole('button', { name: '前へ' }));
    expect(await screen.findByText('51〜100 / 120')).toBeInTheDocument();
  });

  test('FREQ-530-AC-02: 「印刷」は結果の表を window.print() で印刷する。条件欄・ボタン・頁送りは印刷しない（print:hidden）', async () => {
    const user = userEvent.setup();
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined);
    await loaded();
    await user.click(screen.getByRole('button', { name: '印刷' }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '検索' }).closest('form')?.className).toMatch(/print:hidden/);
    expect(screen.getByRole('link', { name: '発注一覧表に戻る' }).parentElement?.className).toMatch(/print:hidden/);
    expect(screen.getByRole('button', { name: '次へ' }).parentElement?.className).toMatch(/print:hidden/);
    const region = screen.getByRole('region', { name: '検索結果' });
    expect(region.className).not.toMatch(/print:hidden/);
    expect(region.closest('[class*="print:hidden"]')).toBeNull();
    // 画面だけの操作の列（原本を見る）は印刷しない
    const original = within(region).getByRole('columnheader', { name: '原本' });
    expect(original.className).toMatch(/print:hidden/);
    expect(within(region).getByRole('button', { name: '原本を見る' }).closest('td')?.className).toMatch(/print:hidden/);
  });

  test('FREQ-530-AC-02: 印刷では結果の表を丸ごと出す。画面用の高さの上限とスクロール（max-h・overflow-auto）と表の最小幅は print: で外し、スクロールの外の行が切れない', async () => {
    await loaded();
    const region = screen.getByRole('region', { name: '検索結果' });
    // 画面では見出しを保つ高さの上限つきスクロール領域・表は横に広がれる最小幅つき
    expect(region.className).toMatch(/max-h-\[70vh\]/);
    expect(region.className).toMatch(/(^|\s)overflow-auto(\s|$)/);
    expect(screen.getByRole('table', { name: '検索結果' }).className).toMatch(/min-w-\[52rem\]/);
    // 印刷では、上限・スクロール・最小幅を外す
    expect(region.className).toMatch(/print:max-h-none/);
    expect(region.className).toMatch(/print:overflow-visible/);
    expect(screen.getByRole('table', { name: '検索結果' }).className).toMatch(/print:min-w-0/);
  });

  test.each([390, 768, 1280])('FREQ-530-AC-02: 幅 %ipx でも結果の表は見出しを保ったスクロール領域に入り、頁全体を横に広げない', async (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
    await loaded();
    const region = screen.getByRole('region', { name: '検索結果' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toMatch(/overflow-auto/);
    expect(region.className).toMatch(/max-w-full/);
    for (const header of within(region).getAllByRole('columnheader')) expect(header.className).toMatch(/sticky/);
    expect(region.parentElement?.className).toMatch(/min-w-0/);
    expect(screen.getByLabelText('取引先').className).toMatch(/w-full/);
    expect(screen.getByLabelText('取引先').closest('.grid')?.className).toMatch(/grid-cols-1/);
  });

  test('FREQ-530-AC-02: ページは検索の部品を main の中に出す', async () => {
    fetchMock.mockResolvedValueOnce(page([row()]));
    render(<PurchaseOrderDocumentSearchPage />);
    expect(within(screen.getByRole('main')).getByRole('heading', { level: 1, name: '取引書類の検索' })).toBeInTheDocument();
    await screen.findByRole('table', { name: '検索結果' });
  });
});
