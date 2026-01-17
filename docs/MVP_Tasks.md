# ECサイト MVP 実装タスク一覧（詳細サブタスク付き）

以下は `doc/ECSiteSpec.md` を元に作成した、公開可能な最小構成（MVP）に必要なタスクを細分化した一覧です。
各タスクは `manage_todo_list` と同期済みで、進捗をステータス管理できます。

---

## Authentication（優先）

1. Supabase クライアント設定 — 見積: 小
   - ファイル: `src/lib/supabaseClient.ts`
   - 説明: Supabase を初期化しエクスポートするユーティリティを作成。env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`。

2. ログイン／登録 UI 統合 — 見積: 中
   - ファイル: `src/app/login/page.tsx`
   - 説明: 登録・ログイン処理を Supabase Auth と繋ぐ。

3. パスワードリセット実装 — 見積: 中
   - ファイル: `src/app/api/auth/password-reset/route.ts`, `src/app/login/reset.tsx`
   - 説明: リセットメール送信とトークン検証フロー。

---

## データベースとデータ準備

4. DB スキーマ設計 & マイグレーション — 見積: 中
   - ファイル: `migrations/` 配下に SQL
   - 説明: `items`/`variants`/`carts`/`cart_items`/`orders`/`order_items` を定義。

5. 開発用シードデータ作成 — 見積: 小
   - ファイル: `scripts/seed.sql`

---

## 商品 API / PDP

6. 商品詳細 API (`GET /api/items/[id]`) — 見積: 中
   - ファイル: `src/app/api/items/[id]/route.ts`

7. 商品一覧 API の検索/フィルタ拡張 — 見積: 中
   - ファイル: `src/app/api/items/route.ts`

8. PDP を API 駆動化（フロント連携） — 見積: 中
   - ファイル: `src/app/item/[id]/page.tsx`

---

## カート

9. carts テーブルとカート CRUD API — 見積: 中
   - ファイル: `src/app/api/cart/route.ts`

10. カートの Cookie / セッション同期ロジック — 見積: 小
   - ファイル: `src/app/components/Cart.tsx`, `src/app/components/CartItem.tsx`

11. カート UI の API 同期 — 見積: 小
   - ファイル: `src/app/components/Cart.tsx`, `CartSummary.tsx`

---

## 決済・注文

12. Stripe 初期化ユーティリティ — 見積: 小
   - ファイル: `src/lib/stripe.ts`

13. 支払い作成 API（PaymentIntent / Checkout） — 見積: 大
   - ファイル: `src/app/api/checkout/create-payment-intent/route.ts`

14. Stripe Webhook と注文保存 — 見積: 中
   - ファイル: `src/app/api/checkout/webhook/route.ts`, `src/app/api/orders/route.ts`

15. 注文確認メール送信（SendGrid） — 見積: 中
   - ファイル: `src/app/api/notifications/email.ts`

---

## アカウント / 管理

16. アカウント：注文履歴表示 — 見積: 中
   - ファイル: `src/app/account/page.tsx`, `src/app/api/orders/route.ts`

17. 管理 API：商品 CRUD（最小） — 見積: 大
   - ファイル: `src/app/api/admin/items/route.ts`

18. 管理 UI：最小商品編集画面 — 見積: 大
   - ファイル: `src/app/admin/page.tsx`

---

## 検索・UI 改善

19. フィルタ状態を URL に反映 — 見積: 中
   - ファイル: `src/app/components/FilterSidebar.tsx`

20. 無限スクロール／ページネーション実装 — 見積: 中
   - ファイル: カテゴリ/一覧ページ

---

## 開発運用 / 品質 / ドキュメント

21. ローカル開発：Stripe CLI & Supabase 設定手順 — 見積: 小
   - ファイル: `README.md`

22. E2E テスト（主要購入フロー） — 見積: 中
   - ファイル: `e2e/`（Playwright 設定）

23. Webhook 署名検証とシークレット管理（セキュリティ） — 見積: 小

24. CI：Lint/Tests ワークフロー追加 — 見積: 小

25. ドキュメント更新（環境変数と起動手順） — 見積: 小

26. 入力検証・CSP などセキュリティチェック — 見積: 小

27. 将来：CSV インポート（低優先） — 見積: 大

---

次のステップ: どのタスクから着手しますか？開始したら該当タスクの `status` を `in-progress` に更新します。
