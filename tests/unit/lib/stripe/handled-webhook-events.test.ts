import fs from 'node:fs';
import path from 'node:path';
import {
  HANDLED_STRIPE_EVENT_TYPES,
  isHandledStripeEventType,
  stripeKeyLivemode,
} from '@/lib/stripe/handled-webhook-events';

describe('受け取り口が保存する知らせの種類', () => {
  it('13種だけ', () => {
    expect([...HANDLED_STRIPE_EVENT_TYPES].sort()).toEqual([
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
    expect(isHandledStripeEventType('customer.created')).toBe(false);
  });

  it('処理する側（webhook-processor）が分ける種類と、13種が一致する', () => {
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
