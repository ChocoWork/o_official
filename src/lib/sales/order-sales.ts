export type OrderSalesStatus = 'pending' | 'paid' | 'failed' | 'cancelled';

export type OrderSalesRow = {
  id: string;
  payment_intent_id: string;
  status: OrderSalesStatus;
  total_amount: number;
  refunded_amount: number | null;
  currency: string;
  created_at: string;
};

export type OrderSalesTransaction = {
  source: 'order';
  sourceId: string;
  paymentIntentId: string;
  date: string;
  grossAmount: number;
  refundedAmount: number;
  netAmount: number;
  currency: string;
  readOnly: true;
};

export function toOrderSalesTransaction(
  row: OrderSalesRow,
): OrderSalesTransaction | null {
  const grossAmount = Math.max(0, Number(row.total_amount));
  const refundedAmount = Math.min(
    Math.max(0, Number(row.refunded_amount ?? 0)),
    grossAmount,
  );

  const isPaidSale = row.status === 'paid';
  const isRefundedSale = row.status === 'cancelled' && refundedAmount > 0;
  if (!isPaidSale && !isRefundedSale) {
    return null;
  }

  return {
    source: 'order',
    sourceId: row.id,
    paymentIntentId: row.payment_intent_id,
    date: row.created_at,
    grossAmount,
    refundedAmount,
    netAmount: grossAmount - refundedAmount,
    currency: row.currency,
    readOnly: true,
  };
}
