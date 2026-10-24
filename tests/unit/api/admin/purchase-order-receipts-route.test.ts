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
import { POST } from '@/app/api/admin/purchase-orders/[id]/receipts/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { LINE_1, LINE_2, ORDER_ID, RECEIPT_ID } from '../../lib/purchase-orders/purchase-order-fixtures';

const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const validBody = {
  expectedVersion: 2,
  receivedOn: '2026-10-26',
  memo: '午前便',
  lines: [{ lineId: LINE_1, quantity: 2 }, { lineId: LINE_2, quantity: 3 }],
  requestKey: REQUEST_KEY,
};
const dbResult = { receiptId: RECEIPT_ID, version: 3, allocatedQuantity: 2, replayed: false };
const ACTION = 'admin.purchase_orders.receive';
const RECEIPT_PERMISSIONS = ['admin.receiving.manage', 'admin.purchase_orders.read'];

function makeRequest(body: unknown, id: string = ORDER_ID): Request {
  return new Request(`https://example.test/api/admin/purchase-orders/${id}/receipts`, {
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

describe('POST /api/admin/purchase-orders/[id]/receipts（受け取り）', () => {
  test('FREQ-529-AC-01: 201 で { receiptId, version, allocatedQuantity, replayed } を返し no-store。実行者は認可結果の userId だけから渡し、本文の actorId は使わない', async () => {
    const request = makeRequest({ ...validBody, actorId: 'forged' });
    const response = await POST(request, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(dbResult);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(RECEIPT_PERMISSIONS, request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_receive_purchase_order', {
      _purchase_order_id: ORDER_ID, _expected_version: 2, _received_on: '2026-10-26', _memo: '午前便',
      _lines: [{ lineId: LINE_1, quantity: 2 }, { lineId: LINE_2, quantity: 3 }], _actor_id: 'authorized-actor', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-529-AC-01: メモは前後の空白を落として渡し、無い・空白だけなら null', async () => {
    await post({ ...validBody, memo: '  午後便  ' });
    expect(rpc).toHaveBeenLastCalledWith('admin_receive_purchase_order', expect.objectContaining({ _memo: '午後便' }));
    await post({ ...validBody, memo: undefined });
    expect(rpc).toHaveBeenLastCalledWith('admin_receive_purchase_order', expect.objectContaining({ _memo: null }));
    await post({ ...validBody, memo: '   ' });
    expect(rpc).toHaveBeenLastCalledWith('admin_receive_purchase_order', expect.objectContaining({ _memo: null }));
    // 空白を足して 200 字を超えても、落とした後の字数で見る(DB と同じ)
    expect((await post({ ...validBody, memo: ` ${'あ'.repeat(200)} ` })).status).toBe(201);
  });

  test('FREQ-529-AC-02: 同じ要求の再送（replayed: true）も201で、そのまま返す', async () => {
    rpc.mockResolvedValue({ data: { ...dbResult, replayed: true }, error: null });
    const { status, json } = await post();
    expect(status).toBe(201);
    expect(json).toEqual({ ...dbResult, replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', metadata: { line_count: 2, allocated_quantity: 2, replayed: true } }));
  });

  test('FREQ-529-AC-01: 監査 admin.purchase_orders.receive は成功で、発注書の id・行数・割り当てた数・再送かどうかだけを残す', async () => {
    await post();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'success',
      metadata: { line_count: 2, allocated_quantity: 2, replayed: false },
    });
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    for (const secret of ['午前便', REQUEST_KEY, LINE_1, RECEIPT_ID]) expect(logged).not.toContain(secret);
  });

  test.each([
    ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage'], 'admin.receiving.manage'],
    ['admin.receiving.manage だけ', ['admin.receiving.manage'], 'admin.purchase_orders.read'],
    ['admin.purchase_orders.read だけ', ['admin.purchase_orders.read'], 'admin.receiving.manage'],
    ['admin.purchase_orders.manage と admin.stock.manage だけ', ['admin.purchase_orders.manage', 'admin.stock.manage'], 'admin.receiving.manage'],
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

  test('FREQ-540-AC-07: admin.receiving.manage と admin.purchase_orders.read の両方があれば進み、RPC を1回呼ぶ', async () => {
    useAcl(RECEIPT_PERMISSIONS);
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

  test('FREQ-529-AC-01: 認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC → 監査 の順は変えない', async () => {
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

  test('FREQ-529-AC-01: 回数制限は admin.purchase_orders.receive の 60 回/600 秒で、IP と actor（認可結果の userId）の2回', async () => {
    await post();
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: ACTION, limit: 60, windowSeconds: 600 }));
    expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: ACTION, limit: 60, windowSeconds: 600, subject: 'authorized-actor' }));
  });

  test('FREQ-529-AC-01: CSRF の拒否はその Response をそのまま返し、制限・RPC に進まない', async () => {
    const denied = new Response('Denied', { status: 403 });
    mockCsrf.mockResolvedValue(denied);
    const response = await POST(makeRequest(validBody), { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response).toBe(denied);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([1, 2])('FREQ-529-AC-01: 回数制限（%i 回目）の Response はそのまま返し、RPC に進まない', async (stage) => {
    const limited = new Response('Limited', { status: 429 });
    if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
    mockRateLimit.mockResolvedValueOnce(limited);
    const response = await POST(makeRequest(validBody), { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response).toBe(limited);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-529-AC-01: 本文が JSON でなければ 400 で、RPC を呼ばない', async () => {
    const { response, status } = await post('not json');
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['expectedVersion が無い', { ...validBody, expectedVersion: undefined }],
    ['expectedVersion が0', { ...validBody, expectedVersion: 0 }],
    ['expectedVersion が小数', { ...validBody, expectedVersion: 1.5 }],
    ['receivedOn が無い', { ...validBody, receivedOn: undefined }],
    ['receivedOn が日付の形でない', { ...validBody, receivedOn: '2026/10/26' }],
    ['receivedOn が実在しない日付', { ...validBody, receivedOn: '2026-02-30' }],
    ['receivedOn が日時', { ...validBody, receivedOn: '2026-10-26T00:00:00Z' }],
    ['メモが201字', { ...validBody, memo: 'あ'.repeat(201) }],
    ['メモが文字でない', { ...validBody, memo: 1 }],
    ['lines が無い', { ...validBody, lines: undefined }],
    ['lines が0件', { ...validBody, lines: [] }],
    ['lines が101件', { ...validBody, lines: Array.from({ length: 101 }, (_, i) => ({ lineId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, quantity: 1 })) }],
    ['lines が重複', { ...validBody, lines: [{ lineId: LINE_1, quantity: 1 }, { lineId: LINE_1, quantity: 2 }] }],
    ['lines が大文字小文字だけ違う重複', { ...validBody, lines: [{ lineId: LINE_1, quantity: 1 }, { lineId: LINE_1.toUpperCase(), quantity: 2 }] }],
    ['lineId が uuid でない', { ...validBody, lines: [{ lineId: 'abc', quantity: 1 }] }],
    ['数量が0', { ...validBody, lines: [{ lineId: LINE_1, quantity: 0 }] }],
    ['数量が負', { ...validBody, lines: [{ lineId: LINE_1, quantity: -1 }] }],
    ['数量が100000', { ...validBody, lines: [{ lineId: LINE_1, quantity: 100000 }] }],
    ['数量が小数', { ...validBody, lines: [{ lineId: LINE_1, quantity: 1.5 }] }],
    ['数量が文字', { ...validBody, lines: [{ lineId: LINE_1, quantity: '1' }] }],
    ['lines が配列でない', { ...validBody, lines: LINE_1 }],
    ['requestKey が無い', { ...validBody, requestKey: undefined }],
    ['requestKey が uuid でない', { ...validBody, requestKey: 'invalid' }],
  ])('FREQ-529-AC-01: 検証 %s は 400（details つき）で、RPC を呼ばない。監査は failure と結果コードだけ', async (_name, body) => {
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

  test('FREQ-529-AC-01: 上限ちょうど（100行・数量99999・メモ200字・うるう日）は通る', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ lineId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, quantity: 99999 }));
    expect((await post({ ...validBody, lines, memo: 'う'.repeat(200), receivedOn: '2028-02-29' })).status).toBe(201);
  });

  test.each(['abc', '123', 'not-a-uuid', '22222222-2222-4222-8222-22222222222Z', '../orders'])(
    'FREQ-529-AC-01: 発注書の id が uuid でない（%s）は400で no-store、RPC は呼ばない。監査の resource_id は null（受け取った文字列は残さない）', async (id) => {
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
    GROUP_G_FORBIDDEN: ['42501', 403, '受け取りを記録する権限がありません。'],
    GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
    GROUP_G_PO_NOT_FOUND: ['P0002', 404, '発注書が見つかりません。'],
    GROUP_G_PO_VERSION_CONFLICT: ['55000', 409, '発注書が更新されました。内容を確認して、もう一度送ってください。'],
    GROUP_G_PO_NOT_CONFIRMED: ['55000', 409, '数量が確定するまで受け取りはできません。'],
    GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING: ['23514', 409, '未納の数を超えて受け取ることはできません。先に数量を訂正してください。'],
    GROUP_G_PO_RECEIVED_ON_INVALID: ['22023', 400, '受取日は発注日から今日までの日付にしてください。'],
  }))('FREQ-529-AC-01: DB の %s は表の状態と本文（権限は受け取り用の文）を { code, error } で返し、監査は failure と行数と結果コードだけ', async (message, [sqlstate, status, body]) => {
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

  test('FREQ-529-AC-01: 未知・不一致の DB エラーは固定の500で、生の文を本文にも監査にもログにも出さない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', resource_id: ORDER_ID, metadata: { line_count: 2, code: 'PURCHASE_ORDER_RECEIVE_FAILED' },
    }));
    expect(inspect([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-529-AC-01: RPC の戻り値が型検査に通らなければ201にせず、固定の500', async () => {
    rpc.mockResolvedValue({ data: { receiptId: RECEIPT_ID, version: 3, replayed: false }, error: null });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
  });

  test('FREQ-529-AC-01: 想定外の throw は名前と code だけをログに残し、固定の500を返す', async () => {
    authorize.mockRejectedValue(Object.assign(new TypeError('PRIVATE-MARKER'), { code: 'XX000', details: 'PRIVATE-MARKER' }));
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(console.error).toHaveBeenCalledWith('POST /api/admin/purchase-orders/[id]/receipts error:', 'TypeError', 'XX000');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
    expect(rpc).not.toHaveBeenCalled();
  });
});
