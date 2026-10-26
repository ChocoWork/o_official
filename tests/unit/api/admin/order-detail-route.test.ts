/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/orders/admin-orders/admin-order-store', () => ({ ...jest.requireActual('@/lib/orders/admin-orders/admin-order-store'), getAdminOrderDetailCore: jest.fn() }));
jest.mock('@/lib/orders/admin-orders/admin-order-summary', () => ({ buildAdminOrderSummary: jest.fn() }));
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({ listOrderFulfillments: jest.fn() }));
jest.mock('@/lib/orders/shipment-slips/shipment-slip-store', () => ({ ...jest.requireActual('@/lib/orders/shipment-slips/shipment-slip-store'), listAdminOrderShipmentSlips: jest.fn() }));
jest.mock('@/lib/orders/tracking/delivery-store', () => ({ ...jest.requireActual('@/lib/orders/tracking/delivery-store'), getOrderDeliveryDetail: jest.fn() }));
import { GET } from '@/app/api/admin/orders/[id]/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { AdminOrderError, getAdminOrderDetailCore } from '@/lib/orders/admin-orders/admin-order-store';
import { buildAdminOrderSummary } from '@/lib/orders/admin-orders/admin-order-summary';
import { listOrderFulfillments } from '@/lib/orders/fulfillment/fulfillment-store';
import { listAdminOrderShipmentSlips, ShipmentSlipError } from '@/lib/orders/shipment-slips/shipment-slip-store';
import { DeliveryStoreError, getOrderDeliveryDetail } from '@/lib/orders/tracking/delivery-store';
const id = '12345678-1234-4234-8234-123456789abc';
const core = { order: { id }, rows: [], amounts: {}, attention: {}, permissions: { read: true } };
const query = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn() }; const client = { from: jest.fn(() => query) };
const get = (value = id) => GET(new Request('https://example.test/'), { params: Promise.resolve({ id: value }) });
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => {}); (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: 'authorized-actor' }); (createServiceRoleClient as jest.Mock).mockResolvedValue(client); query.maybeSingle.mockResolvedValue({ data: { id }, error: null }); (getAdminOrderDetailCore as jest.Mock).mockResolvedValue(core); (buildAdminOrderSummary as jest.Mock).mockResolvedValue({ id, items: [{ readyUnshipped: 2 }] }); (listOrderFulfillments as jest.Mock).mockResolvedValue([{ fulfillmentId: id, number: 1, shippedAt: '2026-10-26T00:00:00Z', cancelledAt: null, shippingCarrier: 'yamato', trackingNumber: 'number', createdByEmail: 'PRIVATE' }]); (getOrderDeliveryDetail as jest.Mock).mockResolvedValue({ enabled: true, fulfillments: [{ fulfillmentId: id, deliveredAt: '2026-10-26T01:00:00Z' }] }); (listAdminOrderShipmentSlips as jest.Mock).mockResolvedValue(new Map([[id, { slipId: id, number: 'SL-1', stage: 'confirmed' }]])); });
afterEach(() => jest.restoreAllMocks());
test('FREQ-539-AC-01: core・旧summary・発送・票を返し、発送の内部欄は出さない', async () => {
  const r = await get(); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); expect(await r.json()).toEqual({ data: { ...core, summary: { id, items: [{ readyUnshipped: 2 }] }, fulfillments: [{ id, number: 1, shippedAt: '2026-10-26T00:00:00Z', deliveredAt: '2026-10-26T01:00:00Z', cancelledAt: null, carrier: 'yamato', trackingNumber: 'number', slipId: id, slipNumber: 'SL-1' }], slips: [{ slipId: id, number: 'SL-1', stage: 'confirmed' }] } }); expect(getAdminOrderDetailCore).toHaveBeenCalledWith(client, 'authorized-actor', id); expect(buildAdminOrderSummary).toHaveBeenCalledWith(client, { id });
});
test.each([401, 403])('FREQ-540-AC-13: 認可%dはid検証より先', async (status) => {
  (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: false, response: new Response('{}', { status }) }); const r = await get('invalid'); expect(r.status).toBe(status); expect(createServiceRoleClient).not.toHaveBeenCalled();
});
test('FREQ-539-AC-01: 不正idは400', async () => { const r = await get('invalid'); expect(r.status).toBe(400); expect(getAdminOrderDetailCore).not.toHaveBeenCalled(); });
test('FREQ-539-AC-01: 不在は404の固定本文', async () => { (getAdminOrderDetailCore as jest.Mock).mockRejectedValue(new AdminOrderError(404, 'GROUP_G_ORDER_NOT_FOUND')); const r = await get(); expect(r.status).toBe(404); expect(await r.json()).toEqual({ code: 'GROUP_G_ORDER_NOT_FOUND', error: '注文が見つかりません。' }); });
test.each([true, false])('FREQ-539-AC-04: 票だけの拒否/失敗でも詳細は200 %s', async (forbidden) => {
  (listAdminOrderShipmentSlips as jest.Mock).mockRejectedValue(forbidden ? new ShipmentSlipError(403, 'GROUP_G_FORBIDDEN') : new Error('PRIVATE')); const r = await get(); expect(r.status).toBe(200); const { data } = await r.json(); expect(data.slips).toBeNull(); expect(data.fulfillments[0]).toMatchObject({ slipId: null, slipNumber: null }); if (forbidden) expect(console.error).not.toHaveBeenCalled(); else expect(console.error).toHaveBeenCalledWith(expect.any(String), 'Error', null);
});

test.each([
  [new DeliveryStoreError('PRIVATE-MARKER', 'DELIVERY_READ_FAILED'), 'DeliveryStoreError', 'DELIVERY_READ_FAILED'],
  [new Error('PRIVATE-MARKER'), 'Error', null],
] as const)('FREQ-539-AC-04: 配送の補助読取が失敗しても配達日時だけnullで200', async (error, name, code) => {
  (getOrderDeliveryDetail as jest.Mock).mockRejectedValue(error);
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body.data).toMatchObject({ ...core, summary: { id }, fulfillments: [{ id, deliveredAt: null, slipId: id, slipNumber: 'SL-1' }] });
  expect(console.error).toHaveBeenCalledWith('[admin.orders.detail] Failed to load delivery detail', name, code);
  expect(JSON.stringify(body)).not.toContain('PRIVATE-MARKER');
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('PRIVATE-MARKER');
});

test('FREQ-539-AC-04: 発送IDから票を引き、同じ票の一覧は重複させず、票のない発送はnull', async () => {
  const second = '22345678-1234-4234-8234-123456789abc';
  const legacy = '32345678-1234-4234-8234-123456789abc';
  (listOrderFulfillments as jest.Mock).mockResolvedValue([second, legacy, id].map((fulfillmentId, index) => ({ fulfillmentId, number: index + 1, shippedAt: '2026-10-26T00:00:00Z', cancelledAt: null, shippingCarrier: null, trackingNumber: null })));
  const link = { slipId: id, number: 'SL-1', stage: 'confirmed' };
  (listAdminOrderShipmentSlips as jest.Mock).mockResolvedValue(new Map([[id, link], [second, link]]));
  const response = await get(); const { data } = await response.json();
  expect(response.status).toBe(200);
  expect(data.slips).toEqual([link]);
  expect(data.fulfillments.map((row: { id: string; slipId: string | null; slipNumber: string | null }) => [row.id, row.slipId, row.slipNumber])).toEqual([[second, id, 'SL-1'], [legacy, null, null], [id, id, 'SL-1']]);
  expect(listAdminOrderShipmentSlips).toHaveBeenCalledTimes(1);
  expect(listAdminOrderShipmentSlips).toHaveBeenCalledWith(client, 'authorized-actor', id);
});

test('FREQ-540-AC-13: DB側のGROUP_G_FORBIDDENは403の固定本文', async () => {
  (getAdminOrderDetailCore as jest.Mock).mockRejectedValue(new AdminOrderError(403, 'GROUP_G_FORBIDDEN'));
  const response = await get();
  expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ code: 'GROUP_G_FORBIDDEN', error: '注文を見る権限がありません。' });
  expect(console.error).not.toHaveBeenCalled();
});

test.each([new AdminOrderError(), new Error('PRIVATE-MARKER')])('FREQ-539-AC-01: 詳細coreの読取失敗は生の文を含まない500', async (error) => {
  (getAdminOrderDetailCore as jest.Mock).mockRejectedValue(error);
  const response = await get(); const body = await response.json();
  expect(response.status).toBe(500); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(body).toEqual({ error: '注文の情報を読み込めませんでした。' });
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('PRIVATE-MARKER');
});

test('FREQ-539-AC-01: 必須の発送一覧の読取失敗は固定500', async () => {
  (listOrderFulfillments as jest.Mock).mockRejectedValue(new Error('PRIVATE-MARKER'));
  const response = await get();
  expect(response.status).toBe(500); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error: '注文の情報を読み込めませんでした。' });
  expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('PRIVATE-MARKER');
});
