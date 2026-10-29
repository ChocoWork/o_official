import { buildProductCandidates, evaluateProductCombination } from '@/lib/discounts/discount-products';
import { calculateDiscounts } from '@/lib/discounts/discount-engine';
import { definition, input, jacket, line, usage } from './fixtures';

test('FREQ-544-AC-02: Aだけ・Bだけ・両方は仕様7.1の着数になる', () => {
  for (const [prior, current, counts] of [[0, 2, [0, 1, 1]], [1, 1, [1, 0, 1]]] as const) {
    for (const [idx, [a, b]] of [[true, false], [false, true], [true, true]].entries()) {
      const d = definition('r', { kind: 'repeat', targetMode: 'include', itemIds: [1], repeatPrevious: a, repeatInOrder: b });
      const i = input([d], [line('b', 1, 1000, current)]);
      i.facts = { ...i.facts, priorUnitsByItem: { '1': prior } };
      expect(calculateDiscounts(i).discountAmount).toBe(counts[idx] * 100);
      const g = { ...i, facts: { ...i.facts, buyer: { kind: 'guest' as const, normalizedEmail: 'g@example.invalid' } } };
      expect(calculateDiscounts(g).discountAmount).toBe(b ? (current - 1) * 100 : 0);
    }
  }
  const r = definition('r', { kind: 'repeat', targetMode: 'include', itemIds: [1], repeatPrevious: true, repeatInOrder: true });
  const i = input([r], [line('z', 1, 1000), line('a', 1, 500), { ...line('x', 1, 10000), lineKind: 'exchange' }]);
  expect(calculateDiscounts(i).unitAmounts).toEqual([{ lineKey: 'a', unitIndex: 0, paidAmount: 500 }, { lineKey: 'z', unitIndex: 0, paidAmount: 900 }]);
  // Facts already exclude unpaid orders, exchanges and successful refunded units.
  expect(calculateDiscounts({ ...i, lines: [line('z')], facts: { ...i.facts, priorUnitsByItem: { '1': 1 } } }).discountAmount).toBe(100);
  expect(calculateDiscounts({ ...i, lines: [line('z')], facts: { ...i.facts, priorUnitsByItem: { '1': 0 } } }).discountAmount).toBe(0);
});

test('FREQ-544-AC-03: ジャケット2とパンツ1は１組で、別割引が取った着は組に使えない', () => {
  const i = jacket();
  const plan = evaluateProductCombination(i, buildProductCandidates(i));
  expect(plan.setCounts).toEqual({ set: 1 });
  expect(plan.effects.map(e => [e.discountId, e.amount])).toEqual([['set', 3000], ['single', 1000]]);
  expect(evaluateProductCombination(jacket(4000), buildProductCandidates(jacket(4000))).setCounts.set).toBe(0);
  for (const count of [2, 10]) {
    const d = definition('s', { kind: 'set', targetMode: 'include', itemIds: Array.from({ length: count }, (_, n) => n + 1) });
    for (const method of ['automatic', 'code'] as const) {
      const rule = { ...d, method };
      const cart = input([rule], d.itemIds.map(id => line(String(id), id, 1000, 2)));
      cart.codes = method === 'code' ? ['S'] : [];
      expect(calculateDiscounts(cart).discountAmount).toBe(count * 200);
      expect(evaluateProductCombination(cart, buildProductCandidates(cart)).setCounts.s).toBe(2);
    }
  }
  for (const itemIds of [[1], [1, 1], Array.from({ length: 11 }, (_, n) => n + 1)]) {
    const d = definition('s', { kind: 'set', targetMode: 'include', itemIds });
    expect(() => calculateDiscounts(input([d]))).toThrow('invalid_input');
  }
  const d = definition('r', { kind: 'repeat', targetMode: 'include', itemIds: [1] });
  expect(() => calculateDiscounts(input([d]))).toThrow('invalid_input');
  const duplicate = { ...i.discounts[0], id: 'set2' };
  expect(() => calculateDiscounts({ ...i, discounts: [...i.discounts, duplicate], facts: { ...i.facts, usage: [...i.facts.usage, usage(duplicate)] } })).toThrow('invalid_input');
});

test('FREQ-544-AC-01: evaluateProductCombinationは資格を失った候補を無視し有効な効果だけ返す', () => {
  const i = input([definition('valid'), definition('expired')]);
  const oldCandidates = buildProductCandidates(i);
  const changed = { ...i, discounts: i.discounts.map(d => d.id === 'expired' ? { ...d, stopped: true } : d) };
  const plan = evaluateProductCombination(changed, [...oldCandidates, { discountId: 'missing', codeId: null, targetGroupKeys: ['1:1000'], setItemIds: [] }]);
  expect(plan.selectedDiscountIds).toEqual(['valid']);
  expect(plan.effects.map(e => [e.discountId, e.amount])).toEqual([['valid', 100]]);
  expect(evaluateProductCombination(changed, oldCandidates.filter(c => c.discountId === 'expired')).effects).toEqual([]);
});
