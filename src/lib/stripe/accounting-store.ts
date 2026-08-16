import type {
  StripeAccountingDatabase,
  StripeAccountingTable,
  StripeBalanceTransactionInput,
  StripeBalanceTransactionRow,
  StripePayoutInput,
  StripePayoutRow,
  StripeRefundInput,
  StripeRefundRow,
  StripeStoreDisposition,
} from './accounting-types';

type StoreResult<Row> = { disposition: StripeStoreDisposition; row: Row };

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function guardedUpsert<Row extends Record<string, unknown>>(
  database: StripeAccountingDatabase,
  table: StripeAccountingTable,
  id: string,
  complete: Row,
  immutableKeys: readonly string[],
  mutableKeys: readonly string[],
  mismatchMessage: string,
): Promise<StoreResult<Row>> {
  const existing = await database.findById(table, id);
  if (!existing) {
    return { disposition: 'inserted', row: await database.insert(table, complete) as Row };
  }

  if (immutableKeys.some((key) => !equal(existing[key], complete[key]))) {
    throw new Error(mismatchMessage);
  }

  const changes = Object.fromEntries(
    mutableKeys
      .filter((key) => !equal(existing[key], complete[key]))
      .map((key) => [key, complete[key]]),
  );
  if (Object.keys(changes).length === 0) {
    return { disposition: 'unchanged', row: existing as Row };
  }
  return {
    disposition: 'updated',
    row: await database.updateById(table, id, changes) as Row,
  };
}

export async function upsertBalanceTransaction(
  database: StripeAccountingDatabase,
  input: StripeBalanceTransactionInput,
): Promise<StoreResult<StripeBalanceTransactionRow>> {
  const row = {
    id: input.id, source_id: input.sourceId, payment_intent_id: input.paymentIntentId,
    order_id: input.orderId, payout_id: input.payoutId, type: input.type,
    reporting_category: input.reportingCategory, amount: input.amount, fee: input.fee,
    net: input.net, currency: input.currency, status: input.status,
    available_on: input.availableOn, stripe_created_at: input.stripeCreatedAt,
    fee_details: input.feeDetails, raw_payload: input.rawPayload, synced_at: input.syncedAt,
  };
  return guardedUpsert(
    database, 'stripe_balance_transactions', input.id, row,
    ['id', 'source_id', 'amount', 'fee', 'net', 'currency'],
    ['payment_intent_id', 'order_id', 'payout_id', 'type', 'reporting_category', 'status',
      'available_on', 'stripe_created_at', 'fee_details', 'raw_payload', 'synced_at'],
    'immutable Stripe balance transaction mismatch',
  );
}

export async function upsertRefund(
  database: StripeAccountingDatabase,
  input: StripeRefundInput,
): Promise<StoreResult<StripeRefundRow>> {
  const row = {
    id: input.id, payment_intent_id: input.paymentIntentId, charge_id: input.chargeId,
    order_id: input.orderId, amount: input.amount, currency: input.currency,
    status: input.status, reason: input.reason,
    balance_transaction_id: input.balanceTransactionId,
    failure_balance_transaction_id: input.failureBalanceTransactionId,
    stripe_created_at: input.stripeCreatedAt, succeeded_at: input.succeededAt,
    raw_payload: input.rawPayload, synced_at: input.syncedAt,
  };
  return guardedUpsert(
    database, 'stripe_refunds', input.id, row,
    ['id', 'order_id', 'payment_intent_id', 'amount', 'currency'],
    ['charge_id', 'status', 'reason', 'balance_transaction_id',
      'failure_balance_transaction_id', 'stripe_created_at', 'succeeded_at',
      'raw_payload', 'synced_at'],
    'immutable Stripe refund mismatch',
  );
}

export async function upsertPayout(
  database: StripeAccountingDatabase,
  input: StripePayoutInput,
): Promise<StoreResult<StripePayoutRow>> {
  const row = {
    id: input.id, amount: input.amount, currency: input.currency, status: input.status,
    automatic: input.automatic, arrival_date: input.arrivalDate,
    stripe_created_at: input.stripeCreatedAt, paid_at: input.paidAt,
    reconciliation_status: input.reconciliationStatus, reconciled_net: input.reconciledNet,
    raw_payload: input.rawPayload, synced_at: input.syncedAt,
  };
  return guardedUpsert(
    database, 'stripe_payouts', input.id, row,
    ['id', 'amount', 'currency', 'automatic'],
    ['status', 'arrival_date', 'stripe_created_at', 'paid_at', 'reconciliation_status',
      'reconciled_net', 'raw_payload', 'synced_at'],
    'immutable Stripe payout mismatch',
  );
}
