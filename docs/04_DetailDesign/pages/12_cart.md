# 1.12 カートページ（CART）詳細設計

> 状態: 既存設計 | 実装状況は項目ごとに要再照合

## 概要

本書は「1.12 カートページ（CART）詳細設計」の既存設計を記録する。要件IDと設計意図を保持しているが、表中の実装状況は現在のコードと一括再照合していない。

現在のお届けの目安と在庫の変化の案内は、下の「お届けの目安と受付拒否後の案内（FREQ-417）」を参照する。

## お届けの目安と受付拒否後の案内（FREQ-417）

> FREQ-417 により明細ごとのお届けの目安と、在庫の変化で受付を断られた後の案内・行の印を追加した。下の既存要件表の在庫表示・チェックの記述は作成時点のもの。

| 項目 | 現行の扱い | 根拠 |
| --- | --- | --- |
| お届けの目安 | APIの`fulfillment`が`stock`なら「在庫あり・3〜7営業日で発送」、`backorder`なら「受注生産・数週間〜2か月以上」を明細ごとに出す。在庫数は出さず、値が無いときは目安も出さない | [CartItemRow](../../../src/app/cart/_components/CartItemRow.tsx)、[表示文言](../../../src/features/checkout/utils/fulfillment-labels.ts) |
| 在庫の変化での受付拒否 | 最終確認画面の「注文する」で、在庫ありと見せた明細が受注生産へ変わると、place-orderは409 `stock_changed`を返す。この拒否では注文も在庫の確保も作らず、カートへ戻す | [place-order](../../../src/app/api/checkout/place-order/route.ts)、[購入画面](../../../src/app/checkout/page.tsx)、[CHECKOUT詳細設計](13_checkout.md) |
| カートの案内 | カートの上に「在庫の状況が変わりました。次の商品は受注生産になります（発送まで数週間〜2か月以上）」と、変わった商品名・色・サイズを出す。`checkout:cart-notice`をsessionStorageから1回だけ読み、読んだら消す。空カートでも案内の入れ物を置く | [cart/page.tsx](../../../src/app/cart/page.tsx)、[案内の受け渡し](../../../src/features/checkout/utils/cart-notice.ts) |
| 変わった行の印 | 商品・色・サイズが案内の明細と一致し、現在の`fulfillment`が`stock`でない行に「在庫あり → 受注生産」を出す。数量を減らし在庫ありに戻った行の印は消す。目安が読めない（`null`）行は印を残す | [cart/page.tsx](../../../src/app/cart/page.tsx)、[CartItemRow](../../../src/app/cart/_components/CartItemRow.tsx) |
| ほかの受付拒否 | `price_changed`・`item_unavailable`も、カートの上に案内を1回だけ出す。在庫の変化の行の印は付けない | [購入画面](../../../src/app/checkout/page.tsx)、[案内の受け渡し](../../../src/features/checkout/utils/cart-notice.ts) |

表示の目印は`data-testid="cart-fulfillment"`、`cart-notice`、`cart-stock-changed`。関連テストは[お届けの目安と在庫変化の案内](../../../e2e/FR-CART-022-delivery-estimate-and-stock-notice.spec.ts)。

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-CART-001 | `/cart` ページは `GET /api/cart` からカートアイテムを取得し商品画像・商品名・価格・カラー・サイズ・数量変更 UI を表示する | IMPL-CART-001 | `src/app/cart/page.tsx`, `src/app/api/cart/route.ts` | `useEffect` で `fetch('/api/cart')` 実行、画像/名前/価格/カラー/サイズ/`Stepper` を表示。※ 画像の `<Link href>` がカート UUID を参照するバグが存在（正しくは `item.items.id`） | 済 |
| FR-CART-002 | ゲストは cart Cookie で2週間保持し、会員は会員の ID で持つ | IMPL-CART-002 | `src/features/cart/services/shopping-context.ts`, `src/app/api/cart/route.ts` | session_idとは別の印。ログインで会員のカートへ合わせる（FREQ-428・432） | 済 |
| FR-CART-003 | 数量変更は Stepper で可能とし500msのデバウンスで POST /api/cart/changeを呼ぶ | IMPL-CART-003 | `src/app/cart/_hooks/useCartItems.ts`, `src/app/api/cart/change/route.ts` | 明細keyと数量を送信、楽観的更新・二重送信防止 | 済 |
| FR-CART-004 | POST /api/cart/changeに明細keyと数量0を送り、削除後に件数と画面を更新する | IMPL-CART-004 | `src/app/cart/_hooks/useCartItems.ts`, `src/app/api/cart/change/route.ts` | 即時反映とバッジ更新。失敗はトースト（FREQ-377） | 済 |
| FR-CART-005 | 注文サマリーは小計・配送料（無料表示）・合計を表示し `/checkout` への遷移ボタンを設置する | IMPL-CART-005 | `src/app/cart/page.tsx` | 小計・配送料「無料」・合計・`Button href="/checkout"` を実装。`total = subtotal`（送料0円） | 済 |
| FR-CART-006 | プロモーションコード入力欄と適用ボタンを UI に含む | IMPL-CART-006 | `src/app/cart/page.tsx` | `TextField` + `Button「適用」` の UI を設置。コード検証・割引計算ロジックは未実装（プレースホルダー表示のみ） | 済 |
| FR-CART-007 | カートが空の場合は `EmptyCart` コンポーネントを表示し `/item` への「買い物を続ける」リンクを設ける | IMPL-CART-007 | `src/app/cart/page.tsx`, `src/components/EmptyCart.tsx` | `cartItems.length === 0` 時に `<EmptyCart />` をレンダリング。`/item` リンクあり | 済 |
| FR-CART-008 | `CartContext` は `/api/cart` からカート件数を取得しヘッダーバッジ表示と動的更新をサポートする | IMPL-CART-008 | `src/contexts/CartContext.tsx`, `src/app/api/cart/route.ts` | `useCart()` から `updateCartCount` / `wishlistedItems` / `toggleWishlist` を呼び出し | 済 |
| FR-CART-009 | プロモーションコードのサーバ側バリデーション・割引計算（WONT） | — | — | 「WELCOME10 または SAVE20」のプレースホルダーテキストのみ。現フェーズ対象外 | 未 |
| FR-CART-010 | 各カートアイテム行に「単価 × 数量 = 小計」を明示し注文サマリーに税・送料・割引行を追加する | IMPL-CART-009 | `src/app/cart/page.tsx` | 単価のみ表示。行サブトータル・税/割引行は未表示 | 未 |
| FR-CART-011 | 商品ごとの在庫チェックを組み込み「在庫あり / 売り切れ / 残り○点」を表示しチェックアウト前に在庫不足をバリデーションする | IMPL-CART-010 | `src/app/cart/page.tsx` | 在庫チェック・残数表示は未実装 | 未 |
| FR-CART-012 | 削除ボタン・ウィッシュリストボタンに `aria-label` を付与しカートアイテムリストに `role="list"` を設定する | IMPL-CART-011 | `src/app/cart/page.tsx` | `<Button>` 内にアイコンのみで `aria-label` がない。リストの ARIA role 未設定 | 未 |
| FR-CART-013 | API の取得失敗時に「再試行」ボタンとリロード案内を表示する | IMPL-CART-012 | `src/app/cart/page.tsx` | `error` ステートを赤枠で表示。再試行ボタンは未実装 | 未 |
| FR-CART-014 | モバイルでは `/checkout` ボタンを固定 CTA として設置しカート内容更新時にサマリーを即時再計算する | IMPL-CART-013 | `src/app/cart/page.tsx` | `sticky top-32` のサイドバーはデスクトップのみ。モバイル固定 CTA 未実装。小計はカート更新に連動して即時再計算 | 未 |

---

## 実装タスク管理 (CART-01)

**タスクID**: CART-01
**ステータス**: 一部実装済
**元ファイル**: `docs/tasks/03_cart_ticket.md`

### チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| CART-01-001 | Cart API（GET /api/cart・POST /api/cart/add・POST /api/cart/change） | IMPL-CART-API-01 | `src/app/api/cart/route.ts`, `src/app/api/cart/add/route.ts`, `src/app/api/cart/change/route.ts` | 持ち主とバリアントで読み書きする | 済 |
| CART-01-002 | Cookie 永続化（cart、2週間）と会員の ID による保持 | IMPL-CART-SESSION-01 | `src/features/cart/services/shopping-context.ts` | ログインで会員へ合わせ、ログアウトで端末のCookieを消す | 済 |
| CART-01-003 | `inFlight.current` ref スナップショットパターンで ESLint 警告解消 | IMPL-CART-ESLINT-01 | `src/app/cart/page.tsx` | ref スナップショットパターン適用済み | 済 |
| CART-01-004 | クーポン検証ロジック（サーバ側） | IMPL-CART-COUPON-01 | `src/app/api/cart/coupon/route.ts` | 未実装 | 未 |
| CART-01-005 | 明細の数量・種類の上限と購入可否 | IMPL-CART-STOCK-01 | `src/app/api/cart/add/route.ts`, `src/app/api/cart/change/route.ts`, `src/features/cart/services/cart-stock.ts` | 1明細20個・50種類は422、非公開・取り扱い終了・無いバリアントは404。在庫0は受注生産で追加できる | 済 |

### 依存関係

- 在庫管理（SKU 在庫情報）: `items` テーブルベース (実装済み)
- プロモーションサービス: 未実装

---

## データモデル（CART-DATA）

> 元ファイル: `docs/02_Requirements/03_cart.md`

カートは持ち主（carts）と明細（cart_lines）に分ける。定義と索引・FKは [ER図](../../03_BasicDesign/data/er.md) と [移行 A](../../../supabase/migrations/20261008130000_cart_wishlist_ownership.sql) を参照する。

| 表 | 主な列・決まり |
| --- | --- |
| carts | id UUID、user_idまたはguest_token_hash（SHA-256）のどちらか1つ、created_at・updated_at。会員1人・印1つにつき1行 |
| cart_lines | id UUID（APIのkey）、cart_id、variant_id、quantity（1〜20）、added_at・updated_at。同じcart_id・variant_idは1行 |

### カート TTL と引き継ぎ（FREQ-428・431・432）

- ゲストの `cart` Cookie は256ビット乱数、HttpOnly・SameSite=Lax・Path=/・2週間。書き換えのたびに延長する。session_idは決済の流れだけに使う。
- ゲストのサーバーの分は、最後に使ってから30日を過ぎると毎日の処理で削除する。会員の分は対象外。
- ログインで会員にカートが無ければ付け替え、両方あれば違うバリアントは残し、同じバリアントは大きい方の数量。会員の明細を先に、ゲストの追加順に50種類まで残す。
- 合わせるのに失敗してもログインは止めず、印を残し、次のカート・お気に入り・決済の読み出しで再試行する。ログアウトは端末のcart・wishlist Cookieを消す。会員の分は次のログインで戻る。

---

## API 仕様（CART-API）

| メソッド | パス | 概要 | NFR |
|---------|------|------|-----|
| GET | `/api/cart` | カート全体（item_count・items・円の合計、tokenなし） | P95 < 150ms |
| POST | `/api/cart/add` | `{items:[{id:variantId,quantity}]}`、同じバリアントは加算、追加後の明細を返す | P95 < 150ms |
| POST | `/api/cart/change` | `{id:明細key,quantity}`（0で削除）、カート全体を返す | P95 < 150ms |
| POST | `/api/cart/coupon` | クーポンコード適用 | — |

カート3窓口の認可は cart Cookie または会員（会員の書き換えにはCSRFが必須）。`/api/cart/coupon` の行は旧構想で、現行の割引コードは決済画面の `/api/checkout/promotion-code` で扱う。

追加・変更の断りは `{status,message:"Cart Error",description}`。422「1つの商品は20個までです。」「カートに入れられるのは50種類までです。」、404「選んだ色・サイズは現在お求めいただけません。」「カートの商品が見つかりません。ページを読み込み直してください。」、400「送った内容を確認できませんでした。」を画面へ出す。根拠: [エラー定義](../../../src/features/cart/services/cart-errors.ts)、[クライアント](../../../src/features/cart/client/cart-api.ts)。

2026-10-08追記（FREQ-430-REQ-05・AC-08）: GETは非公開商品と取り扱い終了バリアントの明細を表示・件数から除く。「確認へ進む」はそれらを持ち主のカートから外し、409 cart_updatedで外した商品を案内する。画面はカートと割引の目安を読み直して押し直せるままにし、残りの商品で最終確認へ進める。根拠: [create-session](../../../src/app/api/checkout/create-session/route.ts)、[購入画面](../../../src/app/checkout/page.tsx)。

---

## クーポン検証設計（CART-COUPON）

- ルール: 1 コード / 1 回使用 / スタッキング不可。
- 検証はサーバ側で実施（クライアントの値を信頼しない）。
- クーポンの計算ロジックはカートサマリー計算時に統合。
- 割引後の合計金額は server-side で再計算してレスポンスに含める。
