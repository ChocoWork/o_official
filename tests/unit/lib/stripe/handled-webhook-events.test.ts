import fs from 'node:fs';
import path from 'node:path';
import {
  HANDLED_STRIPE_EVENT_TYPES,
  isHandledStripeEventType,
  stripeKeyLivemode,
} from '@/lib/stripe/handled-webhook-events';

describe('受け取り口が保存する知らせの種類', () => {
  it('FREQ-567-AC-01: 18種だけ（charge.dispute の5種を含む）', () => {
    expect([...HANDLED_STRIPE_EVENT_TYPES].sort()).toEqual([
      'charge.dispute.closed',
      'charge.dispute.created',
      'charge.dispute.funds_reinstated',
      'charge.dispute.funds_withdrawn',
      'charge.dispute.updated',
      'charge.refunded',
      'checkout.session.async_payment_failed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.completed',
      'checkout.session.expired',
      'payment_intent.payment_failed',
      'payment_intent.succeeded',
      'payout.failed',
      'payout.paid',
      'payout.reconciliation_completed',
      'refund.created',
      'refund.failed',
      'refund.updated',
    ]);
    expect(isHandledStripeEventType('checkout.session.completed')).toBe(true);
    expect(HANDLED_STRIPE_EVENT_TYPES).toHaveLength(18);
    expect(isHandledStripeEventType('charge.dispute.funds_reinstated')).toBe(true);
    expect(isHandledStripeEventType('customer.created')).toBe(false);
  });

  it('FREQ-567-AC-01: 受け取りの種類は18種で、処理する側（webhook-processor）のcaseの集合と一致する', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/stripe/webhook-processor.ts'), 'utf8');
    const cases = new Set([...source.matchAll(/case '([a-z_.]+)':/g)].map((match) => match[1]));
    expect([...cases].sort()).toEqual([...HANDLED_STRIPE_EVENT_TYPES].sort());
  });
});

describe('stripeKeyLivemode', () => {
  it.each([
    ['sk_live_abc', true],
    ['rk_live_abc', true],
    ['sk_test_abc', false],
    ['rk_test_abc', false],
    ['pk_live_abc', null],
    ['', null],
    [undefined, null],
  ])('%s は %s', (key, expected) => {
    expect(stripeKeyLivemode(key)).toBe(expected);
  });
});
