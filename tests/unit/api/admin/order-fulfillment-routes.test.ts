/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));
const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args) }));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
const mockSchedule = jest.fn();
const mockScheduleTracking = jest.fn();
jest.mock('@/lib/orders/tracking/delivery-schedule', () => ({
  scheduleDeliveryTracking: (...args: unknown[]) => mockScheduleTracking(...args),
}));
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockSchedule(...args),
}));
const mockRpc = jest.fn();
const mockFrom = jest.fn();
const mockCreateServiceRoleClient = jest.fn(async () => ({
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (...args: unknown[]) => mockFrom(...args),
}));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));

import { GET as getMaterials, POST as postFulfillment } from '@/app/api/admin/orders/[id]/fulfillments/route';
import { POST as postCancel } from '@/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route';
import { LEGACY_FULFILLMENT_DISABLED_TEXT } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

/**
 * G-1 Task 14: 旧の発送（POST）・発送の材料（GET）・発送の取消（POST）は止めた。
 * POST は権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の後、GET は権限の後に、入力を読まずに 410 と固定の本文を返す。
 * DB（rpc・from）も service_role の client も使わず、メール・配送の worker も動かさない。監査は既存の操作名の failure と固定の記号だけ。
 */
const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const TRACKING = '1234-5678-9012';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const CANCEL_CONTEXT = { params: Promise.resolve({ id: ORDER_ID, fulfillmentId: FULFILLMENT_ID }) };
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };
const DISABLED_BODY = { code: 'LEGACY_FULFILLMENT_DISABLED', error: LEGACY_FULFILLMENT_DISABLED_TEXT };

const CREATE_BODY = {
  requestKey: REQUEST_KEY,
  carrier: 'yamato',
  trackingNumber: TRACKING,
  notifyCustomer: true,
  lines: [{ orderItemId: ITEM_1, quantity: 2 }],
};

function createRequest(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/fulfillments`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

function cancelRequest() {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/fulfillments/${FULFILLMENT_ID}/cancel`, {
    method: 'POST',
    headers: HEADERS,
  });
}

async function expectDisabled(response: Response) {
  expect(response.status).toBe(410);
  expect(response.headers.get('cache-control')).toBe('no-store');
  await expect(response.json()).resolves.toEqual(DISABLED_BODY);
}

function expectNoSideEffects() {
  expect(mockRpc).not.toHaveBeenCalled();
  expect(mockFrom).not.toHaveBeenCalled();
  expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  expect(mockSchedule).not.toHaveBeenCalled();
  expect(mockScheduleTracking).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

// 書く窓口はどれも、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめてから、固定の 410 を返す
describe.each([
  ['発送する', 'admin:orders:fulfillment-create', 60, 'admin.orders.fulfillment.create', () => postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT)],
  ['発送の取消', 'admin:orders:fulfillment-cancel', 30, 'admin.orders.fulfillment.cancel', () => postCancel(cancelRequest(), CANCEL_CONTEXT)],
] as const)('%s の窓口（G-1 で停止）', (_name, endpoint, limit, action, call) => {
  it('権限が無ければ CSRF も回数の制限も確かめず、認可の応答を返す（権限の確認が 410 より先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await call()).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も記録しない（CSRF が 410 より先）', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await call()).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('守りを通った後は、この窓口の名前と回数で数え、410 と固定の本文・no-store を返す。DB も worker も使わない', async () => {
    await expectDisabled(await call());

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: expect.any(Request), endpoint, limit, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: expect.any(Request), endpoint, limit, windowSeconds: 600, subject: 'admin-1' });
    expect(mockAuthorize.mock.invocationCallOrder[0]).toBeLessThan(mockRequireCsrf.mock.invocationCallOrder[0]);
    expect(mockRequireCsrf.mock.invocationCallOrder[0]).toBeLessThan(mockEnforceRateLimit.mock.invocationCallOrder[0]);
    expect(mockLogAudit.mock.calls).toEqual([[expect.objectContaining({
      action, actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID, outcome: 'failure',
      metadata: { code: 'LEGACY_FULFILLMENT_DISABLED' },
    })]]);
    // 伝票番号・宛先を監査に入れない
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(TRACKING);
    expectNoSideEffects();
  });
});

describe('POST /api/admin/orders/[id]/fulfillments（発送する、G-1 で停止）', () => {
  it.each([
    ['正しい入力', createRequest(CREATE_BODY), ORDER_CONTEXT],
    ['送り直しと同じ入力', createRequest(CREATE_BODY), ORDER_CONTEXT],
    ['注文番号の形の誤り', createRequest(CREATE_BODY), { params: Promise.resolve({ id: 'x' }) }],
    ['中身の誤り', createRequest({ ...CREATE_BODY, requestKey: 'abc', lines: [] }), ORDER_CONTEXT],
    ['JSON として読めない本文', createRequest(null, '{'), ORDER_CONTEXT],
    ['未知の項目', createRequest({ ...CREATE_BODY, actorId: 'untrusted', extra: true }), ORDER_CONTEXT],
  ] as const)('%sでも、旧の業務へ落とさず同じ 410 を返す', async (_name, request, context) => {
    await expectDisabled(await postFulfillment(request, context));
    expectNoSideEffects();
  });
});

describe('POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel（発送の取消、G-1 で停止）', () => {
  it.each([
    ['正しい番号', CANCEL_CONTEXT],
    ['注文番号の形の誤り', { params: Promise.resolve({ id: 'x', fulfillmentId: FULFILLMENT_ID }) }],
    ['発送の番号の形の誤り', { params: Promise.resolve({ id: ORDER_ID, fulfillmentId: 'x' }) }],
  ] as const)('%sでも同じ 410 を返し、DB を読まない（何回目かも引かない）', async (_name, context) => {
    await expectDisabled(await postCancel(cancelRequest(), context));
    expectNoSideEffects();
  });
});

describe('止めた窓口の監査の resource_id（G-1）', () => {
  it.each([
    ['発送する', 'admin.orders.fulfillment.create', () => postFulfillment(createRequest(CREATE_BODY), { params: Promise.resolve({ id: 'x' }) })],
    ['発送の取消', 'admin.orders.fulfillment.cancel',
      () => postCancel(cancelRequest(), { params: Promise.resolve({ id: 'x', fulfillmentId: FULFILLMENT_ID }) })],
  ] as const)('%s: URL の注文番号が UUID でなければ resource_id は null。410 は変わらない', async (_name, action, call) => {
    await expectDisabled(await call());

    expect(mockLogAudit.mock.calls).toEqual([[expect.objectContaining({
      action, actor_id: 'admin-1', resource: 'orders', resource_id: null, outcome: 'failure',
      metadata: { code: 'LEGACY_FULFILLMENT_DISABLED' },
    })]]);
    expectNoSideEffects();
  });
});

describe('GET /api/admin/orders/[id]/fulfillments（発送の材料、G-1 で停止）', () => {
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/fulfillments`);

  it('注文の管理の権限の後に 410 と固定の本文を返す。読むだけなので CSRF と回数の制限は通さず、材料も読まない', async () => {
    await expectDisabled(await getMaterials(request()));

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('権限が無ければ認可の応答を返し、DB を読まない', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await getMaterials(request())).status).toBe(403);
    expectNoSideEffects();
  });
});
