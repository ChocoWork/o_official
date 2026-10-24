/** @jest-environment node */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ADMIN_ITEM_STATUS_LABELS, type AdminItemStatus } from '@/lib/orders/item-state/item-state-types';
import { listAdminOrderItemStates } from '@/lib/orders/item-state/item-state-store';
import { ORDER_PROGRESS_LABELS } from '@/lib/orders/order-progress';

jest.mock('server-only', () => ({}), { virtual: true });

const ORDER = '10000000-0000-4000-8000-000000000001';
const ITEM = '20000000-0000-4000-8000-000000000001';
const LABELS: Record<AdminItemStatus, string> = {
  unpaid: '未払い', payment_expired: '支払い期限切れ', in_production: '受注生産中', ready: '発送準備中',
  shipped: '発送済み', delivered: '配達済み', cancel_requested: 'キャンセル申請中', cancelled: 'キャンセル済み',
  return_requested: '返品申請中', return_in_progress: '返品受付中', refund_waiting: '返金待ち', returned: '返品済み',
};
const row = { order_id: ORDER, order_item_id: ITEM, status: 'ready', quantity: 2, blocked_reasons: [] };
const rpc = jest.fn();
const client = { rpc } as unknown as SupabaseClient;

beforeEach(() => { rpc.mockReset(); });

test('管理の12コードと日本語全文、客語の配送中を維持する', () => {
  expect(ADMIN_ITEM_STATUS_LABELS).toEqual(LABELS);
  expect(ADMIN_ITEM_STATUS_LABELS.shipped).toBe('発送済み');
  expect(ORDER_PROGRESS_LABELS.in_transit).toBe('配送中');
});

test.each(Object.keys(LABELS))('RPCから %s をcamelCaseに変換する', async (status) => {
  rpc.mockResolvedValue({ data: [{ ...row, status, blocked_reasons: ['variant_missing', 'payment_review',
    'exchange_fee_waiting', 'cancel_requested', 'refund_processing', 'stock_shortage'] }], error: null });
  expect(await listAdminOrderItemStates(client, [ORDER])).toEqual([{ orderId: ORDER, orderItemId: ITEM,
    status, quantity: 2, blockedReasons: ['variant_missing', 'payment_review', 'exchange_fee_waiting',
      'cancel_requested', 'refund_processing', 'stock_shortage'] }]);
  expect(rpc).toHaveBeenCalledWith('list_admin_order_item_states', { _order_ids: [ORDER] });
});

test('空配列はRPCなしで空、空の結果も空', async () => {
  expect(await listAdminOrderItemStates(client, [])).toEqual([]);
  expect(rpc).not.toHaveBeenCalled();
  rpc.mockResolvedValue({ data: [], error: null });
  expect(await listAdminOrderItemStates(client, [ORDER])).toEqual([]);
});

test.each([
  { status: 'unknown' }, { status: 'toString' }, { quantity: -1 }, { quantity: 0 }, { quantity: 1.5 },
  { quantity: '2' }, { quantity: NaN }, { quantity: Infinity }, { quantity: 2147483648 },
  { blocked_reasons: ['unknown'] }, { blocked_reasons: null }, { order_id: null }, { order_item_id: '' },
])('不正な返却値 %j は固定内部失敗', async (patch) => {
  rpc.mockResolvedValue({ data: [{ ...row, ...patch }], error: null });
  await expect(listAdminOrderItemStates(client, [ORDER])).rejects.toThrow('ITEM_STATE_READ_FAILED');
});

test.each([null, {}, [null]])('不正な結果構造 %j を拒否する', async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(listAdminOrderItemStates(client, [ORDER])).rejects.toThrow('ITEM_STATE_READ_FAILED');
});

test.each(['response', 'throw'])('DBの本文・detail・causeを外へ出さない: %s', async (mode) => {
  const secret = { message: 'private-sql-text', details: 'private-detail', code: 'XX001' };
  if (mode === 'throw') rpc.mockRejectedValue(secret);
  else rpc.mockResolvedValue({ data: null, error: secret });
  let failure: unknown;
  try { await listAdminOrderItemStates(client, [ORDER]); } catch (caught) { failure = caught; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('ITEM_STATE_READ_FAILED');
  expect(Object.keys(failure as object)).toEqual([]);
  expect((failure as Error).cause).toBeUndefined();
});
