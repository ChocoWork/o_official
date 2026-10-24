/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
const mockCsrf = jest.fn();
const mockRateLimit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

import { inspect } from 'util';
import { POST } from '@/app/api/admin/purchase-orders/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';

const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '22222222-2222-4222-8222-222222222222';
const validBody = {
  supplierName: '工場A',
  memo: '春の追加分',
  lines: [{ variantId: 11, quantity: 5 }, { variantId: 12, quantity: 3 }],
  requestKey: REQUEST_KEY,
};
const dbResult = { id: ORDER_ID, number: 'PO-20261025-0001', version: 1, replayed: false };

function makeRequest(body: unknown): Request {
  return new Request('https://example.test/api/admin/purchase-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(body: unknown = validBody) {
  const response = await POST(makeRequest(body));
  const text = await response.text();
  return { response, status: response.status, text, json: text ? JSON.parse(text) : null };
}

/** 本物の authorizeAdminPermissions と同じ規則の代役: 要る権限を全部持つ時だけ通し、足りない最初の権限を 403 に入れる */
function useAcl(granted: readonly string[]) {
  authorize.mockImplementation(async (required: readonly string[]) => {
    const missing = required.find((code) => !granted.includes(code));
    return missing === undefined
      ? { ok: true, userId: 'authorized-actor', role: 'supporter' }
      : { ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission: missing, role: 'supporter' }), { status: 403 }) };
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  authorize.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  mockCsrf.mockResolvedValue(undefined);
  mockRateLimit.mockResolvedValue(null);
  mockLogAudit.mockResolvedValue(undefined);
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  rpc.mockResolvedValue({ data: dbResult, error: null });
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/admin/purchase-orders', () => {
  test('FREQ-526-AC-02: 201 で id・number・version・replayed を返し no-store。実行者は認可結果の userId だけから渡し、本文の actorId は使わない', async () => {
    const req = makeRequest({ ...validBody, actorId: 'forged' });
    const response = await POST(req);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(dbResult);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(['admin.purchase_orders.manage', 'admin.purchase_orders.read'], req);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_create_purchase_order', {
      _supplier_name: '工場A',
      _memo: '春の追加分',
      _lines: [{ variantId: 11, quantity: 5 }, { variantId: 12, quantity: 3 }],
      _actor_id: 'authorized-actor',
      _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-526-AC-03: 同じ要求の再送（replayed: true）も201で、そのまま返す', async () => {
    rpc.mockResolvedValue({ data: { ...dbResult, replayed: true }, error: null });
    const { status, json } = await post();
    expect(status).toBe(201);
    expect(json).toEqual({ ...dbResult, replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success', metadata: { line_count: 2, replayed: true },
    }));
  });

  test('FREQ-526-AC-02: 発注先は前後の空白を落として渡し、メモが無ければ null を渡す', async () => {
    await post({ supplierName: '  工場A  ', lines: [{ variantId: 11, quantity: 1 }], requestKey: REQUEST_KEY });
    expect(rpc).toHaveBeenCalledWith('admin_create_purchase_order', expect.objectContaining({ _supplier_name: '工場A', _memo: null }));
  });

  test('FREQ-526-AC-02: メモは前後の空白を落としてから長さを見て渡す（空白だけは null）。DB と同じ数え方', async () => {
    const lines = [{ variantId: 11, quantity: 1 }];
    // 空白を除いて500字ちょうど: 前後の空白を含めると500字を超えるが通り、DB へは落とした物を渡す
    const padded = await post({ supplierName: '工場A', memo: `  ${'い'.repeat(500)}  `, lines, requestKey: REQUEST_KEY });
    expect(padded.status).toBe(201);
    expect(rpc).toHaveBeenLastCalledWith('admin_create_purchase_order', expect.objectContaining({ _memo: 'い'.repeat(500) }));
    // 落としても501字なら断る
    expect((await post({ supplierName: '工場A', memo: ` ${'い'.repeat(501)} `, lines, requestKey: REQUEST_KEY })).status).toBe(400);
    // 空白だけのメモは無し（null）
    expect((await post({ supplierName: '工場A', memo: ' \t ', lines, requestKey: REQUEST_KEY })).status).toBe(201);
    expect(rpc).toHaveBeenLastCalledWith('admin_create_purchase_order', expect.objectContaining({ _memo: null }));
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  test('FREQ-526-AC-02: 監査 admin.purchase_orders.confirm は成功で、id・件数・再送かどうかだけを残す', async () => {
    await post();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.purchase_orders.confirm',
      actor_id: 'authorized-actor',
      resource: 'purchase_orders',
      resource_id: ORDER_ID,
      outcome: 'success',
      metadata: { line_count: 2, replayed: false },
    });
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    expect(logged).not.toContain('工場A');
    expect(logged).not.toContain('春の追加分');
    expect(logged).not.toContain(REQUEST_KEY);
  });

  test.each([
    ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage'], 'admin.purchase_orders.manage'],
    ['admin.purchase_orders.read だけ', ['admin.purchase_orders.read'], 'admin.purchase_orders.manage'],
    ['admin.purchase_orders.manage だけ', ['admin.purchase_orders.manage'], 'admin.purchase_orders.read'],
    ['admin.stock.manage と admin.receiving.manage だけ', ['admin.stock.manage', 'admin.receiving.manage'], 'admin.purchase_orders.manage'],
  ])('FREQ-540-AC-07: %s の人は 403（足りない最初の権限が permission）で no-store。CSRF・制限・RPC・監査には進まない', async (_name, held, missing) => {
    useAcl(held);
    const { response, status, json } = await post();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: 'Forbidden', permission: missing, role: 'supporter' });
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-07: admin.purchase_orders.manage と admin.purchase_orders.read の両方があれば進み、RPC を1回呼ぶ', async () => {
    useAcl(['admin.purchase_orders.manage', 'admin.purchase_orders.read']);
    expect((await post()).status).toBe(201);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden' }],
    [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-07: 認可の拒否 %s は状態と本文をそのまま返し no-store、CSRF より前で止まる', async (status, body) => {
    authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }) });
    const result = await post();
    expect(result.status).toBe(status);
    expect(result.json).toEqual(body);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.response.headers.get('retry-after')).toBe('30');
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-526-AC-02: 認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC → 監査 の順は変えない', async () => {
    const order: string[] = [];
    authorize.mockImplementation(async () => { order.push('authorize'); return { ok: true, userId: 'authorized-actor', role: 'admin' }; });
    mockCsrf.mockImplementation(async () => { order.push('csrf'); });
    mockRateLimit.mockImplementation(async (arg: { subject?: string }) => { order.push(arg.subject ? 'rate:actor' : 'rate:ip'); return null; });
    rpc.mockImplementation(async () => { order.push('rpc'); return { data: dbResult, error: null }; });
    mockLogAudit.mockImplementation(async () => { order.push('audit'); });

    expect((await post()).status).toBe(201);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'rpc', 'audit']);

    order.length = 0;
    expect((await post({ ...validBody, lines: [] })).status).toBe(400);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor']);
  });

  test('FREQ-526-AC-02: 回数制限は admin.purchase_orders.create の 30 回/600 秒で、IP と actor（認可結果の userId）の2回', async () => {
    await post();
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: 'admin.purchase_orders.create', limit: 30, windowSeconds: 600 }));
    expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      endpoint: 'admin.purchase_orders.create', limit: 30, windowSeconds: 600, subject: 'authorized-actor',
    }));
  });

  test('FREQ-526-AC-02: CSRF の拒否はその Response をそのまま返し、制限・RPC に進まない', async () => {
    const denied = new Response('Denied', { status: 403 });
    mockCsrf.mockResolvedValue(denied);
    const response = await POST(makeRequest(validBody));
    expect(response).toBe(denied);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([1, 2])('FREQ-526-AC-02: 回数制限（%i 回目）の Response はそのまま返し、RPC に進まない', async (stage) => {
    const limited = new Response('Limited', { status: 429 });
    if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
    mockRateLimit.mockResolvedValueOnce(limited);
    const response = await POST(makeRequest(validBody));
    expect(response).toBe(limited);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-526-AC-02: 本文が JSON でなければ 400 で、RPC を呼ばない', async () => {
    const response = await POST(new Request('https://example.test/api/admin/purchase-orders', { method: 'POST', body: 'not json' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['発注先が無い', { ...validBody, supplierName: undefined }],
    ['発注先が空', { ...validBody, supplierName: '' }],
    ['発注先が空白だけ', { ...validBody, supplierName: '   ' }],
    ['発注先が101字', { ...validBody, supplierName: 'あ'.repeat(101) }],
    ['メモが501字', { ...validBody, memo: 'あ'.repeat(501) }],
    ['メモが文字列でない', { ...validBody, memo: 5 }],
    ['明細が無い', { ...validBody, lines: undefined }],
    ['明細が0行', { ...validBody, lines: [] }],
    ['明細が101行', { ...validBody, lines: Array.from({ length: 101 }, (_, i) => ({ variantId: i + 1, quantity: 1 })) }],
    ['variantId が重複', { ...validBody, lines: [{ variantId: 11, quantity: 1 }, { variantId: 11, quantity: 2 }] }],
    ['variantId が0', { ...validBody, lines: [{ variantId: 0, quantity: 1 }] }],
    ['variantId が負', { ...validBody, lines: [{ variantId: -3, quantity: 1 }] }],
    ['variantId が小数', { ...validBody, lines: [{ variantId: 1.5, quantity: 1 }] }],
    ['variantId が文字列', { ...validBody, lines: [{ variantId: '11', quantity: 1 }] }],
    ['数量が0', { ...validBody, lines: [{ variantId: 11, quantity: 0 }] }],
    ['数量が100000', { ...validBody, lines: [{ variantId: 11, quantity: 100000 }] }],
    ['数量が小数', { ...validBody, lines: [{ variantId: 11, quantity: 1.5 }] }],
    ['数量が文字列', { ...validBody, lines: [{ variantId: 11, quantity: '5' }] }],
    ['requestKey が無い', { ...validBody, requestKey: undefined }],
    ['requestKey が uuid でない', { ...validBody, requestKey: 'invalid' }],
  ])('FREQ-526-AC-02: 検証 %s は 400（details つき）で、RPC を呼ばない', async (_name, body) => {
    const { response, status, json } = await post(body);
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  test('FREQ-526-AC-02: 数量の上限99999・100行・発注先100字・メモ500字ちょうどは通る', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ variantId: i + 1, quantity: 99999 }));
    const { status } = await post({ ...validBody, supplierName: 'あ'.repeat(100), memo: 'い'.repeat(500), lines });
    expect(status).toBe(201);
  });

  test.each(Object.entries({
    GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
    GROUP_G_FORBIDDEN: ['42501', 403, '発注を扱う権限がありません。'],
    GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
  }))('FREQ-526-AC-02: DB の %s は表の状態と本文を { code, error } で返し、監査は failure と結果コードだけ', async (message, [sqlstate, status, body]) => {
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await post();
    expect(result.status).toBe(status);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ code: message, error: body });
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.purchase_orders.confirm',
      actor_id: 'authorized-actor',
      resource: 'purchase_orders',
      resource_id: null,
      outcome: 'failure',
      metadata: { line_count: 2, code: message },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-526-AC-02: 未知・不一致の DB エラーは固定の500で、生の文を本文にも監査にもログにも出さない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', resource_id: null, metadata: { line_count: 2, code: 'PURCHASE_ORDER_CREATE_FAILED' },
    }));
    expect(inspect([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-526-AC-02: RPC の戻り値が型検査に通らなければ201にせず、固定の500', async () => {
    rpc.mockResolvedValue({ data: { id: 'abc', number: 'x', version: 1, replayed: false }, error: null });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
  });

  test('FREQ-526-AC-02: 想定外の throw は名前と code だけをログに残し、固定の500を返す', async () => {
    authorize.mockRejectedValue(Object.assign(new TypeError('PRIVATE-MARKER'), { code: 'XX000', details: 'PRIVATE-MARKER' }));
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(console.error).toHaveBeenCalledWith('POST /api/admin/purchase-orders error:', 'TypeError', 'XX000');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-526-AC-02: サービス用のクライアントを作れなくても固定の500で、生の文を出さない', async () => {
    (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(inspect([result.text, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });
});
