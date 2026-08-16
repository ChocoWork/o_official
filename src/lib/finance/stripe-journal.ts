import { accountByCode } from './accounts';
import type { JournalEntry, JournalLine } from './journal';
import type {
  StripeBalanceTransactionRow,
  StripePayoutRow,
  StripeRefundRow,
} from '@/lib/stripe/accounting-types';

export type StripeJournalOrder = {
  id: string;
  paymentIntentId: string;
  totalAmount: number;
  currency: string;
  customerName?: string;
};

export type StripeJournalInput = {
  orders: readonly StripeJournalOrder[];
  balanceTransactions: readonly StripeBalanceTransactionRow[];
  refunds: readonly StripeRefundRow[];
  payouts: readonly StripePayoutRow[];
};

function hash(value: string): number {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

function line(code: string, debit: number, credit: number): JournalLine {
  const account = accountByCode(code);
  if (!account) throw new Error(`Unknown accounting code: ${code}`);
  return { account, debit, credit };
}

function entry(
  sourceKey: string,
  dateTime: unknown,
  description: string,
  partner: string,
  lines: JournalLine[],
): JournalEntry | null {
  if (typeof dateTime !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(dateTime)) return null;
  const date = dateTime.slice(0, 10);
  const stable = hash(sourceKey);
  return {
    entryId: -(stable + 1), sourceKey,
    number: `JE-${date.replaceAll('-', '')}-S${stable.toString(36).toUpperCase()}`,
    date, description, partner, lines,
  };
}

export function buildStripeJournal(input: StripeJournalInput): JournalEntry[] {
  const output: JournalEntry[] = [];
  const keys = new Set<string>();
  const orders = new Map(input.orders.map((order) => [order.id, order]));
  const chargeCategories = new Set(['charge', 'payment']);
  const refundCategories = new Set(['refund', 'payment_refund']);
  const standaloneFeeCategories = new Set(['stripe_fee', 'stripe_fx_fee', 'tax_fee']);

  const add = (candidate: JournalEntry | null) => {
    if (candidate?.sourceKey && !keys.has(candidate.sourceKey)) {
      keys.add(candidate.sourceKey);
      output.push(candidate);
    }
  };

  for (const transaction of input.balanceTransactions) {
    const category = String(transaction.reporting_category);
    const orderId = typeof transaction.order_id === 'string' ? transaction.order_id : null;
    const order = orderId ? orders.get(orderId) : undefined;

    if (order && chargeCategories.has(category)) {
      add(entry(
        `stripe:sale:${order.id}`, transaction.stripe_created_at,
        'Stripe決済売上', order.customerName ?? '',
        [line('1130', order.totalAmount, 0), line('4010', 0, order.totalAmount)],
      ));
    }

    if ((chargeCategories.has(category) || refundCategories.has(category)) && Number(transaction.fee) !== 0) {
      const fee = Number(transaction.fee);
      add(entry(
        `stripe:fee:${transaction.id}`, transaction.stripe_created_at,
        fee > 0 ? 'Stripe決済手数料' : 'Stripe決済手数料戻入', '',
        fee > 0
          ? [line('6280', fee, 0), line('1130', 0, fee)]
          : [line('1130', -fee, 0), line('6280', 0, -fee)],
      ));
    } else if (standaloneFeeCategories.has(category) && Number(transaction.net) !== 0) {
      const fee = -Number(transaction.net);
      add(entry(
        `stripe:fee:${transaction.id}`, transaction.stripe_created_at,
        fee > 0 ? 'Stripe手数料調整' : 'Stripe手数料戻入', '',
        fee > 0
          ? [line('6280', fee, 0), line('1130', 0, fee)]
          : [line('1130', -fee, 0), line('6280', 0, -fee)],
      ));
    }

    if (category === 'payout_failure' || category === 'payout_cancel') {
      const amount = Math.abs(Number(transaction.net));
      if (amount > 0) add(entry(
        `stripe:payout-failure:${transaction.id}`, transaction.stripe_created_at,
        'Stripe入金失敗戻入', '',
        [line('1130', amount, 0), line('1150', 0, amount)],
      ));
    }
  }

  for (const refund of input.refunds) {
    if (refund.status !== 'succeeded' || !refund.succeeded_at) continue;
    const amount = Number(refund.amount);
    add(entry(
      `stripe:refund:${refund.id}`, refund.succeeded_at,
      'Stripe売上返金', orders.get(refund.order_id)?.customerName ?? '',
      [line('4020', amount, 0), line('1130', 0, amount)],
    ));
  }

  for (const payout of input.payouts) {
    if (payout.reconciliation_status !== 'matched' || !payout.paid_at) continue;
    const amount = Number(payout.amount);
    add(entry(
      `stripe:payout:${payout.id}`, payout.paid_at,
      'Stripe入金振替', 'Stripe',
      [line('1150', amount, 0), line('1130', 0, amount)],
    ));
    if (payout.bank_arrival_date && payout.bank_confirmed_at) add(entry(
      `stripe:bank:${payout.id}`, payout.bank_arrival_date,
      'Stripe銀行着金', 'Stripe',
      [line('1040', amount, 0), line('1150', 0, amount)],
    ));
  }

  return output.sort((left, right) => left.date.localeCompare(right.date) || left.number.localeCompare(right.number));
}

export function mergeJournalEntries(
  base: readonly JournalEntry[],
  generated: readonly JournalEntry[],
): JournalEntry[] {
  const merged = new Map<string, JournalEntry>();
  for (const value of [...base, ...generated]) merged.set(value.sourceKey ?? value.number, value);
  return [...merged.values()].sort(
    (left, right) => left.date.localeCompare(right.date) || left.number.localeCompare(right.number),
  );
}
