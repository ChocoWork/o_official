// 毎晩の返金の照合が呼ぶ取り込みと保留の一覧。中身は order-refund-sync.test.ts・refund-store.test.ts が確かめる
const mockSyncPaymentIntentRefunds = jest.fn();
jest.mock('@/lib/stripe/order-refund-sync', () => {
  class OrderNotFoundForPaymentIntentError extends Error {}
  class RefundSyncNotConvergedError extends Error {}
  return {
    OrderNotFoundForPaymentIntentError,
    RefundSyncNotConvergedError,
    syncPaymentIntentRefunds: (...args: unknown[]) => mockSyncPaymentIntentRefunds(...args),
  };
});
const mockListPendingRefundPaymentIntents = jest.fn();
jest.mock('@/lib/orders/refund/refund-store', () => ({
  listPendingRefundPaymentIntents: (...args: unknown[]) => mockListPendingRefundPaymentIntents(...args),
}));

import type { RefundServiceDeps } from '@/lib/orders/refund/refund-service';
import { OrderNotFoundForPaymentIntentError, RefundSyncNotConvergedError } from '@/lib/stripe/order-refund-sync';
import { reconcileRecentRefunds, reconcileStripeOrders, reconcileStripePayouts } from '@/lib/stripe/reconcile-orders';

// 直近7日の境目を決まった値で確かめるため、時計を渡す
const NOW = new Date('2026-10-07T00:00:00Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const DAY_SECONDS = 24 * 60 * 60;
// 支払いの通貨と作られた時刻（Stripe の PaymentIntent には必ずある）
const PAYMENT = { currency: 'jpy', created: NOW_SECONDS - 60 };

describe('reconcileStripeOrders', () => {
  it('注文の無い支払いのうち、返金し切っていない物だけを報告する。注文のある支払いの返金は読まない（返金の照合が受け持つ）', async () => {
    const orders = [{ payment_intent_id: 'pi_partial' }];
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
    const refundList = jest.fn(({ payment_intent }: { payment_intent: string }) => refundsByIntent[payment_intent]);
    const stripe = {
      paymentIntents: { list: () => paymentIntents },
      refunds: { list: refundList },
    };

    const report = await reconcileStripeOrders({ database, stripe });

    expect(report.unmatchedActivePayments).toEqual(['pi_unmatched']);
    expect(report.unmatchedActivePayments).not.toContain('pi_fully_refunded');
    expect(refundList.mock.calls.map(([params]) => params.payment_intent)).toEqual(['pi_unmatched', 'pi_fully_refunded']);
    expect(report.errors).toEqual([]);
  });

  it('syncs accounting for existing orders only and never creates one', async () => {
    const orders = [{ payment_intent_id: 'pi_known' }];
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
      { payment_intent_id: 'pi_a' },
      { payment_intent_id: 'pi_b' },
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
      syncAccounting,
    });

    expect(report.syncedBalanceTransactions).toBe(1);
    expect(report.errors).toEqual([{ sourceId: 'pi_a', reason: 'unexpected_error' }]);
  });

  it('records a refund listing failure and continues with the next payment', async () => {
    const orders = [{ payment_intent_id: 'pi_b' }];
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

    const report = await reconcileStripeOrders({ database, stripe });

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

    await expect(reconcileStripeOrders({ database, stripe }))
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

    const report = await reconcileStripeOrders({ database: noOrders, stripe, now: () => NOW });

    expect(report.unmatchedActivePayments).toEqual(['pi_new', 'pi_edge', 'pi_old']);
    expect(report.unmatchedRecentPayments).toEqual([
      { id: 'pi_new', amount: 8900, currency: 'jpy', created: NOW_SECONDS - 3600 },
      { id: 'pi_edge', amount: 1200, currency: 'jpy', created: NOW_SECONDS - 7 * DAY_SECONDS },
    ]);
  });

  it('全額返金済み・注文のある支払い・成功していない支払いは載せない。一部だけ返金した支払いは載せる', async () => {
    const database = {
      from: () => ({ select: async () => ({ data: [{ payment_intent_id: 'pi_with_order' }], error: null }) }),
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

    const report = await reconcileStripeOrders({ database, stripe, now: () => NOW });

    expect(report.unmatchedActivePayments).toEqual(['pi_partly_refunded']);
    expect(report.unmatchedRecentPayments.map((payment) => payment.id)).toEqual(['pi_partly_refunded']);
  });

  it('時計を渡さないときは、今の時刻から7日を数える', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const stripe = stripeWith([
      { id: 'pi_recent', status: 'succeeded', amount: 1000, currency: 'jpy', created: nowSeconds - 60 },
      { id: 'pi_eight_days', status: 'succeeded', amount: 1000, currency: 'jpy', created: nowSeconds - 8 * DAY_SECONDS },
    ]);

    const report = await reconcileStripeOrders({ database: noOrders, stripe });

    expect(report.unmatchedRecentPayments.map((payment) => payment.id)).toEqual(['pi_recent']);
  });
});

describe('reconcileRecentRefunds（前の48時間の返金と、保留の返金の支払いを、取り込みに通す）', () => {
  const SINCE = new Date('2026-10-05T02:00:00.000Z');
  const NOW_MS = Date.parse('2026-10-07T02:00:00.000Z');
  const OPTIONS = { since: SINCE, deadline: NOW_MS + 120_000 };

  type RefundStub = { id: string; payment_intent: string | { id: string } | null };

  function makeDeps(refunds: RefundStub[], now: () => Date = () => new Date(NOW_MS)) {
    const list = jest.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const refund of refunds) yield refund;
      },
    }));
    const deps = { store: { name: 'store' }, stripe: { refunds: { list } }, now } as unknown as RefundServiceDeps;
    return { deps, list };
  }

  /** 取り込みの答え。results の中身は数えるだけなので空の物でよい */
  const synced = (count = 1) => ({
    kind: 'synced',
    orderId: 'order-1',
    orderStatus: 'paid',
    results: Array.from({ length: count }, () => ({})),
  });

  beforeEach(() => {
    mockSyncPaymentIntentRefunds.mockReset();
    mockSyncPaymentIntentRefunds.mockResolvedValue(synced());
    mockListPendingRefundPaymentIntents.mockReset();
    mockListPendingRefundPaymentIntents.mockResolvedValue([]);
  });

  it('保留の返金の支払いを先に、Stripe の返金の一覧（作った日時で絞る）の支払いを後に集め、重複なしに1つずつ取り込む', async () => {
    const { deps, list } = makeDeps([
      { id: 're_1', payment_intent: 'pi_a' },
      { id: 're_2', payment_intent: 'pi_b' },
      { id: 're_3', payment_intent: 'pi_a' },
      { id: 're_4', payment_intent: { id: 'pi_c' } },
      { id: 're_5', payment_intent: null },
    ]);
    mockListPendingRefundPaymentIntents.mockResolvedValue(['pi_b', 'pi_d']);

    const report = await reconcileRecentRefunds(deps, OPTIONS);

    expect(list).toHaveBeenCalledWith({ created: { gte: Math.floor(SINCE.getTime() / 1000) }, limit: 100 });
    expect(mockListPendingRefundPaymentIntents).toHaveBeenCalledWith(deps.store, 500);
    // 保留の側（pi_b・pi_d）が先。時間切れで止まる時に、保留の側を後回しにしない
    expect(mockSyncPaymentIntentRefunds.mock.calls.map(([, paymentIntentId]) => paymentIntentId)).toEqual([
      'pi_b',
      'pi_d',
      'pi_a',
      'pi_c',
    ]);
    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(deps, 'pi_a');
    expect(report).toEqual({ checkedPaymentIntents: 4, syncedRefunds: 4, errors: [] });
  });

  it('Stripe の一覧が空でも、保留の返金の支払いは取り込む', async () => {
    const { deps } = makeDeps([]);
    mockListPendingRefundPaymentIntents.mockResolvedValue(['pi_pending']);

    const report = await reconcileRecentRefunds(deps, OPTIONS);

    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledTimes(1);
    expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledWith(deps, 'pi_pending');
    expect(report.checkedPaymentIntents).toBe(1);
  });

  it('syncedRefunds は書いた返金の数。入金が決まる前の注文の支払い（skipped_unpaid）は数えない', async () => {
    const { deps } = makeDeps([
      { id: 're_1', payment_intent: 'pi_a' },
      { id: 're_2', payment_intent: 'pi_b' },
    ]);
    mockSyncPaymentIntentRefunds
      .mockResolvedValueOnce(synced(2))
      .mockResolvedValueOnce({ kind: 'skipped_unpaid', orderId: 'order-2', orderStatus: 'pending' });

    const report = await reconcileRecentRefunds(deps, OPTIONS);

    expect(report).toEqual({ checkedPaymentIntents: 2, syncedRefunds: 2, errors: [] });
  });

  it('注文の無い支払いは数えるだけで、失敗にしない', async () => {
    const { deps } = makeDeps([
      { id: 're_1', payment_intent: 'pi_orphan' },
      { id: 're_2', payment_intent: 'pi_b' },
    ]);
    mockSyncPaymentIntentRefunds
      .mockRejectedValueOnce(new OrderNotFoundForPaymentIntentError())
      .mockResolvedValueOnce(synced());

    const report = await reconcileRecentRefunds(deps, OPTIONS);

    expect(report).toEqual({ checkedPaymentIntents: 2, syncedRefunds: 1, errors: [] });
  });

  it('1つの失敗で全体を止めない。失敗は支払いの番号と原因の記号だけを残す（例外の文は残さない）', async () => {
    const { deps } = makeDeps([
      { id: 're_1', payment_intent: 'pi_a' },
      { id: 're_2', payment_intent: 'pi_b' },
    ]);
    mockSyncPaymentIntentRefunds
      .mockRejectedValueOnce(Object.assign(new Error('Stripe is down for buyer@example.com'), { statusCode: 503 }))
      .mockResolvedValueOnce(synced());

    const report = await reconcileRecentRefunds(deps, OPTIONS);

    expect(report).toEqual({
      checkedPaymentIntents: 2,
      syncedRefunds: 1,
      errors: [{ paymentIntentId: 'pi_a', message: 'stripe_unavailable' }],
    });
    expect(JSON.stringify(report)).not.toContain('buyer@example.com');
  });

  it('書いている間に返金が変わり続けて収まらない支払い（RefundSyncNotConvergedError）は、決済の照合と同じ記号 not_converged で残す', async () => {
    const { deps } = makeDeps([{ id: 're_1', payment_intent: 'pi_a' }]);
    mockSyncPaymentIntentRefunds.mockRejectedValueOnce(new RefundSyncNotConvergedError());

    const report = await reconcileRecentRefunds(deps, OPTIONS);

    expect(report).toEqual({
      checkedPaymentIntents: 1,
      syncedRefunds: 0,
      errors: [{ paymentIntentId: 'pi_a', message: 'not_converged' }],
    });
  });

  it('時間切れ: deadline に届いたら、残りを次の夜に回す', async () => {
    const clock = [new Date(NOW_MS), new Date(OPTIONS.deadline)];
    const { deps } = makeDeps(
      [
        { id: 're_1', payment_intent: 'pi_a' },
        { id: 're_2', payment_intent: 'pi_b' },
      ],
      () => clock.shift() ?? new Date(OPTIONS.deadline),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const report = await reconcileRecentRefunds(deps, OPTIONS);

      expect(report).toEqual({ checkedPaymentIntents: 1, syncedRefunds: 1, errors: [] });
      expect(mockSyncPaymentIntentRefunds).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('Stripe の返金の一覧を読めなければ、そのまま投げる（窓口が受け止めて、失敗として errors に残す）', async () => {
    const failure = Object.assign(new Error('connection reset'), { type: 'StripeConnectionError' });
    const deps = {
      store: { name: 'store' },
      stripe: {
        refunds: {
          list: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                throw failure;
              },
            }),
          }),
        },
      },
      now: () => new Date(NOW_MS),
    } as unknown as RefundServiceDeps;

    await expect(reconcileRecentRefunds(deps, OPTIONS)).rejects.toBe(failure);
    expect(mockSyncPaymentIntentRefunds).not.toHaveBeenCalled();
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
