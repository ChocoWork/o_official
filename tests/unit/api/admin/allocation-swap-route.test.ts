/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn(); const mockAudit = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: () => mockCsrf() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockAudit(...args) }));
import { POST } from '@/app/api/admin/orders/[id]/allocations/swap/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ALLOCATION_SWAP_ERRORS } from '@/lib/inventory/allocation-swap-types';

const id = '11111111-1111-4111-8111-111111111111'; const donor = '22222222-2222-4222-8222-222222222222';
const item = '33333333-3333-4333-8333-333333333333'; const donorItem = '44444444-4444-4444-8444-444444444444';
const body = { takerOrderItemId: item, donorOrderItemId: donorItem, quantity: 2, reason: '順番の調整', requestKey: donor };
const saved = { id, operationId: donor, takerOrderId: id, takerOrderItemId: item, donorOrderId: donor, donorOrderItemId: donorItem, quantity: 2, reason: body.reason, replayed: false };
const rpc = jest.fn(); const auth = authorizeAdminPermissions as jest.Mock;
async function call(input: unknown = body, orderId = id) {
  const request = new Request('https://example.test/api/admin/orders/swap', { method: 'POST', body: JSON.stringify(input) });
  const response = await POST(request, { params: Promise.resolve({ id: orderId }) });
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { response, json: await response.json(), request };
}
beforeEach(() => {
  jest.resetAllMocks(); auth.mockResolvedValue({ ok: true, userId: 'authorized-actor', role: 'admin' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockRate.mockResolvedValue(null); (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc }); rpc.mockResolvedValue({ data: saved, error: null });
});
afterEach(() => jest.restoreAllMocks());
test('FREQ-540-AC-13: 認可→CSRF→IP→actor→検証→RPC→監査、actorは認可結果だけ', async () => {
  const sequence: string[] = [];
  auth.mockImplementation(async () => { sequence.push('auth'); return { ok: true, userId: 'authorized-actor', role: 'admin' }; });
  mockCsrf.mockImplementation(() => { sequence.push('csrf'); });
  mockRate.mockImplementation((arg) => { sequence.push(arg.subject ? 'actor' : 'ip'); return null; });
  rpc.mockImplementation(() => { sequence.push('rpc'); return { data: saved, error: null }; });
  mockAudit.mockImplementation(() => { sequence.push('audit'); });
  const request = new Request('https://example.test/swap', { method: 'POST' });
  jest.spyOn(request, 'json').mockImplementation(async () => { sequence.push('validation'); return { ...body, reason: ` ${body.reason} ` }; });
  const response = await POST(request, { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual(saved);
  expect(sequence).toEqual(['auth', 'csrf', 'ip', 'actor', 'validation', 'rpc', 'audit']);
  expect(auth).toHaveBeenCalledWith(['admin.orders.allocate', 'admin.orders.read'], request);
  expect(mockRate.mock.calls).toEqual([[{ request, endpoint: 'admin.orders.allocation.swap', limit: 30, windowSeconds: 600 }], [{ request, endpoint: 'admin.orders.allocation.swap', limit: 30, windowSeconds: 600, subject: 'authorized-actor' }]]);
  expect(rpc).toHaveBeenCalledWith('admin_swap_order_allocations', { _order_id: id, _taker_order_item_id: item, _donor_order_item_id: donorItem, _quantity: 2, _reason: body.reason, _actor_id: 'authorized-actor', _request_key: donor });
  expect(mockAudit).toHaveBeenCalledWith({ action: 'admin.orders.allocation.swap', actor_id: 'authorized-actor', resource: 'orders', resource_id: id, outcome: 'success', metadata: { quantity: 2, replayed: false } });
});
test.each(['admin.orders.allocate', 'admin.orders.read'])('FREQ-540-AC-13: %s不足の403はpermissionとroleを保持', async (permission) => {
  auth.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission, role: 'supporter' }), { status: 403 }) });
  const result = await call(); expect(result.response.status).toBe(403);
  expect(result.json).toEqual({ error: '割り当てを入れ替える権限がありません。', permission, role: 'supporter' }); expect(mockCsrf).not.toHaveBeenCalled();
});
test.each([401, 403])('FREQ-540-AC-13: 認証/MFA%sの本文とheadersを保持', async (status) => {
  const denied = { error: 'Forbidden', reason: 'MFA required', permission: 'admin.orders.allocate' };
  auth.mockResolvedValue({ ok: false, response: new Response(JSON.stringify(denied), { status, headers: { 'Retry-After': '30' } }) });
  const result = await call(); expect(result.response.status).toBe(status); expect(result.json).toEqual(denied); expect(result.response.headers.get('retry-after')).toBe('30'); expect(rpc).not.toHaveBeenCalled();
});
test.each(['csrf', 'ip', 'actor'])('FREQ-540-AC-13: %sで停止し、検証・RPCへ進まない', async (stop) => {
  if (stop === 'csrf') mockCsrf.mockResolvedValue(new Response('{}', { status: 403 }));
  else if (stop === 'ip') mockRate.mockResolvedValueOnce(new Response('{}', { status: 429 }));
  else mockRate.mockResolvedValueOnce(null).mockResolvedValueOnce(new Response('{}', { status: 429 }));
  expect((await call({}, 'invalid')).response.status).toBe(stop === 'csrf' ? 403 : 429);
  expect(rpc).not.toHaveBeenCalled(); expect(mockAudit).not.toHaveBeenCalled();
});
test.each([{ quantity: 0 }, { quantity: 100000 }, { quantity: 1.5 }, { quantity: '2' }, { takerOrderItemId: 'bad' }, { donorOrderItemId: null }, { requestKey: 'bad' }, { reason: 'あ'.repeat(201) }, { reason: null }, { actorId: 'forged' }])('FREQ-523-AC-02: strict本文%jは400でRPCを呼ばない', async (patch) => {
  expect((await call({ ...body, ...patch })).response.status).toBe(400); expect(rpc).not.toHaveBeenCalled();
  expect(JSON.stringify(mockAudit.mock.calls)).not.toContain(body.reason);
});
test.each(['', ' \t\n', '\u3000\u00a0\ufeff'])('FREQ-523-AC-02: 空白理由%jはREASON_REQUIREDの400', async (reason) => {
  const result = await call({ ...body, reason }); expect(result.response.status).toBe(400); expect(result.json).toEqual({ code: 'GROUP_G_SWAP_REASON_REQUIRED', error: '理由を入力してください。' }); expect(rpc).not.toHaveBeenCalled();
});
test('FREQ-523-AC-02: trim後200字は通り、不正pathはresource_id=null', async () => {
  rpc.mockResolvedValueOnce({ data: { ...saved, reason: 'あ'.repeat(200) }, error: null });
  expect((await call({ ...body, reason: ` ${'あ'.repeat(200)} ` })).response.status).toBe(200);
  rpc.mockClear(); mockAudit.mockClear(); expect((await call(body, 'invalid')).response.status).toBe(400); expect(rpc).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ resource_id: null, metadata: { code: 'GROUP_G_ARGUMENT_INVALID' } }));
});
test.each(Object.entries(ALLOCATION_SWAP_ERRORS))('FREQ-540-AC-13: %sのDB拒否は固定本文と結果コードだけを監査', async (code, [state, status, error]) => {
  rpc.mockResolvedValue({ data: null, error: { message: code, code: state, details: 'PRIVATE' } });
  const result = await call(); expect(result.response.status).toBe(status); expect(result.json).toEqual({ code, error });
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { code } }));
  expect(console.error).not.toHaveBeenCalled();
});
test('FREQ-540-AC-13: 未知の例外は固定500で生文も理由も監査/ログへ出さない', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  rpc.mockRejectedValue(new Error('PRIVATE'));
  const result = await call(); expect(result.response.status).toBe(500); expect(result.json).toEqual({ error: '割当の入替に失敗しました。' });
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', metadata: { code: 'ALLOCATION_SWAP_FAILED' } }));
  expect(log).toHaveBeenCalledWith('POST /api/admin/orders/[id]/allocations/swap error:', 'AllocationSwapError', null);
  expect(JSON.stringify([mockAudit.mock.calls, log.mock.calls])).not.toMatch(/PRIVATE|順番の調整/); log.mockRestore();
});
test.each(['55000', '40P01', '23514'])('FREQ-540-AC-13: 未知500はerror名とSQLSTATE %sだけをログへ出す', async (sqlstate) => {
  rpc.mockResolvedValue({ data: null, error: { code: sqlstate, message: 'PRIVATE', details: 'PRIVATE', hint: 'PRIVATE', name: 'PRIVATE' } });
  const result = await call();
  expect(result.response.status).toBe(500); expect(result.json).toEqual({ error: '割当の入替に失敗しました。' });
  expect(console.error).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith('POST /api/admin/orders/[id]/allocations/swap error:', 'AllocationSwapError', sqlstate);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', metadata: { code: 'ALLOCATION_SWAP_FAILED' } }));
  expect(JSON.stringify([jest.mocked(console.error).mock.calls, mockAudit.mock.calls, result.json])).not.toMatch(/PRIVATE|順番の調整/);
  expect(JSON.stringify([mockAudit.mock.calls, result.json])).not.toContain(sqlstate);
});
test('FREQ-540-AC-13: 結果の検査に失敗した500はSQLSTATEなしとしてログへ出す', async () => {
  rpc.mockResolvedValue({ data: { PRIVATE: body.reason }, error: null });
  expect((await call()).response.status).toBe(500);
  expect(console.error).toHaveBeenCalledWith('POST /api/admin/orders/[id]/allocations/swap error:', 'AllocationSwapError', null);
  expect(JSON.stringify([jest.mocked(console.error).mock.calls, mockAudit.mock.calls])).not.toMatch(/PRIVATE|順番の調整/);
});
