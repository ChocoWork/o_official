/** @jest-environment node */
// 会計の計画3 Task 10 / ピアの依頼: 応答の後に流す計上係が失敗しても、もう返した応答（返金の受け付け・受け取りの結果）は変わらない。
// 計上係は本物（posting-runner）を使い、next の after() は呼び出しを集めて、応答を返した後に自分で流す。

jest.mock('server-only', () => ({}), { virtual: true });
const afterCallbacks: Array<() => unknown> = [];
const mockAfter = jest.fn((callback: () => unknown) => {
  afterCallbacks.push(callback);
});
jest.mock('next/server', () => ({
  NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) },
  after: (callback: () => unknown) => mockAfter(callback),
}));
const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: async () => undefined }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: async () => undefined }));
jest.mock('@/lib/audit', () => ({ logAudit: async () => undefined }));
const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }) }));
const mockSubmitAdminRefund = jest.fn();
const mockRefundDeps = { name: 'refund-deps' };
jest.mock('@/lib/orders/refund/refund-service', () => ({
  submitAdminRefund: (...args: unknown[]) => mockSubmitAdminRefund(...args),
  confirmAwaitingRefund: jest.fn(),
  createDefaultRefundServiceDeps: async () => mockRefundDeps,
}));
const mockReceive = jest.fn();
jest.mock('@/lib/orders/returns/return-service', () => ({
  receiveReturnAndRefund: (...args: unknown[]) => mockReceive(...args),
  refundReturnAndRequestStripe: jest.fn(),
}));

import { POST as postRefund } from '@/app/api/admin/orders/[id]/refund/route';
import { POST as postReceive } from '@/app/api/admin/returns/[returnId]/receive/route';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const RETURN_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'c1b2c3d4-1111-4222-8333-444455556666';
const REFUND_ID = 'd1b2c3d4-1111-4222-8333-444455556666';
const RECEIPT_ID = 'f1b2c3d4-1111-4222-8333-444455556666';
const HEADERS = { 'content-type': 'application/json', 'x-real-ip': '203.0.113.5', 'user-agent': 'jest' };

const refundRequest = () =>
  new Request(`http://localhost/api/admin/orders/${ORDER_ID}/refund`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      requestKey: REQUEST_KEY,
      lines: [{ orderItemId: 'e1b2c3d4-1111-4222-8333-444455556661', quantity: 1, beforeShipment: true }],
      restock: true, shippingAmount: 0, amount: 4000, note: null, stripeReason: 'requested_by_customer', notifyCustomer: true,
    }),
  });
const receiveRequest = () =>
  new Request(`http://localhost/api/admin/returns/${RETURN_ID}/receive`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      requestKey: REQUEST_KEY,
      units: [{ returnLineId: 'e1b2c3d4-1111-4222-8333-444455556662', disposition: 'restocked', quantity: 1 }],
      refundChoice: 'now', refundAmount: null, refundShippingAmount: 0, note: null, notifyCustomer: true,
      sentBackMessage: null, sentBackCarrier: null, sentBackTrackingNumber: null,
    }),
  });

const cases = [
  {
    name: '返金の受け付け',
    source: 'refund',
    call: () => postRefund(refundRequest(), { params: Promise.resolve({ id: ORDER_ID }) }),
    arrange: () => mockSubmitAdminRefund.mockResolvedValue({ kind: 'accepted', refundId: REFUND_ID, status: 'pending', amount: 4000, replayed: false }),
    expected: { refundId: REFUND_ID, status: 'pending', amount: 4000, replayed: false },
  },
  {
    name: '受け取りの結果',
    source: 'return',
    call: () => postReceive(receiveRequest(), { params: Promise.resolve({ returnId: RETURN_ID }) }),
    arrange: () => mockReceive.mockResolvedValue({ kind: 'received', receiptId: RECEIPT_ID, returnStatus: 'closed', refund: { refundId: REFUND_ID, amount: 4000, status: 'pending' }, feeDueAmount: 0, exchangeOrderItemIds: [], replayed: false }),
    expected: { data: { receiptId: RECEIPT_ID, returnStatus: 'closed', refundId: REFUND_ID, refundAmount: 4000, refundStatus: 'pending', feeDueAmount: 0, replayed: false } },
  },
];

let consoleError: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  afterCallbacks.length = 0;
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe.each(cases)('$name の後の計上係', ({ source, call, arrange, expected }) => {
  beforeEach(arrange);

  it('FREQ-579-AC-06: 応答を返した後に流す計上係が失敗しても、もう返した応答は変わらず、失敗は握ってログに種類だけ残す', async () => {
    mockRpc.mockRejectedValue(new Error('PRIVATE-MARKER connection lost'));

    const response = await call();
    const text = await response.text();

    // 応答の時点では、計上係はまだ流れていない（応答を遅らせない）
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual(expected);
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();

    // 応答の後に流れて、DB が失敗する。例外は外へ出ない
    await expect(Promise.all(afterCallbacks.map((callback) => callback()))).resolves.toBeDefined();
    expect(mockRpc).toHaveBeenCalledWith('accounting_run_posting', { _limit: 50 });
    expect(consoleError).toHaveBeenCalledWith('[accounting.posting]', source, expect.any(String));
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE-MARKER');

    // 返した応答の中身は、計上係の失敗で書き換わらない
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual(expected);
  });

  it('FREQ-579-AC-06: after() が使えない時（予約そのものの失敗）も、応答は変わらず、ログに種類だけ残る', async () => {
    mockAfter.mockImplementationOnce(() => {
      throw new Error('PRIVATE-MARKER outside request scope');
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual(expected);
    expect(afterCallbacks).toHaveLength(0);
    expect(consoleError).toHaveBeenCalledWith('[accounting.posting]', source, expect.stringContaining('schedule_'));
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('PRIVATE-MARKER');
  });
});
