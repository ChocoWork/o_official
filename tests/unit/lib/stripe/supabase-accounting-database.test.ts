import { createStripeAccountingDatabase } from '@/lib/stripe/supabase-accounting-database';

type Result = { data: unknown; error: { message: string } | null };

type Builder = {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  eq: jest.Mock;
  maybeSingle: jest.Mock;
  single: jest.Mock;
};

function fakeClient(result: Result) {
  const calls: Array<Record<string, unknown>> = [];
  const builder: Builder = {
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

describe('createStripeAccountingDatabase: dispute（カード会社からの支払いの取り消し）', () => {
  const dispute = {
    id: 'dp_1', paymentIntentId: 'pi_1', chargeId: 'ch_1', orderId: null, amount: 5000, currency: 'jpy', reason: 'fraudulent',
    status: 'needs_response', isChargeRefundable: false, evidenceDueBy: '2026-07-01T00:00:00.000Z', evidenceDetails: { has_evidence: false },
    stripeCreatedAt: '2026-06-10T00:00:00.000Z',
  };
  const event = {
    stripeEventId: 'evt_1', eventType: 'charge.dispute.created', status: 'needs_response', occurredAt: '2026-06-10T00:05:00.000Z',
    stripeEventCreatedAt: null, balanceTransactionIds: ['txn_1'], rawPayload: { id: 'dp_1' },
  };

  it('FREQ-567-AC-01: recordDispute は DB の関数 record_stripe_dispute を呼び、表へ直接書かない', async () => {
    const rpc = jest.fn(async () => ({ data: { dispute_id: 'dp_1', event_inserted: true }, error: null }));
    const from = jest.fn();
    const database = createStripeAccountingDatabase({ rpc, from } as never);

    await expect(database.recordDispute!(dispute, event)).resolves.toEqual({ disputeId: 'dp_1', eventInserted: true });

    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('record_stripe_dispute', {
      _dispute: {
        id: 'dp_1', payment_intent_id: 'pi_1', charge_id: 'ch_1', order_id: null, amount: 5000, currency: 'jpy', reason: 'fraudulent',
        status: 'needs_response', is_charge_refundable: false, evidence_due_by: '2026-07-01T00:00:00.000Z',
        evidence_details: { has_evidence: false }, stripe_created_at: '2026-06-10T00:00:00.000Z',
      },
      _event: {
        stripe_event_id: 'evt_1', event_type: 'charge.dispute.created', status: 'needs_response', occurred_at: '2026-06-10T00:05:00.000Z',
        stripe_event_created_at: null, balance_transaction_ids: ['txn_1'], raw_payload: { id: 'dp_1' },
      },
    });
  });

  it('FREQ-567-AC-02: 履歴を足さない呼び方は _event をNULLで渡し、足さなかった答えを返す', async () => {
    const rpc = jest.fn(async () => ({ data: { dispute_id: 'dp_1', event_inserted: false }, error: null }));
    const database = createStripeAccountingDatabase({ rpc } as never);

    await expect(database.recordDispute!(dispute, null)).resolves.toEqual({ disputeId: 'dp_1', eventInserted: false });
    expect(rpc).toHaveBeenCalledWith('record_stripe_dispute', expect.objectContaining({ _event: null }));
  });

  it('FREQ-567-AC-02: DB の関数が失敗したら投げる（知らせの再試行に任せる）', async () => {
    const rpc = jest.fn(async () => ({ data: null, error: { message: 'ACCOUNTING_ARGUMENT_INVALID' } }));
    const database = createStripeAccountingDatabase({ rpc } as never);

    await expect(database.recordDispute!(dispute, event)).rejects.toThrow('ACCOUNTING_ARGUMENT_INVALID');
  });

  it('FREQ-567-AC-04: findDisputeStatus は表の今の状態を返し、無ければNULL', async () => {
    const builder: Record<string, jest.Mock> = {};
    builder.select = jest.fn(() => builder);
    builder.eq = jest.fn(() => builder);
    builder.maybeSingle = jest.fn()
      .mockResolvedValueOnce({ data: { status: 'under_review' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const from = jest.fn(() => builder);
    const database = createStripeAccountingDatabase({ from } as never);

    await expect(database.findDisputeStatus!('dp_1')).resolves.toBe('under_review');
    await expect(database.findDisputeStatus!('dp_2')).resolves.toBeNull();
    expect(from).toHaveBeenCalledWith('stripe_disputes');
    expect(builder.select).toHaveBeenCalledWith('status');
  });

  it('FREQ-567-AC-04: listOpenDisputeIds は決着していない（won・lost・warning_closed 以外の）番号を返す', async () => {
    const builder: Record<string, jest.Mock> = {};
    builder.select = jest.fn(() => builder);
    builder.not = jest.fn(() => builder);
    builder.limit = jest.fn(async () => ({ data: [{ id: 'dp_1' }, { id: 'dp_2' }], error: null }));
    const database = createStripeAccountingDatabase({ from: jest.fn(() => builder) } as never);

    await expect(database.listOpenDisputeIds!()).resolves.toEqual(['dp_1', 'dp_2']);
    expect(builder.not).toHaveBeenCalledWith('status', 'in', '(won,lost,warning_closed)');
  });
});
