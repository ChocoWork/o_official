/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });

if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
}

const mockAuthorize = jest.fn();
const mockCsrf = jest.fn();
const mockLimit = jest.fn();
const mockAudit = jest.fn();
const mockMail = jest.fn();
const mockTracking = jest.fn();
const mockUpdate = jest.fn();
const mockDelivered = jest.fn();
const mockResolve = jest.fn();
const mockSummaries = jest.fn();
const mockCreateStore = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockLimit(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
jest.mock('@/lib/orders/email/order-email-schedule', () => ({ scheduleOrderEmailDelivery: () => mockMail() }));
jest.mock('@/lib/orders/tracking/delivery-schedule', () => ({ scheduleDeliveryTracking: () => mockTracking() }));
jest.mock('@/lib/orders/tracking/delivery-store', () => ({
  ...jest.requireActual('@/lib/orders/tracking/delivery-store'),
  updateFulfillmentTracking: (...args: unknown[]) => mockUpdate(...args),
  markFulfillmentDelivered: (...args: unknown[]) => mockDelivered(...args),
  resolveDeliveryAttention: (...args: unknown[]) => mockResolve(...args),
  listOrderDeliverySummaries: (...args: unknown[]) => mockSummaries(...args),
}));
// 一覧は配送の集計以外の依存を固定し、状態の絞り込み・ページ件数を観測する。
const mockQueryCalls: unknown[][] = [];
const ORDER = 'a1111111-1111-4111-8111-111111111111';
const FULFILLMENT = 'b1111111-1111-4111-8111-111111111111';
const KEY = 'c1111111-1111-4111-8111-111111111111';
const mockListRows = [{ id: ORDER, status: 'shipped', total_amount: 100, refunded_amount: 0, currency: 'jpy',
  created_at: '2026-10-21T00:00:00Z', order_items: [], payment_intent_id: null }];
const mockQuery: Record<string, unknown> = {};
for (const name of ['select', 'order', 'eq', 'is', 'in', 'not', 'gte', 'lte', 'or', 'range']) {
  mockQuery[name] = (...args: unknown[]) => { mockQueryCalls.push([name, ...args]); return mockQuery; };
}
mockQuery.then = (resolve: (value: unknown) => unknown) => resolve({ data: mockListRows, count: 41, error: null });
const mockStore = { from: () => mockQuery };
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateStore(), createClient: async () => mockStore,
}));
jest.mock('@/lib/stripe/server', () => ({ getStripeServerClient: jest.fn() }));
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({ listOrderLineFulfillment: async () => new Map() }));
jest.mock('@/lib/orders/refund/refund-store', () => ({ listOrderRefundSummaries: async () => new Map() }));
jest.mock('@/lib/orders/returns/return-store', () => ({
  countReturnAttention: async () => ({ requested: 2, refundWaiting: 3 }), listOrderReturnSummaries: async () => new Map(),
}));
jest.mock('@/lib/orders/returns/cancel-request-reads', () => ({
  countOrdersWithOpenCancelRequest: async () => 0, listOrderIdsWithOpenCancelRequest: async () => [],
  findOrderIdsWithOpenCancelRequest: async () => new Set(),
}));

import { POST as tracking } from '@/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/tracking/route';
import { POST as delivered } from '@/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/delivered/route';
import { POST as resolveAttention } from '@/app/api/admin/order-attention/deliveries/[attentionId]/resolve/route';
import { GET as orders } from '@/app/api/admin/orders/route';
import { DeliveryOperationError, DeliveryStoreError } from '@/lib/orders/tracking/delivery-store';
import { DELIVERY_ERROR_MESSAGES } from '@/lib/orders/tracking/delivery-messages';
import { DELIVERY_ERROR_CODES } from '@/lib/orders/tracking/delivery-types';
import { deliveryErrorReply } from '@/lib/orders/tracking/delivery-route-support';
import { LEGACY_FULFILLMENT_DISABLED_TEXT } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

/**
 * G-1 Task 14: 伝票番号の訂正（tracking）と手動の配達済み（delivered）は止めた。権限 → CSRF → 回数の制限の後、
 * 入力を読まずに 410 と固定の本文（LEGACY_FULFILLMENT_DISABLED）を返す。配送の要対応の解決（resolve）と一覧の読取は今のまま。
 */
const DISABLED_BODY = { code: 'LEGACY_FULFILLMENT_DISABLED', error: LEGACY_FULFILLMENT_DISABLED_TEXT };
const bodies = {
  tracking: { requestKey: KEY, carrier: 'yamato', trackingNumber: ' ABC-123 ', notifyCustomer: true },
  delivered: { requestKey: KEY, deliveredOn: '2026-10-21', notifyCustomer: false },
  resolve: {},
};
type Endpoint = keyof typeof bodies;
async function post(endpoint: Endpoint, body: unknown = bodies[endpoint], id = ORDER, fulfillmentId = FULFILLMENT) {
  const request = new Request('http://localhost/api/admin/delivery', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (endpoint === 'resolve') return resolveAttention(request, { params: Promise.resolve({ attentionId: id }) });
  return ({ tracking, delivered })[endpoint](request, { params: Promise.resolve({ id, fulfillmentId }) });
}
const endpoints: Endpoint[] = ['tracking', 'delivered', 'resolve'];
const stopped = ['tracking', 'delivered'] as const;
function noWork() {
  for (const mock of [mockCreateStore, mockUpdate, mockDelivered, mockResolve, mockMail, mockTracking]) expect(mock).not.toHaveBeenCalled();
}
async function expectDisabled(response: Response) {
  expect(response.status).toBe(410);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(DISABLED_BODY);
}
beforeEach(() => {
  jest.resetAllMocks();
  mockQueryCalls.length = 0;
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'actor-from-auth', role: 'supporter' });
  mockCreateStore.mockResolvedValue(mockStore);
  mockUpdate.mockResolvedValue({ trackingChangeId: KEY, trackingVersion: 2, replayed: false });
  mockDelivered.mockResolvedValue({ eventId: KEY, deliveredAt: '2026-10-21T03:00:00Z', replayed: false });
  mockResolve.mockResolvedValue({ outcome: 'resolved' });
  mockSummaries.mockResolvedValue(new Map());
});

test.each(endpoints)('%sは権限→CSRF→IP→管理者の順（止めた窓口はその後に 410）', async (endpoint) => {
  const checkOrder: string[] = [];
  mockAuthorize.mockImplementation(async (permission) => { checkOrder.push(permission); return { ok: true, userId: 'actor-from-auth' }; });
  mockCsrf.mockImplementation(async () => { checkOrder.push('csrf'); });
  mockLimit.mockImplementation(async (input) => { checkOrder.push(input.subject ? 'actor' : 'ip'); });
  expect((await post(endpoint)).status).toBe(endpoint === 'resolve' ? 200 : 410);
  expect(checkOrder).toEqual(['admin.orders.manage', 'csrf', 'ip', 'actor']);
  const names = { tracking: ['fulfillment-tracking', 60], delivered: ['fulfillment-delivered', 30], resolve: ['delivery-resolve', 60] };
  const [name, limit] = names[endpoint];
  expect(mockLimit.mock.calls.map(([input]) => ({ endpoint: input.endpoint, limit: input.limit, windowSeconds: input.windowSeconds, subject: input.subject })))
    .toEqual([undefined, 'actor-from-auth'].map((subject) => ({ endpoint: `admin:orders:${name}`, limit, windowSeconds: 600, subject })));
});

describe.each(endpoints)('%sの守りの拒否', (endpoint) => {
  test.each([401, 403])('認証・権限の%sでDBとscheduleは0回', async (status) => {
    const response = new Response('denied', { status });
    mockAuthorize.mockResolvedValue({ ok: false, response });
    expect(await post(endpoint)).toBe(response);
    expect(mockCsrf).not.toHaveBeenCalled(); expect(mockLimit).not.toHaveBeenCalled(); noWork();
    expect(mockAudit).not.toHaveBeenCalled();
  });
  test('CSRF拒否で後続は0回', async () => {
    const response = new Response('csrf denied', { status: 403 }); mockCsrf.mockResolvedValue(response);
    expect(await post(endpoint)).toBe(response); expect(mockLimit).not.toHaveBeenCalled(); noWork();
    expect(mockAudit).not.toHaveBeenCalled();
  });
  test.each([0, 1])('回数制限%sで429をそのまま返す', async (index) => {
    const response = new Response('rate denied', { status: 429, headers: { 'Retry-After': '23' } });
    mockLimit.mockImplementation(async () => mockLimit.mock.calls.length === index + 1 ? response : undefined);
    expect(await post(endpoint)).toBe(response); expect(mockLimit).toHaveBeenCalledTimes(index + 1); noWork();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe.each(stopped)('%s（G-1 で停止）', (endpoint) => {
  const action = endpoint === 'tracking' ? 'admin.orders.fulfillment.tracking_update' : 'admin.orders.fulfillment.delivered';
  test('守りの後は 410 と固定の本文・no-store。DB・store・schedule は0回、監査は failure と固定の記号だけ', async () => {
    await expectDisabled(await post(endpoint));
    noWork();
    expect(mockAudit.mock.calls).toEqual([[expect.objectContaining({
      action, actor_id: 'actor-from-auth', resource: 'orders', resource_id: ORDER, outcome: 'failure',
      metadata: { code: 'LEGACY_FULFILLMENT_DISABLED' },
    })]]);
    // 伝票番号・日付・入力を監査に入れない
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('ABC-123');
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('2026-10-21');
  });
  test('注文番号が UUID でなければ監査の resource_id は null。410 は変わらない', async () => {
    await expectDisabled(await post(endpoint, bodies[endpoint], 'bad'));
    noWork();
    expect(mockAudit.mock.calls).toEqual([[expect.objectContaining({
      action, actor_id: 'actor-from-auth', resource: 'orders', resource_id: null, outcome: 'failure',
      metadata: { code: 'LEGACY_FULFILLMENT_DISABLED' },
    })]]);
  });
  test.each([
    ['uuidの誤り', 'bad', FULFILLMENT, bodies[endpoint]],
    ['発送uuidの誤り', ORDER, 'bad', bodies[endpoint]],
    ['body null', ORDER, FULFILLMENT, null],
    ['body []', ORDER, FULFILLMENT, []],
    ['未知の項目', ORDER, FULFILLMENT, { ...bodies[endpoint], actorId: 'untrusted' }],
    ['不正な伝票番号・日付', ORDER, FULFILLMENT, { ...bodies[endpoint], trackingNumber: 'あいう', deliveredOn: '2026-02-30' }],
  ] as const)('%sでも検証へ進まず同じ 410', async (_name, id, fulfillmentId, body) => {
    await expectDisabled(await post(endpoint, body, id, fulfillmentId));
    noWork();
  });
});

describe('resolveの拒否（今のまま）', () => {
  test('uuidの誤りはDBを呼ばない', async () => { expect((await post('resolve', bodies.resolve, 'bad')).status).toBe(400); noWork(); });
  test.each([null, [], { actorId: 'untrusted' }])('厳しいbody %j', async (body) => {
    expect((await post('resolve', body)).status).toBe(400); noWork();
  });
  test.each(DELIVERY_ERROR_CODES)('C-4 %s', async (code) => {
    mockResolve.mockRejectedValue(new DeliveryOperationError(code));
    const response = await post('resolve');
    const expected = DELIVERY_ERROR_MESSAGES[code];
    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual({ error: expected.message, code });
    expect(mockMail).not.toHaveBeenCalled(); expect(mockTracking).not.toHaveBeenCalled();
  });
  test('想定外500はraw messageを返さず監査にも入れない', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockResolve.mockRejectedValue(new Error('RAW PRIVATE MESSAGE'));
      const response = await post('resolve');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: '配送の記録を保存できませんでした。時間をおいて、もう一度お試しください。' });
      expect(JSON.stringify([mockAudit.mock.calls, log.mock.calls])).not.toContain('RAW PRIVATE MESSAGE');
      expect(mockMail).not.toHaveBeenCalled(); expect(mockTracking).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});

test.each(['resolved', 'already_resolved'])('要対応%sもメールだけschedule', async (outcome) => {
  mockResolve.mockResolvedValue({ outcome }); expect((await post('resolve')).status).toBe(200);
  expect(mockResolve).toHaveBeenCalledWith(mockStore, { attentionId: ORDER, actorId: 'actor-from-auth' });
  expect(mockMail).toHaveBeenCalledTimes(1); expect(mockTracking).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.orders.delivery_attention.resolve', metadata: { attentionId: ORDER, outcome } }));
});
test('DBの記号や一般Errorのcodeを公開の断りと誤認しない', () => {
  for (const error of [new DeliveryStoreError('rpc', '08006'), { code: 'ORDER_NOT_FOUND', message: 'private' }]) {
    expect(deliveryErrorReply(error)).toEqual({ status: 500, body: { error: '配送の記録を保存できませんでした。時間をおいて、もう一度お試しください。' } });
  }
});
test.each(['delivery_failure', 'attempted_delivery', 'tracking_not_found', 'tracking_registration_failed', 'tracking_stalled', null] as const)(
  '複数の要対応は問題ありを先に印にする（集計の優先結果%s）', async (attentionKind) => {
    mockSummaries.mockResolvedValue(new Map([[ORDER, { activeCount: 2, deliveredCount: 0, attentionKind }]]));
    const response = await orders(new Request('http://localhost/api/admin/orders?status=shipped&page=2&pageSize=20'));
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.data[0].deliveryAttention).toBe(attentionKind === 'delivery_failure' ? 'failure' : attentionKind === 'attempted_delivery' ? 'attempted_delivery' : attentionKind ? 'untrackable' : null);
    expect(body.pagination).toEqual({ page: 2, pageSize: 20, total: 41, totalPages: 3 });
    expect(mockQueryCalls).toContainEqual(['eq', 'status', 'shipped']);
    expect(mockSummaries).toHaveBeenCalledWith(mockStore, [ORDER]);
    expect(mockCsrf).not.toHaveBeenCalled(); expect(mockLimit).not.toHaveBeenCalled();
  },
);
