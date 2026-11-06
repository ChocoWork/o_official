import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OrderReturnsDialog from '@/components/OrderReturnsDialog';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';
import { LABEL, ORDER_ID, RETURN_ID, RETURNS_URL, returnDetail, returnLine } from '../../unit/components/return-review-test-fixtures';

// clientFetch は本物を通し、網の境目の fetch だけを差し替える（CSRF の見出しと送り方まで確かめる）
const CSRF_TOKEN = 'csrf-test-token';
const RECEIVE_URL = `/api/admin/returns/${RETURN_ID}/receive`;
const mockFetch = jest.fn();
const realFetch = global.fetch;

beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
});

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as unknown as Response;
}

/** 承認した後の、お客様の申し込みの返品（P9 の条件に当たる）。2点とも未処理の返金の品（1点 12,000 円） */
const openReturn = (overrides: Partial<OrderReturnDetail> = {}) =>
  returnDetail({ status: 'open', displayStatus: 'in_progress', marks: ['awaiting_items'], approvedAt: '2026-10-13T06:00:00.000Z', ...overrides });

/** 受け取った後に窓口が返す返品。1点は返金済み、1点は返金待ち */
const receivedReturn = () =>
  openReturn({
    displayStatus: 'refund_waiting',
    marks: [],
    firstReceiptDone: true,
    lines: [returnLine({
      progress: {
        restocked: 2, notRestocked: 0, pendingInspection: 0, sentBack: 0, missing: 0,
        processed: 2, unprocessed: 0, exchanged: 0, refundCovered: 1, refundWaived: 0, refundWaiting: 1,
      },
      refundAmountsByCount: [],
      refundWaitingAmount: 12000,
    })],
    refunds: [{ id: 'refund-1', amount: 12000, status: 'pending', createdAt: '2026-11-06T01:00:00.000Z' }],
    receipts: [{ id: 'receipt-1', kind: 'receive', refundChoice: 'mixed', createdAt: '2026-11-06T01:00:00.000Z', actorEmail: 'support@example.com' }],
  });

function returnsBody(detail: OrderReturnDetail) {
  return {
    data: { returns: [detail], canRefund: false, returnableUnits: 0, refundableAmount: 54800, refundableShipping: 800, inspectionEnabled: false },
  };
}

const receivePosts = () => mockFetch.mock.calls.filter(([url, init]) => url === RECEIVE_URL && (init as RequestInit).method === 'POST');
const returnsReads = () => mockFetch.mock.calls.filter(([url]) => url === RETURNS_URL);

beforeEach(() => {
  mockFetch.mockReset();
  document.cookie = `sb-csrf-token=${CSRF_TOKEN}; path=/`;
});

it('FREQ-641-AC-11: P9の品ごとの選びとAPI本文と再読込をつなぐ', async () => {
  // 返品の一覧と受け取りの画面は同じ窓口を読む。受け取りの前は2回（一覧・受け取りの画面）、受け取った後の読み直しは受け取り済みの返品
  let received = false;
  mockFetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url === RETURNS_URL) return response(200, returnsBody(received ? receivedReturn() : openReturn()));
    if (url === RECEIVE_URL && init.method === 'POST') {
      received = true;
      return response(200, {
        data: { receiptId: 'receipt-1', returnStatus: 'open', refundId: 'refund-1', refundAmount: 12000, refundStatus: 'pending', feeDueAmount: 0, replayed: false },
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  const onChanged = jest.fn();
  render(<OrderReturnsDialog orderId={ORDER_ID} canRefund={false} open onClose={jest.fn()} onChanged={onChanged} />);

  fireEvent.click(await screen.findByRole('button', { name: '受け取る' }));
  const dialog = await screen.findByRole('dialog', { name: `受け取る（${LABEL}）` });
  const rows = within(within(dialog).getByRole('list', { name: '受け取る品' })).getAllByRole('listitem');
  for (const row of rows) {
    fireEvent.click(within(row).getByRole('checkbox', { name: '届いた' }));
    fireEvent.change(within(row).getByRole('combobox', { name: '品の状態' }), { target: { value: 'restocked' } });
  }

  // 金額と送料の入力は無く、品ごとに選べる
  expect(within(dialog).queryAllByRole('spinbutton')).toHaveLength(0);
  expect(within(dialog).getAllByRole('radio', { name: /^(今すぐ返金|額を相談)$/ })).toHaveLength(4);
  fireEvent.click(within(rows[1]).getByRole('radio', { name: '額を相談' }));
  fireEvent.click(within(dialog).getByRole('button', { name: `受け取る（1点を ${formatYen(12000)} 返金・1点は相談）` }));

  // 単一の結果を受けて受け取りの画面を閉じ、返品の一覧を読み直す
  expect(await screen.findByRole('status')).toHaveTextContent('受け取りを記録し、返金を受け付けました。');
  await waitFor(() => expect(returnsReads()).toHaveLength(3));
  expect(screen.queryByRole('dialog', { name: `受け取る（${LABEL}）` })).not.toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledTimes(1);
  // 読み直した返品は2点とも処理済みなので、受け取りのボタンは無い
  await waitFor(() => expect(screen.queryByRole('button', { name: '受け取る' })).not.toBeInTheDocument());
  expect(receivePosts()).toHaveLength(1);
  const [, init] = receivePosts()[0] as [string, RequestInit];
  expect((init.headers as Headers).get('x-csrf-token')).toBe(CSRF_TOKEN);
  const post = JSON.parse(init.body as string) as { refundChoice: string; units: Array<{ refundChoice?: string }> } & Record<string, unknown>;
  expect(post.units.map((x) => x.refundChoice)).toEqual(['now', 'consult']);
  expect(post).toMatchObject({ refundAmount: null, refundShippingAmount: 0 });
  expect(post.refundChoice).toBe('mixed');
});
