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
const mockResolve = jest.fn();
const mockCreateStore = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args) }));
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockLimit(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
jest.mock('@/lib/orders/email/order-email-schedule', () => ({ scheduleOrderEmailDelivery: () => mockMail() }));
jest.mock('@/lib/orders/tracking/delivery-schedule', () => ({ scheduleDeliveryTracking: () => mockTracking() }));
jest.mock('@/lib/orders/tracking/delivery-store', () => ({
  ...jest.requireActual('@/lib/orders/tracking/delivery-store'),
  resolveDeliveryAttention: (...args: unknown[]) => mockResolve(...args),
}));
const ORDER = 'a1111111-1111-4111-8111-111111111111';
const mockStore = {};
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateStore(), createClient: async () => mockStore,
}));

import { POST as resolveAttention } from '@/app/api/admin/order-attention/deliveries/[attentionId]/resolve/route';
import { DeliveryOperationError, DeliveryStoreError } from '@/lib/orders/tracking/delivery-store';
import { DELIVERY_ERROR_MESSAGES } from '@/lib/orders/tracking/delivery-messages';
import { DELIVERY_ERROR_CODES } from '@/lib/orders/tracking/delivery-types';
import { deliveryErrorReply } from '@/lib/orders/tracking/delivery-route-support';

/**
 * 配送の要対応の解決（resolve）の窓口。伝票番号の訂正（tracking）と手動の配達済み（delivered）の窓口は、G-1 で 410 だけを返す形にし、
 * G-4 Task 8 で撤去した（窓口が無いことは legacy-fulfillment-routes-removed.test.ts が確かめる）。
 * 旧い一覧の窓口は G-4 Task 7 で撤去した。一覧の配送の印の優先は admin-order-summary.test.ts が確かめる。
 */
async function post(body: unknown = {}, id = ORDER) {
  const request = new Request('http://localhost/api/admin/delivery', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return resolveAttention(request, { params: Promise.resolve({ attentionId: id }) });
}
function noWork() {
  for (const mock of [mockCreateStore, mockResolve, mockMail, mockTracking]) expect(mock).not.toHaveBeenCalled();
}
beforeEach(() => {
  jest.resetAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'actor-from-auth', role: 'supporter' });
  mockCreateStore.mockResolvedValue(mockStore);
  mockResolve.mockResolvedValue({ outcome: 'resolved' });
});

test('resolveは権限→CSRF→IP→管理者の順', async () => {
  const checkOrder: string[] = [];
  mockAuthorize.mockImplementation(async (permission) => { checkOrder.push(permission); return { ok: true, userId: 'actor-from-auth' }; });
  mockCsrf.mockImplementation(async () => { checkOrder.push('csrf'); });
  mockLimit.mockImplementation(async (input) => { checkOrder.push(input.subject ? 'actor' : 'ip'); });
  expect((await post()).status).toBe(200);
  expect(checkOrder).toEqual(['admin.orders.manage', 'csrf', 'ip', 'actor']);
  expect(mockLimit.mock.calls.map(([input]) => ({ endpoint: input.endpoint, limit: input.limit, windowSeconds: input.windowSeconds, subject: input.subject })))
    .toEqual([undefined, 'actor-from-auth'].map((subject) => ({ endpoint: 'admin:orders:delivery-resolve', limit: 60, windowSeconds: 600, subject })));
});

describe('resolveの守りの拒否', () => {
  test.each([401, 403])('認証・権限の%sでDBとscheduleは0回', async (status) => {
    const response = new Response('denied', { status });
    mockAuthorize.mockResolvedValue({ ok: false, response });
    expect(await post()).toBe(response);
    expect(mockCsrf).not.toHaveBeenCalled(); expect(mockLimit).not.toHaveBeenCalled(); noWork();
    expect(mockAudit).not.toHaveBeenCalled();
  });
  test('CSRF拒否で後続は0回', async () => {
    const response = new Response('csrf denied', { status: 403 }); mockCsrf.mockResolvedValue(response);
    expect(await post()).toBe(response); expect(mockLimit).not.toHaveBeenCalled(); noWork();
    expect(mockAudit).not.toHaveBeenCalled();
  });
  test.each([0, 1])('回数制限%sで429をそのまま返す', async (index) => {
    const response = new Response('rate denied', { status: 429, headers: { 'Retry-After': '23' } });
    mockLimit.mockImplementation(async () => mockLimit.mock.calls.length === index + 1 ? response : undefined);
    expect(await post()).toBe(response); expect(mockLimit).toHaveBeenCalledTimes(index + 1); noWork();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('resolveの拒否（今のまま）', () => {
  test('uuidの誤りはDBを呼ばない', async () => { expect((await post({}, 'bad')).status).toBe(400); noWork(); });
  test.each([null, [], { actorId: 'untrusted' }])('厳しいbody %j', async (body) => {
    expect((await post(body)).status).toBe(400); noWork();
  });
  test.each(DELIVERY_ERROR_CODES)('C-4 %s', async (code) => {
    mockResolve.mockRejectedValue(new DeliveryOperationError(code));
    const response = await post();
    const expected = DELIVERY_ERROR_MESSAGES[code];
    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual({ error: expected.message, code });
    expect(mockMail).not.toHaveBeenCalled(); expect(mockTracking).not.toHaveBeenCalled();
  });
  test('想定外500はraw messageを返さず監査にも入れない', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockResolve.mockRejectedValue(new Error('RAW PRIVATE MESSAGE'));
      const response = await post();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: '配送の記録を保存できませんでした。時間をおいて、もう一度お試しください。' });
      expect(JSON.stringify([mockAudit.mock.calls, log.mock.calls])).not.toContain('RAW PRIVATE MESSAGE');
      expect(mockMail).not.toHaveBeenCalled(); expect(mockTracking).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});

test.each(['resolved', 'already_resolved'])('要対応%sもメールだけschedule', async (outcome) => {
  mockResolve.mockResolvedValue({ outcome }); expect((await post()).status).toBe(200);
  expect(mockResolve).toHaveBeenCalledWith(mockStore, { attentionId: ORDER, actorId: 'actor-from-auth' });
  expect(mockMail).toHaveBeenCalledTimes(1); expect(mockTracking).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin.orders.delivery_attention.resolve', resource: 'order_fulfillment_attention', resource_id: ORDER, actor_id: 'actor-from-auth', outcome: 'success', metadata: { attentionId: ORDER, outcome } }));
});
test('DBの記号や一般Errorのcodeを公開の断りと誤認しない', () => {
  for (const error of [new DeliveryStoreError('rpc', '08006'), { code: 'ORDER_NOT_FOUND', message: 'private' }]) {
    expect(deliveryErrorReply(error)).toEqual({ status: 500, body: { error: '配送の記録を保存できませんでした。時間をおいて、もう一度お試しください。' } });
  }
});
