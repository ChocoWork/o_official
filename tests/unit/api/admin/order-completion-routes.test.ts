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

import { POST as postCompletion } from '@/app/api/admin/orders/[id]/completions/route';
import { POST as postCancel } from '@/app/api/admin/orders/[id]/completions/[completionId]/cancel/route';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
const REQUEST_KEY = 'b1b2c3d4-1111-4222-8333-444455556666';
const COMPLETION_ID = 'c1b2c3d4-1111-4222-8333-444455556661';
const COMPLETION_ID_2 = 'c1b2c3d4-1111-4222-8333-444455556662';
const ITEM_1 = 'd1b2c3d4-1111-4222-8333-444455556661';
const ITEM_2 = 'd1b2c3d4-1111-4222-8333-444455556662';
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
const ORDER_CONTEXT = { params: Promise.resolve({ id: ORDER_ID }) };
const CANCEL_CONTEXT = { params: Promise.resolve({ id: ORDER_ID, completionId: COMPLETION_ID }) };
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5', 'user-agent': 'jest' };

const RECORD_BODY = {
  requestKey: REQUEST_KEY,
  lines: [{ orderItemId: ITEM_1, quantity: 2 }, { orderItemId: ITEM_2, quantity: 1 }],
};
const RECORDED_ROWS = [
  { completion_id: COMPLETION_ID, order_item_id: ITEM_1, quantity: 2, replayed: false },
  { completion_id: COMPLETION_ID_2, order_item_id: ITEM_2, quantity: 1, replayed: false },
];

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと（number を含む鍵は伏せられてしまう） */
function expectNoKeyIsRedacted(event: { metadata: Record<string, unknown> | null }) {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent(event).metadata).toEqual(event.metadata);
}

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
  ['仕上がりの記録', 'admin:orders:completion-record', 60, 'admin_record_completion', RECORDED_ROWS, () => postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT)],
  ['仕上がりの取消', 'admin:orders:completion-cancel', 30, 'admin_cancel_completion', [{ outcome: 'cancelled' }], () => postCancel(cancelRequest(), CANCEL_CONTEXT)],
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
  });

  it('管理者ごとの回数の制限を超えたら 429。何も記録しない', async () => {
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(new Response(null, { status: 429 }));

    expect((await call()).status).toBe(429);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/orders/[id]/completions（仕上がりの記録）', () => {
  it('仕上がりを記録し、監査に行の数と数の合計を残す。お客様にメールは送らないので worker は動かさない', async () => {
    rpcReturns({ admin_record_completion: { data: RECORDED_ROWS } });

    const response = await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ completionIds: [COMPLETION_ID, COMPLETION_ID_2], replayed: false });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('admin_record_completion', {
      _order_id: ORDER_ID,
      _actor_id: 'admin-1',
      _request_key: REQUEST_KEY,
      _lines: [{ order_item_id: ITEM_1, quantity: 2 }, { order_item_id: ITEM_2, quantity: 1 }],
    });
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.completion.record',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Completion recorded',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { line_count: 2, total_quantity: 3, replayed: false },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('@example.com');
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('同じ番号で送り直されたら、前と同じ形の 200 を返す（replayed）', async () => {
    rpcReturns({ admin_record_completion: { data: RECORDED_ROWS.map((row) => ({ ...row, replayed: true })) } });

    const response = await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ completionIds: [COMPLETION_ID, COMPLETION_ID_2], replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ replayed: true }) }));
  });

  it('注文番号の形が違えば 400。DB を呼ばず、固定の文だけを監査に残す', async () => {
    const response = await postCompletion(recordRequest(RECORD_BODY), { params: Promise.resolve({ id: 'x' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid order id', metadata: null }));
  });

  it.each([
    ['requestKey が無い', { ...RECORD_BODY, requestKey: undefined }],
    ['requestKey が UUID でない', { ...RECORD_BODY, requestKey: 'abc' }],
    ['商品の行が無い', { ...RECORD_BODY, lines: [] }],
    ['商品の行が101行', { ...RECORD_BODY, lines: Array.from({ length: 101 }, (_, index) => ({ orderItemId: `d1b2c3d4-1111-4222-8333-${String(index).padStart(12, '0')}`, quantity: 1 })) }],
    ['商品の番号が UUID でない', { ...RECORD_BODY, lines: [{ orderItemId: 'item-1', quantity: 1 }] }],
    ['数が0', { ...RECORD_BODY, lines: [{ orderItemId: ITEM_1, quantity: 0 }] }],
    ['数が1000', { ...RECORD_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1000 }] }],
    ['数が小数', { ...RECORD_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1.5 }] }],
    ['同じ商品が2行', { ...RECORD_BODY, lines: [{ orderItemId: ITEM_1, quantity: 1 }, { orderItemId: ITEM_1, quantity: 1 }] }],
  ])('中身の誤り（%s）は 400。DB を呼ばず、固定の文だけを監査に残す', async (_name, body) => {
    const response = await postCompletion(recordRequest(body), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit.mock.calls).toEqual([[{
      action: 'admin.orders.completion.record', actor_id: 'admin-1', resource: 'orders', resource_id: ORDER_ID,
      outcome: 'failure', detail: 'Invalid request body', ip: '203.0.113.5', user_agent: 'jest', metadata: null,
    }]]);
  });

  it.each(['null', '{'])('本文が JSON として読めない（%s）なら 400', async (rawBody) => {
    const response = await postCompletion(recordRequest(null, rawBody), ORDER_CONTEXT);

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['ORDER_NOT_FOUND', 'P0002', 404, 'order_not_found', '注文が見つかりません。'],
    ['ORDER_NOT_IN_PRODUCTION', '22023', 409, 'not_in_production', '仕上がりを記録できる状態ではありません。一覧を更新してください。'],
    ['LINE_NOT_IN_PRODUCTION', '22023', 409, 'quantity_exceeds_in_production', '仕上がった数が受注生産中の数を超えています。一覧を更新してください。'],
    ['QUANTITY_EXCEEDS_IN_PRODUCTION', '22023', 409, 'quantity_exceeds_in_production', '仕上がった数が受注生産中の数を超えています。一覧を更新してください。'],
    ['COMPLETION_REQUEST_MISMATCH', '22023', 409, 'completion_request_mismatch', '前の記録と内容が違います。画面を開き直してください。'],
    ['COMPLETION_ARGUMENT_INVALID', '22023', 400, 'invalid_argument', '入力を確かめてください。'],
  ] as const)('DB が %s（%s）で断ったら %i %s', async (message, dbCode, status, code, error) => {
    rpcReturns({ admin_record_completion: { data: null, error: { message, code: dbCode } } });

    const response = await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: status === 409 ? 'conflict' : 'failure', detail: 'Completion refused', metadata: { code },
    }));
  });

  it('思いがけない DB の失敗は 500。ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ admin_record_completion: { data: null, error: { message: '宛先・氏名を含む DB の文', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '仕上がりの記録に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.completion.record] Failed to record completion', 'FulfillmentStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to record completion' }));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('DB が行を返さなければ 500', async () => {
    rpcReturns({ admin_record_completion: { data: [] } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect((await postCompletion(recordRequest(RECORD_BODY), ORDER_CONTEXT)).status).toBe(500);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /api/admin/orders/[id]/completions/[completionId]/cancel（仕上がりの取消）', () => {
  it('仕上がりを取り消し、監査に結果を残す', async () => {
    rpcReturns({ admin_cancel_completion: { data: [{ outcome: 'cancelled' }] } });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'cancelled' });
    expect(mockRpc).toHaveBeenCalledWith('admin_cancel_completion', {
      _order_id: ORDER_ID, _completion_id: COMPLETION_ID, _actor_id: 'admin-1',
    });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.completion.cancel',
      actor_id: 'admin-1',
      resource: 'orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      detail: 'Completion cancelled',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { completion_id: COMPLETION_ID, outcome: 'cancelled' },
    });
    expectNoKeyIsRedacted(mockLogAudit.mock.calls[0][0]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('もう取り消してあれば already_cancelled の 200', async () => {
    rpcReturns({ admin_cancel_completion: { data: [{ outcome: 'already_cancelled' }] } });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: 'already_cancelled' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Completion was already cancelled' }));
  });

  it.each([
    ['注文番号', { id: 'x', completionId: COMPLETION_ID }],
    ['仕上がりの番号', { id: ORDER_ID, completionId: 'x' }],
  ])('%s の形が違えば 400。DB を呼ばず、固定の文だけを監査に残す', async (_name, params) => {
    const response = await postCancel(cancelRequest(), { params: Promise.resolve(params) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '入力を確かめてください。', code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', detail: 'Invalid id', metadata: null }));
  });

  // 受注生産の品を一部送った後に、店が仕上がりを取り消そうとした時は 409 で断り、数は変わらない
  it.each([
    ['ORDER_NOT_FOUND', 'P0002', 404, 'order_not_found', '注文が見つかりません。'],
    ['COMPLETION_NOT_FOUND', 'P0002', 404, 'completion_not_found', '仕上がりの記録が見つかりません。'],
    ['ORDER_NOT_IN_PRODUCTION', '22023', 409, 'not_in_production', '仕上がりを記録できる状態ではありません。一覧を更新してください。'],
    ['COMPLETION_ALREADY_SHIPPED', '22023', 409, 'completion_already_shipped', 'もう発送した数があるため、取り消せません。'],
    ['COMPLETION_ARGUMENT_INVALID', '22023', 400, 'invalid_argument', '入力を確かめてください。'],
  ] as const)('DB が %s（%s）で断ったら %i %s', async (message, dbCode, status, code, error) => {
    rpcReturns({ admin_cancel_completion: { data: null, error: { message, code: dbCode } } });

    const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error, code });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: status === 409 ? 'conflict' : 'failure', detail: 'Completion cancel refused', metadata: { code },
    }));
  });

  it('思いがけない DB の失敗は 500。ログは例外名と DB の記号だけ', async () => {
    rpcReturns({ admin_cancel_completion: { data: null, error: { message: '宛先・氏名を含む DB の文', code: '08006' } } });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await postCancel(cancelRequest(), CANCEL_CONTEXT);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '仕上がりの取消に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.completion.cancel] Failed to cancel completion', 'FulfillmentStoreError', '08006']]);
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', detail: 'Failed to cancel completion' }));
    } finally {
      consoleError.mockRestore();
    }
  });
});
