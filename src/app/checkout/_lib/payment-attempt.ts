/**
 * 「注文する」で支払いを始めたことの記録（計画の決め事 D10）。
 *
 * PayPay などは Stripe の画面へ移ってから当店に戻るので、戻ってきたときに「支払った直後」か
 * 「後からの入り直し」かを、この記録で見分ける。画面の中で支払いが終われば消す。
 */
export type PaymentAttempt = { checkoutSessionId: string; paymentType: string | null };

const STORAGE_KEY = "checkout:payment-attempt";

export function rememberPaymentAttempt(attempt: PaymentAttempt): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attempt));
  } catch {
    // 戻ったときの案内が一般の文言になるだけ
  }
}

export function clearPaymentAttempt(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 記録が残っても、次に同じ決済の画面へ戻ったときに読まれて消えるだけ
  }
}

/** 戻ってきた決済の画面の記録を読んで消す。別の決済の画面の記録なら消さずに null */
export function takePaymentAttempt(checkoutSessionId: string): PaymentAttempt | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as PaymentAttempt).checkoutSessionId !== checkoutSessionId
    ) {
      return null;
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
    const paymentType = (parsed as PaymentAttempt).paymentType;
    return { checkoutSessionId, paymentType: typeof paymentType === "string" ? paymentType : null };
  } catch {
    return null;
  }
}

/** 支払いの画面から戻ったのに未払いのときの案内（設計書第7章） */
export function paymentIncompleteMessage(paymentType: string | null): string {
  return paymentType === "paypay"
    ? "PayPay でのお支払いが完了しませんでした"
    : "お支払いが完了しませんでした。もう一度お試しください";
}
