import { z } from 'zod';
import type { DiscountBuyer, DiscountDefinition, DiscountFacts, DiscountRefusal } from '@/lib/discounts/discount-types';
import { promotionRefusalMessage } from '@/lib/discounts/discount-messages';

export const PROMOTION_CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Normalize before the five-code limit, so repeated entries do not consume slots. */
export const promotionCodesSchema = z.array(z.string().trim().regex(PROMOTION_CODE_PATTERN).transform(s => s.toUpperCase()))
  .transform(codes => [...new Set(codes)]).refine(codes => codes.length <= 5);

function isPublic(code: string, discounts: readonly DiscountDefinition[], facts: DiscountFacts): boolean {
  const u = facts.usage.find(u => u.code === code);
  const d = discounts.find(d => d.id === u?.discountId);
  return Boolean(d && d.audience === 'anyone' && d.allowGuests && u?.audience === 'anyone' && u.allowGuests);
}

/** Keep only caller-entered code and the public refusal contract, never existence metadata. */
export function publicDiscountRefusals(buyer: DiscountBuyer, refusals: readonly DiscountRefusal[], discounts: readonly DiscountDefinition[], facts: DiscountFacts): DiscountRefusal[] {
  // A reason-dependent order would reveal which entered codes exist, even after masking.
  return refusals.map<DiscountRefusal>(r => buyer.kind === 'guest' || !isPublic(r.code, discounts, facts)
    ? { code: r.code, reason: 'not_eligible' } : { code: r.code, reason: r.reason, ...(r.minimumAmount === undefined ? {} : { minimumAmount: r.minimumAmount }) })
    .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

export function checkoutPromotionRefusalMessage(buyer: DiscountBuyer, refusal: DiscountRefusal): string {
  if (buyer.kind === 'member' && refusal.reason === 'zero_total') return 'このコードでは合計が0円になるため使えません';
  return promotionRefusalMessage(refusal, buyer.kind === 'guest' ? 'guest' : 'public');
}
