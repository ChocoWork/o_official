import type { SupabaseClient } from '@supabase/supabase-js';
import { getOrderDiscountBreakdown, OrderDiscountStoreError } from '@/lib/discounts/order-discount-store';
import { displayOrderDiscountName, orderDiscountLabel, toCustomerOrderDiscounts } from '@/lib/discounts/discount-types';

jest.mock('server-only', () => ({}), { virtual: true });

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const DISCOUNT_A = '22222222-2222-4222-8222-222222222222';
const DISCOUNT_B = '33333333-3333-4333-8333-333333333333';
const ITEM_1 = '44444444-4444-4444-8444-444444444444';
const ITEM_2 = '55555555-5555-4555-8555-555555555555';

const hRow = (overrides: Record<string, unknown> = {}) => ({
  name: '秋の割引', amount: 2000, discountId: DISCOUNT_A, code: 'AUTUMN', lineAllocations: [{ orderItemId: ITEM_1, amount: 1200 }, { orderItemId: ITEM_2, amount: 800 }], ...overrides,
});
const LEGACY = { rows: [{ name: 'discount', amount: 500, discountId: null, code: null, lineAllocations: [] }], legacy: true };

function clientOf(result: { data?: unknown; error?: unknown } | Error) {
  const rpc = jest.fn(async () => {
    if (result instanceof Error) throw result;
    return { data: result.data ?? null, error: result.error ?? null };
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('getOrderDiscountBreakdown', () => {
  test('FREQ-552-AC-03: 注文のidだけを渡し、サーバーが返した行を検査して返す', async () => {
    const material = { rows: [hRow(), hRow({ name: 'ウェルカム', amount: 300, discountId: DISCOUNT_B, code: null, lineAllocations: [{ orderItemId: ITEM_1, amount: 300 }] })], legacy: false };
    const { client, rpc } = clientOf({ data: material });

    await expect(getOrderDiscountBreakdown(client, ORDER_ID)).resolves.toEqual(material);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_order_discount_breakdown', { _order_id: ORDER_ID });
  });

  test('FREQ-552-AC-01: 旧注文は合計だけの1行(sentinel)と旧印で返り、0円の旧注文は空', async () => {
    await expect(getOrderDiscountBreakdown(clientOf({ data: LEGACY }).client, ORDER_ID)).resolves.toEqual(LEGACY);
    await expect(getOrderDiscountBreakdown(clientOf({ data: { rows: [], legacy: true } }).client, ORDER_ID)).resolves.toEqual({ rows: [], legacy: true });
  });

  test.each([
    ['rowsがない', { legacy: false }],
    ['legacyがbooleanでない', { rows: [], legacy: 'no' }],
    ['余計なキー', { rows: [], legacy: false, extra: 1 }],
    ['行に余計なキー(会員情報)', { rows: [hRow({ userId: 'u1' })], legacy: false }],
    ['金額が0', { rows: [hRow({ amount: 0 })], legacy: false }],
    ['金額が小数', { rows: [hRow({ amount: 1.5 })], legacy: false }],
    ['金額が文字列', { rows: [hRow({ amount: '2000' })], legacy: false }],
    ['金額がint上限超え', { rows: [hRow({ amount: 2147483648 })], legacy: false }],
    ['名前が空', { rows: [hRow({ name: '' })], legacy: false }],
    ['discountIdがUUIDでない', { rows: [hRow({ discountId: 'x' })], legacy: false }],
    ['割引idの重複', { rows: [hRow(), hRow()], legacy: false }],
    ['新注文なのにdiscountIdがnull', { rows: [hRow({ discountId: null })], legacy: false }],
    ['旧注文なのにdiscountIdがある', { rows: [hRow()], legacy: true }],
    ['旧注文の行が2つ', { rows: [LEGACY.rows[0], LEGACY.rows[0]], legacy: true }],
    ['配分の注文明細idが不正', { rows: [hRow({ lineAllocations: [{ orderItemId: 'x', amount: 1 }] })], legacy: false }],
    ['配分の金額が0', { rows: [hRow({ lineAllocations: [{ orderItemId: ITEM_1, amount: 0 }] })], legacy: false }],
    ['配分が配列でない', { rows: [hRow({ lineAllocations: null })], legacy: false }],
    ['戻り値がnull', null],
    ['戻り値が配列', []],
  ])('FREQ-552-AC-03: 壊れた材料(%s)は固定のエラーで止め、中身を示さない', async (_label, data) => {
    const failure = await getOrderDiscountBreakdown(clientOf({ data }).client, ORDER_ID).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(OrderDiscountStoreError);
    expect((failure as OrderDiscountStoreError).message).toBe('order discount store failed');
    expect(JSON.stringify(failure instanceof Error ? { message: failure.message, name: failure.name } : failure)).not.toContain('2000');
  });

  test('FREQ-552-AC-03: DBの失敗も例外も生の文を出さず固定のエラーにする', async () => {
    const dbError = { message: 'relation "private.x" leaked-secret detail', code: '42501' };
    for (const result of [{ error: dbError }, new Error('connection leaked-secret')]) {
      const failure = await getOrderDiscountBreakdown(clientOf(result).client, ORDER_ID).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(OrderDiscountStoreError);
      expect((failure as Error).message).toBe('order discount store failed');
      expect((failure as OrderDiscountStoreError).operation).toBe('get_order_discount_breakdown');
      expect((failure as Error).message).not.toContain('leaked-secret');
    }
  });
});

describe('order discount display helpers', () => {
  test('FREQ-552-AC-01: SQLのsentinelは表示の「割引」に変わり、名前のある割引は「割引（名前）」になる', () => {
    expect(displayOrderDiscountName('discount')).toBe('割引');
    expect(displayOrderDiscountName('秋の割引')).toBe('秋の割引');
    expect(orderDiscountLabel('discount')).toBe('割引');
    expect(orderDiscountLabel('秋の割引')).toBe('割引（秋の割引）');
    expect(orderDiscountLabel('a\nb\r\nc')).toBe('割引（a b c）');
  });

  test('FREQ-552-AC-02: 顧客向けの投影は名前と額だけで、0円を出さず余計なキーを落とす', () => {
    const rows = [
      { name: 'discount', amount: 500, discountId: null, code: 'SECRET', lineAllocations: [{ orderItemId: ITEM_1, amount: 500 }] },
      { name: '無料', amount: 0 },
      { name: '春', amount: 100, userId: 'u1' },
    ];
    expect(toCustomerOrderDiscounts(rows)).toEqual([{ name: '割引', amount: 500 }, { name: '春', amount: 100 }]);
    expect(JSON.stringify(toCustomerOrderDiscounts(rows))).not.toMatch(/SECRET|discountId|lineAllocations|userId|u1/);
  });
});
