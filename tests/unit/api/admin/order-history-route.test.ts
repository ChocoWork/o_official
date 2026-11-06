/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
jest.mock('next/server', () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init) } }));
jest.mock('@/lib/auth/admin-rbac', () => ({ authorizeAdminPermission: jest.fn() }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));
jest.mock('@/lib/orders/admin-orders/admin-order-store', () => ({ ...jest.requireActual('@/lib/orders/admin-orders/admin-order-store'), listAdminOrderItemStateHistory: jest.fn() }));
jest.mock('@/lib/orders/email/order-email-store', () => ({ OrderEmailStoreError: class extends Error {}, listOrderStatusHistory: jest.fn(async () => []), listOrderEmailHistory: jest.fn(async () => []), getOrderEmailSendState: jest.fn(async () => ({ paused: false })) }));
jest.mock('@/lib/orders/fulfillment/fulfillment-store', () => ({ FulfillmentStoreError: class extends Error {}, listOrderFulfillments: jest.fn(async () => []), listOrderLineFulfillment: jest.fn(async () => new Map()) }));
jest.mock('@/lib/orders/refund/refund-store', () => ({ RefundStoreError: class extends Error {}, listOrderRefunds: jest.fn(async () => []) }));
jest.mock('@/lib/orders/returns/return-store', () => ({ listOrderReturns: jest.fn(async () => []) }));
jest.mock('@/lib/orders/returns/cancel-request-store', () => ({ listOrderCancelRequests: jest.fn(async () => []) }));
jest.mock('@/lib/orders/shipment-slips/shipment-slip-store', () => ({ ShipmentSlipError: class extends Error {}, listAdminOrderShipmentSlips: jest.fn(async () => new Map()) }));
jest.mock('@/lib/orders/tracking/delivery-store', () => ({ DeliveryStoreError: class extends Error {}, getOrderDeliveryDetail: jest.fn(async () => ({ enabled: false, fulfillments: [] })) }));
import { GET } from '@/app/api/admin/orders/[id]/history/route';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { listAdminOrderItemStateHistory } from '@/lib/orders/admin-orders/admin-order-store';
import { listOrderReturns } from '@/lib/orders/returns/return-store';
import { returnDetail } from '../../lib/orders/returns/order-return-detail-fixture';
const id = '12345678-1234-4234-8234-123456789abc'; const entry = { id, reasonLabel: '入金の確認' };
const getUserById = jest.fn();
const client = { from: jest.fn(), auth: { admin: { getUserById } } }; const stateHistory = listAdminOrderItemStateHistory as jest.Mock;
beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); (authorizeAdminPermission as jest.Mock).mockResolvedValue({ ok: true, userId: 'authorized-actor' }); (createServiceRoleClient as jest.Mock).mockResolvedValue(client); client.from.mockImplementation((table: string) => ({ select: () => table === 'orders' ? { eq: () => ({ maybeSingle: async () => ({ data: { id, status: 'paid', shipping_email: null, created_at: '2026-10-26T00:00:00Z' }, error: null }) }) } : { eq: async () => ({ data: [], error: null }) } })); stateHistory.mockResolvedValue({ entries: [entry], truncated: true }); });
afterEach(() => jest.restoreAllMocks());
const get = () => GET(new Request('https://example.test/'), { params: Promise.resolve({ id }) });
test('FREQ-539-AC-04: 状態履歴を足し既存の履歴を維持する', async () => {
  const r = await get(); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); const body = await r.json(); expect(body).toMatchObject({ itemStates: [entry], itemStatesTruncated: true, order: { id, orderNumber: 'ORD-12345678' }, entries: [{ type: 'created', at: '2026-10-26T00:00:00Z' }] }); expect(stateHistory).toHaveBeenCalledWith(client, 'authorized-actor', id, expect.any(Function));
});
test('FREQ-541-AC-05: 品物履歴の失敗でも既存応答を保ち、生の失敗を出さない', async () => {
  const previous = await (await get()).json(); stateHistory.mockRejectedValue(new Error('PRIVATE')); const r = await get(); const body = await r.json(); expect(r.status).toBe(200); expect(body).toEqual({ ...previous, itemStates: [], itemStatesTruncated: false, itemStatesFailed: true }); expect(console.warn).toHaveBeenCalledWith(expect.any(String), 'Error', null); expect(console.error).not.toHaveBeenCalled(); expect(JSON.stringify(body)).not.toContain('PRIVATE');
});

test('FREQ-539-AC-04: 返品の記録と品物の状態履歴が同じ人のメールcacheを共有する', async () => {
  const actorId = '22345678-1234-4234-8234-123456789abc';
  const actorEmail = 'actor@example.invalid';
  getUserById.mockResolvedValue({ data: { user: { email: actorEmail } }, error: null });
  (listOrderReturns as jest.Mock).mockResolvedValue([returnDetail({ status: 'cancelled', cancelledAt: '2026-10-26T03:00:00Z' })]);
  client.from.mockImplementation((table: string) => ({ select: () => table === 'orders'
    ? { eq: () => ({ maybeSingle: async () => ({ data: { id, status: 'paid', shipping_email: null, created_at: '2026-10-26T00:00:00Z' }, error: null }) }) }
    : table === 'order_returns'
      ? { in: async () => ({ data: [{ id: 'ret-1', cancelled_by: actorId, fee_received_by: actorId, exchange_released_by: null, declined_by: null, fee_waived: false, fee_settled_amount: 0 }], error: null }) }
      : { eq: async () => ({ data: [], error: null }) } }));
  stateHistory.mockImplementation(async (_client: unknown, _actor: string, _order: string, emailForActor: (actor: string) => Promise<string | null>) => {
    const emails = await Promise.all([emailForActor(actorId), emailForActor(actorId)]);
    return { entries: emails.map((email) => ({ ...entry, actorEmail: email })), truncated: false };
  });
  const response = await get(); const body = await response.json();
  expect(response.status).toBe(200);
  expect(getUserById).toHaveBeenCalledTimes(1); expect(getUserById).toHaveBeenCalledWith(actorId);
  expect(body.itemStates).toEqual([{ ...entry, actorEmail }, { ...entry, actorEmail }]);
  expect(body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'return', actorEmail })]));
  expect(console.warn).not.toHaveBeenCalled(); expect(console.error).not.toHaveBeenCalled();
});

test('DD-ADMIN-020 受け取り履歴は1行で選びの点数を添える（窓口は明細の解決と返金の選びを読んで渡す）', async () => {
  const receiptLineSelects: string[] = [];
  (listOrderReturns as jest.Mock).mockResolvedValue([returnDetail({
    receipts: [{ id: 'rc-1', kind: 'receive', refundChoice: 'mixed', createdAt: '2026-10-26T02:00:00Z', actorEmail: 'admin@example.com' }],
  })]);
  client.from.mockImplementation((table: string) => ({ select: (columns: string) => table === 'orders'
    ? { eq: () => ({ maybeSingle: async () => ({ data: { id, status: 'paid', shipping_email: null, created_at: '2026-10-26T00:00:00Z' }, error: null }) }) }
    : table === 'order_return_receipt_lines'
      ? (receiptLineSelects.push(columns), { in: async () => ({ data: [
        { receipt_id: 'rc-1', disposition: 'restocked', quantity: 1, resolution: 'refund', refund_choice: 'now' },
        { receipt_id: 'rc-1', disposition: 'not_restocked', quantity: 1, resolution: 'refund', refund_choice: 'consult' },
      ], error: null }) })
      : { eq: async () => ({ data: [], error: null }), in: async () => ({ data: [], error: null }) } }));

  const response = await get(); const body = await response.json();

  expect(response.status).toBe(200);
  expect(receiptLineSelects).toEqual(['receipt_id, disposition, quantity, resolution, refund_choice']);
  const receives = body.entries.filter((entry: { kind?: string }) => entry.kind === 'receive');
  expect(receives).toHaveLength(1);
  expect(receives[0].details).toEqual(['在庫に戻す 1点', '戻さない 1点', '今すぐ返金 1点・相談 1点']);
});
