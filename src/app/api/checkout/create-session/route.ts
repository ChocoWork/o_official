import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import Stripe from "stripe";
import { getStripeServerClient } from "@/lib/stripe/server";
import { KONBINI_PAYMENT_DAYS } from "@/lib/constants/konbini";
import {
  buildInventoryConflictBody,
  collectInventoryIssues,
} from "@/features/cart/services/cart-stock";
import {
  buyerOfCheckoutSession,
  buildShippingSnapshot,
  checkoutShippingSchema,
  findMissingShippingFields,
  normalizeCheckoutEmail,
  STRIPE_CHECKOUT_PAYMENT_METHODS,
  type CheckoutDraftItemSnapshot,
  type CheckoutCartSnapshotRow,
  type CheckoutShippingSnapshot,
  type CheckoutItemSnapshotRow,
} from "@/features/checkout/services/checkout-draft.service";
import {
  calculateCheckoutAmountsFromCartRows,
  checkoutDisplayedAmountsSchema,
  isCheckoutDisplayedAmountsMatched,
} from "@/features/checkout/services/checkout-pricing.service";
import { classifyCheckoutSessionError } from "@/features/checkout/services/checkout-error.service";
import { logAudit } from "@/lib/audit";
import { cookieOptionsForCsrf, csrfCookieName } from "@/lib/cookie";
import { getRequestOrigin } from "@/lib/redirect";
import { expireOpenCheckoutSession } from "@/lib/stripe/checkout-session-expiry";
import { signItemImageUrl } from "@/lib/storage/item-images";
import {
  PROMOTION_CODE_PATTERN,
  checkPromotionCode,
  type PromotionCodeCheck,
} from "@/features/checkout/services/promotion-code.service";
import { buildCheckoutConfirmation } from "@/features/checkout/services/checkout-confirmation.service";
import {
  closeOtherCheckoutSessions,
  findPaidCheckoutSession,
  reconcileCheckoutSession,
} from "@/features/checkout/services/checkout-session-lifecycle.service";
import { resolveCheckoutIpLimitMultiplier } from "@/features/checkout/services/checkout-route-guard";
import {
  buyerUserIdOf,
  checkoutBuyerFailureResponse,
  resolveCheckoutBuyer,
} from "@/features/checkout/services/checkout-buyer";

type CsrfDenyResponse = {
  status: number;
  _body: unknown;
  headers?: Headers | Record<string, string>;
};

type CsrfRotateResult = {
  rotatedCsrfToken: string;
};

function isCsrfDenyResponse(value: unknown): value is CsrfDenyResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "_body" in value
  );
}

function hasRotatedCsrfToken(value: unknown): value is CsrfRotateResult {
  return (
    typeof value === "object" && value !== null && "rotatedCsrfToken" in value
  );
}

function applyRotatedCsrfCookie(response: NextResponse, csrfResult: unknown) {
  if (!hasRotatedCsrfToken(csrfResult)) {
    return response;
  }

  response.cookies.set({
    name: csrfCookieName,
    value: csrfResult.rotatedCsrfToken,
    ...cookieOptionsForCsrf(0),
  });

  return response;
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const createSessionSchema = z.object({
  paymentMethod: z.enum(STRIPE_CHECKOUT_PAYMENT_METHODS).optional(),
  uiMode: z.enum(["custom"]).default("custom"),
  shipping: checkoutShippingSchema,
  displayedAmounts: checkoutDisplayedAmountsSchema,
  // 入力画面で「適用」したコード。ここでもう一度確かめてから決済の画面に付ける（設計書第3章）
  promotionCode: z.string().trim().regex(PROMOTION_CODE_PATTERN).optional(),
});

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? null;
  }

  return request.headers.get("x-real-ip");
}

type ReusableCheckoutDraftRow = {
  id: string;
  checkout_session_id: string | null;
  payment_method: string | null;
  subtotal_amount: number;
  shipping_amount: number;
  total_amount: number;
  currency: string;
  items_snapshot: CheckoutDraftItemSnapshot[] | null;
  shipping_snapshot: CheckoutShippingSnapshot | null;
  shipping_revision: number | null;
  checkout_request_version?: number | null;
  checkout_request_fingerprint?: string | null;
};

type ClaimedCheckoutDraftRow = ReusableCheckoutDraftRow & {
  session_id: string;
  tax_amount: number;
  checkout_request_version: number;
  checkout_request_fingerprint: string;
  checkout_ui_mode: "custom";
  checkout_origin: string;
  claim_created: boolean;
};

type CheckoutDraftAttachmentResult = {
  checkout_session_id: string;
  attached: boolean;
};

// 版 2（決め事 D4）: 割引コードと配送先を見分けの値に含め、入力が同じときだけ下書き・決済の画面を使い回す。
// 版 3（グループ C）: 買い手も見分けの値に含め、入力と買い手が同じときだけ使い回す（設計書 4-2）。
// 版を上げることで、買い手を記録していない古い下書きが使い回されるのを防ぐ。
const CHECKOUT_REQUEST_VERSION = 3;

/** 開いている決済の画面を使い回すのに要る残り時間（受け付けの10分＋最終確認画面での5分。決め事 D4） */
const REUSE_MIN_REMAINING_SECONDS = 15 * 60;

/** PostgREST の素のエラーも、code・message だけ監査に残す。details・hint や本文は含めない。 */
function describeUnexpectedError(error: unknown): { error_message: string; error_code?: string } {
  const fields = typeof error === "object" && error !== null ? (error as { message?: unknown; code?: unknown }) : {};
  const errorMessage = typeof fields.message === "string" ? fields.message : "Unknown error";
  return typeof fields.code === "string"
    ? { error_message: errorMessage, error_code: fields.code }
    : { error_message: errorMessage };
}

function hasReusableTimeLeft(session: Stripe.Checkout.Session): boolean {
  return (
    typeof session.expires_at === "number" &&
    session.expires_at - Math.floor(Date.now() / 1000) >= REUSE_MIN_REMAINING_SECONDS
  );
}

/** 支払いの済んだ決済の画面がある（設計書 2-5）。画面は注文の確定を仕上げて状態を見せる */
function orderAlreadyPlacedResponse(checkoutSessionId: string): NextResponse {
  return NextResponse.json(
    {
      error: "order_already_placed",
      checkoutSessionId,
      message: "ご注文は確定しています。",
      retryable: false,
    },
    { status: 409 },
  );
}

function canonicalizeItemsSnapshot(
  itemsSnapshot: CheckoutDraftItemSnapshot[],
): CheckoutDraftItemSnapshot[] {
  return [...itemsSnapshot].sort((left, right) =>
    [
      left.source_cart_line_id,
      String(left.item_id),
      left.color ?? "",
      left.size ?? "",
    ]
      .join(":")
      .localeCompare(
        [
          right.source_cart_line_id,
          String(right.item_id),
          right.color ?? "",
          right.size ?? "",
        ].join(":"),
      ),
  );
}

function buildCheckoutRequestFingerprint(params: {
  uiMode: "custom";
  origin: string;
  subtotalAmount: number;
  taxAmount: number;
  shippingAmount: number;
  totalAmount: number;
  itemsSnapshot: CheckoutDraftItemSnapshot[];
  shippingSnapshot: CheckoutShippingSnapshot;
  promotionCodeId: string | null;
  buyerUserId: string | null;
}): string {
  const canonical = JSON.stringify({
    version: CHECKOUT_REQUEST_VERSION,
    uiMode: params.uiMode,
    origin: params.origin,
    currency: "jpy",
    subtotalAmount: params.subtotalAmount,
    taxAmount: params.taxAmount,
    shippingAmount: params.shippingAmount,
    totalAmount: params.totalAmount,
    itemsSnapshot: params.itemsSnapshot,
    shippingSnapshot: params.shippingSnapshot,
    promotionCodeId: params.promotionCodeId,
    buyerUserId: params.buyerUserId,
  });

  return `v${CHECKOUT_REQUEST_VERSION}:${createHash("sha256").update(canonical).digest("hex")}`;
}

function checkoutSessionIdempotencyKey(draftId: string, expiresAt: number): string {
  return `checkout-session:create:v${CHECKOUT_REQUEST_VERSION}:${draftId}:${expiresAt}`;
}

/**
 * 決済画面の失効時刻を下書きに1回だけ決める（設計書 2-2、R-25）。
 * 冪等キーに含めるので、同じ要求の再送は同じ Session に収束する。
 */
async function reserveCheckoutSessionExpiry(draftId: string): Promise<number> {
  const { data, error } = await supabase.rpc("reserve_checkout_session_expiry", {
    _draft_id: draftId,
  });

  if (error || typeof data !== "number" || !Number.isInteger(data)) {
    throw new Error("Failed to reserve checkout session expiry");
  }

  return data;
}

// IP 単位の上限は二段で数える（FREQ-362）。
// - 10秒10回: 一瞬の集中を抑える。時間枠の境目をまたいでも約2秒で20回（毎秒10回）までで、
//   Stripe の上限（エンドポイントごとに毎秒25回）を1つの IP で超えない。
// - 10分60回: 1つの IP から続けて呼べる総量を抑える（1時間360回）。
// 1つの長い時間枠だけで絞ると、共有 IP（携帯回線・社内）からの短い集中まで止めてしまう。
// 時間枠ごとに数え直すので、キーは時間枠ごとに分ける（同じキーだと境目で回数が混ざる）。
const CREATE_SESSION_IP_LIMITS = [
  { endpoint: "checkout:create-session:ip-10s", limit: 10, windowSeconds: 10 },
  { endpoint: "checkout:create-session:ip-10m", limit: 60, windowSeconds: 600 },
] as const;
// 画面（checkout/page.tsx）は message をそのまま表示する。再試行は「確認へ進む」をもう一度押すこと。
const RATE_LIMITED_MESSAGE =
  "アクセスが集中しているため、決済の準備を一時的に止めています。少し時間をおいてから、もう一度「確認へ進む」を押してください。";

type StoreCheckoutSessionResult = "stored" | "conflict" | "error";

/**
 * Stripe Session ID を、claimしたdraftへCASで確定する。
 *
 * 同じIDの再送は成功として扱い、異なるIDが既に確定していれば上書きしない。
 * RPCエラーは結果不明なので、Sessionは失効しない。冪等キーに含む失効時刻は
 * reserve_checkout_session_expiry が15秒だけ使い回すので、15秒以内の再送は同じキーで
 * 同じSessionを回収する。それより後の再送は別のキーで新しいSessionを作る。
 * 結び付けられなかったSessionは利用者のどこにも渡らず、自身の失効時刻で失効する。
 */
async function storeCheckoutSessionIdOnDraft(params: {
  draftId: string;
  checkoutSessionId: string;
  sessionId: string;
  requestVersion: number;
  requestFingerprint: string;
  uiMode: "custom";
  ip: string | null;
  userAgent: string | null;
}): Promise<StoreCheckoutSessionResult> {
  const { data, error } = await supabase.rpc(
    "attach_checkout_session_to_draft",
    {
      _draft_id: params.draftId,
      _session_id: params.sessionId,
      _request_version: params.requestVersion,
      _request_fingerprint: params.requestFingerprint,
      _checkout_session_id: params.checkoutSessionId,
    },
  );

  if (!error) {
    const attached = (data as CheckoutDraftAttachmentResult[] | null)?.[0];
    if (attached?.checkout_session_id === params.checkoutSessionId) {
      return "stored";
    }
  }

  const detail = error
    ? "Failed to store checkout session id on draft"
    : "Checkout session id conflicted with the claimed draft";
  console.error(detail + ":", params.draftId, error ?? null);
  try {
    await logAudit({
      action: "checkout.session.create",
      outcome: "error",
      detail,
      ip: params.ip,
      user_agent: params.userAgent,
      metadata: {
        session_id: params.sessionId,
        draft_id: params.draftId,
        checkout_session_id: params.checkoutSessionId,
        ui_mode: params.uiMode,
        error_message: error?.message ?? null,
      },
    });
  } catch (logAuditError) {
    console.error("Failed to log checkout attachment error:", logAuditError);
  }

  return error ? "error" : "conflict";
}

async function retireExpiredDraft(params: {
  draftId: string;
  sessionId: string;
  checkoutSessionId: string;
  requestVersion: number | null;
  requestFingerprint: string | null;
}): Promise<boolean> {
  const { data, error } = await supabase.rpc("retire_expired_checkout_draft", {
    _draft_id: params.draftId,
    _session_id: params.sessionId,
    _checkout_session_id: params.checkoutSessionId,
    _request_version: params.requestVersion,
    _request_fingerprint: params.requestFingerprint,
  });

  if (error) {
    throw error;
  }

  return data === true;
}

async function expireConflictingOpenSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  draftId: string,
): Promise<void> {
  if (session.status !== "open") {
    return;
  }

  await stripe.checkout.sessions.expire(
    session.id,
    {},
    {
      idempotencyKey: `checkout-session:expire-orphan:v${CHECKOUT_REQUEST_VERSION}:${draftId}:${session.id}`,
    },
  );
}
async function claimCheckoutDraft(params: {
  sessionId: string;
  buyerUserId: string | null;
  /** 下書きを作ったカート（carts.id）。「注文する」の「カートが変わった」の確かめは、このカートの明細で行う */
  cartId: string;
  requestFingerprint: string;
  uiMode: "custom";
  checkoutOrigin: string;
  paymentMethod: string;
  subtotalAmount: number;
  taxAmount: number;
  shippingAmount: number;
  totalAmount: number;
  shippingSnapshot: CheckoutShippingSnapshot;
  itemsSnapshot: CheckoutDraftItemSnapshot[];
}): Promise<ClaimedCheckoutDraftRow> {
  const { data, error } = await supabase.rpc("claim_checkout_draft", {
    _session_id: params.sessionId,
    _request_version: CHECKOUT_REQUEST_VERSION,
    _request_fingerprint: params.requestFingerprint,
    _checkout_ui_mode: params.uiMode,
    _checkout_origin: params.checkoutOrigin,
    _payment_method: params.paymentMethod,
    _currency: "jpy",
    _subtotal_amount: params.subtotalAmount,
    _tax_amount: params.taxAmount,
    _shipping_amount: params.shippingAmount,
    _total_amount: params.totalAmount,
    _shipping_snapshot: params.shippingSnapshot,
    _items_snapshot: params.itemsSnapshot,
    _buyer_user_id: params.buyerUserId,
    _cart_id: params.cartId,
  });

  const draft = (data as ClaimedCheckoutDraftRow[] | null)?.[0];
  if (error || !draft) {
    throw error ?? new Error("Checkout draft claim returned no row");
  }

  return draft;
}

/**
 * 上限到達（429）を、時間をおいて再試行するよう案内する応答に置き換える。
 * 回数制限を判定できなかった応答（503）は上限到達ではないので、そのまま返す。
 * enforceRateLimit はテスト環境で素の Response を返しうるので、返り値は書き換えずに作り直す。
 */
function toRateLimitedResponse(limited: Response): Response {
  if (limited.status !== 429) {
    return limited;
  }

  const retryAfter = limited.headers?.get?.("Retry-After");
  return NextResponse.json(
    { error: "rate_limited", message: RATE_LIMITED_MESSAGE, retryable: true },
    {
      status: 429,
      headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
    },
  );
}

// PUBLIC: ゲスト購入を許可する公開Route。推測不能なsession_id Cookieでカートを分離し、
// 認証済み利用者はCSRF検証、全利用者は二段のIP/セッションrate limitを通す。
export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const userAgent = req.headers.get("user-agent");

  try {
    const sessionId = req.cookies.get("session_id")?.value;
    if (!sessionId) {
      await logAudit({
        action: "checkout.session.create",
        outcome: "failure",
        detail: "Session cookie not found",
        ip: clientIp,
        user_agent: userAgent,
      });
      return NextResponse.json({ error: "Session not found" }, { status: 400 });
    }

    const { enforceRateLimit } =
      await import("@/features/auth/middleware/rateLimit");
    // 少数の IP からの濫用を止めるのは IP 単位の上限（CREATE_SESSION_IP_LIMITS）。
    // 下のセッション単位の上限は、Cookie を捨てれば回避できるので、1つのブラウザでの
    // 誤操作の連打を止めるためのもの。IP 単位の上限を緩める根拠にはしない。
    const ipLimitMultiplier = resolveCheckoutIpLimitMultiplier();
    for (const { endpoint, limit, windowSeconds } of CREATE_SESSION_IP_LIMITS) {
      const rateLimitByIp = await enforceRateLimit({
        request: req,
        endpoint,
        limit: limit * ipLimitMultiplier,
        windowSeconds,
      });
      if (rateLimitByIp) {
        return toRateLimitedResponse(rateLimitByIp);
      }
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: "checkout:create-session",
      limit: 10,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return toRateLimitedResponse(rateLimitBySession);
    }

    // CSRF protection: enforced for authenticated users (sb-refresh-token present).
    // Unauthenticated guest sessions are mitigated by SameSite=Lax cookie policy.
    const { requireCsrfOrDeny } = await import("@/lib/csrfMiddleware");
    const csrfResult = await requireCsrfOrDeny();
    if (isCsrfDenyResponse(csrfResult)) {
      const denyResponse = NextResponse.json(csrfResult._body, {
        status: csrfResult.status,
      });
      if (csrfResult.headers instanceof Headers) {
        csrfResult.headers.forEach((headerValue, headerName) => {
          denyResponse.headers.set(headerName, headerValue);
        });
      } else if (csrfResult.headers) {
        for (const [headerName, headerValue] of Object.entries(
          csrfResult.headers,
        )) {
          denyResponse.headers.set(headerName, headerValue);
        }
      }

      return denyResponse;
    }

    // 買い手（会員かゲスト）は検証済みのログインからだけ決め、下書きに記録する（グループ C 設計書 4-2）
    const buyerResolution = await resolveCheckoutBuyer(req);
    if (buyerResolution.kind === "expired" || buyerResolution.kind === "unavailable") {
      return checkoutBuyerFailureResponse(buyerResolution.kind);
    }
    const buyerUserId = buyerUserIdOf(buyerResolution);

    const parsed = createSessionSchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      await logAudit({
        action: "checkout.session.create",
        outcome: "failure",
        detail: "Invalid request body",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }

    const { paymentMethod, shipping: requestedShipping, uiMode, displayedAmounts, promotionCode } = parsed.data;
    // 会員の注文のメールは、画面から送られた値ではなく検証済みのログインのメールにする（設計書 4-2・C7）。
    // 同じブラウザで前の人が入れたメールが、別の会員の注文に混ざらないようにする。
    // ログインのメールは、ゲストが入力したメールと同じ整え（NFKC・前後の空白・小文字、形の確かめ）を通してから使う。
    // 通さないと、注文のメールの形がゲストと食い違い、同じメールが大文字小文字・全角の違いで別の見分けの値（別の下書き）になる。
    // ログインのメールが無い会員とゲストは、画面のメールのまま扱う。値があっても使えない会員は断る。
    const memberEmail =
      buyerResolution.kind === "member" ? normalizeCheckoutEmail(buyerResolution.email) : undefined;
    if (buyerResolution.kind === "member" && buyerResolution.email !== null && !memberEmail) {
      await logAudit({
        action: "checkout.session.create",
        outcome: "failure",
        detail: "ログインのメールアドレスの形式が不正",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, reason: "invalid_member_email" },
      });
      return NextResponse.json({
        error: "invalid_member_email",
        message: "ログイン中のメールアドレスを確かめられませんでした。ログインし直してから、もう一度お試しください。",
        retryable: false,
      }, { status: 400 });
    }
    const shipping = memberEmail ? { ...requestedShipping, email: memberEmail } : requestedShipping;
    // 完了の照合と共有する任意項目のスキーマは保ち、支払いの準備では配送先の欠落を先に断る。
    const missingShippingFields = findMissingShippingFields(buildShippingSnapshot(shipping));
    if (missingShippingFields.length > 0) {
      await logAudit({
        action: "checkout.session.create",
        outcome: "failure",
        detail: "Shipping fields are incomplete",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, reason: "shipping_incomplete", missing_fields: missingShippingFields },
      });
      return NextResponse.json({ error: "shipping_incomplete" }, { status: 400 });
    }


    // カートは session_id ではなく持ち主（確かめた買い手）で読む。会員に残ったゲストの印があれば、ここで先に合わせる。
    // session_id は決済の流れ（下書き・注文・入り直し・回数の制限）の印として、この先もそのまま使う。
    const { findCartIdForBuyer } = await import("@/features/cart/services/shopping-context");
    const { readCheckoutCartRows } = await import("@/features/checkout/services/checkout-cart.service");
    let cartId: string | null;
    let cartData: CheckoutCartSnapshotRow[];
    try {
      cartId = await findCartIdForBuyer(supabase, req, buyerResolution);
      cartData = cartId ? await readCheckoutCartRows(supabase, cartId) : [];
    } catch (cartError) {
      console.error("Failed to fetch cart for checkout session:", cartError);
      await logAudit({
        action: "checkout.session.create",
        outcome: "error",
        detail: "Failed to fetch cart",
        ip: clientIp,
        user_agent: userAgent,
        // PostgREST の失敗は Error ではない素のオブジェクトで投げられるので、message・code だけ取り出す（details・hint は残さない）
        metadata: { session_id: sessionId, ...describeUnexpectedError(cartError) },
      });
      return NextResponse.json(
        { error: "Failed to fetch cart" },
        { status: 500 },
      );
    }

    if (!cartId || cartData.length === 0) {
      await logAudit({
        action: "checkout.session.create",
        outcome: "failure",
        detail: "Cart is empty",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    const itemIds = (cartData as CheckoutCartSnapshotRow[]).map(
      (item) => item.item_id,
    );
    const { data: itemsData, error: itemsError } = await supabase
      .from("items")
      .select("id, name, price, image_url, status")
      .in("id", itemIds);

    if (itemsError) {
      console.error("Failed to fetch items for checkout session:", itemsError);
      return NextResponse.json(
        { error: "Failed to fetch items" },
        { status: 500 },
      );
    }

    const inventoryIssues = collectInventoryIssues(
      cartData as CheckoutCartSnapshotRow[],
      (itemsData ?? []) as CheckoutItemSnapshotRow[],
    );

    if (inventoryIssues.length > 0) {
      return NextResponse.json(
        buildInventoryConflictBody(inventoryIssues, "out_of_stock"),
        { status: 409 },
      );
    }

    // 非公開の商品も名前で案内するために読む。ここまで通った明細はすべて公開中なので、金額・写しを作れる。
    const itemMap = new Map<number, CheckoutItemSnapshotRow>(
      ((itemsData ?? []) as CheckoutItemSnapshotRow[]).map((item) => [
        item.id,
        item,
      ]),
    );

    const { subtotalAmount, taxAmount, shippingAmount, totalAmount } =
      calculateCheckoutAmountsFromCartRows(
        cartData as CheckoutCartSnapshotRow[],
        itemMap,
      );

    if (
      !isCheckoutDisplayedAmountsMatched(
        { subtotalAmount, taxAmount, shippingAmount, totalAmount },
        displayedAmounts,
      )
    ) {
      await logAudit({
        action: "checkout.session.create",
        outcome: "failure",
        detail:
          "Displayed checkout amounts do not match server-calculated amounts",
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          displayed_amounts: displayedAmounts,
          server_amounts: {
            subtotalAmount,
            taxAmount,
            shippingAmount,
            totalAmount,
          },
        },
      });
      return NextResponse.json(
        {
          error: "checkout_amount_mismatch",
          message:
            "表示金額と請求金額が一致しません。画面を再読み込みして再度お試しください。",
        },
        { status: 409 },
      );
    }

    if (!Number.isInteger(totalAmount) || totalAmount <= 0) {
      return NextResponse.json(
        { error: "Invalid total amount" },
        { status: 400 },
      );
    }

    const stripe = getStripeServerClient();

    // 受け付け済みで支払いの済んだ決済の画面があれば、新しい決済の画面を作らない（設計書 2-5、R-56）。
    // 二重に払わせないため。画面は注文の確定を仕上げて「ご注文は確定しています」を出す。
    const paidCheckoutSessionId = await findPaidCheckoutSession({ supabase, stripe }, sessionId);
    if (paidCheckoutSessionId) {
      const paidBuyer = await buyerOfCheckoutSession(supabase, paidCheckoutSessionId);
      if (paidBuyer === undefined || paidBuyer !== buyerUserId) {
        // 支払いの仕上げが済めば、次の「確認へ進む」でこの画面を拾わなくなる。照合で持ち主は付けない。
        try {
          await reconcileCheckoutSession(paidCheckoutSessionId);
        } catch (reconcileError) {
          console.error("支払い済みの決済の画面を照合できませんでした:", reconcileError);
        }
        try {
          await logAudit({
            action: "checkout.session.create",
            outcome: "failure",
            detail: "支払い済みの決済の画面の買い手が一致しません",
            ip: clientIp,
            user_agent: userAgent,
            metadata: {
              session_id: sessionId, reason: "login_changed",
              // この経路は下書きを取る前なので、今の下書きはまだ無い。
              draft_id: null, buyer_user_id: buyerUserId,
              paid_checkout_session_id: paidCheckoutSessionId, paid_draft_found: paidBuyer !== undefined,
              ...(paidBuyer !== undefined ? { paid_draft_buyer_user_id: paidBuyer } : {}),
            },
          });
        } catch (logAuditError) {
          console.error("買い手が一致しない決済の画面の監査ログを残せませんでした:", logAuditError);
        }
        return applyRotatedCsrfCookie(NextResponse.json({
          error: "login_changed",
          message: "ログインの状態が変わりました。もう一度「確認へ進む」を押してください。",
        }, { status: 409 }), csrfResult);
      }
      return applyRotatedCsrfCookie(orderAlreadyPlacedResponse(paidCheckoutSessionId), csrfResult);
    }

    let promotion: Extract<PromotionCodeCheck, { ok: true }> | null = null;
    if (promotionCode) {
      const checked = await checkPromotionCode(stripe, {
        code: promotionCode,
        preDiscountTotal: totalAmount,
        now: new Date(),
      });
      if (!checked.ok) {
        try {
          await logAudit({
            action: "checkout.session.create",
            outcome: "failure",
            detail: "Promotion code rejected",
            ip: clientIp,
            user_agent: userAgent,
            metadata: { session_id: sessionId, reason: checked.reason },
          });
        } catch (logAuditError) {
          console.error("Failed to log promotion code rejection:", logAuditError);
        }
        return applyRotatedCsrfCookie(
          NextResponse.json(
            {
              error: "promotion_code_invalid",
              reason: checked.reason,
              message: checked.message,
              retryable: false,
            },
            { status: 409 },
          ),
          csrfResult,
        );
      }
      promotion = checked;
    }

    // 最終確認画面の内容を返す前に、同じセッションのほかの決済の画面を閉じる（設計書 2-2・8、決め事 D5）。
    const respondWithConfirmation = async (
      draft: ClaimedCheckoutDraftRow,
      checkoutSessionId: string,
      clientSecret: string,
    ): Promise<NextResponse> => {
      await closeOtherCheckoutSessions(
        {
          supabase,
          stripe,
          reconcile: reconcileCheckoutSession,
          logFailure: async (detail, metadata) => {
            try {
              await logAudit({
                action: "checkout.session.create",
                outcome: "error",
                detail,
                ip: clientIp,
                user_agent: userAgent,
                metadata: { session_id: sessionId, ...metadata },
              });
            } catch (logAuditError) {
              console.error("Failed to log closing other checkout sessions:", logAuditError);
            }
          },
        },
        { cartSessionId: sessionId, keepCheckoutSessionId: checkoutSessionId },
      );
      const confirmation = await buildCheckoutConfirmation(
        { supabase, signImageUrl: (raw) => signItemImageUrl(supabase, raw) },
        {
          checkoutSessionId,
          clientSecret,
          itemsSnapshot: draft.items_snapshot ?? [],
          shippingSnapshot: draft.shipping_snapshot,
          promotionCode: promotion?.code ?? null,
          acceptedOrderId: null,
        },
      );
      return applyRotatedCsrfCookie(NextResponse.json({ confirmation }), csrfResult);
    };

    const shippingSnapshot = buildShippingSnapshot(shipping);
    const itemsSnapshot = canonicalizeItemsSnapshot(
      (cartData as CheckoutCartSnapshotRow[]).map((cartItem) => {
        const item = itemMap.get(cartItem.item_id);

        return {
          source_cart_line_id: cartItem.id,
          item_id: cartItem.item_id,
          item_name: item?.name ?? "商品",
          item_price: item?.price ?? 0,
          item_image_url: item?.image_url ?? null,
          color: cartItem.color,
          size: cartItem.size,
          quantity: cartItem.quantity,
          line_total: (item?.price ?? 0) * cartItem.quantity,
        };
      }),
    );
    const checkoutOrigin = getRequestOrigin(req);
    const requestFingerprint = buildCheckoutRequestFingerprint({
      uiMode,
      origin: checkoutOrigin,
      subtotalAmount,
      taxAmount,
      shippingAmount,
      totalAmount,
      itemsSnapshot,
      shippingSnapshot,
      promotionCodeId: promotion?.promotionCodeId ?? null,
      buyerUserId,
    });

    const claimParams = {
      sessionId,
      buyerUserId,
      cartId,
      requestFingerprint,
      uiMode,
      checkoutOrigin,
      paymentMethod: paymentMethod ?? "stripe_card",
      subtotalAmount,
      taxAmount,
      shippingAmount,
      totalAmount,
      shippingSnapshot,
      itemsSnapshot,
    };
    let createdDraft = await claimCheckoutDraft(claimParams);

    // RPCの原子的claimとStripeの冪等キーの間で応答が失われても、
    // draftに確定済みのSessionを取得して同じものを返す。
    for (
      let recoveryAttempt = 0;
      recoveryAttempt < 2 && createdDraft.checkout_session_id;
      recoveryAttempt += 1
    ) {
      const existingSession = await stripe.checkout.sessions.retrieve(
        createdDraft.checkout_session_id,
      );

      if (
        existingSession.ui_mode &&
        existingSession.ui_mode !== createdDraft.checkout_ui_mode
      ) {
        throw new Error("Claimed Checkout Session UI mode does not match");
      }

      if (existingSession.status === "open" && hasReusableTimeLeft(existingSession)) {
        if (
          createdDraft.checkout_ui_mode === "custom" &&
          existingSession.client_secret
        ) {
          try {
            await logAudit({
              action: "checkout.session.create",
              outcome: "success",
              detail: "Recovered claimed Stripe checkout session (custom UI)",
              ip: clientIp,
              user_agent: userAgent,
              metadata: {
                session_id: sessionId,
                draft_id: createdDraft.id,
                checkout_session_id: existingSession.id,
                ui_mode: "custom",
                reused: true,
              },
            });
          } catch (logAuditError) {
            console.error(
              "Failed to log audit for recovered checkout session:",
              logAuditError,
            );
          }

          return await respondWithConfirmation(
            createdDraft,
            existingSession.id,
            existingSession.client_secret,
          );
        }

        throw new Error(
          "Claimed Checkout Session is open without its required response field",
        );
      }

      if (existingSession.status === "complete") {
        return applyRotatedCsrfCookie(
          orderAlreadyPlacedResponse(existingSession.id),
          csrfResult,
        );
      }

      if (existingSession.status === "open") {
        // 受け付けに要る時間が残らない画面は閉じ、退役させて作り直す（決め事 D4）。
        // 閉じる間に支払いが済むなど状態が変われば、次の回で読み直す。
        if ((await expireOpenCheckoutSession(stripe, existingSession.id)) !== "expired") {
          continue;
        }
      } else if (existingSession.status !== "expired") {
        throw new Error("Claimed Checkout Session has an unknown status");
      }

      const retired = await retireExpiredDraft({
        draftId: createdDraft.id,
        sessionId,
        checkoutSessionId: existingSession.id,
        requestVersion: createdDraft.checkout_request_version,
        requestFingerprint: createdDraft.checkout_request_fingerprint,
      });
      if (!retired) {
        throw new Error("Expired checkout draft retirement conflicted");
      }
      createdDraft = await claimCheckoutDraft(claimParams);
    }

    if (createdDraft.checkout_session_id) {
      throw new Error("Failed to recover the claimed Checkout Session");
    }

    const canonicalItems = createdDraft.items_snapshot ?? [];
    if (canonicalItems.length === 0) {
      throw new Error("Claimed checkout draft has no items");
    }

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
      canonicalItems.map((item) => ({
        price_data: {
          currency: createdDraft.currency,
          product_data: { name: item.item_name },
          unit_amount: item.item_price,
        },
        quantity: item.quantity,
      }));

    if (createdDraft.shipping_amount > 0) {
      lineItems.push({
        price_data: {
          currency: createdDraft.currency,
          product_data: { name: "配送料" },
          unit_amount: createdDraft.shipping_amount,
        },
        quantity: 1,
      });
    }

    if (createdDraft.tax_amount > 0) {
      lineItems.push({
        price_data: {
          currency: createdDraft.currency,
          product_data: { name: "消費税" },
          unit_amount: createdDraft.tax_amount,
        },
        quantity: 1,
      });
    }

    const canonicalLineTotal =
      canonicalItems.reduce(
        (sum, item) => sum + item.item_price * item.quantity,
        0,
      ) +
      createdDraft.shipping_amount +
      createdDraft.tax_amount;
    if (canonicalLineTotal !== createdDraft.total_amount) {
      throw new Error("Claimed checkout draft amount invariant failed");
    }

    const checkoutSessionExpiresAt = await reserveCheckoutSessionExpiry(createdDraft.id);
    const selectedPaymentMethod = createdDraft.payment_method ?? "auto";
    const commonSessionParams = {
      mode: "payment" as const,
      line_items: lineItems,
      client_reference_id: createdDraft.id,
      expires_at: checkoutSessionExpiresAt,
      // 割引はサーバーが確かめたコードだけを付ける。お客様のブラウザからは付けさせない（設計書第3章）
      ...(promotion ? { discounts: [{ promotion_code: promotion.promotionCodeId }] } : {}),
      metadata: {
        draft_id: createdDraft.id,
        session_id: createdDraft.session_id,
        selected_payment_method: selectedPaymentMethod,
        // 最終確認画面と入り直しで、付けたコードを見せる（決め事 D8）
        ...(promotion ? { promotion_code: promotion.code } : {}),
      },
      payment_intent_data: {
        metadata: {
          draft_id: createdDraft.id,
          session_id: createdDraft.session_id,
          selected_payment_method: selectedPaymentMethod,
        },
      },
      customer_email: createdDraft.shipping_snapshot?.email ?? undefined,
      payment_method_options: {
        konbini: { expires_after_days: KONBINI_PAYMENT_DAYS },
      },
    } satisfies Stripe.Checkout.SessionCreateParams;

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      ...commonSessionParams,
      ui_mode: "custom",
    };

    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: checkoutSessionIdempotencyKey(createdDraft.id, checkoutSessionExpiresAt),
    });

    const stored = await storeCheckoutSessionIdOnDraft({
      draftId: createdDraft.id,
      checkoutSessionId: session.id,
      sessionId,
      requestVersion: createdDraft.checkout_request_version,
      requestFingerprint: createdDraft.checkout_request_fingerprint,
      uiMode: createdDraft.checkout_ui_mode,
      ip: clientIp,
      userAgent,
    });

    if (stored !== "stored") {
      if (stored === "conflict") {
        try {
          await expireConflictingOpenSession(stripe, session, createdDraft.id);
        } catch (expireError) {
          console.error(
            "Failed to expire conflicting Stripe checkout session:",
            expireError,
          );
        }
      }

      return applyRotatedCsrfCookie(
        NextResponse.json(
          { error: "Failed to prepare checkout" },
          { status: 500 },
        ),
        csrfResult,
      );
    }

    try {
      await logAudit({
        action: "checkout.session.create",
        outcome: "success",
        detail: "Created Stripe checkout session (custom UI)",
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          draft_id: createdDraft.id,
          checkout_session_id: session.id,
          ui_mode: createdDraft.checkout_ui_mode,
        },
      });
    } catch (logAuditError) {
      console.error(
        "Failed to log audit for created checkout session:",
        logAuditError,
      );
    }

    if (!session.client_secret) {
      return NextResponse.json(
        { error: "Failed to create checkout client secret" },
        { status: 500 },
      );
    }

    return await respondWithConfirmation(createdDraft, session.id, session.client_secret);

  } catch (error) {
    const classified = classifyCheckoutSessionError(error);
    const correlationId = randomUUID();

    const errorDescription = describeUnexpectedError(error);
    console.error("Checkout session creation error:", correlationId, {
      ...errorDescription,
      ...(error instanceof Error ? { stack: error.stack } : {}),
    });
    try {
      await logAudit({
        action: classified.auditAction,
        outcome: "error",
        detail: "Checkout session creation error",
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          correlation_id: correlationId,
          ...errorDescription,
          stripe_type: classified.stripe.type ?? null,
          stripe_code: classified.stripe.code ?? null,
          stripe_status: classified.stripe.statusCode ?? null,
          stripe_request_id: classified.stripe.requestId ?? null,
        },
      });
    } catch (logAuditError) {
      console.error(
        "Failed to log checkout session creation error:",
        logAuditError,
      );
    }

    return NextResponse.json(
      {
        error: "checkout_session_failed",
        message: classified.message,
        correlationId,
        retryable: classified.retryable,
      },
      { status: classified.status },
    );
  }
}
