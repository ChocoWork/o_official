import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AdminPage from '@/app/admin/page';

/**
 * 管理画面の ORDER タブと、返金の画面・支払い済みのキャンセルの画面のつなぎ込み（グループ E-2 の Task 11）。
 * 一覧（OrderSection）は返金とキャンセルのボタンだけの代役にし、返金の画面とキャンセルの画面は本物を使う。
 * 窓口（clientFetch）だけを差し替える。部品ごとの試験（OrderRefundDialog・OrderPaidCancelDialog）では見えない、
 * 管理画面の中での配線（知らせ・一覧の読み直し・どの画面を開くか）を確かめる。
 */
const clientFetchMock = jest.fn();
const mockAttention = jest.fn();
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
// 一覧の代役。ボタンの名前を「一覧の…」にして、画面の中のボタン（キャンセル・閉じる）と区別する。
// キャンセルのボタンは、本物の一覧と同じく、行の canCancel が true の時だけ出す
jest.mock('@/components/OrderSection', () => ({
  __esModule: true,
  default: (props: {
    orders: Array<{ id: string; status: string; canCancel?: boolean }>;
    errorMessage?: string | null;
    noticeMessage?: string | null;
    onRefundOrder?: (id: string) => void;
    onCancelOrder?: (id: string) => void;
  }) => (
    <section>
      <p data-testid="order-status">{props.orders[0]?.status ?? 'none'}</p>
      {props.errorMessage ? <p role="alert">{props.errorMessage}</p> : null}
      {props.noticeMessage ? <p role="status">{props.noticeMessage}</p> : null}
      {props.orders.map((order) => (
        <div key={order.id}>
          <button type="button" onClick={() => props.onRefundOrder?.(order.id)}>{`返金 ${order.id}`}</button>
          {order.canCancel ? (
            <button type="button" onClick={() => props.onCancelOrder?.(order.id)}>{`一覧のキャンセル ${order.id}`}</button>
          ) : null}
        </div>
      ))}
    </section>
  ),
}));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PENDING_NOTICE = '返金を受け付けました。お金が戻ると、注文の状態が変わります。';
const CANCEL_PENDING_NOTICE = 'キャンセルを受け付けました。返金が済むと、注文がキャンセルになります。';
const PAID_CANCEL_SUBMIT = '注文をキャンセルして ￥10,000 を返金する';

/** 返金の画面・キャンセルの画面が読む「返金の材料」。在庫の品1つ（10,000）で、送料は無い */
const MATERIALS = {
  order: {
    id: 'order-1', orderNumber: 'ORD-1', status: 'paid', paymentMethod: 'card',
    totalAmount: 10000, shippingAmount: 0, discountAmount: 0, paidAmount: 10000,
    succeededAmount: 0, openAmount: 0, refundableAmount: 10000, refundedShipping: 0, refundableShipping: 0,
    shippedTotal: 0, unshippedTotal: 1,
  },
  lines: [
    {
      orderItemId: 'item-1', name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock',
      itemPrice: 10000, quantity: 1, lineTotal: 10000, shipped: 0, unshipped: 1,
      refundedBeforeShipment: 0, refundedAfterShipment: 0, shippedRefundable: 0, restockable: 1,
      lineDiscount: 0, refundedUnits: 0,
    },
  ],
  awaitingRefund: null,
};

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    customerName: 'Customer',
    customerEmail: 'buyer@example.com',
    orderDate: '2026-09-22',
    itemCount: '1点',
    items: [],
    totalAmount: '￥10,000',
    status: '発送準備中',
    orderStatus: 'paid',
    canRefund: true,
    canCancel: true,
    cancelKind: 'paid',
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

/** 一覧が返す行と、POST への答え。窓口を呼んだ後に差し替えて、読み直した結果を再現する */
let orderRows: unknown[] = [];
let postAnswer: (url: string) => Promise<unknown> = () => ok(accepted());

/** 返事を止めておく。release(返事) で返す（画面の更新まで待つ） */
function hold() {
  let resolve: (answer: unknown) => void = () => undefined;
  const held = new Promise<unknown>((resolveHeld) => {
    resolve = resolveHeld;
  });
  return {
    held,
    release: (answer: unknown) =>
      act(async () => {
        resolve(answer);
        await held;
      }),
  };
}

/** 窓口（url の終わりが suffix）への POST の返事を止めておく。返すときは、戻り値の関数に返事を渡す */
function holdPost(suffix: string) {
  const { held, release } = hold();
  const previous = postAnswer;
  postAnswer = (url) => (url.endsWith(suffix) ? held : previous(url));
  return release;
}

function serveApi() {
  clientFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'POST') return postAnswer(target);
    if (target.startsWith('/api/admin/orders?')) {
      return ok({ data: orderRows, pagination: { page: 1, pageSize: 20, total: orderRows.length, totalPages: 1 } });
    }
    if (target.endsWith('/refund')) return ok(MATERIALS);
    return ok({});
  });
}

/** 管理画面が一覧を読んだ呼び出し（注文一覧の窓口） */
function listRequests() {
  return clientFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/admin/orders?'));
}

/** 窓口（url の終わりが suffix）へ POST した本文。送っていなければ undefined */
function postedBody(suffix: string): Record<string, unknown> | undefined {
  const call = clientFetchMock.mock.calls.find(
    ([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST',
  );
  return call ? (JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
}

/** 一覧を出し、「返金」で返金の画面を開き、材料を読み終えるまで待つ */
async function openRefundDialog() {
  render(<AdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: '返金 order-1' }));
  const dialog = await screen.findByRole('dialog', { name: '返金（注文 ORD-ORDER-1）' });
  await within(dialog).findByRole('group', { name: 'シルクブラウス（白 / M）' });
  return dialog;
}

/** 在庫の品1つを全部返す（1つも発送していない注文の商品が全部なので、額は全額に固定される） */
function submitFullRefund(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('返金する数'), { target: { value: '1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '￥10,000 を返金する' }));
}

/** 一覧を出し、支払い済みの注文の「キャンセル」でキャンセルの画面を開き、材料を読み終えるまで待つ */
async function openPaidCancelDialog() {
  render(<AdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: '一覧のキャンセル order-1' }));
  const dialog = await screen.findByRole('dialog', { name: '注文をキャンセルする（注文 ORD-ORDER-1）' });
  await within(dialog).findByText('返金する額: ￥10,000（全額）');
  return dialog;
}

describe('管理画面の返金の画面', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    mockAttention.mockReset();
    mockAttention.mockImplementation(() => ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }));
    mockUserRole = 'admin';
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    orderRows = [orderRow()];
    postAnswer = () => ok(accepted());
    serveApi();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('「返金」で返金の画面が開き、返金の材料を読む。確認の文（window.confirm）は使わず、まだ何も送らない', async () => {
    const dialog = await openRefundDialog();

    expect(clientFetchMock).toHaveBeenCalledWith('/api/admin/orders/order-1/refund', { cache: 'no-store' });
    expect(within(dialog).getByRole('button', { name: '￥0 を返金する' })).toBeDisabled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(postedBody('/refund')).toBeUndefined();
  });

  it('返金を受け付けたら（保留）、画面を閉じ、知らせを出して、一覧と要対応を読み直す', async () => {
    const dialog = await openRefundDialog();
    const attentionReads = mockAttention.mock.calls.length;
    submitFullRefund(dialog);

    expect(await screen.findByText(PENDING_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postedBody('/refund')).toEqual({
      requestKey: expect.stringMatching(UUID_PATTERN),
      lines: [{ orderItemId: 'item-1', quantity: 1, beforeShipment: true }],
      restock: true,
      shippingAmount: 0,
      amount: 10000,
      note: null,
      stripeReason: 'requested_by_customer',
      notifyCustomer: true,
    });
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    await waitFor(() => expect(mockAttention.mock.calls.length).toBeGreaterThan(attentionReads));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('返金が成功したら、「返金しました。」を出し、読み直した一覧の言葉を出す', async () => {
    postAnswer = () => {
      orderRows = [orderRow({ status: 'キャンセル', orderStatus: 'cancelled', canRefund: false, canCancel: false, cancelKind: null })];
      return ok(accepted({ status: 'succeeded' }));
    };
    const dialog = await openRefundDialog();
    submitFullRefund(dialog);

    expect(await screen.findByText('返金しました。')).toBeInTheDocument();
    expect(screen.queryByText(PENDING_NOTICE)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('order-status')).toHaveTextContent('キャンセル'));
    expect(listRequests()).toHaveLength(2);
  });

  it('窓口が断ったら、画面を開いたまま理由を出し、知らせも出さず、一覧は読み直さない', async () => {
    postAnswer = () => refused(409, { error: '返せる額を超えています。', code: 'exceeds_refundable' });
    const dialog = await openRefundDialog();
    submitFullRefund(dialog);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('返せる額を超えています。');
    expect(screen.getByRole('dialog', { name: '返金（注文 ORD-ORDER-1）' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(listRequests()).toHaveLength(1);
  });

  it('答えが分からないまま画面を閉じたら、知らせは出さずに、一覧を読み直す', async () => {
    postAnswer = () => Promise.reject(new TypeError('Failed to fetch'));
    const dialog = await openRefundDialog();
    submitFullRefund(dialog);
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });
    expect(listRequests()).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('答えが分からない時に「もう一度確かめる」で受け付けられたら、同じ中身で送り直し、知らせを出して画面を閉じる', async () => {
    let answers = 0;
    postAnswer = () => (answers++ === 0 ? Promise.reject(new TypeError('Failed to fetch')) : ok(accepted({ replayed: true })));
    const dialog = await openRefundDialog();
    submitFullRefund(dialog);
    fireEvent.click(await within(dialog).findByRole('button', { name: 'もう一度確かめる' }));

    expect(await screen.findByText(PENDING_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const posts = clientFetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/refund') && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    // 同じ二重防止の番号・同じ中身（Stripe の返金は1件だけ）
    expect((posts[1][1] as RequestInit).body).toBe((posts[0][1] as RequestInit).body);
  });

  it('返事を待つ間に絞り込みを変えても、返事の後の読み直しは今の絞り込みで頼む', async () => {
    const release = holdPost('/refund');
    const dialog = await openRefundDialog();
    submitFullRefund(dialog);
    await waitFor(() => expect(postedBody('/refund')).toBeDefined());

    // 画面の後ろのボタンなので hidden: true で探す
    fireEvent.click(screen.getByRole('button', { name: '発送待ち（受注生産中・発送準備中）', hidden: true }));
    await waitFor(() => expect(String(listRequests().at(-1)?.[0])).toContain('status=paid'));
    await release(ok(accepted({ status: 'succeeded' })));

    await waitFor(() => expect(listRequests()).toHaveLength(3));
    expect(String(listRequests().at(-1)?.[0])).toContain('status=paid');
  });
});

describe('管理画面の支払い済みの注文のキャンセル', () => {
  beforeEach(() => {
    clientFetchMock.mockReset();
    mockAttention.mockReset();
    mockAttention.mockImplementation(() => ok({ data: { exceptions: [], reviews: [], counts: { exceptions: 0, reviews: 0 } } }));
    mockUserRole = 'admin';
    orderRows = [orderRow()];
    postAnswer = () => ok(accepted());
    serveApi();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('支払い済み（cancelKind が paid）の注文の「キャンセル」は、返金の材料を読む新しい画面を開く。取消の画面は開かない', async () => {
    const dialog = await openPaidCancelDialog();

    expect(clientFetchMock).toHaveBeenCalledWith('/api/admin/orders/order-1/refund', { cache: 'no-store' });
    expect(within(dialog).getByRole('button', { name: PAID_CANCEL_SUBMIT })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: '注文を取り消す（注文 ORD-ORDER-1）' })).not.toBeInTheDocument();
  });

  it('キャンセルを受け付けたら（保留）、状態の窓口へ送り、画面を閉じ、知らせを出して、一覧を読み直す', async () => {
    const dialog = await openPaidCancelDialog();
    fireEvent.change(within(dialog).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    fireEvent.click(within(dialog).getByRole('button', { name: PAID_CANCEL_SUBMIT }));

    expect(await screen.findByText(CANCEL_PENDING_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(postedBody('/status')).toEqual({
      status: 'cancelled',
      requestKey: expect.stringMatching(UUID_PATTERN),
      reason: 'customer_request',
      restock: true,
      notifyCustomer: true,
    });
    await waitFor(() => expect(listRequests()).toHaveLength(2));
  });

  it('キャンセルが成功したら、「注文をキャンセルし、返金しました。」を出す', async () => {
    postAnswer = () => {
      orderRows = [orderRow({ status: 'キャンセル', orderStatus: 'cancelled', canRefund: false, canCancel: false, cancelKind: null })];
      return ok(accepted({ status: 'succeeded' }));
    };
    const dialog = await openPaidCancelDialog();
    fireEvent.change(within(dialog).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'stock_unavailable' } });
    fireEvent.click(within(dialog).getByRole('button', { name: PAID_CANCEL_SUBMIT }));

    expect(await screen.findByText('注文をキャンセルし、返金しました。')).toBeInTheDocument();
    expect(screen.queryByText(CANCEL_PENDING_NOTICE)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('order-status')).toHaveTextContent('キャンセル'));
  });

  it('答えが分からないまま画面を閉じたら、知らせは出さずに、一覧を読み直す', async () => {
    postAnswer = () => Promise.reject(new TypeError('Failed to fetch'));
    const dialog = await openPaidCancelDialog();
    fireEvent.change(within(dialog).getByRole('combobox', { name: '取消の理由' }), { target: { value: 'customer_request' } });
    fireEvent.click(within(dialog).getByRole('button', { name: PAID_CANCEL_SUBMIT }));
    await within(dialog).findByRole('button', { name: 'もう一度確かめる' });
    expect(listRequests()).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole('button', { name: '戻る' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('未入金（cancelKind が unpaid）の注文の「キャンセル」は、今の取消の画面を開き、返金の材料は読まない', async () => {
    orderRows = [orderRow({ status: '未決済', orderStatus: 'pending', canRefund: false, cancelKind: 'unpaid' })];
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '一覧のキャンセル order-1' }));

    expect(await screen.findByRole('dialog', { name: '注文を取り消す（注文 ORD-ORDER-1）' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '注文をキャンセルする（注文 ORD-ORDER-1）' })).not.toBeInTheDocument();
    expect(clientFetchMock.mock.calls.some(([url]) => String(url).endsWith('/refund'))).toBe(false);
  });

  it('種類が無い注文の「キャンセル」も、今の取消の画面を開く', async () => {
    orderRows = [orderRow({ status: '未決済', orderStatus: 'pending', canRefund: false, cancelKind: undefined })];
    render(<AdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: '一覧のキャンセル order-1' }));

    expect(await screen.findByRole('dialog', { name: '注文を取り消す（注文 ORD-ORDER-1）' })).toBeInTheDocument();
    expect(clientFetchMock.mock.calls.some(([url]) => String(url).endsWith('/refund'))).toBe(false);
  });

  it('店長でない人（サポートの人）の一覧には、支払い済みの注文の「キャンセル」を出さない。未入金の注文の取消は出す', async () => {
    mockUserRole = 'supporter';
    orderRows = [
      orderRow(),
      orderRow({ id: 'order-2', status: '未決済', orderStatus: 'pending', canRefund: false, cancelKind: 'unpaid' }),
    ];
    render(<AdminPage />);

    expect(await screen.findByRole('button', { name: '一覧のキャンセル order-2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '一覧のキャンセル order-1' })).not.toBeInTheDocument();
  });
});
