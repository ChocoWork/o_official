import type Stripe from 'stripe';

export const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';
export const REFUND_ID = 'b1b2c3d4-1111-4222-8333-444455556666';
export const ACTOR_ID = 'c1b2c3d4-1111-4222-8333-444455556666';

/**
 * Stripe の返金（Stripe.Refund）の見本。試験に要る項目だけを置き、overrides で上書きする。
 * created の 1_791_000_000 は 2026-10-03T04:00:00.000Z。印（metadata）は、こちらが頼んだ返金と同じ形
 */
export function stripeRefund(overrides: Record<string, unknown> = {}): Stripe.Refund {
  return {
    id: 're_test_1',
    object: 'refund',
    amount: 5000,
    balance_transaction: null,
    charge: 'ch_test_1',
    created: 1_791_000_000,
    currency: 'jpy',
    metadata: { order_id: ORDER_ID, refund_id: REFUND_ID },
    payment_intent: 'pi_card_1',
    reason: 'requested_by_customer',
    receipt_number: null,
    source_transfer_reversal: null,
    status: 'pending',
    transfer_reversal: null,
    ...overrides,
  } as unknown as Stripe.Refund;
}

/** Stripe の一覧（for await で全部のページをたどって読む）の代わり */
export function asyncIterableOf<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async (): Promise<IteratorResult<T>> =>
          index < items.length ? { value: items[index++], done: false } : { value: undefined, done: true },
      };
    },
  };
}
