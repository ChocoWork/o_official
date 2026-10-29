import { targetsItem } from './discount-eligibility';
import { compareIds, DiscountInputError, quantityGroups, type DiscountEffect, type DiscountInput, type DiscountResult, type ProductPlan } from './discount-types';

/** Half-up rounding of cumulative shares preserves the exact integer total. */
export function allocateCumulative(amount: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || weights.some(w => !Number.isSafeInteger(w) || w < 0)) throw new DiscountInputError('amount_out_of_range');
  const total = weights.reduce((s, w) => s + BigInt(w), BigInt(0));
  let sum = BigInt(0), previous = BigInt(0);
  return weights.map(w => {
    sum += BigInt(w);
    const rounded = total === BigInt(0) ? BigInt(0) : (BigInt(2) * BigInt(amount) * sum + total) / (BigInt(2) * total);
    const share = Number(rounded - previous); previous = rounded; return share;
  });
}

/** Expand only the winning group plan; line and unit order also provides D15's stable metadata. */
export function expandDiscountPlan(input: DiscountInput, plan: ProductPlan, effects: readonly DiscountEffect[]): Pick<DiscountResult, 'allocations' | 'unitAmounts'> {
  const lines = [...input.lines].filter(l => l.lineKind === 'order').sort((a, b) => compareIds(a.lineKey, b.lineKey));
  const definitions = new Map(input.discounts.map(d => [d.id, d]));
  const units = lines.flatMap(l => Array.from({ length: l.quantity }, (_, unitIndex) => ({ lineKey: l.lineKey, unitIndex,
    groupKey: `${l.itemId}:${l.unitPrice}`, itemId: l.itemId, price: l.unitPrice, paid: l.unitPrice, first: false, assigned: false })));
  const byFirst = [...units].sort((a, b) => a.itemId - b.itemId || a.price - b.price || compareIds(a.lineKey, b.lineKey) || a.unitIndex - b.unitIndex);
  const seen = new Set<number>();
  for (const u of byFirst) { u.first = !seen.has(u.itemId); seen.add(u.itemId); }
  const standalone = (u: typeof units[number]) => {
    let best = 0;
    for (const id of plan.selectedDiscountIds) {
      const d = definitions.get(id)!;
      if (d.kind === 'set' || !targetsItem(d, u.itemId)) continue;
      if (d.kind === 'repeat') {
        const prior = input.facts.buyer.kind === 'member' && (input.facts.priorUnitsByItem[u.itemId] ?? 0) > 0;
        if (!(d.repeatPrevious && prior) && (!d.repeatInOrder || u.first)) continue;
      }
      const amount = d.value.type === 'amount' ? Math.min(d.value.value, u.price) : Number(BigInt(u.price) * BigInt(d.value.value) / BigInt(100));
      best = Math.max(best, amount);
    }
    return best;
  };
  const rows = new Map<string, Map<string, number>>();
  const add = (lineKey: string, id: string, amount: number) => {
    if (amount === 0) return;
    const row = rows.get(lineKey) ?? new Map<string, number>(); row.set(id, (row.get(id) ?? 0) + amount); rows.set(lineKey, row);
  };
  // The floor is applied after all eligibility calculations. Trim orders first, then product id/group descending.
  const budgets = new Map(effects.filter(e => e.class === 'product').map(e => [e.discountId, e.amount]));
  const groupOrder = new Map(quantityGroups(input).map((g, index) => [g.groupKey, index]));
  const ordered = plan.groupAllocations.map((a, index) => ({ ...a, index })).sort((a, b) => compareIds(a.discountId, b.discountId)
    || groupOrder.get(a.groupKey)! - groupOrder.get(b.groupKey)! || a.index - b.index);
  const kept = new Map<number, number>();
  for (const a of ordered) { const n = Math.min(a.amount, budgets.get(a.discountId) ?? 0); budgets.set(a.discountId, (budgets.get(a.discountId) ?? 0) - n); kept.set(a.index, n); }
  // Sets select units with least lost standalone discount; all other assignments use stable unit order.
  const allocationOrder = [...ordered].sort((a, b) => Number(definitions.get(b.discountId)!.kind === 'set') - Number(definitions.get(a.discountId)!.kind === 'set') || a.index - b.index);
  for (const a of allocationOrder) {
    const d = definitions.get(a.discountId)!;
    const eligible = units.filter(u => !u.assigned && u.groupKey === a.groupKey && (d.kind !== 'repeat' ||
      d.repeatPrevious && input.facts.buyer.kind === 'member' && (input.facts.priorUnitsByItem[u.itemId] ?? 0) > 0 || d.repeatInOrder && !u.first));
    if (d.kind === 'set') eligible.sort((a, b) => standalone(a) - standalone(b) || compareIds(a.lineKey, b.lineKey) || a.unitIndex - b.unitIndex);
    // A non-repeat survivor must not take a unit reserved for a stronger repeat survivor.
    if (d.kind !== 'set' && d.kind !== 'repeat') eligible.sort((a, b) => Number(b.first) - Number(a.first) || compareIds(a.lineKey, b.lineKey) || a.unitIndex - b.unitIndex);
    const chosen = eligible.slice(0, a.quantity);
    if (chosen.length !== a.quantity) throw new DiscountInputError('invalid_input');
    const amounts = allocateCumulative(kept.get(a.index) ?? 0, chosen.map(() => 1));
    chosen.forEach((u, idx) => { u.assigned = true; u.paid -= amounts[idx]; add(u.lineKey, a.discountId, amounts[idx]); });
  }
  for (const e of effects.filter(e => e.class === 'order')) {
    const lineWeights = lines.map(l => units.filter(u => u.lineKey === l.lineKey).reduce((s, u) => s + u.paid, 0));
    const shares = allocateCumulative(e.amount, lineWeights);
    lines.forEach((l, idx) => {
      const rowUnits = units.filter(u => u.lineKey === l.lineKey);
      const amounts = allocateCumulative(shares[idx], rowUnits.map(u => u.paid));
      rowUnits.forEach((u, j) => { u.paid -= amounts[j]; }); add(l.lineKey, e.discountId, shares[idx]);
    });
  }
  return { allocations: [...rows].sort(([a], [b]) => compareIds(a, b)).flatMap(([lineKey, row]) => [...row].sort(([a], [b]) => compareIds(a, b)).map(([discountId, amount]) => ({ lineKey, discountId, amount }))),
    unitAmounts: units.map(u => ({ lineKey: u.lineKey, unitIndex: u.unitIndex, paidAmount: u.paid })) };
}
