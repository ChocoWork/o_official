import { allocateCumulative } from '@/lib/discounts/discount-allocation';
import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import { amount, definition, input, line } from './fixtures';

test('FREQ-545-AC-02: 累積丸めは100円を３つに33・34・33と配り、行と１着の和が一致する', () => {
  expect(allocateCumulative(100, [1, 1, 1])).toEqual([33, 34, 33]);
  expect(allocateCumulative(1, [1, 1, 1])).toEqual([0, 1, 0]);
  expect(allocateCumulative(2, [1, 1, 1])).toEqual([1, 0, 1]);
  expect(allocateCumulative(2, [0, 1, 0, 1])).toEqual([0, 1, 0, 1]);
  expect(allocateCumulative(0, [0, 0])).toEqual([0, 0]);
  expect(allocateCumulative(2147483647, [2147483647, 2147483646])).toEqual([1073741824, 1073741823]);
  const i = input([amount('o', 100, { kind: 'order_amount' })], [line('c', 1, 100), line('a', 1, 100), line('b', 1, 100)]);
  const r = calculateDiscounts(i);
  expect(r.allocations).toEqual(['a', 'b', 'c'].map((lineKey, idx) => ({ lineKey, discountId: 'o', amount: [33, 34, 33][idx] })));
  expect(r.unitAmounts.map(u => u.paidAmount)).toEqual([67, 66, 67]);
  const nested = calculateDiscounts(input([amount('o', 151, { kind: 'order_amount' }), definition('p')], [line('a', 1, 101, 3), line('b', 2, 200, 2)]));
  expect(nested.allocations.reduce((s, a) => s + a.amount, 0)).toBe(nested.discountAmount);
  expect(nested.unitAmounts.reduce((s, a) => s + a.paidAmount, 0)).toBe(nested.totalAmount);
  expect(nested.unitAmounts.every(u => Number.isInteger(u.paidAmount) && u.paidAmount >= 0)).toBe(true);
});

test('FREQ-545-AC-03: 商品下限の調整はgroup逆順で削り１着の残額を超えない', () => {
  const i = input([definition('p', { value: { type: 'percent', value: 99 } })], [line('a', 2, 500), line('z', 1, 500)]);
  const r = calculateDiscounts(i);
  expect(r.unitAmounts).toEqual([{ lineKey: 'a', unitIndex: 0, paidAmount: 45 }, { lineKey: 'z', unitIndex: 0, paidAmount: 5 }]);
  expect(r.allocations).toEqual([{ lineKey: 'a', discountId: 'p', amount: 455 }, { lineKey: 'z', discountId: 'p', amount: 495 }]);
});

test('FREQ-545-AC-03: group逆順の下限調整はitem9よりitem10と単価999より1000を先に削る', () => {
  const d = definition('p', { value: { type: 'percent', value: 99 } });
  const byItem = calculateDiscounts(input([d], [line('a', 9, 500), line('b', 10, 500)]));
  expect(byItem.unitAmounts).toEqual([{ lineKey: 'a', unitIndex: 0, paidAmount: 5 }, { lineKey: 'b', unitIndex: 0, paidAmount: 45 }]);
  const byPrice = calculateDiscounts(input([d], [line('a', 1, 999), line('b', 1, 1000)]));
  expect(byPrice.unitAmounts).toEqual([{ lineKey: 'a', unitIndex: 0, paidAmount: 10 }, { lineKey: 'b', unitIndex: 0, paidAmount: 40 }]);
});
