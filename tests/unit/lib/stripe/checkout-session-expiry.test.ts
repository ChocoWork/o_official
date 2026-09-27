import type Stripe from 'stripe';
import {
  expireCheckoutSessionForPaymentIntent,
  isPendingCheckoutPaymentIntentStatus,
} from '@/lib/stripe/checkout-session-expiry';

const retrieve = jest.fn();
const list = jest.fn();
const expire = jest.fn();

const stripe = {
  checkout: {
    sessions: { retrieve, list, expire },
  },
} as unknown as Stripe;

function session(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: 'cs_1',
    object: 'checkout.session',
    status: 'open',
    payment_status: 'unpaid',
    payment_intent: 'pi_1',
    ...overrides,
  } as Stripe.Checkout.Session;
}

describe('expireCheckoutSessionForPaymentIntent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Checkout の非終端 PaymentIntent 状態だけを失効候補にする', () => {
    expect(isPendingCheckoutPaymentIntentStatus('requires_payment_method')).toBe(true);
    expect(isPendingCheckoutPaymentIntentStatus('requires_confirmation')).toBe(true);
    expect(isPendingCheckoutPaymentIntentStatus('requires_action')).toBe(true);
    expect(isPendingCheckoutPaymentIntentStatus('requires_capture')).toBe(true);
    expect(isPendingCheckoutPaymentIntentStatus('processing')).toBe(false);
    expect(isPendingCheckoutPaymentIntentStatus('succeeded')).toBe(false);
    expect(isPendingCheckoutPaymentIntentStatus('canceled')).toBe(false);
  });

  test('関連する open/unpaid Session を冪等キー付きで expire する', async () => {
    retrieve.mockResolvedValue(session());
    expire.mockResolvedValue(session({ status: 'expired' }));

    const result = await expireCheckoutSessionForPaymentIntent({
      stripe,
      paymentIntentId: 'pi_1',
      checkoutSessionId: 'cs_1',
    });

    expect(expire).toHaveBeenCalledWith(
      'cs_1',
      {},
      { idempotencyKey: 'expire-checkout-session:cs_1' },
    );
    expect(result).toEqual({
      outcome: 'expired',
      sessionId: 'cs_1',
      expiredNow: true,
    });
  });

  test('保存済みSessionの関連付けが違う場合はPaymentIntentから正しいSessionを引き直す', async () => {
    retrieve.mockResolvedValue(session({ id: 'cs_wrong', payment_intent: 'pi_other' }));
    list.mockResolvedValue({
      data: [session({ id: 'cs_correct' })],
    });
    expire.mockResolvedValue(session({ id: 'cs_correct', status: 'expired' }));

    const result = await expireCheckoutSessionForPaymentIntent({
      stripe,
      paymentIntentId: 'pi_1',
      checkoutSessionId: 'cs_wrong',
    });

    expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 1 });
    expect(expire).toHaveBeenCalledWith(
      'cs_correct',
      {},
      { idempotencyKey: 'expire-checkout-session:cs_correct' },
    );
    expect(result).toMatchObject({ outcome: 'expired', sessionId: 'cs_correct' });
  });

  test('complete/unpaid は将来入金され得るためexpireしない', async () => {
    retrieve.mockResolvedValue(session({ status: 'complete' }));

    const result = await expireCheckoutSessionForPaymentIntent({
      stripe,
      paymentIntentId: 'pi_1',
      checkoutSessionId: 'cs_1',
    });

    expect(expire).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: 'blocked',
      sessionId: 'cs_1',
      sessionStatus: 'complete',
      paymentStatus: 'unpaid',
    });
  });

  test('expired でもpaidなら安全な在庫解放条件として扱わない', async () => {
    retrieve.mockResolvedValue(session({ status: 'expired', payment_status: 'paid' }));

    const result = await expireCheckoutSessionForPaymentIntent({
      stripe,
      paymentIntentId: 'pi_1',
      checkoutSessionId: 'cs_1',
    });

    expect(expire).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'blocked',
      sessionStatus: 'expired',
      paymentStatus: 'paid',
    });
  });

  test('expireと支払完了が競合したら再取得したcompleteを優先する', async () => {
    retrieve
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(session({ status: 'complete' }));
    expire.mockRejectedValue(new Error('session is no longer open'));

    const result = await expireCheckoutSessionForPaymentIntent({
      stripe,
      paymentIntentId: 'pi_1',
      checkoutSessionId: 'cs_1',
    });

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      outcome: 'blocked',
      sessionStatus: 'complete',
      paymentStatus: 'unpaid',
    });
  });

  test('expire成功後の応答喪失でも再取得がexpiredなら冪等に成功扱いにする', async () => {
    retrieve
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(session({ status: 'expired' }));
    expire.mockRejectedValue(new Error('connection reset'));

    const result = await expireCheckoutSessionForPaymentIntent({
      stripe,
      paymentIntentId: 'pi_1',
      checkoutSessionId: 'cs_1',
    });

    expect(result).toEqual({
      outcome: 'expired',
      sessionId: 'cs_1',
      expiredNow: false,
    });
  });

  test('Sessionを特定できなければunavailableを返し、Stripeを変更しない', async () => {
    list.mockResolvedValue({ data: [] });

    const result = await expireCheckoutSessionForPaymentIntent({
      stripe,
      paymentIntentId: 'pi_missing',
      checkoutSessionId: null,
    });

    expect(expire).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'session_not_found',
      sessionId: null,
    });
  });
});
