import { eligibleCodeId, effectFor } from './discount-products';
import { compareIds, discountClass, discountValue, type DiscountDefinition, type DiscountEffect, type DiscountInput, type ProductPlan } from './discount-types';

/** All order effects share the same post-product base, including mixed amount and percent effects. */
export function calculateOrderEffects(input: DiscountInput, productPlan: ProductPlan, selected: readonly DiscountDefinition[]): readonly DiscountEffect[] {
  const base = Object.values(productPlan.remaining).reduce((s, n) => s + n, 0);
  const quantity = input.lines.reduce((s, l) => s + (l.lineKind === 'order' ? l.quantity : 0), 0);
  return [...selected].sort((a, b) => compareIds(a.id, b.id)).flatMap(d => {
    if (discountClass(d) !== 'order' || d.minimum.type === 'amount' && base < d.minimum.value || d.minimum.type === 'quantity' && quantity < d.minimum.value) return [];
    const codeId = eligibleCodeId(d, input);
    if (codeId === undefined) return [];
    const amount = discountValue(d, base);
    return amount > 0 ? [{ ...effectFor(d, input, codeId), amount }] : [];
  });
}
