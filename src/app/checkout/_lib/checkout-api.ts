import { clientFetch, refreshSessionOnce } from "@/lib/client-fetch";
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
  | "superseded"
  | "login_changed";

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
  "login_changed",
];

const PROCEED_FAILED_MESSAGE = "決済の準備に失敗しました。少し時間をおいてから、もう一度お試しください。";
const PLACE_ORDER_FAILED_MESSAGE = "ご注文を受け付けられませんでした。少し時間をおいてから、もう一度お試しください。";
const COMPLETE_FAILED_MESSAGE = "注文確定に失敗しました。時間をおいて再度お試しください。";
const PROMOTION_FAILED_MESSAGE = "割引コードを確かめられませんでした。少し時間をおいてから、もう一度お試しください。";
const PROMOTION_LOGIN_EXPIRED_MESSAGE = "ログインの有効期限が切れました。ログインし直してから、もう一度「適用」を押してください。";
const LOGIN_CHANGED_MESSAGE = "ログインの状態が変わりました。もう一度「確認へ進む」を押してください。";
const LOGIN_EXPIRED_MESSAGE = "ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。";

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

/**
 * 決済の入口の通信の結果。
 * - response: ふつうの応答（本文つき）
 * - login_expired: 印を新しくできない（更新の入口が 401）、または送り直してもまた断られた。結果は呼び出し側が入口ごとに決める
 * - auth_unavailable: 印の更新が一時的にできない（回数の制限・通信の失敗・待ち時間中）。ゲストの形に落とさず、一時的な失敗として扱う
 */
type CheckoutPostResult =
  | { kind: "response"; response: Response; data: JsonBody }
  | { kind: "login_expired" }
  | { kind: "auth_unavailable" };

function isAuthExpired(response: Response, data: JsonBody): boolean {
  return response.status === 401 && data?.error === "auth_expired";
}

/**
 * ログインの印が古いと断られたら、印を新しくして1回だけ送り直す（グループ C 設計書第6章）。
 * 入口はログインの確かめを何かを変える前に行うので、送り直しても二重にならない。
 * 送り直すのは印を新しくできた時だけ。失効や一時的な失敗の時に送り直しても、同じ断りになるだけで通信が増える。
 */
async function postCheckoutJson(url: string, body: unknown): Promise<CheckoutPostResult> {
  const first = await postJson(url, body);
  const firstData = await readJson(first);
  if (!isAuthExpired(first, firstData)) {
    return { kind: "response", response: first, data: firstData };
  }
  const refreshed = await refreshSessionOnce();
  if (refreshed === "expired") {
    return { kind: "login_expired" };
  }
  if (refreshed === "unavailable") {
    return { kind: "auth_unavailable" };
  }
  const second = await postJson(url, body);
  const secondData = await readJson(second);
  if (isAuthExpired(second, secondData)) {
    return { kind: "login_expired" };
  }
  return { kind: "response", response: second, data: secondData };
}

/** 「確認へ進む」。サーバーが下書きと決済の画面を作り、最終確認画面の内容を返す（設計書 2-2） */
export async function requestCheckoutConfirmation(body: {
  shipping: CheckoutShippingInput;
  displayedAmounts: CheckoutDisplayedAmounts;
  promotionCode: string | null;
}): Promise<ProceedResult> {
  let result: CheckoutPostResult;
  try {
    result = await postCheckoutJson("/api/checkout/create-session", {
      uiMode: "custom",
      shipping: body.shipping,
      displayedAmounts: body.displayedAmounts,
      ...(body.promotionCode ? { promotionCode: body.promotionCode } : {}),
    });
  } catch {
    // clientFetch は POST の通信の失敗を投げ直す。画面が値で扱えるよう、「確認へ進む」をやり直せるエラーにして返す
    return { kind: "error", code: null, message: PROCEED_FAILED_MESSAGE, retryable: true, correlationId: null };
  }
  if (result.kind === "login_expired") {
    // 自動でゲストとして進めず、お客様に押し直してもらう（設計書 C2）
    return { kind: "error", code: "auth_expired", message: LOGIN_EXPIRED_MESSAGE, retryable: true, correlationId: null };
  }
  if (result.kind === "auth_unavailable") {
    // ログインの状態は変わっていない。画面はログインの状態を読み直さず、今の「時間をおいて、もう一度」の案内を出す
    return { kind: "error", code: "auth_unavailable", message: PROCEED_FAILED_MESSAGE, retryable: true, correlationId: null };
  }
  const { response, data } = result;

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
    retryable: typeof data?.retryable === "boolean" ? data.retryable : true,
    correlationId: typeof data?.correlationId === "string" ? data.correlationId : null,
  };
}

/** 決済の画面を開き直したときに、どこから続けるか（決め事 D9）。読めなければ入力画面から */
export async function resumeCheckout(checkoutSessionId: string | null): Promise<ResumeResult> {
  try {
    const result = await postCheckoutJson("/api/checkout/resume", checkoutSessionId ? { checkoutSessionId } : {});
    if (result.kind !== "response") {
      // 印を新しくできなかった（失効、または一時的）。続きの手続きは読めないので、入力画面から始めてもらう
      return { state: "none" };
    }
    const { response, data } = result;
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
  let result: CheckoutPostResult;
  try {
    result = await postCheckoutJson("/api/checkout/place-order", params);
  } catch {
    return { kind: "error", message: PLACE_ORDER_FAILED_MESSAGE };
  }
  if (result.kind === "login_expired") {
    // 「確認へ進む」の時のログインが、今は確かめられない。ログインの状態が変わった時と同じに扱う
    return { kind: "rejected", rejection: { code: "login_changed", message: LOGIN_CHANGED_MESSAGE, changedLines: [] } };
  }
  if (result.kind === "auth_unavailable") {
    // 一時的にログインを確かめられない。最終確認画面に残り、押し直せる
    return { kind: "error", message: PLACE_ORDER_FAILED_MESSAGE };
  }
  const { response, data } = result;

  if (response.ok && typeof data?.orderId === "string") {
    return { kind: "accepted", orderId: data.orderId };
  }
  if (response.status === 409 && data?.error === "payment_done") {
    return { kind: "payment_done", ...(typeof data.checkoutSessionId === "string" ? { checkoutSessionId: data.checkoutSessionId } : {}) };
  }
  if (response.status === 403 && data?.error === "forbidden") {
    // ログインはカートの印（session_id）を新しくするので、「確認へ進む」の後にログインすると、決済の画面は今のカートのものでなくなり、
    // サーバーは買い手を比べる前にこの 403 で断る（設計書 4-3）。お客様には、買い手の比べで断られた時と同じ案内を出して入力画面へ戻す。
    // サーバーはこの 403 で決済の画面を閉じない（印の合わない要求で他人の決済の画面を閉じさせないため）。画面からも閉じない
    return { kind: "rejected", rejection: { code: "login_changed", message: LOGIN_CHANGED_MESSAGE, changedLines: [] } };
  }
  if (response.status === 409 && REJECTION_CODES.includes(data?.error as CheckoutRejectionCode)) {
    const code = data?.error as CheckoutRejectionCode;
    // 画面に出す文はサーバーが付ける。ログインの状態が変わった断りは、文が無くても入力画面へ戻して案内できるよう既定の文を持つ
    const message = typeof data?.message === "string" ? data.message : code === "login_changed" ? LOGIN_CHANGED_MESSAGE : null;
    if (message !== null) {
      return {
        kind: "rejected",
        rejection: {
          code,
          message,
          changedLines: Array.isArray(data?.changedLines) ? data.changedLines.filter(isCartNoticeLine) : [],
        },
      };
    }
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
    const result = await postCheckoutJson("/api/checkout/promotion-code", { code });
    if (result.kind === "login_expired") {
      // ゲストの形に落とさず、ログインし直して押し直してもらう。コードが使えないと確定したわけではないので、一時的な失敗にする
      return { kind: "rejected", message: PROMOTION_LOGIN_EXPIRED_MESSAGE, transient: true };
    }
    if (result.kind === "auth_unavailable") {
      // ログインの状態は変わっていない。通信・回数制限の失敗と同じく、時間をおいて押し直してもらう
      return { kind: "rejected", message: PROMOTION_FAILED_MESSAGE, transient: true };
    }
    const { response, data } = result;
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
