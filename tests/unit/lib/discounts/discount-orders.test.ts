import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import { calculateOrderEffects } from '@/lib/discounts/discount-orders';
import { evaluateProductCombination } from '@/lib/discounts/discount-products';
import { amount, definition, input, line } from './fixtures';

test('FREQ-545-AC-01: １着101円の15％は15円、注文の10％と20％は同じ10000円から合計3000円引く', () => {
  expect(calculateDiscounts(input([definition('p', { value: { type: 'percent', value: 15 } })], [line('a', 1, 101, 2)])).discountAmount).toBe(30);
  const ds = [definition('a', { kind: 'order_percent' }), definition('b', { kind: 'order_percent', value: { type: 'percent', value: 20 } })];
  for (const discounts of [ds, [...ds].reverse()]) {
    const i = input(discounts, [line('a', 1, 10000)]);
    expect(calculateDiscounts(i).totalAmount).toBe(7000);
    expect(calculateOrderEffects(i, evaluateProductCombination(i, []), discounts).map(e => e.amount)).toEqual([1000, 2000]);
  }
  expect(calculateDiscounts(input([ds[0], amount('c', 2000, { kind: 'order_amount' })], [line('a', 1, 10000)])).totalAmount).toBe(7000);
});

test('FREQ-545-AC-03: 下限を割る時は注文から削って50円にし、商品だけなら商品から削る', () => {
  const i = input([definition('p', { value: { type: 'percent', value: 90 } }), amount('o', 99, { kind: 'order_amount' })]);
  const r = calculateDiscounts(i);
  expect(r.applied.map(e => [e.discountId, e.amount])).toEqual([['p', 900], ['o', 50]]);
  expect(r.totalAmount).toBe(50);
  expect(calculateDiscounts(input([definition('p', { value: { type: 'percent', value: 99 } })])).applied[0].amount).toBe(950);
  expect(calculateDiscounts(input([amount('a', 20)], [line('a', 1, 50)])).applied).toEqual([]);
  expect(() => calculateDiscounts(input([], [line('a', 1, 49)]))).toThrow('total_below_minimum');
  expect(() => calculateDiscounts(input([definition('p', { value: { type: 'percent', value: 100 } })]))).toThrow('invalid_input');
  const many = input([definition('p', { value: { type: 'percent', value: 90 } }), ...['a', 'z'].map(id => definition(id, { kind: 'order_percent', value: { type: 'percent', value: 40 } }))]);
  expect(calculateDiscounts(many).applied.map(e => [e.discountId, e.amount])).toEqual([['p', 900], ['a', 40], ['z', 10]]);
});
