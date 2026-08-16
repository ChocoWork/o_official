export type StripeAccountingTable =
  | 'stripe_balance_transactions'
  | 'stripe_refunds'
  | 'stripe_payouts';

export interface StripeAccountingDatabase {
  findOrderByPaymentIntent?(
    paymentIntentId: string,
  ): Promise<{ id: string; currency: string } | null>;
  findById(table: StripeAccountingTable, id: string): Promise<Record<string, unknown> | null>;
  insert(table: StripeAccountingTable, values: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateById(
    table: StripeAccountingTable,
    id: string,
    values: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export type StripeStoreDisposition = 'inserted' | 'updated' | 'unchanged';
export type StripeBalanceStatus = 'pending' | 'available';
export type StripeRefundStatus =
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled';
export type StripePayoutStatus = 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
export type StripePayoutReconciliationStatus = 'pending' | 'matched' | 'mismatch';

export interface StripeBalanceTransactionInput {
  id: string;
  sourceId: string;
  paymentIntentId: string | null;
  orderId: string | null;
  payoutId: string | null;
  type: string;
  reportingCategory: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  status: StripeBalanceStatus;
  availableOn: string | null;
  stripeCreatedAt: string;
  feeDetails: unknown;
  rawPayload: unknown;
  syncedAt: string;
}

export interface StripeRefundInput {
  id: string;
  paymentIntentId: string;
  chargeId: string | null;
  orderId: string;
  amount: number;
  currency: string;
  status: StripeRefundStatus;
  reason: string | null;
  balanceTransactionId: string | null;
  failureBalanceTransactionId: string | null;
  stripeCreatedAt: string;
  succeededAt: string | null;
  rawPayload: unknown;
  syncedAt: string;
}

export interface StripePayoutInput {
  id: string;
  amount: number;
  currency: string;
  status: StripePayoutStatus;
  automatic: boolean;
  arrivalDate: string | null;
  stripeCreatedAt: string;
  paidAt: string | null;
  reconciliationStatus: StripePayoutReconciliationStatus;
  reconciledNet: number;
  rawPayload: unknown;
  syncedAt: string;
}

export type StripeBalanceTransactionRow = Record<string, unknown> & {
  id: string; source_id: string; amount: number; fee: number; net: number; currency: string;
};
export type StripeRefundRow = Record<string, unknown> & {
  id: string; order_id: string; payment_intent_id: string; amount: number; currency: string;
};
export type StripePayoutRow = Record<string, unknown> & {
  id: string; amount: number; currency: string; automatic: boolean;
};
