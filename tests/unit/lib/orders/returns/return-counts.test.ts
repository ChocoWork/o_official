import type { SupabaseClient } from '@supabase/supabase-js';
import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import { loadReturnableUnits } from '@/lib/orders/returns/return-counts';
import { ORDER_ID } from './return-route-fixtures';

function clientReturning(result: { data: unknown; error: unknown }) {
  const rpc = jest.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as Pick<SupabaseClient, 'rpc'>, rpc };
}

describe('loadReturnableUnits（注文の返品できる数の合計）', () => {
  it('Task 1 の DB の関数を注文1件で呼び、商品ごとの returnable を足す', async () => {
    const { client, rpc } = clientReturning({
      data: [
        { order_id: ORDER_ID, order_item_id: 'item-1', returnable: 2 },
        { order_id: ORDER_ID, order_item_id: 'item-2', returnable: 3 },
        { order_id: ORDER_ID, order_item_id: 'item-3', returnable: 0 },
      ],
      error: null,
    });

    await expect(loadReturnableUnits(client, ORDER_ID)).resolves.toBe(5);
    expect(rpc).toHaveBeenCalledWith('list_order_line_return_counts', { _order_ids: [ORDER_ID] });
  });

  it('発送済みの品が無い注文（行が0件）は 0', async () => {
    const { client } = clientReturning({ data: [], error: null });

    await expect(loadReturnableUnits(client, ORDER_ID)).resolves.toBe(0);
  });

  it('行の配列でない答え（null）も 0。数えられない物は足さない', async () => {
    await expect(loadReturnableUnits(clientReturning({ data: null, error: null }).client, ORDER_ID)).resolves.toBe(0);
    await expect(
      loadReturnableUnits(clientReturning({ data: [{ order_id: ORDER_ID, returnable: null }], error: null }).client, ORDER_ID),
    ).resolves.toBe(0);
  });

  it('DB の呼び出しが失敗したら、E-2 と同じ RefundStoreError（呼び出しの名前と DB の記号だけを見せる）', async () => {
    const { client } = clientReturning({ data: null, error: { message: '宛先を含む DB の文', code: '08006' } });

    const failure = await loadReturnableUnits(client, ORDER_ID).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RefundStoreError);
    expect(failure).toMatchObject({ operation: 'list_order_line_return_counts', code: '08006' });
  });
});
