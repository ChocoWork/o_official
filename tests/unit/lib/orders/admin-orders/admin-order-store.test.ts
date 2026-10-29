/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import { AdminOrderError, listAdminOrderItemRows, exportAdminOrderItemRows, getAdminOrderDetailCore, listAdminOrderItemStateHistory } from '@/lib/orders/admin-orders/admin-order-store';
import { ADMIN_ORDER_ERRORS } from '@/lib/orders/admin-orders/admin-order-types';
const rpc = jest.fn(); const getUserById = jest.fn();
const client = { rpc, auth: { admin: { getUserById } } } as unknown as SupabaseClient;
const id = '12345678-1234-4234-8234-123456789abc';
const row = { orderId: id, orderCreatedAt: '2026-10-26T00:00:00Z', customerName: null, customerEmail: null, orderItemId: id, itemName: '品物', color: null, size: null, isExchange: false, status: 'ready', quantity: 1, unitPrice: 100, lineAmount: 100, refundAmount: 0, blockedReasons: [], needsAttention: false };
beforeEach(() => { jest.resetAllMocks(); });
test('FREQ-540-AC-13: list/exportのRPC名・引数・jsonbと注文番号', async () => {
  rpc.mockResolvedValueOnce({ data: { rows: [row], totalRows: 21, totalOrders: 2, ordersCapped: true, ordersCap: 5000 }, error: null });
  expect(await listAdminOrderItemRows(client, 'actor', { statuses: ['ready'] }, 2)).toMatchObject({ rows: [{ ...row, orderNumber: 'ORD-12345678' }], page: 2, pageSize: 20, totalPages: 2, ordersCapped: true, ordersCap: 5000 });
  expect(rpc).toHaveBeenLastCalledWith('list_admin_order_item_rows', { _filters: { statuses: ['ready'] }, _limit: 20, _offset: 20, _actor_id: 'actor' });
  rpc.mockResolvedValueOnce({ data: { rows: [row], rowCount: 1, orderCount: 1 }, error: null });
  expect(await exportAdminOrderItemRows(client, 'actor', {})).toMatchObject({ rowCount: 1, orderCount: 1, rows: [expect.objectContaining({ orderId: id })] });
  expect(rpc).toHaveBeenLastCalledWith('export_admin_order_item_rows', { _filters: {}, _actor_id: 'actor' });
});
test.each(Object.entries(ADMIN_ORDER_ERRORS))('FREQ-540-AC-13: message/code完全一致 %s', async (code, [sqlstate, status, message]) => {
  rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate, details: 'PRIVATE' } });
  await expect(getAdminOrderDetailCore(client, 'actor', id)).rejects.toMatchObject({ name: 'AdminOrderError', code, status, message });
  expect(rpc).toHaveBeenCalledWith('get_admin_order_detail', { _order_id: id, _actor_id: 'actor' });
});
test.each([{ message: 'GROUP_G_FORBIDDEN', code: '22023' }, { message: 'GROUP_G_FORBIDDEN extra', code: '42501' }, { message: 'toString', code: '42501' }, { code: '42501' }, { message: 'PRIVATE', code: 'XX000' }])('FREQ-540-AC-13: 未知・片方の一致は安全な500 %j', async (error) => {
  rpc.mockResolvedValue({ data: null, error });
  const failure = await getAdminOrderDetailCore(client, 'actor', id).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(AdminOrderError);
  expect(failure).toMatchObject({ status: 500, message: '注文の情報を読み込めませんでした。' });
  expect(JSON.stringify(failure)).not.toContain('PRIVATE'); expect(failure).not.toHaveProperty('cause');
});
test.each([{ quantity: 0 }, { quantity: 1.5 }, { lineAmount: 0.1 }, { unitPrice: '100' }, { status: 'unknown' }, { blockedReasons: ['unknown'] }])('FREQ-540-AC-13: 不正な行を500 %j', async (patch) => {
  rpc.mockResolvedValue({ data: { rows: [{ ...row, ...patch }], totalRows: 1, totalOrders: 1, ordersCapped: false, ordersCap: 5000 }, error: null });
  await expect(listAdminOrderItemRows(client, 'actor', {}, 1)).rejects.toMatchObject({ status: 500 });
});
test('FREQ-536-AC-03: 空行のcapを写し、不正なcapは500', async () => {
  const data = { rows: [], totalRows: 0, totalOrders: 0, ordersCapped: true, ordersCap: 5000 };
  rpc.mockResolvedValue({ data, error: null });
  expect(await listAdminOrderItemRows(client, 'actor', {}, 1)).toMatchObject(data);
  for (const patch of [{ ordersCapped: 1 }, { ordersCap: 0 }]) {
    rpc.mockResolvedValue({ data: { ...data, ...patch }, error: null });
    await expect(listAdminOrderItemRows(client, 'actor', {}, 1)).rejects.toMatchObject({ status: 500 });
  }
});
test('FREQ-538-AC-02: CSVは1回のjsonbで全行と件数が一致しない限り500', async () => {
  rpc.mockResolvedValue({ data: { rowCount: 2, orderCount: 1, rows: [row] }, error: null });
  await expect(exportAdminOrderItemRows(client, 'actor', {})).rejects.toMatchObject({ status: 500 });
  rpc.mockRejectedValue(new Error('PRIVATE'));
  await expect(exportAdminOrderItemRows(client, 'actor', {})).rejects.toMatchObject({ status: 500, message: '注文の情報を読み込めませんでした。' });
});
test('FREQ-539-AC-04: 301行目で切り、同じ人のメールは1回だけ引く', async () => {
  const history = { id, created_at: '2026-10-26T00:00:00Z', order_item_id: id, item_name: '品物', color: null, size: null, is_exchange: false, quantity: 1, from_status: null, to_status: 'unpaid', reason: 'stripe_payment_awaiting', actor_id: id, operation: 'stripe_payment_awaiting', ref_kind: null, ref_id: null, ref_label: null, note: null, counterpart_order_id: null };
  rpc.mockResolvedValue({ data: Array.from({ length: 301 }, () => history), error: null });
  getUserById.mockResolvedValue({ data: { user: { email: 'actor@example.invalid' } }, error: null });
  const result = await listAdminOrderItemStateHistory(client, 'actor', id);
  expect(result.truncated).toBe(true); expect(result.entries).toHaveLength(300);
  expect(result.entries[0].actorEmail).toBe('actor@example.invalid'); expect(getUserById).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('list_admin_order_item_state_history', { _order_id: id, _actor_id: 'actor' });
});

function detailCore() {
  return {
    order: { id, status: 'paid', createdAt: row.orderCreatedAt, paidAt: null, customerKind: 'guest', customerName: null, customerEmail: null, currency: 'jpy', shipTo: { fullName: null, postalCode: null, prefecture: null, city: null, address: null, building: null, phone: null } },
    amounts: { productNet: 100, discount: 0, shipping: 10, total: 110, paidAmount: 110, refundedAmount: 0, refundAttachedToRows: 0, refundNotAttached: -10, refundProcessingAmount: 0 },
    rows: [{ orderItemId: id, itemName: '品物', color: null, size: null, isExchange: false, status: 'ready', statusRank: 4, quantity: 1, unitPrice: 100, lineAmount: 100, refundAmount: 0, blockedReasons: [] }],
    attention: { paymentExceptions: [], review: null, deliveries: [] }, permissions: { read: true, manage: false, refund: false, return: true, allocate: false, shippingRead: false },
  };
}
test('FREQ-537-AC-05: 詳細の内訳・負の調整額・12状態・権限をそのまま保持し余分な欄を出さない', async () => {
  const data = detailCore(); rpc.mockResolvedValue({ data: { ...data, privateValue: 'PRIVATE' }, error: null });
  expect(await getAdminOrderDetailCore(client, 'actor', id)).toEqual(data);
});
test('FREQ-549-AC-04: 詳細の割引の要対応は2 kindだけを1件まで通し、余分な欄と未知の kind は500にする', async () => {
  const discount = { orderId: id, kind: 'discount_limit_exceeded', openedAt: '2026-10-29T01:02:03.456+00:00' };
  const data = detailCore(); Object.assign(data.attention, { discounts: [discount] });
  rpc.mockResolvedValue({ data, error: null });
  expect((await getAdminOrderDetailCore(client, 'actor', id)).attention.discounts).toEqual([discount]);
  for (const bad of [{ ...discount, kind: 'discount_other' }, { ...discount, extra: 1 }]) {
    rpc.mockResolvedValue({ data: { ...data, attention: { ...data.attention, discounts: [bad] } }, error: null });
    await expect(getAdminOrderDetailCore(client, 'actor', id)).rejects.toBeDefined();
  }
});
test.each(['quantity', 'lineAmount', 'status', 'statusRank', 'permission', 'amount', 'order', 'shipTo', 'attention'])('FREQ-540-AC-13: 詳細の不正な欄%sを500にする', async (field) => {
  const data = detailCore();
  if (field === 'quantity') data.rows[0].quantity = 0;
  if (field === 'lineAmount') data.rows[0].lineAmount = 1.5;
  if (field === 'status') data.rows[0].status = 'unknown';
  if (field === 'statusRank') data.rows[0].statusRank = 12;
  if (field === 'permission') Object.assign(data.permissions, { read: 'yes' });
  if (field === 'amount') data.amounts.productNet = 1.5;
  if (field === 'order') data.order.status = 'unknown';
  if (field === 'shipTo') Object.assign(data.order, { shipTo: {} });
  if (field === 'attention') Object.assign(data.attention, { paymentExceptions: [{}] });
  rpc.mockResolvedValue({ data, error: null }); await expect(getAdminOrderDetailCore(client, 'actor', id)).rejects.toMatchObject({ status: 500, message: '注文の情報を読み込めませんでした。' });
});
test.each([null, {}, [{ quantity: -1 }], Array.from({ length: 302 }, () => ({}))])('FREQ-540-AC-13: 履歴の不正な形は安全な500', async (data) => {
  rpc.mockResolvedValue({ data, error: null }); await expect(listAdminOrderItemStateHistory(client, 'actor', id)).rejects.toMatchObject({ status: 500 });
});
test('FREQ-539-AC-04: 空の履歴は切り捨てなし、人の解決を呼ばない', async () => {
  rpc.mockResolvedValue({ data: [], error: null }); expect(await listAdminOrderItemStateHistory(client, 'actor', id)).toEqual({ entries: [], truncated: false }); expect(getUserById).not.toHaveBeenCalled();
});
