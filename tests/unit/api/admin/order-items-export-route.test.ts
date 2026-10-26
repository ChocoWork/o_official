/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/audit', () => ({ logAudit: jest.fn() }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: jest.fn() }));
import { GET } from '@/app/api/admin/order-items/export/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
const rpc = jest.fn(); const auth = authorizeAdminPermission as jest.Mock; const rate = enforceRateLimit as jest.Mock;
beforeEach(() => { jest.resetAllMocks(); auth.mockResolvedValue({ ok: true, userId: 'authorized-actor' }); rate.mockResolvedValue(null); (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc }); rpc.mockResolvedValue({ data: { rows: [], rowCount: 0, orderCount: 0 }, error: null }); });
test('FREQ-538-AC-05: 認可→IP→actor→全件store→CSV→監査、値を監査しない', async () => {
  const req = new Request('https://example.test/api/admin/order-items/export?customer=PRIVATE-VALUE&status=ready'); const r = await GET(req);
  expect(auth).toHaveBeenCalledWith('admin.orders.read', req);
  expect(rate.mock.calls).toEqual([[{ request: req, endpoint: 'admin.orders.export', limit: 20, windowSeconds: 600 }], [{ request: req, endpoint: 'admin.orders.export', limit: 20, windowSeconds: 600, subject: 'authorized-actor' }]]);
  expect(auth.mock.invocationCallOrder[0]).toBeLessThan(rate.mock.invocationCallOrder[0]); expect(rate.mock.invocationCallOrder[1]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  expect(rpc).toHaveBeenCalledWith('export_admin_order_item_rows', { _filters: { customer: 'PRIVATE-VALUE', statuses: ['ready'] }, _actor_id: 'authorized-actor' });
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8'); expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="order-items_\d{4}-\d{2}-\d{2}\.csv"$/); expect(r.headers.get('cache-control')).toBe('no-store');
  const bytes = new Uint8Array(await r.arrayBuffer()); expect(Array.from(bytes.slice(0, 3))).toEqual([239, 187, 191]);
  expect(logAudit).toHaveBeenCalledWith({ action: 'admin.orders.export', actor_id: 'authorized-actor', resource: 'orders', resource_id: null, outcome: 'success', metadata: { row_count: 0, order_count: 0, filter_keys: ['customer', 'statuses'] } });
  expect(JSON.stringify((logAudit as jest.Mock).mock.calls)).not.toContain('PRIVATE-VALUE');
});
test.each([401, 403])('FREQ-538-AC-05: 認可%dが先', async (status) => {
  auth.mockResolvedValue({ ok: false, response: new Response('{}', { status }) }); expect((await GET(new Request('https://example.test/?page=0'))).status).toBe(status); expect(rate).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
});
test.each([0, 1])('FREQ-538-AC-05: IP/actorの制限%dで429', async (index) => {
  if (index) rate.mockResolvedValueOnce(null); rate.mockResolvedValueOnce(new Response('{}', { status: 429 }));
  const r = await GET(new Request('https://example.test/?page=0')); expect(r.status).toBe(429); expect(r.headers.get('cache-control')).toBe('no-store'); expect(rpc).not.toHaveBeenCalled();
});
test.each(['page=1', 'page=0', 'unknown=x'])('FREQ-538-AC-02: CSVはpageを受けず400 %s', async (query) => {
  const r = await GET(new Request(`https://example.test/?${query}`)); expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'Invalid query' }); expect(rpc).not.toHaveBeenCalled(); expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { code: 'INVALID_QUERY' } }));
});
test.each([['GROUP_G_EXPORT_TOO_LARGE', '22023', 422], ['GROUP_G_FORBIDDEN', '42501', 403], ['GROUP_G_ARGUMENT_INVALID', '22023', 400]] as const)('FREQ-538-AC-05: DBの断り%s', async (code, sqlstate, status) => {
  rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate, details: 'PRIVATE' } }); const r = await GET(new Request('https://example.test/')); expect(r.status).toBe(status); expect(await r.json()).toMatchObject({ code }); expect(r.headers.get('cache-control')).toBe('no-store'); expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', metadata: { code } }));
});
test('FREQ-538-AC-05: 未知のDB失敗は値を出さず500とerror監査', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'PRIVATE', code: 'XX000', details: 'PRIVATE' } });
  const r = await GET(new Request('https://example.test/?email=PRIVATE-VALUE')); expect(r.status).toBe(500); expect(await r.json()).toEqual({ error: '注文の情報を読み込めませんでした。' }); expect(r.headers.get('cache-control')).toBe('no-store'); expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', metadata: { code: 'ADMIN_ORDER_EXPORT_FAILED' } })); expect(JSON.stringify((logAudit as jest.Mock).mock.calls)).not.toContain('PRIVATE-VALUE');
});
