import { performance } from 'node:perf_hooks';
import { searchBestDiscountPlan } from '@/lib/discounts/discount-search';
import { buildProductCandidates, evaluateProductCombination } from '@/lib/discounts/discount-products';
import type { DiscountDefinition, DiscountInput } from '@/lib/discounts/discount-types';
import { MAX_DISCOUNT_PRODUCT_PLANS, MAX_DISCOUNT_COMBINATIONS } from '@/lib/discounts/discount-types';
import { amount, definition, input, jacket, line, permutations, reviewerLayout, usage } from './fixtures';
import { oracle, oracleSubset } from './oracle';

function agrees(i: DiscountInput) {
  const want = oracle(i), actual = searchBestDiscountPlan(i);
  expect(actual.discountAmount).toBe(want.discount);
  expect([...actual.applied].map(e => ({ id: e.discountId, codeId: e.codeId, amount: e.amount })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(want.effects);
  expect(actual.allocations.reduce((s, a) => s + a.amount, 0)).toBe(actual.discountAmount);
  expect(actual.unitAmounts.reduce((s, u) => s + u.paidAmount, 0)).toBe(actual.totalAmount);
}

test('FREQ-546-AC-01: セットと単品の取り合いは全体の最善を選び、少数候補の総当たりと一致する', () => {
  expect(searchBestDiscountPlan(jacket()).discountAmount).toBe(4000);
  for (const idx of [0, 1]) {
    const i = jacket(); i.discounts = i.discounts.map((d, n) => n === idx ? { ...d, combinesWithProduct: false } : d);
    expect(searchBestDiscountPlan(i).discountAmount).toBe(3000);
  }
  expect(searchBestDiscountPlan(jacket(4000)).discountAmount).toBe(8000);
  let seed = 731;
  const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 16) % n; };
  const permissions = new Map<string, Set<number>>(['r', 'set', 'o', 'code'].map(id => [id, new Set()]));
  for (let n = 0; n < 512; n++) {
    const flags = () => ({ combinesWithProduct: !!next(2), combinesWithOrder: !!next(2) });
    const repeatPrevious = !!next(2);
    const ds = [definition('p', { value: { type: 'percent', value: 1 + next(99) }, ...flags(), targetMode: 'exclude', itemIds: next(2) ? [2] : [] }),
      definition('r', { kind: 'repeat', targetMode: 'include', itemIds: [1], repeatPrevious, repeatInOrder: !repeatPrevious || !!next(2), value: { type: 'percent', value: 1 + next(99) }, ...flags() }),
      (next(2) ? amount('set', 1 + next(100), { kind: 'set', targetMode: 'include', itemIds: [1, 2], ...flags() }) : definition('set', { kind: 'set', targetMode: 'include', itemIds: [1, 2], value: { type: 'percent', value: 1 + next(99) }, ...flags() })),
      definition('o', { kind: 'order_percent', value: { type: 'percent', value: 1 + next(99) }, minimum: next(2) ? { type: 'amount', value: 100 + next(700) } : { type: 'quantity', value: 1 + next(8) }, ...flags() }),
      amount('code', 1 + next(50), { kind: next(2) ? 'order_amount' : 'product', method: 'code', minimum: { type: 'amount', value: 51 + next(500) }, ...flags() })];
    const i = input(ds, [line('a', 1, 50 + next(151), 1 + next(2)), line('b', 2, 50 + next(151), 1 + next(2)), line('c', 1, 201 + next(100)), ...(n % 4 === 0 ? [line('d', 2, 201 + next(100))] : [])]);
    i.facts = { ...i.facts, priorUnitsByItem: { '1': next(2) }, hasPreviousOrder: !!next(2) };
    for (const d of ds) permissions.get(d.id)?.add(Number(d.combinesWithProduct) * 2 + Number(d.combinesWithOrder));
    i.codes = ['CODE']; agrees(i);
  }
  for (const values of permissions.values()) expect([...values].sort()).toEqual([0, 1, 2, 3]);
});

test('FREQ-546-AC-01: 固定円セットと単価の違う着は取り分を手計算しunit方式oracleとも一致する', () => {
  const i = input([amount('set', 600, { kind: 'set', targetMode: 'include', itemIds: [1, 2] }),
    amount('single', 350, { targetMode: 'exclude', itemIds: [2] })], [line('a', 1, 1000, 2), line('b', 1, 2000), line('c', 2, 1000)]);
  // A 1000-yen J gets only 300 (<350), but the 2000-yen J gets 400 (>350).
  // One full set is 400+200, and the two surviving 1000-yen Js each get 350.
  const r = searchBestDiscountPlan(i);
  expect(r).toMatchObject({ discountAmount: 1300, totalAmount: 3700 });
  expect(r.unitAmounts.map(u => u.paidAmount)).toEqual([650, 650, 1600, 800]);
  expect(oracleSubset(i, i.discounts).effects).toEqual([{ id: 'set', codeId: null, amount: 600 }, { id: 'single', codeId: null, amount: 700 }]);
  agrees(i);
});

test('FREQ-545-AC-03: 独立oracleは合法な保持額の組を選び商品優先と注文id順の下限を満たす', () => {
  const i = input([definition('p', { value: { type: 'percent', value: 90 } }), amount('a', 40, { kind: 'order_amount' }), amount('z', 40, { kind: 'order_amount' })]);
  expect(oracleSubset(i, i.discounts).effects).toEqual([{ id: 'a', codeId: null, amount: 40 }, { id: 'p', codeId: null, amount: 900 }, { id: 'z', codeId: null, amount: 10 }]);
  agrees(i);
});

test('FREQ-546-AC-01: engineはセットのJ取り分2000円より単品2500円を優先し２着5000円引きを選ぶ', () => {
  const i = jacket(2500), r = searchBestDiscountPlan(i);
  expect(r.discountAmount).toBe(5000); expect(r.totalAmount).toBe(45000);
  expect(evaluateProductCombination(i, buildProductCandidates(i)).setCounts.set).toBe(0);
  expect(r.applied.map(e => e.discountId)).toEqual(['single']);
});
test('FREQ-546-AC-01: 独立oracleもJ単品2500円が強い時はセット０組で5000円引きになる', () => {
  const i = jacket(2500);
  expect([[], [i.discounts[0]], [i.discounts[1]], [...i.discounts]].map(ds => oracleSubset(i, ds).discount)).toEqual([0, 3000, 5000, 5000]);
  agrees(i);
});
test('FREQ-546-AC-01: 商品10％は16000円２着の両方へ適用され注文5000円だけの案が勝つ', () => {
  const i = input([definition('p'), amount('o', 5000, { kind: 'order_amount', minimum: { type: 'amount', value: 30000 } })], [line('a', 1, 16000, 2)]);
  expect(searchBestDiscountPlan(i)).toMatchObject({ discountAmount: 5000, totalAmount: 27000 }); agrees(i);
});
test('FREQ-546-AC-01: 採用したセットは最大組数を使い注文の最低額のために組数を減らさない', () => {
  const i = jacket(); i.lines = [line('j', 1, 20000, 2), line('p', 2, 10000, 2)];
  i.discounts = [i.discounts[0], amount('o', 10000, { kind: 'order_amount', minimum: { type: 'amount', value: 57000 } })];
  i.facts = { ...i.facts, usage: i.discounts.map(d => usage(d)) };
  expect(evaluateProductCombination(i, buildProductCandidates(i)).setCounts.set).toBe(2);
  expect(searchBestDiscountPlan(i)).toMatchObject({ discountAmount: 10000, totalAmount: 50000 }); agrees(i);
});

test('FREQ-546-AC-01: 対象除外とrepeat保護と最低条件を50行５itemへ集約しても手計算に一致する', () => {
  const ds = [definition('p', { targetMode: 'exclude', itemIds: [5] }), definition('r', { kind: 'repeat', targetMode: 'include', itemIds: [5], repeatInOrder: true, value: { type: 'percent', value: 15 } }), definition('o', { kind: 'order_percent', minimum: { type: 'amount', value: 800000 } })];
  const i = input(ds, Array.from({ length: 50 }, (_, n) => line(String(n).padStart(2, '0'), n % 5 + 1, 1000, 20)));
  expect(searchBestDiscountPlan(i)).toMatchObject({ subtotalAmount: 1000000, discountAmount: 198865, totalAmount: 801135 });
  expect(searchBestDiscountPlan(i).applied.map(e => e.amount)).toEqual([80000, 29850, 89015]);
  const small = input(ds.map(d => ({ ...d, minimum: { type: 'none', value: 0 } })), [line('a', 1, 103, 2), line('b', 5, 107, 2), line('c', 5, 109)]);
  agrees(small);
  agrees(input([jacket().discounts[0], definition('p', { value: { type: 'percent', value: 2 } })], [line('a', 1, 19000), line('b', 1, 20000, 2), line('c', 2, 10000, 2)]));
});

test('FREQ-546-AC-02: 安定順はコード数と割引数の後にidを比べる', () => {
  const ds = [amount('z', 500, { kind: 'order_amount', combinesWithOrder: false }), amount('a', 500, { kind: 'order_amount', combinesWithOrder: false })];
  expect(searchBestDiscountPlan(input(ds)).applied.map(e => e.discountId)).toEqual(['a']);
  const multiple = input([amount('z', 500, { kind: 'order_amount' }), amount('y', 500, { kind: 'order_amount' }), amount('a', 1000, { kind: 'order_amount', combinesWithOrder: false })], [line('a', 1, 5000)]);
  expect(searchBestDiscountPlan(multiple).applied.map(e => e.discountId)).toEqual(['a']);
});

test('FREQ-546-AC-02: 同額はコード最少、次に割引最少、最後に安定順で、選ばないコードを消費しない', () => {
  const ds = [amount('auto', 1000), amount('code', 1000, { method: 'code' }), amount('small1', 500, { kind: 'order_amount' }), amount('small2', 500, { kind: 'order_amount' })];
  // Prevent the product and order classes from combining, so the equal-amount tie is observable.
  const cart = input(ds.map(d => ({ ...d, combinesWithProduct: d.kind === 'product', combinesWithOrder: d.kind !== 'product' })), [line('a', 1, 10000)]);
  cart.codes = ['code'];
  const baseline = searchBestDiscountPlan(cart);
  expect(baseline.applied.map(e => e.discountId)).toEqual(['auto']); expect(baseline.unusedCodes).toEqual(['CODE']);
  for (const discounts of permutations(cart.discounts)) expect(searchBestDiscountPlan({ ...cart, discounts, facts: { ...cart.facts, usage: [...cart.facts.usage].reverse() } })).toEqual(baseline);
  const code = amount('a', 1000, { method: 'code' });
  const i = input([code], [line('a', 1, 10000)]); i.codes = [' z ', 'a', 'Z'];
  i.facts = { ...i.facts, usage: [usage(code, { codeId: 'z', code: 'Z' }), usage(code, { codeId: 'a', code: 'A' })] };
  expect(searchBestDiscountPlan(i).applied).toHaveLength(1);
  expect(searchBestDiscountPlan(i).applied[0].codeId).toBe('a'); expect(searchBestDiscountPlan(i).unusedCodes).toEqual(['Z']);
});

function maximum(c: number, u: number, sets: boolean): DiscountInput {
  const ds: DiscountDefinition[] = [];
  for (let n = 1; n <= 6; n++) ds.push(definition(`p${n}`, sets ? { kind: 'set', targetMode: 'include', itemIds: [n * 2 - 1, n * 2], value: { type: 'percent', value: n } } : { value: { type: 'percent', value: n } }));
  for (let n = 1; n <= 6; n++) ds.push(definition(`o${n}`, { kind: 'order_percent', value: { type: 'percent', value: n } }));
  for (let n = 0; n < 13; n++) ds.push(n < u ? definition(`u${n}`, { combinesWithProduct: false, combinesWithOrder: false, value: { type: 'percent', value: 1 } }) : amount(`u${n}`, n + 1, { kind: 'order_amount', combinesWithProduct: false, combinesWithOrder: false, minimum: { type: 'amount', value: 14 } }));
  for (let n = 0; n < 5; n++) ds.push(definition(`c${n}`, { kind: n < c ? 'product' : 'order_percent', method: 'code', value: { type: 'percent', value: 7 + (n < c ? n : n - c) } }));
  const i = input(ds, Array.from({ length: 50 }, (_, n) => line(String(n).padStart(2, '0'), n + 1, 1000, 20)));
  i.codes = Array.from({ length: 5 }, (_, n) => `C${n}`); return i;
}
test('FREQ-546-AC-03: ５コードと25自動は処理でき、６と26は拒否し、50円で同額になる候補もtie-breakする', () => {
  expect(searchBestDiscountPlan(maximum(5, 0, false)).discountAmount).toBe(296900);
  expect(searchBestDiscountPlan(maximum(0, 0, false)).discountAmount).toBe(680400);
  expect(() => searchBestDiscountPlan({ ...input(), codes: ['A', 'B', 'C', 'D', 'E', 'F'] })).toThrow('too_many_codes');
  expect(() => searchBestDiscountPlan(input(Array.from({ length: 26 }, (_, n) => definition(String(n), { combinesWithProduct: false, combinesWithOrder: false }))))).toThrow('too_many_automatic');
  expect(() => searchBestDiscountPlan(input(Array.from({ length: 7 }, (_, n) => definition(String(n)))))).toThrow('too_many_automatic');
  const i = input([definition('auto', { value: { type: 'percent', value: 50 } }), definition('code', { method: 'code', value: { type: 'percent', value: 99 } })], [line('a', 1, 100)]); i.codes = ['code', ' CODE '];
  expect(searchBestDiscountPlan(i).applied.map(e => e.discountId)).toEqual(['auto']);
});

test('FREQ-546-AC-04: C21全配置の計算上界2067でguardを定め合法な5100円引きをexactで返す', () => {
  let productBound = 0, combinationBound = 0, configurations = 0;
  // Using all 25 autos bounds smaller totals: adding a non-stackable auto never reduces a side's size.
  // Cross-only permissions cannot increase side sizes; both-OFF autos realize all the maxima below.
  for (let p = 0; p <= 6; p++) for (let o = 0; o <= 6; o++) {
    for (let cp = 0; cp <= 5; cp++) for (let cpSingle = 0; cpSingle <= 5 - cp; cpSingle++) {
      for (let co = 0; co <= 5 - cp - cpSingle; co++) for (let coSingle = 0; coSingle <= 5 - cp - cpSingle - co; coSingle++) {
        for (let u = 0; u <= 25 - p - o; u++) {
          const ps = 2 ** (p + cp) + u + cpSingle;
          const os = 2 ** (o + co) + 25 - p - o - u + coSingle;
          productBound = Math.max(productBound, ps); combinationBound = Math.max(combinationBound, ps * os); configurations++;
        }
      }
    }
  }
  expect(productBound).toBe(2067); expect(combinationBound).toBe(157696);
  const exact = searchBestDiscountPlan(reviewerLayout());
  expect(exact).toMatchObject({ calculationMode: 'exact', discountAmount: 5100, totalAmount: 36900 });
  expect(MAX_DISCOUNT_PRODUCT_PLANS).toBe(productBound);
  expect(MAX_DISCOUNT_COMBINATIONS).toBeGreaterThanOrEqual(combinationBound);
  expect(exact.applied.map(e => [e.discountId, e.amount])).toEqual([['p2', 100], ['o', 5000]]);
  console.info(JSON.stringify({ derivedBounds: { configurations, productBound, combinationBound } }));
});

test('FREQ-546-AC-04: 強制fallbackは厳密解と異なっても全単独案以上を必ず返す', () => {
  const i = reviewerLayout();
  const fallback = searchBestDiscountPlan(i, { maxProductPlans: 0, maxCombinations: 0 });
  expect(fallback).toMatchObject({ calculationMode: 'fallback', discountAmount: 5000, totalAmount: 37000 });
  for (const d of i.discounts) {
    const single = searchBestDiscountPlan({ ...i, discounts: [d] });
    expect(fallback.discountAmount).toBeGreaterThanOrEqual(single.discountAmount);
  }
  expect(fallback.allocations.reduce((s, a) => s + a.amount, 0)).toBe(fallback.discountAmount);
  expect(fallback.unitAmounts.reduce((s, a) => s + a.paidAmount, 0)).toBe(fallback.totalAmount);
});

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

test('FREQ-546-AC-04: guard不具合でも単独案と全互換併用案の最善を返してfallbackを印す', () => {
  const ds = [amount('p-alone', 1500, { combinesWithProduct: false, combinesWithOrder: true }), definition('p'), amount('o1', 500, { kind: 'order_amount' }), amount('o2', 500, { kind: 'order_amount' }), amount('o-alone', 600, { kind: 'order_amount', combinesWithProduct: true, combinesWithOrder: false })];
  const i = input(ds, [line('a', 1, 10000)]);
  const r = searchBestDiscountPlan(i, { maxProductPlans: 0, maxCombinations: 0 });
  expect(r.calculationMode).toBe('fallback'); expect(r.discountAmount).toBe(2500); expect(r.applied.map(e => e.discountId)).toEqual(['p-alone', 'o1', 'o2']);
  for (const d of ds) expect(r.discountAmount).toBeGreaterThanOrEqual(searchBestDiscountPlan(input([d], i.lines)).discountAmount);
  expect(searchBestDiscountPlan(i, { maxProductPlans: 1000, maxCombinations: 1 })).toEqual(r);
  const floor = searchBestDiscountPlan(input([definition('a', { value: { type: 'percent', value: 99 } })]), { maxProductPlans: 0, maxCombinations: 0 });
  expect(floor.totalAmount).toBe(50); expect(floor.allocations.reduce((s, a) => s + a.amount, 0)).toBe(floor.discountAmount);
  expect(floor.unitAmounts.reduce((s, a) => s + a.paidAmount, 0)).toBe(50);
});
