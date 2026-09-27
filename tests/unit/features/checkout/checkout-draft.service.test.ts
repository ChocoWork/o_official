import { mapStripePaymentMethodType } from '@/features/checkout/services/checkout-draft.service';

describe('mapStripePaymentMethodType（レビュー指摘 C1）', () => {
  it('card は stripe_card に正規化する', () => {
    expect(mapStripePaymentMethodType('card')).toBe('stripe_card');
  });

  it('paypay は stripe_paypay に正規化する', () => {
    expect(mapStripePaymentMethodType('paypay')).toBe('stripe_paypay');
  });

  it('konbini は stripe_konbini に正規化する', () => {
    expect(mapStripePaymentMethodType('konbini')).toBe('stripe_konbini');
  });

  it('未対応の種別（link 等）は stripe_card に丸めず raw の文字列をそのまま返す', () => {
    expect(mapStripePaymentMethodType('link')).toBe('link');
    expect(mapStripePaymentMethodType('customer_balance')).toBe('customer_balance');
    expect(mapStripePaymentMethodType('alipay')).toBe('alipay');
  });

  it('値が無ければ既定値 stripe_card を返す', () => {
    expect(mapStripePaymentMethodType(undefined)).toBe('stripe_card');
  });
});
