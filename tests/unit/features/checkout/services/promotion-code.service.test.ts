import type Stripe from 'stripe';
import {
  PROMOTION_CODE_PATTERN,
  checkPromotionCode,
} from '@/features/checkout/services/promotion-code.service';

const NOW = new Date('2026-10-08T00:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function coupon(overrides: Partial<Stripe.Coupon> = {}): Stripe.Coupon {
  return {
    id: 'coupon_1',
    object: 'coupon',
    amount_off: null,
    currency: null,
    percent_off: 10,
    valid: true,
    max_redemptions: null,
    times_redeemed: 0,
    redeem_by: null,
    duration: 'once',
    ...overrides,
  } as Stripe.Coupon;
}

function promotionCode(overrides: Partial<Stripe.PromotionCode> = {}, couponOverrides: Partial<Stripe.Coupon> = {}) {
  return {
    id: 'promo_1',
    object: 'promotion_code',
    active: true,
    code: 'WELCOME10',
    created: NOW_SECONDS - 100,
    customer: null,
    customer_account: null,
    expires_at: null,
    livemode: false,
    max_redemptions: null,
    metadata: {},
    promotion: { type: 'coupon', coupon: coupon(couponOverrides) },
    restrictions: {
      first_time_transaction: false,
      minimum_amount: null,
      minimum_amount_currency: null,
    },
    times_redeemed: 0,
    ...overrides,
  } as Stripe.PromotionCode;
}

function stripeReturning(codes: Stripe.PromotionCode[]) {
  const list = jest.fn().mockResolvedValue({ data: codes });
  return { client: { promotionCodes: { list } }, list };
}

describe('checkPromotionCode', () => {
  test('有効な定率のコードは、割引額と割引後の合計を返す。Stripe には有効なコードだけを1件、クーポンを展開して問い合わせる', async () => {
    const { client, list } = stripeReturning([promotionCode()]);

    const result = await checkPromotionCode(client, { code: 'welcome10', preDiscountTotal: 12345, now: NOW });

    expect(list).toHaveBeenCalledWith({
      code: 'welcome10',
      active: true,
      limit: 1,
      expand: ['data.promotion.coupon'],
    });
    expect(result).toEqual({
      ok: true,
      promotionCodeId: 'promo_1',
      code: 'WELCOME10',
      discountAmount: 1235,
      totalAfterDiscount: 11110,
    });
  });

  test('定額のコードは合計を超えて引かない', async () => {
    const { client } = stripeReturning([promotionCode({}, { percent_off: null, amount_off: 1000, currency: 'jpy' })]);

    const result = await checkPromotionCode(client, { code: 'OFF1000', preDiscountTotal: 5000, now: NOW });

    expect(result).toMatchObject({ ok: true, discountAmount: 1000, totalAfterDiscount: 4000 });
  });

  test('合計が0円になるコードは断る（R-28）', async () => {
    const { client } = stripeReturning([promotionCode({}, { percent_off: 100 })]);

    const result = await checkPromotionCode(client, { code: 'FREE', preDiscountTotal: 5000, now: NOW });

    expect(result).toEqual({ ok: false, reason: 'zero_total', message: 'このコードでは合計が0円になるため使えません' });
  });

  test('定額が合計以上でも0円として断る', async () => {
    const { client } = stripeReturning([promotionCode({}, { percent_off: null, amount_off: 6000, currency: 'jpy' })]);

    const result = await checkPromotionCode(client, { code: 'BIG', preDiscountTotal: 5000, now: NOW });

    expect(result).toMatchObject({ ok: false, reason: 'zero_total' });
  });

  test('見つからないコードは断る', async () => {
    const { client } = stripeReturning([]);

    const result = await checkPromotionCode(client, { code: 'NOPE', preDiscountTotal: 5000, now: NOW });

    expect(result).toEqual({ ok: false, reason: 'not_found', message: 'このコードは使えません' });
  });

  test('期限の切れたコード（コード・クーポンのどちらでも）は断る', async () => {
    const byCode = stripeReturning([promotionCode({ expires_at: NOW_SECONDS - 1 })]);
    const byCoupon = stripeReturning([promotionCode({}, { redeem_by: NOW_SECONDS - 1 })]);

    await expect(checkPromotionCode(byCode.client, { code: 'OLD', preDiscountTotal: 5000, now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'expired',
      message: 'このコードは有効期限が切れています',
    });
    await expect(
      checkPromotionCode(byCoupon.client, { code: 'OLD', preDiscountTotal: 5000, now: NOW }),
    ).resolves.toMatchObject({ ok: false, reason: 'expired' });
  });

  test('使える回数を使い切ったコード（コード・クーポンのどちらでも）は断る', async () => {
    const byCode = stripeReturning([promotionCode({ max_redemptions: 3, times_redeemed: 3 })]);
    const byCoupon = stripeReturning([promotionCode({}, { max_redemptions: 1, times_redeemed: 1 })]);

    await expect(checkPromotionCode(byCode.client, { code: 'MAX', preDiscountTotal: 5000, now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'redemption_limit',
      message: 'このコードは利用回数の上限に達しています',
    });
    await expect(
      checkPromotionCode(byCoupon.client, { code: 'MAX', preDiscountTotal: 5000, now: NOW }),
    ).resolves.toMatchObject({ ok: false, reason: 'redemption_limit' });
  });

  test('最低購入額に届かなければ、その額を添えて断る', async () => {
    const { client } = stripeReturning([
      promotionCode({
        restrictions: { first_time_transaction: false, minimum_amount: 10000, minimum_amount_currency: 'jpy' },
      }),
    ]);

    const result = await checkPromotionCode(client, { code: 'MIN', preDiscountTotal: 9999, now: NOW });

    expect(result).toEqual({
      ok: false,
      reason: 'minimum_amount',
      message: 'このコードは ¥10,000 以上のご注文で使えます',
    });
  });

  test('最低購入額は円の通貨ごとの設定も見る', async () => {
    const { client } = stripeReturning([
      promotionCode({
        restrictions: {
          first_time_transaction: false,
          minimum_amount: null,
          minimum_amount_currency: null,
          currency_options: { jpy: { minimum_amount: 8000 } },
        },
      }),
    ]);

    await expect(
      checkPromotionCode(client, { code: 'MIN', preDiscountTotal: 7999, now: NOW }),
    ).resolves.toMatchObject({ ok: false, reason: 'minimum_amount' });
    await expect(
      checkPromotionCode(client, { code: 'MIN', preDiscountTotal: 8000, now: NOW }),
    ).resolves.toMatchObject({ ok: true });
  });

  test('顧客・初回限定の条件、商品の限定、円で使えない定額は、確かめられないので断る（決め事 D6）', async () => {
    const cases = [
      promotionCode({ customer: 'cus_1' }),
      promotionCode({
        restrictions: { first_time_transaction: true, minimum_amount: null, minimum_amount_currency: null },
      }),
      promotionCode({}, { applies_to: { products: ['prod_1'] } }),
      promotionCode({}, { percent_off: null, amount_off: 10, currency: 'usd' }),
      promotionCode({}, { valid: false }),
    ];

    for (const code of cases) {
      const { client } = stripeReturning([code]);
      await expect(
        checkPromotionCode(client, { code: 'X', preDiscountTotal: 5000, now: NOW }),
      ).resolves.toEqual({ ok: false, reason: 'not_applicable', message: 'このコードは使えません' });
    }
  });

  test('円の通貨ごとの定額があれば、それを使う', async () => {
    const { client } = stripeReturning([
      promotionCode({}, { percent_off: null, amount_off: 10, currency: 'usd', currency_options: { jpy: { amount_off: 500 } } }),
    ]);

    await expect(
      checkPromotionCode(client, { code: 'MULTI', preDiscountTotal: 5000, now: NOW }),
    ).resolves.toMatchObject({ ok: true, discountAmount: 500, totalAfterDiscount: 4500 });
  });

  test('コードに使える文字だけを通す', () => {
    expect(PROMOTION_CODE_PATTERN.test('WELCOME-10')).toBe(true);
    expect(PROMOTION_CODE_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(PROMOTION_CODE_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(PROMOTION_CODE_PATTERN.test('SALE 10')).toBe(false);
    expect(PROMOTION_CODE_PATTERN.test('')).toBe(false);
  });
});
