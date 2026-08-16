import {
  upsertBalanceTransaction,
  upsertPayout,
  upsertRefund,
} from './accounting-store';
import type {
  StripeAccountingDatabase,
  StripeBalanceStatus,
  StripePayoutReconciliationStatus,
  StripePayoutStatus,
  StripeRefundStatus,
} from './accounting-types';

type StripeObject = Record<string, unknown>;
type RetrieveApi = { retrieve(id: string): Promise<StripeObject> };
type StripeAccountingClient = {
  paymentIntents?: RetrieveApi;
  charges?: RetrieveApi;
  refunds?: RetrieveApi;
  payouts?: RetrieveApi;
  balanceTransactions?: RetrieveApi & {
    list?(params: { payout: string; limit: number }): AsyncIterable<StripeObject>;
  };
};

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as StripeObject).id === 'string') {
    return (value as StripeObject).id as string;
  }
  return null;
}

function iso(epoch: unknown): string | null {
  return typeof epoch === 'number' ? new Date(epoch * 1000).toISOString() : null;
}

function requiredApi<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`Stripe ${name} API is unavailable`);
  return value;
}

async function saveBalanceTransaction(input: {
  database: StripeAccountingDatabase;
  transaction: StripeObject;
  paymentIntentId?: string | null;
  orderId?: string | null;
  payoutId?: string | null;
  syncedAt: string;
}) {
  const transaction = input.transaction;
  const createdAt = iso(transaction.created);
  if (!createdAt) throw new Error('Stripe balance transaction has no created timestamp');
  return upsertBalanceTransaction(input.database, {
    id: String(transaction.id),
    sourceId: idOf(transaction.source) ?? '',
    paymentIntentId: input.paymentIntentId ?? null,
    orderId: input.orderId ?? null,
    payoutId: input.payoutId ?? null,
    type: String(transaction.type),
    reportingCategory: String(transaction.reporting_category),
    amount: Number(transaction.amount),
    fee: Number(transaction.fee),
    net: Number(transaction.net),
    currency: String(transaction.currency).toLowerCase(),
    status: transaction.status as StripeBalanceStatus,
    availableOn: iso(transaction.available_on),
    stripeCreatedAt: createdAt,
    feeDetails: transaction.fee_details ?? [],
    rawPayload: transaction,
    syncedAt: input.syncedAt,
  });
}

async function findOrder(database: StripeAccountingDatabase, paymentIntentId: string) {
  if (!database.findOrderByPaymentIntent) {
    throw new Error('Stripe accounting database cannot resolve orders');
  }
  return database.findOrderByPaymentIntent(paymentIntentId);
}

export async function syncPaymentIntentAccounting(input: {
  stripe: StripeAccountingClient;
  database: StripeAccountingDatabase;
  paymentIntentId: string;
}) {
  const order = await findOrder(input.database, input.paymentIntentId);
  if (!order) return { disposition: 'unmatched' as const, balanceTransactionId: null };

  const paymentIntent = await requiredApi(input.stripe.paymentIntents, 'PaymentIntent')
    .retrieve(input.paymentIntentId);
  const chargeId = idOf(paymentIntent.latest_charge);
  if (!chargeId) throw new Error('Stripe PaymentIntent has no latest charge');
  const charge = await requiredApi(input.stripe.charges, 'Charge').retrieve(chargeId);
  const transactionId = idOf(charge.balance_transaction);
  if (!transactionId) throw new Error('Stripe Charge has no balance transaction');
  const transaction = await requiredApi(input.stripe.balanceTransactions, 'BalanceTransaction')
    .retrieve(transactionId);
  const stored = await saveBalanceTransaction({
    database: input.database,
    transaction,
    paymentIntentId: input.paymentIntentId,
    orderId: order.id,
    syncedAt: new Date().toISOString(),
  });
  return { disposition: stored.disposition, balanceTransactionId: transactionId };
}

export async function syncRefundAccounting(input: {
  stripe: StripeAccountingClient;
  database: StripeAccountingDatabase;
  refundId: string;
}) {
  const refund = await requiredApi(input.stripe.refunds, 'Refund').retrieve(input.refundId);
  const paymentIntentId = idOf(refund.payment_intent);
  if (!paymentIntentId) throw new Error('Stripe Refund has no PaymentIntent');
  const order = await findOrder(input.database, paymentIntentId);
  if (!order) return { disposition: 'unmatched' as const, refund: null };
  const syncedAt = new Date().toISOString();
  const balanceTransactionId = idOf(refund.balance_transaction);
  const failureTransactionId = idOf(refund.failure_balance_transaction);
  let succeededAt: string | null = null;

  for (const transactionId of [balanceTransactionId, failureTransactionId]) {
    if (!transactionId) continue;
    const transaction = await requiredApi(input.stripe.balanceTransactions, 'BalanceTransaction')
      .retrieve(transactionId);
    await saveBalanceTransaction({
      database: input.database, transaction, paymentIntentId, orderId: order.id, syncedAt,
    });
    if (transactionId === balanceTransactionId) succeededAt = iso(transaction.created);
  }

  const createdAt = iso(refund.created);
  if (!createdAt) throw new Error('Stripe Refund has no created timestamp');
  const refundInput = {
    id: String(refund.id), paymentIntentId, chargeId: idOf(refund.charge), orderId: order.id,
    amount: Number(refund.amount), currency: String(refund.currency).toLowerCase(),
    status: refund.status as StripeRefundStatus,
    reason: typeof refund.reason === 'string' ? refund.reason : null,
    balanceTransactionId, failureBalanceTransactionId: failureTransactionId,
    stripeCreatedAt: createdAt, succeededAt, rawPayload: refund, syncedAt,
  };
  const stored = await upsertRefund(input.database, refundInput);
  return { disposition: stored.disposition, refund: refundInput };
}

export async function syncPayoutAccounting(input: {
  stripe: StripeAccountingClient;
  database: StripeAccountingDatabase;
  payoutId: string;
}) {
  const payout = await requiredApi(input.stripe.payouts, 'Payout').retrieve(input.payoutId);
  const balanceApi = requiredApi(input.stripe.balanceTransactions, 'BalanceTransaction');
  const syncedAt = new Date().toISOString();
  const payoutTransactionId = idOf(payout.balance_transaction);
  let paidAt: string | null = null;
  if (payoutTransactionId) {
    const payoutTransaction = await balanceApi.retrieve(payoutTransactionId);
    paidAt = iso(payoutTransaction.created);
    await saveBalanceTransaction({
      database: input.database, transaction: payoutTransaction,
      payoutId: input.payoutId, syncedAt,
    });
  }

  let transactionCount = 0;
  let reconciledNet = 0;
  const listBalanceTransactions = requiredApi(balanceApi.list, 'BalanceTransaction list');
  for await (const transaction of listBalanceTransactions.call(balanceApi, {
    payout: input.payoutId,
    limit: 100,
  })) {
    transactionCount += 1;
    reconciledNet += Number(transaction.net);
    await saveBalanceTransaction({
      database: input.database, transaction, payoutId: input.payoutId, syncedAt,
    });
  }
  const amount = Number(payout.amount);
  const reconciliationStatus: StripePayoutReconciliationStatus =
    reconciledNet === amount ? 'matched' : 'mismatch';
  const createdAt = iso(payout.created);
  if (!createdAt) throw new Error('Stripe Payout has no created timestamp');
  await upsertPayout(input.database, {
    id: String(payout.id), amount, currency: String(payout.currency).toLowerCase(),
    status: payout.status as StripePayoutStatus, automatic: Boolean(payout.automatic),
    arrivalDate: iso(payout.arrival_date)?.slice(0, 10) ?? null,
    stripeCreatedAt: createdAt, paidAt, reconciliationStatus, reconciledNet,
    rawPayload: payout, syncedAt,
  });
  return { transactionCount, reconciliationStatus, reconciledNet };
}
