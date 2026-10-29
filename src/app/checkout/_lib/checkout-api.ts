import { clientFetch, refreshSessionOnce } from "@/lib/client-fetch";
import type { CheckoutConfirmation } from "@/features/checkout/services/checkout-confirmation.service";
import type { CheckoutDisplayedAmounts } from "@/features/checkout/services/checkout-pricing.service";
import { isCartNoticeLine, type CartNoticeLine } from "@/features/checkout/utils/cart-notice";
import type { DiscountRefusal, DiscountResult } from "@/lib/discounts/discount-types";

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
  /** 入力したコードが使えない（409）。refusals が検証できた時だけ definitive で、該当コードを確定無効にできる */
  | { kind: "promotion_code_invalid"; message: string; refusals: readonly DiscountRefusal[]; definitive: boolean }
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
  /** 入力したコードが条件を失った（409 returnTo=input）。confirm へは進まず入力画面へ戻す */
  | { kind: "discount_codes_invalid"; message: string; refusals: readonly DiscountRefusal[]; definitive: boolean }
  /** 自動の割引が変わった（200）。入力へ戻さず、新しい決済の画面で最終確認をやり直す */
  | { kind: "reconfirmation_required" }
  | { kind: "error"; message: string };

export type CompleteResult = { kind: "completed"; orderId: string; orderStatus: string } | { kind: "error"; message: string };

/**
 * 複数コードの確認の結果。422 または confirm / place-order の入力コード用 409 で、検証できた refusals がある時だけ definitive=true
 * （該当コードを確定無効にしてよい）。401 / 403 / 429 / 500 / 503・通信の失敗・壊れた本文は false（保存したコードを残す）。
 */
export type PromotionCodesResponse =
  | { ok: true; result: DiscountResult }
  | { ok: false; status: number; refusals: readonly DiscountRefusal[]; message: string; definitive: boolean };

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
const DISCOUNT_CHANGED_MESSAGE = "割引の条件が変わりました。入力画面で割引を確かめてください。";
const PROMOTION_LOGIN_EXPIRED_MESSAGE = "ログインの有効期限が切れました。ログインし直してから、もう一度「適用」を押してください。";
const LOGIN_CHANGED_MESSAGE = "ログインの状態が変わりました。もう一度「確認へ進む」を押してください。";
const LOGIN_EXPIRED_MESSAGE = "ログインの有効期限が切れました。ログインし直すか、そのままもう一度「確認へ進む」を押してください。";

type JsonBody = Record<string, unknown> | null;

async function readJson(response: Response): Promise<JsonBody> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
  // 読めなかった本文を開いたまま残さない（no-store の応答が残ると networkidle が終わらない）
  await Promise.resolve(response.body?.cancel()).catch(() => undefined);
  return null;
}

const REFUSAL_REASONS: readonly DiscountRefusal["reason"][] = [
  "not_found", "not_eligible", "expired", "usage_limit", "minimum_amount", "minimum_quantity", "zero_total",
];

function toRefusals(value: unknown): DiscountRefusal[] | null {
  if (!Array.isArray(value)) return null;
  const refusals: DiscountRefusal[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { code, reason, minimumAmount } = item as Record<string, unknown>;
    if (typeof code !== "string" || !REFUSAL_REASONS.includes(reason as DiscountRefusal["reason"])) return null;
    if (minimumAmount !== undefined && (typeof minimumAmount !== "number" || !Number.isFinite(minimumAmount))) return null;
    refusals.push({ code, reason: reason as DiscountRefusal["reason"], ...(typeof minimumAmount === "number" ? { minimumAmount } : {}) });
  }
  return refusals;
}

/** 入力したコードが条件を失った 409（create-session は discount_conditions_changed、place-order は discount_*。どちらも returnTo=input） */
function isDiscountCodeConflict(data: JsonBody): data is Record<string, unknown> {
  if (data === null) return false;
  return data.error === "promotion_code_invalid"
    || (data.returnTo === "input" && typeof data.error === "string" && data.error.startsWith("discount_"));
}

function isDiscountResult(value: unknown): value is DiscountResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return result.version === 1 && typeof result.subtotalAmount === "number" && typeof result.discountAmount === "number"
    && typeof result.totalAmount === "number" && Array.isArray(result.applied) && Array.isArray(result.unusedCodes)
    && typeof result.provisional === "boolean";
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
  promotionCodes: readonly string[];
}): Promise<ProceedResult> {
  let result: CheckoutPostResult;
  try {
    result = await postCheckoutJson("/api/checkout/create-session", {
      uiMode: "custom",
      shipping: body.shipping,
      displayedAmounts: body.displayedAmounts,
      ...(body.promotionCodes.length > 0 ? { promotionCodes: body.promotionCodes } : {}),
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
  if (response.status === 409 && isDiscountCodeConflict(data) && typeof data.message === "string") {
    const refusals = toRefusals(data.refusals) ?? [];
    return { kind: "promotion_code_invalid", message: data.message, refusals, definitive: data.definitive === true && refusals.length > 0 };
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
  if (response.ok && data?.reconfirmationRequired === true && data.returnTo === "confirmation") {
    return { kind: "reconfirmation_required" };
  }
  if (response.status === 409 && isDiscountCodeConflict(data) && data.error !== "promotion_code_invalid") {
    const refusals = toRefusals(data.refusals) ?? [];
    return {
      kind: "discount_codes_invalid",
      message: typeof data.message === "string" ? data.message : DISCOUNT_CHANGED_MESSAGE,
      refusals,
      definitive: data.definitive === true && refusals.length > 0,
    };
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

/**
 * 入力したコード全部の確認（設計書第3章）。サーバーが全コードを再計算する。
 * guestEmail は形式だけ検査されて捨てられ、履歴の照合には使われない（ゲストの初回・１人１回は常に見込み）。
 * 非okの本文も一度読んで分類し、読めない本文は閉じる。
 */
export async function applyPromotionCodes(codes: readonly string[], guestEmail?: string): Promise<PromotionCodesResponse> {
  const failure = (status: number, message: string = PROMOTION_FAILED_MESSAGE): PromotionCodesResponse =>
    ({ ok: false, status, refusals: [], message, definitive: false });
  try {
    const result = await postCheckoutJson("/api/checkout/promotion-code", { codes, ...(guestEmail ? { guestEmail } : {}) });
    if (result.kind === "login_expired") {
      // ゲストの形に落とさず、ログインし直して押し直してもらう。コードが使えないと確定したわけではない
      return failure(401, PROMOTION_LOGIN_EXPIRED_MESSAGE);
    }
    if (result.kind === "auth_unavailable") {
      // ログインの状態は変わっていない。通信・回数制限の失敗と同じく、時間をおいて押し直してもらう
      return failure(503);
    }
    const { response, data } = result;
    if (response.ok) {
      const candidate: unknown = data?.result;
      return isDiscountResult(candidate) ? { ok: true, result: candidate } : failure(response.status);
    }
    const message = typeof data?.message === "string" ? data.message : PROMOTION_FAILED_MESSAGE;
    // 理由つきの422で、検証できた refusals がある時だけ、そのコードを使えないと確定する
    const refusals = response.status === 422 ? toRefusals(data?.refusals) : null;
    if (refusals && refusals.length > 0) {
      return { ok: false, status: response.status, refusals, message, definitive: true };
    }
    return { ok: false, status: response.status, refusals: [], message, definitive: false };
  } catch {
    return failure(0);
  }
}
