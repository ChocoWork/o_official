import {
  syncPaymentIntentAccounting,
  syncPayoutAccounting,
  syncRefundAccounting,
} from '@/lib/stripe/accounting-sync';
import type { StripeAccountingDatabase } from '@/lib/stripe/accounting-types';

function database(): StripeAccountingDatabase & { rows: Record<string, Record<string, unknown>> } {
  const rows: Record<string, Record<string, unknown>> = {};
  return {
    rows,
    async findOrderByPaymentIntent(paymentIntentId) {
      return paymentIntentId === 'pi_1'
        ? { id: '11111111-1111-4111-8111-111111111111', currency: 'jpy' }
        : null;
    },
    async findById(table, id) { return rows[`${table}:${id}`] ?? null; },
    async insert(table, values) {
      rows[`${table}:${String(values.id)}`] = values;
      return values;
    },
    async updateById(table, id, values) {
      rows[`${table}:${id}`] = { ...rows[`${table}:${id}`], ...values };
      return rows[`${table}:${id}`];
    },
  };
}

const balanceTransaction = (overrides: Record<string, unknown> = {}) => ({
  id: 'txn_1', amount: 10_000, fee: 360, net: 9_640, currency: 'jpy',
  reporting_category: 'charge', type: 'charge', source: 'ch_1',
  status: 'available', available_on: 1_755_216_000, created: 1_755_212_400,
  fee_details: [], ...overrides,
});

describe('Stripe accounting synchronization', () => {
  it('stores the charge balance transaction with actual fee and net', async () => {
    const db = database();
    const stripe = {
      paymentIntents: { retrieve: jest.fn().mockResolvedValue({ id: 'pi_1', latest_charge: 'ch_1' }) },
      charges: { retrieve: jest.fn().mockResolvedValue({ id: 'ch_1', balance_transaction: 'txn_1' }) },
      balanceTransactions: { retrieve: jest.fn().mockResolvedValue(balanceTransaction()) },
    };

    const result = await syncPaymentIntentAccounting({ stripe, database: db, paymentIntentId: 'pi_1' });

    expect(result.balanceTransactionId).toBe('txn_1');
    expect(db.rows['stripe_balance_transactions:txn_1']).toMatchObject({ fee: 360, net: 9_640 });
  });

  it('does not save Stripe-only payments without a matching order', async () => {
    const db = database();
    const stripe = { paymentIntents: { retrieve: jest.fn() } };

    await expect(syncPaymentIntentAccounting({
      stripe, database: db, paymentIntentId: 'pi_unknown',
    })).resolves.toMatchObject({ disposition: 'unmatched' });
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('does not save a refund of a Stripe-only payment, and does not throw (the webhook must not retry it forever)', async () => {
    const db = database();
    const stripe = {
      refunds: { retrieve: jest.fn().mockResolvedValue({
        id: 're_orphan', payment_intent: 'pi_unknown', charge: 'ch_unknown', amount: 2_000,
        currency: 'jpy', status: 'succeeded', reason: null,
        balance_transaction: 'txn_refund_orphan', failure_balance_transaction: null,
        created: 1_755_212_400,
      }) },
      balanceTransactions: { retrieve: jest.fn() },
    };

    await expect(syncRefundAccounting({
      stripe, database: db, refundId: 're_orphan',
    })).resolves.toEqual({ disposition: 'unmatched', refund: null });
    expect(stripe.balanceTransactions.retrieve).not.toHaveBeenCalled();
    expect(db.rows).toEqual({});
  });

  it('uses the refund balance transaction created time as succeededAt', async () => {
    const db = database();
    const succeededEpoch = Date.parse('2026-08-15T01:00:00.000Z') / 1000;
    const stripe = {
      refunds: { retrieve: jest.fn().mockResolvedValue({
        id: 're_1', payment_intent: 'pi_1', charge: 'ch_1', amount: 2_000,
        currency: 'jpy', status: 'succeeded', reason: null,
        balance_transaction: 'txn_refund_1', failure_balance_transaction: null,
        created: succeededEpoch - 60,
      }) },
      balanceTransactions: { retrieve: jest.fn().mockResolvedValue(balanceTransaction({
        id: 'txn_refund_1', source: 're_1', amount: -2_000, fee: 0, net: -2_000,
        reporting_category: 'refund', type: 'refund', created: succeededEpoch,
      })) },
    };

    const result = await syncRefundAccounting({ stripe, database: db, refundId: 're_1' });

    expect(result.refund?.succeededAt).toBe('2026-08-15T01:00:00.000Z');
  });

  it('reads every balance transaction in an automatic payout', async () => {
    const db = database();
    const transactions = Array.from({ length: 101 }, (_, index) => balanceTransaction({
      id: `txn_${index}`, amount: 100, fee: 0, net: 100, source: `ch_${index}`,
    }));
    const stripe = {
      payouts: { retrieve: jest.fn().mockResolvedValue({
        id: 'po_1', amount: 10_100, currency: 'jpy', status: 'paid', automatic: true,
        arrival_date: 1_755_302_400, created: 1_755_212_400,
        balance_transaction: 'txn_payout_1',
      }) },
      balanceTransactions: {
        retrieve: jest.fn().mockResolvedValue(balanceTransaction({
          id: 'txn_payout_1', amount: -10_100, fee: 0, net: -10_100,
          source: 'po_1', reporting_category: 'payout', type: 'payout',
        })),
        list: jest.fn().mockReturnValue({ async *[Symbol.asyncIterator]() {
          for (const transaction of transactions) yield transaction;
        } }),
      },
    };

    const result = await syncPayoutAccounting({ stripe, database: db, payoutId: 'po_1' });

    expect(result.transactionCount).toBe(101);
    expect(result.reconciliationStatus).toBe('matched');
    expect(stripe.balanceTransactions.list).toHaveBeenCalledWith({ payout: 'po_1', limit: 100 });
  });

  it('FREQ-565-AC-04: 入金の到着日（arrival_date）は日本時間の日になる', async () => {
    const db = database();
    // 2025-08-15T15:30:00Z は日本時間では 2025-08-16 0:30。UTC の日で切ると 08-15 になってしまう。
    const arrival = Date.parse('2025-08-15T15:30:00.000Z') / 1000;
    const stripe = {
      payouts: { retrieve: jest.fn().mockResolvedValue({
        id: 'po_jst', amount: 100, currency: 'jpy', status: 'paid', automatic: true,
        arrival_date: arrival, created: 1_755_212_400, balance_transaction: 'txn_payout_jst',
      }) },
      balanceTransactions: {
        retrieve: jest.fn().mockResolvedValue(balanceTransaction({
          id: 'txn_payout_jst', amount: -100, fee: 0, net: -100, source: 'po_jst',
          reporting_category: 'payout', type: 'payout',
        })),
        list: jest.fn().mockReturnValue({ async *[Symbol.asyncIterator]() {
          yield balanceTransaction({ id: 'txn_member', amount: 100, fee: 0, net: 100, source: 'ch_member' });
        } }),
      },
    };

    await syncPayoutAccounting({ stripe, database: db, payoutId: 'po_jst' });

    expect(db.rows['stripe_payouts:po_jst']).toMatchObject({ arrival_date: '2025-08-16' });
  });

  it.each([
    ['2025-08-15T14:59:59.000Z', '2025-08-15'],
    ['2025-08-15T15:00:00.000Z', '2025-08-16'],
    ['2025-08-15T00:00:00.000Z', '2025-08-15'],
  ])('FREQ-565-AC-04: 到着日の境（%s は日本時間の %s）', async (arrivalAt, expected) => {
    const db = database();
    const stripe = {
      payouts: { retrieve: jest.fn().mockResolvedValue({
        id: 'po_edge', amount: 100, currency: 'jpy', status: 'paid', automatic: true,
        arrival_date: Date.parse(arrivalAt) / 1000, created: 1_755_212_400, balance_transaction: 'txn_payout_edge',
      }) },
      balanceTransactions: {
        retrieve: jest.fn().mockResolvedValue(balanceTransaction({
          id: 'txn_payout_edge', amount: -100, fee: 0, net: -100, source: 'po_edge', reporting_category: 'payout', type: 'payout',
        })),
        list: jest.fn().mockReturnValue({ async *[Symbol.asyncIterator]() {
          yield balanceTransaction({ id: 'txn_member', amount: 100, fee: 0, net: 100, source: 'ch_member' });
        } }),
      },
    };

    await syncPayoutAccounting({ stripe, database: db, payoutId: 'po_edge' });

    expect(db.rows['stripe_payouts:po_edge']).toMatchObject({ arrival_date: expected });
  });

  it('FREQ-565-AC-05: 入金の失敗の取引（failure_balance_transaction）を同期で保存する', async () => {
    const db = database();
    const stripe = {
      payouts: { retrieve: jest.fn().mockResolvedValue({
        id: 'po_failed', amount: 100, currency: 'jpy', status: 'failed', automatic: true,
        arrival_date: 1_755_302_400, created: 1_755_212_400,
        balance_transaction: 'txn_payout_failed', failure_balance_transaction: 'txn_failure_1',
      }) },
      balanceTransactions: {
        retrieve: jest.fn().mockImplementation(async (id: string) => id === 'txn_failure_1'
          ? balanceTransaction({ id: 'txn_failure_1', amount: 100, fee: 0, net: 100, source: 'po_failed',
            reporting_category: 'payout_reversal', type: 'payout_failure', created: 1_755_300_000 })
          : balanceTransaction({ id: 'txn_payout_failed', amount: -100, fee: 0, net: -100, source: 'po_failed',
            reporting_category: 'payout', type: 'payout' })),
        list: jest.fn().mockReturnValue({ async *[Symbol.asyncIterator]() {
          yield balanceTransaction({ id: 'txn_member', amount: 100, fee: 0, net: 100, source: 'ch_member' });
        } }),
      },
    };

    await syncPayoutAccounting({ stripe, database: db, payoutId: 'po_failed' });

    expect(stripe.balanceTransactions.retrieve).toHaveBeenCalledWith('txn_failure_1');
    expect(db.rows['stripe_balance_transactions:txn_failure_1']).toMatchObject({
      type: 'payout_failure', net: 100, source_id: 'po_failed', payout_id: null,
    });
    // 失敗の取引は入金の中身ではないので、照合の合計（reconciled_net）に入れない。
    expect(db.rows['stripe_payouts:po_failed']).toMatchObject({ reconciled_net: 100, reconciliation_status: 'matched' });
  });

  it('FREQ-565-AC-05: 失敗の取引が無い入金は、取引を余分に取りに行かない', async () => {
    const db = database();
    const stripe = {
      payouts: { retrieve: jest.fn().mockResolvedValue({
        id: 'po_ok', amount: 100, currency: 'jpy', status: 'paid', automatic: true,
        arrival_date: 1_755_302_400, created: 1_755_212_400,
        balance_transaction: 'txn_payout_ok', failure_balance_transaction: null,
      }) },
      balanceTransactions: {
        retrieve: jest.fn().mockResolvedValue(balanceTransaction({
          id: 'txn_payout_ok', amount: -100, fee: 0, net: -100, source: 'po_ok', reporting_category: 'payout', type: 'payout',
        })),
        list: jest.fn().mockReturnValue({ async *[Symbol.asyncIterator]() {
          yield balanceTransaction({ id: 'txn_member', amount: 100, fee: 0, net: 100, source: 'ch_member' });
        } }),
      },
    };

    await syncPayoutAccounting({ stripe, database: db, payoutId: 'po_ok' });

    expect(stripe.balanceTransactions.retrieve).toHaveBeenCalledTimes(1);
    expect(stripe.balanceTransactions.retrieve).toHaveBeenCalledWith('txn_payout_ok');
  });
});
