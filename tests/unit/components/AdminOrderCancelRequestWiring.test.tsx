import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';

/**
 * 管理画面の ORDER タブと、キャンセルの申し込みのつなぎ込み（グループ E-3 段2 の Task 12）。
 * 一覧（OrderSection）と、返金・支払い済みのキャンセル・取消の画面は本物を使い、キャンセルの申し込みの画面
 * （OrderCancelRequestDialog）だけを代役にする（中身は部品の試験が確かめる）。窓口（clientFetch）だけを差し替える。
 * 部品ごとの試験では見えない、管理画面の中での配線（一行の数と押した時・一覧のボタン・「品を外す」で開く画面と最初の数・
 * 成功の後の解決の窓口・解決に失敗した時の言葉・画面を閉じた時や答えが分からない時に解決しないこと・
 * 取消の画面を開く一覧の行が無い時の案内・欄の「返品」を選んでも絞り込みが外れないこと）を確かめる。
 */
const clientFetchMock = jest.fn();
const mockAttention = jest.fn();
const mockCancelRequestDialogProps = jest.fn();
// 代役の画面の「品を外す」が親へ渡す物。試験ごとに差し替える
let mockRemoveRequest: { cancelRequestId: string; mode: string; lines: Array<{ orderItemId: string; quantity: number }> } = {
  cancelRequestId: 'c3c3c3c3-1111-2222-8333-444455556666',
  mode: 'refund',
  lines: [{ orderItemId: 'item-1', quantity: 1 }],
};
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
// キャンセルの申し込みの画面の代役。受け取った props を記録し、「品を外す」「お断りした」「閉じる」で管理画面の処理を呼ぶ
jest.mock('@/components/OrderCancelRequestDialog', () => ({
  __esModule: true,
  default: (props: {
    orderId: string;
    open: boolean;
    canRefund?: boolean;
    onClose: () => void;
    onChanged: (notice: string) => void;
    onRemoveItems: (request: { cancelRequestId: string; mode: string; lines: Array<{ orderItemId: string; quantity: number }> }) => void;
  }) => {
    mockCancelRequestDialogProps(props);
    return (
      <div role="dialog" aria-label="キャンセルの申し込みの画面（試験の代役）">
        <p>{`注文: ${props.orderId}`}</p>
        <button type="button" onClick={() => props.onRemoveItems(mockRemoveRequest)}>代役: 品を外す</button>
        <button type="button" onClick={() => props.onChanged('お断りしました。')}>代役: お断りした</button>
        <button type="button" onClick={props.onClose}>代役: 閉じる</button>
      </div>
    );
  },
}));

const ORDER_ID = 'a1b2c3d4-1111-2222-8333-444455556666';
const CANCEL_REQUEST_ID = 'c3c3c3c3-1111-2222-8333-444455556666';
const STUB_NAME = 'キャンセルの申し込みの画面（試験の代役）';
const REFUND_PENDING_NOTICE = '返金を受け付けました。お金が戻ると、注文の状態が変わります。';
const PAID_CANCEL_PENDING_NOTICE = 'キャンセルを受け付けました。返金が済むと、注文がキャンセルになります。';
const UNPAID_CANCEL_NOTICE = '注文を取り消しました。';
const RESOLVED_NOTICE = 'キャンセルの申し込みを解決しました。';
const RESOLVE_FAILED =
  '返金・キャンセルは記録しましたが、申し込みを解決済みにできませんでした。キャンセルの申し込みの画面で「解決済みにする」を押してください。';
const PAID_CANCEL_SUBMIT = '注文をキャンセルして ￥20,000 を返金する';

/** 返金の画面・キャンセルの画面が読む「返金の材料」。ブラウス 2点（10,000 ずつ）が未発送で、送料は無い */
const MATERIALS = {
  order: {
    id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid', paymentMethod: 'card',
    totalAmount: 20000, shippingAmount: 0, discountAmount: 0, paidAmount: 20000,
    succeededAmount: 0, openAmount: 0, refundableAmount: 20000, refundedShipping: 0, refundableShipping: 0,
    shippedTotal: 0, unshippedTotal: 2,
  },
  lines: [
    {
      orderItemId: 'item-1', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
      itemPrice: 10000, quantity: 2, lineTotal: 20000, shipped: 0, unshipped: 2,
      refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 2,
      lineDiscount: 0, refundedUnits: 0,
    },
  ],
  awaitingRefund: null,
};

/** 発送準備中の支払い済みの注文の行。開いているキャンセルの申し込みがある */
function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    customerName: '山田 花子',
    customerEmail: 'hanako@example.com',
    orderDate: '2026-10-12',
    itemCount: '2点',
    items: [
      { id: 'item-1', name: 'シルクブラウス', color: '白', size: 'M', quantity: 2, fulfillmentType: 'stock', shipped: 0, inProduction: 0, readyUnshipped: 2 },
    ],
    totalAmount: '￥20,000',
    status: '発送準備中',
    orderStatus: 'paid',
    progressKey: 'ready',
    partiallyShipped: false,
    canRefund: true,
    canCancel: true,
    cancelKind: 'paid',
    cancelRequestOpen: true,
    ...overrides,
  };
}

function accepted(overrides: Record<string, unknown> = {}) {
  return { refundId: 'refund-1', status: 'pending', amount: 10000, replayed: false, ...overrides };
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

function refused(status: number, body: unknown) {
  return Promise.resolve({ ok: false, status, json: async () => body });
}

/** POST への既定の答え: 解決の窓口は解決した旨、ほか（返金・状態）は受け付けた旨 */
function defaultPostAnswer(url: string): Promise<unknown> {
  return url.endsWith('/resolve') ? ok({ data: { status: 'resolved' } }) : ok(accepted());
}

/** 一覧が返す行・一行の数・POST への答え。試験ごとに差し替える */
let orderRows: unknown[] = [];
let returnAttention: { requested: number; refundWaiting: number } | undefined;
let cancelRequestAttention: number | undefined;
let postAnswer: (url: string) => Promise<unknown> = defaultPostAnswer;

function serveApi() {
  clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'POST') return postAnswer(target);
    if (target.startsWith('/api/admin/orders?')) {
      return ok({
        data: orderRows,
        pagination: { page: 1, pageSize: 20, total: orderRows.length, totalPages: 1 },
        ...(returnAttention ? { returnAttention } : {}),
        ...(cancelRequestAttention !== undefined ? { cancelRequestAttention } : {}),
      });
    }
    if (target.endsWith('/refund')) return ok(MATERIALS);
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

/** キャンセルの申し込みのほかの絞り込み（状態・要確認のみ・取引先・注文・決済ID・金額・期間・返品）の、最後の問い合わせでの値。付いていなければ null */
function otherFilters() {
  const query = lastListQuery();
  return Object.fromEntries(
    ['status', 'review', 'counterparty', 'reference', 'amountMin', 'amountMax', 'from', 'to', 'return'].map((key) => [key, query.get(key)]),
  );
}

/** 窓口（url の終わりが suffix）へ POST した本文。送っていなければ undefined */
function postedBody(suffix: string): Record<string, unknown> | undefined {
  const call = clientFetchMock.mock.calls.find(
    ([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST',
  );
  return call ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
}

/** POST した窓口の URL（呼んだ順） */
function postedUrls(): string[] {
  return clientFetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([url]) => String(url));
}

/** 一覧を出し、一覧の「キャンセルの申し込み」で代役の画面を開く */
async function openRequestDialog() {
  render(<AdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'キャンセルの申し込み' }));
  return screen.findByRole('dialog', { name: STUB_NAME });
}

/** 代役の画面の「品を外す」を押す。親が、渡した mode の画面を開く */
function removeItems(request: typeof mockRemoveRequest) {
  mockRemoveRequest = request;
  fireEvent.click(screen.getByRole('button', { name: '代役: 品を外す' }));
}

beforeEach(() => {
  clientFetchMock.mockReset();
  mockAttention.mockReset();
  mockAttention.mockImplementation(() => ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }));
  mockCancelRequestDialogProps.mockReset();
  mockUserRole = 'admin';
  mockRemoveRequest = { cancelRequestId: CANCEL_REQUEST_ID, mode: 'refund', lines: [{ orderItemId: 'item-1', quantity: 1 }] };
  orderRows = [orderRow()];
  returnAttention = undefined;
  cancelRequestAttention = undefined;
  postAnswer = defaultPostAnswer;
  serveApi();
});

describe('管理画面の一覧の上の一行（キャンセルの申し込み）', () => {
  it('開いているキャンセルの申し込みの数を、返品の数に「・」でつないで一行に出す', async () => {
    returnAttention = { requested: 2, refundWaiting: 3 };
    cancelRequestAttention = 4;
    render(<AdminPage />);

    const line = await screen.findByTestId('return-attention');
    expect(line).toHaveTextContent('返品の申し込み 2件・返金待ち 3件・キャンセルの申し込み 4件');
    expect(within(line).getByRole('button', { name: 'キャンセルの申し込み 4件' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('返品の数が無い時は、キャンセルの申し込みの数だけを出す', async () => {
    cancelRequestAttention = 2;
    render(<AdminPage />);

    const line = await screen.findByTestId('return-attention');
    expect(line).toHaveTextContent(/^キャンセルの申し込み 2件$/);
    expect(within(line).getAllByRole('button')).toHaveLength(1);
  });

  it.each<[string, number | undefined]>([
    ['0件', 0],
    ['窓口が数を返さない', undefined],
  ])('キャンセルの申し込みの数が%sの時は、一行ごと出さない', async (_label, count) => {
    cancelRequestAttention = count;
    render(<AdminPage />);
    await screen.findByText(ORDER_ID);

    expect(screen.queryByTestId('return-attention')).not.toBeInTheDocument();
  });

  it('押すと cancelRequest=open で絞り込み、ほかの絞り込み（状態・要確認のみ・取引先・注文・決済ID・金額・期間・返品）を全部外す。もう一度押すと、この絞り込みだけを外す', async () => {
    returnAttention = { requested: 2, refundWaiting: 3 };
    cancelRequestAttention = 4;
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '返金待ち 3件' }));
    await waitFor(() => expect(lastListQuery().get('return')).toBe('refund_waiting'));
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
    expect(lastListQuery().get('cancelRequest')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み 4件' }));

    await waitFor(() => expect(lastListQuery().get('cancelRequest')).toBe('open'));
    expect(otherFilters()).toEqual({
      status: null, review: null, counterparty: null, reference: null,
      amountMin: null, amountMax: null, from: null, to: null, return: null,
    });
    expect(lastListQuery().get('page')).toBe('1');
    // 画面の欄も空に戻り、押した数だけが絞り込みとして残る
    expect(screen.getByRole('combobox', { name: '返品' })).toHaveValue('all');
    expect(screen.getByLabelText('取引先')).toHaveDisplayValue('');
    expect(screen.getByLabelText('注文・決済ID')).toHaveDisplayValue('');
    expect(screen.getByLabelText('金額（下限）')).toHaveDisplayValue('');
    expect(screen.getByLabelText('金額（上限）')).toHaveDisplayValue('');
    expect(document.getElementById('orders-from')).toHaveDisplayValue('');
    expect(document.getElementById('orders-to')).toHaveDisplayValue('');
    expect(screen.getByRole('button', { name: '発送済み（配送中・配達済み）' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '要確認のみ' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'キャンセルの申し込み 4件' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み 4件' }));

    await waitFor(() => expect(lastListQuery().get('cancelRequest')).toBeNull());
    expect(screen.getByRole('button', { name: 'キャンセルの申し込み 4件' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('返品の数を押すと、キャンセルの申し込みの絞り込みを外す。キャンセルの申し込みの数を押すと、返品の絞り込みを外す', async () => {
    returnAttention = { requested: 2, refundWaiting: 3 };
    cancelRequestAttention = 4;
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセルの申し込み 4件' }));
    await waitFor(() => expect(lastListQuery().get('cancelRequest')).toBe('open'));

    fireEvent.click(screen.getByRole('button', { name: '返金待ち 3件' }));

    await waitFor(() => expect(lastListQuery().get('return')).toBe('refund_waiting'));
    expect(lastListQuery().get('cancelRequest')).toBeNull();
    expect(screen.getByRole('button', { name: 'キャンセルの申し込み 4件' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み 4件' }));

    await waitFor(() => expect(lastListQuery().get('cancelRequest')).toBe('open'));
    expect(lastListQuery().get('return')).toBeNull();
    expect(screen.getByRole('combobox', { name: '返品' })).toHaveValue('all');
    expect(screen.getByRole('button', { name: '返金待ち 3件' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('開いている申し込みが無くなって数が0件になったら、絞り込みを自動で外す（一行の数が消え、外す手段が無いまま空の一覧が残らないように）', async () => {
    cancelRequestAttention = 1;
    render(<AdminPage />);
    const piece = await screen.findByRole('button', { name: 'キャンセルの申し込み 1件' });
    // 絞り込みを頼む読みの答えでは、もう片付いて 0 件になっている
    cancelRequestAttention = 0;

    fireEvent.click(piece);

    await waitFor(() => expect(listRequests()).toHaveLength(3));
    expect(new URL(String(listRequests()[1][0]), 'http://localhost').searchParams.get('cancelRequest')).toBe('open');
    expect(lastListQuery().get('cancelRequest')).toBeNull();
    expect(screen.queryByRole('button', { name: /キャンセルの申し込み \d+件/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('return-attention')).not.toBeInTheDocument();
  });
});

describe('管理画面の一覧の「キャンセルの申し込み」のボタン', () => {
  it('開いている申し込みのある注文にだけ出る。押すとキャンセルの申し込みの画面を開き、注文の番号と、返金できる人かどうかを渡す', async () => {
    orderRows = [orderRow(), orderRow({ id: 'order-without-request', cancelRequestOpen: false })];
    render(<AdminPage />);
    await screen.findByText('order-without-request');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'キャンセルの申し込み' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' }));

    const dialog = await screen.findByRole('dialog', { name: STUB_NAME });
    expect(within(dialog).getByText(`注文: ${ORDER_ID}`)).toBeInTheDocument();
    expect(mockCancelRequestDialogProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, open: true, canRefund: true }),
    );
  });

  it('サポートの人にも出る（権限 admin.orders.return は店長とサポート）。返金できない人として画面に伝える', async () => {
    mockUserRole = 'supporter';
    render(<AdminPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'キャンセルの申し込み' }));

    await screen.findByRole('dialog', { name: STUB_NAME });
    expect(mockCancelRequestDialogProps).toHaveBeenLastCalledWith(expect.objectContaining({ orderId: ORDER_ID, canRefund: false }));
  });

  it('画面でお断り・解決済みにしたら、画面を外し、知らせを出して、一覧を読み直す', async () => {
    const dialog = await openRequestDialog();
    expect(listRequests()).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole('button', { name: '代役: お断りした' }));

    expect(await screen.findByText('お断りしました。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(listRequests()).toHaveLength(2));
  });

  it('画面を閉じたら、画面を外す。窓口は呼ばない', async () => {
    const dialog = await openRequestDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: '代役: 閉じる' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postedUrls()).toEqual([]);
  });
});

describe('管理画面の「品を外す」（返金の画面。mode=refund）', () => {
  it('キャンセルの申し込みの画面を閉じ、返金の画面を開く。発送前の商品の数に、申し込みの数が最初から入る。まだ何も送らない', async () => {
    await openRequestDialog();

    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'refund', lines: [{ orderItemId: 'item-1', quantity: 1 }] });

    const dialog = await screen.findByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' });
    expect(screen.queryByRole('dialog', { name: STUB_NAME })).not.toBeInTheDocument();
    const group = await within(dialog).findByRole('group', { name: 'シルクブラウス（白 / M）' });
    expect(within(group).getByLabelText('返金する数')).toHaveValue(1);
    expect(within(dialog).getByRole('button', { name: '￥10,000 を返金する' })).toBeEnabled();
    expect(postedUrls()).toEqual([]);
  });

  it('返金が受け付けられたら（保留）、返金の番号で解決の窓口を呼び、返金の知らせに続けて解決の知らせを出し、一覧を読み直す', async () => {
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'refund', lines: [{ orderItemId: 'item-1', quantity: 1 }] });
    const dialog = await screen.findByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' });
    await within(dialog).findByRole('group', { name: 'シルクブラウス（白 / M）' });

    fireEvent.click(within(dialog).getByRole('button', { name: '￥10,000 を返金する' }));

    expect(await screen.findByText(`${REFUND_PENDING_NOTICE}${RESOLVED_NOTICE}`)).toBeInTheDocument();
    expect(postedUrls()).toEqual([
      `/api/admin/orders/${ORDER_ID}/refund`,
      `/api/admin/cancel-requests/${CANCEL_REQUEST_ID}/resolve`,
    ]);
    expect(postedBody('/resolve')).toEqual({ refundId: 'refund-1', orderCancelled: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // 受け付けた時と、解決の窓口が答えた後に、一覧を読み直す
    await waitFor(() => expect(listRequests()).toHaveLength(3));
  });

  it('解決の窓口が断られたら、返金の知らせは残し、解決できなかった言葉（C-5）を出す。解決した旨は出さない', async () => {
    postAnswer = (url) => (url.endsWith('/resolve') ? refused(500, { error: 'x' }) : ok(accepted()));
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'refund', lines: [{ orderItemId: 'item-1', quantity: 1 }] });
    const dialog = await screen.findByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' });
    await within(dialog).findByRole('group', { name: 'シルクブラウス（白 / M）' });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: '￥10,000 を返金する' }));

      expect(await screen.findByText(RESOLVE_FAILED)).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(RESOLVE_FAILED);
      expect(screen.getByText(REFUND_PENDING_NOTICE)).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(RESOLVED_NOTICE))).not.toBeInTheDocument();
      // 失敗した時も、一覧は読み直す（申し込みは開いたまま残っているので、印と一行の数をそのまま出す）
      await waitFor(() => expect(listRequests()).toHaveLength(3));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('返金の画面を閉じた（返金しなかった）ら、解決の窓口を呼ばない。そのあと一覧の「返金」から返金しても、申し込みの数は入らず、解決の窓口も呼ばない', async () => {
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'refund', lines: [{ orderItemId: 'item-1', quantity: 1 }] });
    const first = await screen.findByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' });
    await within(first).findByRole('group', { name: 'シルクブラウス（白 / M）' });
    fireEvent.click(within(first).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返金' }));

    const second = await screen.findByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' });
    const group = await within(second).findByRole('group', { name: 'シルクブラウス（白 / M）' });
    expect(within(group).getByLabelText('返金する数')).toHaveValue(0);
    fireEvent.change(within(group).getByLabelText('返金する数'), { target: { value: '2' } });
    fireEvent.click(within(second).getByRole('button', { name: '￥20,000 を返金する' }));
    expect(await screen.findByText(REFUND_PENDING_NOTICE)).toBeInTheDocument();
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(postedUrls()).toEqual([`/api/admin/orders/${ORDER_ID}/refund`]);
  });

  it('返金が断られたら（画面は開いたまま）、解決の窓口を呼ばない', async () => {
    postAnswer = (url) =>
      url.endsWith('/refund') ? refused(409, { error: '返せる額を超えています。', code: 'exceeds_refundable' }) : defaultPostAnswer(url);
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'refund', lines: [{ orderItemId: 'item-1', quantity: 1 }] });
    const dialog = await screen.findByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' });
    await within(dialog).findByRole('group', { name: 'シルクブラウス（白 / M）' });

    fireEvent.click(within(dialog).getByRole('button', { name: '￥10,000 を返金する' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返せる額を超えています。');
    expect(screen.getByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' })).toBeInTheDocument();
    expect(postedBody('/resolve')).toBeUndefined();
  });
});

describe('管理画面の「品を外す」（支払い済みのキャンセルの画面。mode=paid_cancel）', () => {
  it('キャンセルが受け付けられたら（保留）、返金の番号で解決の窓口を呼び、キャンセルの知らせに続けて解決の知らせを出す', async () => {
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'paid_cancel', lines: [{ orderItemId: 'item-1', quantity: 2 }] });
    const dialog = await screen.findByRole('dialog', { name: '注文をキャンセルする（注文 ORD-A1B2C3D4）' });
    expect(screen.queryByRole('dialog', { name: STUB_NAME })).not.toBeInTheDocument();
    await within(dialog).findByText('返金する額: ￥20,000（全額）');
    fireEvent.change(within(dialog).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });

    fireEvent.click(within(dialog).getByRole('button', { name: PAID_CANCEL_SUBMIT }));

    expect(await screen.findByText(`${PAID_CANCEL_PENDING_NOTICE}${RESOLVED_NOTICE}`)).toBeInTheDocument();
    expect(postedUrls()).toEqual([
      `/api/admin/orders/${ORDER_ID}/status`,
      `/api/admin/cancel-requests/${CANCEL_REQUEST_ID}/resolve`,
    ]);
    expect(postedBody('/resolve')).toEqual({ refundId: 'refund-1', orderCancelled: false });
  });
});

describe('管理画面の「品を外す」（取消の画面。mode=unpaid_cancel）', () => {
  beforeEach(() => {
    orderRows = [orderRow({ status: '未決済', orderStatus: 'pending', canRefund: false, cancelKind: 'unpaid' })];
  });

  it('取消の画面を開き（返金の材料は読まない）、取り消せたら、orderCancelled: true で解決の窓口を呼び、取消の知らせに続けて解決の知らせを出す', async () => {
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'unpaid_cancel', lines: [{ orderItemId: 'item-1', quantity: 2 }] });
    const dialog = await screen.findByRole('dialog', { name: '注文を取り消す（注文 ORD-A1B2C3D4）' });
    expect(screen.queryByRole('dialog', { name: STUB_NAME })).not.toBeInTheDocument();
    expect(clientFetchMock.mock.calls.some(([url]) => String(url).endsWith('/refund'))).toBe(false);
    fireEvent.change(within(dialog).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });

    fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));

    expect(await screen.findByText(`${UNPAID_CANCEL_NOTICE}${RESOLVED_NOTICE}`)).toBeInTheDocument();
    expect(postedBody('/status')).toEqual({ status: 'cancelled', reason: 'customer_request', notifyCustomer: true });
    expect(postedBody('/resolve')).toEqual({ refundId: null, orderCancelled: true });
    expect(postedUrls()).toEqual([
      `/api/admin/orders/${ORDER_ID}/status`,
      `/api/admin/cancel-requests/${CANCEL_REQUEST_ID}/resolve`,
    ]);
  });

  it('取消が断られたら、その言葉を出し、解決の窓口を呼ばない', async () => {
    postAnswer = (url) => (url.endsWith('/status') ? refused(409, { error: '払込票が有効な間は取り消せません。' }) : defaultPostAnswer(url));
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'unpaid_cancel', lines: [{ orderItemId: 'item-1', quantity: 2 }] });
    const dialog = await screen.findByRole('dialog', { name: '注文を取り消す（注文 ORD-A1B2C3D4）' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));

      expect(await screen.findByText('払込票が有効な間は取り消せません。')).toBeInTheDocument();
      expect(postedBody('/resolve')).toBeUndefined();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('取消の画面を開く一覧の行が無い時（開いている間に一覧が読み直されて、その注文が今のページから外れた）は、申し込みの画面を閉じ、一覧を読み直して案内を出す。何も送らない', async () => {
    await openRequestDialog();
    // 申し込みの画面を開いたまま、絞り込みを変えて一覧を読み直す。読み直した一覧には、この注文が無い
    orderRows = [orderRow({ id: 'order-other', cancelRequestOpen: false })];
    fireEvent.change(screen.getByRole('combobox', { name: '返品' }), { target: { value: 'refund_waiting' } });
    await screen.findByText('order-other');
    const readsBefore = listRequests().length;

    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'unpaid_cancel', lines: [{ orderItemId: 'item-1', quantity: 2 }] });

    expect(await screen.findByText('操作に失敗しました。一覧を更新してください。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(listRequests()).toHaveLength(readsBefore + 1));
    expect(postedUrls()).toEqual([]);
  });
});

/** 一覧の注文の行（表の行）。行の操作のボタンだけを探す（絞り込みの「キャンセル」のボタンと名前が重なるため） */
function orderRowElement(): HTMLElement {
  const row = screen.getAllByRole('row').find((candidate) => candidate.textContent?.includes(ORDER_ID));
  if (!row) throw new Error('注文の行が見つかりません');
  return row;
}

describe('管理画面の解決を待つ申し込みを外す場面（画面を閉じた時・答えが分からない時・返品の欄）', () => {
  it('支払い済みのキャンセルの画面を閉じたら、解決の窓口を呼ばない。そのあと一覧の「キャンセル」から受け付けても解決しない', async () => {
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'paid_cancel', lines: [{ orderItemId: 'item-1', quantity: 2 }] });
    const first = await screen.findByRole('dialog', { name: '注文をキャンセルする（注文 ORD-A1B2C3D4）' });
    await within(first).findByText('返金する額: ￥20,000（全額）');
    fireEvent.click(within(first).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(within(orderRowElement()).getByRole('button', { name: 'キャンセル' }));

    const second = await screen.findByRole('dialog', { name: '注文をキャンセルする（注文 ORD-A1B2C3D4）' });
    await within(second).findByText('返金する額: ￥20,000（全額）');
    fireEvent.change(within(second).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    fireEvent.click(within(second).getByRole('button', { name: PAID_CANCEL_SUBMIT }));
    expect(await screen.findByText(PAID_CANCEL_PENDING_NOTICE)).toBeInTheDocument();
    expect(postedUrls()).toEqual([`/api/admin/orders/${ORDER_ID}/status`]);
  });

  it('取消の画面を「戻る」で閉じたら、解決の窓口を呼ばない。そのあと一覧の「キャンセル」から取り消しても解決しない', async () => {
    orderRows = [orderRow({ status: '未決済', orderStatus: 'pending', canRefund: false, cancelKind: 'unpaid' })];
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'unpaid_cancel', lines: [{ orderItemId: 'item-1', quantity: 2 }] });
    const first = await screen.findByRole('dialog', { name: '注文を取り消す（注文 ORD-A1B2C3D4）' });
    fireEvent.click(within(first).getByRole('button', { name: '戻る' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(within(orderRowElement()).getByRole('button', { name: 'キャンセル' }));

    const second = await screen.findByRole('dialog', { name: '注文を取り消す（注文 ORD-A1B2C3D4）' });
    fireEvent.change(within(second).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    fireEvent.click(within(second).getByRole('button', { name: '取り消す' }));
    expect(await screen.findByText(UNPAID_CANCEL_NOTICE)).toBeInTheDocument();
    expect(postedUrls()).toEqual([`/api/admin/orders/${ORDER_ID}/status`]);
  });

  it('返金の答えが分からないまま画面を閉じたら（返金が行われたか分からない）、解決の窓口を呼ばず、一覧だけ読み直す', async () => {
    postAnswer = (url) => (url.endsWith('/refund') ? refused(500, { error: 'x' }) : defaultPostAnswer(url));
    await openRequestDialog();
    removeItems({ cancelRequestId: CANCEL_REQUEST_ID, mode: 'refund', lines: [{ orderItemId: 'item-1', quantity: 1 }] });
    const dialog = await screen.findByRole('dialog', { name: '返金（注文 ORD-A1B2C3D4）' });
    await within(dialog).findByRole('group', { name: 'シルクブラウス（白 / M）' });
    fireEvent.click(within(dialog).getByRole('button', { name: '￥10,000 を返金する' }));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(postedUrls()).toEqual([`/api/admin/orders/${ORDER_ID}/refund`]);
  });

  it('欄の「返品」を選んでも、キャンセルの申し込みの絞り込みは外さない（欄はほかの絞り込みと組み合わせられる）', async () => {
    cancelRequestAttention = 4;
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセルの申し込み 4件' }));
    await waitFor(() => expect(lastListQuery().get('cancelRequest')).toBe('open'));

    fireEvent.change(screen.getByRole('combobox', { name: '返品' }), { target: { value: 'refund_waiting' } });

    await waitFor(() => expect(lastListQuery().get('return')).toBe('refund_waiting'));
    expect(lastListQuery().get('cancelRequest')).toBe('open');
    expect(screen.getByRole('button', { name: 'キャンセルの申し込み 4件' })).toHaveAttribute('aria-pressed', 'true');
  });
});
