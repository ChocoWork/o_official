import Stripe from 'stripe';

export type CheckoutSessionErrorClassification = {
  status: number;
  message: string;
  retryable: boolean;
  auditAction: string;
  stripe: {
    type?: string;
    code?: string;
    statusCode?: number;
    requestId?: string;
  };
};

const DEFAULT_AUDIT_ACTION = 'checkout.session.create';

/**
 * StripeInvalidRequestError のうち、顧客がカート内容を直せば解消しうる code。
 * ここに載っていない code（未指定含む）は当方のパラメータ不備とみなす。
 */
const CUSTOMER_FIXABLE_INVALID_REQUEST_CODES = new Set(['amount_too_small', 'amount_too_large']);

/**
 * Stripe の例外を、クライアントへ返してよい形に分類する。
 *
 * - 生のメッセージは返さない（内部情報の露出を避ける）。日本語の定型文に写す
 * - 永続的な失敗（金額下限など）は 422 とし、画面の「確認へ進む」を押せなくする
 * - 一時的な失敗（レート制限・接続）は 429 / 503 とし、再試行させる
 */
export function classifyCheckoutSessionError(error: unknown): CheckoutSessionErrorClassification {
  if (error instanceof Stripe.errors.StripeError) {
    const stripe = {
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
      requestId: error.requestId,
    };

    switch (error.type) {
      case 'StripeInvalidRequestError':
        if (error.code && CUSTOMER_FIXABLE_INVALID_REQUEST_CODES.has(error.code)) {
          return {
            status: 422,
            message: 'ご注文内容では決済を開始できません。カートの内容をご確認ください。',
            retryable: false,
            auditAction: DEFAULT_AUDIT_ACTION,
            stripe,
          };
        }
        return {
          status: 500,
          message: '決済を開始できませんでした。しばらくしてからお試しください。',
          retryable: false,
          auditAction: 'checkout.session.create.invalid_request',
          stripe,
        };
      case 'StripeRateLimitError':
        return {
          status: 429,
          message: '混み合っています。しばらく待ってから再度お試しください。',
          retryable: true,
          auditAction: DEFAULT_AUDIT_ACTION,
          stripe,
        };
      case 'StripeConnectionError':
      case 'StripeAPIError':
        return {
          status: 503,
          message: '決済サービスに接続できませんでした。時間をおいて再度お試しください。',
          retryable: true,
          auditAction: DEFAULT_AUDIT_ACTION,
          stripe,
        };
      case 'StripeAuthenticationError':
      case 'StripePermissionError':
        return {
          status: 500,
          message: '決済を開始できませんでした。しばらくしてからお試しください。',
          retryable: false,
          auditAction: 'checkout.session.create.misconfigured',
          stripe,
        };
      default:
        return {
          status: 500,
          message: '決済を開始できませんでした。時間をおいて再度お試しください。',
          retryable: true,
          auditAction: DEFAULT_AUDIT_ACTION,
          stripe,
        };
    }
  }

  return {
    status: 500,
    message: '決済を開始できませんでした。時間をおいて再度お試しください。',
    retryable: true,
    auditAction: DEFAULT_AUDIT_ACTION,
    stripe: {},
  };
}
