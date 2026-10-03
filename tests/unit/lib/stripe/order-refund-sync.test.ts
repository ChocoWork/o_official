import {
  calculateSucceededRefundTotal,
  OrderNotFoundForPaymentIntentError,
  syncOrderRefunds,
  type OrderRefundDatabase,
  type RefundListClient,
} from '@/lib/stripe/order-refund-sync';

type TestOrder = {
  id: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'shipped';
  total_amount: number;
  refunded_amount: number;
  payment_status_updated_at: string | null;
  shipped_at: string | null;
};

const BASE_ORDER: TestOrder = {
  id: 'order-1',
  status: 'paid',
  total_amount: 10_000,
  refunded_amount: 0,
  payment_status_updated_at: null,
  shipped_at: null,
};

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

function createDatabase({
  orders = [BASE_ORDER],
  rpcResults,
}: {
  orders?: TestOrder[];
  rpcResults?: Array<{ data: unknown; error: { message?: string } | null }>;
} = {}) {
  const maybeSingle = jest.fn();
  orders.forEach((order) => maybeSingle.mockResolvedValueOnce({ data: order, error: null }));
  const selectEq = jest.fn().mockReturnValue({ maybeSingle });
  const select = jest.fn().mockReturnValue({ eq: selectEq });
  const from = jest.fn().mockReturnValue({ select });
  const rpc = jest.fn();
  const defaults = rpcResults ?? [{
    data: [{ id: 'order-1', status: 'paid', refunded_amount: 0 }],
    error: null,
  }];
  defaults.forEach((result) => rpc.mockResolvedValueOnce(result));

  return {
    database: { from, rpc } as unknown as OrderRefundDatabase,
    maybeSingle,
    rpc,
  };
}

function createStripe(refunds: Array<{ status: string | null; amount: number; created: number }>) {
  return {
    refunds: {
      list: jest.fn().mockImplementation(() => asyncRefunds(refunds)),
    },
  } as unknown as RefundListClient;
}

describe('syncOrderRefunds', () => {
  it('does not count a requires_action refund and applies the projection through the RPC', async () => {
    const { database, rpc } = createDatabase();
    const stripe = createStripe([{ status: 'requires_action', amount: 10_000, created: 20 }]);

    const result = await syncOrderRefunds({
      database,
      stripe,
      paymentIntentId: 'pi_1',
      actorId: 'admin-1',
    });

    expect(result).toEqual({ orderId: 'order-1', refundedAmount: 0, orderStatus: 'paid' });
    expect(rpc).toHaveBeenCalledWith('apply_order_refund_projection', expect.objectContaining({
      _actor_id: 'admin-1',
      _expected_payment_status_updated_at: null,
      _expected_refunded_amount: 0,
      _expected_status: 'paid',
      _order_id: 'order-1',
      _refunded_amount: 0,
      _refunded_at: null,
      _payment_status_updated_at: expect.any(String),
    }));
  });

  it('cancels an order only after succeeded refunds reach the total', async () => {
    const { database, rpc } = createDatabase({
      rpcResults: [{
        data: [{ id: 'order-1', status: 'cancelled', refunded_amount: 10_000 }],
        error: null,
      }],
    });
    const stripe = createStripe([
      { status: 'succeeded', amount: 4_000, created: 20 },
      { status: 'succeeded', amount: 6_000, created: 30 },
    ]);

    const result = await syncOrderRefunds({ database, stripe, paymentIntentId: 'pi_1' });

    expect(result).toEqual({ orderId: 'order-1', refundedAmount: 10_000, orderStatus: 'cancelled' });
    expect(rpc).toHaveBeenCalledWith('apply_order_refund_projection', expect.objectContaining({
      _expected_payment_status_updated_at: null,
      _expected_refunded_amount: 0,
      _expected_status: 'paid',
      _refunded_amount: 10_000,
      _refunded_at: new Date(30_000).toISOString(),
    }));
  });

  it('uses Stripe auto-pagination so 101 succeeded refunds are all included', async () => {
    const refunds = Array.from({ length: 101 }, (_, index) => ({
      status: 'succeeded',
      amount: 100,
      created: index + 1,
    }));
    const order = { ...BASE_ORDER, total_amount: 10_100 };
    const { database, rpc } = createDatabase({
      orders: [order],
      rpcResults: [{
        data: [{ id: 'order-1', status: 'cancelled', refunded_amount: 10_100 }],
        error: null,
      }],
    });
    const stripe = createStripe(refunds);

    await syncOrderRefunds({ database, stripe, paymentIntentId: 'pi_many' });

    expect(rpc).toHaveBeenCalledWith('apply_order_refund_projection', expect.objectContaining({
      _refunded_amount: 10_100,
    }));
  });

  it('leaves a legacy unpaid cancellation outside the refund projection path', async () => {
    const legacyCancelled = {
      ...BASE_ORDER,
      status: 'cancelled' as const,
      refunded_amount: 0,
    };
    const { database, rpc } = createDatabase({ orders: [legacyCancelled] });
    const stripe = createStripe([{ status: 'succeeded', amount: 1_000, created: 20 }]);

    const result = await syncOrderRefunds({
      database,
      stripe,
      paymentIntentId: 'pi_legacy_cancelled',
    });

    expect(result).toEqual({
      orderId: 'order-1',
      refundedAmount: 0,
      orderStatus: 'cancelled',
    });
    expect(stripe.refunds.list).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('repairs a stale successful projection when post-write Stripe verification changed', async () => {
    const projectionTimestamp = '2026-09-22T00:00:00.000Z';
    const { database, rpc } = createDatabase({
      orders: [
        BASE_ORDER,
        {
          ...BASE_ORDER,
          status: 'cancelled',
          refunded_amount: 10_000,
          payment_status_updated_at: projectionTimestamp,
        },
      ],
      rpcResults: [
        { data: [{ id: 'order-1', status: 'cancelled', refunded_amount: 10_000 }], error: null },
        { data: [{ id: 'order-1', status: 'paid', refunded_amount: 0 }], error: null },
      ],
    });
    const list = jest.fn()
      .mockImplementationOnce(() => asyncRefunds([
        { status: 'succeeded', amount: 10_000, created: 30 },
      ]))
      .mockImplementationOnce(() => asyncRefunds([]))
      .mockImplementationOnce(() => asyncRefunds([]))
      .mockImplementationOnce(() => asyncRefunds([]));
    const stripe = { refunds: { list } } as unknown as RefundListClient;

    const result = await syncOrderRefunds({
      database,
      stripe,
      paymentIntentId: 'pi_stale_snapshot',
    });

    expect(result).toEqual({ orderId: 'order-1', refundedAmount: 0, orderStatus: 'paid' });
    expect(list).toHaveBeenCalledTimes(4);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith('apply_order_refund_projection', expect.objectContaining({
      _expected_payment_status_updated_at: projectionTimestamp,
      _expected_refunded_amount: 10_000,
      _expected_status: 'cancelled',
      _refunded_amount: 0,
    }));
  });
  it('re-reads Stripe and the order after a CAS conflict, then succeeds', async () => {
    const { database, maybeSingle, rpc } = createDatabase({
      orders: [BASE_ORDER, { ...BASE_ORDER, refunded_amount: 4_000 }],
      rpcResults: [
        { data: [], error: null },
        { data: [{ id: 'order-1', status: 'cancelled', refunded_amount: 10_000 }], error: null },
      ],
    });
    const stripe = createStripe([{ status: 'succeeded', amount: 10_000, created: 30 }]);

    const result = await syncOrderRefunds({ database, stripe, paymentIntentId: 'pi_retry' });

    expect(result.orderStatus).toBe('cancelled');
    expect(maybeSingle).toHaveBeenCalledTimes(2);
    expect(stripe.refunds.list).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith('apply_order_refund_projection', expect.objectContaining({
      _expected_refunded_amount: 4_000,
      _expected_status: 'paid',
    }));
  });

  it('throws after three CAS conflicts so the webhook can return 5xx', async () => {
    const { database, rpc } = createDatabase({
      orders: [BASE_ORDER, BASE_ORDER, BASE_ORDER],
      rpcResults: [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ],
    });
    const stripe = createStripe([{ status: 'succeeded', amount: 10_000, created: 30 }]);

    await expect(syncOrderRefunds({
      database,
      stripe,
      paymentIntentId: 'pi_conflict',
    })).rejects.toThrow('concurrent updates');

    expect(stripe.refunds.list).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('surfaces an RPC error without retrying it as a conflict', async () => {
    const { database, rpc } = createDatabase({
      rpcResults: [{ data: null, error: { message: 'permission denied' } }],
    });
    const stripe = createStripe([]);

    await expect(syncOrderRefunds({
      database,
      stripe,
      paymentIntentId: 'pi_error',
    })).rejects.toThrow('permission denied');

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('throws a typed error, with the same message as before, when no order has the PaymentIntent', async () => {
    const { database, maybeSingle, rpc } = createDatabase({ orders: [] });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const stripe = createStripe([{ status: 'succeeded', amount: 1_000, created: 20 }]);

    const error = await syncOrderRefunds({
      database,
      stripe,
      paymentIntentId: 'pi_without_order',
    }).catch((caught: unknown) => caught);

    // The cron reconcile job and the admin refund route only see an Error with this message, as before.
    expect(error).toBeInstanceOf(OrderNotFoundForPaymentIntentError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Order not found for Stripe PaymentIntent');
    expect(stripe.refunds.list).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not mistake a failed order read for a missing order', async () => {
    const { database, maybeSingle } = createDatabase({ orders: [] });
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'connection lost' } });
    const stripe = createStripe([]);

    const error = await syncOrderRefunds({
      database,
      stripe,
      paymentIntentId: 'pi_read_failed',
    }).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(OrderNotFoundForPaymentIntentError);
    expect((error as Error).message).toBe('Failed to read order refund state: connection lost');
  });
});
