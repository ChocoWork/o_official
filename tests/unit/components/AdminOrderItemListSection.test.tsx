import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminOrderItemListSection from '@/components/AdminOrderItemListSection';
import type { AdminOrderItemRow } from '@/lib/orders/admin-orders/admin-order-types';

/**
 * 注文一覧表（G-4 Task 7）。一覧・CSV・要対応の欄を本物の部品でつなぎ、窓口（clientFetch）と画面の移動だけを差し替える。
 * 画面に出す言葉・読む問合せ・復元・読みの重なりを確かめる。
 */
const mockFetch = jest.fn();
const mockPush = jest.fn();
let mockRole: 'admin' | 'supporter' = 'admin';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props} onClick={(event) => event.preventDefault()}>{children}</a>
  ),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({ isLoggedIn: true, isAuthResolved: true, userRole: mockRole, isMfaVerified: true }),
}));
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));

const STORAGE_KEY = 'admin-order-list-state';
const LIST_URL = '/api/admin/order-items?';
const EXPORT_URL = '/api/admin/order-items/export?';
const ATTENTION_URL = '/api/admin/order-attention';
const ORDER = 'a1b2c3d4-1111-4222-8333-444455556666';
const ORDER_2 = 'b1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'c1111111-1111-4111-8111-111111111111';
const CAP_NOTE_5000 = '新しい5,000件の注文だけを表示しています。それより前の注文は「注文日（まで）」で期間を絞ると表示されます。';
const DESCRIPTION = '現在の絞り込みに合う全行を出力します。';

function itemRow(patch: Partial<AdminOrderItemRow> = {}): AdminOrderItemRow {
  return {
    orderId: ORDER, orderNumber: 'ORD-A1B2C3D4', orderCreatedAt: '2026-10-20T01:00:00Z', customerName: '山田 花子', customerEmail: 'hanako@example.com',
    orderItemId: ITEM_1, itemName: 'シルクブラウス', color: '白', size: 'M', isExchange: false, status: 'ready', quantity: 2, unitPrice: 6400, lineAmount: 12800, refundAmount: 0,
    blockedReasons: [], needsAttention: false, ...patch,
  };
}

type ListOptions = {
  rows?: AdminOrderItemRow[]; totalRows?: number; totalOrders?: number; ordersCapped?: boolean; ordersCap?: number; totalPages?: number;
  returnAttention?: { requested: number; refundWaiting: number }; cancelRequestAttention?: number;
};
function listBody(options: ListOptions = {}) {
  const rows = options.rows ?? [itemRow()];
  return {
    data: {
      rows, totalRows: options.totalRows ?? rows.length, totalOrders: options.totalOrders ?? 1, ordersCapped: options.ordersCapped ?? false,
      ordersCap: options.ordersCap ?? 5000, page: 1, pageSize: 20, totalPages: options.totalPages ?? 1,
    },
    returnAttention: options.returnAttention ?? { requested: 0, refundWaiting: 0 },
    cancelRequestAttention: options.cancelRequestAttention ?? 0,
  };
}

type Answer = { ok: boolean; status: number; json: () => Promise<unknown>; blob: () => Promise<Blob>; headers: { get: (name: string) => string | null } };
function answer(body: unknown, status = 200, headers: Record<string, string> = {}, blob: Blob = new Blob([''])): Promise<Answer> {
  return Promise.resolve({
    ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => blob,
    headers: { get: (name: string) => headers[name] ?? null },
  });
}

const emptyAttention = () => ({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } });

let attentionAnswer: () => Promise<Answer>;
let listAnswer: (params: URLSearchParams) => Promise<Answer>;
let exportAnswer: (params: URLSearchParams) => Promise<Answer>;
let postAnswer: (url: string) => Promise<Answer>;
const downloads: Array<{ name: string; blob: Blob | MediaSource }> = [];
const createObjectURL = jest.fn();
const revokeObjectURL = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  mockRole = 'admin';
  window.sessionStorage.clear();
  attentionAnswer = () => answer(emptyAttention());
  listAnswer = () => answer(listBody());
  exportAnswer = () => answer({}, 200, { 'Content-Disposition': 'attachment; filename="order-items_2026-10-26.csv"' });
  postAnswer = () => answer({});
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'POST') return postAnswer(target);
    if (target === ATTENTION_URL) return attentionAnswer();
    if (target.startsWith(EXPORT_URL)) return exportAnswer(new URL(target, 'http://localhost').searchParams);
    if (target.startsWith(LIST_URL)) return listAnswer(new URL(target, 'http://localhost').searchParams);
    return answer({});
  });
  downloads.length = 0;
  createObjectURL.mockReset();
  createObjectURL.mockImplementation((blob: Blob) => { downloads.push({ name: '', blob }); return 'blob:order-items'; });
  revokeObjectURL.mockReset();
  Object.defineProperty(window.URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
  Object.defineProperty(window.URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true });
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    downloads[downloads.length - 1].name = this.download;
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  // 窓口の失敗の記録は黙らせるが、状態の更新が act の外で起きた警告は見逃さない
  const actWarnings = (console.error as jest.Mock).mock.calls.filter(([message]) => String(message).includes('not wrapped in act'));
  jest.restoreAllMocks();
  expect(actWarnings).toEqual([]);
});

const listCalls = (): URLSearchParams[] => mockFetch.mock.calls
  .map(([url]) => String(url))
  .filter((url) => url.startsWith(LIST_URL))
  .map((url) => new URL(url, 'http://localhost').searchParams);
const lastList = (): URLSearchParams => listCalls().at(-1) as URLSearchParams;
const exportCalls = () => mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(EXPORT_URL));

async function open(): Promise<void> {
  render(<AdminOrderItemListSection />);
  await screen.findAllByRole('row', { name: /の詳細を開く/ });
}
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const change = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: '絞り込む' }));

describe('一覧の頁の上部と状態', () => {
  test('FREQ-536-AC-01: 見出し・説明・12列の表・読み込み中の文を出し、窓口は注文日なしの1頁目で読む', async () => {
    render(<AdminOrderItemListSection />);

    expect(screen.getByRole('heading', { level: 1, name: '注文一覧表' })).toBeInTheDocument();
    expect(screen.getByText('品物ごとに、ステータス別の数量で1行ずつ表示します。行を選ぶと注文の詳細を開きます。')).toBeInTheDocument();
    expect(await screen.findByText('注文一覧を読み込み中です...')).toBeInTheDocument();
    await screen.findByRole('row', { name: 'ORD-A1B2C3D4 シルクブラウス の詳細を開く' });
    expect(screen.queryByText('注文一覧を読み込み中です...')).not.toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(12);
    expect(screen.getByRole('link', { name: '管理画面に戻る' })).toHaveAttribute('href', '/admin?tab=ORDER');
    expect(mockFetch).toHaveBeenCalledWith('/api/admin/order-items?page=1', { cache: 'no-store' });
  });

  test('FREQ-536-AC-03: 条件に合う行が無ければ「条件に一致する品物はありません。」を出す。件数は 0行', async () => {
    listAnswer = () => answer(listBody({ rows: [], totalOrders: 0 }));
    render(<AdminOrderItemListSection />);

    expect(await screen.findByText('条件に一致する品物はありません。')).toBeInTheDocument();
    expect(screen.getByTestId('order-item-count')).toHaveTextContent('0行（0件の注文）');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cap-note')).not.toBeInTheDocument();
  });

  test.each([
    [403, {}, '注文一覧を見る権限がありません。'],
    [500, { error: '注文の情報を読み込めませんでした。' }, '注文一覧を読み込めませんでした。'],
    [400, { error: 'Invalid query' }, '注文一覧を読み込めませんでした。'],
    [422, { error: '条件に合う行が多すぎます（上限 20,000 行）。「注文日（から）」「注文日（まで）」で期間を絞ってください。' }, '条件に合う行が多すぎます（上限 20,000 行）。「注文日（から）」「注文日（まで）」で期間を絞ってください。'],
  ])('FREQ-536-AC-03: 読みが %i で断られたら、表の代わりに文を出す', async (status, body, message) => {
    listAnswer = () => answer(body, status);
    render(<AdminOrderItemListSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('FREQ-536-AC-03: 通信が切れた時と、形の違う答えは「読み込めませんでした。」にする', async () => {
    listAnswer = () => Promise.reject(new TypeError('Failed to fetch'));
    const { unmount } = render(<AdminOrderItemListSection />);
    expect(await screen.findByText('注文一覧を読み込めませんでした。')).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
    unmount();

    listAnswer = () => answer({ data: { rows: 'x' } });
    render(<AdminOrderItemListSection />);
    expect(await screen.findByText('注文一覧を読み込めませんでした。')).toBeInTheDocument();
  });
});

describe('絞り込み', () => {
  test('FREQ-536-AC-02: 初めて開いた時は全期間 — dateFrom は付かず、注文日（から）は空。選んだ時だけ付き、条件をクリアすると付かない', async () => {
    await open();

    expect(lastList().has('dateFrom')).toBe(false);
    expect(lastList().has('dateTo')).toBe(false);
    expect(field('注文日（から）').value).toBe('');
    expect(field('注文日（まで）').value).toBe('');
    expect(screen.getByText(DESCRIPTION)).toBeInTheDocument();

    change('注文日（から）', '2026-10-01');
    submit();
    await waitFor(() => expect(lastList().get('dateFrom')).toBe('2026-10-01'));
    expect(lastList().get('page')).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: '条件をクリア' }));
    await waitFor(() => expect(lastList().has('dateFrom')).toBe(false));
    expect(field('注文日（から）').value).toBe('');
  });

  test('FREQ-536-AC-02: 「絞り込む」を押すまで読み直さず、押すと問合せに値が載る（status の繰り返し・attention=1・日付・語）。値は URL に載らない', async () => {
    await open();
    const initial = listCalls().length;

    change('注文日（から）', '2026-09-01');
    change('注文日（まで）', '2026-10-31');
    change('注文ID', ' pi_abc123 ');
    change('顧客名', '山田');
    change('メールアドレス', 'hanako@example.com');
    change('商品名', 'ブラウス');
    change('色', '白');
    change('サイズ', 'M');
    fireEvent.click(screen.getByRole('button', { name: '発送準備中' }));
    fireEvent.click(screen.getByRole('button', { name: '発送済み' }));
    fireEvent.click(screen.getByRole('button', { name: '要対応のみ' }));
    expect(screen.getByRole('button', { name: '発送準備中' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '要対応のみ' })).toHaveAttribute('aria-pressed', 'true');
    expect(listCalls()).toHaveLength(initial);

    fireEvent.submit(screen.getByRole('form', { name: '注文の絞り込み' }));

    await waitFor(() => expect(listCalls()).toHaveLength(initial + 1));
    const params = lastList();
    expect(params.getAll('status')).toEqual(['ready', 'shipped']);
    expect(params.get('attention')).toBe('1');
    expect(params.get('dateFrom')).toBe('2026-09-01');
    expect(params.get('dateTo')).toBe('2026-10-31');
    // 決済ID（pi_…）は注文IDの欄の値として、trim してそのまま送る
    expect(params.get('orderNumber')).toBe('pi_abc123');
    expect(params.get('customer')).toBe('山田');
    expect(params.get('email')).toBe('hanako@example.com');
    expect(params.get('product')).toBe('ブラウス');
    expect(params.get('color')).toBe('白');
    expect(params.get('size')).toBe('M');
    expect(params.get('page')).toBe('1');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain('pi_abc123');
    expect(mockPush).not.toHaveBeenCalled();
  });

  test('FREQ-536-AC-02: ステータスは押し直すと外れる。選ぶ順に関わらず状態の定義順で送る', async () => {
    await open();

    fireEvent.click(screen.getByRole('button', { name: '返金待ち' }));
    fireEvent.click(screen.getByRole('button', { name: '未払い' }));
    fireEvent.click(screen.getByRole('button', { name: '配達済み' }));
    fireEvent.click(screen.getByRole('button', { name: '配達済み' }));
    expect(screen.getByRole('button', { name: '配達済み' })).toHaveAttribute('aria-pressed', 'false');
    submit();

    await waitFor(() => expect(lastList().getAll('status')).toEqual(['unpaid', 'refund_waiting']));
    expect(lastList().has('attention')).toBe(false);
  });

  test('FREQ-536-AC-02: 「条件をクリア」で入力・ステータス・要対応のみが全部消え、条件なしで読み直す', async () => {
    await open();
    change('顧客名', '山田');
    change('注文日（から）', '2026-09-01');
    fireEvent.click(screen.getByRole('button', { name: '発送済み' }));
    fireEvent.click(screen.getByRole('button', { name: '要対応のみ' }));
    submit();
    await waitFor(() => expect(lastList().get('customer')).toBe('山田'));

    fireEvent.click(screen.getByRole('button', { name: '条件をクリア' }));

    await waitFor(() => expect(lastList().toString()).toBe('page=1'));
    expect(field('顧客名').value).toBe('');
    expect(field('注文日（から）').value).toBe('');
    expect(screen.getByRole('button', { name: '発送済み' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '要対応のみ' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('FREQ-536-AC-02: 日付が逆なら読まずに誤りを出し、直して押すと読む', async () => {
    await open();
    const initial = listCalls().length;

    change('注文日（から）', '2026-12-31');
    change('注文日（まで）', '2026-01-01');
    submit();

    expect(await screen.findByText('期間指定が不正です。開始日は終了日以前にしてください。')).toBeInTheDocument();
    expect(listCalls()).toHaveLength(initial);

    change('注文日（から）', '2026-01-01');
    submit();
    await waitFor(() => expect(listCalls()).toHaveLength(initial + 1));
    expect(screen.queryByText('期間指定が不正です。開始日は終了日以前にしてください。')).not.toBeInTheDocument();
  });
});

describe('件数・上限の注記・頁送り・読みの重なり', () => {
  test('FREQ-536-AC-03: 総行数と注文数を別に出し、上限に達していなければ注記を出さない', async () => {
    listAnswer = () => answer(listBody({ rows: [itemRow(), itemRow({ orderItemId: 'c2222222-2222-4222-8222-222222222222', status: 'shipped' })], totalRows: 3, totalOrders: 2 }));
    await open();

    expect(screen.getByTestId('order-item-count')).toHaveTextContent('3行（2件の注文）');
    expect(screen.queryByTestId('cap-note')).not.toBeInTheDocument();
  });

  test('FREQ-536-AC-03: 一覧の上限 — ordersCapped が真なら「N行（新しいN件の注文の中で）」と cap-note を出す', async () => {
    listAnswer = () => answer(listBody({ totalRows: 12000, totalOrders: 5000, ordersCapped: true, ordersCap: 5000, totalPages: 600 }));
    await open();

    expect(screen.getByTestId('order-item-count')).toHaveTextContent('12000行（新しい5000件の注文の中で）');
    const note = screen.getByTestId('cap-note');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveTextContent(CAP_NOTE_5000);
  });

  test('FREQ-536-AC-03: ordersCap=2 なら「新しい2件の…」。行が0件でも注記を出す', async () => {
    listAnswer = () => answer(listBody({ rows: [], totalRows: 0, totalOrders: 0, ordersCapped: true, ordersCap: 2 }));
    render(<AdminOrderItemListSection />);

    expect(await screen.findByTestId('cap-note')).toHaveTextContent('新しい2件の注文だけを表示しています。それより前の注文は「注文日（まで）」で期間を絞ると表示されます。');
    expect(screen.getByText('条件に一致する品物はありません。')).toBeInTheDocument();
    expect(screen.getByTestId('order-item-count')).toHaveTextContent('0行（新しい0件の注文の中で）');
  });

  test('FREQ-536-AC-03: 頁送りで page が進み、注記は頁を送っても消えない。前の頁・次の頁は端で押せない', async () => {
    listAnswer = (params) => answer(listBody({ totalRows: 45, totalOrders: 30, ordersCapped: true, totalPages: 3, rows: [itemRow({ itemName: `品物${params.get('page')}` })] }));
    await open();

    expect(screen.getByText('1 / 3ページ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前の頁' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));

    await screen.findByRole('row', { name: 'ORD-A1B2C3D4 品物2 の詳細を開く' });
    expect(lastList().get('page')).toBe('2');
    expect(screen.getByText('2 / 3ページ')).toBeInTheDocument();
    expect(screen.getByTestId('cap-note')).toHaveTextContent(CAP_NOTE_5000);
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    await screen.findByRole('row', { name: 'ORD-A1B2C3D4 品物3 の詳細を開く' });
    expect(screen.getByRole('button', { name: '次の頁' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '前の頁' }));
    await screen.findByRole('row', { name: 'ORD-A1B2C3D4 品物2 の詳細を開く' });
    expect(lastList().get('page')).toBe('2');
  });

  test('FREQ-536-AC-03: 頁を送る読み直しの間も、前の頁の表・件数・注記・頁送りを外さず（aria-busy）、押した「次の頁」のフォーカスが残る。答えが来たら置き換える', async () => {
    let release: (value: Answer) => void = () => {};
    const body = (name: string) => listBody({ totalRows: 45, totalOrders: 30, ordersCapped: true, totalPages: 3, rows: [itemRow({ itemName: name })] });
    listAnswer = (params) => (params.get('page') === '2'
      ? new Promise<Answer>((resolve) => { release = resolve; })
      : answer(body('品物1')));
    await open();
    const next = screen.getByRole('button', { name: '次の頁' });
    next.focus();
    expect(next).toHaveFocus();

    fireEvent.click(next);
    await waitFor(() => expect(lastList().get('page')).toBe('2'));

    // 答えを待つ間: 前の頁が残り、同じボタンにフォーカスがあり、読み込み中の知らせと aria-busy が出る
    expect(screen.getByText('注文一覧を読み込み中です...')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'ORD-A1B2C3D4 品物1 の詳細を開く' })).toBeInTheDocument();
    expect(screen.getByTestId('order-item-count')).toHaveTextContent('45行（新しい30件の注文の中で）');
    expect(screen.getByTestId('cap-note')).toHaveTextContent(CAP_NOTE_5000);
    expect(screen.getByRole('button', { name: '次の頁' })).toBe(next);
    expect(next).toHaveFocus();
    expect(screen.getByTestId('order-item-count').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');

    await act(async () => release(await answer(body('品物2'))));

    await screen.findByRole('row', { name: 'ORD-A1B2C3D4 品物2 の詳細を開く' });
    expect(screen.queryByRole('row', { name: /品物1/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '次の頁' })).toBe(next);
    expect(next).toHaveFocus();
    expect(screen.getByTestId('order-item-count').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText('注文一覧を読み込み中です...')).not.toBeInTheDocument();
  });

  test('FREQ-536-AC-03: 読み直しが失敗したら、前の頁を出したままにせず失敗の文に置き換える', async () => {
    let fail = false;
    listAnswer = () => (fail ? answer({}, 500) : answer(listBody({ totalPages: 3 })));
    await open();
    fail = true;

    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));

    expect(await screen.findByText('注文一覧を読み込めませんでした。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('order-item-count')).not.toBeInTheDocument();
  });

  test('FREQ-536-AC-03: 20行の頁を表にし、条件を変えると1頁目から読む', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => itemRow({ orderItemId: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, itemName: `品物${index + 1}` }));
    listAnswer = (params) => answer(listBody({ rows, totalRows: 41, totalOrders: 41, totalPages: 3 }), 200, { page: params.get('page') ?? '' });
    await open();

    expect(screen.getAllByRole('row')).toHaveLength(21);
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    await waitFor(() => expect(lastList().get('page')).toBe('2'));
    change('顧客名', '山田');
    submit();
    await waitFor(() => expect(lastList().get('customer')).toBe('山田'));
    expect(lastList().get('page')).toBe('1');
  });

  test('FREQ-536-AC-03: 遅れて返った古い答えは、新しい条件の答えを上書きしない', async () => {
    const pending: Array<(value: Answer) => void> = [];
    listAnswer = () => new Promise<Answer>((resolve) => { pending.push(resolve); });
    render(<AdminOrderItemListSection />);
    await waitFor(() => expect(pending).toHaveLength(1));

    change('顧客名', '新しい');
    submit();
    await waitFor(() => expect(pending).toHaveLength(2));

    const respond = async (index: number, name: string) => {
      const value = await answer(listBody({ rows: [itemRow({ itemName: name })] }));
      await act(async () => pending[index](value));
    };
    await respond(1, '新しい条件の品物');
    expect(await screen.findByRole('row', { name: 'ORD-A1B2C3D4 新しい条件の品物 の詳細を開く' })).toBeInTheDocument();
    await respond(0, '古い条件の品物');

    expect(screen.queryByRole('row', { name: /古い条件の品物/ })).not.toBeInTheDocument();
    expect(screen.getByRole('row', { name: /新しい条件の品物/ })).toBeInTheDocument();
    expect(screen.queryByText('注文一覧を読み込み中です...')).not.toBeInTheDocument();
  });

  test('FREQ-536-AC-03: 古い答えが先に返っても、新しい答えが返るまで読み込み中の表示を消さない', async () => {
    const pending: Array<(value: Answer) => void> = [];
    listAnswer = () => new Promise<Answer>((resolve) => { pending.push(resolve); });
    render(<AdminOrderItemListSection />);
    await waitFor(() => expect(pending).toHaveLength(1));
    change('顧客名', '新しい');
    submit();
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => pending[0](await answer(listBody({ rows: [itemRow({ itemName: '古い' })] }))));

    expect(screen.getByText('注文一覧を読み込み中です...')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /古い/ })).not.toBeInTheDocument();
  });
});

describe('条件と頁の復元（sessionStorage）', () => {
  test('FREQ-536-AC-02: 適用した条件・頁を sessionStorage に残し、開き直す（詳細からの戻り）と同じ条件と頁で読む', async () => {
    listAnswer = () => answer(listBody({ totalRows: 60, totalOrders: 60, totalPages: 3 }));
    const first = render(<AdminOrderItemListSection />);
    await screen.findAllByRole('row', { name: /の詳細を開く/ });
    change('顧客名', '山田');
    fireEvent.click(screen.getByRole('button', { name: '発送済み' }));
    submit();
    await waitFor(() => expect(lastList().get('customer')).toBe('山田'));
    fireEvent.click(await screen.findByRole('button', { name: '次の頁' }));
    await waitFor(() => expect(lastList().get('page')).toBe('2'));

    expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ filters: { customer: '山田', statuses: ['shipped'] }, page: 2 });
    expect(window.location.search).toBe('');
    first.unmount();
    mockFetch.mockClear();

    render(<AdminOrderItemListSection />);
    await screen.findAllByRole('row', { name: /の詳細を開く/ });

    expect(listCalls()).toHaveLength(1);
    expect(lastList().get('customer')).toBe('山田');
    expect(lastList().getAll('status')).toEqual(['shipped']);
    expect(lastList().get('page')).toBe('2');
    expect(lastList().has('dateFrom')).toBe(false);
    expect(field('顧客名').value).toBe('山田');
    expect(screen.getByRole('button', { name: '発送済み' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('2 / 3ページ')).toBeInTheDocument();
  });

  test.each([
    ['JSON でない', 'not json'],
    ['形が違う', JSON.stringify({ filters: 'x', page: 1 })],
    ['未知の状態', JSON.stringify({ filters: { statuses: ['bogus'] }, page: 1 })],
    ['未知の項目だけ', JSON.stringify({ filters: { counterparty: 'x' }, page: 0 })],
    ['日付が逆', JSON.stringify({ filters: { dateFrom: '2026-12-31', dateTo: '2026-01-01' }, page: 1 })],
  ])('FREQ-536-AC-02: 保存した値が壊れている（%s）時は捨てて、初期値（全期間）で読む', async (_label, stored) => {
    window.sessionStorage.setItem(STORAGE_KEY, stored);
    await open();

    expect(listCalls()).toHaveLength(1);
    expect(lastList().toString()).toBe('page=1');
  });

  test('FREQ-536-AC-02: sessionStorage が投げても（読み書きとも）一覧は初期値（全期間）で動く', async () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    await open();

    expect(lastList().toString()).toBe('page=1');
    change('顧客名', '山田');
    submit();
    await waitFor(() => expect(lastList().get('customer')).toBe('山田'));
    expect(await screen.findByRole('row', { name: /の詳細を開く/ })).toBeInTheDocument();
  });
});

describe('行から詳細へ', () => {
  test('FREQ-536-AC-04: 行の押下と Enter/Space で /admin/orders/{id} へ移り、注文IDの Link の押下では移動を足さない', async () => {
    listAnswer = () => answer(listBody({ rows: [itemRow({ orderId: ORDER_2, orderNumber: 'ORD-B1B2C3D4' })] }));
    await open();
    const tableRow = screen.getByRole('row', { name: 'ORD-B1B2C3D4 シルクブラウス の詳細を開く' });

    fireEvent.click(screen.getByRole('link', { name: 'ORD-B1B2C3D4' }));
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'ORD-B1B2C3D4' })).toHaveAttribute('href', `/admin/orders/${ORDER_2}`);

    fireEvent.click(within(tableRow).getAllByRole('cell')[4]);
    fireEvent.keyDown(tableRow, { key: 'Enter' });
    fireEvent.keyDown(tableRow, { key: ' ' });

    expect(mockPush).toHaveBeenCalledTimes(3);
    expect(mockPush).toHaveBeenNthCalledWith(1, `/admin/orders/${ORDER_2}`);
    expect(mockPush).toHaveBeenNthCalledWith(3, `/admin/orders/${ORDER_2}`);
  });
});

describe('CSV出力', () => {
  test('FREQ-538-AC-01: 現在の絞り込み（頁を含まない）で export の窓口を呼び、返ってきた Blob をファイル名つきでダウンロードする', async () => {
    const blob = new Blob(['﻿"注文ID"\r\n'], { type: 'text/csv; charset=utf-8' });
    exportAnswer = () => answer({}, 200, { 'Content-Disposition': 'attachment; filename="order-items_2026-10-26.csv"' }, blob);
    await open();
    change('顧客名', '山田');
    fireEvent.click(screen.getByRole('button', { name: '発送済み' }));
    submit();
    await waitFor(() => expect(lastList().get('customer')).toBe('山田'));
    // 入力しただけで押していない条件は CSV に含めない
    change('商品名', '押していない');

    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(exportCalls()).toEqual(['/api/admin/order-items/export?customer=%E5%B1%B1%E7%94%B0&status=shipped']);
    expect(mockFetch).toHaveBeenCalledWith(exportCalls()[0], { cache: 'no-store' });
    // 窓口が作った CSV（BOM つき）の Blob をそのまま渡す。ブラウザの取得済みの行から作り直さない
    expect(downloads[0].blob).toBe(blob);
    expect(downloads[0].name).toBe('order-items_2026-10-26.csv');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:order-items');
  });

  test('FREQ-538-AC-01: ファイル名が無い・読めない時は今日の日付で作る', async () => {
    exportAnswer = () => answer({}, 200, { 'Content-Disposition': 'attachment; filename="../evil name.csv"' });
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));

    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toMatch(/^order-items_\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test('FREQ-538-AC-01: 一覧が上限で切っていても、CSV の呼出しは同じ条件（頁・上限を載せない）', async () => {
    listAnswer = () => answer(listBody({ totalRows: 12000, totalOrders: 5000, ordersCapped: true, totalPages: 600 }));
    await open();
    fireEvent.click(screen.getByRole('button', { name: '次の頁' }));
    await waitFor(() => expect(lastList().get('page')).toBe('2'));

    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));

    await waitFor(() => expect(exportCalls()).toHaveLength(1));
    expect(exportCalls()[0]).toBe('/api/admin/order-items/export?');
  });

  test('FREQ-538-AC-05: 422 の本文（期間を絞る案内）を出し、押し直せる', async () => {
    const message = '条件に合う行が多すぎます（上限 20,000 行）。「注文日（から）」「注文日（まで）」で期間を絞ってください。';
    exportAnswer = () => answer({ error: message }, 422);
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(downloads).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'CSV出力' })).toBeEnabled();
  });

  test('FREQ-538-AC-05: 回数の制限（429。窓口の本文は英語）は「しばらくしてから、もう一度お試しください。」を出し、押し直せる', async () => {
    exportAnswer = () => answer({ error: 'Too many requests' }, 429);
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));

    const alert = await screen.findByText('しばらくしてから、もう一度お試しください。');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
    expect(screen.queryByText('CSVを出力できませんでした。')).not.toBeInTheDocument();
    expect(downloads).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'CSV出力' })).toBeEnabled();
  });

  test.each([
    ['本文なし', () => answer({}, 500)],
    ['英語の本文', () => answer({ error: 'Invalid query' }, 400)],
    ['通信の失敗', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('FREQ-538-AC-05: 失敗（%s）は「CSVを出力できませんでした。」を role="alert" で出す', async (_label, failure) => {
    exportAnswer = failure;
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));

    const alert = await screen.findByText('CSVを出力できませんでした。');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
  });

  test('FREQ-538-AC-01: 作成中は「CSVを作成しています...」を出してボタンを無効にし、二重に呼ばない', async () => {
    let release: (value: Answer) => void = () => {};
    exportAnswer = () => new Promise<Answer>((resolve) => { release = resolve; });
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));

    expect(await screen.findByText('CSVを作成しています...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CSV出力' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'CSV出力' }));
    expect(exportCalls()).toHaveLength(1);

    await act(async () => release(await answer({}, 200, { 'Content-Disposition': 'attachment; filename="order-items_2026-10-26.csv"' })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'CSV出力' })).toBeEnabled());
    expect(screen.queryByText('CSVを作成しています...')).not.toBeInTheDocument();
  });
});

const REFUND_FAILURE = {
  id: 'exception-refund', reason: 'refund_failed', reasonLabel: '返金の失敗', detail: null, orderId: ORDER, orderNumber: 'ORD-A1B2C3D4', orderStatus: 'paid',
  paymentRef: 're_1', firstDetectedAt: '2026-10-11T04:00:00.000Z', lastDetectedAt: '2026-10-11T04:00:00.000Z', detectionCount: 1, canCancelOrder: false, canRetryRefund: true,
  refundFailure: { amount: 28800, failureReasonLabel: 'カードが使えません', shortages: [] as unknown[] },
};
const DELIVERY = { id: 'delivery-1', orderId: ORDER, orderNumber: 'ORD-A1B2C3D4', fulfillmentId: 'f1', fulfillmentNumber: 1, kind: 'delivery_failure', openedAt: '2026-10-21T03:00:00.000Z', status: 'failure' };
const REVIEW = { orderId: ORDER, orderNumber: 'ORD-A1B2C3D4', orderStatus: 'paid', reviewReason: 'stock_not_reserved', reviewReasonLabel: '在庫を確保できませんでした', reviewMarkedAt: null };

function attentionWith(parts: { exceptions?: unknown[]; reviews?: unknown[]; deliveries?: unknown[]; emailSending?: unknown }) {
  const { exceptions = [], reviews = [], deliveries = [], emailSending } = parts;
  return { data: { exceptions, reviews, deliveries, counts: { exceptions: exceptions.length, reviews: reviews.length, deliveries: deliveries.length }, ...(emailSending ? { emailSending } : {}) } };
}

describe('要対応の欄・メール停止の帯・要対応の一行', () => {
  test('FREQ-539-AC-05: 要対応の欄・要確認・配送が一覧の頁に出る。欄は id="attention" の中にある', async () => {
    attentionAnswer = () => answer(attentionWith({ exceptions: [REFUND_FAILURE], reviews: [REVIEW], deliveries: [DELIVERY] }));
    await open();

    const inbox = await screen.findByRole('heading', { name: '要対応 1件・要確認 1件・配送 1件' });
    expect(document.getElementById('attention')).toContainElement(inbox);
    expect(screen.getByText('失敗の理由: カードが使えません')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '確認済みにする' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '対応済みにする' })).toBeInTheDocument();
  });

  test.each(['送信元のドメインの設定', null])('FREQ-539-AC-05: 送信を止めている時は帯に原因 %s と再開の案内を出す', async (reasonLabel) => {
    attentionAnswer = () => answer(attentionWith({ emailSending: { paused: true, reasonLabel } }));
    await open();

    const title = await screen.findByText('お客様への注文のメールの送信を止めています');
    const banner = title.closest('[role="alert"]');
    expect(banner).toHaveAttribute('data-ui-banner-alert-variant', 'error');
    expect(banner).toHaveTextContent(`原因: ${reasonLabel ?? '不明'}。原因を直すと、15分ごとに1件ずつ試して自動で再開します（1日の送信の上限の時は日本時間 9時から）。手順は「注文のメールの手順書」の「送信の一時停止」にあります。`);
  });

  test.each([
    ['止めていない', { paused: false, reasonLabel: null }],
    ['値が null', null],
  ])('FREQ-539-AC-05: 送信状態が %s 時は帯を出さず、注文を読み込める', async (_label, emailSending) => {
    attentionAnswer = () => answer({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 }, emailSending } });
    await open();

    expect(screen.queryByText('お客様への注文のメールの送信を止めています')).not.toBeInTheDocument();
    expect(screen.queryByText('要対応・要確認を読み込めませんでした。')).not.toBeInTheDocument();
  });

  test('FREQ-539-AC-05: 要対応の欄を読めなかった時は、その旨を出す（「未処理なし」に見せない）。一覧は読める', async () => {
    attentionAnswer = () => answer({}, 500);
    await open();

    expect(await screen.findByText('要対応・要確認を読み込めませんでした。')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('row', { name: /の詳細を開く/ })).toBeInTheDocument();
  });

  test('FREQ-539-AC-05: 欄の「もう一度返金する」は ?open=refund、返品の返金は ?open=returns、履歴は #order-history へ移る', async () => {
    attentionAnswer = () => answer(attentionWith({
      exceptions: [REFUND_FAILURE, { ...REFUND_FAILURE, id: 'exception-return', orderId: ORDER_2, refundFailure: { ...REFUND_FAILURE.refundFailure, returnId: 'return-1' } }],
      deliveries: [DELIVERY],
    }));
    await open();

    const retries = await screen.findAllByRole('button', { name: 'もう一度返金する' });
    expect(retries).toHaveLength(2);
    fireEvent.click(retries[0]);
    fireEvent.click(retries[1]);
    fireEvent.click(screen.getByRole('button', { name: '履歴を開く' }));

    expect(mockPush).toHaveBeenNthCalledWith(1, `/admin/orders/${ORDER}?open=refund`);
    expect(mockPush).toHaveBeenNthCalledWith(2, `/admin/orders/${ORDER_2}?open=returns`);
    expect(mockPush).toHaveBeenNthCalledWith(3, `/admin/orders/${ORDER}#order-history`);
  });

  test('FREQ-539-AC-05: サポーターには「もう一度返金する」を出さず、配送の「対応済みにする」と履歴は出す', async () => {
    mockRole = 'supporter';
    attentionAnswer = () => answer(attentionWith({ exceptions: [REFUND_FAILURE], deliveries: [DELIVERY] }));
    await open();

    expect(await screen.findByRole('button', { name: '対応済みにする' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '履歴を開く' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'もう一度返金する' })).not.toBeInTheDocument();
  });

  test('FREQ-539-AC-05: 欄の操作が成功すると、知らせを出し、要対応の欄と一覧（今の条件と頁）を読み直す', async () => {
    attentionAnswer = () => answer(attentionWith({ reviews: [REVIEW] }));
    await open();
    change('顧客名', '山田');
    submit();
    await waitFor(() => expect(lastList().get('customer')).toBe('山田'));
    const listBefore = listCalls().length;
    const attentionBefore = mockFetch.mock.calls.filter(([url]) => String(url) === ATTENTION_URL).length;

    fireEvent.click(await screen.findByRole('button', { name: '確認済みにする' }));

    expect(await screen.findByText('確認済みにしました。')).toHaveAttribute('role', 'status');
    expect(mockFetch).toHaveBeenCalledWith(`/api/admin/orders/${ORDER}/review`, { method: 'POST' });
    await waitFor(() => expect(listCalls()).toHaveLength(listBefore + 1));
    expect(lastList().get('customer')).toBe('山田');
    expect(mockFetch.mock.calls.filter(([url]) => String(url) === ATTENTION_URL).length).toBe(attentionBefore + 1);
  });

  test('FREQ-539-AC-05: 欄の操作が断られたら理由を欄の下に出し、一覧は読み直さない', async () => {
    attentionAnswer = () => answer(attentionWith({ reviews: [REVIEW] }));
    postAnswer = () => answer({ error: 'Forbidden' }, 403);
    await open();
    const listBefore = listCalls().length;

    fireEvent.click(await screen.findByRole('button', { name: '確認済みにする' }));

    expect(await screen.findByText('この操作の権限がありません。')).toHaveAttribute('role', 'alert');
    expect(listCalls()).toHaveLength(listBefore);
    expect(screen.getByRole('button', { name: '確認済みにする' })).toBeEnabled();
  });

  test('FREQ-539-AC-05: 要対応の一行は 0件を出さず、押すと状態の絞り込みを1つだけにして読み直し、もう一度押すと外す', async () => {
    listAnswer = () => answer(listBody({ returnAttention: { requested: 2, refundWaiting: 0 }, cancelRequestAttention: 3 }));
    await open();

    const line = screen.getByTestId('return-attention');
    expect(within(line).getAllByRole('button').map((button) => button.textContent)).toEqual(['返品の申し込み 2件', 'キャンセルの申し込み 3件']);
    expect(screen.queryByRole('button', { name: /^返金待ち \d+件$/ })).not.toBeInTheDocument();

    // ほかの絞り込みは外れる
    change('顧客名', '山田');
    fireEvent.click(screen.getByRole('button', { name: '要対応のみ' }));
    submit();
    await waitFor(() => expect(lastList().get('customer')).toBe('山田'));

    fireEvent.click(screen.getByRole('button', { name: '返品の申し込み 2件' }));
    await waitFor(() => expect(lastList().toString()).toBe('status=return_requested&page=1'));
    expect(field('顧客名').value).toBe('');
    expect(screen.getByRole('button', { name: '返品の申し込み 2件' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'キャンセルの申し込み 3件' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み 3件' }));
    await waitFor(() => expect(lastList().toString()).toBe('status=cancel_requested&page=1'));
    expect(screen.getByRole('button', { name: '返品の申し込み 2件' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み 3件' }));
    await waitFor(() => expect(lastList().toString()).toBe('page=1'));
    expect(screen.getByRole('button', { name: 'キャンセルの申し込み 3件' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('FREQ-539-AC-05: 返金待ちの数は refund_waiting の1つだけに絞り込む', async () => {
    listAnswer = () => answer(listBody({ returnAttention: { requested: 0, refundWaiting: 1 } }));
    await open();

    fireEvent.click(screen.getByRole('button', { name: '返金待ち 1件' }));

    await waitFor(() => expect(lastList().getAll('status')).toEqual(['refund_waiting']));
    expect(screen.getByRole('button', { name: '返金待ち' })).toHaveAttribute('aria-pressed', 'true');
  });
});
