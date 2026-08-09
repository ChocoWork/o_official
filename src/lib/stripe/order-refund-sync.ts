type QueryError = { message?: string } | null;

type OrderRefundRow = {
  id: string;
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  total_amount: number;
};

type OrderRefundTable = {
  select(columns: string): {
    eq(column: string, value: string): {
      maybeSingle(): Promise<{ data: OrderRefundRow | null; error: QueryError }>;
    };
  };
  update(values: Record<string, unknown>): {
    eq(column: string, value: string): Promise<{ error: QueryError }>;
  };
};

export type OrderRefundDatabase = {
  from(table: 'orders'): OrderRefundTable;
};

export type RefundSnapshot = {
  status: string | null;
  amount: number;
  created: number;
};

export type RefundListClient = {
  refunds: {
    list(params: { payment_intent: string; limit: number }): AsyncIterable<RefundSnapshot>;
  };
};

export type OrderRefundSyncResult = {
  orderId: string;
  refundedAmount: number;
  orderStatus: OrderRefundRow['status'];
};

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

export async function syncOrderRefunds({
  database,
  stripe,
  paymentIntentId,
}: {
  database: OrderRefundDatabase;
  stripe: RefundListClient;
  paymentIntentId: string;
}): Promise<OrderRefundSyncResult> {
  const { data: order, error: orderError } = await database
    .from('orders')
    .select('id, status, total_amount')
    .eq('payment_intent_id', paymentIntentId)
    .maybeSingle();

  if (orderError) {
    throw new Error(`Failed to read order refund state: ${orderError.message ?? 'database error'}`);
  }
  if (!order) {
    throw new Error('Order not found for Stripe PaymentIntent');
  }

  const refunds: RefundSnapshot[] = [];
  for await (const refund of stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 })) {
    refunds.push(refund);
  }

  const succeeded = calculateSucceededRefundTotal(refunds);
  const refundedAmount = Math.min(succeeded.amount, order.total_amount);
  const orderStatus = refundedAmount >= order.total_amount ? 'cancelled' : order.status;
  const { error: updateError } = await database
    .from('orders')
    .update({
      refunded_amount: refundedAmount,
      refunded_at: succeeded.latestSucceededAt
        ? new Date(succeeded.latestSucceededAt * 1_000).toISOString()
        : null,
      payment_status_updated_at: new Date().toISOString(),
      status: orderStatus,
    })
    .eq('id', order.id);

  if (updateError) {
    throw new Error(`Failed to update order refund state: ${updateError.message ?? 'database error'}`);
  }

  return { orderId: order.id, refundedAmount, orderStatus };
}
