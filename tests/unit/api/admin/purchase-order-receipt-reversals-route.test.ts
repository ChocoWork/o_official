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
import { POST } from '@/app/api/admin/purchase-orders/[id]/receipts/[receiptId]/reversals/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ORDER_ID, RECEIPT_ID, RECEIPT_LINE_ID } from '../../lib/purchase-orders/purchase-order-fixtures';

const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const NEW_RECEIPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
const validBody = {
  expectedVersion: 3,
  lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: 2 }],
  reason: '数え間違い',
  requestKey: REQUEST_KEY,
};
const dbResult = { receiptId: NEW_RECEIPT_ID, version: 4, releasedQuantity: 0, replayed: false };
const ACTION = 'admin.purchase_orders.receipt.reverse';
const RECEIPT_PERMISSIONS = ['admin.receiving.manage', 'admin.purchase_orders.read'];

function makeRequest(body: unknown, id: string = ORDER_ID, receiptId: string = RECEIPT_ID): Request {
  return new Request(`https://example.test/api/admin/purchase-orders/${id}/receipts/${receiptId}/reversals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function post(body: unknown = validBody, id: string = ORDER_ID, receiptId: string = RECEIPT_ID) {
  const response = await POST(makeRequest(body, id, receiptId), { params: Promise.resolve({ id, receiptId }) });
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

describe('POST /api/admin/purchase-orders/[id]/receipts/[receiptId]/reversals（受け取りの取消・数量訂正）', () => {
  test('FREQ-529-AC-04: 201 で { receiptId, version, releasedQuantity, replayed } を返し no-store。実行者は認可結果の userId だけから渡し、確認の数が無ければ null', async () => {
    const request = makeRequest({ ...validBody, actorId: 'forged' });
    const response = await POST(request, { params: Promise.resolve({ id: ORDER_ID, receiptId: RECEIPT_ID }) });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(dbResult);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(RECEIPT_PERMISSIONS, request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_reverse_purchase_order_receipt', {
      _purchase_order_id: ORDER_ID, _expected_version: 3, _receipt_id: RECEIPT_ID, _lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: 2 }],
      _reason: '数え間違い', _expected_release_quantity: null, _actor_id: 'authorized-actor', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-529-AC-04: 確認した後の送信は expectedReleaseQuantity を DB の関数へ渡す（0 も有効な確認の数）。理由は前後の空白を落とす', async () => {
    await post({ ...validBody, reason: '  数え間違い  ', expectedReleaseQuantity: 3 });
    expect(rpc).toHaveBeenLastCalledWith('admin_reverse_purchase_order_receipt', expect.objectContaining({ _expected_release_quantity: 3, _reason: '数え間違い' }));
    await post({ ...validBody, expectedReleaseQuantity: 0 });
    expect(rpc).toHaveBeenLastCalledWith('admin_reverse_purchase_order_receipt', expect.objectContaining({ _expected_release_quantity: 0 }));
  });

  test('FREQ-529-AC-04: 外す割当の確認が要る時は 409 { code, error, releasedQuantity } で no-store（G-1 の在庫の窓口と同じ形）。監査は failure と行数と結果コードだけ', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code: '55000', details: '{"releasedQuantity": 3}', hint: 'PRIVATE-MARKER' },
    });
    const result = await post();
    expect(result.status).toBe(409);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({
      code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', error: '割り当て済みの品を外す必要があります。数量を確認してください。', releasedQuantity: 3,
    });
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'failure',
      metadata: { line_count: 1, code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED' },
    });
    expect(result.text).not.toContain('PRIVATE-MARKER');
  });

  test.each([
    ['DETAIL が無い', null],
    ['DETAIL が JSON でない', 'not json'],
    ['キーが違う', '{"released": 3}'],
    ['キーが2つ', '{"releasedQuantity": 3, "extra": 1}'],
    ['点数が負', '{"releasedQuantity": -1}'],
    ['点数が小数', '{"releasedQuantity": 1.5}'],
    ['点数が文字', '{"releasedQuantity": "3"}'],
    ['点数が大きすぎる', '{"releasedQuantity": 2147483648}'],
  ])('FREQ-529-AC-04: 確認の DETAIL が %s なら確認の409にせず、固定の500（生の文は出さない）', async (_name, details) => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code: '55000', details } });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
  });

  test('FREQ-529-AC-04: 同じ要求の再送（replayed: true）も201で、そのまま返す', async () => {
    rpc.mockResolvedValue({ data: { ...dbResult, releasedQuantity: 3, replayed: true }, error: null });
    const { status, json } = await post();
    expect(status).toBe(201);
    expect(json).toEqual({ ...dbResult, releasedQuantity: 3, replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', metadata: { line_count: 1, released_quantity: 3, replayed: true } }));
  });

  test('FREQ-529-AC-04: 監査 admin.purchase_orders.receipt.reverse は成功で、発注書の id・行数・外した数・再送かどうかだけを残す', async () => {
    await post();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'success',
      metadata: { line_count: 1, released_quantity: 0, replayed: false },
    });
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    for (const secret of ['数え間違い', REQUEST_KEY, RECEIPT_ID, RECEIPT_LINE_ID, NEW_RECEIPT_ID]) expect(logged).not.toContain(secret);
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

  test('FREQ-529-AC-04: 認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC → 監査 の順は変えない', async () => {
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

  test('FREQ-529-AC-04: 回数制限は admin.purchase_orders.receipt.reverse の 30 回/600 秒で、IP と actor（認可結果の userId）の2回', async () => {
    await post();
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: ACTION, limit: 30, windowSeconds: 600 }));
    expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: ACTION, limit: 30, windowSeconds: 600, subject: 'authorized-actor' }));
  });

  test('FREQ-529-AC-04: CSRF の拒否はその Response をそのまま返し、制限・RPC に進まない', async () => {
    const denied = new Response('Denied', { status: 403 });
    mockCsrf.mockResolvedValue(denied);
    const response = await POST(makeRequest(validBody), { params: Promise.resolve({ id: ORDER_ID, receiptId: RECEIPT_ID }) });
    expect(response).toBe(denied);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([1, 2])('FREQ-529-AC-04: 回数制限（%i 回目）の Response はそのまま返し、RPC に進まない', async (stage) => {
    const limited = new Response('Limited', { status: 429 });
    if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
    mockRateLimit.mockResolvedValueOnce(limited);
    const response = await POST(makeRequest(validBody), { params: Promise.resolve({ id: ORDER_ID, receiptId: RECEIPT_ID }) });
    expect(response).toBe(limited);
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-529-AC-04: 本文が JSON でなければ 400 で、RPC を呼ばない', async () => {
    const { response, status } = await post('not json');
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    ['expectedVersion が無い', { ...validBody, expectedVersion: undefined }],
    ['expectedVersion が0', { ...validBody, expectedVersion: 0 }],
    ['expectedVersion が小数', { ...validBody, expectedVersion: 1.5 }],
    ['lines が無い', { ...validBody, lines: undefined }],
    ['lines が0件', { ...validBody, lines: [] }],
    ['lines が101件', { ...validBody, lines: Array.from({ length: 101 }, (_, i) => ({ receiptLineId: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`, quantity: 1 })) }],
    ['lines が重複', { ...validBody, lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: 1 }, { receiptLineId: RECEIPT_LINE_ID, quantity: 1 }] }],
    ['lines が大文字小文字だけ違う重複', { ...validBody, lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: 1 }, { receiptLineId: RECEIPT_LINE_ID.toUpperCase(), quantity: 1 }] }],
    ['receiptLineId が uuid でない', { ...validBody, lines: [{ receiptLineId: 'abc', quantity: 1 }] }],
    ['数量が0', { ...validBody, lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: 0 }] }],
    ['数量が負', { ...validBody, lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: -1 }] }],
    ['数量が100000', { ...validBody, lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: 100000 }] }],
    ['数量が小数', { ...validBody, lines: [{ receiptLineId: RECEIPT_LINE_ID, quantity: 1.5 }] }],
    ['lines が配列でない', { ...validBody, lines: RECEIPT_LINE_ID }],
    ['理由が無い', { ...validBody, reason: undefined }],
    ['理由が空', { ...validBody, reason: '' }],
    ['理由が空白だけ', { ...validBody, reason: '   ' }],
    ['理由が201字', { ...validBody, reason: 'あ'.repeat(201) }],
    ['確認の数が負', { ...validBody, expectedReleaseQuantity: -1 }],
    ['確認の数が小数', { ...validBody, expectedReleaseQuantity: 1.5 }],
    ['確認の数が文字', { ...validBody, expectedReleaseQuantity: '3' }],
    ['確認の数が大きすぎる', { ...validBody, expectedReleaseQuantity: 2147483648 }],
    ['requestKey が無い', { ...validBody, requestKey: undefined }],
    ['requestKey が uuid でない', { ...validBody, requestKey: 'invalid' }],
  ])('FREQ-529-AC-04: 検証 %s は 400（details つき）で、RPC を呼ばない。監査は failure と結果コードだけ', async (_name, body) => {
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

  test('FREQ-529-AC-04: 上限ちょうど（100行・数量99999・理由200字・確認の数2147483647）は通る', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ receiptLineId: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`, quantity: 99999 }));
    expect((await post({ ...validBody, lines, reason: 'う'.repeat(200), expectedReleaseQuantity: 2147483647 })).status).toBe(201);
  });

  test.each(['abc', '123', 'not-a-uuid', '22222222-2222-4222-8222-22222222222Z', '../orders'])(
    'FREQ-529-AC-04: 発注書の id が uuid でない（%s）は400で no-store、RPC は呼ばない。監査の resource_id は null（受け取った文字列は残さない）', async (id) => {
      const { response, status, json } = await post(validBody, id);
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: 'Invalid request' });
      expect(rpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: null, metadata: { code: 'INVALID_REQUEST' } }));
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(id);
    });

  test.each(['abc', '123', 'not-a-uuid', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbZ', '..%2Forders'])(
    'FREQ-529-AC-04: 受取の id が uuid でない（%s）は400で no-store、RPC は呼ばない。監査は failure（resource_id は正しい発注書の id、受け取った文字列は残さない）', async (receiptId) => {
      const { response, status, json } = await post(validBody, ORDER_ID, receiptId);
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: 'Invalid request' });
      expect(rpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: ORDER_ID, metadata: { code: 'INVALID_REQUEST' } }));
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(receiptId);
    });

  test.each(Object.entries({
    GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
    GROUP_G_FORBIDDEN: ['42501', 403, '受け取りを記録する権限がありません。'],
    GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
    GROUP_G_PO_NOT_FOUND: ['P0002', 404, '発注書が見つかりません。'],
    GROUP_G_PO_VERSION_CONFLICT: ['55000', 409, '発注書が更新されました。内容を確認して、もう一度送ってください。'],
    GROUP_G_PO_REASON_REQUIRED: ['22023', 400, '理由を入力してください。'],
    GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED: ['23514', 409, '取り消せる数を超えています。'],
    GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT: ['23514', 409, '在庫が足りないため取り消せません。取り消す数が、空き在庫と外せる割当の合計を超えています。'],
  }))('FREQ-529-AC-05: DB の %s は表の状態と本文（権限は受け取り用の文）を { code, error } で返し、監査は failure と行数と結果コードだけ', async (message, [sqlstate, status, body]) => {
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await post();
    expect(result.status).toBe(status);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ code: message, error: body });
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'purchase_orders', resource_id: ORDER_ID, outcome: 'failure',
      metadata: { line_count: 1, code: message },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-529-AC-04: 未知・不一致の DB エラーは固定の500で、生の文を本文にも監査にもログにも出さない', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', resource_id: ORDER_ID, metadata: { line_count: 1, code: 'PURCHASE_ORDER_RECEIPT_REVERSE_FAILED' },
    }));
    expect(inspect([result.text, mockLogAudit.mock.calls, (console.error as jest.Mock).mock.calls], { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-529-AC-04: RPC の戻り値が型検査に通らなければ201にせず、固定の500', async () => {
    rpc.mockResolvedValue({ data: { receiptId: NEW_RECEIPT_ID, version: 4, replayed: false }, error: null });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
  });

  test('FREQ-529-AC-04: 想定外の throw は名前と code だけをログに残し、固定の500を返す', async () => {
    authorize.mockRejectedValue(Object.assign(new TypeError('PRIVATE-MARKER'), { code: 'XX000', details: 'PRIVATE-MARKER' }));
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発注の記録に失敗しました' });
    expect(console.error).toHaveBeenCalledWith('POST /api/admin/purchase-orders/[id]/receipts/[receiptId]/reversals error:', 'TypeError', 'XX000');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
    expect(rpc).not.toHaveBeenCalled();
  });
});
