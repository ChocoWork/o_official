import { reconcileStripeOrders, reconcileStripePayouts } from '@/lib/stripe/reconcile-orders';

describe('reconcileStripeOrders', () => {
  it('reports active Stripe-only payments and repairs refund mismatches', async () => {
    const orders = [
      { payment_intent_id: 'pi_partial', refunded_amount: 0 },
    ];
    const database = {
      from: () => ({ select: async () => ({ data: orders, error: null }) }),
    };
    const paymentIntents = [
      { id: 'pi_unmatched', status: 'succeeded', amount: 1000 },
      { id: 'pi_fully_refunded', status: 'succeeded', amount: 2000 },
      { id: 'pi_partial', status: 'succeeded', amount: 5000 },
    ];
    const refundsByIntent: Record<string, Array<{ status: string; amount: number; created: number }>> = {
      pi_unmatched: [],
      pi_fully_refunded: [{ status: 'succeeded', amount: 2000, created: 1 }],
      pi_partial: [{ status: 'succeeded', amount: 2000, created: 1 }],
    };
    const stripe = {
      paymentIntents: { list: () => paymentIntents },
      refunds: { list: ({ payment_intent }: { payment_intent: string }) => refundsByIntent[payment_intent] },
    };
    const syncRefunds = jest.fn().mockResolvedValue(undefined);

    const report = await reconcileStripeOrders({ database, stripe, syncRefunds });

    expect(report.unmatchedActivePayments).toEqual(['pi_unmatched']);
    expect(report.refundMismatches).toEqual([{ paymentIntentId: 'pi_partial', stripe: 2000, database: 0 }]);
    expect(report.unmatchedActivePayments).not.toContain('pi_fully_refunded');
    expect(syncRefunds).toHaveBeenCalledWith('pi_partial');
  });

  it('syncs accounting for existing orders only and never creates one', async () => {
    const orders = [{ payment_intent_id: 'pi_known', refunded_amount: 0 }];
    const database = {
      from: () => ({ select: async () => ({ data: orders, error: null }) }),
      insert: jest.fn(),
    };
    const stripe = {
      paymentIntents: {
        list: () => [
          { id: 'pi_known', status: 'succeeded', amount: 1000 },
          { id: 'pi_stripe_only', status: 'succeeded', amount: 2000 },
        ],
      },
      refunds: { list: () => [] },
    };
    const syncAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });

    const report = await reconcileStripeOrders({
      database,
      stripe,
      syncRefunds: jest.fn(),
      syncAccounting,
    });

    expect(syncAccounting).toHaveBeenCalledTimes(1);
    expect(syncAccounting).toHaveBeenCalledWith('pi_known');
    expect(database.insert).not.toHaveBeenCalled();
    expect(report.syncedBalanceTransactions).toBe(1);
    expect(report.unmatchedActivePayments).toEqual(['pi_stripe_only']);
  });

  it('records an accounting failure without aborting the remaining payments', async () => {
    const orders = [
      { payment_intent_id: 'pi_a', refunded_amount: 0 },
      { payment_intent_id: 'pi_b', refunded_amount: 0 },
    ];
    const database = { from: () => ({ select: async () => ({ data: orders, error: null }) }) };
    const stripe = {
      paymentIntents: {
        list: () => [
          { id: 'pi_a', status: 'succeeded', amount: 1000 },
          { id: 'pi_b', status: 'succeeded', amount: 1000 },
        ],
      },
      refunds: { list: () => [] },
    };
    const syncAccounting = jest
      .fn()
      .mockRejectedValueOnce(new Error('stripe unavailable'))
      .mockResolvedValueOnce({ disposition: 'inserted' });

    const report = await reconcileStripeOrders({
      database,
      stripe,
      syncRefunds: jest.fn(),
      syncAccounting,
    });

    expect(report.syncedBalanceTransactions).toBe(1);
    expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'stripe unavailable' }]);
  });
});

describe('reconcileStripePayouts', () => {
  it('syncs recent payouts and counts mismatches', async () => {
    const stripe = {
      payouts: {
        list: () => [
          { id: 'po_matched' },
          { id: 'po_mismatch' },
        ],
      },
    };
    const syncPayout = jest.fn(async (payoutId: string) => ({
      reconciliationStatus: payoutId === 'po_mismatch' ? 'mismatch' : 'matched',
    }));

    const report = await reconcileStripePayouts({ stripe, syncPayout });

    expect(syncPayout).toHaveBeenCalledTimes(2);
    expect(report.syncedPayouts).toBe(2);
    expect(report.payoutMismatches).toBe(1);
    expect(report.errors).toEqual([]);
  });

  it('records a payout failure and continues', async () => {
    const stripe = { payouts: { list: () => [{ id: 'po_1' }, { id: 'po_2' }] } };
    const syncPayout = jest
      .fn()
      .mockRejectedValueOnce(new Error('payout sync failed'))
      .mockResolvedValueOnce({ reconciliationStatus: 'matched' });

    const report = await reconcileStripePayouts({ stripe, syncPayout });

    expect(report.syncedPayouts).toBe(1);
    expect(report.errors).toEqual([{ sourceId: 'po_1', reason: 'payout sync failed' }]);
  });
});
