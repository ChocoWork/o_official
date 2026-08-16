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

export type StripeReconciliationError = { sourceId: string; reason: string };

export type StripeOrderReconciliationReport = {
  checkedPayments: number;
  unmatchedActivePayments: string[];
  refundMismatches: Array<{ paymentIntentId: string; stripe: number; database: number }>;
  syncedBalanceTransactions: number;
  syncedRefunds: number;
  errors: StripeReconciliationError[];
};

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export async function reconcileStripeOrders({
  database,
  stripe,
  syncRefunds,
  syncAccounting,
}: {
  database: ReconcileDatabase;
  stripe: ReconcileStripe;
  syncRefunds: (paymentIntentId: string) => Promise<unknown>;
  syncAccounting?: (paymentIntentId: string) => Promise<unknown>;
}): Promise<StripeOrderReconciliationReport> {
  const { data: orders, error } = await database.from('orders').select('payment_intent_id, refunded_amount');
  if (error) throw new Error(`Failed to load orders: ${error.message ?? 'database error'}`);
  const ordersByPayment = new Map((orders ?? []).map((order) => [order.payment_intent_id, order]));
  const report: StripeOrderReconciliationReport = {
    checkedPayments: 0,
    unmatchedActivePayments: [],
    refundMismatches: [],
    syncedBalanceTransactions: 0,
    syncedRefunds: 0,
    errors: [],
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
      report.syncedRefunds += 1;
    }

    if (syncAccounting) {
      try {
        await syncAccounting(payment.id);
        report.syncedBalanceTransactions += 1;
      } catch (error) {
        report.errors.push({ sourceId: payment.id, reason: reasonOf(error) });
      }
    }
  }
  return report;
}

type PayoutSnapshot = { id: string };
type ReconcilePayoutStripe = {
  payouts: { list(params?: { limit: number }): AsyncIterable<PayoutSnapshot> | Iterable<PayoutSnapshot> };
};

export type StripePayoutReconciliationReport = {
  syncedPayouts: number;
  payoutMismatches: number;
  errors: StripeReconciliationError[];
};

export async function reconcileStripePayouts({
  stripe,
  syncPayout,
}: {
  stripe: ReconcilePayoutStripe;
  syncPayout: (payoutId: string) => Promise<{ reconciliationStatus: string }>;
}): Promise<StripePayoutReconciliationReport> {
  const report: StripePayoutReconciliationReport = {
    syncedPayouts: 0,
    payoutMismatches: 0,
    errors: [],
  };

  for await (const payout of stripe.payouts.list({ limit: 100 })) {
    try {
      const result = await syncPayout(payout.id);
      report.syncedPayouts += 1;
      if (result.reconciliationStatus === 'mismatch') report.payoutMismatches += 1;
    } catch (error) {
      report.errors.push({ sourceId: payout.id, reason: reasonOf(error) });
    }
  }
  return report;
}

export type { ReconcileDatabase, ReconcileStripe, ReconcilePayoutStripe };
