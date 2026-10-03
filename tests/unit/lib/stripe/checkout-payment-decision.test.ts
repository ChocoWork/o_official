import { ORDER_STATUSES, type OrderStatus } from '@/lib/orders/order-payment-types';
import {
  decideOrderAction,
  type OrderAction,
  type StripePaymentState,
} from '@/lib/stripe/checkout-payment-decision';

/**
 * 判定表（設計書 3-2）の全マス。行が Stripe の状態、列が注文の状態（注文なし + 7状態）。
 * 表をそのままテストの入力にする。イベントの種類と届いた順番は入力に無い（R-01・R-02）。
 */
type Column = 'none' | OrderStatus;

const STATES = {
  入金済み: { kind: 'paid', amountReceived: 5000, amountRefunded: 0, currency: 'jpy' },
  入金待ち: { kind: 'awaiting_payment' },
  払込票の期限切れ: { kind: 'voucher_expired' },
  決済画面の放棄: { kind: 'checkout_abandoned' },
  手続き中: { kind: 'in_progress' },
  '0円で完了': { kind: 'zero_amount_complete' },
  Stripeに無い: { kind: 'missing' },
  '対象外・想定外': { kind: 'not_applicable', reason: 'unexpected' },
} satisfies Record<string, StripePaymentState>;

const none: OrderAction = { type: 'none' };
const conflict: OrderAction = { type: 'exception', reason: 'state_conflict' };

function everyOrder(action: OrderAction): Record<OrderStatus, OrderAction> {
  return Object.fromEntries(ORDER_STATUSES.map((status) => [status, action])) as Record<OrderStatus, OrderAction>;
}

const TABLE: Record<keyof typeof STATES, Record<Column, OrderAction>> = {
  入金済み: {
    none: { type: 'place_and_mark_paid' },
    payment_in_progress: { type: 'mark_paid', expectedStatus: 'payment_in_progress', emailVariant: 'order_confirmed' },
    pending: { type: 'mark_paid', expectedStatus: 'pending', emailVariant: 'payment_received' },
    paid: none,
    shipped: none,
    failed: { type: 'mark_paid', expectedStatus: 'failed', emailVariant: 'payment_received_after_expiry' },
    abandoned: conflict,
    cancelled: { type: 'exception', reason: 'cancelled_order_paid' },
  },
  入金待ち: {
    none: { type: 'place_and_mark_awaiting' },
    payment_in_progress: { type: 'mark_awaiting' },
    pending: none,
    paid: conflict,
    shipped: conflict,
    failed: conflict,
    abandoned: conflict,
    cancelled: conflict,
  },
  払込票の期限切れ: {
    none,
    payment_in_progress: { type: 'release', expectedStatus: 'payment_in_progress', nextStatus: 'failed' },
    pending: { type: 'release', expectedStatus: 'pending', nextStatus: 'failed' },
    paid: conflict,
    shipped: conflict,
    failed: none,
    abandoned: none,
    cancelled: none,
  },
  決済画面の放棄: {
    none,
    payment_in_progress: { type: 'release', expectedStatus: 'payment_in_progress', nextStatus: 'abandoned' },
    pending: conflict,
    paid: conflict,
    shipped: conflict,
    failed: none,
    abandoned: none,
    cancelled: none,
  },
  手続き中: {
    none,
    payment_in_progress: none,
    pending: conflict,
    paid: conflict,
    shipped: conflict,
    failed: none,
    abandoned: none,
    cancelled: none,
  },
  '0円で完了': {
    none: { type: 'record_only', note: 'zero_amount' },
    ...everyOrder({ type: 'exception', reason: 'paid_amount_mismatch', detail: 'zero_amount' }),
  },
  Stripeに無い: {
    none: { type: 'record_only', note: 'stripe_object_missing' },
    ...everyOrder({ type: 'exception', reason: 'stripe_object_missing' }),
  },
  '対象外・想定外': {
    none: { type: 'record_only', note: 'not_applicable' },
    ...everyOrder({ type: 'exception', reason: 'unexpected_state', detail: 'unexpected' }),
  },
};

const CASES = (Object.keys(TABLE) as Array<keyof typeof STATES>).flatMap((state) =>
  (Object.keys(TABLE[state]) as Column[]).map((column) => [state, column, TABLE[state][column]] as const),
);

describe('decideOrderAction（判定表）', () => {
  it('Stripe の状態8行 × 注文なしと7状態のすべてのマスを持つ', () => {
    expect(CASES).toHaveLength(8 * 8);
  });

  it.each(CASES)('%s × %s', (state, column, expected) => {
    expect(
      decideOrderAction({
        stripe: STATES[state],
        orderStatus: column === 'none' ? null : column,
        adminCancel: false,
      }),
    ).toEqual(expected);
  });

  it('管理画面の取消では、在庫を戻す行き先を「取消」にする', () => {
    expect(decideOrderAction({ stripe: STATES['払込票の期限切れ'], orderStatus: 'pending', adminCancel: true }))
      .toEqual({ type: 'release', expectedStatus: 'pending', nextStatus: 'cancelled' });
    expect(decideOrderAction({ stripe: STATES['決済画面の放棄'], orderStatus: 'payment_in_progress', adminCancel: true }))
      .toEqual({ type: 'release', expectedStatus: 'payment_in_progress', nextStatus: 'cancelled' });
  });

  it('管理画面の取消でも、入金済みなら取り消さず入金済みにする', () => {
    expect(decideOrderAction({ stripe: STATES['入金済み'], orderStatus: 'payment_in_progress', adminCancel: true }))
      .toEqual(TABLE['入金済み'].payment_in_progress);
  });

  it('取消の注文への入金は、Stripe の返金額で全額返金済みなら何もしない', () => {
    const refunded: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded: 5000, currency: 'jpy' };
    const partly: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded: 4999, currency: 'jpy' };

    expect(decideOrderAction({ stripe: refunded, orderStatus: 'cancelled', adminCancel: false })).toEqual(none);
    expect(decideOrderAction({ stripe: partly, orderStatus: 'cancelled', adminCancel: false }))
      .toEqual({ type: 'exception', reason: 'cancelled_order_paid' });
  });

  it.each([
    ['一部だけ返金済み', 1],
    ['全額返金済み', 5000],
  ])('注文が無く、入金済みで返金済みの分もある支払い（%s）は、注文を作らず記録のみにする', (_name, amountRefunded) => {
    // 注文より先に店が Stripe で返金した支払い。あとから注文にすると、返金が反映されない入金済みの注文が残る
    const refundedFirst: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded, currency: 'jpy' };

    expect(decideOrderAction({ stripe: refundedFirst, orderStatus: null, adminCancel: false }))
      .toEqual({ type: 'record_only', note: 'refunded_before_order' });
  });

  it('返金済みの分があっても、注文がある入金済みの行は変えない（返金の反映は照合関数が続ける）', () => {
    const refunded: StripePaymentState = { kind: 'paid', amountReceived: 5000, amountRefunded: 2000, currency: 'jpy' };

    for (const status of ORDER_STATUSES) {
      expect(decideOrderAction({ stripe: refunded, orderStatus: status, adminCancel: false }))
        .toEqual(TABLE['入金済み'][status]);
    }
  });

  it('下書きの無い支払いは detail に no_draft を入れる', () => {
    expect(decideOrderAction({
      stripe: { kind: 'not_applicable', reason: 'no_draft' },
      orderStatus: 'paid',
      adminCancel: false,
    })).toEqual({ type: 'exception', reason: 'unexpected_state', detail: 'no_draft' });
  });
});
