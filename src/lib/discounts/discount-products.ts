import { discountUsage, evaluateEligibility, targetsItem } from './discount-eligibility';
import { allocateCumulative } from './discount-allocation';
import { compareIds, discountClass, discountValue, quantityGroups, type DiscountDefinition, type DiscountEffect, type DiscountInput,
  type ProductCandidate, type ProductPlan } from './discount-types';

/** Snapshot the selected eligible code; another code of the same definition adds no effect. */
export function effectFor(d: DiscountDefinition, input: DiscountInput, codeId?: string | null): DiscountEffect {
  const u = discountUsage(d, input, codeId);
  return { discountId: d.id, codeId: u?.codeId ?? null, name: d.name, code: u?.code ?? null, class: discountClass(d), amount: 0 };
}
/** Resolve the first eligible code by identity, independent of input order. */
export function eligibleCodeId(d: DiscountDefinition, input: DiscountInput): string | null | undefined {
  if (d.method === 'automatic') return evaluateEligibility(d, input, null).eligible ? null : undefined;
  for (const u of [...input.facts.usage].filter(u => u.discountId === d.id && u.code !== null && input.codes.some(c => c.trim().toUpperCase() === u.code)).sort((a, b) => compareIds(a.codeId ?? '', b.codeId ?? ''))) {
    if (evaluateEligibility(d, input, u.codeId).eligible) return u.codeId;
  }
  return undefined;
}
/** Candidate eligibility and percent arithmetic are prepared once, outside the combination loop. */
export function buildProductCandidates(input: DiscountInput): readonly ProductCandidate[] {
  const groups = quantityGroups(input);
  return [...input.discounts].sort((a, b) => compareIds(a.id, b.id)).flatMap(d => {
    if (discountClass(d) !== 'product') return [];
    const codeId = eligibleCodeId(d, input);
    if (codeId === undefined) return [];
    return [{ discountId: d.id, codeId, targetGroupKeys: groups.filter(g => targetsItem(d, g.itemId)).map(g => g.groupKey), setItemIds: d.kind === 'set' ? [...d.itemIds].sort((a, b) => a - b) : [] }];
  });
}
type Segment = { group: number; quantity: number; amount: number; owner: number };

/** Reusable evaluator has no unit state and no amount-dependent memoization. */
export function createProductEvaluator(input: DiscountInput, candidates: readonly ProductCandidate[]): (selected: readonly ProductCandidate[]) => ProductPlan {
  const groups = quantityGroups(input);
  const definitions = new Map(input.discounts.map(d => [d.id, d]));
  const prepared = candidates.map(c => {
    const d = definitions.get(c.discountId)!;
    return { c, d, effect: effectFor(d, input, c.codeId), amounts: groups.map(g => c.targetGroupKeys.includes(g.groupKey) ? discountValue(d, g.unitPrice) : 0) };
  });
  const index = new Map(prepared.map((p, n) => [p.c.discountId, n]));
  return selected => {
    const selectedIndices = [...new Set(selected.flatMap(c => {
      const n = index.get(c.discountId);
      return n === undefined || prepared[n].c.codeId !== c.codeId ? [] : [n];
    }))].sort((a, b) => a - b);
    const singles = selectedIndices.filter(n => prepared[n].d.kind !== 'set');
    const sets = selectedIndices.filter(n => prepared[n].d.kind === 'set');
    const segments: Segment[] = [];
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      // Two counts per price suffice: the one B-protected unit and all other units.
      for (const protectedUnit of [true, false]) {
        const quantity = protectedUnit ? group.repeatProtected : group.quantity - group.repeatProtected;
        if (!quantity) continue;
        let amount = 0, owner = -1;
        for (const n of singles) {
          const p = prepared[n], d = p.d;
          if (d.kind === 'repeat') {
            const previous = input.facts.buyer.kind === 'member' && (input.facts.priorUnitsByItem[group.itemId] ?? 0) > 0;
            if (!(d.repeatPrevious && previous) && (!d.repeatInOrder || protectedUnit && group.repeatProtected > 0)) continue;
          }
          // Candidate order gives equal amounts to the smallest discount id.
          if (p.amounts[g] > amount) { amount = p.amounts[g]; owner = n; }
        }
        segments.push({ group: g, quantity, amount, owner });
      }
    }
    const allocations: { groupKey: string; discountId: string; quantity: number; amount: number }[] = [];
    const setCounts: Record<string, number> = Object.create(null);
    for (const n of sets) {
      const p = prepared[n];
      const pools = p.c.setItemIds.map(item => segments.filter(s => groups[s.group].itemId === item)
        .sort((a, b) => a.amount - b.amount || a.group - b.group));
      const positions = pools.map(() => 0);
      let count = 0;
      while (pools.every((pool, j) => positions[j] < pool.length)) {
        const tuple = pools.map((pool, j) => pool[positions[j]]);
        const prices = tuple.map(s => groups[s.group].unitPrice);
        const total = prices.reduce((s, x) => s + x, 0);
        const shares = allocateCumulative(discountValue(p.d, total), prices);
        let blocked = false;
        for (let j = 0; j < tuple.length; j++) {
          const s = tuple[j];
          if (s.quantity === 0 || s.amount > shares[j] || (s.amount === shares[j] && s.owner >= 0 && compareIds(prepared[s.owner].d.id, p.d.id) < 0)) {
            positions[j]++; blocked = true;
          }
        }
        if (blocked) continue;
        const batch = Math.min(...tuple.map(s => s.quantity));
        for (let j = 0; j < tuple.length; j++) {
          const s = tuple[j];
          allocations.push({ groupKey: groups[s.group].groupKey, discountId: p.d.id, quantity: batch, amount: shares[j] * batch });
          s.quantity -= batch;
          if (s.quantity === 0) positions[j]++;
        }
        count += batch;
      }
      setCounts[p.d.id] = count;
    }
    for (const s of segments) if (s.owner >= 0 && s.quantity > 0) allocations.push({ groupKey: groups[s.group].groupKey, discountId: prepared[s.owner].d.id, quantity: s.quantity, amount: s.quantity * s.amount });
    const remaining: Record<string, number> = Object.create(null);
    for (const g of groups) remaining[g.groupKey] = g.unitPrice * g.quantity;
    const amounts = new Map<string, number>();
    for (const a of allocations) { remaining[a.groupKey] -= a.amount; amounts.set(a.discountId, (amounts.get(a.discountId) ?? 0) + a.amount); }
    return { selectedDiscountIds: selectedIndices.map(n => prepared[n].d.id), remaining,
      effects: selectedIndices.flatMap(n => { const amount = amounts.get(prepared[n].d.id) ?? 0; return amount > 0 ? [{ ...prepared[n].effect, amount }] : []; }), groupAllocations: allocations, setCounts };
  };
}
/** Eligible definitions apply fully. Stale/ineligible candidates are ignored; sets use maximum complete batches. */
export function evaluateProductCombination(input: DiscountInput, selected: readonly ProductCandidate[]): ProductPlan {
  return createProductEvaluator(input, buildProductCandidates(input))(selected);
}
