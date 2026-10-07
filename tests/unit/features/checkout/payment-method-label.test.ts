import { mapPaymentMethodLabel } from '@/features/checkout/services/payment-method.service';

describe('mapPaymentMethodLabel（レビュー指摘 C1）', () => {
  it('stripe_card はクレジットカードと表示する', () => {
    expect(mapPaymentMethodLabel('stripe_card')).toBe('クレジットカード');
  });

  it('stripe_konbini はコンビニ払いと表示する', () => {
    expect(mapPaymentMethodLabel('stripe_konbini')).toBe('コンビニ払い');
  });

  it('stripe_paypay は PayPay と表示する', () => {
    expect(mapPaymentMethodLabel('stripe_paypay')).toBe('PayPay');
  });

  it('link は Link と表示する', () => {
    expect(mapPaymentMethodLabel('link')).toBe('Link');
  });

  it('customer_balance は銀行振込と表示する', () => {
    expect(mapPaymentMethodLabel('customer_balance')).toBe('銀行振込');
  });

  it('未知の値は丸めずそのまま表示する（stripe_card への丸め込みをしない）', () => {
    expect(mapPaymentMethodLabel('alipay')).toBe('alipay');
  });

  it('null / undefined / 空文字は - を表示する', () => {
    expect(mapPaymentMethodLabel(null)).toBe('-');
    expect(mapPaymentMethodLabel(undefined)).toBe('-');
    expect(mapPaymentMethodLabel('')).toBe('-');
  });
});
