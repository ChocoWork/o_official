/** @jest-environment node */

import { RefundStoreError } from '@/lib/orders/refund/refund-store';
import {
  loadReturnOrderId, loadReturnRefundOutstanding, loadUnitPricingMaterials, type UnitPricingClient,
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

describe('loadReturnRefundOutstanding（返品の返金の見込み）', () => {
  const amountOf = async (client: UnitPricingClient) => (await loadReturnRefundOutstanding(client, 'ret-1')).amount;
  const events = (rows: Array<{ id: string; consult_refund: number; now_refund?: number }>): Result =>
    ({ data: rows.map((row) => ({ now_refund: 0, ...row })), error: null });

  test('DD-ADMIN-022: 相談の分の出来事が無ければ 0', async () => {
    const { client, from } = tableClient({ order_unit_events: events([]) });

    await expect(amountOf(client)).resolves.toBe(0);
    expect(from).toHaveBeenCalledTimes(1);
  });

  test('DD-ADMIN-022: 相談の返金が付いた出来事は、店長が額を下げていても残りに出さない（全部返したら 0）', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', consult_refund: 5000 }, { id: 'e2', consult_refund: 3000 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'consult' }, { event_id: 'e2', refund_id: 'r1', part: 'consult' }], error: null },
      order_refunds: { data: [{ id: 'r1', status: 'awaiting_response' }], error: null },
    });

    await expect(amountOf(client)).resolves.toBe(0);
  });

  test('DD-ADMIN-022: 返金が無い出来事・失敗した返金だけの出来事の分が残りになる', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', consult_refund: 5000 }, { id: 'e2', consult_refund: 3000 }, { id: 'e3', consult_refund: 700 }]),
      order_unit_event_refunds: {
        data: [{ event_id: 'e1', refund_id: 'r1', part: 'consult' }, { event_id: 'e2', refund_id: 'r2', part: 'consult' }], error: null,
      },
      order_refunds: { data: [{ id: 'r1', status: 'succeeded' }, { id: 'r2', status: 'failed' }], error: null },
    });

    await expect(amountOf(client)).resolves.toBe(3000 + 700);
  });

  test('FREQ-642-AC-37: 今すぐの返金が失敗した出来事は、今すぐの分も残りに足す（17,000円 + 相談 20,000円 = 37,000円）', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 20000 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'now' }], error: null },
      order_refunds: { data: [{ id: 'r1', status: 'failed' }], error: null },
    });

    await expect(amountOf(client)).resolves.toBe(37000);
  });

  test('FREQ-642-AC-37: 今すぐだけの出来事でも、今すぐの返金が失敗していれば今すぐの分が残り', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 0 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'now' }], error: null },
      order_refunds: { data: [{ id: 'r1', status: 'failed' }], error: null },
    });

    await expect(amountOf(client)).resolves.toBe(17000);
  });

  test.each(['pending', 'awaiting_response', 'error', 'succeeded'])(
    'FREQ-642-AC-37: 今すぐの返金が %s なら今すぐの分は二度数えず、相談の分だけ', async (status) => {
      const { client } = tableClient({
        order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 20000 }]),
        order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'now' }], error: null },
        order_refunds: { data: [{ id: 'r1', status }], error: null },
      });

      await expect(amountOf(client)).resolves.toBe(20000);
    });

  test('FREQ-642-AC-37: 今すぐの返金が無い（受け取りで0円で終えた）出来事の今すぐの分は数えない', async () => {
    const { client } = tableClient({ order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 20000 }]) });

    await expect(amountOf(client)).resolves.toBe(20000);
  });

  test('FREQ-642-AC-37: 失敗の後の返し直しが両方の分を持てば、残りは 0', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 20000 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'now' },
        { event_id: 'e1', refund_id: 'r2', part: 'now' }, { event_id: 'e1', refund_id: 'r2', part: 'consult' }], error: null },
      order_refunds: { data: [{ id: 'r1', status: 'failed' }, { id: 'r2', status: 'awaiting_response' }], error: null },
    });

    await expect(amountOf(client)).resolves.toBe(0);
  });

  test.each(['now', 'consult'] as const)('FREQ-642-AC-37: 返金しないで終えた（記録のある）%s の分は数えない', async (part) => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 20000 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'now' }], error: null },
      order_refunds: { data: [{ id: 'r1', status: 'failed' }], error: null },
      order_unit_event_waives: { data: [{ event_id: 'e1', part }], error: null },
    });

    await expect(amountOf(client)).resolves.toBe(part === 'now' ? 20000 : 17000);
  });

  test('FREQ-642-AC-37: 送料の初めの値は、返し直す今すぐの分の失敗した返金の送料の和（同じ返金は1回）', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 0 }, { id: 'e2', now_refund: 5000, consult_refund: 0 },
        { id: 'e3', now_refund: 3000, consult_refund: 0 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'now' }, { event_id: 'e2', refund_id: 'r2', part: 'now' },
        { event_id: 'e2', refund_id: 'r1', part: 'now' }, { event_id: 'e3', refund_id: 'r3', part: 'now' }], error: null },
      order_refunds: { data: [{ id: 'r1', status: 'failed', shipping_amount: 800 }, { id: 'r2', status: 'failed', shipping_amount: 300 },
        { id: 'r3', status: 'failed', shipping_amount: 500 }], error: null },
      order_unit_event_waives: { data: [{ event_id: 'e3', part: 'now' }], error: null },
    });

    await expect(loadReturnRefundOutstanding(client, 'ret-1')).resolves.toEqual({ amount: 22000, retryShipping: 1100 });
  });

  test.each([
    ['300円', 300, 300],
    ['0円（店長が送料を返さないと決めた）', 0, 0],
  ])('FREQ-642-AC-37: 返し直しも失敗したら、送料の初めの値は出来事ごとに一番新しい失敗した返金（送料 %s）の送料だけ', async (_label, r2Shipping, expected) => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 20000 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'now' },
        { event_id: 'e1', refund_id: 'r2', part: 'now' }, { event_id: 'e1', refund_id: 'r2', part: 'consult' }], error: null },
      order_refunds: { data: [
        { id: 'r2', status: 'failed', shipping_amount: r2Shipping, created_at: '2026-11-12T02:00:00.000Z' },
        { id: 'r1', status: 'failed', shipping_amount: 300, created_at: '2026-11-12T01:00:00.000Z' },
      ], error: null },
    });

    await expect(loadReturnRefundOutstanding(client, 'ret-1')).resolves.toEqual({ amount: 37000, retryShipping: expected });
  });

  test('FREQ-642-AC-37: 時刻が同じ失敗した返金は、番号の大きい方を一番新しいとする', async () => {
    const at = '2026-11-12T01:00:00.000Z';
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 0 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'ra', part: 'now' }, { event_id: 'e1', refund_id: 'rb', part: 'now' }], error: null },
      order_refunds: { data: [{ id: 'rb', status: 'failed', shipping_amount: 500, created_at: at },
        { id: 'ra', status: 'failed', shipping_amount: 300, created_at: at }], error: null },
    });

    await expect(loadReturnRefundOutstanding(client, 'ret-1')).resolves.toEqual({ amount: 17000, retryShipping: 500 });
  });

  test('FREQ-642-AC-37: 今すぐの分を返し直さない（相談の分だけ）なら、送料の初めの値は 0', async () => {
    const { client } = tableClient({
      order_unit_events: events([{ id: 'e1', now_refund: 17000, consult_refund: 20000 }]),
      order_unit_event_refunds: { data: [{ event_id: 'e1', refund_id: 'r1', part: 'now' }, { event_id: 'e1', refund_id: 'r2', part: 'consult' }], error: null },
      order_refunds: { data: [{ id: 'r1', status: 'pending', shipping_amount: 800 }, { id: 'r2', status: 'failed', shipping_amount: 400 }], error: null },
    });

    await expect(loadReturnRefundOutstanding(client, 'ret-1')).resolves.toEqual({ amount: 20000, retryShipping: 0 });
  });

  test('DD-ADMIN-022: 読み出しの失敗は RefundStoreError', async () => {
    const { client } = tableClient({ order_unit_events: { data: null, error: { code: '08006' } } });
    await expect(loadReturnRefundOutstanding(client, 'ret-1')).rejects.toBeInstanceOf(RefundStoreError);
  });
});
