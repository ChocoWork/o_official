# 1.12 カートページ（CART）詳細設計

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
| CART-01-005 | 在庫チェック（数量超過でエラー） | IMPL-CART-STOCK-01 | `src/app/api/cart/route.ts` | 未実装 | 未 |

### 依存関係

- 在庫管理（SKU 在庫情報）: `items` テーブルベース (実装済み)
- プロモーションサービス: 未実装

---

## データモデル（CART-DATA）

> 元ファイル: `docs/2_Specs/03_cart.md`

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
