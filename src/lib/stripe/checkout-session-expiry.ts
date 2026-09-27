import type Stripe from 'stripe';

const PENDING_CHECKOUT_PAYMENT_INTENT_STATUSES = new Set<string>([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
]);

export type CheckoutSessionExpiryResult =
  | {
      outcome: 'expired';
      sessionId: string;
      expiredNow: boolean;
    }
  | {
      outcome: 'blocked';
      sessionId: string;
      sessionStatus: Stripe.Checkout.Session.Status | null;
      paymentStatus: Stripe.Checkout.Session.PaymentStatus;
    }
  | {
      outcome: 'unavailable';
      reason: 'session_not_found' | 'payment_intent_mismatch' | 'unexpected_expire_result';
      sessionId: string | null;
    };

export function isPendingCheckoutPaymentIntentStatus(status: string): boolean {
  return PENDING_CHECKOUT_PAYMENT_INTENT_STATUSES.has(status);
}

function paymentIntentIdOf(session: Stripe.Checkout.Session): string | null {
  if (typeof session.payment_intent === 'string') {
    return session.payment_intent;
  }

  return session.payment_intent?.id ?? null;
}

function belongsToPaymentIntent(
  session: Stripe.Checkout.Session,
  paymentIntentId: string,
): boolean {
  return paymentIntentIdOf(session) === paymentIntentId;
}

function isResourceMissingError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'resource_missing',
  );
}

async function findCheckoutSession(
  stripe: Stripe,
  paymentIntentId: string,
  checkoutSessionId: string | null,
): Promise<Stripe.Checkout.Session | null> {
  if (checkoutSessionId) {
    try {
      const storedSession = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      if (belongsToPaymentIntent(storedSession, paymentIntentId)) {
        return storedSession;
      }
    } catch (error) {
      if (!isResourceMissingError(error)) {
        throw error;
      }
    }
  }

  const sessions = await stripe.checkout.sessions.list({
    payment_intent: paymentIntentId,
    limit: 1,
  });
  return sessions.data[0] ?? null;
}

function classifyResolvedSession(
  session: Stripe.Checkout.Session,
  paymentIntentId: string,
  expiredNow: boolean,
): CheckoutSessionExpiryResult {
  if (!belongsToPaymentIntent(session, paymentIntentId)) {
    return {
      outcome: 'unavailable',
      reason: 'payment_intent_mismatch',
      sessionId: session.id,
    };
  }

  if (session.status === 'expired' && session.payment_status === 'unpaid') {
    return {
      outcome: 'expired',
      sessionId: session.id,
      expiredNow,
    };
  }

  return {
    outcome: 'blocked',
    sessionId: session.id,
    sessionStatus: session.status,
    paymentStatus: session.payment_status,
  };
}

/**
 * Checkout が所有する PaymentIntent は直接 cancel できないため、関連する
 * Checkout Session を失効させる。支払完了との競合時は再取得した Stripe 状態を優先し、
 * expired/unpaid を確認できた場合だけ呼び出し側が注文・在庫を変更できるようにする。
 */
export async function expireCheckoutSessionForPaymentIntent(params: {
  stripe: Stripe;
  paymentIntentId: string;
  checkoutSessionId: string | null;
}): Promise<CheckoutSessionExpiryResult> {
  const { stripe, paymentIntentId, checkoutSessionId } = params;
  const session = await findCheckoutSession(stripe, paymentIntentId, checkoutSessionId);

  if (!session) {
    return {
      outcome: 'unavailable',
      reason: 'session_not_found',
      sessionId: checkoutSessionId,
    };
  }

  const initial = classifyResolvedSession(session, paymentIntentId, false);
  if (initial.outcome !== 'blocked') {
    return initial;
  }

  if (session.status !== 'open' || session.payment_status !== 'unpaid') {
    return initial;
  }

  try {
    const expiredSession = await stripe.checkout.sessions.expire(
      session.id,
      {},
      { idempotencyKey: `expire-checkout-session:${session.id}` },
    );
    const result = classifyResolvedSession(expiredSession, paymentIntentId, true);
    if (result.outcome === 'expired') {
      return result;
    }

    return {
      outcome: 'unavailable',
      reason: 'unexpected_expire_result',
      sessionId: session.id,
    };
  } catch (expireError) {
    // open の確認後に支払いが完了する TOCTOU を解消する。失効済みなら成功として
    // 冪等に扱い、complete/paid へ進んでいれば注文と在庫には触れない。
    let refreshedSession: Stripe.Checkout.Session;
    try {
      refreshedSession = await stripe.checkout.sessions.retrieve(session.id);
    } catch {
      throw expireError;
    }

    const refreshed = classifyResolvedSession(refreshedSession, paymentIntentId, false);
    if (refreshed.outcome === 'expired' || refreshed.outcome === 'blocked') {
      return refreshed;
    }

    throw expireError;
  }
}
