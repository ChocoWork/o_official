import {
  clearPaymentAttempt,
  paymentIncompleteMessage,
  rememberPaymentAttempt,
  takePaymentAttempt,
} from '@/app/checkout/_lib/payment-attempt';

describe('支払いの試みの記録（決め事 D10）', () => {
  beforeEach(() => window.sessionStorage.clear());

  test('同じ決済の画面なら読んで消す。別の画面なら消さずに null', () => {
    rememberPaymentAttempt({ checkoutSessionId: 'cs_test_1', paymentType: 'paypay' });

    expect(takePaymentAttempt('cs_test_other')).toBeNull();
    expect(takePaymentAttempt('cs_test_1')).toEqual({ checkoutSessionId: 'cs_test_1', paymentType: 'paypay' });
    expect(takePaymentAttempt('cs_test_1')).toBeNull();
  });

  test('画面の中で支払いが終われば消す', () => {
    rememberPaymentAttempt({ checkoutSessionId: 'cs_test_1', paymentType: 'card' });
    clearPaymentAttempt();

    expect(takePaymentAttempt('cs_test_1')).toBeNull();
  });

  test('戻ってきて未払いなら、PayPay は PayPay の案内、ほかは一般の案内', () => {
    expect(paymentIncompleteMessage('paypay')).toBe('PayPay でのお支払いが完了しませんでした');
    expect(paymentIncompleteMessage('card')).toBe('お支払いが完了しませんでした。もう一度お試しください');
    expect(paymentIncompleteMessage(null)).toBe('お支払いが完了しませんでした。もう一度お試しください');
  });
});
