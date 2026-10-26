/** @jest-environment node */
jest.mock('server-only', () => ({}), { virtual: true });
import type { SupabaseClient } from '@supabase/supabase-js';
import { AllocationSwapError, swapOrderAllocations, listAllocationSwapCandidates } from '@/lib/inventory/allocation-swap-store';
import { ALLOCATION_SWAP_ERRORS } from '@/lib/inventory/allocation-swap-types';

const orderId = '11111111-1111-4111-8111-111111111111';
const donorId = '22222222-2222-4222-8222-222222222222';
const takerItem = '33333333-3333-4333-8333-333333333333';
const donorItem = '44444444-4444-4444-8444-444444444444';
const input = { takerOrderItemId: takerItem, donorOrderItemId: donorItem, quantity: 2, reason: '順番の調整', requestKey: donorId };
const result = { id: orderId, operationId: donorId, takerOrderId: orderId, takerOrderItemId: takerItem, donorOrderId: donorId, donorOrderItemId: donorItem, quantity: 2, reason: input.reason, replayed: false };
const row = { donor_order_id: donorId, donor_order_item_id: donorItem, order_created_at: '2026-10-26T00:00:00+00:00', swappable_quantity: 3, taker_quantity: 2 };
const rpc = jest.fn(); const client = { rpc } as unknown as SupabaseClient;
beforeEach(() => jest.resetAllMocks());
test('FREQ-540-AC-13: writerの名前と7引数、camelCaseの結果を保持する', async () => {
  rpc.mockResolvedValue({ data: result, error: null });
  expect(await swapOrderAllocations(client, 'actor', orderId, input)).toEqual(result);
  expect(rpc).toHaveBeenCalledWith('admin_swap_order_allocations', { _order_id: orderId, _taker_order_item_id: takerItem, _donor_order_item_id: donorItem, _quantity: 2, _reason: input.reason, _actor_id: 'actor', _request_key: donorId });
});
test('FREQ-523-AC-05: candidatesの名前と3引数、snake_caseを公開型へ変換する', async () => {
  rpc.mockResolvedValue({ data: [row], error: null });
  expect(await listAllocationSwapCandidates(client, 'actor', orderId, takerItem)).toEqual([{ donorOrderId: donorId, donorOrderItemId: donorItem, orderCreatedAt: row.order_created_at, swappableQuantity: 3, takerQuantity: 2 }]);
  expect(rpc).toHaveBeenCalledWith('list_admin_allocation_swap_candidates', { _order_id: orderId, _taker_order_item_id: takerItem, _actor_id: 'actor' });
  rpc.mockResolvedValue({ data: [], error: null }); expect(await listAllocationSwapCandidates(client, 'actor', orderId, takerItem)).toEqual([]);
});
test.each(Object.entries(ALLOCATION_SWAP_ERRORS))('FREQ-540-AC-13: %sは両storeとも完全一致だけ分類する', async (code, [sqlstate, status, message]) => {
  rpc.mockResolvedValue({ data: null, error: { message: code, code: sqlstate, details: 'PRIVATE', hint: 'PRIVATE' } });
  for (const call of [() => swapOrderAllocations(client, 'actor', orderId, input), () => listAllocationSwapCandidates(client, 'actor', orderId, takerItem)]) {
    const error = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllocationSwapError); expect(error).toMatchObject({ code, status, message }); expect(error).not.toHaveProperty('cause'); expect(JSON.stringify(error)).not.toContain('PRIVATE');
  }
});
test.each([{ message: 'GROUP_G_FORBIDDEN', code: '22023' }, { message: ' GROUP_G_FORBIDDEN', code: '42501' }, { message: 'toString', code: '42501' }, { message: 'PRIVATE', code: '55000' }, null])('FREQ-540-AC-13: 未知・部分一致・継承名%jは固定500', async (error) => {
  rpc.mockResolvedValue({ data: null, error });
  await expect(swapOrderAllocations(client, 'actor', orderId, input)).rejects.toMatchObject({ status: 500, message: '割当の入替に失敗しました。' });
});
test('FREQ-540-AC-13: 通信切れの生エラーを保持しない', async () => {
  rpc.mockRejectedValue(new Error('PRIVATE'));
  await expect(listAllocationSwapCandidates(client, 'actor', orderId, takerItem)).rejects.toMatchObject({ status: 500, message: '割当の入替に失敗しました。' });
});
test.each(['55000', '40P01', '23514'])('FREQ-540-AC-13: 未知のSQLSTATE %sだけを診断用に保持し、列挙・JSONに出さない', async (sqlstate) => {
  for (const rejected of [false, true]) {
    const raw = { code: sqlstate, message: 'PRIVATE', details: 'PRIVATE', hint: 'PRIVATE', name: 'PRIVATE' };
    if (rejected) rpc.mockRejectedValueOnce(raw);
    else rpc.mockResolvedValueOnce({ data: null, error: raw });
    const error: unknown = await swapOrderAllocations(client, 'actor', orderId, input).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AllocationSwapError);
    expect(error).toMatchObject({ status: 500, message: '割当の入替に失敗しました。', sqlstate });
    expect(error).not.toHaveProperty('code'); expect(error).not.toHaveProperty('cause');
    expect(Object.getOwnPropertyDescriptor(error, 'sqlstate')?.enumerable).toBe(false);
    expect(Object.keys(error as object).sort()).toEqual(['name', 'status']);
    expect(JSON.stringify(error)).not.toMatch(new RegExp(`PRIVATE|sqlstate|${sqlstate}`));
  }
});
test.each(['PRIVATE', 'PGRST116', '40p01', '55000\n', 55000, null, undefined])('FREQ-540-AC-13: SQLSTATEの形でないcode %jを診断用にも保持しない', async (code) => {
  rpc.mockResolvedValueOnce({ data: null, error: { code, message: 'PRIVATE' } });
  const error: unknown = await swapOrderAllocations(client, 'actor', orderId, input).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ status: 500, message: '割当の入替に失敗しました。' });
  expect((error as { sqlstate?: string }).sqlstate).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain('PRIVATE');
});
test.each([null, [], { ...result, quantity: '2' }, { ...result, id: donorId }, { ...result, takerOrderItemId: donorItem }, { ...result, donorOrderId: orderId }, { ...result, reason: 'different' }, { ...result, quantity: 1 }, { ...result, replayed: null }])('FREQ-540-AC-13: 不正なwriter結果%jは固定500', async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(swapOrderAllocations(client, 'actor', orderId, input)).rejects.toMatchObject({ status: 500, message: '割当の入替に失敗しました。' });
});
test.each([null, {}, [row, row], [{ ...row, swappable_quantity: 0 }], [{ ...row, taker_quantity: 1.5 }], [{ ...row, donor_order_id: orderId }], [{ ...row, order_created_at: 'bad' }]])('FREQ-523-AC-05: 不正な候補%jは固定500', async (data) => {
  rpc.mockResolvedValue({ data, error: null });
  await expect(listAllocationSwapCandidates(client, 'actor', orderId, takerItem)).rejects.toMatchObject({ status: 500, message: '割当の入替に失敗しました。' });
});
