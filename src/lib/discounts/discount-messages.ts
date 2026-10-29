import type { DiscountRefusal } from './discount-types';

export const GUEST_DISCOUNT_REFUSAL_MESSAGE = 'このコードは使えません。会員の方はログインしてからお試しください。';
export const BETTER_DISCOUNT_MESSAGE = 'このコードは今の割引と一緒には使えません。よりお得な割引を適用しています。';

/** The caller supplies visibility from trusted code metadata, never the refusal reason. */
export function promotionRefusalMessage(refusal: DiscountRefusal, visibility: 'guest' | 'restricted' | 'public'): string {
  if (visibility === 'guest') return GUEST_DISCOUNT_REFUSAL_MESSAGE;
  if (visibility === 'restricted') return 'このコードは使えません';
  if (refusal.reason === 'expired') return 'このコードは有効期限が切れています';
  if (refusal.reason === 'usage_limit') return 'このコードは利用回数の上限に達しています';
  if (refusal.reason === 'minimum_amount' && refusal.minimumAmount !== undefined) return `このコードは ¥${refusal.minimumAmount.toLocaleString('ja-JP')} 以上のご注文で使えます`;
  return 'このコードは使えません';
}
