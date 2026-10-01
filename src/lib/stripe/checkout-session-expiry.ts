import type Stripe from 'stripe';

function isResourceMissingError(error: unknown): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && (error as { code?: unknown }).code === 'resource_missing',
  );
}

export type OpenSessionExpiryResult = 'expired' | 'not_open' | 'missing';

/**
 * 開いている Checkout Session を失効させる（見回り・管理画面の取消・商品の非公開。設計書 2-2・4-6）。
 * 開いていなければ何もしない。支払いの完了と競合したら Stripe の現在値を優先し、失効させない。
 * 注文と在庫は、呼び出し側が照合関数で合わせる。
 */
export async function expireOpenCheckoutSession(
  stripe: Stripe,
  checkoutSessionId: string,
): Promise<OpenSessionExpiryResult> {
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
  } catch (error) {
    if (isResourceMissingError(error)) {
      return 'missing';
    }
    throw error;
  }

  if (session.status !== 'open') {
    return 'not_open';
  }

  try {
    await stripe.checkout.sessions.expire(
      checkoutSessionId,
      {},
      { idempotencyKey: `expire-checkout-session:${checkoutSessionId}` },
    );
    return 'expired';
  } catch (expireError) {
    // open を確かめた後に支払いが完了した（TOCTOU）。完了していれば失効させない
    const refreshed = await stripe.checkout.sessions.retrieve(checkoutSessionId);
    if (refreshed.status === 'expired') {
      return 'expired';
    }
    if (refreshed.status !== 'open') {
      return 'not_open';
    }
    throw expireError;
  }
}
