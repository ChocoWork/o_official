/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn();
const mockRateLimit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args) }));
const mockLogAudit = jest.fn();
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));

import { inspect } from 'util';
import { GET, POST } from '@/app/api/admin/shipment-slips/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { dbSlipListRow, ITEM_ID, ITEM_ID_2, SLIP_ID, slipListRow } from '../../lib/orders/shipment-slips/shipment-slip-fixtures';

const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;

async function get(query = '') {
  const request = new Request(`https://example.test/api/admin/shipment-slips${query}`);
  const response = await GET(request);
  const text = await response.text();
  return { request, response, status: response.status, text, json: text ? JSON.parse(text) : null };
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
  rpc.mockResolvedValue({ data: [dbSlipListRow({ total_count: 1 })], error: null });
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/admin/shipment-slips', () => {
  test('FREQ-531-AC-01: 200 で { rows, total, page, limit } を返し no-store。認可は shipping.read + orders.read、RPC は全段階・既定の20件・1頁目と認可結果の userId で1回だけ', async () => {
    const { request, response, json } = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ rows: [slipListRow()], total: 1, page: 1, limit: 20 });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(['admin.shipping.read', 'admin.orders.read'], request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('list_admin_shipment_slips', { _stage: null, _limit: 20, _offset: 0, _actor_id: 'authorized-actor' });
  });

  test.each(['draft', 'confirmed', 'cancelled', 'discarded'])('FREQ-531-AC-01: stage=%s で絞れる。limit・page も渡せる', async (stage) => {
    await get(`?stage=${stage}&limit=5&page=4`);
    expect(rpc).toHaveBeenCalledWith('list_admin_shipment_slips', { _stage: stage, _limit: 5, _offset: 15, _actor_id: 'authorized-actor' });
  });

  test.each([
    '?stage=unknown', '?stage=', '?stage=DRAFT', '?stage=draft,confirmed', '?stage=toString',
    '?limit=0', '?limit=101', '?limit=abc', '?limit=', '?limit=1.5',
    '?page=0', '?page=100001', '?page=abc', '?page=',
  ])('FREQ-531-AC-01: 不正な指定（%s）は400で no-store、RPC は呼ばない', async (query) => {
    const { response, status, json } = await get(query);
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: 'Invalid request' });
    expect(rpc).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  test.each([
    ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage'], 'admin.shipping.read'],
    ['admin.orders.read だけ', ['admin.orders.read'], 'admin.shipping.read'],
    ['admin.shipping.read だけ', ['admin.shipping.read'], 'admin.orders.read'],
  ])('FREQ-540-AC-10: %s の人は 403（足りない最初の権限が permission）で no-store。RPC には進まない', async (_name, held, missing) => {
    useAcl(held);
    const { response, status, json } = await get();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ error: 'Forbidden', permission: missing, role: 'supporter' });
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-10: 認可の拒否 %s は状態と本文をそのまま返し no-store、RPC は呼ばない', async (status, body) => {
    authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }) });
    const result = await get();
    expect(result.status).toBe(status);
    expect(result.json).toEqual(body);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.response.headers.get('retry-after')).toBe('30');
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-10: 認可が通らなければ、指定が不正でも400でなく認可の拒否を返す。読むだけの窓口なので CSRF の確かめも回数制限もしない', async () => {
    useAcl([]);
    expect((await get('?stage=unknown')).status).toBe(403);
    useAcl(['admin.shipping.read', 'admin.orders.read']);
    expect((await get()).status).toBe(200);
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });

  test('FREQ-540-AC-10: DB が GROUP_G_FORBIDDEN / 42501 で断ったら403の固定の文と code（生の文は返さない）', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'GROUP_G_FORBIDDEN', code: '42501', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const { response, status, json, text } = await get();
    expect(status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json).toEqual({ code: 'GROUP_G_FORBIDDEN', error: '発送を扱う権限がありません。' });
    expect(text).not.toContain('PRIVATE-MARKER');
  });

  test.each(['rpc', 'malformed', 'client'] as const)(
    'FREQ-531-AC-04: 内部の失敗(%s)は固定の500。DB の生の誤りを本文にもログにも出さない', async (source) => {
      if (source === 'rpc') rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE-MARKER', code: '57014', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
      if (source === 'malformed') rpc.mockResolvedValue({ data: [dbSlipListRow({ stage: 'PRIVATE-MARKER', total_count: 1 })], error: null });
      if (source === 'client') (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
      const { response, status, json, text } = await get();
      expect(status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: '発送の記録に失敗しました' });
      expect(text).not.toContain('PRIVATE-MARKER');
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
      expect((console.error as jest.Mock).mock.calls[0][0]).toBe('GET /api/admin/shipment-slips error:');
    });
});

describe('POST /api/admin/shipment-slips（下書きの作成）', () => {
  const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
  const LINES = [{ orderItemId: ITEM_ID, quantity: 2 }, { orderItemId: ITEM_ID_2, quantity: 1 }];
  const validBody = { lines: LINES, requestKey: REQUEST_KEY };
  const saved = { id: SLIP_ID, number: 'SL-20261025-0001', version: 1, replayed: false };
  const ACTION = 'admin.shipment_slips.draft.save';
  const MANAGE = ['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'];

  function makeRequest(body: unknown): Request {
    return new Request('https://example.test/api/admin/shipment-slips', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
  async function post(body: unknown = validBody) {
    const response = await POST(makeRequest(body));
    const text = await response.text();
    return { response, status: response.status, text, json: text ? JSON.parse(text) : null };
  }

  beforeEach(() => {
    rpc.mockResolvedValue({ data: saved, error: null });
  });

  test('FREQ-531-AC-03: 201 で { id, number, version, replayed } を返し no-store。実行者は認可結果の userId だけから渡し、本文の actorId は使わない', async () => {
    const request = makeRequest({ ...validBody, actorId: 'forged' });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(saved);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(MANAGE, request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_save_shipment_slip_draft', {
      _slip_id: null, _expected_version: null, _lines: LINES, _actor_id: 'authorized-actor', _request_key: REQUEST_KEY,
    });
  });

  test('FREQ-533-AC-03: 同じ要求の再送（replayed: true）も201で、そのまま返す。監査は再送かどうかだけを残す', async () => {
    rpc.mockResolvedValue({ data: { ...saved, replayed: true }, error: null });
    const { status, json } = await post();
    expect(status).toBe(201);
    expect(json).toEqual({ ...saved, replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', metadata: { line_count: 2, replayed: true } }));
  });

  test('FREQ-531-AC-03: 監査 admin.shipment_slips.draft.save は成功で、票の id・件数・再送かどうかだけを残す（品物・数量・要求番号は残さない）', async () => {
    await post();
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'shipment_slips', resource_id: SLIP_ID, outcome: 'success', metadata: { line_count: 2, replayed: false },
    });
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    for (const secret of [ITEM_ID, ITEM_ID_2, REQUEST_KEY]) expect(logged).not.toContain(secret);
  });

  test.each([
    ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage'], 'admin.shipping.manage'],
    ['read の2つだけ', ['admin.shipping.read', 'admin.orders.read'], 'admin.shipping.manage'],
    ['shipping.manage と shipping.read だけ', ['admin.shipping.manage', 'admin.shipping.read'], 'admin.orders.manage'],
    ['orders.manage と orders.read と shipping.manage だけ', ['admin.orders.manage', 'admin.orders.read', 'admin.shipping.manage'], 'admin.shipping.read'],
  ])('FREQ-540-AC-10: %s の人は 403（足りない最初の権限が permission）で no-store。CSRF・制限・RPC・監査には進まない', async (_name, held, missing) => {
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

  test('FREQ-540-AC-10: 4つの権限が揃えば進み、RPC を1回呼ぶ', async () => {
    useAcl(MANAGE);
    expect((await post()).status).toBe(201);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-10: 認可の拒否 %s は状態と本文をそのまま返し no-store、CSRF より前で止まる', async (status, body) => {
    authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }) });
    const result = await post();
    expect(result.status).toBe(status);
    expect(result.json).toEqual(body);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.response.headers.get('retry-after')).toBe('30');
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-531-AC-03: 認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC → 監査 の順は変えない', async () => {
    const order: string[] = [];
    authorize.mockImplementation(async () => { order.push('authorize'); return { ok: true, userId: 'authorized-actor', role: 'admin' }; });
    mockCsrf.mockImplementation(async () => { order.push('csrf'); });
    mockRateLimit.mockImplementation(async (arg: { subject?: string }) => { order.push(arg.subject ? 'rate:actor' : 'rate:ip'); return null; });
    rpc.mockImplementation(async () => { order.push('rpc'); return { data: saved, error: null }; });
    mockLogAudit.mockImplementation(async () => { order.push('audit'); });

    expect((await post()).status).toBe(201);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'rpc', 'audit']);
    order.length = 0;
    expect((await post({ ...validBody, lines: [] })).status).toBe(400);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'audit']);
  });

  test('FREQ-531-AC-03: 回数制限は admin.shipment_slips.draft の 120 回/600 秒で、IP と actor（認可結果の userId）の2回', async () => {
    await post();
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: 'admin.shipment_slips.draft', limit: 120, windowSeconds: 600 }));
    expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: 'admin.shipment_slips.draft', limit: 120, windowSeconds: 600, subject: 'authorized-actor' }));
  });

  test('FREQ-531-AC-03: CSRF の拒否・回数制限の Response はそのまま返し、RPC に進まない', async () => {
    const denied = new Response('Denied', { status: 403 });
    mockCsrf.mockResolvedValueOnce(denied);
    expect(await POST(makeRequest(validBody))).toBe(denied);
    expect(mockRateLimit).not.toHaveBeenCalled();
    for (const stage of [1, 2]) {
      const limited = new Response('Limited', { status: 429 });
      if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
      mockRateLimit.mockResolvedValueOnce(limited);
      expect(await POST(makeRequest(validBody))).toBe(limited);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-531-AC-03: 本文が JSON でなければ 400 で、RPC を呼ばない', async () => {
    const { response, status } = await post('not json');
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ orderItemId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`, quantity: 1 }));
  test.each([
    ['lines が無い', { requestKey: REQUEST_KEY }],
    ['lines が配列でない', { lines: 'x', requestKey: REQUEST_KEY }],
    ['lines が空', { lines: [], requestKey: REQUEST_KEY }],
    ['lines が101件', { lines: many(101), requestKey: REQUEST_KEY }],
    ['明細が重複', { lines: [{ orderItemId: ITEM_ID, quantity: 1 }, { orderItemId: ITEM_ID.toUpperCase(), quantity: 2 }], requestKey: REQUEST_KEY }],
    ['orderItemId が uuid でない', { lines: [{ orderItemId: 'abc', quantity: 1 }], requestKey: REQUEST_KEY }],
    ['orderItemId が無い', { lines: [{ quantity: 1 }], requestKey: REQUEST_KEY }],
    ['quantity が0', { lines: [{ orderItemId: ITEM_ID, quantity: 0 }], requestKey: REQUEST_KEY }],
    ['quantity が負', { lines: [{ orderItemId: ITEM_ID, quantity: -1 }], requestKey: REQUEST_KEY }],
    ['quantity が小数', { lines: [{ orderItemId: ITEM_ID, quantity: 1.5 }], requestKey: REQUEST_KEY }],
    ['quantity が文字列', { lines: [{ orderItemId: ITEM_ID, quantity: '2' }], requestKey: REQUEST_KEY }],
    ['quantity が100000', { lines: [{ orderItemId: ITEM_ID, quantity: 100000 }], requestKey: REQUEST_KEY }],
    ['行に余分な項目', { lines: [{ orderItemId: ITEM_ID, quantity: 1, price: 1 }], requestKey: REQUEST_KEY }],
    ['requestKey が無い', { lines: LINES }],
    ['requestKey が uuid でない', { lines: LINES, requestKey: 'invalid' }],
  ])('FREQ-531-AC-03: 検証 %s は 400（details つき）で、RPC を呼ばない。監査は failure と結果コードだけ', async (_name, body) => {
    const { response, status, json } = await post(body);
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'shipment_slips', resource_id: null, outcome: 'failure', metadata: { code: 'INVALID_REQUEST' },
    });
  });

  test('FREQ-531-AC-03: 100件・数量 99999 ちょうどは通る', async () => {
    expect((await post({ lines: many(100), requestKey: REQUEST_KEY })).status).toBe(201);
    expect((await post({ lines: [{ orderItemId: ITEM_ID, quantity: 99999 }], requestKey: REQUEST_KEY })).status).toBe(201);
  });

  test.each([
    ['GROUP_G_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
    ['GROUP_G_FORBIDDEN', '42501', 403, '発送を扱う権限がありません。'],
    ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
    ['GROUP_G_SLIP_EMPTY', '22023', 400, '品物を選んでください。'],
    ['GROUP_G_SLIP_CUSTOMER_MISMATCH', '22023', 409, '同じお客様の注文だけを同梱できます。会員は同じ会員、ゲストは同じメールアドレスの注文に限ります。'],
    ['GROUP_G_SLIP_ADDRESS_MISMATCH', '22023', 409, '配送先がすべて同じ注文だけを同梱できます。'],
    ['GROUP_G_SLIP_ADDRESS_INCOMPLETE', '22023', 409, '配送先の情報が足りない注文は発送できません。'],
    ['GROUP_G_SLIP_ORDER_NOT_SHIPPABLE', '22023', 409, '入金が確認できていない注文は発送できません。'],
    ['GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED', '22023', 409, '支払額の確認が済むまで発送できません。'],
    ['GROUP_G_SLIP_EXCHANGE_ON_HOLD', '22023', 409, '交換手数料のお支払いを待っているため発送できません。'],
    ['GROUP_G_SLIP_QUANTITY_EXCEEDS_READY', '22023', 409, '発送準備中の数を超えています。荷作り表を読み直してください。'],
  ])('FREQ-532-AC-01: DB の %s は表の状態と本文を { code, error } で返し、監査は failure と結果コードだけ', async (message, sqlstate, status, body) => {
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await post();
    expect(result.status).toBe(status);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ code: message, error: body });
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: ACTION, actor_id: 'authorized-actor', resource: 'shipment_slips', resource_id: null, outcome: 'failure', metadata: { line_count: 2, code: message },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
  });

  test.each([
    ['未知の DB エラー', { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' }],
    ['内部の DB エラー（GROUP_G_SLIP_NUMBER_EXHAUSTED）', { message: 'GROUP_G_SLIP_NUMBER_EXHAUSTED', code: '55000', details: 'PRIVATE-MARKER' }],
    ['SQLSTATE が表と違う', { message: 'GROUP_G_FORBIDDEN', code: '22023', details: 'PRIVATE-MARKER' }],
  ])('FREQ-531-AC-04: %s は固定の500で、生の文を本文にも監査にもログにも出さない', async (_name, error) => {
    rpc.mockResolvedValue({ data: null, error });
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発送の記録に失敗しました' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', metadata: { line_count: 2, code: 'SHIPMENT_SLIP_DRAFT_SAVE_FAILED' },
    }));
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test.each(['戻りが崩れている', 'RPC が投げる', 'クライアントが作れない'] as const)('FREQ-531-AC-04: %s と固定の500', async (source) => {
    if (source === '戻りが崩れている') rpc.mockResolvedValue({ data: { id: 'PRIVATE-MARKER' }, error: null });
    if (source === 'RPC が投げる') rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    if (source === 'クライアントが作れない') (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await post();
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発送の記録に失敗しました' });
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
  });
});