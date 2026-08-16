import {
  upsertBalanceTransaction,
  upsertPayout,
  upsertRefund,
} from '@/lib/stripe/accounting-store';
import type {
  StripeAccountingDatabase,
  StripeAccountingTable,
} from '@/lib/stripe/accounting-types';

function fakeDatabase(
  initial: Partial<Record<StripeAccountingTable, Record<string, unknown>>>,
): StripeAccountingDatabase & { writes: Array<{ kind: string; values: object }> } {
  const rows = new Map(
    Object.entries(initial).map(([table, row]) => [
      `${table}:${String(row?.id)}`,
      row as Record<string, unknown>,
    ]),
  );
  const writes: Array<{ kind: string; values: object }> = [];

  return {
    writes,
    async findById(table, id) {
      return rows.get(`${table}:${id}`) ?? null;
    },
    async insert(table, values) {
      writes.push({ kind: 'insert', values });
      rows.set(`${table}:${String(values.id)}`, values);
      return values;
    },
    async updateById(table, id, values) {
      writes.push({ kind: 'update', values });
      const updated = { ...rows.get(`${table}:${id}`), ...values };
      rows.set(`${table}:${id}`, updated);
      return updated;
    },
  };
}

const balanceTransaction = {
  id: 'txn_1',
  sourceId: 'ch_1',
  paymentIntentId: 'pi_1',
  orderId: '11111111-1111-4111-8111-111111111111',
  payoutId: null,
  type: 'charge',
  reportingCategory: 'charge',
  amount: 10_000,
  fee: 360,
  net: 9_640,
  currency: 'jpy',
  status: 'pending' as const,
  availableOn: null,
  stripeCreatedAt: '2026-08-15T00:00:00.000Z',
  feeDetails: [],
  rawPayload: { id: 'txn_1' },
  syncedAt: '2026-08-15T00:01:00.000Z',
};

describe('Stripe accounting store', () => {
  it('rejects a changed immutable amount for an existing balance transaction', async () => {
    const database = fakeDatabase({
      stripe_balance_transactions: {
        id: 'txn_1', source_id: 'ch_1', amount: 10_000, fee: 360,
        net: 9_640, currency: 'jpy', status: 'pending',
      },
    });

    await expect(upsertBalanceTransaction(database, {
      ...balanceTransaction,
      amount: 9_000,
      net: 8_640,
    })).rejects.toThrow('immutable Stripe balance transaction mismatch');
    expect(database.writes).toHaveLength(0);
  });

  it('updates only mutable state for an identical Stripe id', async () => {
    const database = fakeDatabase({
      stripe_balance_transactions: {
        id: 'txn_1', source_id: 'ch_1', amount: 10_000, fee: 360,
        net: 9_640, currency: 'jpy', status: 'pending', payout_id: null,
      },
    });

    const result = await upsertBalanceTransaction(database, {
      ...balanceTransaction,
      status: 'available',
      payoutId: 'po_1',
    });

    expect(result.disposition).toBe('updated');
    expect(database.writes[0]).toMatchObject({
      kind: 'update',
      values: { status: 'available', payout_id: 'po_1' },
    });
    expect(database.writes[0]?.values).not.toHaveProperty('amount');
  });

  it('inserts a new refund and leaves an identical retry unchanged', async () => {
    const input = {
      id: 're_1', paymentIntentId: 'pi_1', chargeId: 'ch_1',
      orderId: '11111111-1111-4111-8111-111111111111', amount: 2_000,
      currency: 'jpy', status: 'succeeded' as const, reason: null,
      balanceTransactionId: 'txn_refund_1', failureBalanceTransactionId: null,
      stripeCreatedAt: '2026-08-15T00:00:00.000Z',
      succeededAt: '2026-08-15T01:00:00.000Z', rawPayload: { id: 're_1' },
      syncedAt: '2026-08-15T01:01:00.000Z',
    };
    const database = fakeDatabase({});

    expect((await upsertRefund(database, input)).disposition).toBe('inserted');
    expect((await upsertRefund(database, input)).disposition).toBe('unchanged');
  });

  it('rejects immutable payout changes', async () => {
    const database = fakeDatabase({
      stripe_payouts: {
        id: 'po_1', amount: 9_640, currency: 'jpy', automatic: true,
      },
    });

    await expect(upsertPayout(database, {
      id: 'po_1', amount: 9_000, currency: 'jpy', automatic: true,
      status: 'paid', arrivalDate: '2026-08-18',
      stripeCreatedAt: '2026-08-15T00:00:00.000Z', paidAt: null,
      reconciliationStatus: 'pending', reconciledNet: 0,
      rawPayload: { id: 'po_1' }, syncedAt: '2026-08-15T01:00:00.000Z',
    })).rejects.toThrow('immutable Stripe payout mismatch');
  });
});
