import {
  resolvePaymentMethodFromPaymentIntent,
  resolvePaymentMethodFromSession,
} from '@/features/checkout/services/payment-method.service';

describe('resolvePaymentMethodFromSession', () => {
  it('tier1: charge の type を最優先する（types と食い違っても charge が勝つ）', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: {
        payment_method_types: ['card'],
        payment_method: { type: 'card' },
        latest_charge: { payment_method_details: { type: 'paypay' } },
      },
    });

    expect(result).toBe('stripe_paypay');
  });

  it('tier2: charge が無ければ payment_intent.payment_method.type を優先する（types と食い違っても勝つ）', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: {
        payment_method_types: ['card'],
        payment_method: { type: 'konbini' },
        latest_charge: null,
      },
    });

    expect(result).toBe('stripe_konbini');
  });

  it('tier3: charge も payment_method も無ければ payment_method_types[0] を使う', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: {
        payment_method_types: ['konbini', 'card'],
        payment_method: null,
        latest_charge: null,
      },
    });

    expect(result).toBe('stripe_konbini');
  });

  it('tier4: PaymentIntent の情報が何も無ければ session metadata の selected_payment_method を使う', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: null,
      metadata: { selected_payment_method: 'stripe_paypay' },
    });

    expect(result).toBe('stripe_paypay');
  });

  it('tier5: 何も解決できなければ既定値 stripe_card を返す', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: null,
      metadata: {},
    });

    expect(result).toBe('stripe_card');
  });

  it('metadata の selected_payment_method が既知の値でなければ既定値へ落ちる', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: null,
      metadata: { selected_payment_method: 'auto' },
    });

    expect(result).toBe('stripe_card');
  });

  it('payment_intent が文字列 ID（expand 失敗）の場合は無いものとして扱い metadata へ落ちる', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: 'pi_not_expanded',
      metadata: { selected_payment_method: 'stripe_konbini' },
    });

    expect(result).toBe('stripe_konbini');
  });

  it('payment_intent.payment_method が文字列 ID（expand 失敗）の場合は無いものとして扱い types へ落ちる', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: {
        payment_method_types: ['paypay'],
        payment_method: 'pm_not_expanded',
        latest_charge: null,
      },
    });

    expect(result).toBe('stripe_paypay');
  });

  it('latest_charge が文字列 ID（expand 失敗）の場合は無いものとして扱い payment_method へ落ちる', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: {
        payment_method_types: ['card'],
        payment_method: { type: 'konbini' },
        latest_charge: 'ch_not_expanded',
      },
    });

    expect(result).toBe('stripe_konbini');
  });

  it('未対応の Stripe 決済手段は丸めず raw の種別文字列をそのまま返す（レビュー指摘 C1）', () => {
    const result = resolvePaymentMethodFromSession({
      payment_intent: {
        payment_method_types: ['link'],
        payment_method: null,
        latest_charge: null,
      },
    });

    expect(result).toBe('link');
  });
});

describe('resolvePaymentMethodFromPaymentIntent', () => {
  it('tier1: charge の type を最優先する（types と食い違っても charge が勝つ）', () => {
    const result = resolvePaymentMethodFromPaymentIntent({
      payment_method_types: ['card'],
      payment_method: { type: 'card' },
      latest_charge: { payment_method_details: { type: 'paypay' } },
    });

    expect(result).toBe('stripe_paypay');
  });

  it('tier2: charge が無ければ payment_method.type を優先する（types と食い違っても勝つ）', () => {
    const result = resolvePaymentMethodFromPaymentIntent({
      payment_method_types: ['card'],
      payment_method: { type: 'konbini' },
      latest_charge: null,
    });

    expect(result).toBe('stripe_konbini');
  });

  it('tier3: charge も payment_method も無ければ payment_method_types[0] を使う', () => {
    const result = resolvePaymentMethodFromPaymentIntent({
      payment_method_types: ['konbini', 'card'],
      payment_method: null,
      latest_charge: null,
    });

    expect(result).toBe('stripe_konbini');
  });

  it('tier4: 何も解決できなければ既定値 stripe_card を返す（session metadata 相当の段は無い）', () => {
    const result = resolvePaymentMethodFromPaymentIntent({
      payment_method_types: [],
      payment_method: null,
      latest_charge: null,
    });

    expect(result).toBe('stripe_card');
  });

  it('payment_method が文字列 ID（expand 失敗）の場合は無いものとして扱い types へ落ちる', () => {
    const result = resolvePaymentMethodFromPaymentIntent({
      payment_method_types: ['paypay'],
      payment_method: 'pm_not_expanded',
      latest_charge: null,
    });

    expect(result).toBe('stripe_paypay');
  });

  it('latest_charge が文字列 ID（expand 失敗）の場合は無いものとして扱い payment_method へ落ちる', () => {
    const result = resolvePaymentMethodFromPaymentIntent({
      payment_method_types: ['card'],
      payment_method: { type: 'konbini' },
      latest_charge: 'ch_not_expanded',
    });

    expect(result).toBe('stripe_konbini');
  });

  it('未対応の Stripe 決済手段は丸めず raw の種別文字列をそのまま返す（レビュー指摘 C1）', () => {
    const result = resolvePaymentMethodFromPaymentIntent({
      payment_method_types: ['link'],
      payment_method: null,
      latest_charge: null,
    });

    expect(result).toBe('link');
  });

  it('customer_balance のような別の未対応手段も丸めずそのまま返す', () => {
    const result = resolvePaymentMethodFromPaymentIntent({
      payment_method_types: ['customer_balance'],
      payment_method: null,
      latest_charge: null,
    });

    expect(result).toBe('customer_balance');
  });
});
