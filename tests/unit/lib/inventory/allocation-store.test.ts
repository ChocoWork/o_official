/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordStockMovement, listItemAllocationHistory, listGroupGVariantInventory } from '@/lib/inventory/allocation-store';

const rpc = jest.fn();
const client = { rpc } as unknown as SupabaseClient;
const input = { itemId: 7, variantId: 11, delta: -2, reason: 'adjustment' as const,
  note: '棚卸', requestKey: '11111111-1111-4111-8111-111111111111', expectedReleaseQuantity: 1 };
const success = { movementId: '9007199254740993', releasedQuantity: 1, allocatedQuantity: 0, replayed: false };
beforeEach(() => rpc.mockReset());

test('writes once through the RPC, preserving bigint strings and the authorized actor', async () => {
  rpc.mockResolvedValue({ data: success, error: null });
  await expect(recordStockMovement(client, 'actor', input)).resolves.toEqual(success);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('admin_record_stock_movement', { _item_id: 7, _variant_id: 11, _delta: -2,
    _reason: 'adjustment', _note: '棚卸', _actor_id: 'actor', _request_key: input.requestKey, _expected_release_quantity: 1 });
});

test.each([
  ['GROUP_G_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
  ['GROUP_G_FORBIDDEN', '42501', 403, '在庫を変更する権限がありません。'],
  ['GROUP_G_STOCK_INSUFFICIENT', '23514', 409, '在庫が足りないため、この数量は引けません。'],
  ['GROUP_G_STOCK_RELEASE_REASON_REQUIRED', '22023', 400, '割り当てを外す理由を入力してください。'],
  ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる在庫操作は実行できません。'],
])('classifies only the exact %s / %s pair', async (message, code, status, text) => {
  rpc.mockResolvedValue({ error: { message, code, details: 'PRIVATE-MARKER' } });
  await expect(recordStockMovement(client, 'actor', input)).rejects.toMatchObject({ code: message, status, message: text });
  rpc.mockResolvedValue({ error: { message, code: 'OTHER', details: 'PRIVATE-MARKER' } });
  await expect(recordStockMovement(client, 'actor', input)).rejects.toMatchObject({ message: '在庫の記録に失敗しました', status: 500 });
});

test('confirmation accepts only the generated exact detail shape and a nonnegative integer', async () => {
  rpc.mockResolvedValue({ error: { message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code: '55000', details: '{"releasedQuantity":2}' } });
  await expect(recordStockMovement(client, 'actor', input)).rejects.toMatchObject({ status: 409,
    code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', releasedQuantity: 2,
    message: '割り当て済みの品を外す必要があります。数量を確認してください。' });
});

test.each(['bad', '{}', '{"releasedQuantity":-1}', '{"releasedQuantity":1.5}', '{"releasedQuantity":"2"}',
  '{"releasedQuantity":2,"secret":"PRIVATE-MARKER"}'])('rejects malformed confirmation detail %s', async (details) => {
  rpc.mockResolvedValue({ error: { message: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', code: '55000', details } });
  await expect(recordStockMovement(client, 'actor', input)).rejects.toMatchObject({ status: 500, message: '在庫の記録に失敗しました' });
});

test.each([null, {}, { ...success, movementId: 123 }, { ...success, releasedQuantity: -1 },
  { ...success, allocatedQuantity: 1.5 }, { ...success, replayed: 'true' }])('rejects invalid RPC success %p', async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(recordStockMovement(client, 'actor', input)).rejects.toMatchObject({ status: 500 });
});

test('transport failures and unknown DB errors retain no raw data or cause', async () => {
  for (const action of ['throw', 'error']) {
    if (action === 'throw') rpc.mockRejectedValue(new Error('PRIVATE-MARKER'));
    else rpc.mockResolvedValue({ error: { code: '23514', message: 'PRIVATE-MARKER' } });
    const error = await recordStockMovement(client, 'actor', input).catch((e: unknown) => e);
    expect(error).toMatchObject({ message: '在庫の記録に失敗しました', status: 500 });
    expect(JSON.stringify(error)).not.toContain('PRIVATE-MARKER');
    expect(error).not.toHaveProperty('cause');
  }
});

const event = { event_id: 'event', allocation_id: 'allocation', order_id: 'order', order_item_id: 'line', variant_id: 11,
  event_type: 'promote', quantity: 2, operation_id: 'operation', counterpart_allocation_id: null,
  reverses_event_id: null, stock_movement_id: null, reason: null, actor_id: null, created_at: '2026-10-24T00:00:00Z' };
test('maps allocation history without inventing movements', async () => {
  rpc.mockResolvedValue({ data: [event], error: null });
  await expect(listItemAllocationHistory(client, 7, 50)).resolves.toEqual([{ id: 'event', allocationId: 'allocation',
    orderId: 'order', orderItemId: 'line', variantId: 11, type: 'promote', quantity: 2, operationId: 'operation',
    counterpartAllocationId: null, reversesEventId: null, stockMovementId: null, reason: null, actorId: null, createdAt: event.created_at }]);
  expect(rpc).toHaveBeenCalledWith('list_item_allocation_history', { _item_id: 7, _limit: 50 });
});
test.each([{ ...event, event_type: 'unknown' }, { ...event, quantity: 0 }, { ...event, stock_movement_id: 9007199254740992 }, null])(
  'fails closed on invalid history %p', async (row) => {
    rpc.mockResolvedValue({ data: [row], error: null });
    await expect(listItemAllocationHistory(client, 7, 50)).rejects.toThrow('ALLOCATION_HISTORY_READ_FAILED');
  });
test('inventory returns quantities from one RPC snapshot and rejects missing variants', async () => {
  const row = { variant_id: 11, free: 1, paid_allocated: 2, payment_held: 3, on_hand: 6, waiting: 4 };
  rpc.mockResolvedValue({ data: [row], error: null });
  await expect(listGroupGVariantInventory(client, [11])).resolves.toEqual([row]);
  expect(rpc).toHaveBeenCalledWith('list_group_g_variant_inventory', { _variant_ids: [11] });
  rpc.mockResolvedValue({ data: [], error: null });
  await expect(listGroupGVariantInventory(client, [11])).rejects.toThrow('INVENTORY_READ_FAILED');
});
