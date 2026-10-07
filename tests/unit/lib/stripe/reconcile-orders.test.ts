import { reconcileStripeOrders, reconcileStripePayouts } from '@/lib/stripe/reconcile-orders';

// 直近7日の境目を決まった値で確かめるため、時計を渡す
const NOW = new Date('2026-10-07T00:00:00Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const DAY_SECONDS = 24 * 60 * 60;
// 支払いの通貨と作られた時刻（Stripe の PaymentIntent には必ずある）
const PAYMENT = { currency: 'jpy', created: NOW_SECONDS - 60 };

describe('reconcileStripeOrders', () => {
  it('reports active Stripe-only payments and repairs refund mismatches', async () => {
    const orders = [
      { payment_intent_id: 'pi_partial', refunded_amount: 0 },
    ];
    const database = {
      from: () => ({ select: async () => ({ data: orders, error: null }) }),
    };
    const paymentIntents = [
      { id: 'pi_unmatched', status: 'succeeded', amount: 1000, ...PAYMENT },
      { id: 'pi_fully_refunded', status: 'succeeded', amount: 2000, ...PAYMENT },
      { id: 'pi_partial', status: 'succeeded', amount: 5000, ...PAYMENT },
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
          { id: 'pi_known', status: 'succeeded', amount: 1000, ...PAYMENT },
          { id: 'pi_stripe_only', status: 'succeeded', amount: 2000, ...PAYMENT },
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
          { id: 'pi_a', status: 'succeeded', amount: 1000, ...PAYMENT },
          { id: 'pi_b', status: 'succeeded', amount: 1000, ...PAYMENT },
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
    expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'unexpected_error' }]);
  });
  it('records a refund sync failure without aborting the remaining payments（設計書 4-5）', async () => {
    const orders = [
      { payment_intent_id: 'pi_a', refunded_amount: 0 },
      { payment_intent_id: 'pi_b', refunded_amount: 0 },
    ];
    const database = { from: () => ({ select: async () => ({ data: orders, error: null }) }) };
    const stripe = {
      paymentIntents: {
        list: () => [
          { id: 'pi_a', status: 'succeeded', amount: 1000, ...PAYMENT },
          { id: 'pi_b', status: 'succeeded', amount: 1000, ...PAYMENT },
        ],
      },
      refunds: { list: () => [{ status: 'succeeded', amount: 500, created: 1 }] },
    };
    const syncRefunds = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Stripe is down for buyer@example.com'), { statusCode: 503 }))
      .mockResolvedValueOnce(undefined);
    const syncAccounting = jest.fn().mockResolvedValue({ disposition: 'inserted' });

    const report = await reconcileStripeOrders({ database, stripe, syncRefunds, syncAccounting });

    expect(syncRefunds).toHaveBeenCalledTimes(2);
    expect(report.syncedRefunds).toBe(1);
    expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'stripe_unavailable' }]);
    expect(JSON.stringify(report)).not.toContain('buyer@example.com');
    expect(syncAccounting).toHaveBeenCalledWith('pi_a');
    expect(syncAccounting).toHaveBeenCalledWith('pi_b');
  });

  it('records a refund listing failure and continues with the next payment', async () => {
    const orders = [{ payment_intent_id: 'pi_b', refunded_amount: 0 }];
    const database = { from: () => ({ select: async () => ({ data: orders, error: null }) }) };
    const stripe = {
      paymentIntents: {
        list: () => [
          { id: 'pi_a', status: 'succeeded', amount: 1000, ...PAYMENT },
          { id: 'pi_b', status: 'succeeded', amount: 1000, ...PAYMENT },
        ],
      },
      refunds: {
        list: ({ payment_intent }: { payment_intent: string }) => {
          if (payment_intent === 'pi_a') {
            throw Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' });
          }
          return [];
        },
      },
    };

    const report = await reconcileStripeOrders({ database, stripe, syncRefunds: jest.fn() });

    expect(report.checkedPayments).toBe(2);
    expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'stripe_unavailable' }]);
    expect(report.unmatchedActivePayments).toEqual([]);
    expect(report.unmatchedRecentPayments).toEqual([]);
  });

  it('reports a database failure while loading orders as db_unavailable', async () => {
    const database = {
      from: () => ({ select: async () => ({ data: null, error: { message: 'connection refused' } }) }),
    };
    const stripe = { paymentIntents: { list: () => [] }, refunds: { list: () => [] } };

    await expect(reconcileStripeOrders({ database, stripe, syncRefunds: jest.fn() }))
      .rejects.toMatchObject({ code: 'db_unavailable' });
  });
});

describe('reconcileStripeOrders: unmatchedRecentPayments（直近7日の、注文の無い成功の支払い）', () => {
  type Payment = { id: string; status: string; amount: number; currency: string; created: number };
  const noOrders = { from: () => ({ select: async () => ({ data: [], error: null }) }) };

  /** refunded: PaymentIntent の ID → 成功した返金の合計 */
  function stripeWith(payments: Payment[], refunded: Record<string, number> = {}) {
    return {
      paymentIntents: { list: () => payments },
      refunds: {
        list: ({ payment_intent }: { payment_intent: string }) => (
          refunded[payment_intent] ? [{ status: 'succeeded', amount: refunded[payment_intent], created: 1 }] : []
        ),
      },
    };
  }

  it('ちょうど7日前の支払いは載せ、それより1秒古い支払いは載せない（注文の無い支払い全体の数は変えない）', async () => {
    const stripe = stripeWith([
      { id: 'pi_new', status: 'succeeded', amount: 8900, currency: 'jpy', created: NOW_SECONDS - 3600 },
      { id: 'pi_edge', status: 'succeeded', amount: 1200, currency: 'jpy', created: NOW_SECONDS - 7 * DAY_SECONDS },
      { id: 'pi_old', status: 'succeeded', amount: 3000, currency: 'jpy', created: NOW_SECONDS - 7 * DAY_SECONDS - 1 },
    ]);

    const report = await reconcileStripeOrders({ database: noOrders, stripe, syncRefunds: jest.fn(), now: () => NOW });

    expect(report.unmatchedActivePayments).toEqual(['pi_new', 'pi_edge', 'pi_old']);
    expect(report.unmatchedRecentPayments).toEqual([
      { id: 'pi_new', amount: 8900, currency: 'jpy', created: NOW_SECONDS - 3600 },
      { id: 'pi_edge', amount: 1200, currency: 'jpy', created: NOW_SECONDS - 7 * DAY_SECONDS },
    ]);
  });

  it('全額返金済み・注文のある支払い・成功していない支払いは載せない。一部だけ返金した支払いは載せる', async () => {
    const database = {
      from: () => ({ select: async () => ({ data: [{ payment_intent_id: 'pi_with_order', refunded_amount: 0 }], error: null }) }),
    };
    const stripe = stripeWith(
      [
        { id: 'pi_fully_refunded', status: 'succeeded', amount: 2000, ...PAYMENT },
        { id: 'pi_partly_refunded', status: 'succeeded', amount: 5000, ...PAYMENT },
        { id: 'pi_with_order', status: 'succeeded', amount: 1000, ...PAYMENT },
        { id: 'pi_not_paid', status: 'requires_payment_method', amount: 1000, ...PAYMENT },
      ],
      { pi_fully_refunded: 2000, pi_partly_refunded: 2000 },
    );

    const report = await reconcileStripeOrders({ database, stripe, syncRefunds: jest.fn(), now: () => NOW });

    expect(report.unmatchedActivePayments).toEqual(['pi_partly_refunded']);
    expect(report.unmatchedRecentPayments.map((payment) => payment.id)).toEqual(['pi_partly_refunded']);
  });

  it('時計を渡さないときは、今の時刻から7日を数える', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const stripe = stripeWith([
      { id: 'pi_recent', status: 'succeeded', amount: 1000, currency: 'jpy', created: nowSeconds - 60 },
      { id: 'pi_eight_days', status: 'succeeded', amount: 1000, currency: 'jpy', created: nowSeconds - 8 * DAY_SECONDS },
    ]);

    const report = await reconcileStripeOrders({ database: noOrders, stripe, syncRefunds: jest.fn() });

    expect(report.unmatchedRecentPayments.map((payment) => payment.id)).toEqual(['pi_recent']);
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
    expect(report.errors).toEqual([{ sourceId: 'po_1', reason: 'unexpected_error' }]);
  });
});
