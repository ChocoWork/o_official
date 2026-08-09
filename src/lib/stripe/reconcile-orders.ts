import { calculateSucceededRefundTotal, type RefundSnapshot } from './order-refund-sync';

type OrderState = { payment_intent_id: string; refunded_amount: number | null };
type ReconcileDatabase = {
  from(table: 'orders'): {
    select(columns: string): Promise<{ data: OrderState[] | null; error: { message?: string } | null }>;
  };
};
type PaymentIntentSnapshot = { id: string; status: string; amount: number };
type ReconcileStripe = {
  paymentIntents: { list(params: { limit: number }): AsyncIterable<PaymentIntentSnapshot> | Iterable<PaymentIntentSnapshot> };
  refunds: { list(params: { payment_intent: string; limit: number }): AsyncIterable<RefundSnapshot> | Iterable<RefundSnapshot> };
};

export type StripeOrderReconciliationReport = {
  checkedPayments: number;
  unmatchedActivePayments: string[];
  refundMismatches: Array<{ paymentIntentId: string; stripe: number; database: number }>;
};

export async function reconcileStripeOrders({
  database,
  stripe,
  syncRefunds,
}: {
  database: ReconcileDatabase;
  stripe: ReconcileStripe;
  syncRefunds: (paymentIntentId: string) => Promise<unknown>;
}): Promise<StripeOrderReconciliationReport> {
  const { data: orders, error } = await database.from('orders').select('payment_intent_id, refunded_amount');
  if (error) throw new Error(`Failed to load orders: ${error.message ?? 'database error'}`);
  const ordersByPayment = new Map((orders ?? []).map((order) => [order.payment_intent_id, order]));
  const report: StripeOrderReconciliationReport = {
    checkedPayments: 0,
    unmatchedActivePayments: [],
    refundMismatches: [],
  };

  for await (const payment of stripe.paymentIntents.list({ limit: 100 })) {
    if (payment.status !== 'succeeded') continue;
    report.checkedPayments += 1;
    const refunds: RefundSnapshot[] = [];
    for await (const refund of stripe.refunds.list({ payment_intent: payment.id, limit: 100 })) refunds.push(refund);
    const stripeRefunded = calculateSucceededRefundTotal(refunds).amount;
    const order = ordersByPayment.get(payment.id);
    if (!order) {
      if (stripeRefunded < payment.amount) report.unmatchedActivePayments.push(payment.id);
      continue;
    }
    const databaseRefunded = order.refunded_amount ?? 0;
    if (stripeRefunded !== databaseRefunded) {
      report.refundMismatches.push({ paymentIntentId: payment.id, stripe: stripeRefunded, database: databaseRefunded });
      await syncRefunds(payment.id);
    }
  }
  return report;
}

export type { ReconcileDatabase, ReconcileStripe };
