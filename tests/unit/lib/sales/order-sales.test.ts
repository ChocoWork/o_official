import { toOrderSalesTransaction, type OrderSalesRow } from '@/lib/sales/order-sales';

const paidOrder: OrderSalesRow = {
  id: 'order-1',
  payment_intent_id: 'pi_1',
  status: 'paid',
  total_amount: 10_000,
  refunded_amount: 0,
  currency: 'jpy',
  created_at: '2026-08-01T00:00:00.000Z',
};

describe('toOrderSalesTransaction', () => {
  it('maps a paid order to gross and net sales', () => {
    expect(toOrderSalesTransaction(paidOrder)).toEqual({
      source: 'order',
      sourceId: 'order-1',
      paymentIntentId: 'pi_1',
      date: '2026-08-01T00:00:00.000Z',
      grossAmount: 10_000,
      refundedAmount: 0,
      netAmount: 10_000,
      currency: 'jpy',
      readOnly: true,
    });
  });

  it('uses succeeded refund amount to calculate net sales', () => {
    expect(toOrderSalesTransaction({ ...paidOrder, refunded_amount: 2_500 })?.netAmount).toBe(7_500);
  });

  it('retains a fully refunded cancelled order with zero net sales', () => {
    const transaction = toOrderSalesTransaction({
      ...paidOrder,
      status: 'cancelled',
      refunded_amount: 10_000,
    });

    expect(transaction?.netAmount).toBe(0);
    expect(transaction?.refundedAmount).toBe(10_000);
  });

  it('excludes an unpaid order', () => {
    expect(toOrderSalesTransaction({ ...paidOrder, status: 'pending' })).toBeNull();
  });

  it('keeps gross order revenue when Stripe source records exist', () => {
    expect(
      toOrderSalesTransaction({ ...paidOrder, refunded_amount: 3_000 }, { hasStripeAccounting: true }),
    ).toMatchObject({ grossAmount: 10_000, refundedAmount: 0, netAmount: 10_000 });
  });

  it('uses the legacy refunded net only before source records are backfilled', () => {
    expect(
      toOrderSalesTransaction({ ...paidOrder, refunded_amount: 3_000 }, { hasStripeAccounting: false })?.netAmount,
    ).toBe(7_000);
  });

  it('keeps a fully refunded cancelled order visible under the new projection', () => {
    expect(
      toOrderSalesTransaction(
        { ...paidOrder, status: 'cancelled', refunded_amount: 10_000 },
        { hasStripeAccounting: true },
      ),
    ).toMatchObject({ grossAmount: 10_000, netAmount: 10_000 });
  });

  it('clamps malformed refund values to the order total', () => {
    expect(toOrderSalesTransaction({ ...paidOrder, refunded_amount: 12_000 })?.netAmount).toBe(0);
    expect(toOrderSalesTransaction({ ...paidOrder, refunded_amount: -1 })?.refundedAmount).toBe(0);
  });
});
