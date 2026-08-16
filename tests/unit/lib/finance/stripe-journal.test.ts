import { buildStripeJournal, mergeJournalEntries } from '@/lib/finance/stripe-journal';
import { accountByCode } from '@/lib/finance/accounts';

const order = {
  id: 'order-1', paymentIntentId: 'pi_1', totalAmount: 10_000,
  currency: 'jpy', customerName: '顧客',
};
const charge = {
  id: 'txn-charge-1', source_id: 'ch_1', payment_intent_id: 'pi_1',
  order_id: 'order-1', payout_id: 'po_1', type: 'charge',
  reporting_category: 'charge', amount: 10_000, fee: 360, net: 9_640,
  currency: 'jpy', status: 'available', stripe_created_at: '2026-08-15T00:00:00.000Z',
};
const refund = {
  id: 're_1', order_id: 'order-1', payment_intent_id: 'pi_1',
  amount: 10_000, currency: 'jpy', status: 'succeeded',
  succeeded_at: '2026-08-16T01:00:00.000Z', balance_transaction_id: 'txn-refund-1',
};
const payout = {
  id: 'po_1', amount: 9_640, currency: 'jpy', automatic: true, status: 'paid',
  paid_at: '2026-08-17T01:00:00.000Z', reconciliation_status: 'matched',
  bank_arrival_date: '2026-08-18', bank_confirmed_at: '2026-08-18T03:00:00.000Z',
};

function lines(journal: ReturnType<typeof buildStripeJournal>, key: string) {
  return journal.find((entry) => entry.sourceKey === key)?.lines.map((line) => ({
    code: line.account.code, debit: line.debit, credit: line.credit,
  }));
}

describe('Stripe accounting journal projection', () => {
  it('recognizes gross revenue and the actual Stripe fee at payment success', () => {
    const journal = buildStripeJournal({
      orders: [order], balanceTransactions: [charge], refunds: [], payouts: [],
    });

    expect(lines(journal, 'stripe:sale:order-1')).toEqual([
      { code: '1130', debit: 10_000, credit: 0 },
      { code: '4010', debit: 0, credit: 10_000 },
    ]);
    expect(lines(journal, 'stripe:fee:txn-charge-1')).toEqual([
      { code: '6280', debit: 360, credit: 0 },
      { code: '1130', debit: 0, credit: 360 },
    ]);
  });

  it('adds a reversal on the successful refund date without deleting the sale', () => {
    const journal = buildStripeJournal({
      orders: [order], balanceTransactions: [charge], refunds: [refund], payouts: [],
    });

    expect(lines(journal, 'stripe:sale:order-1')).toBeDefined();
    expect(lines(journal, 'stripe:refund:re_1')).toEqual([
      { code: '4020', debit: 10_000, credit: 0 },
      { code: '1130', debit: 0, credit: 10_000 },
    ]);
    expect(journal.find((entry) => entry.sourceKey === 'stripe:refund:re_1')?.date)
      .toBe('2026-08-16');
  });

  it('moves matched payouts through funds in transit and then to the bank', () => {
    const journal = buildStripeJournal({
      orders: [order], balanceTransactions: [charge], refunds: [], payouts: [payout],
    });

    expect(lines(journal, 'stripe:payout:po_1')).toEqual([
      { code: '1150', debit: 9_640, credit: 0 },
      { code: '1130', debit: 0, credit: 9_640 },
    ]);
    expect(lines(journal, 'stripe:bank:po_1')).toEqual([
      { code: '1040', debit: 9_640, credit: 0 },
      { code: '1150', debit: 0, credit: 9_640 },
    ]);
  });

  it('reverses a previously paid payout after a Stripe payout failure', () => {
    const failure = {
      ...charge, id: 'txn_failure_1', source_id: 'po_1', order_id: null,
      payment_intent_id: null, reporting_category: 'payout_failure',
      type: 'payout_failure', amount: 9_640, fee: 0, net: 9_640,
      stripe_created_at: '2026-08-18T00:00:00.000Z',
    };
    const journal = buildStripeJournal({
      orders: [order], balanceTransactions: [charge, failure], refunds: [],
      payouts: [{ ...payout, status: 'failed', bank_arrival_date: null, bank_confirmed_at: null }],
    });

    expect(lines(journal, 'stripe:payout-failure:txn_failure_1')).toEqual([
      { code: '1130', debit: 9_640, credit: 0 },
      { code: '1150', debit: 0, credit: 9_640 },
    ]);
  });

  it('ignores unknown classifications and deduplicates projection keys', () => {
    const journal = buildStripeJournal({
      orders: [order],
      balanceTransactions: [charge, charge, { ...charge, id: 'txn_dispute', reporting_category: 'dispute' }],
      refunds: [], payouts: [],
    });

    expect(journal.filter((entry) => entry.sourceKey === 'stripe:fee:txn-charge-1')).toHaveLength(1);
    expect(journal.some((entry) => entry.sourceKey?.includes('dispute'))).toBe(false);
  });

  it('adds Stripe funds in transit and merges without duplicate source keys', () => {
    expect(accountByCode('1150')).toMatchObject({
      type: 'asset', normalSide: 'debit', section: 'その他流動資産',
    });
    const generated = buildStripeJournal({
      orders: [order], balanceTransactions: [charge], refunds: [], payouts: [],
    });
    expect(mergeJournalEntries(generated, generated)).toHaveLength(generated.length);
  });
});
