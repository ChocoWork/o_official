type QueryError = { message?: string } | null;

type RefundableOrderStatus = 'paid' | 'shipped' | 'cancelled';

type OrderRefundRow = {
  id: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'shipped';
  total_amount: number;
  refunded_amount: number;
  payment_status_updated_at: string | null;
  shipped_at: string | null;
};

type OrderRefundTable = {
  select(columns: string): {
    eq(column: string, value: string): {
      maybeSingle(): Promise<{ data: OrderRefundRow | null; error: QueryError }>;
    };
  };
};

type RefundProjectionRow = {
  id: string;
  status: RefundableOrderStatus;
  refunded_amount: number;
};

type RefundProjectionArguments = {
  _actor_id: string | null;
  _expected_payment_status_updated_at: string | null;
  _expected_refunded_amount: number;
  _expected_status: OrderRefundRow['status'];
  _order_id: string;
  _payment_status_updated_at: string;
  _refunded_amount: number;
  _refunded_at: string | null;
};

export type OrderRefundDatabase = {
  from(table: 'orders'): OrderRefundTable;
  rpc(
    functionName: 'apply_order_refund_projection',
    args: RefundProjectionArguments,
  ): Promise<{ data: RefundProjectionRow[] | RefundProjectionRow | null; error: QueryError }>;
};

export type RefundSnapshot = {
  status: string | null;
  amount: number;
  created: number;
};

export type RefundListClient = {
  refunds: {
    // Stripe's AsyncIterable auto-pagination follows every page even though each
    // request is capped at 100 records.
    list(params: { payment_intent: string; limit: number }): AsyncIterable<RefundSnapshot>;
  };
};

export type OrderRefundSyncResult = {
  orderId: string;
  refundedAmount: number;
  orderStatus: RefundableOrderStatus;
};

type StripeRefundProjection = {
  refundedAmount: number;
  refundedAt: string | null;
};

const MAX_PROJECTION_ATTEMPTS = 3;

/**
 * No order carries the PaymentIntent (for example a payment that could not become an order).
 * It stays an Error with the same message, so callers that only propagate failures behave as before.
 */
export class OrderNotFoundForPaymentIntentError extends Error {
  constructor() {
    super('Order not found for Stripe PaymentIntent');
    this.name = 'OrderNotFoundForPaymentIntentError';
  }
}

export function calculateSucceededRefundTotal(
  refunds: readonly RefundSnapshot[],
): { amount: number; latestSucceededAt: number | null } {
  let amount = 0;
  let latestSucceededAt: number | null = null;

  for (const refund of refunds) {
    if (refund.status !== 'succeeded') continue;
    amount += Math.max(0, refund.amount);
    latestSucceededAt = Math.max(latestSucceededAt ?? 0, refund.created);
  }

  return { amount, latestSucceededAt };
}

async function readStripeRefundProjection({
  stripe,
  paymentIntentId,
  totalAmount,
}: {
  stripe: RefundListClient;
  paymentIntentId: string;
  totalAmount: number;
}): Promise<StripeRefundProjection> {
  const refunds: RefundSnapshot[] = [];
  for await (const refund of stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
    refunds.push(refund);
  }

  const succeeded = calculateSucceededRefundTotal(refunds);
  return {
    // The database invariant caps the order projection at the order total even
    // when Stripe contains overlapping or otherwise excessive successful refunds.
    refundedAmount: Math.min(succeeded.amount, totalAmount),
    refundedAt: succeeded.latestSucceededAt
      ? new Date(succeeded.latestSucceededAt * 1_000).toISOString()
      : null,
  };
}

function deriveProjectedStatus(
  order: OrderRefundRow,
  refundedAmount: number,
): RefundableOrderStatus {
  if (order.status !== 'paid' && order.status !== 'shipped' && order.status !== 'cancelled') {
    throw new Error(`Order status is not refundable: ${order.status}`);
  }

  if (refundedAmount >= order.total_amount) {
    return 'cancelled';
  }

  if (order.status === 'cancelled' && order.refunded_amount >= order.total_amount) {
    return order.shipped_at ? 'shipped' : 'paid';
  }

  return order.status;
}

export async function syncOrderRefunds({
  database,
  stripe,
  paymentIntentId,
  actorId = null,
}: {
  database: OrderRefundDatabase;
  stripe: RefundListClient;
  paymentIntentId: string;
  actorId?: string | null;
}): Promise<OrderRefundSyncResult> {
  for (let attempt = 1; attempt <= MAX_PROJECTION_ATTEMPTS; attempt += 1) {
    const { data: order, error: orderError } = await database
      .from('orders')
      .select('id, status, total_amount, refunded_amount, payment_status_updated_at, shipped_at')
      .eq('payment_intent_id', paymentIntentId)
      .maybeSingle();

    if (orderError) {
      throw new Error(`Failed to read order refund state: ${orderError.message ?? 'database error'}`);
    }
    if (!order) {
      throw new OrderNotFoundForPaymentIntentError();
    }

    // Existing unpaid cancellations predate the refund projection contract.
    // Keep them unchanged rather than mixing a later refund projection into a
    // cancellation that did not originate from a successful full refund.
    if (order.status === 'cancelled' && order.refunded_amount < order.total_amount) {
      return {
        orderId: order.id,
        refundedAmount: order.refunded_amount,
        orderStatus: 'cancelled',
      };
    }

    const stripeProjection = await readStripeRefundProjection({
      stripe,
      paymentIntentId,
      totalAmount: order.total_amount,
    });
    const projectionUpdatedAt = new Date().toISOString();

    const { data, error: projectionError } = await database.rpc(
      'apply_order_refund_projection',
      {
        _actor_id: actorId,
        _expected_payment_status_updated_at: order.payment_status_updated_at,
        _expected_refunded_amount: order.refunded_amount,
        _expected_status: order.status,
        _order_id: order.id,
        _payment_status_updated_at: projectionUpdatedAt,
        _refunded_amount: stripeProjection.refundedAmount,
        _refunded_at: stripeProjection.refundedAt,
      },
    );

    if (projectionError) {
      throw new Error(
        `Failed to update order refund state: ${projectionError.message ?? 'database error'}`,
      );
    }

    const projectedOrder = Array.isArray(data) ? data[0] : data;
    if (!projectedOrder) {
      continue;
    }

    // A newer refund.failed/refund.updated can change Stripe after the first
    // read while leaving status and refunded_amount unchanged in the database.
    // Re-read Stripe after the write so an older snapshot cannot win last.
    const confirmedProjection = await readStripeRefundProjection({
      stripe,
      paymentIntentId,
      totalAmount: order.total_amount,
    });
    const confirmedStatus = deriveProjectedStatus(order, confirmedProjection.refundedAmount);
    if (
      projectedOrder.refunded_amount !== confirmedProjection.refundedAmount
      || projectedOrder.status !== confirmedStatus
    ) {
      continue;
    }

    return {
      orderId: projectedOrder.id,
      refundedAmount: projectedOrder.refunded_amount,
      orderStatus: projectedOrder.status,
    };
  }

  throw new Error(
    'Failed to update order refund state after concurrent updates or changing Stripe refund state',
  );
}