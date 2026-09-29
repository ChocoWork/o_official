import type Stripe from 'stripe';
import { getDraftIdFromStripeMetadata } from '@/features/checkout/services/checkout-draft.service';
import { resolvePaymentMethodFromSession } from '@/features/checkout/services/payment-method.service';
import type { StripePaymentState } from '@/lib/stripe/checkout-payment-decision';

export type ReconcileTransientCode = 'stripe_unavailable' | 'db_unavailable' | 'not_converged';

/**
 * 照合の一時的な失敗（設計書 5-1）。呼び出し元はイベントを失敗にし、キューが間隔を空けて再試行する。
 */
export class ReconcileTransientError extends Error {
  readonly code: ReconcileTransientCode;

  constructor(code: ReconcileTransientCode, options?: { cause?: unknown }) {
    super(`Checkout payment reconciliation failed temporarily: ${code}`, options);
    this.name = 'ReconcileTransientError';
    this.code = code;
  }
}

/** 照合が使う Stripe の API だけを表す狭い型（order-refund-sync.ts と同じ考え方） */
export type CheckoutPaymentStripeClient = {
  checkout: {
    sessions: {
      retrieve(id: string, params?: { expand?: string[] }): Promise<Stripe.Checkout.Session>;
      list(params: { payment_intent: string; limit: number; expand?: string[] }): Promise<{
        data: Stripe.Checkout.Session[];
      }>;
    };
  };
  paymentIntents: {
    retrieve(id: string): Promise<Stripe.PaymentIntent>;
  };
};

export type CheckoutPaymentSnapshot = {
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  draftId: string | null;
  /** 下書きを作ったお客様のセッション（Session の metadata.session_id） */
  cartSessionId: string | null;
  sessionCreatedAt: Date | null;
  amountTotal: number | null;
  amountDiscount: number;
  currency: string | null;
  /** 実際に使われた支払方法。PaymentIntent が無ければ null */
  paymentMethod: string | null;
  /** コンビニの払込期限。払込票が無ければ null */
  voucherExpiresAt: Date | null;
  state: StripePaymentState;
};

const SESSION_EXPAND = ['payment_intent', 'payment_intent.payment_method', 'payment_intent.latest_charge'];

const UNEXPECTED: StripePaymentState = { kind: 'not_applicable', reason: 'unexpected' };

function isResourceMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'resource_missing');
}

const TRANSIENT_STRIPE_ERROR_TYPES = new Set(['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError']);

/**
 * 一時的な失敗（設計書 5-1）は Stripe の通信・5xx・回数制限だけ。認証・権限・入力不備
 * （resource_missing 以外）やコード側のバグ（snapshotFromSession/classifyStripePaymentState 由来）は
 * ここに含めない。再試行しても直らない失敗を「一時的」として無限に再試行させないため。
 */
export function isTransientStripeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { type, statusCode } = error as { type?: unknown; statusCode?: unknown };
  if (typeof type === 'string' && TRANSIENT_STRIPE_ERROR_TYPES.has(type)) return true;
  return typeof statusCode === 'number' && (statusCode >= 500 || statusCode === 429);
}

function emptySnapshot(ref: {
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  state: StripePaymentState;
}): CheckoutPaymentSnapshot {
  return {
    checkoutSessionId: ref.checkoutSessionId,
    paymentIntentId: ref.paymentIntentId,
    draftId: null,
    cartSessionId: null,
    sessionCreatedAt: null,
    amountTotal: null,
    amountDiscount: 0,
    currency: null,
    paymentMethod: null,
    voucherExpiresAt: null,
    state: ref.state,
  };
}

function amountRefundedOf(charge: string | Stripe.Charge | null): number {
  return charge && typeof charge === 'object' ? charge.amount_refunded : 0;
}

/**
 * Session と PaymentIntent の現在値を、判定表の行に分ける（設計書 3-1）。
 * 下書き ID は見ない。下書き ID の無い支払い（当店の Checkout 以外）を対象外にするかは、照合関数が注文の有無と
 * 合わせて決める（注文が無いときだけ対象外。移行前の注文は Session に下書き ID が無くても状態に従う。設計書 7-1）。
 */
export function classifyStripePaymentState(
  session: Pick<Stripe.Checkout.Session, 'status' | 'payment_status'>,
  paymentIntent: Pick<Stripe.PaymentIntent, 'status' | 'amount_received' | 'currency' | 'latest_charge'> | null,
): StripePaymentState {
  if (session.status === 'open') return { kind: 'in_progress' };
  // expired は一度も完了していない Session だけがなる（complete は終状態）
  if (session.status === 'expired') return { kind: 'checkout_abandoned' };
  if (session.status !== 'complete') return UNEXPECTED;

  if (session.payment_status === 'no_payment_required') return { kind: 'zero_amount_complete' };
  if (!paymentIntent) return UNEXPECTED;

  // Session の payment_status は非同期決済の入金を少し遅れて反映することがある。PaymentIntent を優先する
  if (session.payment_status === 'paid' || paymentIntent.status === 'succeeded') {
    return {
      kind: 'paid',
      amountReceived: paymentIntent.amount_received,
      amountRefunded: amountRefundedOf(paymentIntent.latest_charge),
      currency: paymentIntent.currency,
    };
  }

  if (session.payment_status === 'unpaid') {
    if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'processing') {
      return { kind: 'awaiting_payment' };
    }
    if (paymentIntent.status === 'requires_payment_method' || paymentIntent.status === 'canceled') {
      return { kind: 'voucher_expired' };
    }
  }

  return UNEXPECTED;
}

function snapshotFromSession(session: Stripe.Checkout.Session): CheckoutPaymentSnapshot {
  const paymentIntent =
    session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : paymentIntent?.id ?? null;
  const voucherExpiresAt = paymentIntent?.next_action?.konbini_display_details?.expires_at ?? null;

  return {
    checkoutSessionId: session.id,
    paymentIntentId,
    // metadata に下書き ID が無ければ null のまま渡す（移行前の注文の Session など）
    draftId: getDraftIdFromStripeMetadata(session.metadata),
    cartSessionId: session.metadata?.session_id ?? null,
    sessionCreatedAt: new Date(session.created * 1000),
    amountTotal: session.amount_total ?? null,
    amountDiscount: session.total_details?.amount_discount ?? 0,
    currency: session.currency ?? null,
    paymentMethod: paymentIntent ? resolvePaymentMethodFromSession(session) : null,
    voucherExpiresAt: voucherExpiresAt ? new Date(voucherExpiresAt * 1000) : null,
    state: classifyStripePaymentState(session, paymentIntent),
  };
}

/**
 * Stripe の現在値を読む。Session ID があれば Session から、無ければ PaymentIntent から Session を引く
 * （Session ID を持たない古い注文と payment_intent 系のイベント。checkout-session-expiry.ts と同じ方法）。
 * Stripe へは書かない。通信・5xx・回数制限は ReconcileTransientError('stripe_unavailable') にする。
 */
export async function readCheckoutPayment(
  stripe: CheckoutPaymentStripeClient,
  ref: { checkoutSessionId?: string | null; paymentIntentId?: string | null },
): Promise<CheckoutPaymentSnapshot> {
  const checkoutSessionId = ref.checkoutSessionId ?? null;
  const paymentIntentId = ref.paymentIntentId ?? null;
  if (!checkoutSessionId && !paymentIntentId) {
    throw new Error('checkoutSessionId or paymentIntentId is required');
  }

  try {
    if (checkoutSessionId) {
      try {
        return snapshotFromSession(await stripe.checkout.sessions.retrieve(checkoutSessionId, { expand: SESSION_EXPAND }));
      } catch (error) {
        if (isResourceMissing(error)) {
          return emptySnapshot({ checkoutSessionId, paymentIntentId, state: { kind: 'missing' } });
        }
        throw error;
      }
    }

    const intentId = paymentIntentId as string;
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: intentId,
      limit: 1,
      expand: SESSION_EXPAND.map((field) => `data.${field}`),
    });
    const found = sessions.data[0];
    if (found) {
      return snapshotFromSession(found);
    }

    try {
      await stripe.paymentIntents.retrieve(intentId);
    } catch (error) {
      if (isResourceMissing(error)) {
        return emptySnapshot({ checkoutSessionId: null, paymentIntentId: intentId, state: { kind: 'missing' } });
      }
      throw error;
    }

    // Checkout を通らない支払いは注文にしない（2026-08-09 の設計。会計の照合が不一致として検出する）
    return emptySnapshot({
      checkoutSessionId: null,
      paymentIntentId: intentId,
      state: { kind: 'not_applicable', reason: 'no_draft' },
    });
  } catch (error) {
    if (isTransientStripeError(error)) {
      throw new ReconcileTransientError('stripe_unavailable', { cause: error });
    }
    throw error;
  }
}
