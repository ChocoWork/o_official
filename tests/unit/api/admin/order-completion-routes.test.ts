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
jest.mock('@/lib/orders/email/order-email-schedule', () => ({
  scheduleOrderEmailDelivery: (...args: unknown[]) => mockSchedule(...args),
}));
const mockRpc = jest.fn();
const mockCreateServiceRoleClient = jest.fn(async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }));
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: () => mockCreateServiceRoleClient(),
}));

import { POST as postCompletion } from '@/app/api/admin/orders/[id]/completions/route';
import { POST as postCancel } from '@/app/api/admin/orders/[id]/completions/[completionId]/cancel/route';
import { MANUAL_COMPLETION_DISABLED_TEXT } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

/**
 * G-1 Task 14: 仕上がりの手動の記録と取消は終了した（品物は在庫の入荷から FIFO で自動に割り当てる）。
 * 権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の後、入力を読まずに 410 と固定の本文（MANUAL_COMPLETION_DISABLED）を返す。
 * DB の関数は呼ばず、監査は既存の操作名の failure と固定の記号だけ。
 */
const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
const COMPLETION_ID = 'c1b2c3d4-1111-4222-8333-444455556661';
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const CANCEL_CONTEXT = { params: Promise.resolve({ id: ORDER_ID, completionId: COMPLETION_ID }) };
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };
const DISABLED_BODY = { code: 'MANUAL_COMPLETION_DISABLED', error: MANUAL_COMPLETION_DISABLED_TEXT };
const RECORD_BODY = { requestKey: REQUEST_KEY, lines: [{ orderItemId: ITEM_1, quantity: 2 }] };

function recordRequest(body: unknown, rawBody?: string) {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/completions`, {
    method: 'POST',
    headers: HEADERS,
    body: rawBody ?? JSON.stringify(body),
  });
}

function cancelRequest() {
  return new Request(`http://localhost/api/admin/orders/${ORDER_ID}/completions/${COMPLETION_ID}/cancel`, {
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
  expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
  expect(mockSchedule).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

describe.each([
  ['仕上がりの記録', 'admin:orders:completion-record', 60, 'admin.orders.completion.record', () => postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT)],
  ['仕上がりの取消', 'admin:orders:completion-cancel', 30, 'admin.orders.completion.cancel', () => postCancel(cancelRequest(), CANCEL_CONTEXT)],
] as const)('%s の窓口（G-1 で終了）', (_name, endpoint, limit, action, call) => {
  it('権限が無ければ CSRF も回数の制限も確かめず、認可の応答を返す（権限の確認が 410 より先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await call()).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も記録しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await call()).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('送信元ごと・管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await call()).status).toBe(429);
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await call()).status).toBe(429);
    expect(mockLogAudit).not.toHaveBeenCalled();
    expectNoSideEffects();
  });

  it('守りを通った後は、この窓口の名前と回数で数え、410 と固定の本文・no-store を返す', async () => {
    await expectDisabled(await call());

    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: expect.any(Request), endpoint, limit, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: expect.any(Request), endpoint, limit, windowSeconds: 600, subject: 'admin-1' });
    expect(mockLogAudit.mock.calls).toEqual([[expect.objectContaining({
      action, actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID, outcome: 'failure',
      metadata: { code: 'MANUAL_COMPLETION_DISABLED' },
    })]]);
    expectNoSideEffects();
  });
});

describe('入力にかかわらず同じ 410', () => {
  it.each([
    ['注文番号の形の誤り', () => postCompletion(recordRequest(RECORD_BODY), { params: Promise.resolve({ id: 'x' }) })],
    ['中身の誤り', () => postCompletion(recordRequest({ requestKey: 'abc', lines: [] }), ORDER_CONTEXT)],
    ['JSON として読めない本文', () => postCompletion(recordRequest(null, '{'), ORDER_CONTEXT)],
    ['取消の番号の形の誤り', () => postCancel(cancelRequest(), { params: Promise.resolve({ id: ORDER_ID, completionId: 'x' }) })],
  ] as const)('%s', async (_name, call) => {
    await expectDisabled(await call());
    expectNoSideEffects();
  });
});
