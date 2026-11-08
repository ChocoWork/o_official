export type StripeAccountingTable =
  | 'stripe_balance_transactions'
  | 'stripe_refunds'
  | 'stripe_payouts';

export interface StripeAccountingDatabase {
  findOrderByPaymentIntent?(
    paymentIntentId: string,
  ): Promise<{ id: string; currency: string } | null>;
  /**
   * dispute（カード会社からの支払いの取り消し）と履歴の保存（DB の private.record_stripe_dispute。service_role は表を直接書けない）。
   * event が null なら履歴を足さず、dispute の可変の欄だけを更新する。
   */
  recordDispute?(
    dispute: StripeDisputeInput,
    event: StripeDisputeEventInput | null,
  ): Promise<{ disputeId: string; eventInserted: boolean }>;
  /** 表にある dispute の今の状態（無ければ null） */
  findDisputeStatus?(disputeId: string): Promise<string | null>;
  /** 表の中で決着していない（won・lost・warning_closed 以外の）dispute の番号。作成の古い順に limit 件まで */
  listOpenDisputeIds?(limit: number): Promise<string[]>;
  /** その dispute の lost の履歴に、Stripe 側の時刻（stripe_event_created_at）が入った行が1つでもあるか */
  hasLostEventTime?(disputeId: string): Promise<boolean>;
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

/** record_stripe_dispute の _dispute（DB へ渡す時に snake_case へ直す） */
export interface StripeDisputeInput {
  id: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  orderId: string | null;
  amount: number;
  currency: string;
  reason: string;
  status: string;
  isChargeRefundable: boolean | null;
  evidenceDueBy: string | null;
  evidenceDetails: unknown;
  stripeCreatedAt: string;
  /** Stripe から取り直した時刻。DB は、これより新しい取り直しの状態を上書きしない */
  syncedAt: string;
}

/** record_stripe_dispute の _event。rawPayload にはお客様の個人情報が入りうる（service_role だけが読む・ログに出さない） */
export interface StripeDisputeEventInput {
  stripeEventId: string;
  eventType: string;
  status: string;
  occurredAt: string;
  stripeEventCreatedAt: string | null;
  balanceTransactionIds: string[];
  rawPayload: unknown;
}
