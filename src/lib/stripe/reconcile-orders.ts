import { calculateSucceededRefundTotal, type RefundSnapshot } from './order-refund-sync';
import { ReconcileTransientError } from './checkout-payment-reader';
import { webhookFailureCause, type WebhookFailureCause } from './webhook-events';

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

/** 照合の1件ずつの失敗。原因の記号だけを残す（設計書 2026-10-05 グループ B の 3-3・4-5） */
export type StripeReconciliationError = { sourceId: string; reason: WebhookFailureCause };

export type StripeOrderReconciliationReport = {
  checkedPayments: number;
  unmatchedActivePayments: string[];
  refundMismatches: Array<{ paymentIntentId: string; stripe: number; database: number }>;
  syncedBalanceTransactions: number;
  syncedRefunds: number;
  errors: StripeReconciliationError[];
};

function failureOf(sourceId: string, error: unknown): StripeReconciliationError {
  return { sourceId, reason: webhookFailureCause(error) };
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
  if (error) throw new ReconcileTransientError('db_unavailable');
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
    const order = ordersByPayment.get(payment.id);

    // 支払いごとに失敗を受け止め、その回の残りを止めない（設計書 4-5）
    try {
      const refunds: RefundSnapshot[] = [];
      for await (const refund of stripe.refunds.list({ payment_intent: payment.id, limit: 100 })) refunds.push(refund);
      const stripeRefunded = calculateSucceededRefundTotal(refunds).amount;
      if (!order) {
        if (stripeRefunded < payment.amount) report.unmatchedActivePayments.push(payment.id);
      } else {
        const databaseRefunded = order.refunded_amount ?? 0;
        if (stripeRefunded !== databaseRefunded) {
          report.refundMismatches.push({ paymentIntentId: payment.id, stripe: stripeRefunded, database: databaseRefunded });
          await syncRefunds(payment.id);
          report.syncedRefunds += 1;
        }
      }
    } catch (refundError) {
      report.errors.push(failureOf(payment.id, refundError));
    }

    if (!order || !syncAccounting) continue;
    try {
      await syncAccounting(payment.id);
      report.syncedBalanceTransactions += 1;
    } catch (accountingError) {
      report.errors.push(failureOf(payment.id, accountingError));
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
      report.errors.push(failureOf(payout.id, error));
    }
  }
  return report;
}

export type { ReconcileDatabase, ReconcileStripe, ReconcilePayoutStripe };
