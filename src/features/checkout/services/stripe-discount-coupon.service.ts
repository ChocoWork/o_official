import 'server-only';
import type Stripe from 'stripe';

/** The persisted draft/hash pair is also Stripe's idempotency boundary. */
export async function createStripeDiscountCoupon(stripe: Stripe, draftId: string, snapshotHash: string, amount: number): Promise<string | null> {
  if (!Number.isInteger(amount) || amount < 0 || amount > 2147483647) throw new Error('Invalid discount amount');
  if (amount === 0) return null;
  const coupon = await stripe.coupons.create({
    amount_off: amount, currency: 'jpy', duration: 'once', max_redemptions: 1, metadata: { checkout_draft_id: draftId },
  }, { idempotencyKey: 'h-discount:' + draftId + ':' + snapshotHash });
  return coupon.id;
}
