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
import { POST as CONFIRM } from '@/app/api/admin/shipment-slips/[id]/confirm/route';
import { SHIPMENT_SLIP_ERRORS } from '@/lib/orders/shipment-slips/shipment-slip-types';

import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ITEM_ID, ITEM_ID_2, SLIP_ID } from '../../lib/orders/shipment-slips/shipment-slip-fixtures';

/**
 * 発送確定（POST /api/admin/shipment-slips/[id]/confirm）の窓口（G-3 Task 5）。
 * 認可（4つの権限）→ CSRF → IP の回数制限 → actor の回数制限 → 検証 → store → 監査 の順で、実行者は認可結果の userId だけから渡す。
 */
const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;

const REQUEST_KEY = '11111111-1111-4111-8111-111111111111';
const BODY = { expectedVersion: 2, carrier: null, trackingNumber: null, shipmentDate: '2026-10-25', notifyCustomer: true, requestKey: REQUEST_KEY };
const MANAGE = ['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read'];
const saved = { id: SLIP_ID, number: 'SL-20261025-0001', version: 3, shipmentDate: '2026-10-25', fulfillments: [{ orderId: '11111111-1111-4111-8111-111111111111', fulfillmentId: '22222222-2222-4222-8222-222222222222', number: 1, completesOrder: false }], replayed: false };

type Route = {
  name: string;
  handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  path: string;
  body: Record<string, unknown>;
  rpcName: string;
  rpcArgs: Record<string, unknown>;
  action: string;
  rateEndpoint: string;
  rateLimit: number;
  errorCode: string;
  successMetadata: Record<string, unknown>;
  failureMetadata: Record<string, unknown>;
  bad: Array<[string, Record<string, unknown>]>;
};

const ROUTES: Route[] = [{
  name: 'POST /api/admin/shipment-slips/[id]/confirm', handler: CONFIRM, path: 'confirm', body: BODY,
  rpcName: 'admin_confirm_shipment_slip',
  rpcArgs: { _slip_id: SLIP_ID, _expected_version: 2, _carrier: null, _tracking_number: null, _shipment_date: '2026-10-25', _notify_customer: true, _actor_id: 'authorized-actor', _request_key: REQUEST_KEY },
  action: 'admin.shipment_slips.confirm', rateEndpoint: 'admin.shipment_slips.confirm', rateLimit: 60,
  errorCode: 'SHIPMENT_SLIP_CONFIRM_FAILED', successMetadata: { fulfillment_count: 1, replayed: false }, failureMetadata: {},
  bad: [
    ['版0', { ...BODY, expectedVersion: 0 }], ['小数版', { ...BODY, expectedVersion: 1.5 }], ['版なし', { ...BODY, expectedVersion: undefined }],
    ['会社だけ', { ...BODY, carrier: 'yamato' }], ['番号だけ', { ...BODY, trackingNumber: 'ABC' }], ['会社不正', { ...BODY, carrier: 'unknown', trackingNumber: 'ABC' }],
    ['記号', { ...BODY, carrier: 'yamato', trackingNumber: 'abc?' }], ['65文字', { ...BODY, carrier: 'yamato', trackingNumber: 'A'.repeat(65) }],
    ['空番号', { ...BODY, carrier: 'yamato', trackingNumber: '  ' }], ['日付形式', { ...BODY, shipmentDate: '2026/10/25' }], ['不在日', { ...BODY, shipmentDate: '2026-02-30' }],
    ['日付なし', { ...BODY, shipmentDate: null }], ['通知なし', { ...BODY, notifyCustomer: null }], ['キー不正', { ...BODY, requestKey: 'bad' }],
  ],
}];

function makeRequest(route: Route, body: unknown, id: string): Request {
  return new Request(`https://example.test/api/admin/shipment-slips/${id}/${route.path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(route: Route, body: unknown = route.body, id: string = SLIP_ID) {
  const response = await route.handler(makeRequest(route, body, id), { params: Promise.resolve({ id }) });
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
  rpc.mockResolvedValue({ data: saved, error: null });
});
afterEach(() => jest.restoreAllMocks());

describe.each(ROUTES)('$name', (route) => {
  test('FREQ-533-AC-02: 200 で { id, number, version, replayed } を返し no-store。実行者は認可結果の userId だけから渡し、本文の actorId は使わない', async () => {
    const request = makeRequest(route, { ...route.body, actorId: 'forged' }, SLIP_ID);
    const response = await route.handler(request, { params: Promise.resolve({ id: SLIP_ID }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(saved);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(MANAGE, request);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(route.rpcName, route.rpcArgs);
  });

  test('FREQ-533-AC-03: 同じ要求の再送（replayed: true）も200で、そのまま返す', async () => {
    rpc.mockResolvedValue({ data: { ...saved, replayed: true }, error: null });
    const { status, json } = await call(route);
    expect(status).toBe(200);
    expect(json).toEqual({ ...saved, replayed: true });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', metadata: { ...route.successMetadata, replayed: true } }));
  });

  test('FREQ-533-AC-02: 監査は成功で、票の id と件数・再送かどうかだけを残す（品物・数量・要求番号は残さない）', async () => {
    await call(route);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: route.action, actor_id: 'authorized-actor', resource: 'shipment_slips', resource_id: SLIP_ID, outcome: 'success', metadata: route.successMetadata,
    });
    const logged = JSON.stringify(mockLogAudit.mock.calls);
    for (const secret of [ITEM_ID, ITEM_ID_2, REQUEST_KEY]) expect(logged).not.toContain(secret);
  });

  test.each([
    ['admin.items.read と admin.items.manage だけ', ['admin.items.read', 'admin.items.manage'], 'admin.shipping.manage'],
    ['read の2つだけ', ['admin.shipping.read', 'admin.orders.read'], 'admin.shipping.manage'],
    ['shipping の2つだけ', ['admin.shipping.manage', 'admin.shipping.read'], 'admin.orders.manage'],
  ])('FREQ-540-AC-10: %s の人は 403（足りない最初の権限が permission）で no-store。CSRF・制限・RPC・監査には進まない', async (_name, held, missing) => {
    useAcl(held);
    const { response, status, json } = await call(route);
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
    expect((await call(route)).status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  test.each([
    [401, { error: 'Unauthorized' }], [403, { error: 'Forbidden', reason: 'MFA required' }], [503, { error: 'Service temporarily unavailable' }],
  ])('FREQ-540-AC-10: 認可の拒否 %s は状態と本文をそのまま返し no-store、CSRF より前で止まる', async (status, body) => {
    authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(body), { status, headers: { 'retry-after': '30' } }) });
    const result = await call(route);
    expect(result.status).toBe(status);
    expect(result.json).toEqual(body);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.response.headers.get('retry-after')).toBe('30');
    expect(mockCsrf).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-533-AC-02: 認可 → CSRF → IP の回数制限 → actor の回数制限 → 検証 → RPC → 監査 の順は変えない', async () => {
    const order: string[] = [];
    authorize.mockImplementation(async () => { order.push('authorize'); return { ok: true, userId: 'authorized-actor', role: 'admin' }; });
    mockCsrf.mockImplementation(async () => { order.push('csrf'); });
    mockRateLimit.mockImplementation(async (arg: { subject?: string }) => { order.push(arg.subject ? 'rate:actor' : 'rate:ip'); return null; });
    rpc.mockImplementation(async () => { order.push('rpc'); return { data: saved, error: null }; });
    mockLogAudit.mockImplementation(async () => { order.push('audit'); });

    expect((await call(route)).status).toBe(200);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'rpc', 'audit']);
    order.length = 0;
    expect((await call(route, { ...route.body, requestKey: 'invalid' })).status).toBe(400);
    expect(order).toEqual(['authorize', 'csrf', 'rate:ip', 'rate:actor', 'audit']);
  });

  test('FREQ-533-AC-02: 回数制限の名前と数。IP と actor（認可結果の userId）の2回、600秒', async () => {
    await call(route);
    expect(mockRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRateLimit).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: route.rateEndpoint, limit: route.rateLimit, windowSeconds: 600 }));
    expect(mockRateLimit.mock.calls[0][0]).not.toHaveProperty('subject');
    expect(mockRateLimit).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: route.rateEndpoint, limit: route.rateLimit, windowSeconds: 600, subject: 'authorized-actor' }));
  });

  test('FREQ-533-AC-02: CSRF の拒否・回数制限の Response はそのまま返し、RPC に進まない', async () => {
    const denied = new Response('Denied', { status: 403 });
    mockCsrf.mockResolvedValueOnce(denied);
    expect(await route.handler(makeRequest(route, route.body, SLIP_ID), { params: Promise.resolve({ id: SLIP_ID }) })).toBe(denied);
    expect(mockRateLimit).not.toHaveBeenCalled();
    for (const stage of [1, 2]) {
      const limited = new Response('Limited', { status: 429 });
      if (stage === 2) mockRateLimit.mockResolvedValueOnce(null);
      mockRateLimit.mockResolvedValueOnce(limited);
      expect(await route.handler(makeRequest(route, route.body, SLIP_ID), { params: Promise.resolve({ id: SLIP_ID }) })).toBe(limited);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  test('FREQ-533-AC-02: 本文が JSON でなければ 400 で、RPC を呼ばない', async () => {
    const { response, status } = await call(route, 'not json');
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).not.toHaveBeenCalled();
  });

  test.each(route.bad)('FREQ-533-AC-02: 検証 %s は 400（details つき）で、RPC を呼ばない。監査は failure と結果コードだけ', async (_name, body) => {
    const { response, status, json } = await call(route, body);
    expect(status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(json.error).toBe('Invalid request');
    expect(json.details).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: route.action, actor_id: 'authorized-actor', resource: 'shipment_slips', resource_id: SLIP_ID, outcome: 'failure', metadata: { code: 'INVALID_REQUEST' },
    });
  });

  test('FREQ-533-AC-02: 版の上限（2147483647）ちょうどは通る', async () => {
    expect((await call(route, { ...route.body, expectedVersion: 2147483647 })).status).toBe(200);
  });

  test.each(['abc', '123', 'not-a-uuid', '22222222-2222-4222-8222-22222222222Z', '../shipment-slips'])(
    'FREQ-533-AC-02: 票の id が uuid でない（%s）は400で no-store、RPC は呼ばない。監査の resource_id は null（受け取った文字列は残さない）', async (id) => {
      const { response, status, json } = await call(route, route.body, id);
      expect(status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(json).toEqual({ error: 'Invalid request' });
      expect(rpc).not.toHaveBeenCalled();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', resource_id: null, metadata: { code: 'INVALID_REQUEST' } }));
      expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain(id);
    },
  );

  test.each(Object.entries(SHIPMENT_SLIP_ERRORS).map(([message, [sqlstate, status, body]]) => [message, sqlstate, status, body] as const))('FREQ-533-AC-02: DB の %s は表の状態と本文を { code, error } で返し、監査は failure と結果コードだけ', async (message, sqlstate, status, body) => {
    rpc.mockResolvedValue({ data: null, error: { message, code: sqlstate, details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' } });
    const result = await call(route);
    expect(result.status).toBe(status);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ code: message, error: body });
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith({
      action: route.action, actor_id: 'authorized-actor', resource: 'shipment_slips', resource_id: SLIP_ID, outcome: 'failure', metadata: { ...route.failureMetadata, code: message },
    });
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
  });

  test.each([
    ['未知の DB エラー', { message: 'PRIVATE-MARKER', code: '23514', details: 'PRIVATE-MARKER', hint: 'PRIVATE-MARKER' }],
    ['内部の DB エラー（GROUP_G_HISTORY_IMMUTABLE）', { message: 'GROUP_G_HISTORY_IMMUTABLE', code: '55000', details: 'PRIVATE-MARKER' }],
  ])('FREQ-533-AC-02: %s は固定の500で、生の文を本文にも監査にもログにも出さない', async (_name, error) => {
    rpc.mockResolvedValue({ data: null, error });
    const result = await call(route);
    expect(result.status).toBe(500);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(result.json).toEqual({ error: '発送の記録に失敗しました' });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'error', resource_id: SLIP_ID, metadata: { ...route.failureMetadata, code: route.errorCode },
    }));
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
  });

  test.each(['戻りが崩れている', 'RPC が投げる', 'クライアントが作れない'] as const)('FREQ-533-AC-02: %s と固定の500', async (source) => {
    if (source === '戻りが崩れている') rpc.mockResolvedValue({ data: { id: 'PRIVATE-MARKER' }, error: null });
    if (source === 'RPC が投げる') rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    if (source === 'クライアントが作れない') (createServiceRoleClient as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
    const result = await call(route);
    expect(result.status).toBe(500);
    expect(result.json).toEqual({ error: '発送の記録に失敗しました' });
    expect(result.text).not.toContain('PRIVATE-MARKER');
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
    expect(inspect((console.error as jest.Mock).mock.calls, { depth: null })).not.toContain('PRIVATE-MARKER');
  });
});

test('FREQ-533-AC-05: 会社と番号がそろえばtrim後の値を渡す', async () => {
  const result = await call(ROUTES[0], { ...BODY, carrier: 'yamato', trackingNumber: ' abc-123 ' });
  expect(result.status).toBe(200);
  expect(rpc).toHaveBeenCalledWith('admin_confirm_shipment_slip', expect.objectContaining({ _carrier: 'yamato', _tracking_number: 'abc-123' }));
});
