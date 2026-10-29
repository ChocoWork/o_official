import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { evaluateCheckoutDiscounts, loadCheckoutDiscountContext } from '@/features/checkout/services/checkout-discounts.service';
import { targetsItem } from './discount-eligibility';
import { compareIds, type DiscountBuyer, type DiscountDefinition, type DiscountLine, type DiscountResult } from './discount-types';

/** Guest previews never use the typed email or any purchase history; members keep their verified id. */
function previewBuyer(buyer: DiscountBuyer): DiscountBuyer {
  return buyer.kind === 'guest' ? { kind: 'guest', normalizedEmail: null } : buyer;
}

/**
 * Cart preview: automatic discounts only (no codes). Guest first-order and once-per-customer
 * discounts stay provisional because no history is read before confirm.
 * A search guard still yields the fully evaluated fallback amount, and the shared evaluator
 * records the attention item once; this never fails the cart.
 */
export async function previewAutomaticDiscounts(
  client: SupabaseClient, buyer: DiscountBuyer, lines: readonly DiscountLine[], at: string,
): Promise<DiscountResult> {
  return (await evaluateCheckoutDiscounts(client, previewBuyer(buyer), lines, [], at, 'preview')).result;
}

function isAdvertisable(d: DiscountDefinition, buyer: DiscountBuyer, itemId: number, at: number): boolean {
  if (d.method !== 'automatic' || !d.advertise || d.stopped || !d.advertisingText?.trim()) return false;
  if (at < Date.parse(d.startsAt) || (d.endsAt !== null && at >= Date.parse(d.endsAt))) return false;
  if (!targetsItem(d, itemId)) return false;
  // Condition A (a previous purchase) can only be met by a verified member. Guests never see it.
  return buyer.kind === 'member' || (d.allowGuests && !(d.kind === 'repeat' && d.repeatPrevious));
}

/** One short management sentence per active automatic discount that advertises itself for this item. */
export async function listDiscountAdvertisements(
  client: SupabaseClient, buyer: DiscountBuyer, itemId: number, at: string,
): Promise<{ discountId: string; text: string }[]> {
  const safeBuyer = previewBuyer(buyer);
  const context = await loadCheckoutDiscountContext(client, safeBuyer, [], [itemId], at, 'preview');
  const now = Date.parse(at);
  return context.discounts
    .filter(d => isAdvertisable(d, safeBuyer, itemId, now))
    .sort((a, b) => compareIds(a.id, b.id))
    .map(d => ({ discountId: d.id, text: d.advertisingText as string }));
}
