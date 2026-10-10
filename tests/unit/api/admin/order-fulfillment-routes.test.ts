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
jest.mock('@/lib/supabase/server', () => ({
  createServiceRoleClient: jest.fn(async () => ({ rpc: (...args: unknown[]) => mockRpc(...args) })),
}));
const mockLoadMaterials = jest.fn();
jest.mock('@/lib/orders/fulfillment/fulfillment-materials', () => ({
  loadFulfillmentMaterials: (...args: unknown[]) => mockLoadMaterials(...args),
}));

import { GET as getMaterials, POST as postFulfillment } from '@/app/api/admin/orders/[id]/fulfillments/route';
import { POST as postCancel } from '@/app/api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel/route';
import { FulfillmentStoreError } from '@/lib/orders/fulfillment/fulfillment-store';
import type { FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
const FULFILLMENT_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
const TRACKING = '1234-5678-9012';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const CANCEL_CONTEXT = { params: Promise.resolve({ id: ORDER_ID, fulfillmentId: FULFILLMENT_ID }) };
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };

const CREATE_BODY = {
  requestKey: REQUEST_KEY,
  carrier: 'yamato',
  trackingNumber: TRACKING,
  notifyCustomer: true,
  lines: [{ orderItemId: ITEM_1, quantity: 2 }, { orderItemId: ITEM_2, quantity: 1 }],
};
const CREATED_ROW = { fulfillment_id: FULFILLMENT_ID, number: 1, completes_order: false, order_status: 'paid', replayed: false };

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと（number を含む鍵は伏せられてしまう） */
function expectNoKeyIsRedacted(event: { metadata: Record<string, unknown> | null }) {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent(event).metadata).toEqual(event.metadata);
}

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

function rpcReturns(map: Record<string, { data: unknown; error?: unknown }>) {
  mockRpc.mockImplementation(async (name: string) => ({ data: map[name]?.data ?? null, error: map[name]?.error ?? null }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockReset();
  mockAuthorize.mockResolvedValue({ ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' });
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

// 書く窓口はどれも、権限 → CSRF → 回数の制限（送信元ごと・管理者ごと）の順に確かめる（今の再送の窓口と同じ）
describe.each([
  ['発送する', 'admin:orders:fulfillment-create', 60, 'admin_create_fulfillment', [CREATED_ROW], () => postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT)],
  ['発送の取消', 'admin:orders:fulfillment-cancel', 30, 'admin_cancel_fulfillment', [{ outcome: 'cancelled', order_status: 'paid' }], () => postCancel(cancelRequest(), CANCEL_CONTEXT)],
] as const)('%s の窓口の守り', (_name, endpoint, limit, rpcName, rpcRows, call) => {
  beforeEach(() => {
    rpcReturns({ [rpcName]: { data: rpcRows } });
  });

  it('権限が無ければ CSRF も回数の制限も確かめず、認可の応答を返す（権限の確認が先）', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await call()).status).toBe(403);
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わなければ、回数も数えず、何も記録しない', async () => {
    mockRequireCsrf.mockResolvedValueOnce(new Response(null, { status: 403 }));

    expect((await call()).status).toBe(403);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('送信元ごと・管理者ごとの回数の制限を、この窓口の名前と回数で数える', async () => {
    expect((await call()).status).toBe(200);

    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, { request: expect.any(Request), endpoint, limit, windowSeconds: 600 });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, { request: expect.any(Request), endpoint, limit, windowSeconds: 600, subject: 'admin-1' });
  });

  it('送信元ごとの回数の制限を超えたら 429。管理者ごとの回数も数えず、何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/orders/[id]/fulfillments（発送の材料）', () => {
  const request = () => new Request(`http://localhost/api/admin/orders/${ORDER_ID}/fulfillments`);
  const MATERIALS: FulfillmentMaterials = {
    order: {
      id: ORDER_ID, orderNumber: 'ORD-A1B2C3D4', status: 'paid',
      progress: { key: 'in_production', label: '受注生産中', partiallyShipped: false },
    },
    blockedReason: null,
    lines: [{
      orderItemId: ITEM_1, name: 'シルクブラウス', color: '白', size: 'M', fulfillmentType: 'stock', quantity: 2,
      shipped: 0, inProduction: 0, readyUnshipped: 2, unshipped: 2,
    }],
    fulfillments: [],
  };

  it('注文の管理の権限で材料を返す。読むだけなので CSRF と回数の制限は通さない', async () => {
    mockLoadMaterials.mockResolvedValueOnce(MATERIALS);

    const response = await getMaterials(request(), ORDER_CONTEXT);

    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.manage', expect.any(Request));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual(MATERIALS);
    expect(mockLoadMaterials).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }), ORDER_ID);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('権限が無ければ認可の応答を返し、DB を読まない', async () => {
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: DENIED });

    expect((await getMaterials(request(), ORDER_CONTEXT)).status).toBe(403);
    expect(mockLoadMaterials).not.toHaveBeenCalled();
  });

  it('注文番号の形が違えば 400、注文が無ければ 404', async () => {
    const invalid = await getMaterials(request(), { params: Promise.resolve({ id: 'x' }) });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockLoadMaterials).not.toHaveBeenCalled();

    mockLoadMaterials.mockResolvedValueOnce(null);
    const missing = await getMaterials(request(), ORDER_CONTEXT);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: '注文が見つかりません。', code: 'order_not_found' });
  });

  it('読み込みの失敗は 500。ログは例外名と DB の記号だけ', async () => {
    mockLoadMaterials.mockRejectedValueOnce(new FulfillmentStoreError('load_order', { message: '宛先・氏名を含む DB の文', code: '08006' }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await getMaterials(request(), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '発送の材料を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.fulfillment.materials] Failed to load materials', 'FulfillmentStoreError', '08006']]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /api/admin/orders/[id]/fulfillments（発送する）', () => {
  it('権限・CSRF・回数の制限を通った後に発送を記録し、監査に残し、メールの worker を動かす', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [CREATED_ROW] } });

    const response = await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 1, completesOrder: false, orderStatus: 'paid', replayed: false,
    });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('admin_create_fulfillment', {
      _order_id: ORDER_ID,
      _actor_id: 'admin-1',
      _request_key: REQUEST_KEY,
      _shipping_carrier: 'yamato',
      _tracking_number: TRACKING,
      _notify_customer: true,
      _lines: [{ order_item_id: ITEM_1, quantity: 2 }, { order_item_id: ITEM_2, quantity: 1 }],
    });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.fulfillment.create',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Fulfillment recorded',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: {
        fulfillment_id: FULFILLMENT_ID, sequence: 1, carrier: 'yamato', notify_customer: true, completes_order: false, line_count: 2, replayed: false,
      },
    });
    // 伝票番号・宛先・氏名を監査に入れない。入れた鍵が maskAuditEvent に伏せられることもない
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain(TRACKING);
    expect(audited).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('「お客様に発送のメールを送る」を省くと送る。伝票番号の前後の空白は除いて DB に渡す', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [CREATED_ROW] } });

    // undefined の項目は JSON にならない（送られない）
    await postFulfillment(createRequest({ ...CREATE_BODY, notifyCustomer: undefined, trackingNumber: `  ${TRACKING}  ` }), ORDER_CONTEXT);

    expect(mockRpc).toHaveBeenCalledWith('admin_create_fulfillment', expect.objectContaining({
      _notify_customer: true, _tracking_number: TRACKING,
    }));
  });

  it('送らないを選んで全部送った発送は、発送済みになったことを返す', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [{ ...CREATED_ROW, number: 2, completes_order: true, order_status: 'shipped' }] } });

    const response = await postFulfillment(createRequest({ ...CREATE_BODY, notifyCustomer: false }), ORDER_CONTEXT);

    expect(mockRpc).toHaveBeenCalledWith('admin_create_fulfillment', expect.objectContaining({ _notify_customer: false }));
    await expect(response.json()).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 2, completesOrder: true, orderStatus: 'shipped', replayed: false,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ sequence: 2, notify_customer: false, completes_order: true }),
    }));
  });

  it('通信が切れて同じ番号で送り直されたら、前と同じ形の 200 を返す（replayed）。二重に記録しない', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [{ ...CREATED_ROW, replayed: true }] } });

    const response = await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      fulfillmentId: FULFILLMENT_ID, number: 1, completesOrder: false, orderStatus: 'paid', replayed: true,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', metadata: expect.objectContaining({ replayed: true }),
    }));
    // 前の呼び出しが worker を動かす前に止まっていても、送り直しで動かす
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('注文番号の形が違えば 400。DB を呼ばず、固定の文だけを監査に残す', async () => {
    const response = await postFulfillment(createRequest(CREATE_BODY), { params: Promise.resolve({ id: 'x' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });

  it.each([
    ['requestKey が無い', { ...CREATE_BODY, requestKey: undefined }],
    ['requestKey が UUID でない', { ...CREATE_BODY, requestKey: 'abc' }],
    ['知らない配送業者', { ...CREATE_BODY, carrier: 'dhl' }],
    ['伝票番号が空白だけ', { ...CREATE_BODY, trackingNumber: '   ' }],
    ['伝票番号に記号', { ...CREATE_BODY, trackingNumber: '12 34/56' }],
    ['伝票番号が65文字', { ...CREATE_BODY, trackingNumber: 'a'.repeat(65) }],
    ['「送るか」が真偽でない', { ...CREATE_BODY, notifyCustomer: 'no' }],
    ['商品の行が無い', { ...CREATE_BODY, lines: [] }],
    ['商品の行が101行', { ...CREATE_BODY, lines: Array.from({ length: 101 }, (_, index) => ({ orderItemId: `d1b2c3d4-1111-4222-8333-${String(index).padStart(12, '0')}`, quantity: 1 })) }],
    ['商品の番号が UUID でない', { ...CREATE_BODY, lines: [{ orderItemId: 'item-1', quantity: 1 }] }],
    ['数が0', { ...CREATE_BODY, lines: [{ orderItemId: ITEM_1, quantity: 0 }] }],
    ['数が1000', { ...CREATE_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1000 }] }],
    ['数が小数', { ...CREATE_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1.5 }] }],
    ['同じ商品が2行', { ...CREATE_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1 }, { orderItemId: ITEM_1, quantity: 2 }] }],
  ])('中身の誤り（%s）は 400。DB を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postFulfillment(createRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.fulfillment.create', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await postFulfillment(createRequest(null, rawBody), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // 発送する直前に別の人が同じ品を発送した時は QUANTITY_EXCEEDS_READY で 409 になり、2回目は記録されない
  it.each([
    ['ORDER_NOT_FOUND', 'P0002', 404, 'order_not_found', '注文が見つかりません。'],
    ['ORDER_NOT_SHIPPABLE', '22023', 409, 'not_shippable', '発送できる状態ではありません。一覧を更新してください。'],
    ['SHIPPING_ADDRESS_INCOMPLETE', '22023', 409, 'address_incomplete', '配送先の必須項目が足りないため発送できません。'],
    ['PAYMENT_REVIEW_REQUIRED', '22023', 409, 'payment_review_required', '支払額の確認（要対応）が済むまで発送できません。'],
    ['LINE_NOT_IN_ORDER', '22023', 409, 'quantity_exceeds_ready', '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。'],
    ['QUANTITY_EXCEEDS_READY', '22023', 409, 'quantity_exceeds_ready', '発送する数が発送準備中の数を超えています。受注生産の品は、先に仕上がりを記録してください。'],
    ['FULFILLMENT_REQUEST_MISMATCH', '22023', 409, 'fulfillment_request_mismatch', '前の発送と内容が違います。画面を開き直してください。'],
    ['FULFILLMENT_ARGUMENT_INVALID', '22023', 400, 'invalid_argument', '入力を確かめてください。'],
  ] as const)('DB が %s（%s）で断ったら %i %s', async (message, dbCode, status, code, error) => {
    rpcReturns({ admin_create_fulfillment: { data: null, error: { message, code: dbCode } } });

    const response = await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: status === 409 ? 'conflict' : 'failure', detail: 'Fulfillment refused', metadata: { code },
    }));
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('思いがけない DB の失敗は 500。ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ admin_create_fulfillment: { data: null, error: { message: '宛先・氏名を含む DB の文', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '発送の記録に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.fulfillment.create] Failed to create fulfillment', 'FulfillmentStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to create fulfillment', metadata: null }));
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('DB が行を返さなければ 500', async () => {
    rpcReturns({ admin_create_fulfillment: { data: [] } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect((await postFulfillment(createRequest(CREATE_BODY), ORDER_CONTEXT)).status).toBe(500);
      expect(mockSchedule).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /api/admin/orders/[id]/fulfillments/[fulfillmentId]/cancel（発送の取消）', () => {
  const LISTED = {
    fulfillment_id: FULFILLMENT_ID, number: 2, shipping_carrier: 'yamato', tracking_number: TRACKING, notify_customer: true,
    completes_order: true, shipped_at: '2026-10-10T02:00:00+00:00', created_by_email: 'admin@example.com', cancelled_at: null,
    cancelled_by_email: null, legacy: false, lines: [{ order_item_id: ITEM_1, quantity: 2 }],
  };

  it('発送を取り消し、監査に何回目かを残す。メールは送らないので worker は動かさない', async () => {
    rpcReturns({
      admin_cancel_fulfillment: { data: [{ outcome: 'cancelled', order_status: 'paid' }] },
      list_order_fulfillments: { data: [LISTED] },
    });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'cancelled', orderStatus: 'paid' });
    expect(mockRpc).toHaveBeenCalledWith('admin_cancel_fulfillment', {
      _order_id: ORDER_ID, _fulfillment_id: FULFILLMENT_ID, _actor_id: 'admin-1',
    });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.fulfillment.cancel',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Fulfillment cancelled',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { fulfillment_id: FULFILLMENT_ID, sequence: 2, outcome: 'cancelled', order_status: 'paid' },
    });
    const audited = JSON.stringify(mockLogAudit.mock.calls);
    expect(audited).not.toContain(TRACKING);
    expect(audited).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('もう取り消してあれば already_cancelled の 200（何度押しても同じ結果）', async () => {
    rpcReturns({
      admin_cancel_fulfillment: { data: [{ outcome: 'already_cancelled', order_status: 'paid' }] },
      list_order_fulfillments: { data: [LISTED] },
    });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'already_cancelled', orderStatus: 'paid' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', detail: 'Fulfillment was already cancelled',
    }));
  });

  it('何回目かを引けなくても、取消の結果は変えない（sequence は null）', async () => {
    rpcReturns({
      admin_cancel_fulfillment: { data: [{ outcome: 'cancelled', order_status: 'paid' }] },
      list_order_fulfillments: { data: null, error: { message: 'down', code: '08006' } },
    });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', metadata: expect.objectContaining({ sequence: null }),
    }));
  });

  it.each([
    ['注文番号', { id: 'x', fulfillmentId: FULFILLMENT_ID }],
    ['発送の番号', { id: ORDER_ID, fulfillmentId: 'x' }],
  ])('%s の形が違えば 400。DB を呼ばず、固定の文だけを監査に残す', async (_name, params) => {
    const response = await postCancel(cancelRequest(), { params: Promise.resolve(params) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid id', metadata: null }));
  });

  it.each([
    ['ORDER_NOT_FOUND', 'P0002', 404, 'order_not_found', '注文が見つかりません。'],
    ['FULFILLMENT_NOT_FOUND', 'P0002', 404, 'fulfillment_not_found', '発送の記録が見つかりません。'],
    ['FULFILLMENT_CANCEL_NOT_ALLOWED', '22023', 409, 'fulfillment_cancel_not_allowed', 'この発送は取り消せません。注文の状態を確かめてください。'],
    ['FULFILLMENT_ARGUMENT_INVALID', '22023', 400, 'invalid_argument', '入力を確かめてください。'],
  ] as const)('DB が %s（%s）で断ったら %i %s', async (message, dbCode, status, code, error) => {
    rpcReturns({ admin_cancel_fulfillment: { data: null, error: { message, code: dbCode } } });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: status === 409 ? 'conflict' : 'failure', detail: 'Fulfillment cancel refused', metadata: { code },
    }));
    expect(mockRpc).not.toHaveBeenCalledWith('list_order_fulfillments', expect.anything());
  });

  it('思いがけない DB の失敗は 500。ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ admin_cancel_fulfillment: { data: null, error: { message: '宛先・氏名を含む DB の文', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '発送の取消に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.fulfillment.cancel] Failed to cancel fulfillment', 'FulfillmentStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to cancel fulfillment' }));
    } finally {
      consoleError.mockRestore();
    }
  });
});
