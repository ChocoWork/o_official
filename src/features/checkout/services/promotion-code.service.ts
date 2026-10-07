import type Stripe from 'stripe';

/** Stripe のプロモーションコードに使える文字（英数字とハイフン） */
export const PROMOTION_CODE_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export type PromotionCodeRejection =
  | 'not_found'
  | 'not_applicable'
  | 'expired'
  | 'redemption_limit'
  | 'minimum_amount'
  | 'zero_total';

export type PromotionCodeCheck =
  | {
      ok: true;
      promotionCodeId: string;
      /** Stripe に登録された表記（入力の大文字・小文字は問わない） */
      code: string;
      discountAmount: number;
      totalAfterDiscount: number;
    }
  | { ok: false; reason: PromotionCodeRejection; message: string };

export type PromotionCodeClient = {
  promotionCodes: {
    list(params: Stripe.PromotionCodeListParams): Promise<{ data: Stripe.PromotionCode[] }>;
  };
};

const CURRENCY = 'jpy';

const MESSAGES: Record<Exclude<PromotionCodeRejection, 'minimum_amount'>, string> = {
  not_found: 'このコードは使えません',
  not_applicable: 'このコードは使えません',
  expired: 'このコードは有効期限が切れています',
  redemption_limit: 'このコードは利用回数の上限に達しています',
  zero_total: 'このコードでは合計が0円になるため使えません',
};

function reject(reason: Exclude<PromotionCodeRejection, 'minimum_amount'>): PromotionCodeCheck {
  return { ok: false, reason, message: MESSAGES[reason] };
}

function minimumAmountOf(code: Stripe.PromotionCode): number | null {
  const byCurrency = code.restrictions.currency_options?.[CURRENCY]?.minimum_amount;
  if (typeof byCurrency === 'number') {
    return byCurrency;
  }
  if (code.restrictions.minimum_amount !== null && code.restrictions.minimum_amount_currency?.toLowerCase() === CURRENCY) {
    return code.restrictions.minimum_amount;
  }
  return null;
}

/** 円で引ける定額。定額のクーポンでなければ undefined、円で使えなければ null */
function amountOffInYen(coupon: Stripe.Coupon): number | null | undefined {
  if (coupon.amount_off === null) {
    return undefined;
  }
  if (coupon.currency?.toLowerCase() === CURRENCY) {
    return coupon.amount_off;
  }
  return coupon.currency_options?.[CURRENCY]?.amount_off ?? null;
}

/**
 * 割引コードを、今のカートの割引前の合計で確かめる（グループ F 設計書第3章、計画の決め事 D6・D7）。
 *
 * 顧客を作らないので、顧客・初回限定の条件があるコードは確かめられず、断る（H で自前の確かめを足す）。
 * 決済の画面の明細はその場で作る商品なので、商品を限ったクーポンは当たらない。
 * 割引後の金額は目安で、最終確認画面は Stripe の金額を出す。
 */
export async function checkPromotionCode(
  stripe: PromotionCodeClient,
  params: { code: string; preDiscountTotal: number; now: Date },
): Promise<PromotionCodeCheck> {
  const list = await stripe.promotionCodes.list({
    code: params.code,
    active: true,
    limit: 1,
    expand: ['data.promotion.coupon'],
  });
  const promotion = list.data[0];
  const coupon = promotion && typeof promotion.promotion?.coupon === 'object' ? promotion.promotion.coupon : null;
  if (!promotion || !coupon) {
    return reject('not_found');
  }

  const nowSeconds = Math.floor(params.now.getTime() / 1000);
  if (
    (promotion.expires_at !== null && promotion.expires_at <= nowSeconds) ||
    (coupon.redeem_by !== null && coupon.redeem_by <= nowSeconds)
  ) {
    return reject('expired');
  }

  if (
    (promotion.max_redemptions !== null && promotion.times_redeemed >= promotion.max_redemptions) ||
    (coupon.max_redemptions !== null && coupon.times_redeemed >= coupon.max_redemptions)
  ) {
    return reject('redemption_limit');
  }

  if (
    !coupon.valid ||
    promotion.customer !== null ||
    promotion.customer_account !== null ||
    promotion.restrictions.first_time_transaction ||
    (coupon.applies_to?.products?.length ?? 0) > 0
  ) {
    return reject('not_applicable');
  }

  const minimum = minimumAmountOf(promotion);
  if (minimum !== null && params.preDiscountTotal < minimum) {
    return {
      ok: false,
      reason: 'minimum_amount',
      message: `このコードは ¥${minimum.toLocaleString('ja-JP')} 以上のご注文で使えます`,
    };
  }

  const amountOff = amountOffInYen(coupon);
  let discountAmount: number;
  if (amountOff === null) {
    return reject('not_applicable');
  } else if (amountOff !== undefined) {
    discountAmount = Math.min(amountOff, params.preDiscountTotal);
  } else if (coupon.percent_off !== null) {
    discountAmount = Math.min(params.preDiscountTotal, Math.round((params.preDiscountTotal * coupon.percent_off) / 100));
  } else {
    return reject('not_applicable');
  }

  const totalAfterDiscount = params.preDiscountTotal - discountAmount;
  if (totalAfterDiscount <= 0) {
    return reject('zero_total');
  }

  return { ok: true, promotionCodeId: promotion.id, code: promotion.code, discountAmount, totalAfterDiscount };
}
