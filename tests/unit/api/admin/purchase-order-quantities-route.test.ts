/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
const mockCsrf = jest.fn();
const mockRateLimit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn(), authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

import { inspect } from 'util';
import { POST } from '@/app/api/admin/purchase-orders/[id]/quantities/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { LINE_1, LINE_2, ORDER_ID } from '../../lib/purchase-orders/purchase-order-fixtures';

const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const lines = [{ lineId: LINE_1, quantity: 4, unitPriceYen: 1200 }, { lineId: LINE_2, quantity: 0, unitPriceYen: null }];
const validBody = { expectedVersion: 2, lines, reason: '工場の都合', requestKey: REQUEST_KEY };
const dbResult = { version: 3, changedLines: 2, replayed: false };
const ACTION = 'admin.purchase_orders.quantity.confirm';

function makeRequest(body: unknown, id: string = ORDER_ID): Request {
  return new Request(`https://example.test/api/admin/purchase-orders/${id}/quantities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(body: unknown = validBody, id: string = ORDER_ID) {
  const response = await POST(makeRequest(body, id), { params: Promise.resolve({ id }) });
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

describe('POST /api/admin/purchase-orders/[id]/quantities（数量の確定・訂正）', () => {
  test('FREQ-527-AC-01: 201 で { version, changedLines, replayed } を返し no-store。実行者は認可結果の userId だけから渡し、本文の actorId は使わない', async () => {
    const request = makeRequest({ ...validBody, actorId: 'forged' });
    const response = await POST(request, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(dbResult);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(['admin.purchase_orders.manage', 'admin.purchase_orders.read'], request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_confirm_purchase_order_quantities', {
      _purchase_order_id: ORDER_ID, _expected_version: 2, _lines: lines, _reason: '工場の都合', _actor_id: 'authorized-actor', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-527-AC-01: 単価 0 と null（未登録）は区別してそのまま渡す。理由は省ける（最初の確定）ので null を渡し、空白だけも null', async () => {
    await post({ expectedVersion: 1, lines: [{ lineId: LINE_1, quantity: 5, unitPriceYen: 0 }, { lineId: LINE_2, quantity: 3, unitPriceYen: null }], requestKey: REQUEST_KEY });
    expect(rpc).toHaveBeenLastCalledWith('admin_confirm_purchase_order_quantities', expect.objectContaining({
      _lines: [{ lineId: LINE_1, quantity: 5, unitPriceYen: 0 }, { lineId: LINE_2, quantity: 3, unitPriceYen: null }], _reason: null,
    }));
    await post({ ...validBody, reason: '   ' });
    expect(rpc).toHaveBeenLastCalledWith('admin_confirm_purchase_order_quantities', expect.objectContaining({ _reason: null }));
    await post({ ...validBody, reason: '  訂正  ' });
    expect(rpc).toHaveBeenLastCalledWith('admin_confirm_purchase_order_quantities', expect.objectContaining({ _reason: '訂正' }));
  });

  test('FREQ-527-AC-01: 同じ要求の再送（replayed: true）も201で、そのまま返す', async () => {
    rpc.mockResolvedValue({ data: { ...dbResult, replayed: true }, error: null });
    const { status, json } = await post();
    expect(status).toBe(201);
    expect(json).toEqual({ ...dbResult, replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', metadata: { line_count: 2, changed_lines: 2, replayed: true } }));
  });

  test('FREQ-527-AC-01: 監査 admin.purchase_orders.quantity.confirm は成功で、発注書の id・行数・変えた行数・再送かどうかだけを残す', async () => {
    await post();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'success',
      metadata: { line_count: 2, changed_lines: 2, replayed: false },
    });
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    for (const secret of ['工場の都合', REQUEST_KEY, LINE_1, '1200']) expect(logged).not.toContain(secret);
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

  test('FREQ-527-AC-01: 認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC → 監査 の順は変えない', async () => {
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
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'audit']);
  });

  test('FREQ-527-AC-01: 回数制限は admin.purchase_orders.quantity.confirm の 60 回/600 秒で、IP と actor（認可結果の userId）の2回', async () => {
    await post();
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: ACTION, limit: 60, windowSeconds: 600 }));
    expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: ACTION, limit: 60, windowSeconds: 600, subject: 'authorized-actor' }));
  });

  test('FREQ-527-AC-01: CSRF の拒否はその Response をそのまま返し、制限・RPC に進まない', async () => {
    const denied = new Response('Denied', { status: 403 });
    mockCsrf.mockResolvedValue(denied);
    const response = await POST(makeRequest(validBody), { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response).toBe(denied);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([1, 2])('FREQ-527-AC-01: 回数制限（%i 回目）の Response はそのまま返し、RPC に進まない', async (stage) => {
    const limited = new Response('Limited', { status: 429 });
    if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
    mockRateLimit.mockResolvedValueOnce(limited);
    const response = await POST(makeRequest(validBody), { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response).toBe(limited);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-527-AC-01: 本文が JSON でなければ 400 で、RPC を呼ばない', async () => {
    const { response, status } = await post('not json');
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['expectedVersion が無い', { ...validBody, expectedVersion: undefined }],
    ['expectedVersion が0', { ...validBody, expectedVersion: 0 }],
    ['expectedVersion が小数', { ...validBody, expectedVersion: 1.5 }],
    ['expectedVersion が文字列', { ...validBody, expectedVersion: '2' }],
    ['明細が無い', { ...validBody, lines: undefined }],
    ['明細が0行', { ...validBody, lines: [] }],
    ['明細が101行', { ...validBody, lines: Array.from({ length: 101 }, (_, i) => ({ lineId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, quantity: 1, unitPriceYen: null })) }],
    ['lineId が重複', { ...validBody, lines: [lines[0], { ...lines[1], lineId: LINE_1 }] }],
    ['lineId が大文字小文字だけ違う重複', { ...validBody, lines: [{ ...lines[0], lineId: LINE_1.toUpperCase() }, { ...lines[1], lineId: LINE_1 }] }],
    ['lineId が uuid でない', { ...validBody, lines: [{ ...lines[0], lineId: 'abc' }, lines[1]] }],
    ['lineId が無い', { ...validBody, lines: [{ quantity: 1, unitPriceYen: null }, lines[1]] }],
    ['数量が負', { ...validBody, lines: [{ ...lines[0], quantity: -1 }, lines[1]] }],
    ['数量が100000', { ...validBody, lines: [{ ...lines[0], quantity: 100000 }, lines[1]] }],
    ['数量が小数', { ...validBody, lines: [{ ...lines[0], quantity: 1.5 }, lines[1]] }],
    ['数量が文字列', { ...validBody, lines: [{ ...lines[0], quantity: '5' }, lines[1]] }],
    ['数量が無い', { ...validBody, lines: [{ lineId: LINE_1, unitPriceYen: null }, lines[1]] }],
    ['単価が負', { ...validBody, lines: [{ ...lines[0], unitPriceYen: -1 }, lines[1]] }],
    ['単価が10000000', { ...validBody, lines: [{ ...lines[0], unitPriceYen: 10000000 }, lines[1]] }],
    ['単価が小数', { ...validBody, lines: [{ ...lines[0], unitPriceYen: 1.5 }, lines[1]] }],
    ['単価が文字列', { ...validBody, lines: [{ ...lines[0], unitPriceYen: '100' }, lines[1]] }],
    ['単価の項目が無い（未登録は null で明示する）', { ...validBody, lines: [{ lineId: LINE_1, quantity: 1 }, lines[1]] }],
    ['理由が201字', { ...validBody, reason: 'あ'.repeat(201) }],
    ['理由が文字列でない', { ...validBody, reason: 5 }],
    ['requestKey が無い', { ...validBody, requestKey: undefined }],
    ['requestKey が uuid でない', { ...validBody, requestKey: 'invalid' }],
  ])('FREQ-527-AC-01: 検証 %s は 400（details つき）で、RPC を呼ばない。監査は failure と結果コードだけ', async (_name, body) => {
    const { response, status, json } = await post(body);
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'failure', metadata: { code: 'INVALID_REQUEST' },
    });
  });

  test('FREQ-527-AC-01: 上限ちょうど（数量99999・単価9999999・100行・理由200字・数量0・単価0）は通る', async () => {
    const edge = Array.from({ length: 100 }, (_, i) => ({ lineId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, quantity: i === 0 ? 0 : 99999, unitPriceYen: i === 1 ? 0 : 9999999 }));
    const { status } = await post({ ...validBody, lines: edge, reason: 'う'.repeat(200) });
    expect(status).toBe(201);
  });

  test.each(['abc', '123', 'not-a-uuid', '22222222-2222-4222-8222-22222222222Z', '../orders'])(
    'FREQ-527-AC-01: 発注書の id が uuid でない（%s）は400で no-store、RPC は呼ばない。監査の resource_id は null（受け取った文字列は残さない）', async (id) => {
      const { response, status, json } = await post(validBody, id);
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: 'Invalid request' });
      expect(rpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: null, metadata: { code: 'INVALID_REQUEST' } }));
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(id);
    });

  test.each(Object.entries({
    GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
    GROUP_G_FORBIDDEN: ['42501', 403, '発注を扱う権限がありません。'],
    GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
    GROUP_G_PO_NOT_FOUND: ['P0002', 404, '発注書が見つかりません。'],
    GROUP_G_PO_VERSION_CONFLICT: ['55000', 409, '発注書が更新されました。内容を確認して、もう一度送ってください。'],
    GROUP_G_PO_REASON_REQUIRED: ['22023', 400, '理由を入力してください。'],
    GROUP_G_PO_QUANTITY_BELOW_RECEIVED: ['23514', 409, '納品済みの数より少ない数量には訂正できません。'],
  }))('FREQ-527-AC-02: DB の %s は表の状態と本文を { code, error } で返し、監査は failure と行数と結果コードだけ', async (message, [sqlstate, status, body]) => {
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await post();
    expect(result.status).toBe(status);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ code: message, error: body });
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'failure',
      metadata: { line_count: 2, code: message },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-527-AC-01: 未知・不一致の DB エラーは固定の500で、生の文を本文にも監査にもログにも出さない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', resource_id: ORDER_ID, metadata: { line_count: 2, code: 'PURCHASE_ORDER_QUANTITIES_FAILED' },
    }));
    expect(inspect([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-527-AC-01: RPC の戻り値が型検査に通らなければ201にせず、固定の500', async () => {
    rpc.mockResolvedValue({ data: { version: 3, replayed: false }, error: null });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
  });

  test('FREQ-527-AC-01: 想定外の throw は名前と code だけをログに残し、固定の500を返す', async () => {
    authorize.mockRejectedValue(Object.assign(new TypeError('PRIVATE-MARKER'), { code: 'XX000', details: 'PRIVATE-MARKER' }));
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(console.error).toHaveBeenCalledWith('POST /api/admin/purchase-orders/[id]/quantities error:', 'TypeError', 'XX000');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
    expect(rpc).not.toHaveBeenCalled();
  });
});
