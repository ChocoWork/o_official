import { expireOpenCheckoutSession } from '@/lib/stripe/checkout-session-expiry';

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
