import type Stripe from 'stripe';
import {
  expireCheckoutSessionForPaymentIntent,
  expireOpenCheckoutSession,
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

describe('expireOpenCheckoutSession', () => {
  function stripeWith(options: { retrieve: jest.Mock; expire?: jest.Mock }) {
    return {
      checkout: { sessions: { retrieve: options.retrieve, expire: options.expire ?? jest.fn() } },
    } as unknown as Parameters<typeof expireOpenCheckoutSession>[0];
  }

  it('開いている Session だけを、冪等キー付きで失効させる', async () => {
    const expire = jest.fn().mockResolvedValue({ id: 'cs_1', status: 'expired' });
    const stripe = stripeWith({ retrieve: jest.fn().mockResolvedValue({ id: 'cs_1', status: 'open' }), expire });

    expect(await expireOpenCheckoutSession(stripe, 'cs_1')).toBe('expired');
    expect(expire).toHaveBeenCalledWith('cs_1', {}, { idempotencyKey: 'expire-checkout-session:cs_1' });
  });

  it('完了・失効済みの Session には触らない', async () => {
    const expire = jest.fn();
    const stripe = stripeWith({ retrieve: jest.fn().mockResolvedValue({ id: 'cs_1', status: 'complete' }), expire });

    expect(await expireOpenCheckoutSession(stripe, 'cs_1')).toBe('not_open');
    expect(expire).not.toHaveBeenCalled();
  });

  it('失効の直前に支払いが完了したら、Stripe の現在値を優先して失効させない', async () => {
    const retrieve = jest.fn()
      .mockResolvedValueOnce({ id: 'cs_1', status: 'open' })
      .mockResolvedValueOnce({ id: 'cs_1', status: 'complete' });
    const stripe = stripeWith({ retrieve, expire: jest.fn().mockRejectedValue(new Error('session is not open')) });

    expect(await expireOpenCheckoutSession(stripe, 'cs_1')).toBe('not_open');
  });

  it('Stripe に無い Session は missing', async () => {
    const retrieve = jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'resource_missing' }));

    expect(await expireOpenCheckoutSession(stripeWith({ retrieve }), 'cs_gone')).toBe('missing');
  });
});
