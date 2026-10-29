import { checkoutPromotionRefusalMessage, promotionCodesSchema, publicDiscountRefusals } from '@/features/checkout/services/promotion-code.service';
import { definition, input, usage } from '../../../lib/discounts/fixtures';
import type { DiscountRefusal } from '@/lib/discounts/discount-types';

test('FREQ-548-AC-01: 未ログインの使えないコードは全理由が同じ文と理由で存在を区別できない', () => {
  const guest = { kind: 'guest' as const, normalizedEmail: null };
  const member = { kind: 'member' as const, userId: 'member' };
  const refusals: DiscountRefusal[] = ['not_found','not_eligible','expired','usage_limit','minimum_amount','minimum_quantity','zero_total'].map(reason => ({ code: 'CODE', reason: reason as DiscountRefusal['reason'], minimumAmount: 10000 }));
  for (const restricted of [true, false]) {
    const d = definition('d', { method: 'code', audience: restricted ? 'assigned' : 'anyone', allowGuests: !restricted });
    const f = { ...input([d]).facts, usage: [usage(d, { code: 'CODE' })] };
    for (const r of refusals) {
      expect(publicDiscountRefusals(guest, [r], [d], f)).toEqual([{ code: 'CODE', reason: 'not_eligible' }]);
      expect(checkoutPromotionRefusalMessage(guest, publicDiscountRefusals(guest, [r], [d], f)[0])).toBe('このコードは使えません。会員の方はログインしてからお試しください。');
      const visible = publicDiscountRefusals(member, [r], [d], f)[0];
      if (restricted) { expect(visible).toEqual({ code: 'CODE', reason: 'not_eligible' }); expect(checkoutPromotionRefusalMessage(member, visible)).toBe('このコードは使えません'); }
      else expect(visible).toEqual(r);
    }
  }
  expect(checkoutPromotionRefusalMessage(member, { code: 'CODE', reason: 'expired' })).toBe('このコードは有効期限が切れています');
  expect(checkoutPromotionRefusalMessage(member, { code: 'CODE', reason: 'usage_limit' })).toBe('このコードは利用回数の上限に達しています');
  expect(checkoutPromotionRefusalMessage(member, { code: 'CODE', reason: 'minimum_amount', minimumAmount: 10000 })).toBe('このコードは ¥10,000 以上のご注文で使えます');
  expect(checkoutPromotionRefusalMessage(member, { code: 'CODE', reason: 'zero_total' })).toBe('このコードでは合計が0円になるため使えません');
});

test('FREQ-548-AC-01: 正規化後５コードまでを許し形式と未知キーを分ける', () => {
  expect(promotionCodesSchema.parse([' a ', 'A', 'b'])).toEqual(['A','B']);
  expect(promotionCodesSchema.parse([])).toEqual([]);
  for (const value of [['A','B','C','D','E','F'], [''], ['A B'], ['あ'], ['A'.repeat(65)]]) expect(promotionCodesSchema.safeParse(value).success).toBe(false);
});