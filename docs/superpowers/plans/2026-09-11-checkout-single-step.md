# checkout 1画面化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** checkout の step 1 を「お客様情報・配送先・支払方法」を同時に入力できる1画面にする。

**Architecture:** Stripe の Checkout Session をページ表示時（カート読込完了かつ商品あり）に1回だけ生成し、配送先は既存の `update-shipping` でドラフトだけ更新する。サーバ側は同一カート内容の未完了 draft（status='created'）があれば Stripe セッションを再利用して、表示のたびにセッションと draft 行が増えるのを防ぐ。左列の JSX は「入力フォーム版」「決済版」の二重化を解消して1つにまとめる。

**Tech Stack:** Next.js App Router (Client Component) / React 18 / `@stripe/react-stripe-js` の `CheckoutProvider` + `useCheckout` / Stripe Node SDK / Supabase (service role) / Jest + Testing Library / Playwright

**Spec:** `docs/superpowers/specs/2026-09-11-checkout-single-step-design.md`

## Global Constraints

- コミットしない。ユーザーの明示指示があるまで `git commit` を実行しない（各タスク末尾は「検証」で終える）。
- 作業ブランチは `master`。feature ブランチも PR も作らない。
- E2E は本番ビルド（`npm run build && npm run start`）に対して実行する。dev サーバーが :3000 で動いていると Playwright がそれを再利用するので、実行前に停止する。
- 要求管理ルール: 機能変更には `docs/02_Requirements/requirements.md` のトレーサビリティ行と `e2e/FR-{CATEGORY}-{NNN}-{description}.spec.ts` をセットで追加する。E2E は mobile 390 / tablet 768 / desktop 1280 の3ビューポート。
- ステッパーの2段（`注文を確定する` / `ご注文内容の確認`）と step 2 の確認画面は変更しない。
- 確定ボタンのラベルは既存の `確認へ進む` のまま。`お支払いに進む` は廃止。
- `checkout_drafts` の保持ジョブ（pg_cron）はこの計画のスコープ外。

---

### Task 1: create-session にセッション再利用パスを足す

**Files:**
- Modify: `src/app/api/checkout/create-session/route.ts:279-300`（draft insert の直前に再利用分岐を挿入）
- Test: `tests/unit/api/checkout/create-session-route.test.ts`

**Interfaces:**
- Consumes: 既存の `calculateCheckoutAmountsFromCartRows` の結果（`subtotalAmount` / `shippingAmount` / `totalAmount`）と `itemsSnapshot: CheckoutDraftItemSnapshot[]`
- Produces: 同じレスポンス形（`{ clientSecret: string; checkoutSessionId: string }`）。呼び出し側の変更は不要。再利用時は `checkout_drafts` へ insert せず、Stripe セッションも作らない。

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/api/checkout/create-session-route.test.ts` の `beforeEach` 内 `checkout_drafts` のモックを、再利用検索に対応させる。既存の `mockFrom.mockImplementation` の `checkout_drafts` ブランチを次に置き換える:

```ts
      if (table === 'checkout_drafts') {
        return {
          insert: mockDraftInsert,
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                not: jest.fn().mockReturnValue({
                  order: jest.fn().mockReturnValue({
                    limit: jest.fn().mockReturnValue({
                      maybeSingle: mockReusableDraft,
                    }),
                  }),
                }),
              }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: mockDraftUpdateEq,
          }),
          delete: jest.fn().mockReturnValue({
            eq: mockDraftDeleteEq,
          }),
        };
      }
```

モック宣言をファイル上部（`const mockFrom = jest.fn();` の直前）に追加する:

```ts
const mockReusableDraft = jest.fn().mockResolvedValue({ data: null, error: null });
```

Stripe モックに `retrieve` を足す（`jest.mock('@/lib/stripe/server', ...)` の `sessions` を差し替え）:

```ts
const mockCreate = jest.fn();
const mockRetrieve = jest.fn();
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/stripe/server', () => ({
  getStripeServerClient: jest.fn().mockReturnValue({
    checkout: {
      sessions: {
        create: mockCreate,
        retrieve: mockRetrieve,
      },
    },
  }),
}));
```

`describe` の末尾にテストを3本追加する:

```ts
  const reusableDraftRow = {
    id: 'draft-existing',
    checkout_session_id: 'cs_existing',
    payment_method: 'stripe_card',
    subtotal_amount: 5000,
    shipping_amount: 0,
    total_amount: 5000,
    currency: 'jpy',
    items_snapshot: [
      {
        source_cart_id: 'cart-1',
        item_id: 1,
        item_name: 'テスト商品',
        item_price: 5000,
        item_image_url: null,
        color: 'BLACK',
        size: 'M',
        quantity: 1,
        line_total: 5000,
      },
    ],
  };

  it('同一カートの未完了 draft があれば Stripe セッションを再利用する', async () => {
    mockReusableDraft.mockResolvedValueOnce({ data: reusableDraftRow, error: null });
    mockRetrieve.mockResolvedValue({
      id: 'cs_existing',
      status: 'open',
      client_secret: 'secret_existing',
    });

    const req = makeRequest({ uiMode: 'custom', paymentMethod: 'stripe_card' });
    const res = (await POST(req)) as { status: number; body: Record<string, unknown> };

    expect(mockRetrieve).toHaveBeenCalledWith('cs_existing');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockDraftInsert).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      clientSecret: 'secret_existing',
      checkoutSessionId: 'cs_existing',
    });
  });

  it('カート内容が変わっている未完了 draft は再利用しない', async () => {
    mockReusableDraft.mockResolvedValueOnce({
      data: { ...reusableDraftRow, total_amount: 9999 },
      error: null,
    });
    mockCreate.mockResolvedValue({ client_secret: 'secret_new', id: 'cs_new' });

    const req = makeRequest({ uiMode: 'custom', paymentMethod: 'stripe_card' });
    const res = (await POST(req)) as { status: number };

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('既存 Stripe セッションが open でなければ作り直す', async () => {
    mockReusableDraft.mockResolvedValueOnce({ data: reusableDraftRow, error: null });
    mockRetrieve.mockResolvedValue({
      id: 'cs_existing',
      status: 'expired',
      client_secret: 'secret_existing',
    });
    mockCreate.mockResolvedValue({ client_secret: 'secret_new', id: 'cs_new' });

    const req = makeRequest({ uiMode: 'custom', paymentMethod: 'stripe_card' });
    const res = (await POST(req)) as { status: number; body: Record<string, unknown> };

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ clientSecret: 'secret_new', checkoutSessionId: 'cs_new' });
  });
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `npx jest tests/unit/api/checkout/create-session-route.test.ts -t 再利用`
Expected: FAIL（`mockCreate` が呼ばれてしまう／`mockRetrieve` が呼ばれない）

- [ ] **Step 3: 再利用パスを実装する**

`src/app/api/checkout/create-session/route.ts` の `const stripe = getStripeServerClient();` より後、`const { data: createdDraft, ... } = await supabase.from('checkout_drafts').insert(...)` の直前に挿入する:

```ts
    // 同一カート内容の未完了 draft（status='created'）があれば Stripe セッションを作り直さず再利用する。
    // （checkout 表示のたびに draft 行と Stripe セッションが増えるのを防ぐ）
    if (uiMode === 'custom') {
      const { data: reusableDraft } = await supabase
        .from('checkout_drafts')
        .select(
          'id, checkout_session_id, payment_method, subtotal_amount, shipping_amount, total_amount, currency, items_snapshot'
        )
        .eq('session_id', sessionId)
        .eq('status', 'created')
        .not('checkout_session_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<ReusableCheckoutDraftRow>();

      if (reusableDraft && isSameCheckoutContent(reusableDraft, {
        paymentMethod: paymentMethod ?? 'stripe_card',
        subtotalAmount,
        shippingAmount,
        totalAmount,
        itemsSnapshot,
      })) {
        try {
          const existingSession = await stripe.checkout.sessions.retrieve(
            reusableDraft.checkout_session_id as string
          );

          if (existingSession.status === 'open' && existingSession.client_secret) {
            return applyRotatedCsrfCookie(
              NextResponse.json({
                clientSecret: existingSession.client_secret,
                checkoutSessionId: existingSession.id,
              }),
              csrfResult
            );
          }
        } catch (retrieveError) {
          console.error('Failed to retrieve reusable checkout session:', retrieveError);
        }
      }
    }
```

同ファイルのトップレベル（`buildShippingSnapshot` の下）に型と比較関数を追加する:

```ts
type ReusableCheckoutDraftRow = {
  id: string;
  checkout_session_id: string | null;
  payment_method: string | null;
  subtotal_amount: number;
  shipping_amount: number;
  total_amount: number;
  currency: string;
  items_snapshot: CheckoutDraftItemSnapshot[] | null;
};

/** 再利用可否の判定キー。金額・通貨・支払方法・明細（商品/色/サイズ/数量）が完全一致するときだけ再利用する。 */
function isSameCheckoutContent(
  draft: ReusableCheckoutDraftRow,
  current: {
    paymentMethod: string;
    subtotalAmount: number;
    shippingAmount: number;
    totalAmount: number;
    itemsSnapshot: CheckoutDraftItemSnapshot[];
  }
): boolean {
  if (!draft.checkout_session_id) return false;
  if ((draft.payment_method ?? 'stripe_card') !== current.paymentMethod) return false;
  if (draft.subtotal_amount !== current.subtotalAmount) return false;
  if (draft.shipping_amount !== current.shippingAmount) return false;
  if (draft.total_amount !== current.totalAmount) return false;
  if (draft.currency.toLowerCase() !== 'jpy') return false;

  const draftItems = draft.items_snapshot ?? [];
  if (draftItems.length !== current.itemsSnapshot.length) return false;

  const signature = (rows: CheckoutDraftItemSnapshot[]) =>
    rows
      .map((row) => [row.item_id, row.color ?? '', row.size ?? '', row.quantity, row.line_total].join(':'))
      .sort()
      .join('|');

  return signature(draftItems) === signature(current.itemsSnapshot);
}
```

`CheckoutDraftItemSnapshot` が未 import ならファイル冒頭の `@/features/checkout/services/checkout-draft.service` からの import に追加する。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx jest tests/unit/api/checkout/create-session-route.test.ts`
Expected: PASS（既存テストも含め全件）

---

### Task 2: セッション生成をページ表示時に移す

**Files:**
- Modify: `src/app/checkout/page.tsx:266`（`paymentReady` state 削除）
- Modify: `src/app/checkout/page.tsx:693-726`（自動遷移 effect とセッション生成 effect を差し替え）
- Modify: `src/app/checkout/page.tsx:918-941`（`handleProceedToPayment` / `handleEditShipping` 削除）

**Interfaces:**
- Consumes: Task 1 の `create-session`（レスポンス形は不変）
- Produces: `customCheckoutClientSecret` が「カート読込完了かつ商品あり」で自動的に埋まる状態。Task 3 の描画はこれを前提にする。

- [ ] **Step 1: `paymentReady` を削除する**

`src/app/checkout/page.tsx:266` の行を削除:

```ts
  const [paymentReady, setPaymentReady] = useState(false);
```

- [ ] **Step 2: 2つの effect を1つに置き換える**

「保存済み配送先 + プロフィール連絡先が揃えば自動的に決済へ進める」effect（`:693` 付近）と「配送先確定後に Stripe セッションを生成」effect（`:716-726`）の両方を削除し、次に置き換える:

```ts
  // StrictMode の二重実行と再レンダリングによる多重生成を止めるためのガード
  const sessionRequestStartedRef = React.useRef(false);

  // カートが確定した時点で決済セッションを1回だけ生成する（配送先は空でよい）。
  // 住所は後から /api/checkout/update-shipping でドラフトへ反映する。
  React.useEffect(() => {
    if (step !== 1) return;
    if (cartLoading) return;
    if (cartItems.length === 0) return;
    if (customCheckoutClientSecret) return;
    if (sessionRequestStartedRef.current) return;

    sessionRequestStartedRef.current = true;
    void createCustomCheckoutSession();
  }, [
    step,
    cartLoading,
    cartItems.length,
    customCheckoutClientSecret,
    createCustomCheckoutSession,
  ]);
```

- [ ] **Step 3: 再試行時にガードを解除できるようにする**

`createCustomCheckoutSession` の `catch` 節（`setCheckoutError(...)` を呼んでいる箇所）の直後に1行足し、失敗時は再試行できるようにする:

```ts
      sessionRequestStartedRef.current = false;
```

`useCallback` の依存配列は変更しない（ref は依存に含めない）。

- [ ] **Step 4: 不要になった関数を削除する**

`handleProceedToPayment`（`:918-933`）と `handleEditShipping`（`:935-941`）を削除する。参照している JSX は Task 3 で消す。

- [ ] **Step 5: 型チェックで参照漏れを洗い出す**

Run: `npx tsc --noEmit`
Expected: `handleProceedToPayment` / `handleEditShipping` / `paymentReady` の未定義参照が JSX 側（`page.tsx` の 1700 行以降）にだけ残る。それ以外のエラーが出たら直す。

---

### Task 3: 左列 JSX を1つに統合する

**Files:**
- Modify: `src/app/checkout/page.tsx:1711-1945`（2系統の描画を単一化）

**Interfaces:**
- Consumes: Task 2 の `customCheckoutClientSecret`
- Produces: `renderCheckoutSections()`（引数なし、`JSX.Element` を返す）。お客様情報・配送先・支払方法・確定ボタンを含む左列全体。Task 4 の確定ボタン変更はこの中の `<ConfirmPaymentButton />` を触る。

- [ ] **Step 1: 左列をまとめる関数を追加する**

`renderAddressFields` の定義直後に追加する。支払方法セクションの中身だけ `customCheckoutClientSecret` で出し分ける:

```tsx
  // 左列（お客様情報 → 配送先 → 支払方法 → 確定）。
  // 決済セッション未取得でも入力欄は描画する（生成失敗・429 でも入力を止めないため）。
  const renderCheckoutSections = () => (
    <div className="order-2 lg:order-1 md:col-span-1 lg:col-span-2 checkout-sections">
      <section className="checkout-section">
        <h3 className="checkout-heading font-brand">お客様情報</h3>
        {renderCustomerInfoSection()}
      </section>

      <section className="checkout-section">
        <h3 className="checkout-heading font-brand">配送先</h3>
        {hasSavedAddress && (
          <SingleSelect
            label="保存済みの配送先"
            variant="dropdown"
            block
            multiline
            value={selectedAddressId}
            onValueChange={handleSelectSavedAddress}
            options={addressOptions}
            size="md"
          />
        )}
        {selectedAddressId === NEW_ADDRESS_VALUE || !hasSavedAddress ? (
          <div className="checkout-box checkout-form">{renderAddressFields()}</div>
        ) : (
          <AddressCard />
        )}
      </section>

      <section className="checkout-section">
        <h3 className="checkout-heading font-brand">支払方法の選択</h3>
        <div className="checkout-box">
          {customCheckoutClientSecret ? (
            <PaymentElement
              options={{
                layout: {
                  type: "accordion",
                  defaultCollapsed: false,
                  radios: "always",
                  spacedAccordionItems: false,
                },
              }}
              onChange={(event) => {
                const selectedType = event.value?.type;
                if (selectedType === "paypay") {
                  setPaymentMethod("stripe_paypay");
                  return;
                }
                if (selectedType === "konbini") {
                  setPaymentMethod("stripe_konbini");
                  return;
                }
                setPaymentMethod("stripe_card");
              }}
            />
          ) : (
            <p style={{ fontSize: "var(--lk-size-sm)", color: "#474747" }}>
              決済フォームを準備しています...
            </p>
          )}
          {checkoutError && (
            <div className="mt-4 space-y-3">
              <p className="lk-text-sm text-red-600">{checkoutError}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setCheckoutError(null);
                  setCustomCheckoutClientSecret(null);
                  setCustomCheckoutSessionId(null);
                  sessionRequestStartedRef.current = false;
                }}
              >
                再試行する
              </Button>
            </div>
          )}
        </div>
      </section>

      {profileSaveError && (
        <p
          className="text-red-600"
          style={{ fontSize: "var(--lk-size-sm)" }}
          role="alert"
        >
          {profileSaveError}
        </p>
      )}

      <div className="flex">
        <ConfirmPaymentButton />
      </div>
    </div>
  );
```

再試行ボタンはガードを解除するだけにする（Task 2 の effect が `clientSecret` が null に戻ったのを見て再生成する）。

- [ ] **Step 2: step 1 の描画を単一化する**

`{step === 1 && customCheckoutClientSecret ? (` から始まる三項演算子（`:1711`）と、その `else` 側にある「STEP 1（配送先入力）」の `<form onSubmit={handleProceedToPayment}>` ブロック、および「STEP 1（セッション準備中）」ブロックを削除し、次に置き換える。step 2 のブロックと右列サマリはそのまま残す:

```tsx
        {step === 1 ? (
          customCheckoutClientSecret ? (
            <CheckoutProvider
              stripe={stripePromise}
              options={{
                clientSecret: customCheckoutClientSecret,
                elementsOptions: { appearance: stripeAppearance },
              }}
            >
              <div className="checkout-grid grid grid-cols-1 md:grid-cols-1 lg:grid-cols-3">
                {renderCheckoutSections()}
                <div className="order-1 lg:order-2 md:col-span-1 lg:col-span-1">
                  <div className="checkout-summary md:sticky md:top-32">
                    <h2 className="checkout-summary-title">ORDER SUMMARY</h2>
                    {cartItems.length === 0 ? (
                      <p
                        className="text-gray-500"
                        style={{ fontSize: "var(--lk-size-sm)" }}
                      >
                        カートに商品がありません
                      </p>
                    ) : (
                      <>
                        <OrderItems />
                        <PromoCodeField />
                        <StripeOrderTotals />
                      </>
                    )}
                  </div>
                </div>
              </div>
            </CheckoutProvider>
          ) : (
            <div className="checkout-grid grid grid-cols-1 md:grid-cols-1 lg:grid-cols-3">
              {renderCheckoutSections()}
              <div className="order-1 lg:order-2 md:col-span-1 lg:col-span-1">
                <div className="checkout-summary md:sticky md:top-32">
                  <h2 className="checkout-summary-title">ORDER SUMMARY</h2>
                  <OrderItems />
                  <CartTotals />
                </div>
              </div>
            </div>
          )
        ) : (
```

`PaymentElement` / `PromoCodeField` / `StripeOrderTotals` は `CheckoutProvider` 配下でしか使えないので、セッション未取得側では既存のローカル金額表示 `CartTotals`（`page.tsx` 内で定義済み、`StripeOrderTotals` と対になるもの）を使う。

- [ ] **Step 2b: step 2 側に残る step 1 用の条件を削除する**

step 2 のブロック（旧 else 側）の右列に残っている次の分岐は、step 1 が上の枝に移ったことで常に false になる。削除する:

```tsx
                    {/* step1(決済準備完了)時は金額をメイン列のStripe表示に委ねる */}
                    {step === 1 && !customCheckoutClientSecret && (
                      <CartTotals />
                    )}
```

同ブロック内の `{step === 2 && (` も常に true になるが、こちらは条件を外して中身だけ残す。

- [ ] **Step 3: 「変更する」ボタンの残骸を消す**

配送先セクションのヘッダにあった `<div className="flex items-center justify-between">` と「変更する」`<Button>`（`handleEditShipping` を呼んでいたもの）が Step 1 の新しいマークアップに含まれていないことを確認する。`handleEditShipping` の参照がファイルから消えていること:

Run: `grep -n "handleEditShipping\|handleProceedToPayment\|paymentReady\|お支払いに進む" src/app/checkout/page.tsx`
Expected: 出力なし

- [ ] **Step 4: 型と lint を通す**

Run: `npx tsc --noEmit && npx next lint --dir src/app/checkout`
Expected: エラーなし

- [ ] **Step 5: 実ブラウザで1画面になっていることを確認する**

dev サーバー（:3000）で `/checkout` を開き、カートに商品がある状態で「お客様情報」「配送先」「支払方法の選択」の3セクションが同時に見えること、ボタンが `確認へ進む` 1つだけであることを目視する。

---

### Task 4: 確定ボタンを未入力でも押せるようにする

**Files:**
- Modify: `src/app/checkout/page.tsx:1129-1207`（`ConfirmPaymentButton`）

**Interfaces:**
- Consumes: `validateShippingForm()`（`Record<string, string>` を返す）、`focusFirstError(errors: Record<string, string>)`、`updateDraftShipping(): Promise<void>`、`persistSavedProfileAndAddress(): Promise<boolean>`
- Produces: 変更なし（`ConfirmPaymentButton` は引数なしのローカルコンポーネントのまま）

- [ ] **Step 1: `updateDraftShipping` が同期後のキーを返すようにする**

`syncedShippingKey` は state なので、`await updateDraftShipping()` の直後でも古い値のままになる。判定に使えるよう、同期後のキーを戻り値にする。

宣言を `const updateDraftShipping = React.useCallback(async (): Promise<string | null> => {` に変え、失敗経路（`if (!response.ok) return;` と `catch` の末尾）を `return null;` にし、成功経路の `setSyncedShippingKey(...)` を次に置き換える:

```ts
      const nextKey = shippingKeyOf({
        email,
        fullName,
        postalCode,
        prefecture,
        city,
        address,
        building,
        phone,
      });
      setSyncedShippingKey(nextKey);
      return nextKey;
```

デバウンス effect 側の `void updateDraftShipping();` は変更不要。

- [ ] **Step 2: `handleConfirmPayment` の先頭に検証と同期を足す**

`const handleConfirmPayment = async () => {` の直後、`if (checkout.type !== "success")` の前に挿入する:

```ts
      const errors = validateShippingForm();
      if (Object.keys(errors).length > 0) {
        focusFirstError(errors);
        return;
      }

      // デバウンス待ちを潰して、確定前に配送先をドラフトへ確実に反映する
      const currentKey = shippingKeyOf(shippingForm);
      if (currentKey !== syncedShippingKey) {
        const nextKey = await updateDraftShipping();
        if (nextKey !== currentKey) {
          setCheckoutError(
            "配送先の反映に失敗しました。少し待ってから再度お試しください。",
          );
          return;
        }
      }
```

- [ ] **Step 3: disabled 条件から住所同期を外す**

`ConfirmPaymentButton` の `disabled` を次に変える。`addressOutOfSync` の計算行も削除する:

```tsx
        disabled={
          customSessionLoading || confirmingPayment || !customCheckoutClientSecret
        }
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし（`addressOutOfSync` の未使用参照が残っていたら消す）

- [ ] **Step 5: 手動で挙動を確認する**

dev サーバーの `/checkout` で、全欄を空のまま `確認へ進む` を押す。氏名欄へフォーカスが移り、画面内にスクロールされること。その後すべて埋めて押すと決済確定に進むこと。

---

### Task 5: 既存 E2E を新しいフローに合わせる

**Files:**
- Modify: `e2e/FR-CHECKOUT-001-payment-element.spec.ts:23`
- Modify: `e2e/FR-CHECKOUT-002-pci-compliance.spec.ts:16`
- Modify: `e2e/FR-CHECKOUT-004-field-validation.spec.ts:21,32,42,59,70`
- Modify: `e2e/FR-CHECKOUT-007-inventory-check.spec.ts:52`
- Modify: `e2e/FR-CHECKOUT-008-error-retry.spec.ts:21,34`
- Modify: `e2e/FR-CHECKOUT-018-required-field-indication.spec.ts:103,123`
- Modify: `e2e/FR-CHECKOUT-019-kana-required.spec.ts:59`

**Interfaces:**
- Consumes: Task 3・4 後の UI（ボタンは `確認へ進む` のみ、支払方法は最初から表示）
- Produces: なし（テストのみ）

- [ ] **Step 1: ボタン名を一括で読み替える**

`お支払いに進む` を `確認へ進む` に置換する。`FR-CHECKOUT-001 / 002 / 008` は「押して決済フォームへ進む」ための操作だったので、**クリック自体を削除**して「到着時点で `PaymentElement` の iframe が出る」前提に変える。例（`FR-CHECKOUT-001`）:

```ts
    await page.goto('/checkout');
    // 1画面化により、遷移操作なしで支払方法が描画される
    await expect(page.frameLocator('iframe[name^="__privateStripeFrame"]').first().locator('body')).toBeVisible();
```

`FR-CHECKOUT-004 / 018 / 019` は「未入力で送信してエラーを出す」テストなので、ボタン名だけ `確認へ進む` に置換する。

- [ ] **Step 2: 在庫テストの前提を直す**

`FR-CHECKOUT-007` は「お支払いに進む押下 → 在庫エラー」だったが、1画面化ではページ到着時にセッション生成が走るので、押下せずにエラーが出る。クリック行を削除し、`await page.goto('/checkout')` の後にそのままエラーメッセージを待つ形にする:

```ts
    await page.goto('/checkout');
    await expect(page.getByText(/在庫/)).toBeVisible();
```

既存のアサーション文言（`buildInventoryConflictBody` が返すメッセージ）に合わせること。文言はテストファイル内の既存 expect をそのまま使う。

- [ ] **Step 3: dev サーバーを止めて本番ビルドで流す**

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

停止を確認してから:

Run: `npx playwright test e2e/FR-CHECKOUT-001 e2e/FR-CHECKOUT-002 e2e/FR-CHECKOUT-004 e2e/FR-CHECKOUT-007 e2e/FR-CHECKOUT-008 e2e/FR-CHECKOUT-018 e2e/FR-CHECKOUT-019`
Expected: PASS。失敗したら CLAUDE.md の切り分け手順（単体再実行 → 他ビューポート確認 → タイムアウトかアサーション不一致かの判別）に従う。

---

### Task 6: 1画面化の要求と新規 E2E を追加する

**Files:**
- Modify: `docs/02_Requirements/requirements.md`（末尾に FREQ-354 を追記）
- Create: `e2e/FR-CHECKOUT-021-single-step-checkout.spec.ts`

**Interfaces:**
- Consumes: Task 1〜4 の実装
- Produces: なし（仕様とテストのみ）

- [ ] **Step 1: spec.md にトレーサビリティ行を追加する**

`docs/02_Requirements/requirements.md` の末尾に1行追記する:

```text
| FREQ-354 | checkout の1段階目を分割せず、お客様情報・配送先・支払方法を1画面で入力できるようにすること（入力と決済の往復をなくす） | FREQ-354-REQ-01 | カート読込完了かつ商品がある時点で決済セッションを1回だけ生成し、配送先が未入力でも支払方法を描画すること。StrictMode の二重実行でも生成は1回に抑えること | FREQ-354-REQ-02 | 「お支払いに進む」ボタンと決済準備の中間画面を廃止し、確定ボタン（確認へ進む）1つにすること。未入力でも押せ、押下時に検証して先頭のエラー欄へフォーカスすること | FREQ-354-REQ-03 | 同一カート内容の 未完了（status='created'）の draft がある場合は Stripe セッションを再利用し、checkout_drafts 行と Stripe セッションを増やさないこと | FREQ-354-AC-01 | mobile（390px）/ tablet（768px）/ desktop（1280px）で、/checkout 到着時に「お客様情報」「配送先」「支払方法の選択」の3見出しが同時に表示されること | FREQ-354-AC-02 | 同3ビューポートで、「お支払いに進む」ボタンが存在しないこと | FREQ-354-AC-03 | 同3ビューポートで、全欄が空のまま確認へ進むを押すと氏名欄にフォーカスが移ること | FREQ-354-AC-04 | 同3ビューポートで、/api/checkout/create-session への POST がページ表示あたり1回だけであること | FREQ-354-AC-05 | 同3ビューポートで、create-session が 429 を返しても入力欄が操作できること |
```

- [ ] **Step 2: 新規 E2E を書く**

`e2e/FR-CHECKOUT-021-single-step-checkout.spec.ts` を作成する:

```ts
import { expect, test, type Page } from "@playwright/test";
import { mockCartApis, sampleCartItem } from "./shop-test-utils";

const VIEWPORTS = [
  { name: "mobile", width: 390 },
  { name: "tablet", width: 768 },
  { name: "desktop", width: 1280 },
];

async function mockCheckoutApis(page: Page, createSessionStatus = 200) {
  await mockCartApis(page, [sampleCartItem()]);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { authenticated: false, user: null } }),
  );
  await page.route("**/api/profile", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/profile/addresses", (route) =>
    route.fulfill({ json: { addresses: [] } }),
  );
  await page.route("**/api/checkout/create-session", (route) =>
    createSessionStatus === 200
      ? route.fulfill({
          json: {
            clientSecret: "cs_test_secret",
            checkoutSessionId: "cs_test_123",
          },
        })
      : route.fulfill({ status: 429, json: { error: "Too many requests" } }),
  );
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}（${viewport.width}px）3セクションが1画面に並ぶ`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await mockCheckoutApis(page);
    await page.goto("/checkout");

    await expect(page.getByRole("heading", { name: "お客様情報" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "配送先" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "支払方法の選択" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "お支払いに進む" }),
    ).toHaveCount(0);
  });

  test(`${viewport.name}（${viewport.width}px）未入力で確定を押すと氏名欄へ移る`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await mockCheckoutApis(page);
    await page.goto("/checkout");

    await page.getByRole("button", { name: "確認へ進む" }).click();

    await expect(page.locator('input[name="fullName"]')).toBeFocused();
  });

  test(`${viewport.name}（${viewport.width}px）セッション生成は1回だけ`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    let createSessionCalls = 0;
    await mockCartApis(page, [sampleCartItem()]);
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ json: { authenticated: false, user: null } }),
    );
    await page.route("**/api/profile", (route) => route.fulfill({ json: {} }));
    await page.route("**/api/profile/addresses", (route) =>
      route.fulfill({ json: { addresses: [] } }),
    );
    await page.route("**/api/checkout/create-session", (route) => {
      createSessionCalls += 1;
      return route.fulfill({
        json: { clientSecret: "cs_test_secret", checkoutSessionId: "cs_test_123" },
      });
    });

    await page.goto("/checkout");
    await expect(page.locator('input[name="fullName"]')).toBeVisible();
    await page.waitForTimeout(1500);

    expect(createSessionCalls).toBe(1);
  });

  test(`${viewport.name}（${viewport.width}px）429 でも入力欄は操作できる`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await mockCheckoutApis(page, 429);
    await page.goto("/checkout");

    const fullName = page.locator('input[name="fullName"]');
    await fullName.fill("山田太郎");
    await expect(fullName).toHaveValue("山田太郎");
  });
}
```

- [ ] **Step 3: 新規 E2E を本番ビルドで流す**

Run: `npx playwright test e2e/FR-CHECKOUT-021`
Expected: PASS（12件 = 4テスト × 3ビューポート）

- [ ] **Step 4: checkout 系をまとめて流して回帰を確認する**

Run: `npx playwright test e2e/FR-CHECKOUT-`
Expected: 既存の赤（`docs` 記載の既知失敗）以外は PASS。新たな赤が出たら CLAUDE.md の切り分け手順に従う。

---

## 完了条件

- `grep -n "お支払いに進む" src e2e` が空
- `npx tsc --noEmit` がエラーなし
- `npx jest tests/unit/api/checkout` が PASS
- `npx playwright test e2e/FR-CHECKOUT-` に新規の赤がない
- `/checkout` 到着時点で3セクションが見え、確定ボタンが1つ
