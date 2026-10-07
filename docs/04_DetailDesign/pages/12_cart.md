# 1.12 カートページ（CART）詳細設計

> 状態: 既存設計 | 実装状況は項目ごとに要再照合

## 概要

本書は「1.12 カートページ（CART）詳細設計」の既存設計を記録する。要件IDと設計意図を保持しているが、表中の実装状況は現在のコードと一括再照合していない。

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
| FR-CART-002 | カートは `proxy.ts` で生成される `session_id` クッキーに基づき30日間保持されログイン不要の永続カートを実現する | IMPL-CART-002 | `src/proxy.ts`, `src/app/api/cart/route.ts` | `session_id` クッキーベースで proxy が管理 | 済 |
| FR-CART-003 | 数量変更は `Stepper` で可能とし 500ms のデバウンスで `PATCH /api/cart/[id]` を呼び出す | IMPL-CART-003 | `src/app/cart/page.tsx`, `src/app/api/cart/[id]/route.ts` | `scheduleUpdate` で 500ms デバウンス、`inFlight` で二重送信防止、楽観的 UI 更新を実装 | 済 |
| FR-CART-004 | アイテム削除は `DELETE /api/cart/[id]` で実行し削除後にカート件数と画面を更新する | IMPL-CART-004 | `src/app/cart/page.tsx`, `src/app/api/cart/[id]/route.ts` | `DELETE /api/cart/${cartId}` + `setCartItems(filter)` で即時反映 + `updateCartCount()` でバッジ更新。エラー時は `alert()` のみ | 済 |
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
| CART-01-001 | Cart API 実装（GET/POST/PATCH/DELETE） | IMPL-CART-API-01 | `src/app/api/cart/route.ts`, `src/app/api/cart/[id]/route.ts` | 全メソッド実装済み | 済 |
| CART-01-002 | Cookie 永続化（`session_id` ベース、30日TTL） | IMPL-CART-SESSION-01 | `src/proxy.ts` | session_id Cookie で永続カート実装済み | 済 |
| CART-01-003 | `inFlight.current` ref スナップショットパターンで ESLint 警告解消 | IMPL-CART-ESLINT-01 | `src/app/cart/page.tsx` | ref スナップショットパターン適用済み | 済 |
| CART-01-004 | クーポン検証ロジック（サーバ側） | IMPL-CART-COUPON-01 | `src/app/api/cart/coupon/route.ts` | 未実装 | 未 |
| CART-01-005 | 在庫チェック（数量超過でエラー） | IMPL-CART-STOCK-01 | `src/app/api/cart/route.ts`, `src/app/api/cart/[id]/route.ts`, `src/features/cart/services/cart-stock.ts` | 同一 `item_id` の合算数量で `quantity <= stock_quantity` を検証し、非公開商品と在庫不足を 409 で返却 | 済 |

### 依存関係

- 在庫管理（SKU 在庫情報）: `items` テーブルベース (実装済み)
- プロモーションサービス: 未実装

---

## データモデル（CART-DATA）

> 元ファイル: `docs/02_Requirements/03_cart.md`

```sql
carts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  items      jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_carts_session_id ON carts(session_id);
```

### カート TTL

- 30 日間保持。`updated_at` ベースで期限切れ判定。
- クリーンアップジョブで定期削除。

---

## API 仕様（CART-API）

| メソッド | パス | 概要 | NFR |
|---------|------|------|-----|
| GET | `/api/cart` | カートアイテム一覧取得 | P95 < 150ms |
| POST | `/api/cart/add` | 商品をカートに追加 | P95 < 150ms |
| PATCH | `/api/cart/[id]` | 数量更新（500ms デバウンス） | P95 < 150ms |
| DELETE | `/api/cart/[id]` | アイテム削除 | — |
| POST | `/api/cart/coupon` | クーポンコード適用 | — |

---

## クーポン検証設計（CART-COUPON）

- ルール: 1 コード / 1 回使用 / スタッキング不可。
- 検証はサーバ側で実施（クライアントの値を信頼しない）。
- クーポンの計算ロジックはカートサマリー計算時に統合。
- 割引後の合計金額は server-side で再計算してレスポンスに含める。
