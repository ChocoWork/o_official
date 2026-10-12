import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';

/**
 * 管理画面の ORDER タブと、返品の列・絞り込みの欄・一覧の上の一行・返品の画面のつなぎ込み（グループ E-3 の Task 11）。
 * 一覧（OrderSection）と要対応の欄（AttentionInbox）は本物を使い、返品の画面（OrderReturnsDialog。Task 10）とふつうの返金の画面
 * （OrderRefundDialog）は代役にする（中身は部品ごとの試験が確かめる）。窓口（clientFetch）だけを差し替える。
 * 部品ごとの試験では見えない、管理画面の中での配線（どの絞り込みを窓口に頼むか・一行の数と押した時・返品の画面に何を渡すか・
 * 変えた後と閉じた後の読み直し・要対応の「もう一度返金する」がどちらの画面を開くか）を確かめる。
 */
const clientFetchMock = jest.fn();
const mockAttention = jest.fn();
const mockReturnsDialogProps = jest.fn();
// ログインしている人の役割。各試験の前に 'admin' に戻す
let mockUserRole = 'admin';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('tab=ORDER'),
}));
jest.mock('@/contexts/LoginContext', () => ({
  useLogin: () => ({
    isLoggedIn: true,
    isAuthResolved: true,
    userRole: mockUserRole,
    isMfaVerified: true,
  }),
}));
jest.mock('@/lib/client-fetch', () => ({
  clientFetch: (...args: unknown[]) =>
    String(args[0]) === '/api/admin/order-attention' ? mockAttention(...args) : clientFetchMock(...args),
}));
jest.mock('@/components/AdminSideNav', () => () => null);
jest.mock('@/components/KpiSection', () => () => null);
jest.mock('@/components/AccountingSection', () => () => null);
jest.mock('@/components/NewsSection', () => () => null);
jest.mock('@/components/ItemSection', () => () => null);
jest.mock('@/components/LookSection', () => () => null);
jest.mock('@/components/StockistSection', () => () => null);
jest.mock('@/components/UserSection', () => () => null);
// 返品の画面の代役。受け取った props を記録し、「変えた」「閉じる」で管理画面の処理を呼ぶ
jest.mock('@/components/OrderReturnsDialog', () => ({
  __esModule: true,
  default: (props: { orderId: string; canRefund: boolean; open: boolean; onClose: () => void; onChanged: () => void }) => {
    mockReturnsDialogProps(props);
    return (
      <div role="dialog" aria-label="返品の画面（試験の代役）">
        <p>{`注文: ${props.orderId}`}</p>
        <button type="button" onClick={props.onChanged}>代役: 変えた</button>
        <button type="button" onClick={props.onClose}>代役: 閉じる</button>
      </div>
    );
  },
}));
// ふつうの返金の画面の代役（要対応の「もう一度返金する」が、ふつうの返金の画面と返品の画面のどちらを開くかを見分けるため）
jest.mock('@/components/OrderRefundDialog', () => ({
  __esModule: true,
  default: (props: { orderId: string | null }) =>
    props.orderId ? (
      <div role="dialog" aria-label="返金の画面（試験の代役）">
        <p>{`返金: ${props.orderId}`}</p>
      </div>
    ) : null,
}));

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const RETURN_ID = 'f1f1f1f1-1111-2222-8333-444455556666';

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

/** 返品の要約の見本（窓口が一覧の各行に付ける形）。既定は、返品は無いが返品できる品がある */
function summary(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID, displayStatus: null, marks: [], nextAction: 'none', hasReturnable: true,
    refundWaitingReturns: 0, requestedReturns: 0,
    ...overrides,
  };
}

/** 発送済みの注文の行（返品できる品がある） */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-10-12',
    itemCount: '1点',
    items: [
      { id: 'item-1', name: 'シルクブラウス', color: '白', size: 'M', quantity: 1, fulfillmentType: 'stock', shipped: 1, inProduction: 0, readyUnshipped: 0 },
    ],
    totalAmount: '¥28,800',
    status: '配送中',
    orderStatus: 'shipped',
    progressKey: 'in_transit',
    partiallyShipped: false,
    returnSummary: summary(),
    ...overrides,
  };
}

/** 一覧が返す行・一覧の上の一行の数・ページ数。窓口の答えを試験ごとに変える */
let orderRows: unknown[] = [];
let returnAttention: { requested: number; refundWaiting: number } | undefined;
let totalPages = 1;

function serveApi() {
  clientFetchMock.mockImplementation((url: string) => {
    const target = String(url);
    if (target.startsWith('/api/admin/orders?')) {
      const page = Number(new URL(target, 'http://localhost').searchParams.get('page') ?? '1');
      return ok({
        data: orderRows,
        pagination: { page, pageSize: 20, total: totalPages * 20, totalPages },
        ...(returnAttention ? { returnAttention } : {}),
      });
    }
    return ok({});
  });
}

/** 管理画面が一覧を読んだ呼び出し（注文一覧の窓口） */
function listRequests() {
  return clientFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/orders?'));
}

/** 注文一覧の窓口へ頼んだ問い合わせ（最後の1回） */
function lastListQuery(): URLSearchParams {
  return new URL(String(listRequests().at(-1)?.[0]), 'http://localhost').searchParams;
}

/** 返品のほかの絞り込み（状態・要確認のみ・取引先・注文・決済ID・金額・期間）の、最後の問い合わせでの値。付いていなければ null */
function otherFilters() {
  const query = lastListQuery();
  return Object.fromEntries(
    ['status', 'review', 'counterparty', 'reference', 'amountMin', 'amountMax', 'from', 'to'].map((key) => [key, query.get(key)]),
  );
}

beforeEach(() => {
  clientFetchMock.mockReset();
  mockAttention.mockReset();
  mockAttention.mockImplementation(() => ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }));
  mockReturnsDialogProps.mockReset();
  mockUserRole = 'admin';
  orderRows = [orderRow()];
  returnAttention = undefined;
  totalPages = 1;
  serveApi();
});

describe('管理画面の一覧の上の一行', () => {
  it('一覧の窓口が返した件数から、「返品の申し込み {n}件・返金待ち {n}件」の一行を出す', async () => {
    returnAttention = { requested: 2, refundWaiting: 3 };
    render(<AdminPage />);

    const line = await screen.findByTestId('return-attention');
    expect(line).toHaveTextContent('返品の申し込み 2件・返金待ち 3件');
    expect(within(line).getByRole('button', { name: '返品の申し込み 2件' })).toBeInTheDocument();
    expect(within(line).getByRole('button', { name: '返金待ち 3件' })).toBeInTheDocument();
  });

  it.each([
    ['返金待ち 3件', { requested: 0, refundWaiting: 3 }],
    ['返品の申し込み 2件', { requested: 2, refundWaiting: 0 }],
  ])('一行は「%s」だけになる（0件の数と「・」は出さない）', async (text, counts) => {
    returnAttention = counts;
    render(<AdminPage />);

    const line = await screen.findByTestId('return-attention');
    expect(line).toHaveTextContent(new RegExp(`^${text}$`));
    expect(within(line).getAllByRole('button')).toHaveLength(1);
  });

  it.each([
    ['両方0件', { requested: 0, refundWaiting: 0 }],
    ['窓口が件数を返さない', undefined],
  ])('%s の時は、一行ごと出さない', async (_label, counts) => {
    returnAttention = counts;
    render(<AdminPage />);
    await screen.findByText(ORDER_ID);

    expect(screen.queryByTestId('return-attention')).not.toBeInTheDocument();
  });

  it('「返金待ち 3件」を押すと、返金待ちで絞り込み（窓口へ return=refund_waiting を頼み、絞り込みの欄もそれを選ぶ）、もう一度押すと外す', async () => {
    returnAttention = { requested: 2, refundWaiting: 3 };
    render(<AdminPage />);
    const button = await screen.findByRole('button', { name: '返金待ち 3件' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(lastListQuery().get('return')).toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(lastListQuery().get('return')).toBe('refund_waiting'));
    expect(screen.getByRole('combobox', { name: '返品' })).toHaveValue('refund_waiting');
    expect(screen.getByRole('button', { name: '返金待ち 3件' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '返品の申し込み 2件' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: '返金待ち 3件' }));

    await waitFor(() => expect(lastListQuery().get('return')).toBeNull());
    expect(screen.getByRole('combobox', { name: '返品' })).toHaveValue('all');
  });

  it('一行の数を押すと、ほかの絞り込み（状態・要確認のみ・取引先・注文・決済ID・金額・期間）を全部外して、返品だけで絞る（数は全体の注文の数なので、残すと数より少なく出て合わなくなる）', async () => {
    returnAttention = { requested: 2, refundWaiting: 3 };
    render(<AdminPage />);
    await screen.findByRole('button', { name: '返金待ち 3件' });
    fireEvent.click(screen.getByRole('button', { name: '発送済み（配送中・配達済み）' }));
    fireEvent.click(screen.getByRole('button', { name: '要確認のみ' }));
    fireEvent.change(screen.getByLabelText('取引先'), { target: { value: 'hanako@example.com' } });
    fireEvent.change(screen.getByLabelText('注文・決済ID'), { target: { value: 'pi_123' } });
    fireEvent.change(screen.getByLabelText('金額（下限）'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('金額（上限）'), { target: { value: '50000' } });
    fireEvent.change(document.getElementById('orders-from') as HTMLElement, { target: { value: '2026-10-01' } });
    fireEvent.change(document.getElementById('orders-to') as HTMLElement, { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByRole('button', { name: '期間適用' }));
    await waitFor(() => expect(lastListQuery().get('to')).toBe('2026-10-31'));
    expect(otherFilters()).toEqual({
      status: 'shipped', review: 'only', counterparty: 'hanako@example.com', reference: 'pi_123',
      amountMin: '1000', amountMax: '50000', from: '2026-10-01', to: '2026-10-31',
    });

    fireEvent.click(screen.getByRole('button', { name: '返金待ち 3件' }));

    await waitFor(() => expect(lastListQuery().get('return')).toBe('refund_waiting'));
    expect(otherFilters()).toEqual({
      status: null, review: null, counterparty: null, reference: null,
      amountMin: null, amountMax: null, from: null, to: null,
    });
    expect(lastListQuery().get('page')).toBe('1');
    // 画面の欄も空に戻り、押した数だけが絞り込みとして残る
    expect(screen.getByLabelText('取引先')).toHaveDisplayValue('');
    expect(screen.getByLabelText('注文・決済ID')).toHaveDisplayValue('');
    expect(screen.getByLabelText('金額（下限）')).toHaveDisplayValue('');
    expect(screen.getByLabelText('金額（上限）')).toHaveDisplayValue('');
    expect(document.getElementById('orders-from')).toHaveDisplayValue('');
    expect(document.getElementById('orders-to')).toHaveDisplayValue('');
    expect(screen.getByRole('button', { name: '発送済み（配送中・配達済み）' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '要確認のみ' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '返金待ち 3件' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('押した数をもう一度押すと、返品の絞り込みだけを外す（押した後に付けたほかの絞り込みには触らない）', async () => {
    returnAttention = { requested: 2, refundWaiting: 3 };
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '返金待ち 3件' }));
    await waitFor(() => expect(lastListQuery().get('return')).toBe('refund_waiting'));
    fireEvent.click(screen.getByRole('button', { name: '発送済み（配送中・配達済み）' }));
    await waitFor(() => expect(lastListQuery().get('status')).toBe('shipped'));
    expect(lastListQuery().get('return')).toBe('refund_waiting');

    fireEvent.click(screen.getByRole('button', { name: '返金待ち 3件' }));

    await waitFor(() => expect(lastListQuery().get('return')).toBeNull());
    expect(lastListQuery().get('status')).toBe('shipped');
  });
});

describe('管理画面の返品の絞り込みの欄', () => {
  it('見出し「返品」の欄は、すべて・返品の申し込み・返品中・返金待ち・返品済みの順に並び、最初は「すべて」で、窓口へ return= を頼まない', async () => {
    render(<AdminPage />);

    const select = await screen.findByRole('combobox', { name: '返品' });
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'すべて', '返品の申し込み', '返品中', '返金待ち', '返品済み',
    ]);
    expect(select).toHaveValue('all');
    await waitFor(() => expect(listRequests()).toHaveLength(1));
    expect(lastListQuery().get('return')).toBeNull();
  });

  it.each([
    ['返品の申し込み', 'requested'],
    ['返品中', 'in_progress'],
    ['返金待ち', 'refund_waiting'],
    ['返品済み', 'returned'],
  ])('欄で「%s」を選ぶと、窓口へ return=%s で頼む', async (_label, value) => {
    render(<AdminPage />);
    fireEvent.change(await screen.findByRole('combobox', { name: '返品' }), { target: { value } });

    await waitFor(() => expect(lastListQuery().get('return')).toBe(value));
  });

  it('絞り込みを変えると、何ページ目にいても1ページ目から読む。ほかの絞り込み（状態）はそのまま保つ', async () => {
    totalPages = 3;
    render(<AdminPage />);
    await screen.findByText('1 / 3ページ');
    fireEvent.click(screen.getByRole('button', { name: '発送済み（配送中・配達済み）' }));
    await waitFor(() => expect(lastListQuery().get('status')).toBe('shipped'));
    // 読み込み中の間は「次へ」が押せないので、答えが返って押せるようになってから押す
    await waitFor(() => expect(screen.getByRole('button', { name: '次へ' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '次へ' }));
    await waitFor(() => expect(lastListQuery().get('page')).toBe('2'));
    await screen.findByText('2 / 3ページ');

    fireEvent.change(screen.getByRole('combobox', { name: '返品' }), { target: { value: 'returned' } });

    await waitFor(() => expect(lastListQuery().get('return')).toBe('returned'));
    expect(lastListQuery().get('page')).toBe('1');
    expect(lastListQuery().get('status')).toBe('shipped');
  });
});

describe('管理画面の返品の画面のつなぎ', () => {
  it('一覧の「返品」を押すと返品の画面を開き、注文の番号と、返金できる人かどうかを渡す', async () => {
    render(<AdminPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: '返品' }));

    const dialog = await screen.findByRole('dialog', { name: '返品の画面（試験の代役）' });
    expect(within(dialog).getByText(`注文: ${ORDER_ID}`)).toBeInTheDocument();
    expect(mockReturnsDialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, canRefund: true, open: true }),
    );
  });

  it.each([
    ['admin', '額を決めて返金する', true],
    ['supporter', '返品', false],
  ])('%s の一覧の返金待ちの注文のボタンは「%s」で、返品の画面には canRefund=%s を渡す', async (role, label, canRefund) => {
    mockUserRole = role;
    orderRows = [
      orderRow({
        returnSummary: summary({ displayStatus: 'refund_waiting', nextAction: 'refund', refundWaitingReturns: 1 }),
      }),
    ];
    render(<AdminPage />);

    fireEvent.click(await screen.findByRole('button', { name: label }));

    await screen.findByRole('dialog', { name: '返品の画面（試験の代役）' });
    expect(mockReturnsDialogProps).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: ORDER_ID, canRefund }));
  });

  it('返品の画面で何かを変えたら、一覧と要対応を読み直す（画面は開いたまま）。閉じたら、画面を外して一覧を読み直す', async () => {
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '返品' }));
    const dialog = await screen.findByRole('dialog', { name: '返品の画面（試験の代役）' });
    const attentionReads = mockAttention.mock.calls.length;
    expect(listRequests()).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole('button', { name: '代役: 変えた' }));

    await waitFor(() => expect(listRequests()).toHaveLength(2));
    await waitFor(() => expect(mockAttention.mock.calls.length).toBeGreaterThan(attentionReads));
    expect(screen.getByRole('dialog', { name: '返品の画面（試験の代役）' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '代役: 閉じる' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(listRequests()).toHaveLength(3));
  });
});

describe('管理画面の要対応「返金の失敗」の「もう一度返金する」（返品の返金。グループ E-3 の P21）', () => {
  /** 返金の失敗の要対応を1件返す。refundFailure.returnId があれば、失敗した返金は返品の返金 */
  function serveRefundFailure(returnId: string | null) {
    mockAttention.mockImplementation(() => ok({ data: {
      exceptions: [{
        id: 'exception-refund', reason: 'refund_failed', reasonLabel: '返金の失敗', detail: 'expired_or_canceled_card',
        orderId: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', orderStatus: 'shipped', paymentRef: 're_test_1',
        firstDetectedAt: '2026-10-12T04:00:00.000Z', lastDetectedAt: '2026-10-12T04:00:00.000Z', detectionCount: 1,
        canCancelOrder: false, canRetryRefund: true,
        refundFailure: { amount: 12800, failureReasonLabel: 'カードが使えません', shortages: [], returnId },
      }],
      reviews: [],
      counts: { exceptions: 1, reviews: 0 },
    } }));
  }

  it('失敗した返金が返品の返金なら、「もう一度返金する」はふつうの返金の画面ではなく、その注文の返品の画面を開く', async () => {
    serveRefundFailure(RETURN_ID);
    render(<AdminPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'もう一度返金する' }));

    const dialog = await screen.findByRole('dialog', { name: '返品の画面（試験の代役）' });
    expect(within(dialog).getByText(`注文: ${ORDER_ID}`)).toBeInTheDocument();
    expect(mockReturnsDialogProps).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: ORDER_ID, canRefund: true }));
    expect(screen.queryByRole('dialog', { name: '返金の画面（試験の代役）' })).not.toBeInTheDocument();
  });

  it('ふつうの返金の失敗は、今のとおりふつうの返金の画面を開く（返品の画面は開かない）', async () => {
    serveRefundFailure(null);
    render(<AdminPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'もう一度返金する' }));

    const dialog = await screen.findByRole('dialog', { name: '返金の画面（試験の代役）' });
    expect(within(dialog).getByText(`返金: ${ORDER_ID}`)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '返品の画面（試験の代役）' })).not.toBeInTheDocument();
  });

  it.each<[string, string | null]>([
    ['返品の返金', RETURN_ID],
    ['ふつうの返金', null],
  ])('サポートの人（返金の権限が無い人）には、%sの失敗にも「もう一度返金する」を出さない', async (_label, returnId) => {
    mockUserRole = 'supporter';
    serveRefundFailure(returnId);
    render(<AdminPage />);
    await screen.findByText('返金の失敗（ORD-A1B2C3D4）');

    expect(screen.queryByRole('button', { name: 'もう一度返金する' })).not.toBeInTheDocument();
  });
});
