import { evaluateEligibility } from './discount-eligibility';
import { expandDiscountPlan } from './discount-allocation';
import { buildProductCandidates, createProductEvaluator, effectFor, eligibleCodeId } from './discount-products';
import { compareIds, discountClass, discountValue, MAX_DISCOUNT_COMBINATIONS, MAX_DISCOUNT_PRODUCT_PLANS, MIN_CHECKOUT_TOTAL,
  validateDiscountInput, type DiscountDefinition, type DiscountEffect, type DiscountInput, type DiscountResult, type DiscountSearchGuard,
  type ProductCandidate } from './discount-types';

type Side = { indices: number[]; cross: boolean };
function sides(definitions: readonly DiscountDefinition[], cls: 'product' | 'order', maximal: boolean, crossing = false): Side[] {
  const same = (d: DiscountDefinition) => cls === 'product' ? d.combinesWithProduct : d.combinesWithOrder;
  const cross = (d: DiscountDefinition) => cls === 'product' ? d.combinesWithOrder : d.combinesWithProduct;
  const stack: number[] = [], singles: number[] = [];
  definitions.forEach((d, n) => { if (!crossing || cross(d)) (same(d) ? stack : singles).push(n); });
  const out: Side[] = [{ indices: [], cross: true }];
  if (maximal) {
    if (stack.length) out.push({ indices: stack, cross: stack.every(n => cross(definitions[n])) });
  } else {
    for (let mask = 1; mask < 2 ** stack.length; mask++) {
      const indices = stack.filter((_, j) => mask & 2 ** j);
      out.push({ indices, cross: indices.every(n => cross(definitions[n])) });
    }
  }
  for (const n of singles) out.push({ indices: [n], cross: cross(definitions[n]) });
  return out;
}
function trimEffects(products: readonly DiscountEffect[], orders: readonly DiscountEffect[], cap: number): DiscountEffect[] {
  let available = cap;
  const keep: DiscountEffect[] = [];
  // Keeping ascending ids is equivalent to trimming descending ids, order class first.
  for (const e of [...products, ...orders]) {
    const amount = Math.min(e.amount, available); available -= amount;
    if (amount > 0) keep.push(amount === e.amount ? e : { ...e, amount });
  }
  return keep;
}
function isBetter(next: readonly DiscountEffect[], best: readonly DiscountEffect[]): boolean {
  const codes = (es: readonly DiscountEffect[]) => es.reduce((s, e) => s + Number(e.codeId !== null), 0);
  const nc = codes(next), bc = codes(best);
  if (nc !== bc) return nc < bc;
  if (next.length !== best.length) return next.length < best.length;
  const sorted = (es: readonly DiscountEffect[]) => [...es].sort((a, b) => compareIds(a.discountId, b.discountId) || compareIds(a.codeId ?? '', b.codeId ?? ''));
  const a = sorted(next), b = sorted(best);
  for (let j = 0; j < a.length; j++) {
    const cmp = compareIds(a[j].discountId, b[j].discountId) || compareIds(a[j].codeId ?? '', b[j].codeId ?? '');
    if (cmp) return cmp < 0;
  }
  return false;
}

/** Exact enumeration is over discount sets only. Guard fallback evaluates complete, compatible plans. */
export function searchBestDiscountPlan(raw: DiscountInput, guard: DiscountSearchGuard = { maxProductPlans: MAX_DISCOUNT_PRODUCT_PLANS, maxCombinations: MAX_DISCOUNT_COMBINATIONS }): DiscountResult {
  const input = validateDiscountInput(raw);
  const subtotal = input.lines.reduce((s, l) => s + (l.lineKind === 'order' ? l.unitPrice * l.quantity : 0), 0);
  const cap = subtotal - MIN_CHECKOUT_TOTAL;
  const definitions = new Map(input.discounts.map(d => [d.id, d]));
  const candidates = buildProductCandidates(input);
  const products = candidates.map(c => definitions.get(c.discountId)!);
  const orders = input.discounts.filter(d => discountClass(d) === 'order' && eligibleCodeId(d, input) !== undefined).sort((a, b) => compareIds(a.id, b.id));
  const orderTemplates = orders.map(d => effectFor(d, input, eligibleCodeId(d, input)));
  const productSides = sides(products, 'product', false), orderSides = sides(orders, 'order', false);
  const fallback = productSides.length > guard.maxProductPlans || productSides.length * orderSides.length > guard.maxCombinations;
  const evaluate = createProductEvaluator(input, candidates);
  let bestPlan = evaluate([]), bestEffects: readonly DiscountEffect[] = [], bestAmount = 0;
  const quantity = input.lines.reduce((s, l) => s + (l.lineKind === 'order' ? l.quantity : 0), 0);

  function visit(ps: readonly Side[], os: readonly Side[]) {
    for (const p of ps) {
      const selected: ProductCandidate[] = p.indices.map(n => candidates[n]);
      const plan = evaluate(selected);
      const productAmount = plan.effects.reduce((s, e) => s + e.amount, 0);
      const base = subtotal - productAmount;
      // At most eleven BigInt percentage calculations per product set, never per pair of sets.
      const orderAmounts = orders.map(d => d.minimum.type === 'amount' && base < d.minimum.value || d.minimum.type === 'quantity' && quantity < d.minimum.value ? 0 : discountValue(d, base));
      for (const o of os) {
        if (p.indices.length && o.indices.length && (!p.cross || !o.cross)) continue;
        let amount = productAmount;
        for (const n of o.indices) amount += orderAmounts[n];
        amount = Math.min(cap, amount);
        if (amount < bestAmount) continue;
        const effects = trimEffects(plan.effects, o.indices.flatMap(n => orderAmounts[n] > 0 ? [{ ...orderTemplates[n], amount: orderAmounts[n] }] : []), cap);
        if (amount > bestAmount || isBetter(effects, bestEffects)) { bestAmount = amount; bestEffects = effects; bestPlan = plan; }
      }
    }
  }
  if (!fallback) visit(productSides, orderSides);
  else {
    const empty: Side = { indices: [], cross: true };
    // Every single-discount plan is evaluated, including stackable definitions omitted by maximal sets.
    visit([empty, ...products.map((_, n) => ({ indices: [n], cross: true }))], [empty]);
    visit([empty], [empty, ...orders.map((_, n) => ({ indices: [n], cross: true }))]);
    visit(sides(products, 'product', true), [empty]);
    visit([empty], sides(orders, 'order', true));
    visit(sides(products, 'product', true, true), sides(orders, 'order', true, true));
  }
  const applied = [...bestEffects].sort((a, b) => Number(a.class === 'order') - Number(b.class === 'order') || compareIds(a.discountId, b.discountId));
  const usedCodes = new Set(applied.flatMap(e => e.code === null ? [] : [e.code]));
  const provisional = applied.some(e => evaluateEligibility(definitions.get(e.discountId)!, input, e.codeId).provisional);
  return { version: 1, subtotalAmount: subtotal, shippingAmount: 0, discountAmount: bestAmount, totalAmount: subtotal - bestAmount,
    applied, ...expandDiscountPlan(input, bestPlan, applied), unusedCodes: input.codes.filter(c => !usedCodes.has(c)), provisional,
    calculationMode: fallback ? 'fallback' : 'exact' };
}
