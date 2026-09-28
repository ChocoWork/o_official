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
// checkout_drafts.update(...) のチェーン。通常経路（checkout_session_id の書き込み）は .eq() 1 回、
// 再利用経路（住所が空の draft を埋める）は id / session_id / 版番号の 3 回チェーンされる。
// 呼び出し引数をテストで検証できるよう、update と .eq() の引数をすべて記録する。
const mockDraftUpdate = jest.fn();
let draftUpdateEqCalls: unknown[][] = [];
// 更新結果。既定は成功（更新後の版番号を返す）。失敗パスのテストのために書き換え可能にしている。
let mockShippingUpdateResult: { data: unknown; error: unknown } = {
  data: { shipping_revision: 1 },
  error: null,
};
type DraftUpdateChain = {
  eq: (...args: unknown[]) => DraftUpdateChain;
  select: (...args: unknown[]) => DraftUpdateChain;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (onFulfilled?: unknown, onRejected?: unknown) => Promise<unknown>;
};
function makeDraftUpdateChain(): DraftUpdateChain {
  const chain: DraftUpdateChain = {
    eq: (...args: unknown[]) => {
      draftUpdateEqCalls.push(args);
      return chain;
    },
    select: () => chain,
    maybeSingle: () => Promise.resolve(mockShippingUpdateResult),
    then: (onFulfilled?: unknown, onRejected?: unknown) =>
      Promise.resolve(mockShippingUpdateResult).then(
        onFulfilled as never,
        onRejected as never,
      ),
  };
  return chain;
}
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
const mockReusableDraft = jest
  .fn()
  .mockResolvedValue({ data: null, error: null });
// checkout_drafts の旧draft再利用検索チェーン: select().eq(session_id).eq(status).or(identity).not(...).order().limit().maybeSingle()
// BOLA 対策（session_id 絞り込み）とステータス値（'created'）をテストで検証できるよう引数を記録する。
const mockReusableDraftEq1 = jest.fn();
const mockReusableDraftEq2 = jest.fn();
const mockReusableDraftNot = jest.fn();
const mockReusableDraftOr = jest.fn();
const mockFrom = jest.fn();
const mockRpc = jest.fn();

function makeReusableDraftQueryTail() {
  const tail = {
    not: jest.fn((...args: unknown[]) => {
      mockReusableDraftNot(...args);
      return {
        order: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            maybeSingle: mockReusableDraft,
          }),
        }),
      };
    }),
  };

  return {
    ...tail,
    or: jest.fn((...args: unknown[]) => {
      mockReusableDraftOr(...args);
      return tail;
    }),
  };
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
    checkout_request_version: params._request_version ?? 1,
    checkout_request_fingerprint:
      params._request_fingerprint ?? "v1:" + "a".repeat(64),
    checkout_ui_mode: params._checkout_ui_mode ?? "custom",
    checkout_origin: params._checkout_origin ?? "http://localhost:3000",
    claim_created: true,
    ...overrides,
  };
}

describe("POST /api/checkout/create-session", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    draftUpdateEqCalls = [];
    mockShippingUpdateResult = { data: { shipping_revision: 1 }, error: null };
    mockClaimResult = null;
    mockAttachResult = null;
    mockRetireResult = { data: true, error: null };
    mockReserveExpiryResult = { data: RESERVED_EXPIRES_AT, error: null };
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockRequireCsrfOrDeny.mockResolvedValue(undefined);
    mockExpire.mockResolvedValue({ id: "cs_test", status: "expired" });
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
          select: jest.fn().mockReturnValue({
            eq: jest.fn((...args1: unknown[]) => {
              mockReusableDraftEq1(...args1);
              return {
                eq: jest.fn((...args2: unknown[]) => {
                  mockReusableDraftEq2(...args2);
                  return makeReusableDraftQueryTail();
                }),
              };
            }),
          }),
          update: jest.fn((payload: unknown) => {
            mockDraftUpdate(payload);
            return makeDraftUpdateChain();
          }),
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

  it("コンビニの支払期限を3日で送る", async () => {
    mockCreate.mockResolvedValue({ client_secret: "secret", id: "cs_test" });

    await POST(makeRequest({ uiMode: "custom" }));

    const params = mockCreate.mock.calls[0][0] as {
      payment_method_options?: { konbini?: { expires_after_days?: number } };
    };
    expect(params.payment_method_options?.konbini?.expires_after_days).toBe(3);
  });

  it("新規セッションの応答にも配送先の版番号（0）を返す（FREQ-365）", async () => {
    mockCreate.mockResolvedValue({ client_secret: "secret", id: "cs_test" });

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      body: Record<string, unknown>;
    };

    expect(res.body).toMatchObject({ shippingRevision: 0 });
  });

  it("hosted モードでは payment_method_types を送らず、konbini の支払期限を3日で送る", async () => {
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
    expect(params.payment_method_options?.konbini?.expires_after_days).toBe(3);
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
          _request_version: 1,
          _request_fingerprint: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
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
        { idempotencyKey: "checkout-session:create:v1:draft-123:1790001830" },
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
      { idempotencyKey: "checkout-session:create:v1:draft-123:1790001830" },
      { idempotencyKey: "checkout-session:create:v1:draft-123:1790001830" },
    ]);
  });

  it("配送先と申告支払方法が競合しても同じfingerprintとStripeパラメータを使う", async () => {
    const canonicalShipping = {
      email: "winner@example.com",
      fullName: "先行 太郎",
      kanaName: "センコウ タロウ",
      postalCode: "1000001",
      prefecture: "東京都",
      city: "千代田区",
      address: "丸の内1-1-1",
      building: null,
      phone: "09000000000",
    };
    const canonicalItems = [
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
    mockClaimResult = {
      data: [
        makeClaimedDraft(
          {},
          {
            payment_method: "stripe_card",
            shipping_snapshot: canonicalShipping,
            items_snapshot: canonicalItems,
          },
        ),
      ],
      error: null,
    };
    mockCreate.mockResolvedValue({
      id: "cs_test",
      status: "open",
      client_secret: "cs_secret",
    });

    await Promise.all([
      POST(
        makeRequest({
          uiMode: "custom",
          paymentMethod: "stripe_paypay",
          shipping: { ...canonicalShipping, email: "later-a@example.com" },
        }),
      ),
      POST(
        makeRequest({
          uiMode: "custom",
          paymentMethod: "stripe_konbini",
          shipping: { ...canonicalShipping, email: "later-b@example.com" },
        }),
      ),
    ]);

    const claimCalls = mockRpc.mock.calls.filter(
      ([functionName]) => functionName === "claim_checkout_draft",
    );
    const fingerprints = claimCalls.map(
      ([, params]) => (params as Record<string, unknown>)._request_fingerprint,
    );
    expect(new Set(fingerprints).size).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0]).toEqual(mockCreate.mock.calls[1]);
    expect(mockCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        customer_email: "winner@example.com",
        metadata: expect.objectContaining({
          selected_payment_method: "stripe_card",
        }),
      }),
    );
  });

  it.each([["custom"], ["hosted"]] as const)(
    "claim済みのopen %s SessionはStripe作成を再実行せず回収する",
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
        client_secret: "secret_existing_claim",
        url: "https://checkout.stripe.com/pay/cs_existing_claim",
      });

      const res = (await POST(makeRequest({ uiMode }))) as unknown as {
        status: number;
        body: Record<string, unknown>;
      };

      expect(res.status).toBe(200);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(res.body).toEqual(
        uiMode === "custom"
          ? {
              clientSecret: "secret_existing_claim",
              checkoutSessionId: "cs_existing_claim",
              shippingRevision: 0,
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
        idempotencyKey: "checkout-session:expire-orphan:v1:draft-123:cs_orphan",
      },
    );
  });

  /**
   * 生成経路で挙動を分けない（FREQ-397）。
   *
   * プロモーションコードの受け付けが custom 側にしか無いと、hosted（uiMode の既定値）で
   * 作られたセッションだけコードを使えない。割引の扱い自体は確定・webhook が経路を問わず
   * 同じように処理する。
   */
  it("hosted でもプロモーションコードを受け付ける", async () => {
    mockCreate.mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.com/pay/cs_test",
    });

    await POST(makeRequest({ uiMode: "hosted" }));

    const params = mockCreate.mock.calls[0][0] as {
      allow_promotion_codes?: unknown;
    };
    expect(params.allow_promotion_codes).toBe(true);
  });

  /**
   * 下書きに決済セッション ID を書けなかったら、そのまま進めない（FREQ-397）。
   *
   * 書けないと次が起きる。どれも画面には成功に見えるので、握りつぶすと気づけない。
   * - 配送先の保存（update-shipping）は checkout_session_id で下書きを引くため 404 になり、
   *   客は住所を1文字も保存できない
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

  // 既に配送先が入っている draft（別タブで住所を入力済みの状態）。
  const reusableDraftRow = {
    id: "draft-existing",
    checkout_session_id: "cs_existing",
    payment_method: "stripe_card",
    subtotal_amount: 5000,
    shipping_amount: 0,
    total_amount: 5000,
    currency: "jpy",
    shipping_revision: 2,
    shipping_snapshot: {
      email: "saved@example.com",
      fullName: "保存済み太郎",
      postalCode: "1500001",
      prefecture: "東京都",
      city: "渋谷区",
      address: "神宮前1-1-1",
      building: null,
      phone: "0311112222",
    },
    items_snapshot: [
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
    ],
  };

  // 住所がまだ入っていない draft（フォーム未入力のまま開いた直後の状態）。
  const emptyShippingDraftRow = {
    ...reusableDraftRow,
    shipping_revision: 0,
    shipping_snapshot: null,
  };

  it("同一カートの created draft があれば Stripe セッションを再利用する", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "open",
      client_secret: "secret_existing",
    });

    const req = makeRequest({
      uiMode: "custom",
      paymentMethod: "stripe_card",
      shipping: {
        email: "test@example.com",
        fullName: "テスト太郎",
        postalCode: "1000001",
        prefecture: "東京都",
        city: "千代田区",
        address: "丸の内1-1-1",
        phone: "09000000000",
      },
    });
    const res = (await POST(req)) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    // 再利用検索が cookie の session_id と status='created' で絞り込まれていること
    // （BOLA 対策のセッション境界と、実在しない 'pending' を検索していないことの両方を確認する）。
    expect(mockReusableDraftEq1).toHaveBeenCalledWith("session_id", "sess-abc");
    expect(mockReusableDraftEq2).toHaveBeenCalledWith("status", "created");

    expect(mockRetrieve).toHaveBeenCalledWith("cs_existing");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDraftInsert).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    // 画面が条件付き更新に使う版番号を返すこと（FREQ-365）。
    expect(res.body).toEqual({
      clientSecret: "secret_existing",
      checkoutSessionId: "cs_existing",
      shippingRevision: 2,
    });
    expect(mockReusableDraftOr).toHaveBeenCalledWith(
      "checkout_request_version.is.null,checkout_request_version.eq.0",
    );

    // 既に配送先が入っている draft は上書きしない。別タブが入力済みの住所を潰さないため。
    // 今回の入力は、画面が版番号つきで update-shipping を呼んで反映する。
    expect(mockDraftUpdate).not.toHaveBeenCalled();

    // 再利用成功も他の成功系と同様に監査ログへ記録されること。
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "checkout.session.create",
        outcome: "success",
        metadata: expect.objectContaining({
          session_id: "sess-abc",
          draft_id: "draft-existing",
          checkout_session_id: "cs_existing",
          ui_mode: "custom",
        }),
      }),
    );
  });

  it("旧支払方法が異なるSessionは再利用せずv1 claimへ進む", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: { ...reusableDraftRow, payment_method: "stripe_konbini" },
      error: null,
    });
    mockCreate.mockResolvedValue({
      id: "cs_new_card",
      status: "open",
      client_secret: "secret_new_card",
    });

    const res = (await POST(
      makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" }),
    )) as unknown as {
      status: number;
    };

    expect(res.status).toBe(200);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(
      "claim_checkout_draft",
      expect.objectContaining({ _payment_method: "stripe_card" }),
    );
    expect(mockReusableDraftOr).toHaveBeenCalledWith(
      "checkout_request_version.is.null,checkout_request_version.eq.0",
    );
  });

  it("旧hosted Sessionはcustom要求として誤再利用せず、別のrequest identityへ進む", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_legacy_hosted",
      status: "open",
      ui_mode: "hosted",
      url: "https://checkout.stripe.com/pay/cs_legacy_hosted",
      client_secret: null,
    });
    mockCreate.mockResolvedValue({
      id: "cs_new_custom",
      status: "open",
      ui_mode: "custom",
      client_secret: "secret_new_custom",
    });

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRpc).not.toHaveBeenCalledWith(
      "retire_expired_checkout_draft",
      expect.anything(),
    );
  });

  it("カート内容が変わっている created draft は再利用しない", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: { ...reusableDraftRow, total_amount: 9999 },
      error: null,
    });
    mockCreate.mockResolvedValue({ client_secret: "secret_new", id: "cs_new" });

    const req = makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" });
    const res = (await POST(req)) as { status: number };

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("金額は一致していても明細（サイズ）が異なる場合は再利用しない", async () => {
    // 合計金額は draft と同じ（5000）だが、カートの size が draft のスナップショットと異なる。
    // 金額だけの比較では検知できない差分であることを確認する。
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
    mockEq.mockResolvedValue({
      data: [
        { id: "cart-1", item_id: 1, quantity: 1, color: "BLACK", size: "L" },
      ],
      error: null,
    });
    mockCreate.mockResolvedValue({ client_secret: "secret_new", id: "cs_new" });

    const req = makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" });
    const res = (await POST(req)) as { status: number };

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it("旧draftの商品名が現在値と異なる場合は古いSessionを再利用しない", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: {
        ...reusableDraftRow,
        items_snapshot: [
          { ...reusableDraftRow.items_snapshot[0], item_name: "旧商品名" },
        ],
      },
      error: null,
    });
    mockCreate.mockResolvedValue({ client_secret: "secret_new", id: "cs_new" });

    const res = (await POST(
      makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" }),
    )) as unknown as { status: number };

    expect(res.status).toBe(200);
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("shipping_snapshot の更新が失敗したら 500 を返し、Stripe セッションを新規作成しない", async () => {
    // 住所がまだ空の draft（＝今回の配送先で埋める経路）で、書き込みが失敗した場合。
    mockReusableDraft.mockResolvedValueOnce({
      data: emptyShippingDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "open",
      client_secret: "secret_existing",
    });
    mockShippingUpdateResult = {
      data: null,
      error: { message: "update failed" },
    };

    const req = makeRequest({
      uiMode: "custom",
      paymentMethod: "stripe_card",
      shipping: {
        email: "test@example.com",
        fullName: "テスト太郎",
        postalCode: "1000001",
        prefecture: "東京都",
        city: "千代田区",
        address: "丸の内1-1-1",
        phone: "09000000000",
      },
    });
    const res = (await POST(req)) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(mockCreate).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to prepare checkout" });
    // 監査ログも記録されず、既存セッションはそのまま open で残る（新規 draft も作られない）。
    expect(mockLogAudit).not.toHaveBeenCalled();
    expect(mockDraftInsert).not.toHaveBeenCalled();
  });

  it("再利用経路で配送先が全項目空の場合、shipping_snapshot は上書きせず reused の clientSecret を返す（C1）", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: emptyShippingDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "open",
      client_secret: "secret_existing",
    });

    // shipping を渡さない = buildShippingSnapshot はすべて null（別タブがフォーム未入力のまま
    // create-session を叩いたケースを再現）。
    const req = makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" });
    const res = (await POST(req)) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(mockDraftUpdate).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      clientSecret: "secret_existing",
      checkoutSessionId: "cs_existing",
      shippingRevision: 0,
    });
  });

  it("再利用時、draft に住所がまだ無ければ今回の配送先で埋め、版番号を1つ進める（FREQ-365）", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: emptyShippingDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "open",
      client_secret: "secret_existing",
    });

    const req = makeRequest({
      uiMode: "custom",
      paymentMethod: "stripe_card",
      shipping: {
        email: "test@example.com",
        fullName: "テスト太郎",
        postalCode: "1000001",
        prefecture: "東京都",
        city: "千代田区",
        address: "丸の内1-1-1",
        phone: "09000000000",
      },
    });
    const res = (await POST(req)) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(mockDraftUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping_snapshot: expect.objectContaining({ address: "丸の内1-1-1" }),
        shipping_revision: 1,
      }),
    );
    // 他セッションの draft を書き換えないための絞り込みと、版番号の照合。
    expect(draftUpdateEqCalls).toEqual(
      expect.arrayContaining([
        ["id", "draft-existing"],
        ["session_id", "sess-abc"],
        ["shipping_revision", 0],
      ]),
    );
    expect(res.body).toEqual({
      clientSecret: "secret_existing",
      checkoutSessionId: "cs_existing",
      shippingRevision: 1,
    });
  });

  it("再利用時、draft に住所が入っていれば別の住所が送られても上書きしない（FREQ-365）", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "open",
      client_secret: "secret_existing",
    });

    const req = makeRequest({
      uiMode: "custom",
      paymentMethod: "stripe_card",
      shipping: {
        email: "other@example.com",
        fullName: "別タブ太郎",
        postalCode: "0600001",
        prefecture: "北海道",
        city: "札幌市",
        address: "北1条西1-1",
        phone: "0111112222",
      },
    });
    const res = (await POST(req)) as unknown as {
      body: Record<string, unknown>;
    };

    expect(mockDraftUpdate).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      clientSecret: "secret_existing",
      checkoutSessionId: "cs_existing",
      shippingRevision: 2,
    });
    expect(mockReusableDraftOr).toHaveBeenCalledWith(
      "checkout_request_version.is.null,checkout_request_version.eq.0",
    );
  });

  it("logAudit が throw しても再利用レスポンス（clientSecret / checkoutSessionId）が返る", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "open",
      client_secret: "secret_existing",
    });
    mockLogAudit.mockRejectedValueOnce(new Error("audit down"));

    const req = makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" });
    const res = (await POST(req)) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      clientSecret: "secret_existing",
      checkoutSessionId: "cs_existing",
      shippingRevision: 2,
    });
    expect(mockReusableDraftOr).toHaveBeenCalledWith(
      "checkout_request_version.is.null,checkout_request_version.eq.0",
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("既存 Stripe セッションの取得結果が不明なら新規セッションを作らない", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
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

  it("既存 Stripe セッションが complete なら新規セッションを作らない", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "complete",
      payment_status: "unpaid",
      client_secret: "secret_existing",
    });

    const res = (await POST(makeRequest({ uiMode: "custom" }))) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "checkout_session_complete",
      retryable: false,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("既存 Stripe セッションが expired のときだけdraftをCASで退役させて作り直す", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "expired",
      client_secret: "secret_existing",
    });
    mockCreate.mockResolvedValue({ client_secret: "secret_new", id: "cs_new" });

    const req = makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" });
    const res = (await POST(req)) as unknown as {
      status: number;
      body: Record<string, unknown>;
    };

    expect(mockRpc).toHaveBeenCalledWith(
      "retire_expired_checkout_draft",
      expect.objectContaining({
        _draft_id: "draft-existing",
        _session_id: "sess-abc",
        _checkout_session_id: "cs_existing",
      }),
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({
      clientSecret: "secret_new",
      checkoutSessionId: "cs_new",
      shippingRevision: 0,
    });
  });

  it("expiredでも下書き退役CASが競合したら新規Sessionを作らない", async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: reusableDraftRow,
      error: null,
    });
    mockRetrieve.mockResolvedValue({
      id: "cs_existing",
      status: "expired",
      client_secret: "secret_existing",
    });
    mockRetireResult = { data: false, error: null };

    const res = (await POST(
      makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" }),
    )) as unknown as { status: number };

    expect(res.status).toBe(500);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(
      mockRpc.mock.calls.filter(
        ([functionName]) => functionName === "claim_checkout_draft",
      ),
    ).toHaveLength(0);
  });

  it("失効時刻を下書きに決められなければ Session を作らない", async () => {
    mockReserveExpiryResult = { data: null, error: { message: "CHECKOUT_DRAFT_NOT_RESERVABLE" } };

    const res = (await POST(
      makeRequest({ uiMode: "custom", paymentMethod: "stripe_card" }),
    )) as unknown as { status: number };

    expect(res.status).toBe(500);
    expect(mockCreate).not.toHaveBeenCalled();
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
