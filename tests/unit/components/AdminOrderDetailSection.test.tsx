import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import AdminOrderDetailSection from '@/components/AdminOrderDetailSection';
import type { AdminOrderDetail } from '@/lib/orders/admin-orders/admin-order-types';
import type RefundDialog from '@/components/OrderRefundDialog';
import type PaidCancelDialog from '@/components/OrderPaidCancelDialog';
import type ReturnsDialog from '@/components/OrderReturnsDialog';
import type CancelRequestDialog from '@/components/OrderCancelRequestDialog';

const mockFetch = jest.fn(); const mockReplace = jest.fn(); let mockQuery = '';
let mockRefund: ComponentProps<typeof RefundDialog>; let mockPaid: ComponentProps<typeof PaidCancelDialog>;
let mockReturns: ComponentProps<typeof ReturnsDialog>; let mockRequest: ComponentProps<typeof CancelRequestDialog>;
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace }), useSearchParams: () => new URLSearchParams(mockQuery) }));
const mockCandidates = jest.fn(); const mockSwap = jest.fn();
jest.mock('@/lib/client-fetch', () => ({ clientFetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('@/lib/inventory/allocation-swap-client', () => ({ fetchSwapCandidates: (...args: unknown[]) => mockCandidates(...args), postAllocationSwap: (...args: unknown[]) => mockSwap(...args) }));
jest.mock('@/components/OrderRefundDialog', () => ({ __esModule: true, default: (props: ComponentProps<typeof RefundDialog>) => { mockRefund = props; return props.orderId ? <div role="dialog" aria-label="返金の代役"><button onClick={props.onClose}>返金を閉じる</button></div> : null; } }));
jest.mock('@/components/OrderPaidCancelDialog', () => ({ __esModule: true, default: (props: ComponentProps<typeof PaidCancelDialog>) => { mockPaid = props; return props.orderId ? <div role="dialog" aria-label="支払い済み取消の代役" /> : null; } }));
jest.mock('@/components/OrderReturnsDialog', () => ({ __esModule: true, default: (props: ComponentProps<typeof ReturnsDialog>) => { mockReturns = props; return <div role="dialog" aria-label="返品の代役" />; } }));
jest.mock('@/components/OrderCancelRequestDialog', () => ({ __esModule: true, default: (props: ComponentProps<typeof CancelRequestDialog>) => { mockRequest = props; return <div role="dialog" aria-label="申請の代役" />; } }));

const id = 'a1b2c3d4-1111-4222-8333-444455556666';
const response = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
function fixture(): AdminOrderDetail {
  return {
    order: { id, status: 'paid', createdAt: '2026-10-20T01:00:00Z', paidAt: '2026-10-20T02:00:00Z', customerKind: 'guest', customerName: 'テスト顧客', customerEmail: null, currency: 'jpy', shipTo: { fullName: 'テスト顧客', postalCode: null, prefecture: null, city: null, address: null, building: null, phone: null } },
    amounts: { productNet: 12800, discount: 100, shipping: 500, total: 13300, paidAmount: 13300, refundedAmount: 1000, refundAttachedToRows: 800, refundNotAttached: 200, refundProcessingAmount: 300 },
    rows: [{ orderItemId: 'b1b2c3d4-1111-4222-8333-444455556666', itemName: 'ブラウス', color: '白', size: 'M', isExchange: false, status: 'in_production', statusRank: 3, quantity: 1, unitPrice: 12900, lineAmount: 12800, refundAmount: 800, blockedReasons: ['stock_shortage'] }],
    permissions: { read: true, manage: true, refund: true, return: true, allocate: true, shippingRead: true },
    attention: { paymentExceptions: [], review: null, deliveries: [] }, fulfillments: [], slips: [],
    summary: { id, status: '受注生産中', customerName: 'テスト顧客', customerEmail: '', orderDate: '2026-10-20', itemCount: '1点', items: [], totalAmount: '¥13,300', paymentMethod: 'カード', paymentReference: 'pi_test', stripePaymentStatus: 'succeeded', paymentStatus: '支払い済み', shippedAt: null, shippingCarrier: null, trackingNumber: null, canRefund: true, canCancel: true, cancelKind: 'paid', cancelRequestOpen: true, returnSummary: { orderId: id, displayStatus: 'in_progress', marks: ['awaiting_items'], nextAction: 'refund', hasReturnable: true, refundWaitingReturns: 1, requestedReturns: 0 } },
  };
}
let detail: AdminOrderDetail;
let detailRead: () => Promise<Response>;
beforeEach(() => {
  detail = fixture(); mockQuery = ''; mockReplace.mockReset(); mockFetch.mockReset();
  detailRead = async () => response({ data: detail });
  mockFetch.mockImplementation((url: string) => url.endsWith('/history') ? Promise.resolve(response({ order: { id, orderNumber: 'ORD-A1B2C3D4', statusLabel: '決済完了', recipient: null }, sendPaused: null, entries: [], itemStates: [] })) : detailRead());
});
async function open() { render(<AdminOrderDetailSection orderId={id} />); await screen.findByRole('heading', { name: '注文情報' }); }
const reads = () => mockFetch.mock.calls.filter(([url]) => url === `/api/admin/orders/${id}`).length;
const accepted = { refundId: 'refund-1', status: 'pending' as const, amount: 100, replayed: false };
const remove = (mode: 'refund' | 'paid_cancel' | 'unpaid_cancel') => mockRequest.onRemoveItems({ cancelRequestId: 'request-1', mode, lines: [{ orderItemId: detail.rows[0].orderItemId, quantity: 1 }] });

it('FREQ-539-AC-01: 7つの欄を順に表示しAPIの情報と金額を出す', async () => {
  await open();
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['注文情報', '支払いと返金', '品物', '発送', '返品とキャンセルの申し込み', '要対応', '変更履歴']);
  const info = screen.getByRole('region', { name: '注文情報' }); expect(info).toHaveTextContent('テスト顧客'); expect(info).toHaveTextContent('ORD-A1B2C3D4');
  const amounts = screen.getByRole('region', { name: '支払いと返金' }); for (const value of ['¥13,300', '¥1,000', '¥300', '¥200']) expect(amounts).toHaveTextContent(value);
  expect(screen.getByRole('region', { name: '品物' })).toHaveTextContent('¥12,800');
  expect(screen.getByRole('link', { name: '注文一覧表へ戻る' })).toHaveAttribute('href', '/admin/orders');
});
it('FREQ-539-AC-02: サポーターの旗は支払い済み取消と返金を隠し返品受取と申請を残す', async () => {
  detail.permissions.refund = false; await open();
  expect(screen.queryByRole('button', { name: '返金' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: '額を決めて返金する' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '受け取る' })); expect(mockReturns.canRefund).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' })); expect(mockRequest.canRefund).toBe(false);
});
it('FREQ-539-AC-02: manage=falseで未入金取消・確認済み・申し込みを隠す', async () => {
  detail.permissions.manage = false; detail.summary.cancelKind = 'unpaid'; detail.attention.review = { reason: 'paid_stock_shortage', markedAt: null }; await open();
  for (const name of ['キャンセル', '確認済みにする', 'キャンセルの申し込み']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
});
it.each(['pending', 'succeeded'] as const)('FREQ-539-AC-03: 返金%sの通知と詳細・履歴の読み直し', async (status) => {
  await open(); fireEvent.click(screen.getByRole('button', { name: '返金' }));
  await act(async () => mockRefund.onRefunded({ ...accepted, status }));
  expect(await screen.findByText(status === 'pending' ? '返金を受け付けました。お金が戻ると、注文の状態が変わります。' : '返金しました。')).toBeInTheDocument(); expect(reads()).toBeGreaterThan(1);
  expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/history')).length).toBeGreaterThan(1);
});
it('FREQ-539-AC-03: 読み直し失敗は古い詳細を残し通知を隠す。再試行で直る', async () => {
  await open(); fireEvent.click(screen.getByRole('button', { name: '返金' })); detailRead = async () => response({}, 500);
  await act(async () => mockRefund.onRefunded(accepted));
  expect(await screen.findByText('最新の状態を読み込めませんでした。')).toBeInTheDocument(); expect(screen.getByText('この画面の内容は最新ではありません。')).toBeInTheDocument(); expect(screen.queryByText('返金を受け付けました。お金が戻ると、注文の状態が変わります。')).not.toBeInTheDocument(); expect(screen.getByRole('region', { name: '品物' })).toHaveTextContent('ブラウス');
  detailRead = async () => response({ data: detail }); fireEvent.click(screen.getByRole('button', { name: '読み込み直す' }));
  await waitFor(() => expect(screen.queryByText('この画面の内容は最新ではありません。')).not.toBeInTheDocument());
});
it('FREQ-539-AC-03: 遅れた古い読込は新しい詳細を上書きしない', async () => {
  await open(); fireEvent.click(screen.getByRole('button', { name: '額を決めて返金する' }));
  let finish: (value: Response) => void = () => {};
  detailRead = () => new Promise((resolve) => { finish = resolve; }); act(() => mockReturns.onChanged());
  const old = fixture(); detail = fixture(); detail.order.customerName = '新しい顧客'; detailRead = async () => response({ data: detail });
  await act(async () => mockReturns.onClose()); expect(await screen.findByText('新しい顧客')).toBeInTheDocument();
  await act(async () => finish(response({ data: old }))); expect(screen.getByText('新しい顧客')).toBeInTheDocument();
});
it('FREQ-539-AC-03: 未入金取消の見出しに番号だけを出し今の本文で送る', async () => {
  detail.summary.status = '未決済'; detail.summary.cancelKind = 'unpaid'; detail.permissions.refund = false; await open();
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
  const dialog = screen.getByRole('dialog', { name: '注文を取り消す（注文 ORD-A1B2C3D4）' }); expect(dialog).not.toHaveTextContent('テスト顧客');
  fireEvent.change(within(dialog).getByLabelText(/取消の理由/), { target: { value: 'customer_request' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`/api/admin/orders/${id}/status`, expect.objectContaining({ method: 'POST', body: expect.any(String) })));
  const init = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/status'))?.[1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ status: 'cancelled', reason: expect.any(String), notifyCustomer: true }));
  expect(await screen.findByText('注文を取り消しました。')).toBeInTheDocument();
});
it.each(['refund', 'paid_cancel'] as const)('FREQ-539-AC-03: 品を外す%sから受理後だけ申し込みを解決する', async (mode) => {
  await open(); fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' })); act(() => remove(mode));
  expect(screen.queryByRole('dialog', { name: '申請の代役' })).not.toBeInTheDocument();
  if (mode === 'refund') expect(mockRefund.prefillBeforeShipment).toEqual([{ orderItemId: detail.rows[0].orderItemId, quantity: 1 }]);
  await act(async () => mode === 'refund' ? mockRefund.onRefunded(accepted) : mockPaid.onCancelled(accepted));
  expect(mockFetch).toHaveBeenCalledWith('/api/admin/cancel-requests/request-1/resolve', expect.objectContaining({ method: 'POST', body: JSON.stringify({ refundId: 'refund-1', orderCancelled: false }) }));
  expect(await screen.findByText(/キャンセルの申し込みを解決しました。/)).toBeInTheDocument();
});
it('FREQ-539-AC-03: 解決だけ失敗した時の案内を残す', async () => {
  const original = mockFetch.getMockImplementation()!; mockFetch.mockImplementation((url: string, init?: RequestInit) => url.endsWith('/resolve') ? response({}, 409) : original(url, init));
  await open(); fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' })); act(() => remove('refund')); await act(async () => mockRefund.onRefunded(accepted));
  expect(await screen.findByText('返金・キャンセルは記録しましたが、申し込みを解決済みにできませんでした。キャンセルの申し込みの画面で「解決済みにする」を押してください。')).toBeInTheDocument();
});
it('FREQ-539-AC-03: 前の誤りの文は次の読み直しで消え、成功の知らせだけが残る', async () => {
  const original = mockFetch.getMockImplementation()!; mockFetch.mockImplementation((url: string, init?: RequestInit) => url.endsWith('/resolve') ? response({}, 409) : original(url, init));
  await open(); fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' })); act(() => remove('refund')); await act(async () => mockRefund.onRefunded(accepted));
  const failed = '返金・キャンセルは記録しましたが、申し込みを解決済みにできませんでした。キャンセルの申し込みの画面で「解決済みにする」を押してください。';
  expect(await screen.findByText(failed)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' }));
  await act(async () => mockRequest.onChanged('申し込みを解決済みにしました。'));
  expect(await screen.findByText('申し込みを解決済みにしました。')).toBeInTheDocument(); expect(screen.queryByText(failed)).not.toBeInTheDocument();
});
it('FREQ-539-AC-03: 品を外す未入金の取消は受理後に {refundId:null, orderCancelled:true} で申し込みを解決する', async () => {
  await open(); fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' })); act(() => remove('unpaid_cancel'));
  const dialog = await screen.findByRole('dialog', { name: '注文を取り消す（注文 ORD-A1B2C3D4）' });
  fireEvent.change(within(dialog).getByLabelText(/取消の理由/), { target: { value: 'customer_request' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));
  expect(await screen.findByText('注文を取り消しました。キャンセルの申し込みを解決しました。')).toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledWith(`/api/admin/orders/${id}/status`, expect.objectContaining({ method: 'POST' }));
  expect(mockFetch).toHaveBeenCalledWith('/api/admin/cancel-requests/request-1/resolve', expect.objectContaining({ method: 'POST', body: JSON.stringify({ refundId: null, orderCancelled: true }) }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('FREQ-539-AC-03: 未入金の取消は読み直しが遅くても送信後に画面を閉じる', async () => {
  detail.summary.status = '未決済'; detail.summary.cancelKind = 'unpaid'; detail.permissions.refund = false; await open();
  const original = mockFetch.getMockImplementation()!;
  mockFetch.mockImplementation((url: string, init?: RequestInit) => url.endsWith('/status') ? Promise.resolve(response({})) : url === `/api/admin/orders/${id}` ? new Promise<Response>(() => {}) : original(url, init));
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
  const dialog = screen.getByRole('dialog', { name: '注文を取り消す（注文 ORD-A1B2C3D4）' });
  fireEvent.change(within(dialog).getByLabelText(/取消の理由/), { target: { value: 'customer_request' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('FREQ-539-AC-03: 閉じる・結果不明では解決せず詳細を読む', async () => {
  await open(); fireEvent.click(screen.getByRole('button', { name: 'キャンセルの申し込み' })); act(() => remove('refund'));
  await act(async () => mockRefund.onUncertain?.()); await act(async () => mockRefund.onClose()); expect(reads()).toBeGreaterThan(2); expect(mockFetch.mock.calls.some(([url]) => String(url).endsWith('/resolve'))).toBe(false);
});
it('FREQ-523-AC-05: 入替の成功で知らせを出し詳細を読み直す。allocateの旗が無ければ入口を出さない', async () => {
  mockCandidates.mockResolvedValue({ kind: 'ok', data: [{ donorOrderId: 'c1b2c3d4-1111-4222-8333-444455556666', donorOrderItemId: 'd1b2c3d4-1111-4222-8333-444455556666', orderCreatedAt: '2026-10-20T01:00:00Z', swappableQuantity: 2, takerQuantity: 1 }] });
  mockSwap.mockResolvedValue({ kind: 'ok', data: {} });
  await open(); fireEvent.click(screen.getByRole('button', { name: 'ブラウス 白 M の割り当てを入れ替える' }));
  expect(mockCandidates).toHaveBeenCalledWith(id, detail.rows[0].orderItemId);
  const dialog = await screen.findByRole('dialog', { name: '割り当てを入れ替える（注文 ORD-A1B2C3D4）' });
  fireEvent.change(await within(dialog).findByRole('textbox', { name: '理由' }), { target: { value: '急ぎのため' } });
  const before = reads(); fireEvent.click(within(dialog).getByRole('button', { name: '入れ替える' }));
  expect(await screen.findByText('割当を入れ替えました。')).toBeInTheDocument();
  expect(mockSwap).toHaveBeenCalledWith(id, expect.objectContaining({ takerOrderItemId: detail.rows[0].orderItemId, quantity: 1, reason: '急ぎのため' }));
  expect(reads()).toBeGreaterThan(before); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('FREQ-523-AC-05: allocate=falseでは入替の入口を出さない', async () => { detail.permissions.allocate = false; await open(); expect(screen.queryByRole('button', { name: /割り当てを入れ替える/ })).not.toBeInTheDocument(); });
it('FREQ-539-AC-04: 要確認のPOSTと読み直し、支払い配送の一覧へのリンク', async () => {
  detail.attention.review = { reason: 'paid_stock_shortage', markedAt: null }; detail.attention.paymentExceptions = [{ id: 'exception-1', reason: 'amount_mismatch', detectionCount: 2, firstDetectedAt: '2026-10-20T01:00:00Z' }]; detail.attention.deliveries = [{ fulfillmentId: 'fulfillment-1', kind: 'delivery_failure', openedAt: '2026-10-20T01:00:00Z' }]; await open();
  expect(screen.getByRole('link', { name: '要対応の一覧で対応する' })).toHaveAttribute('href', '/admin/orders#attention');
  fireEvent.click(screen.getByRole('button', { name: '確認済みにする' }));
  expect(await screen.findByText('確認済みにしました。')).toBeInTheDocument(); expect(mockFetch).toHaveBeenCalledWith(`/api/admin/orders/${id}/review`, { method: 'POST' }); expect(reads()).toBeGreaterThan(1);
});
it('FREQ-539-AC-04: 空の要対応', async () => { await open(); expect(screen.getByRole('region', { name: '要対応' })).toHaveTextContent('要対応はありません。'); });
it('FREQ-539-AC-05: 発送票と荷作り表のリンクと同梱の注意', async () => {
  detail.fulfillments = [{ id: 'fulfillment-1', number: 1, shippedAt: '2026-10-20T01:00:00Z', deliveredAt: null, cancelledAt: null, carrier: null, trackingNumber: null, slipId: 'slip-1', slipNumber: 'SLIP-1' }]; detail.slips = [{ slipId: 'slip-1', number: 'SLIP-1', stage: 'confirmed' }]; await open();
  const shipping = screen.getByRole('region', { name: '発送' }); expect(within(shipping).getByRole('link', { name: '発送票 SLIP-1' })).toHaveAttribute('href', '/admin/shipment-slips/slip-1'); expect(shipping).toHaveTextContent('伝票番号なし'); expect(shipping).toHaveTextContent('同梱された発送票の配送の要対応は、代表の注文にだけ表示されます。詳しくは発送票を開いてください。'); expect(within(shipping).getByRole('link', { name: '荷作り表を開く' })).toHaveAttribute('href', '/admin/packing');
});
it('FREQ-539-AC-05: slips:nullとshippingRead:falseは権限の文を出す', async () => { detail.slips = null; detail.permissions.shippingRead = false; await open(); expect(screen.getByText('発送票を見る権限がありません。')).toBeInTheDocument(); expect(screen.queryByRole('link', { name: '荷作り表を開く' })).not.toBeInTheDocument(); });
it.each([['refund', '返金の代役'], ['returns', '返品の代役'], ['cancel-request', '申請の代役']])('FREQ-539-AC-02: ?open=%sを読込後に開きqueryを消す', async (query, dialog) => { mockQuery = `open=${query}`; await open(); expect(await screen.findByRole('dialog', { name: dialog })).toBeInTheDocument(); expect(mockReplace).toHaveBeenCalledWith(`/admin/orders/${id}`); });
it.each(['unknown', 'refund', 'returns', 'cancel-request'])('FREQ-539-AC-02: 不可能または未知の?open=%sは開かず置換しない', async (query) => { mockQuery = `open=${query}`; detail.permissions.refund = false; detail.permissions.manage = false; detail.summary.returnSummary = undefined; await open(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(mockReplace).not.toHaveBeenCalled(); });
it.each([[403, '注文を見る権限がありません。'], [404, '注文が見つかりません。'], [500, '注文を読み込めませんでした。']])('FREQ-539-AC-01: 初期HTTP%sの状態', async (status, text) => { detailRead = async () => response({}, Number(status)); render(<AdminOrderDetailSection orderId={id} />); expect(screen.getByText('注文を読み込み中です...')).toBeInTheDocument(); expect(await screen.findByText(text)).toBeInTheDocument(); });
