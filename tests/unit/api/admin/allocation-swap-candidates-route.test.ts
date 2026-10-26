/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermissions: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
const mockCsrf = jest.fn(); const mockRate = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...args: unknown[]) => mockCsrf(...args) }));
jest.mock('@/features/auth/middleware/rateLimit', () => ({ enforceRateLimit: (...args: unknown[]) => mockRate(...args) }));
import { GET } from '@/app/api/admin/orders/[id]/allocations/swap-candidates/route';
import { authorizeAdminPermissions } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ALLOCATION_SWAP_ERRORS } from '@/lib/inventory/allocation-swap-types';
const id = '11111111-1111-4111-8111-111111111111'; const item = '33333333-3333-4333-8333-333333333333';
const donor = '22222222-2222-4222-8222-222222222222'; const donorItem = '44444444-4444-4444-8444-444444444444';
const rpc = jest.fn(); const auth = authorizeAdminPermissions as jest.Mock;
async function call(query = `orderItemId=${item}`, orderId = id) {
  const request = new Request(`https://example.test/api/admin/orders/swap-candidates?${query}`);
  const response = await GET(request, { params: Promise.resolve({ id: orderId }) });
  expect(response.headers.get('cache-control')).toBe('no-store'); return { response, json: await response.json(), request };
}
beforeEach(() => { jest.resetAllMocks(); auth.mockResolvedValue({ ok: true, userId: 'actor', role: 'admin' }); (createServiceRoleClient as jest.Mock).mockResolvedValue({ rpc }); rpc.mockResolvedValue({ data: [], error: null }); });
test('FREQ-523-AC-05: 2権限→検証→実store、候補をcamelCaseで200', async () => {
  rpc.mockResolvedValue({ data: [{ donor_order_id: donor, donor_order_item_id: donorItem, order_created_at: '2026-10-26T00:00:00Z', swappable_quantity: 3, taker_quantity: 2 }], error: null });
  const result = await call(); expect(result.response.status).toBe(200);
  expect(result.json).toEqual({ data: [{ donorOrderId: donor, donorOrderItemId: donorItem, orderCreatedAt: '2026-10-26T00:00:00Z', swappableQuantity: 3, takerQuantity: 2 }] });
  expect(auth).toHaveBeenCalledWith(['admin.orders.allocate', 'admin.orders.read'], result.request);
  expect(rpc).toHaveBeenCalledWith('list_admin_allocation_swap_candidates', { _order_id: id, _taker_order_item_id: item, _actor_id: 'actor' });
});
test.each(['admin.orders.allocate', 'admin.orders.read'])('FREQ-540-AC-13: %s不足は検証前に403', async (permission) => {
  auth.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'Forbidden', permission, role: 'supporter' }), { status: 403 }) });
  const result = await call('', 'bad'); expect(result.response.status).toBe(403); expect(result.json).toEqual({ error: '割り当てを入れ替える権限がありません。', permission, role: 'supporter' }); expect(rpc).not.toHaveBeenCalled();
});
test('FREQ-540-AC-13: 候補GETはCSRFとIP/actor回数制限を呼ばず200を返す', async () => {
  mockCsrf.mockResolvedValue(new Response('{}', { status: 403 }));
  mockRate.mockResolvedValue(new Response('{}', { status: 429 }));
  const result = await call();
  expect(result.response.status).toBe(200); expect(result.json).toEqual({ data: [] });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(mockCsrf).not.toHaveBeenCalled(); expect(mockRate).not.toHaveBeenCalled();
});
test.each(['', 'orderItemId=bad', `orderItemId=${item}&orderItemId=${item}`, `orderItemId=${item}&actorId=forged`])('FREQ-523-AC-05: 不正query%sを400で断る', async (query) => { expect((await call(query)).response.status).toBe(400); expect(rpc).not.toHaveBeenCalled(); });
test('FREQ-523-AC-05: 不正pathは400', async () => { expect((await call(`orderItemId=${item}`, 'bad')).response.status).toBe(400); expect(rpc).not.toHaveBeenCalled(); });
test.each(['GROUP_G_FORBIDDEN', 'GROUP_G_SWAP_ITEM_NOT_FOUND', 'GROUP_G_SWAP_ORDER_NOT_PAID'])('FREQ-523-AC-05: candidatesの%sを分類する', async (code) => {
  const [state, status, error] = ALLOCATION_SWAP_ERRORS[code]; rpc.mockResolvedValue({ data: null, error: { message: code, code: state } });
  const result = await call(); expect(result.response.status).toBe(status); expect(result.json).toEqual({ code, error });
});
