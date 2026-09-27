import { z } from 'zod';
import { STRIPE_CHECKOUT_PAYMENT_METHODS } from '@/features/checkout/services/checkout-draft.service';
import {
  mapPaymentMethodLabel,
  toCheckoutRequestPaymentMethod,
  toRecordedPaymentMethod,
} from '@/features/checkout/services/payment-method.service';

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

describe('toRecordedPaymentMethod（FREQ-371）', () => {
  it.each([
    ['card', 'stripe_card'],
    ['paypay', 'stripe_paypay'],
    ['konbini', 'stripe_konbini'],
    ['link', 'link'],
    ['customer_balance', 'customer_balance'],
    ['alipay', 'alipay'],
  ])('決済フォームの %s を、注文に記録される %s にする', (selectedType, recorded) => {
    expect(toRecordedPaymentMethod(selectedType)).toBe(recorded);
  });

  it('Apple Pay / Google Pay はカードとして記録される値にする', () => {
    expect(toRecordedPaymentMethod('apple_pay')).toBe('stripe_card');
    expect(toRecordedPaymentMethod('google_pay')).toBe('stripe_card');
  });

  it('未選択（change イベントの前）はサーバの既定値と同じ stripe_card にする', () => {
    expect(toRecordedPaymentMethod(null)).toBe('stripe_card');
    expect(toRecordedPaymentMethod(undefined)).toBe('stripe_card');
  });
});

describe('確認画面の支払方法の表示（FREQ-371）', () => {
  it.each([
    ['card', 'クレジットカード'],
    ['paypay', 'PayPay'],
    ['konbini', 'コンビニ払い'],
    ['link', 'Link'],
    ['customer_balance', '銀行振込'],
    ['apple_pay', 'クレジットカード'],
    ['google_pay', 'クレジットカード'],
    ['alipay', 'alipay'],
  ])('決済フォームで %s を選ぶと、注文詳細と同じ「%s」を表示する', (selectedType, label) => {
    expect(mapPaymentMethodLabel(toRecordedPaymentMethod(selectedType))).toBe(label);
  });

  it.each(['link', 'customer_balance'])('%s をカードとして表示しない', (selectedType) => {
    expect(mapPaymentMethodLabel(toRecordedPaymentMethod(selectedType))).not.toBe('クレジットカード');
  });
});

describe('toCheckoutRequestPaymentMethod（FREQ-371）', () => {
  // create-session / complete の入力検証と同じ定義。ここを通らない値を送ると 400 になる。
  const requestSchema = z.enum(STRIPE_CHECKOUT_PAYMENT_METHODS).optional();

  it.each([
    ['card', 'stripe_card'],
    ['paypay', 'stripe_paypay'],
    ['konbini', 'stripe_konbini'],
    ['apple_pay', 'stripe_card'],
    ['google_pay', 'stripe_card'],
  ])('決済フォームの %s は %s として送る', (selectedType, sent) => {
    expect(toCheckoutRequestPaymentMethod(selectedType)).toBe(sent);
  });

  it.each(['link', 'customer_balance', 'alipay'])('API が受け付けない %s は送らない', (selectedType) => {
    expect(toCheckoutRequestPaymentMethod(selectedType)).toBeUndefined();
  });

  it('未選択はこれまでどおり stripe_card を送る', () => {
    expect(toCheckoutRequestPaymentMethod(null)).toBe('stripe_card');
  });

  it.each([
    'card',
    'paypay',
    'konbini',
    'link',
    'customer_balance',
    'apple_pay',
    'google_pay',
    'alipay',
    null,
  ])('決済フォームの %s を選んでも、API の入力検証を通る値だけを送る', (selectedType) => {
    expect(requestSchema.safeParse(toCheckoutRequestPaymentMethod(selectedType)).success).toBe(true);
  });
});
