import type { OrderStatus, PaidEmailVariant, PaymentExceptionReason } from '@/lib/orders/order-payment-types';

/**
 * Stripe の現在値を判定に使う形に分けたもの（設計書 3-1）。
 * イベントの種類と届いた順番は使わない。同じ現在値からは常に同じ行動になる（R-01・R-02）。
 */
export type StripePaymentState =
  | { kind: 'paid'; amountReceived: number; amountRefunded: number; currency: string }
  | { kind: 'awaiting_payment' }
  | { kind: 'voucher_expired' }
  | { kind: 'checkout_abandoned' }
  | { kind: 'in_progress' }
  | { kind: 'zero_amount_complete' }
  | { kind: 'missing' }
  | { kind: 'not_applicable'; reason: 'no_draft' | 'unexpected' };

export type OrderAction =
  | { type: 'none' }
  | { type: 'record_only'; note: 'zero_amount' | 'stripe_object_missing' | 'not_applicable' }
  | { type: 'place_and_mark_paid' }
  | { type: 'place_and_mark_awaiting' }
  | {
      type: 'mark_paid';
      expectedStatus: 'payment_in_progress' | 'pending' | 'failed';
      emailVariant: PaidEmailVariant;
    }
  | { type: 'mark_awaiting' }
  | {
      type: 'release';
      expectedStatus: 'payment_in_progress' | 'pending';
      nextStatus: 'failed' | 'abandoned' | 'cancelled';
    }
  | { type: 'exception'; reason: PaymentExceptionReason; detail?: string };

export type DecisionInput = {
  stripe: StripePaymentState;
  /** 注文が無ければ null */
  orderStatus: OrderStatus | null;
  /** 管理画面の取消として呼ばれた。在庫を戻す行き先を「取消」にする */
  adminCancel: boolean;
};

const NONE: OrderAction = { type: 'none' };

/** 判定表の「起きない」マス。仕組みで起きないので、起きたら要対応として警報を出す */
const STATE_CONFLICT: OrderAction = { type: 'exception', reason: 'state_conflict' };

/**
 * Stripe の状態と注文の状態から、行動を1つ返す（設計書 3-2 の判定表）。外部に依存しない。
 */
export function decideOrderAction({ stripe, orderStatus, adminCancel }: DecisionInput): OrderAction {
  switch (stripe.kind) {
    case 'paid':
      return decidePaid(stripe, orderStatus);

    case 'awaiting_payment':
      if (orderStatus === null) return { type: 'place_and_mark_awaiting' };
      if (orderStatus === 'payment_in_progress') return { type: 'mark_awaiting' };
      if (orderStatus === 'pending') return NONE;
      return STATE_CONFLICT;

    case 'voucher_expired':
      if (orderStatus === 'payment_in_progress' || orderStatus === 'pending') {
        return { type: 'release', expectedStatus: orderStatus, nextStatus: adminCancel ? 'cancelled' : 'failed' };
      }
      if (orderStatus === 'paid' || orderStatus === 'shipped') return STATE_CONFLICT;
      return NONE;

    case 'checkout_abandoned':
      if (orderStatus === 'payment_in_progress') {
        return {
          type: 'release',
          expectedStatus: 'payment_in_progress',
          nextStatus: adminCancel ? 'cancelled' : 'abandoned',
        };
      }
      if (orderStatus === 'pending' || orderStatus === 'paid' || orderStatus === 'shipped') return STATE_CONFLICT;
      return NONE;

    case 'in_progress':
      if (orderStatus === 'pending' || orderStatus === 'paid' || orderStatus === 'shipped') return STATE_CONFLICT;
      return NONE;

    case 'zero_amount_complete':
      return orderStatus === null
        ? { type: 'record_only', note: 'zero_amount' }
        : { type: 'exception', reason: 'paid_amount_mismatch', detail: 'zero_amount' };

    case 'missing':
      return orderStatus === null
        ? { type: 'record_only', note: 'stripe_object_missing' }
        : { type: 'exception', reason: 'stripe_object_missing' };

    case 'not_applicable':
      return orderStatus === null
        ? { type: 'record_only', note: 'not_applicable' }
        : { type: 'exception', reason: 'unexpected_state', detail: stripe.reason };
  }
}

function decidePaid(
  stripe: Extract<StripePaymentState, { kind: 'paid' }>,
  orderStatus: OrderStatus | null,
): OrderAction {
  switch (orderStatus) {
    case null:
      return { type: 'place_and_mark_paid' };
    case 'payment_in_progress':
      return { type: 'mark_paid', expectedStatus: 'payment_in_progress', emailVariant: 'order_confirmed' };
    case 'pending':
      return { type: 'mark_paid', expectedStatus: 'pending', emailVariant: 'payment_received' };
    case 'failed':
      // ⑤ 失敗の後の入金。自動で入金済みにし、在庫を確保し直す
      return { type: 'mark_paid', expectedStatus: 'failed', emailVariant: 'payment_received_after_expiry' };
    case 'paid':
    case 'shipped':
      return NONE;
    case 'abandoned':
      return STATE_CONFLICT;
    case 'cancelled':
      // 全額返金済みかは DB の記録ではなく Stripe の返金額で判断する（返金の反映の遅れで誤って要対応にしない）
      return stripe.amountRefunded >= stripe.amountReceived
        ? NONE
        : { type: 'exception', reason: 'cancelled_order_paid' };
  }
}
