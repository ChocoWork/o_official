import Stripe from 'stripe';
import { classifyCheckoutSessionError } from '@/features/checkout/services/checkout-error.service';

function stripeError(type: string, extra: Record<string, unknown> = {}): unknown {
  const error = new Error('raw stripe message') as Error & Record<string, unknown>;
  error.type = type;
  Object.assign(error, extra);
  Object.setPrototypeOf(error, Stripe.errors.StripeError.prototype);
  return error;
}

describe('classifyCheckoutSessionError', () => {
  it('invalid_request（顧客修正可能な code）は 422 で再試行させない', () => {
    const result = classifyCheckoutSessionError(
      stripeError('StripeInvalidRequestError', { code: 'amount_too_small', statusCode: 400, requestId: 'req_1' }),
    );

    expect(result.status).toBe(422);
    expect(result.retryable).toBe(false);
    expect(result.auditAction).toBe('checkout.session.create');
    expect(result.stripe.code).toBe('amount_too_small');
    expect(result.stripe.requestId).toBe('req_1');
  });

  it('invalid_request（amount_too_large）も 422 で再試行させない', () => {
    const result = classifyCheckoutSessionError(
      stripeError('StripeInvalidRequestError', { code: 'amount_too_large' }),
    );

    expect(result.status).toBe(422);
    expect(result.retryable).toBe(false);
    expect(result.auditAction).toBe('checkout.session.create');
  });

  it('invalid_request（code なし）はこちらのパラメータ不備として 500・再試行不可、専用の audit action を返す', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeInvalidRequestError'));

    expect(result.status).toBe(500);
    expect(result.retryable).toBe(false);
    expect(result.auditAction).toBe('checkout.session.create.invalid_request');
  });

  it('invalid_request（未知の code）もこちらのパラメータ不備として 500・再試行不可を返す', () => {
    const result = classifyCheckoutSessionError(
      stripeError('StripeInvalidRequestError', { code: 'parameter_missing' }),
    );

    expect(result.status).toBe(500);
    expect(result.retryable).toBe(false);
    expect(result.auditAction).toBe('checkout.session.create.invalid_request');
  });

  it('invalid_request の顧客起因メッセージと当方起因メッセージは異なる', () => {
    const customerFixable = classifyCheckoutSessionError(
      stripeError('StripeInvalidRequestError', { code: 'amount_too_small' }),
    );
    const ourBug = classifyCheckoutSessionError(stripeError('StripeInvalidRequestError'));

    expect(customerFixable.message).not.toBe(ourBug.message);
  });

  it('rate_limit は 429 で再試行させる', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeRateLimitError'));
    expect(result.status).toBe(429);
    expect(result.retryable).toBe(true);
  });

  it('接続エラー（StripeConnectionError）は 503 で再試行させる', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeConnectionError'));
    expect(result.status).toBe(503);
    expect(result.retryable).toBe(true);
  });

  it('APIエラー（StripeAPIError）も 503 で再試行させる', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeAPIError'));
    expect(result.status).toBe(503);
    expect(result.retryable).toBe(true);
  });

  it('認証エラーは 500・再試行不可で、専用の audit action を返す', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeAuthenticationError'));
    expect(result.status).toBe(500);
    expect(result.retryable).toBe(false);
    expect(result.auditAction).toBe('checkout.session.create.misconfigured');
  });

  it('未分類の Stripe エラー型（例: StripeIdempotencyError）は default で 500・再試行可', () => {
    const result = classifyCheckoutSessionError(stripeError('StripeIdempotencyError'));
    expect(result.status).toBe(500);
    expect(result.retryable).toBe(true);
    expect(result.auditAction).toBe('checkout.session.create');
  });

  it('Stripe 以外の例外は 500・再試行可', () => {
    const result = classifyCheckoutSessionError(new Error('boom'));
    expect(result.status).toBe(500);
    expect(result.retryable).toBe(true);
  });

  it('Stripe の生メッセージを message に出さない', () => {
    const result = classifyCheckoutSessionError(
      stripeError('StripeInvalidRequestError', { code: 'amount_too_small' }),
    );
    expect(result.message).not.toContain('raw stripe message');
    expect(result.message.length).toBeGreaterThan(0);
  });
});
