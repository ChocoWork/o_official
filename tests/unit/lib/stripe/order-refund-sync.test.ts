import {
  calculateSucceededRefundTotal,
  syncOrderRefunds,
  type OrderRefundDatabase,
  type RefundListClient,
} from '@/lib/stripe/order-refund-sync';

describe('calculateSucceededRefundTotal', () => {
  it('counts only succeeded refunds', () => {
    expect(calculateSucceededRefundTotal([
      { status: 'succeeded', amount: 3_000, created: 10 },
      { status: 'requires_action', amount: 4_000, created: 20 },
      { status: 'failed', amount: 5_000, created: 30 },
    ])).toEqual({ amount: 3_000, latestSucceededAt: 10 });
  });
});

function asyncRefunds(rows: Array<{ status: string | null; amount: number; created: number }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const row of rows) yield row;
    },
  };
}

function createDatabase(totalAmount = 10_000) {
  const maybeSingle = jest.fn().mockResolvedValue({
    data: { id: 'order-1', status: 'paid', total_amount: totalAmount },
    error: null,
  });
  const selectEq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq: selectEq });
  const updateEq = jest.fn().mockResolvedValue({ error: null });
  const update = jest.fn().mockReturnValue({ eq: updateEq });
  const from = jest.fn().mockReturnValue({ select, update });

  return {
    database: { from } as unknown as OrderRefundDatabase,
    update,
  };
}

describe('syncOrderRefunds', () => {
  it('does not reduce sales for a requires_action refund', async () => {
    const { database, update } = createDatabase();
    const stripe = {
      refunds: {
        list: jest.fn().mockReturnValue(asyncRefunds([
          { status: 'requires_action', amount: 10_000, created: 20 },
        ])),
      },
    } as unknown as RefundListClient;

    const result = await syncOrderRefunds({ database, stripe, paymentIntentId: 'pi_1' });

    expect(result.refundedAmount).toBe(0);
    expect(result.orderStatus).toBe('paid');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      refunded_amount: 0,
      status: 'paid',
    }));
  });

  it('cancels an order only after succeeded refunds reach the total', async () => {
    const { database, update } = createDatabase();
    const stripe = {
      refunds: {
        list: jest.fn().mockReturnValue(asyncRefunds([
          { status: 'succeeded', amount: 4_000, created: 20 },
          { status: 'succeeded', amount: 6_000, created: 30 },
        ])),
      },
    } as unknown as RefundListClient;

    const result = await syncOrderRefunds({ database, stripe, paymentIntentId: 'pi_1' });

    expect(result.refundedAmount).toBe(10_000);
    expect(result.orderStatus).toBe('cancelled');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      refunded_amount: 10_000,
      status: 'cancelled',
    }));
  });
});
