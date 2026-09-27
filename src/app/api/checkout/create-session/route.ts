import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import Stripe from "stripe";
import { getStripeServerClient } from "@/lib/stripe/server";
import {
  buildInventoryConflictBody,
  collectInventoryIssues,
} from "@/features/cart/services/cart-stock";
import {
  buildShippingSnapshot,
  checkoutShippingSchema,
  hasShippingAddress,
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
  uiMode: z.enum(["hosted", "custom"]).default("hosted"),
  shipping: checkoutShippingSchema,
  displayedAmounts: checkoutDisplayedAmountsSchema,
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
  checkout_ui_mode: "custom" | "hosted";
  checkout_origin: string;
  claim_created: boolean;
};

type CheckoutDraftAttachmentResult = {
  checkout_session_id: string;
  attached: boolean;
};

const CHECKOUT_REQUEST_VERSION = 1;

function canonicalizeItemsSnapshot(
  itemsSnapshot: CheckoutDraftItemSnapshot[],
): CheckoutDraftItemSnapshot[] {
  return [...itemsSnapshot].sort((left, right) =>
    [
      left.source_cart_id,
      String(left.item_id),
      left.color ?? "",
      left.size ?? "",
    ]
      .join(":")
      .localeCompare(
        [
          right.source_cart_id,
          String(right.item_id),
          right.color ?? "",
          right.size ?? "",
        ].join(":"),
      ),
  );
}

function buildCheckoutRequestFingerprint(params: {
  uiMode: "custom" | "hosted";
  origin: string;
  subtotalAmount: number;
  taxAmount: number;
  shippingAmount: number;
  totalAmount: number;
  itemsSnapshot: CheckoutDraftItemSnapshot[];
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
  });

  return `v${CHECKOUT_REQUEST_VERSION}:${createHash("sha256").update(canonical).digest("hex")}`;
}

function checkoutSessionIdempotencyKey(draftId: string): string {
  return `checkout-session:create:v${CHECKOUT_REQUEST_VERSION}:${draftId}`;
}

/**
 * 旧互換（request version未設定/v0）Sessionの再利用可否を判定する。
 * 旧Sessionは生成時に支払方法を固定していたため、支払方法・金額・通貨・明細が完全一致する場合だけ再利用する。
 * v1以降はこの関数を通らず、動的支払方法を前提にfingerprint付きclaimへ収束させる。
 */
function isSameCheckoutContent(
  draft: ReusableCheckoutDraftRow,
  current: {
    paymentMethod: string;
    subtotalAmount: number;
    shippingAmount: number;
    totalAmount: number;
    itemsSnapshot: CheckoutDraftItemSnapshot[];
  },
): boolean {
  if (!draft.checkout_session_id) return false;
  if (draft.payment_method !== current.paymentMethod) return false;
  if (draft.subtotal_amount !== current.subtotalAmount) return false;
  if (draft.shipping_amount !== current.shippingAmount) return false;
  if (draft.total_amount !== current.totalAmount) return false;
  if (draft.currency.toLowerCase() !== "jpy") return false;

  const draftItems = draft.items_snapshot ?? [];
  if (draftItems.length !== current.itemsSnapshot.length) return false;

  const signature = (rows: CheckoutDraftItemSnapshot[]) =>
    rows
      .map((row) =>
        [
          row.source_cart_id,
          row.item_id,
          row.item_name,
          row.item_price,
          row.color ?? "",
          row.size ?? "",
          row.quantity,
          row.line_total,
        ].join(":"),
      )
      .sort()
      .join("|");

  return signature(draftItems) === signature(current.itemsSnapshot);
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
// E2E はすべてのリクエストが 127.0.0.1 から来るので、本番の上限では足りない。
// scripts/e2e-server.mjs が起動するサーバーだけ、この倍率で IP 単位の上限を引き上げる。
const CREATE_SESSION_IP_LIMIT_MULTIPLIER_ENV =
  "E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER";
const CREATE_SESSION_IP_LIMIT_MULTIPLIER_MAX = 30;
// 画面（checkout/page.tsx）は message をそのまま表示し、retryable なら「再試行する」を出す。
const RATE_LIMITED_MESSAGE =
  "アクセスが集中しているため、決済の準備を一時的に止めています。少し時間をおいてから「再試行する」を押してください。";

type StoreCheckoutSessionResult = "stored" | "conflict" | "error";

/**
 * Stripe Session ID を、claimしたdraftへCASで確定する。
 *
 * 同じIDの再送は成功として扱い、異なるIDが既に確定していれば上書きしない。
 * RPCエラーは結果不明なので、後続が同じStripe冪等キーで回収できるようSessionを失効しない。
 */
async function storeCheckoutSessionIdOnDraft(params: {
  draftId: string;
  checkoutSessionId: string;
  sessionId: string;
  requestVersion: number;
  requestFingerprint: string;
  uiMode: "custom" | "hosted";
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
  requestFingerprint: string;
  uiMode: "custom" | "hosted";
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
  });

  const draft = (data as ClaimedCheckoutDraftRow[] | null)?.[0];
  if (error || !draft) {
    throw error ?? new Error("Checkout draft claim returned no row");
  }

  return draft;
}

async function fillShippingSnapshotIfEmpty(params: {
  draft: Pick<
    ReusableCheckoutDraftRow,
    "id" | "shipping_snapshot" | "shipping_revision"
  >;
  sessionId: string;
  shippingSnapshot: CheckoutShippingSnapshot;
}): Promise<number> {
  const storedRevision = Number(params.draft.shipping_revision ?? 0);

  if (
    hasShippingAddress(params.draft.shipping_snapshot) ||
    !hasShippingAddress(params.shippingSnapshot)
  ) {
    return storedRevision;
  }

  const { data, error } = await supabase
    .from("checkout_drafts")
    .update({
      shipping_snapshot: params.shippingSnapshot,
      shipping_revision: storedRevision + 1,
    })
    .eq("id", params.draft.id)
    .eq("session_id", params.sessionId)
    .eq("shipping_revision", storedRevision)
    .select("shipping_revision")
    .maybeSingle<{ shipping_revision: number }>();

  if (error) {
    throw error;
  }

  return data ? Number(data.shipping_revision) : storedRevision;
}

/**
 * E2E 用の倍率を決める（FREQ-362）。
 *
 * 引き上げは Vercel 以外（手元の E2E サーバー）でだけ効かせる。E2E は next start で動くので
 * NODE_ENV では区別できない。Vercel に誤って環境変数を設定しても本番の上限は緩めず、
 * 倍率にも上限を設ける。
 */
function resolveCreateSessionIpLimitMultiplier(): number {
  const raw = process.env[CREATE_SESSION_IP_LIMIT_MULTIPLIER_ENV];
  if (process.env.VERCEL === "1" || !raw || !/^[0-9]+$/.test(raw)) {
    return 1;
  }

  return Math.min(
    Math.max(Number(raw), 1),
    CREATE_SESSION_IP_LIMIT_MULTIPLIER_MAX,
  );
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
    const ipLimitMultiplier = resolveCreateSessionIpLimitMultiplier();
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

    const { paymentMethod, shipping, uiMode, displayedAmounts } = parsed.data;

    const { data: cartData, error: cartError } = await supabase
      .from("carts")
      .select("id, item_id, quantity, color, size")
      .eq("session_id", sessionId);

    if (cartError) {
      console.error("Failed to fetch cart for checkout session:", cartError);
      await logAudit({
        action: "checkout.session.create",
        outcome: "error",
        detail: "Failed to fetch cart",
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          error_message: cartError.message ?? null,
        },
      });
      return NextResponse.json(
        { error: "Failed to fetch cart" },
        { status: 500 },
      );
    }

    if (!cartData || cartData.length === 0) {
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
      .in("id", itemIds)
      .eq("status", "published");

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

    const shippingSnapshot = buildShippingSnapshot(shipping);
    const itemsSnapshot = canonicalizeItemsSnapshot(
      (cartData as CheckoutCartSnapshotRow[]).map((cartItem) => {
        const item = itemMap.get(cartItem.item_id);

        return {
          source_cart_id: cartItem.id,
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
    });

    const stripe = getStripeServerClient();

    // 互換期間中の旧draftを先に回収する。Stripe取得に失敗した状態は
    // expired（未入金）とは断定せず、新規Sessionを作らない。
    if (uiMode === "custom") {
      const { data: reusableDraft, error: reusableDraftError } = await supabase
        .from("checkout_drafts")
        .select(
          "id, checkout_session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency, items_snapshot, shipping_snapshot, shipping_revision, checkout_request_version, checkout_request_fingerprint",
        )
        .eq("session_id", sessionId)
        .eq("status", "created")
        .or("checkout_request_version.is.null,checkout_request_version.eq.0")
        .not("checkout_session_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<ReusableCheckoutDraftRow>();

      if (reusableDraftError) {
        throw reusableDraftError;
      }

      if (
        reusableDraft &&
        isSameCheckoutContent(reusableDraft, {
          paymentMethod: paymentMethod ?? "stripe_card",
          subtotalAmount,
          shippingAmount,
          totalAmount,
          itemsSnapshot,
        })
      ) {
        const existingSession = await stripe.checkout.sessions.retrieve(
          reusableDraft.checkout_session_id as string,
        );

        if (existingSession.ui_mode && existingSession.ui_mode !== "custom") {
          // ui_modeを記録していない旧draftでも、Stripeがhostedと返したSessionは
          // custom要求の再利用対象ではない。別の要求IDとして新規claimへ進む。
        } else if (
          existingSession.status === "open" &&
          existingSession.client_secret
        ) {
          let shippingRevision: number;
          try {
            shippingRevision = await fillShippingSnapshotIfEmpty({
              draft: reusableDraft,
              sessionId,
              shippingSnapshot,
            });
          } catch (updateShippingError) {
            console.error(
              "Failed to update shipping snapshot on reuse:",
              updateShippingError,
            );
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
              detail: "Reused Stripe checkout session (custom UI)",
              ip: clientIp,
              user_agent: userAgent,
              metadata: {
                session_id: sessionId,
                draft_id: reusableDraft.id,
                checkout_session_id: existingSession.id,
                ui_mode: "custom",
                reused: true,
              },
            });
          } catch (logAuditError) {
            console.error(
              "Failed to log audit for reused checkout session:",
              logAuditError,
            );
          }

          return applyRotatedCsrfCookie(
            NextResponse.json({
              clientSecret: existingSession.client_secret,
              checkoutSessionId: existingSession.id,
              shippingRevision,
            }),
            csrfResult,
          );
        } else if (existingSession.status === "complete") {
          return applyRotatedCsrfCookie(
            NextResponse.json(
              {
                error: "checkout_session_complete",
                message: "この決済セッションは既に確定処理へ進んでいます。",
                retryable: false,
              },
              { status: 409 },
            ),
            csrfResult,
          );
        } else if (existingSession.status === "expired") {
          const retired = await retireExpiredDraft({
            draftId: reusableDraft.id,
            sessionId,
            checkoutSessionId: existingSession.id,
            requestVersion: reusableDraft.checkout_request_version ?? null,
            requestFingerprint:
              reusableDraft.checkout_request_fingerprint ?? null,
          });
          if (!retired) {
            throw new Error("Expired checkout draft retirement conflicted");
          }
        } else {
          throw new Error(
            "Reusable Checkout Session is open without a client secret",
          );
        }
      }
    }

    const claimParams = {
      sessionId,
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

      if (existingSession.status === "open") {
        if (
          createdDraft.checkout_ui_mode === "custom" &&
          existingSession.client_secret
        ) {
          const shippingRevision = await fillShippingSnapshotIfEmpty({
            draft: createdDraft,
            sessionId,
            shippingSnapshot,
          });

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

          return applyRotatedCsrfCookie(
            NextResponse.json({
              clientSecret: existingSession.client_secret,
              checkoutSessionId: existingSession.id,
              shippingRevision,
            }),
            csrfResult,
          );
        }

        if (createdDraft.checkout_ui_mode === "hosted" && existingSession.url) {
          return applyRotatedCsrfCookie(
            NextResponse.json({ url: existingSession.url }),
            csrfResult,
          );
        }

        throw new Error(
          "Claimed Checkout Session is open without its required response field",
        );
      }

      if (existingSession.status === "complete") {
        return applyRotatedCsrfCookie(
          NextResponse.json(
            {
              error: "checkout_session_complete",
              message: "この決済セッションは既に確定処理へ進んでいます。",
              retryable: false,
            },
            { status: 409 },
          ),
          csrfResult,
        );
      }

      if (existingSession.status !== "expired") {
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

    const selectedPaymentMethod = createdDraft.payment_method ?? "auto";
    const commonSessionParams = {
      mode: "payment" as const,
      line_items: lineItems,
      client_reference_id: createdDraft.id,
      allow_promotion_codes: true,
      metadata: {
        draft_id: createdDraft.id,
        session_id: createdDraft.session_id,
        selected_payment_method: selectedPaymentMethod,
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
        konbini: { expires_after_days: 3 },
      },
    } satisfies Stripe.Checkout.SessionCreateParams;

    const sessionParams: Stripe.Checkout.SessionCreateParams =
      createdDraft.checkout_ui_mode === "custom"
        ? {
            ...commonSessionParams,
            ui_mode: "custom",
          }
        : {
            ...commonSessionParams,
            success_url:
              createdDraft.checkout_origin +
              "/checkout?session_id={CHECKOUT_SESSION_ID}",
            cancel_url: createdDraft.checkout_origin + "/checkout?cancelled=1",
          };

    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: checkoutSessionIdempotencyKey(createdDraft.id),
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

    let shippingRevision = Number(createdDraft.shipping_revision ?? 0);
    if (createdDraft.checkout_ui_mode === "custom") {
      shippingRevision = await fillShippingSnapshotIfEmpty({
        draft: createdDraft,
        sessionId,
        shippingSnapshot,
      });
    }

    try {
      await logAudit({
        action: "checkout.session.create",
        outcome: "success",
        detail:
          createdDraft.checkout_ui_mode === "custom"
            ? "Created Stripe checkout session (custom UI)"
            : "Created Stripe checkout session (hosted)",
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

    if (createdDraft.checkout_ui_mode === "custom") {
      if (!session.client_secret) {
        return NextResponse.json(
          { error: "Failed to create checkout client secret" },
          { status: 500 },
        );
      }

      return applyRotatedCsrfCookie(
        NextResponse.json({
          clientSecret: session.client_secret,
          checkoutSessionId: session.id,
          shippingRevision,
        }),
        csrfResult,
      );
    }

    if (!session.url) {
      return NextResponse.json(
        { error: "Failed to create checkout session" },
        { status: 500 },
      );
    }

    return applyRotatedCsrfCookie(
      NextResponse.json({ url: session.url }),
      csrfResult,
    );
  } catch (error) {
    const classified = classifyCheckoutSessionError(error);
    const correlationId = randomUUID();

    console.error("Checkout session creation error:", correlationId, error);
    try {
      await logAudit({
        action: classified.auditAction,
        outcome: "error",
        detail: "Checkout session creation error",
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          correlation_id: correlationId,
          error_message:
            error instanceof Error ? error.message : "Unknown error",
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
