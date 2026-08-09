import { reconcileStripeOrders } from '@/lib/stripe/reconcile-orders';

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
});
