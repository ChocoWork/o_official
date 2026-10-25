/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn();
const mockRate = jest.fn();
const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));

import { POST } from '@/app/api/admin/shipment-slips/[id]/shipment-date/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { SHIPMENT_SLIP_ERRORS } from '@/lib/orders/shipment-slips/shipment-slip-types';
import { SLIP_ID } from '../../lib/orders/shipment-slips/shipment-slip-fixtures';

const permissions = ['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read'];
const body = { expectedVersion: 2, shipmentDate: '2026-10-24', reason: '記録の訂正', requestKey: '11111111-1111-4111-8111-111111111111' };
const result = { id: SLIP_ID, version: 3, shipmentDate: body.shipmentDate, replayed: false };
const rpc = jest.fn();
const authorize = authorizeAdminPermissions as jest.Mock;
async function call(input: unknown = body, id = SLIP_ID) {
  const request = new Request('https://example.test/api/admin/shipment-slips/date', { method: 'POST', body: JSON.stringify(input) });
  const response = await POST(request, { params: Promise.resolve({ id }) });
  return { response, json: await response.json(), request };
}
beforeEach(() => {
  jest.resetAllMocks();
  authorize.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  mockRate.mockResolvedValue(null);
  (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc });
  rpc.mockResolvedValue({ data: result, error: null });
});

test('FREQ-535-AC-03: 訂正の3権限と認可actorだけでRPCを1回呼び、理由をtrimし200/no-store', async () => {
  const { response, json, request } = await call({ ...body, reason: ` ${body.reason} `, actorId: 'forged' });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(json).toEqual(result);
  expect(authorize).toHaveBeenCalledWith(permissions, request);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('admin_correct_shipment_date', {
    _slip_id: SLIP_ID, _expected_version: 2, _shipment_date: body.shipmentDate, _reason: body.reason,
    _actor_id: 'authorized-actor', _request_key: body.requestKey,
  });
  expect(mockAudit).toHaveBeenCalledWith({ action: 'admin.shipment_slips.date.correct', actor_id: 'authorized-actor',
    resource: 'shipment_slips', resource_id: SLIP_ID, outcome: 'success', metadata: { replayed: false } });
});
test.each(permissions)('FREQ-540-AC-10: %s が欠けると403の訂正文、CSRFより前に止まる', async (permission) => {
  authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission }), { status: 403 }) });
  const { response, json } = await call();
  expect(response.status).toBe(403);
  expect(json).toEqual({ error: '出荷日を訂正する権限がありません。', permission });
  expect(mockCsrf).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});
test.each([401, 503])('FREQ-540-AC-10: 認証・障害%sはそのまま返す', async (status) => {
  authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'fixed' }), { status }) });
  const { response, json } = await call();
  expect(response.status).toBe(status); expect(json).toEqual({ error: 'fixed' }); expect(mockCsrf).not.toHaveBeenCalled();
});
test('FREQ-540-AC-10: permission付きでもMFA-requiredの403本文とheadersは訂正文へ書き換えない', async () => {
  const denied = { error: 'Forbidden', reason: 'MFA required', permission: 'admin.shipping.correct_date', role: 'admin' };
  authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(denied), { status: 403, headers: { 'Retry-After': '30' } }) });
  const { response, json } = await call();
  expect(response.status).toBe(403); expect(json).toEqual(denied);
  expect(response.headers.get('retry-after')).toBe('30');
  expect(mockCsrf).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});
test.each(['\t\r\n', '\u3000\u00a0\ufeff'])('FREQ-535-AC-03: 空白だけの理由%jはRPC前にREASON_REQUIRED', async (reason) => {
  const { response, json } = await call({ ...body, reason });
  expect(response.status).toBe(400);
  expect(json).toEqual({ code: 'GROUP_G_SLIP_REASON_REQUIRED', error: '理由を入力してください。' });
  expect(rpc).not.toHaveBeenCalled();
});
test('FREQ-535-AC-03: 空白理由と他引数が不正なら他引数の入力エラーを先に返す', async () => {
  const { response, json } = await call({ ...body, reason: '\t\n', expectedVersion: 0 });
  expect(response.status).toBe(400); expect(json.error).toBe('Invalid request');
  expect(json).not.toHaveProperty('code'); expect(rpc).not.toHaveBeenCalled();
});
test('FREQ-535-AC-03: 認可→CSRF→IP30/600→actor30/600→RPC→監査', async () => {
  const order: string[] = [];
  authorize.mockImplementation(async () => { order.push('auth'); return { ok: true, userId: 'authorized-actor', role: 'admin' }; });
  mockCsrf.mockImplementation(() => { order.push('csrf'); });
  mockRate.mockImplementation((arg) => { order.push(arg.subject ? 'actor' : 'ip'); return null; });
  rpc.mockImplementation(() => { order.push('rpc'); return { data: result, error: null }; });
  mockAudit.mockImplementation(() => { order.push('audit'); });
  expect((await call()).response.status).toBe(200);
  expect(order).toEqual(['auth', 'csrf', 'ip', 'actor', 'rpc', 'audit']);
  expect(mockRate).toHaveBeenNthCalledWith(1, expect.objectContaining({ endpoint: 'admin.shipment_slips.date', limit: 30, windowSeconds: 600 }));
  expect(mockRate.mock.calls[0][0]).not.toHaveProperty('subject');
  expect(mockRate).toHaveBeenNthCalledWith(2, expect.objectContaining({ endpoint: 'admin.shipment_slips.date', limit: 30, windowSeconds: 600, subject: 'authorized-actor' }));
});
test.each([
  { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: 2147483648 },
  { shipmentDate: '2026-02-30' }, { shipmentDate: '2026/10/24' }, { shipmentDate: null },
  { reason: '' }, { reason: '  ' }, { reason: '\t\n\r' }, { reason: '\u3000\ufeff\u00a0' },
  { reason: 'あ'.repeat(201) }, { reason: null }, { reason: undefined },
  { requestKey: 'bad' },
])('FREQ-535-AC-03: 不正な本文%jは400、RPCなし、理由を監査へ出さない', async (patch) => {
  const { response } = await call({ ...body, ...patch });
  expect(response.status).toBe(400); expect(rpc).not.toHaveBeenCalled();
  expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(body.reason);
});
test('FREQ-535-AC-03: trim後200文字は通る、path不正は監査resource_id=null', async () => {
  expect((await call({ ...body, reason: ` ${'あ'.repeat(200)} ` })).response.status).toBe(200);
  rpc.mockClear(); mockAudit.mockClear();
  expect((await call(body, 'bad')).response.status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: null, metadata: { code: 'INVALID_REQUEST' } }));
});
test.each(['GROUP_G_FORBIDDEN', 'GROUP_G_SHIPMENT_DATE_INVALID', 'GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY', 'GROUP_G_SHIPMENT_DATE_UNCHANGED', 'GROUP_G_SLIP_REASON_REQUIRED', 'GROUP_G_SLIP_VERSION_CONFLICT'])('FREQ-535-AC-03: DB拒否%sは完全一致で固定の本文', async (code) => {
  const [sqlstate, status, message] = SHIPMENT_SLIP_ERRORS[code];
  rpc.mockResolvedValue({ data: null, error: { code: sqlstate, message: code, details: 'PRIVATE-MARKER' } });
  const answer = await call();
  expect(answer.response.status).toBe(status);
  expect(answer.json).toEqual({ code, error: code === 'GROUP_G_FORBIDDEN' ? '出荷日を訂正する権限がありません。' : message });
  expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('PRIVATE-MARKER');
});
test('FREQ-535-AC-03: CSRF・回数制限はRPCより前に止める', async () => {
  mockCsrf.mockResolvedValueOnce(new Response('{}', { status: 403 }));
  expect((await call()).response.status).toBe(403); expect(mockRate).not.toHaveBeenCalled();
  mockRate.mockResolvedValueOnce(new Response('{}', { status: 429 }));
  expect((await call()).response.status).toBe(429); expect(rpc).not.toHaveBeenCalled();
});
