import {
  ReconcileTransientError,
  readCheckoutPayment,
  type CheckoutPaymentStripeClient,
} from '@/lib/stripe/checkout-payment-reader';

/**
 * Stripe の現在値を読み、判定表の行に分ける（設計書 3-1）。Stripe へは書かない。
 */
function paymentIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_1',
    status: 'succeeded',
    amount_received: 5000,
    currency: 'jpy',
    payment_method_types: ['card'],
    payment_method: { type: 'card' },
    latest_charge: { amount_refunded: 0, payment_method_details: { type: 'card' } },
    next_action: null,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_1',
    status: 'complete',
    payment_status: 'paid',
    created: 1_790_000_000,
    amount_total: 5000,
    currency: 'jpy',
    total_details: { amount_discount: 0 },
    metadata: { draft_id: 'draft-1', session_id: 'cart-1', selected_payment_method: 'stripe_card' },
    payment_intent: paymentIntent(),
    ...overrides,
  };
}

function stripeError(code: string) {
  return Object.assign(new Error(code), { type: 'StripeInvalidRequestError', code });
}

/** `type`/`statusCode` を持つ Stripe SDK のエラーを模す（`stripe.errors.StripeError` の形） */
function stripeTypedError(props: { type?: string; statusCode?: number }) {
  return Object.assign(new Error('stripe error'), props);
}

function client(options: {
  retrieve?: jest.Mock;
  list?: jest.Mock;
  retrievePaymentIntent?: jest.Mock;
} = {}) {
  const retrieve = options.retrieve ?? jest.fn().mockResolvedValue(session());
  const list = options.list ?? jest.fn().mockResolvedValue({ data: [] });
  const retrievePaymentIntent = options.retrievePaymentIntent ?? jest.fn().mockResolvedValue(paymentIntent());
  return {
    stripe: {
      checkout: { sessions: { retrieve, list } },
      paymentIntents: { retrieve: retrievePaymentIntent },
    } as unknown as CheckoutPaymentStripeClient,
    retrieve,
    list,
    retrievePaymentIntent,
  };
}

async function stateOf(sessionOverrides: Record<string, unknown>) {
  const { stripe } = client({ retrieve: jest.fn().mockResolvedValue(session(sessionOverrides)) });
  return (await readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' })).state;
}

describe('readCheckoutPayment', () => {
  it('Session ID で expand 付きに読み、判定と保存に使う項目をそろえる', async () => {
    const { stripe, retrieve } = client({
      retrieve: jest.fn().mockResolvedValue(session({
        amount_total: 4000,
        total_details: { amount_discount: 1000 },
      })),
    });

    const snapshot = await readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' });

    expect(retrieve).toHaveBeenCalledWith('cs_1', {
      expand: ['payment_intent', 'payment_intent.payment_method', 'payment_intent.latest_charge'],
    });
    expect(snapshot).toEqual({
      checkoutSessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      draftId: 'draft-1',
      cartSessionId: 'cart-1',
      sessionCreatedAt: new Date(1_790_000_000 * 1000),
      amountTotal: 4000,
      amountDiscount: 1000,
      currency: 'jpy',
      paymentMethod: 'stripe_card',
      voucherExpiresAt: null,
      state: { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' },
    });
  });

  it.each([
    ['open', { status: 'open', payment_status: 'unpaid', payment_intent: null }, { kind: 'in_progress' }],
    ['expired', { status: 'expired', payment_status: 'unpaid', payment_intent: null }, { kind: 'checkout_abandoned' }],
    [
      'complete + unpaid + requires_action（払込票の発行）',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'requires_action' }) },
      { kind: 'awaiting_payment' },
    ],
    [
      'complete + unpaid + processing',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'processing' }) },
      { kind: 'awaiting_payment' },
    ],
    [
      'complete + unpaid + requires_payment_method（払込票の期限切れ）',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'requires_payment_method' }) },
      { kind: 'voucher_expired' },
    ],
    [
      'complete + unpaid + canceled',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'canceled' }) },
      { kind: 'voucher_expired' },
    ],
    [
      'complete + unpaid でも PaymentIntent が succeeded なら入金済み（Session の反映待ち）',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'succeeded' }) },
      { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' },
    ],
    ['complete + no_payment_required', { payment_status: 'no_payment_required', payment_intent: null }, { kind: 'zero_amount_complete' }],
    ['complete + paid で PaymentIntent が無い', { payment_intent: null }, { kind: 'not_applicable', reason: 'unexpected' }],
    [
      'complete + unpaid + requires_confirmation',
      { payment_status: 'unpaid', payment_intent: paymentIntent({ status: 'requires_confirmation' }) },
      { kind: 'not_applicable', reason: 'unexpected' },
    ],
    [
      '下書き ID が無くても Session と PaymentIntent の状態で分ける（対象外かは照合関数が注文の有無で決める）',
      { metadata: {} },
      { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' },
    ],
  ])('%s', async (_label, overrides, expected) => {
    expect(await stateOf(overrides)).toEqual(expected);
  });

  it('返金額は latest_charge の amount_refunded を使う', async () => {
    expect(await stateOf({
      payment_intent: paymentIntent({ latest_charge: { amount_refunded: 5000, payment_method_details: { type: 'card' } } }),
    })).toEqual({ kind: 'paid', amountReceived: 5000, amountRefunded: 5000, currency: 'jpy' });
  });

  it('コンビニの払込期限を読む', async () => {
    const { stripe } = client({
      retrieve: jest.fn().mockResolvedValue(session({
        payment_status: 'unpaid',
        payment_intent: paymentIntent({
          status: 'requires_action',
          payment_method_types: ['konbini'],
          payment_method: { type: 'konbini' },
          latest_charge: null,
          next_action: { type: 'konbini_display_details', konbini_display_details: { expires_at: 1_790_259_199 } },
        }),
      })),
    });

    const snapshot = await readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' });

    expect(snapshot.voucherExpiresAt).toEqual(new Date(1_790_259_199 * 1000));
    expect(snapshot.paymentMethod).toBe('stripe_konbini');
  });

  it('PaymentIntent ID だけなら、その PaymentIntent の Session を引く（Session ID を持たない古い注文）', async () => {
    const { stripe, list } = client({ list: jest.fn().mockResolvedValue({ data: [session()] }) });

    const snapshot = await readCheckoutPayment(stripe, { paymentIntentId: 'pi_1' });

    expect(list).toHaveBeenCalledWith({
      payment_intent: 'pi_1',
      limit: 1,
      expand: ['data.payment_intent', 'data.payment_intent.payment_method', 'data.payment_intent.latest_charge'],
    });
    expect(snapshot.checkoutSessionId).toBe('cs_1');
  });

  it('下書き ID の無い Session（移行前の注文）は draftId を null にし、状態で分ける', async () => {
    const legacy = session({
      metadata: {},
      payment_status: 'unpaid',
      payment_intent: paymentIntent({ status: 'requires_payment_method', amount_received: 0, latest_charge: null }),
    });
    const { stripe } = client({ list: jest.fn().mockResolvedValue({ data: [legacy] }) });

    const snapshot = await readCheckoutPayment(stripe, { paymentIntentId: 'pi_1' });

    expect(snapshot).toMatchObject({
      checkoutSessionId: 'cs_1',
      paymentIntentId: 'pi_1',
      draftId: null,
      cartSessionId: null,
      state: { kind: 'voucher_expired' },
    });
  });

  it('Checkout を通らない PaymentIntent は対象外（下書きなし）', async () => {
    const { stripe } = client();

    const snapshot = await readCheckoutPayment(stripe, { paymentIntentId: 'pi_direct' });

    expect(snapshot).toMatchObject({
      checkoutSessionId: null,
      paymentIntentId: 'pi_direct',
      state: { kind: 'not_applicable', reason: 'no_draft' },
    });
  });

  it('Session も PaymentIntent も resource_missing なら Stripe に無い', async () => {
    const bySession = client({ retrieve: jest.fn().mockRejectedValue(stripeError('resource_missing')) });
    const byIntent = client({ retrievePaymentIntent: jest.fn().mockRejectedValue(stripeError('resource_missing')) });

    expect(await readCheckoutPayment(bySession.stripe, { checkoutSessionId: 'cs_gone' })).toMatchObject({
      checkoutSessionId: 'cs_gone',
      state: { kind: 'missing' },
    });
    expect(await readCheckoutPayment(byIntent.stripe, { paymentIntentId: 'pi_gone' })).toMatchObject({
      paymentIntentId: 'pi_gone',
      state: { kind: 'missing' },
    });
  });

  it.each([
    ['通信エラー', stripeTypedError({ type: 'StripeConnectionError' })],
    ['回数制限（429）', stripeTypedError({ type: 'StripeRateLimitError', statusCode: 429 })],
    ['Stripe 側の 5xx', stripeTypedError({ type: 'StripeAPIError', statusCode: 500 })],
  ])('%s は一時的な失敗として投げる', async (_label, error) => {
    const { stripe } = client({ retrieve: jest.fn().mockRejectedValue(error) });

    await expect(readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' })).rejects.toMatchObject({
      name: 'ReconcileTransientError',
      code: 'stripe_unavailable',
    });
    await expect(readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' })).rejects.toBeInstanceOf(ReconcileTransientError);
  });

  it.each([
    ['認証エラー（401・鍵の失効/設定ミス）', stripeTypedError({ type: 'StripeAuthenticationError', statusCode: 401 })],
    ['コード側のバグ等（素の Error）', new Error('boom')],
  ])('%s は一時的な失敗にせず、そのまま投げる', async (_label, error) => {
    const { stripe } = client({ retrieve: jest.fn().mockRejectedValue(error) });

    await expect(readCheckoutPayment(stripe, { checkoutSessionId: 'cs_1' })).rejects.toBe(error);
  });

  it('ID が無ければ呼び出しの誤りとして投げる（一時的な失敗にしない）', async () => {
    const { stripe } = client();

    await expect(readCheckoutPayment(stripe, {})).rejects.toThrow('checkoutSessionId or paymentIntentId is required');
  });
});
