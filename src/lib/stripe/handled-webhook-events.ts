/**
 * 受け取り口が保存する Stripe の知らせの種類（設計書 2026-10-05 グループ B の 5-1）。
 * Stripe 側の購読も同じ13種にする（手順書）。処理する側（webhook-processor）の分け方と一致させる（テストが確かめる）。
 */
export const HANDLED_STRIPE_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.refunded',
  'payout.paid',
  'payout.failed',
  'payout.reconciliation_completed',
] as const;

const HANDLED: ReadonlySet<string> = new Set(HANDLED_STRIPE_EVENT_TYPES);

export function isHandledStripeEventType(type: string): boolean {
  return HANDLED.has(type);
}

/** 秘密鍵の頭でモードを決める。本番の鍵なら true、テストの鍵なら false、どちらでもなければ null。 */
export function stripeKeyLivemode(secretKey: string | undefined): boolean | null {
  if (!secretKey) return null;
  if (/^(sk|rk)_live_/.test(secretKey)) return true;
  if (/^(sk|rk)_test_/.test(secretKey)) return false;
  return null;
}
