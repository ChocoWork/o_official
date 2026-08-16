import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';

type Result = { data: unknown; error: { message: string } | null };

function fakeClient(result: Result) {
  const calls: Array<Record<string, unknown>> = [];
  const builder = {
    select: jest.fn(() => builder),
    insert: jest.fn((values: unknown) => {
      calls.push({ op: 'insert', values });
      return builder;
    }),
    update: jest.fn((values: unknown) => {
      calls.push({ op: 'update', values });
      return builder;
    }),
    eq: jest.fn((column: string, value: unknown) => {
      calls.push({ op: 'eq', column, value });
      return builder;
    }),
    maybeSingle: jest.fn(async () => result),
    single: jest.fn(async () => result),
  };
  const from = jest.fn((table: string) => {
    calls.push({ op: 'from', table });
    return builder;
  });
  return { client: { from } as never, calls };
}

describe('createStripeAccountingDatabase', () => {
  it('resolves an order by payment intent', async () => {
    const { client, calls } = fakeClient({ data: { id: 'order-1', currency: 'jpy' }, error: null });

    const database = createStripeAccountingDatabase(client);

    await expect(database.findOrderByPaymentIntent!('pi_1')).resolves.toEqual({
      id: 'order-1',
      currency: 'jpy',
    });
    expect(calls).toContainEqual({ op: 'from', table: 'orders' });
    expect(calls).toContainEqual({ op: 'eq', column: 'payment_intent_id', value: 'pi_1' });
  });

  it('returns null when a source record does not exist yet', async () => {
    const { client } = fakeClient({ data: null, error: null });

    const database = createStripeAccountingDatabase(client);

    await expect(database.findById('stripe_payouts', 'po_1')).resolves.toBeNull();
  });

  it('inserts a row and returns the stored record', async () => {
    const { client, calls } = fakeClient({ data: { id: 'txn_1', net: 9_640 }, error: null });

    const database = createStripeAccountingDatabase(client);

    await expect(
      database.insert('stripe_balance_transactions', { id: 'txn_1', net: 9_640 })
    ).resolves.toEqual({ id: 'txn_1', net: 9_640 });
    expect(calls).toContainEqual({ op: 'from', table: 'stripe_balance_transactions' });
    expect(calls).toContainEqual({ op: 'insert', values: { id: 'txn_1', net: 9_640 } });
  });

  it('updates only the given columns for one id', async () => {
    const { client, calls } = fakeClient({ data: { id: 'po_1', status: 'paid' }, error: null });

    const database = createStripeAccountingDatabase(client);

    await expect(database.updateById('stripe_payouts', 'po_1', { status: 'paid' })).resolves.toEqual({
      id: 'po_1',
      status: 'paid',
    });
    expect(calls).toContainEqual({ op: 'update', values: { status: 'paid' } });
    expect(calls).toContainEqual({ op: 'eq', column: 'id', value: 'po_1' });
  });

  it('throws when Supabase reports an error', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'permission denied' } });

    const database = createStripeAccountingDatabase(client);

    await expect(database.findById('stripe_refunds', 're_1')).rejects.toThrow('permission denied');
  });
});
