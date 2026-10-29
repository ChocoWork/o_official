import type Stripe from 'stripe';
import { createStripeDiscountCoupon } from '@/features/checkout/services/stripe-discount-coupon.service';
jest.mock('server-only', () => ({}), { virtual: true });

test('FREQ-548-AC-03: 割引合計だけのonce couponを１つ付け旧Stripeコードを検索しない', async () => {
  const create = jest.fn().mockResolvedValue({ id: 'coupon_one' });
  const list = jest.fn();
  const stripe = { coupons: { create }, promotionCodes: { list } } as unknown as Stripe;
  expect(await createStripeDiscountCoupon(stripe, 'draft', 'hash', 3000)).toBe('coupon_one');
  expect(create).toHaveBeenCalledWith({ amount_off: 3000, currency: 'jpy', duration: 'once', max_redemptions: 1, metadata: { checkout_draft_id: 'draft' } }, { idempotencyKey: 'h-discount:draft:hash' });
  await createStripeDiscountCoupon(stripe, 'draft', 'hash', 3000);
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  expect(await createStripeDiscountCoupon(stripe, 'draft', 'hash', 0)).toBeNull();
  expect(create).toHaveBeenCalledTimes(2);
  expect(list).not.toHaveBeenCalled();
});

test.each([-1, 0.5, 2147483648, NaN])('FREQ-548-AC-03: 不正額 %s でcouponを作らない', async amount => {
  const create = jest.fn();
  await expect(createStripeDiscountCoupon({ coupons: { create } } as unknown as Stripe, 'draft', 'hash', amount)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
