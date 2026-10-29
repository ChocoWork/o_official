// Intentionally independent, unit-based, small-cart oracle. No production imports at runtime.
import type { DiscountDefinition, DiscountInput } from '@/lib/discounts/discount-types';

type Unit = { item: number; price: number; first: boolean; amount: number; owner: string | null };
type Effect = { id: string; codeId: string | null; amount: number };
const order = (d: DiscountDefinition) => d.kind.startsWith('order_');
const value = (d: DiscountDefinition, base: number) => d.value.type === 'amount' ? Math.min(base, d.value.value) : Math.floor(base * d.value.value / 100);
function split(n: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  let sum = 0, last = 0;
  return weights.map(w => { sum += w; const next = total ? Math.floor(n * sum / total + 0.5) : 0; const part = next - last; last = next; return part; });
}
function units(i: DiscountInput): Unit[] {
  const seen = new Set<number>();
  return [...i.lines].filter(l => l.lineKind === 'order').sort((a, b) => a.itemId - b.itemId || a.unitPrice - b.unitPrice || a.lineKey.localeCompare(b.lineKey))
    .flatMap(l => Array.from({ length: l.quantity }, () => { const first = !seen.has(l.itemId); seen.add(l.itemId); return { item: l.itemId, price: l.unitPrice, first, amount: 0, owner: null }; }));
}
function target(d: DiscountDefinition, u: Unit, i: DiscountInput): boolean {
  const match = d.targetMode === 'all' || (d.targetMode === 'include' ? d.itemIds.includes(u.item) : !d.itemIds.includes(u.item));
  if (!match || d.kind !== 'repeat') return match;
  const previous = i.facts.buyer.kind === 'member' && (i.facts.priorUnitsByItem[u.item] ?? 0) > 0;
  return (d.repeatPrevious && previous) || (d.repeatInOrder && !u.first);
}
function qualify(d: DiscountDefinition, i: DiscountInput, us: Unit[], after: boolean): boolean {
  const at = Date.parse(i.facts.at);
  if (d.stopped || at < Date.parse(d.startsAt) || (d.endsAt && at >= Date.parse(d.endsAt))) return false;
  const f = i.facts.usage.find(f => f.discountId === d.id && (d.method === 'automatic' || i.codes.map(c => c.trim().toUpperCase()).includes(f.code ?? '')));
  if (!f || (d.method === 'code' && ((f.audience === 'assigned' && !f.assigned) || (i.facts.buyer.kind === 'guest' && !f.allowGuests) || (f.singleUse && f.codeUses > 0)))) return false;
  if ((d.usageLimit !== null && f.reserved + f.confirmed >= d.usageLimit) || (d.oncePerCustomer && (f.buyerUses ?? 0) > 0) || (d.firstOrderOnly && (i.facts.hasPreviousOrder || i.facts.hasFirstOrderReservation))) return false;
  const ts = us.filter(u => d.targetMode === 'all' || (d.targetMode === 'exclude' ? !d.itemIds.includes(u.item) : d.itemIds.includes(u.item)));
  return d.minimum.type === 'none' || (d.minimum.type === 'quantity' ? ts.length : ts.reduce((s, u) => s + u.price - (after ? u.amount : 0), 0)) >= d.minimum.value;
}

type CompleteSet = { units: number[]; shares: number[]; ranks: number[] };
function bruteForceSets(d: DiscountDefinition, us: Unit[]): CompleteSet[] {
  const itemIds = [...d.itemIds].sort((a, b) => a - b);
  const choices = itemIds.map(id => us.map((u, index) => ({ u, index })).filter(({ u }) => u.item === id)
    .sort((a, b) => a.u.amount - b.u.amount || a.u.price - b.u.price || a.index - b.index));
  const tuples: CompleteSet[] = [];
  // Enumerate every tuple of actual units, then test C22's per-unit inequalities.
  // No group batching, cursor advancement, or "skip the losing group" from the engine.
  function cartesian(item: number, indices: number[], ranks: number[]) {
    if (item < choices.length) {
      choices[item].forEach(({ index }, rank) => cartesian(item + 1, [...indices, index], [...ranks, rank]));
      return;
    }
    const prices = indices.map(index => us[index].price);
    const shares = split(value(d, prices.reduce((s, p) => s + p, 0)), prices);
    if (indices.every((index, j) => shares[j] > us[index].amount ||
      shares[j] === us[index].amount && (us[index].owner === null || d.id < us[index].owner!))) {
      tuples.push({ units: indices, shares, ranks });
    }
  }
  cartesian(0, [], []);
  let best: CompleteSet[] = [];
  const lexEarlier = (a: number[], b: number[]) => {
    const different = a.findIndex((n, j) => n !== b[j]);
    return different >= 0 && a[different] < b[different];
  };
  // Enumerate disjoint complete-set packings. C22's stable least-loss ordering pairs
  // each item's ranked units in order; crossing those ranks would choose a different allocation.
  // Maximize count first, then choose the earliest ranked packing, never the largest monetary gain.
  function pack(start: number, current: CompleteSet[]) {
    if (current.length > best.length || current.length === best.length &&
      lexEarlier(current.flatMap(t => t.ranks), best.flatMap(t => t.ranks))) best = current;
    for (let n = start; n < tuples.length; n++) {
      const next = tuples[n], last = current.at(-1);
      if (last && next.ranks.some((rank, j) => rank <= last.ranks[j])) continue;
      pack(n + 1, [...current, next]);
    }
  }
  pack(0, []);
  return best;
}

function floorFromConstraints(effects: Effect[], selected: readonly DiscountDefinition[], subtotal: number): Effect[] {
  const priority = [...effects].sort((a, b) => Number(order(selected.find(d => d.id === a.id)!)) -
    Number(order(selected.find(d => d.id === b.id)!)) || a.id.localeCompare(b.id));
  const target = Math.min(subtotal - 50, effects.reduce((s, e) => s + e.amount, 0));
  const suffix = priority.map((_, j) => priority.slice(j).reduce((s, e) => s + e.amount, 0));
  // Solve 0<=kept[j]<=raw[j], sum(kept)=target. The lexicographically greatest
  // legal vector preserves products first, then low ids. This enumerates retained
  // amounts from the constraints, rather than reproducing the engine's trim/budget loop.
  function legalVector(j: number, left: number): number[] | null {
    if (j === priority.length) return left === 0 ? [] : null;
    if (left < 0 || left > suffix[j]) return null;
    for (let kept = Math.min(priority[j].amount, left); kept >= 0; kept--) {
      const tail = legalVector(j + 1, left - kept);
      if (tail !== null) return [kept, ...tail];
    }
    return null;
  }
  const kept = legalVector(0, target)!;
  return priority.map((e, j) => ({ ...e, amount: kept[j] })).filter(e => e.amount > 0);
}

export function oracleSubset(i: DiscountInput, selected: readonly DiscountDefinition[]): { discount: number; effects: Effect[] } {
  const us = units(i);
  const products = selected.filter(d => !order(d));
  for (const d of products.filter(d => d.kind !== 'set').sort((a, b) => a.id.localeCompare(b.id))) {
    if (!qualify(d, i, us, false)) continue;
    for (const u of us) if (target(d, u, i)) {
      const amount = value(d, u.price);
      if (amount > u.amount || (amount === u.amount && amount > 0 && d.id < (u.owner ?? '~'))) { u.amount = amount; u.owner = d.id; }
    }
  }
  for (const d of products.filter(d => d.kind === 'set')) {
    if (!qualify(d, i, us, false)) continue;
    for (const tuple of bruteForceSets(d, us)) tuple.units.forEach((index, j) => {
      us[index].amount = tuple.shares[j]; us[index].owner = d.id;
    });
  }
  const effects: Effect[] = [];
  for (const d of products) effects.push({ id: d.id, codeId: d.method === 'code' ? [...i.facts.usage].filter(f => f.discountId === d.id && i.codes.map(c => c.trim().toUpperCase()).includes(f.code ?? '')).sort((a, b) => (a.codeId ?? '').localeCompare(b.codeId ?? ''))[0]?.codeId ?? null : null,
    amount: us.filter(u => u.owner === d.id).reduce((s, u) => s + u.amount, 0) });
  const base = us.reduce((s, u) => s + u.price - u.amount, 0);
  for (const d of selected.filter(order)) if (qualify(d, i, us, true)) effects.push({ id: d.id,
    codeId: d.method === 'code' ? i.facts.usage.find(f => f.discountId === d.id)?.codeId ?? null : null, amount: value(d, base) });
  const retained = floorFromConstraints(effects, selected, us.reduce((s, u) => s + u.price, 0));
  return { discount: retained.reduce((s, e) => s + e.amount, 0), effects: retained.sort((a, b) => a.id.localeCompare(b.id)) };
}
export function oracle(i: DiscountInput): ReturnType<typeof oracleSubset> {
  let best = oracleSubset(i, []);
  for (let mask = 1; mask < 2 ** i.discounts.length; mask++) {
    const selected = i.discounts.filter((_, j) => mask & (2 ** j));
    if (selected.some(a => selected.some(b => a !== b && (!(order(b) ? a.combinesWithOrder : a.combinesWithProduct) || !(order(a) ? b.combinesWithOrder : b.combinesWithProduct))))) continue;
    const next = oracleSubset(i, selected);
    const codes = (v: typeof best) => v.effects.filter(e => e.codeId).length;
    const key = (v: typeof best) => v.effects.map(e => `${e.id}/${e.codeId ?? ''}`).join('|');
    const tieWins = codes(next) < codes(best) || (codes(next) === codes(best) &&
      (next.effects.length < best.effects.length || (next.effects.length === best.effects.length && key(next) < key(best))));
    if (next.discount > best.discount || next.discount === best.discount && tieWins) best = next;
  }
  return best;
}
