import { NextRequest } from "next/server";

// ── NextResponse モック ─────────────────────────────────────────
jest.mock("next/server", () => {
  const original = jest.requireActual("next/server");
  return {
    ...original,
    NextResponse: {
      json: jest.fn((body: unknown, init?: { status?: number }) => ({
        body,
        status: init?.status ?? 200,
      })),
    },
  };
});

const mockEq = jest.fn();
const mockIn = jest.fn();
const mockItemsStatusEq = jest.fn();
const mockSelect = jest.fn().mockReturnThis();
const mockDraftDeleteEq = jest
  .fn()
  .mockResolvedValue({ data: null, error: null });
const mockDraftInsertSingle = jest.fn().mockResolvedValue({
  data: {
    id: "draft-123",
    session_id: "sess-abc",
    total_amount: 5000,
    currency: "jpy",
  },
  error: null,
});
const mockDraftInsert = jest.fn().mockReturnValue({
  select: jest.fn().mockReturnValue({
    single: mockDraftInsertSingle,
  }),
});
const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockFindPaidCheckoutSession = jest.fn();
const mockCloseOtherCheckoutSessions = jest.fn();
jest.mock("@/features/checkout/services/checkout-session-lifecycle.service", () => ({
  findPaidCheckoutSession: (...args: unknown[]) => mockFindPaidCheckoutSession(...args),
  closeOtherCheckoutSessions: (...args: unknown[]) => mockCloseOtherCheckoutSessions(...args),
  reconcileCheckoutSession: jest.fn(),
}));

const mockBuildCheckoutConfirmation = jest.fn();
jest.mock("@/features/checkout/services/checkout-confirmation.service", () => ({
  buildCheckoutConfirmation: (...args: unknown[]) => mockBuildCheckoutConfirmation(...args),
}));

const mockCheckPromotionCode = jest.fn();
jest.mock("@/features/checkout/services/promotion-code.service", () => ({
  ...jest.requireActual("@/features/checkout/services/promotion-code.service"),
  checkPromotionCode: (...args: unknown[]) => mockCheckPromotionCode(...args),
}));

const mockExpireOpenCheckoutSession = jest.fn();
jest.mock("@/lib/stripe/checkout-session-expiry", () => ({
  expireOpenCheckoutSession: (...args: unknown[]) => mockExpireOpenCheckoutSession(...args),
}));

jest.mock("@/lib/storage/item-images", () => ({
  signItemImageUrl: async (_client: unknown, raw: string | null) => raw,
}));

/** 開いている決済の画面の失効時刻（使い回せる残り時間がある） */
function openSessionExpiresAt(remainingSeconds = 1800): number {
  return Math.floor(Date.now() / 1000) + remainingSeconds;
}


let mockClaimResult: { data: unknown; error: unknown } | null = null;
let mockAttachResult: { data: unknown; error: unknown } | null = null;
let mockRetireResult: { data: unknown; error: unknown } = {
  data: true,
  error: null,
};
const RESERVED_EXPIRES_AT = 1_790_001_830;
let mockReserveExpiryResult: { data: unknown; error: { message: string } | null } = {
  data: RESERVED_EXPIRES_AT,
  error: null,
};

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn().mockReturnValue({ from: mockFrom, rpc: mockRpc }),
}));

const mockEnforceRateLimit = jest.fn();
jest.mock("@/features/auth/middleware/rateLimit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));

const mockRequireCsrfOrDeny = jest.fn();
jest.mock("@/lib/csrfMiddleware", () => ({
  requireCsrfOrDeny: () => mockRequireCsrfOrDeny(),
}));

const mockCreate = jest.fn();
const mockRetrieve = jest.fn();
const mockExpire = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/stripe/server", () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    checkout: {
      sessions: {
        create: mockCreate,
        retrieve: mockRetrieve,
        expire: mockExpire,
      },
    },
  }),
}));

jest.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

import { POST } from "@/app/api/checkout/create-session/route";

function makeRequest(
  body: Record<string, unknown>,
  sessionId = "sess-abc",
): NextRequest {
  const requestBody = {
    // 価格は税込み (taxAmount/shippingAmount は 0、total=subtotal)。
    // calculateCheckoutAmountsFromSubtotal と一致させる。
    displayedAmounts: {
      subtotalAmount: 5000,
      taxAmount: 0,
      shippingAmount: 0,
      totalAmount: 5000,
    },
    ...body,
  };

  const req = new NextRequest("http://localhost/api/checkout/create-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  Object.defineProperty(req, "cookies", {
    value: {
      get: (name: string) =>
        name === "session_id" ? { value: sessionId } : undefined,
    },
  });
  return req;
}

function makeClaimedDraft(
  params: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "draft-123",
    session_id: "sess-abc",
    checkout_session_id: null,
    payment_method: params._payment_method ?? "stripe_card",
    currency: "jpy",
    subtotal_amount: params._subtotal_amount ?? 5000,
    tax_amount: params._tax_amount ?? 0,
    shipping_amount: params._shipping_amount ?? 0,
    total_amount: params._total_amount ?? 5000,
    shipping_snapshot: params._shipping_snapshot ?? null,
    items_snapshot: params._items_snapshot ?? [],
    shipping_revision: 0,
    checkout_request_version: params._request_version ?? 2,
    checkout_request_fingerprint:
      params._request_fingerprint ?? "v2:" + "a".repeat(64),
    checkout_ui_mode: params._checkout_ui_mode ?? "custom",
    checkout_origin: params._checkout_origin ?? "http://localhost:3000",
    claim_created: true,
    ...overrides,
  };
}

describe("POST /api/checkout/create-session", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimResult = null;
    mockAttachResult = null;
    mockRetireResult = { data: true, error: null };
    mockReserveExpiryResult = { data: RESERVED_EXPIRES_AT, error: null };
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockRequireCsrfOrDeny.mockResolvedValue(undefined);
    mockExpire.mockResolvedValue({ id: "cs_test", status: "expired" });
    mockFindPaidCheckoutSession.mockResolvedValue(null);
    mockCloseOtherCheckoutSessions.mockResolvedValue(undefined);
    mockExpireOpenCheckoutSession.mockResolvedValue("expired");
    mockCheckPromotionCode.mockReset();
    mockBuildCheckoutConfirmation.mockImplementation(
      async (_deps: unknown, params: Record<string, unknown>) => ({
        checkoutSessionId: params.checkoutSessionId,
        clientSecret: params.clientSecret,
        shipping: params.shippingSnapshot,
        lines: [],
        promotionCode: params.promotionCode,
      }),
    );
    mockRpc.mockImplementation(
      (functionName: string, params: Record<string, unknown>) => {
        if (functionName === "claim_checkout_draft") {
          if (mockClaimResult) return Promise.resolve(mockClaimResult);
          return Promise.resolve({
            data: [makeClaimedDraft(params)],
            error: null,
          });
        }

        if (functionName === "attach_checkout_session_to_draft") {
          if (mockAttachResult) return Promise.resolve(mockAttachResult);
          return Promise.resolve({
            data: [
              {
                checkout_session_id: params._checkout_session_id,
                attached: true,
              },
            ],
            error: null,
          });
        }

        if (functionName === "retire_expired_checkout_draft") {
          return Promise.resolve(mockRetireResult);
        }

        if (functionName === "reserve_checkout_session_expiry") {
          return Promise.resolve(mockReserveExpiryResult);
        }

        return Promise.resolve({ data: null, error: null });
      },
    );
    mockFrom.mockImplementation((table: string) => {
      if (table === "carts") {
        return {
          select: jest.fn().mockReturnValue({
            eq: mockEq,
          }),
        };
      }

      if (table === "items") {
        return {
          select: jest.fn().mockReturnValue({
            in: mockIn,
          }),
        };
      }

      if (table === "checkout_drafts") {
        return {
          insert: mockDraftInsert,
          delete: jest.fn().mockReturnValue({
            eq: mockDraftDeleteEq,
          }),
        };
      }

      return { select: mockSelect, eq: mockEq, in: mockIn };
    });

    mockEq.mockResolvedValue({
      data: [
        { id: "cart-1", item_id: 1, quantity: 1, color: "BLACK", size: "M" },
      ],
      error: null,
    });
    mockIn.mockReturnValue({ eq: mockItemsStatusEq });
    mockItemsStatusEq.mockResolvedValue({
      data: [
        {
          id: 1,
          name: "テスト商品",
          price: 5000,
          image_url: null,
          stock_quantity: 10,
          status: "published",
        },
      ],
      error: null,
    });
  });

  it("payment_method_types を送らない（ダッシュボード設定に従う）", async () => {
    mockCreate.mockResolvedValue({ client_secret: "secret", id: "cs_test" });

    const req = makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" });
    const res = (await POST(req)) as unknown as { status: number };

    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params.payment_method_types).toBeUndefined();
    expect(res.status).toBe(200);
  });

  it("コンビニの支払期限を7日で送る（FREQ-106・R-57）", async () => {
    mockCreate.mockResolvedValue({ client_secret: "secret", id: "cs_test" });

    await POST(makeRequest({ uiMode: "custom" }));

    const params = mockCreate.mock.calls[0][0] as {
      payment_method_options?: { konbini?: { expires_after_days?: number } };
    };
    expect(params.payment_method_options?.konbini?.expires_after_days).toBe(7);
  });

  it("hosted モードでは payment_method_types を送らず、konbini の支払期限を7日で送る（FREQ-106・R-57）", async () => {
    mockCreate.mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.com/pay/cs_test",
    });

    const req = makeRequest({ uiMode: "hosted" });
    const res = (await POST(req)) as unknown as { status: number };

    const params = mockCreate.mock.calls[0][0] as {
      payment_method_types?: unknown;
      payment_method_options?: { konbini?: { expires_after_days?: number } };
    };
    expect(params.payment_method_types).toBeUndefined();
    expect(params.payment_method_options?.konbini?.expires_after_days).toBe(7);
    expect(res.status).toBe(200);
  });

  it.each([["custom"], ["hosted"]] as const)(
    "%s は原子的に draft を claim し、draft 固有の Stripe 冪等キーを送る",
    async (uiMode) => {
      mockCreate.mockResolvedValue({
        id: "cs_test",
        status: "open",
        url: "https://checkout.stripe.com/pay/cs_test",
        client_secret: "cs_secret",
      });

      await POST(makeRequest({ uiMode, paymentMethod: "stripe_card" }));

      expect(mockRpc).toHaveBeenCalledWith(
        "claim_checkout_draft",
        expect.objectContaining({
          _session_id: "sess-abc",
          _request_version: 2,
          _request_fingerprint: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
          _checkout_ui_mode: uiMode,
          _checkout_origin: "http://localhost:3000",
          _subtotal_amount: 5000,
          _tax_amount: 0,
          _shipping_amount: 0,
          _total_amount: 5000,
        }),
      );
      expect(mockDraftInsert).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ client_reference_id: "draft-123", expires_at: RESERVED_EXPIRES_AT }),
        { idempotencyKey: "checkout-session:create:v2:draft-123:1790001830" },
      );
      expect(mockRpc).toHaveBeenCalledWith(
        "attach_checkout_session_to_draft",
        expect.objectContaining({
          _draft_id: "draft-123",
          _session_id: "sess-abc",
          _checkout_session_id: "cs_test",
        }),
      );
    },
  );

  it("同じcheckout要求の再送は同じdraftとStripe冪等キーへ収束する", async () => {
    mockCreate.mockResolvedValue({
      id: "cs_test",
      status: "open",
      client_secret: "cs_secret",
    });

    await Promise.all([
      POST(makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" })),
      POST(makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" })),
    ]);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: "checkout-session:create:v2:draft-123:1790001830" },
      { idempotencyKey: "checkout-session:create:v2:draft-123:1790001830" },
    ]);
  });

  it.each([["custom"], ["hosted"]] as const)(
    "claim済みのopen %s Sessionは、残り15分以上ならStripe作成を再実行せず回収する",
    async (uiMode) => {
      mockClaimResult = {
        data: [
          makeClaimedDraft(
            {},
            {
              checkout_session_id: "cs_existing_claim",
              checkout_ui_mode: uiMode,
            },
          ),
        ],
        error: null,
      };
      mockRetrieve.mockResolvedValue({
        id: "cs_existing_claim",
        status: "open",
        expires_at: openSessionExpiresAt(),
        client_secret: "secret_existing_claim",
        url: "https://checkout.stripe.com/pay/cs_existing_claim",
      });

      const res = (await POST(makeRequest({ uiMode }))) as unknown as {
        status: number;
        body: Record<string, unknown>;
      };

      expect(res.status).toBe(200);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
      expect(res.body).toEqual(
        uiMode === "custom"
          ? {
              confirmation: {
                checkoutSessionId: "cs_existing_claim",
                clientSecret: "secret_existing_claim",
                shipping: null,
                lines: [],
                promotionCode: null,
              },
            }
          : { url: "https://checkout.stripe.com/pay/cs_existing_claim" },
      );
    },
  );

  it("claim済みSessionの取得結果が不明なら新規Sessionを作らず退役もしない", async () => {
    mockClaimResult = {
      data: [
        makeClaimedDraft({}, { checkout_session_id: "cs_existing_claim" }),
      ],
      error: null,
    };
    mockRetrieve.mockRejectedValueOnce(new Error("resource_missing"));

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      status: number;
    };

    expect(res.status).toBe(500);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith(
      "retire_expired_checkout_draft",
      expect.anything(),
    );
  });

  it("異なるStripe Session IDとのCAS競合では後発のopen Sessionを失効する", async () => {
    mockCreate.mockResolvedValue({
      id: "cs_orphan",
      status: "open",
      client_secret: "cs_secret",
    });
    mockAttachResult = { data: [], error: null };

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      status: number;
    };

    expect(res.status).toBe(500);
    expect(mockExpire).toHaveBeenCalledWith(
      "cs_orphan",
      {},
      {
        idempotencyKey: "checkout-session:expire-orphan:v2:draft-123:cs_orphan",
      },
    );
  });

  /**
   * 下書きに決済セッション ID を書けなかったら、そのまま進めない（FREQ-397）。
   *
   * 書けないと次が起きる。どれも画面には成功に見えるので、握りつぶすと気づけない。
   * - 「注文する」の受け付け（place-order）と入り直し（resume）は、下書きの checkout_session_id が
   *   この決済の画面と一致することを確かめるため、客は注文できず、最終確認画面にも戻れない
   * - 再利用の判定から外れ、画面を開くたびに Stripe セッションが増える
   * まだ支払いは発生していないので、500 を返して作り直させるのが安全側。
   */
  it.each([["custom"], ["hosted"]] as const)(
    "%s で決済セッション ID の書き戻しに失敗したら 500 を返す",
    async (uiMode) => {
      mockCreate.mockResolvedValue({
        id: "cs_test",
        url: "https://checkout.stripe.com/pay/cs_test",
        client_secret: "cs_secret",
      });
      mockAttachResult = { data: null, error: { message: "update failed" } };

      const res = (await POST(makeRequest({ uiMode }))) as unknown as {
        status: number;
      };

      expect(res.status).toBe(500);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "checkout.session.create",
          outcome: "error",
          detail: "Failed to store checkout session id on draft",
        }),
      );
      expect(mockExpire).not.toHaveBeenCalled();
    },
  );

  // FREQ-401: 在庫の有無は納期を分けるだけ。足りなければ受注生産として受けるので止めない。
  it("在庫が足りなくても受け付ける（受注生産として受ける）", async () => {
    mockCreate.mockResolvedValue({ client_secret: "secret", id: "cs_test" });
    mockEq.mockResolvedValue({
      data: [{ item_id: 1, quantity: 2, color: "BLACK", size: "M" }],
      error: null,
    });
    mockItemsStatusEq.mockResolvedValue({
      data: [
        {
          id: 1,
          name: "テスト商品",
          price: 5000,
          image_url: null,
          status: "published",
        },
      ],
      error: null,
    });

    // 数量2なので表示金額もその分（金額の照合は在庫とは別の検査）
    const req = makeRequest({
      paymentMethod: "stripe_card",
      uiMode: "custom",
      displayedAmounts: {
        subtotalAmount: 10000,
        taxAmount: 0,
        shippingAmount: 0,
        totalAmount: 10000,
      },
    });
    const res = await POST(req);

    expect((res as { status: number }).status).toBe(200);
  });

  it("非公開・存在しない商品は 409 で断る", async () => {
    mockEq.mockResolvedValue({
      data: [{ item_id: 1, quantity: 1, color: "BLACK", size: "M" }],
      error: null,
    });
    mockItemsStatusEq.mockResolvedValue({ data: [], error: null });

    const req = makeRequest({ paymentMethod: "stripe_card", uiMode: "custom" });
    const res = await POST(req);

    expect((res as { status: number }).status).toBe(409);
    expect((res as unknown as { body: { error: string } }).body.error).toBe(
      "out_of_stock",
    );
  });

  it("items 取得時に status=published を必須化する", async () => {
    mockCreate.mockResolvedValue({ client_secret: "secret", id: "cs_test" });

    const req = makeRequest({ uiMode: "custom" });
    const res = await POST(req);

    expect(mockIn).toHaveBeenCalledWith("id", [1]);
    expect(mockItemsStatusEq).toHaveBeenCalledWith("status", "published");
    expect((res as { status: number }).status).toBe(200);
  });

  it("shipping.phone が不正な形式の場合は 400 を返す", async () => {
    const req = makeRequest({
      uiMode: "custom",
      shipping: {
        phone: "abc###",
      },
    });

    const res = await POST(req);

    expect((res as { status: number }).status).toBe(400);
    expect((res as unknown as { body: { error: string } }).body.error).toBe(
      "Invalid request body",
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("失効時刻を下書きに決められなければ Session を作らない", async () => {
    mockReserveExpiryResult = { data: null, error: { message: "CHECKOUT_DRAFT_NOT_RESERVABLE" } };

    const res = (await POST(
      makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" }),
    )) as unknown as { status: number };

    expect(res.status).toBe(500);
    expect(mockCreate).not.toHaveBeenCalled();
  });
  // 決め事 D4: 決済の画面は「確認へ進む」の時点の入力の写し。申告の支払方法は指紋に入れない
  it("申告の支払方法が違っても同じ指紋、配送先が違えば別の指紋になる", async () => {
    mockCreate.mockResolvedValue({ id: "cs_test", status: "open", client_secret: "cs_secret" });
    const shipping = {
      email: "a@example.com",
      fullName: "山田 花子",
      kanaName: "ヤマダ ハナコ",
      postalCode: "1500001",
      prefecture: "東京都",
      city: "渋谷区",
      address: "神宮前1-1-1",
      phone: "0311112222",
    };

    await POST(makeRequest({ uiMode: "custom", paymentMethod: "stripe_card", shipping }));
    await POST(makeRequest({ uiMode: "custom", paymentMethod: "stripe_paypay", shipping }));
    await POST(
      makeRequest({ uiMode: "custom", paymentMethod: "stripe_card", shipping: { ...shipping, address: "神宮前2-2-2" } }),
    );

    const fingerprints = mockRpc.mock.calls
      .filter(([functionName]) => functionName === "claim_checkout_draft")
      .map(([, params]) => (params as Record<string, unknown>)._request_fingerprint);
    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(fingerprints[2]).not.toBe(fingerprints[0]);
  });

  it.each([["custom"], ["hosted"]] as const)(
    "%s でも allow_promotion_codes を送らない（割引はサーバーが付ける）",
    async (uiMode) => {
      mockCreate.mockResolvedValue({
        id: "cs_test",
        url: "https://checkout.stripe.com/pay/cs_test",
        client_secret: "cs_secret",
      });

      await POST(makeRequest({ uiMode }));

      const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(params.allow_promotion_codes).toBeUndefined();
      expect(params.discounts).toBeUndefined();
    },
  );

  it("割引コードはサーバーの割引前の合計で確かめ、discounts で付け、metadata にコードを残す", async () => {
    mockCheckPromotionCode.mockResolvedValue({
      ok: true,
      promotionCodeId: "promo_1",
      code: "WELCOME10",
      discountAmount: 500,
      totalAfterDiscount: 4500,
    });
    mockCreate.mockResolvedValue({ id: "cs_new", status: "open", client_secret: "secret_new" });

    const res = (await POST(makeRequest({ uiMode: "custom", promotionCode: "welcome10" }))) as unknown as {
      status: number;
      body: { confirmation: Record<string, unknown> };
    };

    expect(mockCheckPromotionCode).toHaveBeenCalledWith(expect.anything(), {
      code: "welcome10",
      preDiscountTotal: 5000,
      now: expect.any(Date),
    });
    const params = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params.discounts).toEqual([{ promotion_code: "promo_1" }]);
    expect(params.metadata).toEqual(expect.objectContaining({ promotion_code: "WELCOME10" }));
    expect(res.status).toBe(200);
    expect(res.body.confirmation.promotionCode).toBe("WELCOME10");
  });

  it("割引コードが違えば別の指紋になる（同じ下書き・同じ決済の画面を使い回さない）", async () => {
    mockCheckPromotionCode.mockResolvedValue({
      ok: true,
      promotionCodeId: "promo_1",
      code: "WELCOME10",
      discountAmount: 500,
      totalAfterDiscount: 4500,
    });
    mockCreate.mockResolvedValue({ id: "cs_new", status: "open", client_secret: "secret_new" });

    await POST(makeRequest({ uiMode: "custom" }));
    await POST(makeRequest({ uiMode: "custom", promotionCode: "WELCOME10" }));

    const fingerprints = mockRpc.mock.calls
      .filter(([functionName]) => functionName === "claim_checkout_draft")
      .map(([, params]) => (params as Record<string, unknown>)._request_fingerprint);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });

  it("割引コードが使えなくなっていれば 409 で理由を返し、下書きも決済の画面も作らない", async () => {
    mockCheckPromotionCode.mockResolvedValue({
      ok: false,
      reason: "minimum_amount",
      message: "このコードは ¥10,000 以上のご注文で使えます",
    });

    const res = (await POST(makeRequest({ uiMode: "custom", promotionCode: "MIN10000" }))) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "promotion_code_invalid",
      reason: "minimum_amount",
      message: "このコードは ¥10,000 以上のご注文で使えます",
      retryable: false,
    });
    expect(mockRpc).not.toHaveBeenCalledWith("claim_checkout_draft", expect.anything());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("受け付け済みで支払いの済んだ決済の画面があれば、作らずに 409 order_already_placed", async () => {
    mockFindPaidCheckoutSession.mockResolvedValue("cs_paid");

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(mockFindPaidCheckoutSession).toHaveBeenCalledWith(expect.anything(), "sess-abc");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "order_already_placed",
      checkoutSessionId: "cs_paid",
      message: "ご注文は確定しています。",
      retryable: false,
    });
    expect(mockRpc).not.toHaveBeenCalledWith("claim_checkout_draft", expect.anything());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("claim した下書きの決済の画面が complete なら 409 order_already_placed（やり直せない 409 は返さない）", async () => {
    mockRpc.mockImplementationOnce(async () => ({
      data: [makeClaimedDraft({}, { checkout_session_id: "cs_done" })],
      error: null,
    }));
    mockRetrieve.mockResolvedValue({ id: "cs_done", status: "complete" });

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "order_already_placed", checkoutSessionId: "cs_done" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("claim した下書きの決済の画面が残り15分未満なら、閉じて退役させ、新しい決済の画面を作る", async () => {
    mockRpc.mockImplementationOnce(async () => ({
      data: [makeClaimedDraft({}, { checkout_session_id: "cs_old" })],
      error: null,
    }));
    mockRetrieve.mockResolvedValue({
      id: "cs_old",
      status: "open",
      expires_at: openSessionExpiresAt(14 * 60),
      client_secret: "secret_old",
    });
    mockCreate.mockResolvedValue({ id: "cs_new", status: "open", client_secret: "secret_new" });

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      status: number;
      body: { confirmation: Record<string, unknown> };
    };

    expect(mockExpireOpenCheckoutSession).toHaveBeenCalledWith(expect.anything(), "cs_old");
    expect(mockRpc).toHaveBeenCalledWith(
      "retire_expired_checkout_draft",
      expect.objectContaining({ _checkout_session_id: "cs_old" }),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body.confirmation).toMatchObject({ checkoutSessionId: "cs_new", clientSecret: "secret_new" });
  });

  it("claim した下書きの決済の画面が expired なら、閉じずに退役させて作り直す", async () => {
    mockRpc.mockImplementationOnce(async () => ({
      data: [makeClaimedDraft({}, { checkout_session_id: "cs_expired" })],
      error: null,
    }));
    mockRetrieve.mockResolvedValue({ id: "cs_expired", status: "expired" });
    mockCreate.mockResolvedValue({ id: "cs_new", status: "open", client_secret: "secret_new" });

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as { status: number };

    expect(mockExpireOpenCheckoutSession).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith(
      "retire_expired_checkout_draft",
      expect.objectContaining({ _checkout_session_id: "cs_expired" }),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("決済の画面を作ったら、同じセッションのほかの決済の画面を閉じ、下書きから最終確認画面の内容を作って返す", async () => {
    const items = [
      {
        source_cart_id: "cart-1",
        item_id: 1,
        item_name: "テスト商品",
        item_price: 5000,
        item_image_url: null,
        color: "BLACK",
        size: "M",
        quantity: 1,
        line_total: 5000,
      },
    ];
    mockRpc.mockImplementationOnce(async (_name: string, params: Record<string, unknown>) => ({
      data: [makeClaimedDraft(params, { items_snapshot: items })],
      error: null,
    }));
    mockCreate.mockResolvedValue({ id: "cs_new", status: "open", client_secret: "secret_new" });

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(mockCloseOtherCheckoutSessions).toHaveBeenCalledWith(
      expect.objectContaining({ reconcile: expect.any(Function), logFailure: expect.any(Function) }),
      { cartSessionId: "sess-abc", keepCheckoutSessionId: "cs_new" },
    );
    expect(mockBuildCheckoutConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ signImageUrl: expect.any(Function) }),
      expect.objectContaining({
        checkoutSessionId: "cs_new",
        clientSecret: "secret_new",
        itemsSnapshot: items,
        promotionCode: null,
        acceptedOrderId: null,
      }),
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["confirmation"]);
  });
});

// FREQ-362: 決済開始 API の回数制限（IP 単位は二段、セッション単位は1分10回）
describe("POST /api/checkout/create-session - 回数制限", () => {
  const MULTIPLIER_ENV = "E2E_CREATE_SESSION_IP_LIMIT_MULTIPLIER";
  const originalMultiplier = process.env[MULTIPLIER_ENV];
  const originalVercel = process.env.VERCEL;

  function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks は mockResolvedValueOnce で積んだ値を消さない。前のテストの残りを持ち越さないよう作り直す。
    mockEnforceRateLimit.mockReset();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    delete process.env[MULTIPLIER_ENV];
    delete process.env.VERCEL;
  });

  afterEach(() => {
    restoreEnv(MULTIPLIER_ENV, originalMultiplier);
    restoreEnv("VERCEL", originalVercel);
  });

  type LimitOptions = {
    endpoint: unknown;
    limit: unknown;
    windowSeconds: unknown;
    subject: unknown;
  };

  // IP 単位の2つとセッション単位の1つに渡した値を集める。3つ目で止めて、後続の処理には進ませない。
  // request（NextRequest）は比較に含めない。失敗時の差分表示で非推奨の getter が例外を投げ、
  // 本当の失敗理由（上限の値の違い）が読めなくなるため。
  async function rateLimitOptions(): Promise<LimitOptions[]> {
    mockEnforceRateLimit
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: 429 });
    await POST(makeRequest({}));
    return mockEnforceRateLimit.mock.calls.map(([options]) => {
      const { endpoint, limit, windowSeconds, subject } = options as Record<
        string,
        unknown
      >;
      return { endpoint, limit, windowSeconds, subject };
    });
  }

  it("IP 単位は10秒10回と10分60回、セッション単位は1分10回で数える", async () => {
    expect(await rateLimitOptions()).toEqual([
      {
        endpoint: "checkout:create-session:ip-10s",
        limit: 10,
        windowSeconds: 10,
        subject: undefined,
      },
      {
        endpoint: "checkout:create-session:ip-10m",
        limit: 60,
        windowSeconds: 600,
        subject: undefined,
      },
      {
        endpoint: "checkout:create-session",
        limit: 10,
        windowSeconds: 60,
        subject: "sess-abc",
      },
    ]);
  });

  it("E2E サーバーでは倍率で IP 単位の上限だけを引き上げる", async () => {
    process.env[MULTIPLIER_ENV] = "20";

    expect((await rateLimitOptions()).map((options) => options.limit)).toEqual([
      200, 1200, 10,
    ]);
  });

  // Vercel に誤って環境変数を設定しても、本番の上限は緩めない。
  it("Vercel 上では倍率を無視する", async () => {
    process.env[MULTIPLIER_ENV] = "20";
    process.env.VERCEL = "1";

    expect((await rateLimitOptions()).map((options) => options.limit)).toEqual([
      10, 60, 10,
    ]);
  });

  it("倍率は30倍まで", async () => {
    process.env[MULTIPLIER_ENV] = "100";

    expect((await rateLimitOptions()).map((options) => options.limit)).toEqual([
      300, 1800, 10,
    ]);
  });

  it.each(["abc", "0", "1", "2.5", ""])(
    "整数でない値や1以下の値（%p）は無視する",
    async (value) => {
      process.env[MULTIPLIER_ENV] = value;

      expect(
        (await rateLimitOptions()).map((options) => options.limit),
      ).toEqual([10, 60, 10]);
    },
  );

  // 画面は API の message をそのまま表示する。英語の "Too many requests" や
  // 「初期化に失敗しました」ではなく、時間をおいて再試行するよう案内する。
  it.each([
    ["10秒の上限", 0],
    ["10分の上限", 1],
    ["セッション単位の上限", 2],
  ])(
    "%s に達したら、時間をおいて再試行するよう案内する",
    async (_label, blockedCallIndex) => {
      for (let i = 0; i < blockedCallIndex; i++) {
        mockEnforceRateLimit.mockResolvedValueOnce(undefined);
      }
      mockEnforceRateLimit.mockResolvedValueOnce({ status: 429 });

      const res = (await POST(makeRequest({}))) as unknown as {
        status: number;
        body: Record<string, unknown>;
      };

      expect(res.status).toBe(429);
      expect(res.body).toEqual({
        error: "rate_limited",
        message: expect.stringContaining("少し時間をおいてから"),
        retryable: true,
      });
    },
  );

  // 回数制限の仕組み自体が使えない（503）ときは上限到達ではないので、案内文に置き換えない。
  it("回数制限を判定できない（503）ときは、その応答をそのまま返す", async () => {
    const unavailable = { status: 503 };
    mockEnforceRateLimit.mockResolvedValueOnce(unavailable);

    const res = await POST(makeRequest({}));

    expect(res).toBe(unavailable);
  });
});
