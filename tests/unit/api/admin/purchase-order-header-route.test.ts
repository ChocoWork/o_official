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
import { PATCH } from '@/app/api/admin/purchase-orders/[id]/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ORDER_ID } from '../../lib/purchase-orders/purchase-order-fixtures';

const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const validBody = { expectedVersion: 3, supplierName: '工場B', memo: '新しいメモ', reason: '社名変更', requestKey: REQUEST_KEY };
const dbResult = { version: 4, replayed: false };
const ACTION = 'admin.purchase_orders.header.update';

function makeRequest(body: unknown, id: string = ORDER_ID): Request {
  return new Request(`https://example.test/api/admin/purchase-orders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function patch(body: unknown = validBody, id: string = ORDER_ID) {
  const response = await PATCH(makeRequest(body, id), { params: Promise.resolve({ id }) });
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

describe('PATCH /api/admin/purchase-orders/[id]（発注先・メモの訂正）', () => {
  test('FREQ-527-AC-01: 200 で { version, replayed } を返し no-store。実行者は認可結果の userId だけから渡し、本文の actorId は使わない', async () => {
    const request = makeRequest({ ...validBody, actorId: 'forged' });
    const response = await PATCH(request, { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(dbResult);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(['admin.purchase_orders.manage', 'admin.purchase_orders.read'], request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_update_purchase_order_header', {
      _purchase_order_id: ORDER_ID, _expected_version: 3, _supplier_name: '工場B', _memo: '新しいメモ', _reason: '社名変更',
      _actor_id: 'authorized-actor', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-527-AC-01: 同じ要求の再送（replayed: true）も200で、そのまま返す', async () => {
    rpc.mockResolvedValue({ data: { version: 4, replayed: true }, error: null });
    const { status, json } = await patch();
    expect(status).toBe(200);
    expect(json).toEqual({ version: 4, replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', metadata: { replayed: true } }));
  });

  test('FREQ-527-AC-01: 発注先とメモは前後の空白を落として渡し、メモが無い・空白だけなら null（メモを空にする）', async () => {
    await patch({ ...validBody, supplierName: '  工場B  ', memo: '  新しいメモ  ' });
    expect(rpc).toHaveBeenLastCalledWith('admin_update_purchase_order_header', expect.objectContaining({ _supplier_name: '工場B', _memo: '新しいメモ' }));
    await patch({ expectedVersion: 3, supplierName: '工場B', reason: '社名変更', requestKey: REQUEST_KEY });
    expect(rpc).toHaveBeenLastCalledWith('admin_update_purchase_order_header', expect.objectContaining({ _memo: null }));
    await patch({ ...validBody, memo: ' \t ' });
    expect(rpc).toHaveBeenLastCalledWith('admin_update_purchase_order_header', expect.objectContaining({ _memo: null }));
    // 空白を除いて500字ちょうどは通り、501字は断る
    expect((await patch({ ...validBody, memo: ` ${'い'.repeat(500)} ` })).status).toBe(200);
    expect((await patch({ ...validBody, memo: ` ${'い'.repeat(501)} ` })).status).toBe(400);
  });

  test('FREQ-527-AC-01: 監査 admin.purchase_orders.header.update は成功で、発注書の id と再送かどうかだけを残す（発注先・メモ・理由・要求番号は残さない）', async () => {
    await patch();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'success', metadata: { replayed: false },
    });
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    for (const secret of ['工場B', '新しいメモ', '社名変更', REQUEST_KEY]) expect(logged).not.toContain(secret);
  });

  test.each([
    ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage'], 'admin.purchase_orders.manage'],
    ['admin.purchase_orders.read だけ', ['admin.purchase_orders.read'], 'admin.purchase_orders.manage'],
    ['admin.purchase_orders.manage だけ', ['admin.purchase_orders.manage'], 'admin.purchase_orders.read'],
    ['admin.stock.manage と admin.receiving.manage だけ', ['admin.stock.manage', 'admin.receiving.manage'], 'admin.purchase_orders.manage'],
  ])('FREQ-540-AC-07: %s の人は 403（足りない最初の権限が permission）で no-store。CSRF・制限・RPC・監査には進まない', async (_name, held, missing) => {
    useAcl(held);
    const { response, status, json } = await patch();
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
    expect((await patch()).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden' }],
    [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-07: 認可の拒否 %s は状態と本文をそのまま返し no-store、CSRF より前で止まる', async (status, body) => {
    authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }) });
    const result = await patch();
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

    expect((await patch()).status).toBe(200);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'rpc', 'audit']);

    order.length = 0;
    expect((await patch({ ...validBody, reason: '' })).status).toBe(400);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'audit']);
  });

  test('FREQ-527-AC-01: 回数制限は admin.purchase_orders.header.update の 30 回/600 秒で、IP と actor（認可結果の userId）の2回', async () => {
    await patch();
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: ACTION, limit: 30, windowSeconds: 600 }));
    expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: ACTION, limit: 30, windowSeconds: 600, subject: 'authorized-actor' }));
  });

  test('FREQ-527-AC-01: CSRF の拒否はその Response をそのまま返し、制限・RPC に進まない', async () => {
    const denied = new Response('Denied', { status: 403 });
    mockCsrf.mockResolvedValue(denied);
    const response = await PATCH(makeRequest(validBody), { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response).toBe(denied);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([1, 2])('FREQ-527-AC-01: 回数制限（%i 回目）の Response はそのまま返し、RPC に進まない', async (stage) => {
    const limited = new Response('Limited', { status: 429 });
    if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
    mockRateLimit.mockResolvedValueOnce(limited);
    const response = await PATCH(makeRequest(validBody), { params: Promise.resolve({ id: ORDER_ID }) });
    expect(response).toBe(limited);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-527-AC-01: 本文が JSON でなければ 400 で、RPC を呼ばない', async () => {
    const { response, status } = await patch('not json');
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['expectedVersion が無い', { ...validBody, expectedVersion: undefined }],
    ['expectedVersion が0', { ...validBody, expectedVersion: 0 }],
    ['expectedVersion が小数', { ...validBody, expectedVersion: 1.5 }],
    ['expectedVersion が文字列', { ...validBody, expectedVersion: '3' }],
    ['expectedVersion が整数の上限を超える', { ...validBody, expectedVersion: 2147483648 }],
    ['発注先が無い', { ...validBody, supplierName: undefined }],
    ['発注先が空', { ...validBody, supplierName: '' }],
    ['発注先が空白だけ', { ...validBody, supplierName: '   ' }],
    ['発注先が101字', { ...validBody, supplierName: 'あ'.repeat(101) }],
    ['メモが501字', { ...validBody, memo: 'あ'.repeat(501) }],
    ['メモが文字列でない', { ...validBody, memo: 5 }],
    ['理由が無い', { ...validBody, reason: undefined }],
    ['理由が空', { ...validBody, reason: '' }],
    ['理由が空白だけ', { ...validBody, reason: '  ' }],
    ['理由が201字', { ...validBody, reason: 'あ'.repeat(201) }],
    ['requestKey が無い', { ...validBody, requestKey: undefined }],
    ['requestKey が uuid でない', { ...validBody, requestKey: 'invalid' }],
  ])('FREQ-527-AC-01: 検証 %s は 400（details つき）で、RPC を呼ばない。監査は failure と結果コードだけ', async (_name, body) => {
    const { response, status, json } = await patch(body);
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'failure', metadata: { code: 'INVALID_REQUEST' },
    });
  });

  test('FREQ-527-AC-01: 上限ちょうど（発注先100字・メモ500字・理由200字・版 2147483647）は通る', async () => {
    const { status } = await patch({ ...validBody, expectedVersion: 2147483647, supplierName: 'あ'.repeat(100), memo: 'い'.repeat(500), reason: 'う'.repeat(200) });
    expect(status).toBe(200);
  });

  test.each(['abc', '123', 'not-a-uuid', '22222222-2222-4222-8222-22222222222Z', '../orders'])(
    'FREQ-527-AC-01: 発注書の id が uuid でない（%s）は400で no-store、RPC は呼ばない。監査の resource_id は null（受け取った文字列は残さない）', async (id) => {
      const { response, status, json } = await patch(validBody, id);
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
  }))('FREQ-527-AC-02: DB の %s は表の状態と本文を { code, error } で返し、監査は failure と結果コードだけ', async (message, [sqlstate, status, body]) => {
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await patch();
    expect(result.status).toBe(status);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ code: message, error: body });
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'failure', metadata: { code: message },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-527-AC-01: 未知・不一致の DB エラーは固定の500で、生の文を本文にも監査にもログにも出さない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await patch();
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', resource_id: ORDER_ID, metadata: { code: 'PURCHASE_ORDER_HEADER_UPDATE_FAILED' },
    }));
    expect(inspect([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-527-AC-01: RPC の戻り値が型検査に通らなければ200にせず、固定の500', async () => {
    rpc.mockResolvedValue({ data: { version: 'x', replayed: false }, error: null });
    const result = await patch();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
  });

  test('FREQ-527-AC-01: 想定外の throw は名前と code だけをログに残し、固定の500を返す', async () => {
    authorize.mockRejectedValue(Object.assign(new TypeError('PRIVATE-MARKER'), { code: 'XX000', details: 'PRIVATE-MARKER' }));
    const result = await patch();
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(console.error).toHaveBeenCalledWith('PATCH /api/admin/purchase-orders/[id] error:', 'TypeError', 'XX000');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-527-AC-01: サービス用のクライアントを作れなくても固定の500で、生の文を出さない', async () => {
    (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await patch();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(inspect([result.text, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });
});
