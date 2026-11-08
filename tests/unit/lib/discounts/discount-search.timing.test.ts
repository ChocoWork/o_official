import { performance } from 'node:perf_hooks';
import { searchBestDiscountPlan } from '@/lib/discounts/discount-search';
import type { DiscountDefinition, DiscountInput } from '@/lib/discounts/discount-types';
import { amount, definition, input, line, reviewerLayout } from './fixtures';

function maximum(c: number, u: number, sets: boolean): DiscountInput {
  const ds: DiscountDefinition[] = [];
  for (let n = 1; n <= 6; n++) ds.push(definition(`p${n}`, sets ? { kind: 'set', targetMode: 'include', itemIds: [n * 2 - 1, n * 2], value: { type: 'percent', value: n } } : { value: { type: 'percent', value: n } }));
  for (let n = 1; n <= 6; n++) ds.push(definition(`o${n}`, { kind: 'order_percent', value: { type: 'percent', value: n } }));
  for (let n = 0; n < 13; n++) ds.push(n < u ? definition(`u${n}`, { combinesWithProduct: false, combinesWithOrder: false, value: { type: 'percent', value: 1 } }) : amount(`u${n}`, n + 1, { kind: 'order_amount', combinesWithProduct: false, combinesWithOrder: false, minimum: { type: 'amount', value: 14 } }));
  for (let n = 0; n < 5; n++) ds.push(definition(`c${n}`, { kind: n < c ? 'product' : 'order_percent', method: 'code', value: { type: 'percent', value: 7 + (n < c ? n : n - c) } }));
  const i = input(ds, Array.from({ length: 50 }, (_, n) => line(String(n).padStart(2, '0'), n + 1, 1000, 20)));
  i.codes = Array.from({ length: 5 }, (_, n) => `C${n}`); return i;
}
test('FREQ-546-AC-04: ２商品10着と３つの重なる割引は全着適用の厳密な2900円引きを時間内に返す', () => {
  const i = input([definition('p'), definition('r', { kind: 'repeat', targetMode: 'include', itemIds: [1, 2], repeatInOrder: true, value: { type: 'percent', value: 15 } }), definition('c', { method: 'code', value: { type: 'percent', value: 5 } })], [line('a', 1, 1000, 10), line('b', 2, 1000, 10)]); i.codes = ['C'];
  for (let n = 0; n < 20; n++) {
    const start = performance.now(), r = searchBestDiscountPlan(i), elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200); expect(r).toMatchObject({ discountAmount: 2900, totalAmount: 17100, unusedCodes: ['C'], calculationMode: 'exact' });
    expect(r.unitAmounts.filter(u => u.paidAmount === 900)).toHaveLength(2); expect(r.unitAmounts.filter(u => u.paidAmount === 850)).toHaveLength(18);
  }
});

test('FREQ-546-AC-04: 各分類６件と25自動５コードの最大カートを全組評価し200ms未満で返す', () => {
  let maxMs = 0, calls = 0;
  let computedCombinationBound = 0, computedProductPlanBound = 0;
  const measure = (i: DiscountInput, want: number, productPlanBound: number, combinationBound: number) => {
    computedCombinationBound = Math.max(computedCombinationBound, combinationBound);
    computedProductPlanBound = Math.max(computedProductPlanBound, productPlanBound);
    for (let n = 0; n < 20; n++) {
      const start = performance.now(), r = searchBestDiscountPlan(i), elapsed = performance.now() - start;
      maxMs = Math.max(maxMs, elapsed); calls++;
      expect(elapsed).toBeLessThan(200); expect(r.calculationMode).toBe('exact');
      expect(r.discountAmount).toBe(want);
      expect(r.unitAmounts.reduce((s, a) => s + a.paidAmount, 0)).toBe(r.totalAmount);
    }
  };
  for (let c = 0; c <= 5; c++) for (let u = 0; u <= 13; u++) for (const sets of [false, true]) {
    const i = maximum(c, u, sets);
    const combinations = (2 ** (6 + c) + u) * (2 ** (11 - c) + 13 - u);
    const p = sets ? (c ? (6 + c) * 10000 : 8400) : (6 + c) * 10000;
    const o = c === 5 ? 21 : 21 + (Array.from({ length: 5 - c }, (_, j) => 7 + j).reduce((s, x) => s + x, 0));
    measure(i, p + Math.floor((1000000 - p) * o / 100), 2 ** (6 + c) + u, combinations);
  }
  // These legal layouts have 14..19 product singletons; order autos need not fill the six slots.
  for (let o = 0; o < 6; o++) for (const sets of [false, true]) {
    const original = maximum(5, 13, sets);
    const ds = original.discounts.filter(d => !d.id.startsWith('o') || Number(d.id.slice(1)) <= o);
    for (let n = o; n < 6; n++) ds.push(definition(`extra${n}`, { combinesWithProduct: false, combinesWithOrder: false, value: { type: 'percent', value: 1 } }));
    const i = { ...input(ds, original.lines), codes: original.codes };
    const ps = 2 ** 11 + 19 - o;
    measure(i, 110000 + 8900 * o * (o + 1) / 2, ps, ps * 2 ** o);
  }
  const reviewed = reviewerLayout();
  measure(reviewed, 5100, 2066, 2066 * 2);
  expect(calls).toBe(3620);
  console.info(JSON.stringify({ performance: 'C21-engine', measured: { calls, maxMs }, computedBounds: { productPlans: computedProductPlanBound, combinations: computedCombinationBound } }));
}, 600000);

