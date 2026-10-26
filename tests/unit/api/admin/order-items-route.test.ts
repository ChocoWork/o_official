/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/orders/returns/return-store', () => ({ countReturnAttention: jest.fn() }));
jest.mock('@/lib/orders/returns/cancel-request-reads', () => ({ countOrdersWithOpenCancelRequest: jest.fn() }));
import { GET } from '@/app/api/admin/order-items/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { countReturnAttention } from '@/lib/orders/returns/return-store';
import { countOrdersWithOpenCancelRequest } from '@/lib/orders/returns/cancel-request-reads';
const rpc = jest.fn(); const auth = authorizeAdminPermission as jest.Mock;
beforeEach(() => { jest.resetAllMocks(); auth.mockResolvedValue({ ok: true, userId: 'authorized-actor' }); (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc }); (countReturnAttention as jest.Mock).mockResolvedValue({ requested: 2, refundWaiting: 3 }); (countOrdersWithOpenCancelRequest as jest.Mock).mockResolvedValue(4); rpc.mockResolvedValue({ data: { rows: [], totalRows: 0, totalOrders: 0, ordersCapped: true, ordersCap: 5000 }, error: null }); });
test('FREQ-536-AC-03: 上限で切った空行も200、件数とno-store', async () => {
  const req = new Request('https://example.test/api/admin/order-items?page=2'); const r = await GET(req);
  expect(auth).toHaveBeenCalledWith('admin.orders.read', req);
  expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.json()).toEqual({ data: { rows: [], totalRows: 0, totalOrders: 0, ordersCapped: true, ordersCap: 5000, page: 2, pageSize: 20, totalPages: 1 }, returnAttention: { requested: 2, refundWaiting: 3 }, cancelRequestAttention: 4 });
  expect(rpc).toHaveBeenCalledWith('list_admin_order_item_rows', { _filters: {}, _limit: 20, _offset: 20, _actor_id: 'authorized-actor' });
});
test.each([401, 403])('FREQ-540-AC-13: 認可%dは検証や読取より先', async (status) => {
  auth.mockResolvedValue({ ok: false, response: new Response('{"error":"Forbidden"}', { status }) });
  const r = await GET(new Request('https://example.test/api/admin/order-items?counterparty=invalid'));
  expect(r.status).toBe(status); expect(r.headers.get('cache-control')).toBe('no-store'); expect(createServiceRoleClient).not.toHaveBeenCalled();
});
test('FREQ-536-AC-02: 不正条件は400、storeを呼ばない', async () => {
  const r = await GET(new Request('https://example.test/api/admin/order-items?page=0'));
  expect(r.status).toBe(400); expect(await r.json()).toEqual({ error: 'Invalid query' }); expect(rpc).not.toHaveBeenCalled();
});
test.each([['GROUP_G_FORBIDDEN', '42501', 403, '注文を見る権限がありません。'], ['GROUP_G_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。']] as const)('FREQ-540-AC-13: storeの断り%s', async (code, sqlstate, status, error) => {
  rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate } });
  const r = await GET(new Request('https://example.test/api/admin/order-items'));
  expect(r.status).toBe(status); expect(await r.json()).toEqual({ code, error }); expect(r.headers.get('cache-control')).toBe('no-store');
});
