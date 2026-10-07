import { clientFetch } from "@/lib/client-fetch";
import type { CheckoutConfirmation } from "@/features/checkout/services/checkout-confirmation.service";
import type { CheckoutDisplayedAmounts } from "@/features/checkout/services/checkout-pricing.service";
import { isCartNoticeLine, type CartNoticeLine } from "@/features/checkout/utils/cart-notice";

/** 決済の画面の入口に送る、お客様情報・配送先の入力（サーバーが整えて下書きに残す） */
export type CheckoutShippingInput = {
  email: string;
  fullName: string;
  kanaName: string;
  postalCode: string;
  prefecture: string;
  city: string;
  address: string;
  building: string;
  phone: string;
};

export type ProceedResult =
  | { kind: "confirmation"; confirmation: CheckoutConfirmation }
  | { kind: "order_already_placed"; checkoutSessionId: string }
  | { kind: "promotion_code_invalid"; message: string }
  | { kind: "error"; code: string | null; message: string; retryable: boolean; correlationId: string | null };

export type ResumeResult =
  | { state: "none" }
  | { state: "unavailable" }
  | { state: "payment_done"; checkoutSessionId: string }
  | { state: "resume"; confirmation: CheckoutConfirmation };

export type CheckoutRejectionCode =
  | "stock_changed"
  | "item_unavailable"
  | "price_changed"
  | "cart_changed"
  | "zero_amount"
  | "session_expired"
  | "superseded";

export type CheckoutRejection = { code: CheckoutRejectionCode; message: string; changedLines: CartNoticeLine[] };

export type PlaceOrderOutcome =
  | { kind: "accepted"; orderId: string }
  | { kind: "payment_done"; checkoutSessionId?: string }
  | { kind: "rejected"; rejection: CheckoutRejection }
  | { kind: "error"; message: string };

export type CompleteResult = { kind: "completed"; orderId: string; orderStatus: string } | { kind: "error"; message: string };

export type PromotionPreview = {
  code: string;
  subtotalAmount: number;
  shippingAmount: number;
  discountAmount: number;
  totalAmount: number;
};

export type PromotionCheckResult = { kind: "applied"; preview: PromotionPreview } | { kind: "rejected"; message: string; transient: boolean };

const REJECTION_CODES: readonly CheckoutRejectionCode[] = [
  "stock_changed",
  "item_unavailable",
  "price_changed",
  "cart_changed",
  "zero_amount",
  "session_expired",
  "superseded",
];

const PROCEED_FAILED_MESSAGE = "決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。";
const PLACE_ORDER_FAILED_MESSAGE = "ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。";
const COMPLETE_FAILED_MESSAGE = "注文確定に失敗しました。時間をおいて再度お試しください。";
const PROMOTION_FAILED_MESSAGE = "割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。";

type JsonBody = Record<string, unknown> | null;

async function readJson(response: Response): Promise<JsonBody> {
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
}

function postJson(url: string, body: unknown): Promise<Response> {
  return clientFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 「確認へ進む」。サーバーが下書きと決済の画面を作り、最終確認画面の内容を返す（設計書 2-2） */
export async function requestCheckoutConfirmation(body: {
  shipping: CheckoutShippingInput;
  displayedAmounts: CheckoutDisplayedAmounts;
  promotionCode: string | null;
}): Promise<ProceedResult> {
  let response: Response;
  try {
    response = await postJson("/api/checkout/create-session", {
      uiMode: "custom",
      shipping: body.shipping,
      displayedAmounts: body.displayedAmounts,
      ...(body.promotionCode ? { promotionCode: body.promotionCode } : {}),
    });
  } catch {
    // clientFetch は POST の通信の失敗を投げ直す。画面が値で扱えるよう、「確認へ進む」をやり直せるエラーにして返す
    return { kind: "error", code: null, message: PROCEED_FAILED_MESSAGE, retryable: true, correlationId: null };
  }
  const data = await readJson(response);

  if (response.ok && data?.confirmation) {
    return { kind: "confirmation", confirmation: data.confirmation as CheckoutConfirmation };
  }
  if (response.status === 409 && data?.error === "order_already_placed" && typeof data.checkoutSessionId === "string") {
    return { kind: "order_already_placed", checkoutSessionId: data.checkoutSessionId };
  }
  if (response.status === 409 && data?.error === "promotion_code_invalid" && typeof data.message === "string") {
    return { kind: "promotion_code_invalid", message: data.message };
  }
  return {
    kind: "error",
    code: typeof data?.error === "string" ? data.error : null,
    message: typeof data?.message === "string" ? data.message : PROCEED_FAILED_MESSAGE,
    // 買えない商品（FR-CHECKOUT-007）は待っても直らない
    retryable: data?.error === "out_of_stock" ? false : typeof data?.retryable === "boolean" ? data.retryable : true,
    correlationId: typeof data?.correlationId === "string" ? data.correlationId : null,
  };
}

/** 決済の画面を開き直したときに、どこから続けるか（決め事 D9）。読めなければ入力画面から */
export async function resumeCheckout(checkoutSessionId: string | null): Promise<ResumeResult> {
  try {
    const response = await postJson("/api/checkout/resume", checkoutSessionId ? { checkoutSessionId } : {});
    const data = await readJson(response);
    if (!response.ok) {
      if (checkoutSessionId && (
        (response.status === 400 && data?.error === "session_not_found") ||
        (response.status === 403 && data?.error === "forbidden")
      )) {
        return { state: "unavailable" };
      }
      return { state: "none" };
    }
    if (data?.state === "payment_done" && typeof data.checkoutSessionId === "string") {
      return { state: "payment_done", checkoutSessionId: data.checkoutSessionId };
    }
    if (data?.state === "resume" && data.confirmation) {
      return { state: "resume", confirmation: data.confirmation as CheckoutConfirmation };
    }
  } catch {
    // 入力画面から始めれば、お客様は手続きを続けられる
  }
  return { state: "none" };
}

/** 「注文する」の受け付け（設計書 2-4・第6章） */
export async function placeOrder(params: { checkoutSessionId: string; inStockVariantIds: number[] }): Promise<PlaceOrderOutcome> {
  let response: Response;
  try {
    response = await postJson("/api/checkout/place-order", params);
  } catch {
    return { kind: "error", message: PLACE_ORDER_FAILED_MESSAGE };
  }
  const data = await readJson(response);

  if (response.ok && typeof data?.orderId === "string") {
    return { kind: "accepted", orderId: data.orderId };
  }
  if (response.status === 409 && data?.error === "payment_done") {
    return { kind: "payment_done", ...(typeof data.checkoutSessionId === "string" ? { checkoutSessionId: data.checkoutSessionId } : {}) };
  }
  if (
    response.status === 409 &&
    REJECTION_CODES.includes(data?.error as CheckoutRejectionCode) &&
    typeof data?.message === "string"
  ) {
    return {
      kind: "rejected",
      rejection: {
        code: data.error as CheckoutRejectionCode,
        message: data.message,
        changedLines: Array.isArray(data.changedLines) ? data.changedLines.filter(isCartNoticeLine) : [],
      },
    };
  }
  return { kind: "error", message: typeof data?.message === "string" ? data.message : PLACE_ORDER_FAILED_MESSAGE };
}

/** 支払いの後の完了の処理（照合・メール・カートを空にする。グループ A の complete） */
export async function completeCheckout(checkoutSessionId: string): Promise<CompleteResult> {
  try {
    const response = await fetch("/api/checkout/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkoutSessionId }),
    });
    const data = await readJson(response);
    if (response.ok && typeof data?.orderId === "string") {
      // 状態が読めないときに「入金済み」と出すと、コンビニの入金待ちを入金済みと知らせてしまう。知らない状態は画面が「手続き中」と出す
      return { kind: "completed", orderId: data.orderId, orderStatus: typeof data.status === "string" ? data.status : "unknown" };
    }
  } catch {
    // 下の案内を返す。注文の確定は Stripe の知らせと見回りが仕上げる
  }
  return { kind: "error", message: COMPLETE_FAILED_MESSAGE };
}

/** 割引コードの「適用」（設計書第3章） */
export async function checkPromotionCodeRequest(code: string): Promise<PromotionCheckResult> {
  try {
    const response = await postJson("/api/checkout/promotion-code", { code });
    const data = await readJson(response);
    if (response.ok && typeof data?.code === "string" && typeof data.totalAmount === "number") {
      return { kind: "applied", preview: data as unknown as PromotionPreview };
    }
    return {
      kind: "rejected",
      message: typeof data?.message === "string" ? data.message : PROMOTION_FAILED_MESSAGE,
      // 理由つきの422だけがコードを使えないと確定する。通信・回数制限・サーバーの失敗では記録を残す。
      transient: response.status !== 422 || typeof data?.message !== "string",
    };
  } catch {
    return { kind: "rejected", message: PROMOTION_FAILED_MESSAGE, transient: true };
  }
}
