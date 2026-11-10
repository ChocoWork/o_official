/** @jest-environment node */

import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import {
  loadConsultOutstanding, loadReturnOrderId, loadUnitPricingMaterials, type UnitPricingClient,
} from '@/lib/orders/unit-pricing/unit-pricing-store';
import { repeat } from './fixtures';

type Result = { data: unknown; error: { message?: string; code?: string } | null };

function rpcClient(result: Result) {
  const rpc = jest.fn(async () => result);
  return { client: { rpc } as unknown as UnitPricingClient, rpc };
}

/** from('表').select().eq()... を await すると、表ごとに決めた答えを返す入れ物 */
function tableClient(tables: Record<string, Result>) {
  const from = jest.fn((table: string) => {
    const result = tables[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gt', 'in']) chain[method] = jest.fn(() => chain);
    chain.maybeSingle = jest.fn(async () => result);
    chain.then = (resolve: (value: Result) => void) => resolve(result);
    return chain;
  });
  return { client: { from } as unknown as UnitPricingClient, from };
}

describe('loadUnitPricingMaterials', () => {
  test('DD-ADMIN-022: 材料の関数の答えを、直さずに計画の入力として返す', async () => {
    const materials = repeat();
    const { client, rpc } = rpcClient({ data: materials, error: null });

    await expect(loadUnitPricingMaterials(client, 'order-r')).resolves.toEqual(materials);
    expect(rpc).toHaveBeenCalledWith('order_unit_pricing_materials', { _order_id: 'order-r' });
  });

  test('FREQ-642-AC-20: 注文の時の写しが無い注文（答えが null）は null', async () => {
    await expect(loadUnitPricingMaterials(rpcClient({ data: null, error: null }).client, 'order-r')).resolves.toBeNull();
  });

  test('DD-ADMIN-022: DB の失敗と、形の違う答えは RefundStoreError（DB の文は cause にだけ残す）', async () => {
    const failed = loadUnitPricingMaterials(rpcClient({ data: null, error: { message: '宛先 東京都…', code: '08006' } }).client, 'order-r');
    await expect(failed).rejects.toBeInstanceOf(RefundStoreError);
    await expect(failed).rejects.toMatchObject({ message: 'refund store failed: order_unit_pricing_materials', code: '08006' });

    await expect(loadUnitPricingMaterials(rpcClient({ data: { version: 1 }, error: null }).client, 'order-r'))
      .rejects.toBeInstanceOf(RefundStoreError);
  });
});

describe('loadReturnOrderId', () => {
  test('DD-ADMIN-022: 返品の注文の番号を返す。返品が無ければ null', async () => {
    const found = tableClient({ order_returns: { data: { order_id: 'order-r' }, error: null } });
    await expect(loadReturnOrderId(found.client, 'ret-1')).resolves.toBe('order-r');
    expect(found.from).toHaveBeenCalledWith('order_returns');

    await expect(loadReturnOrderId(tableClient({ order_returns: { data: null, error: null } }).client, 'ret-1')).resolves.toBeNull();
    await expect(loadReturnOrderId(tableClient({ order_returns: { data: null, error: { code: '08006' } } }).client, 'ret-1'))
      .rejects.toBeInstanceOf(RefundStoreError);
  });
});

describe('loadConsultOutstanding（相談の残り）', () => {
  const events = (rows: Array<{ id: string; consult_refund: number }>): Result => ({ data: rows, error: null });

  test('DD-ADMIN-022: 相談の分の出来事が無ければ 0', async () => {
    const { client, from } = tableClient({ order_unit_events: events([]) });

    await expect(loadConsultOutstanding(client, 'ret-1')).resolves.toBe(0);
    expect(from).toHaveBeenCalledTimes(1);
  });

  test('DD-ADMIN-022: 相談の返金が付いた出来事は、店長が額を下げていても残りに出さない（全部返したら 0）', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', consult_refund: 5000 }, { id: 'e2', consult_refund: 3000 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1' }, { event_id: 'e2', refund_id: 'r1' }], error: null },
      order_refunds: { data: [{ id: 'r1', status: 'awaiting_response' }], error: null },
    });

    await expect(loadConsultOutstanding(client, 'ret-1')).resolves.toBe(0);
  });

  test('DD-ADMIN-022: 返金が無い出来事・失敗した返金だけの出来事の分が残りになる', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', consult_refund: 5000 }, { id: 'e2', consult_refund: 3000 }, { id: 'e3', consult_refund: 700 }]),
      order_unit_event_refunds: {
        data: [{ event_id: 'e1', refund_id: 'r1' }, { event_id: 'e2', refund_id: 'r2' }], error: null,
      },
      order_refunds: { data: [{ id: 'r1', status: 'succeeded' }, { id: 'r2', status: 'failed' }], error: null },
    });

    await expect(loadConsultOutstanding(client, 'ret-1')).resolves.toBe(3000 + 700);
  });

  test('DD-ADMIN-022: 読み出しの失敗は RefundStoreError', async () => {
    const { client } = tableClient({ order_unit_events: { data: null, error: { code: '08006' } } });
    await expect(loadConsultOutstanding(client, 'ret-1')).rejects.toBeInstanceOf(RefundStoreError);
  });
});
