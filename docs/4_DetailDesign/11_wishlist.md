# 1.11 ウィッシュリストページ（WISHLIST）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-WISHLIST-001 | `/wishlist` ページは `h1` 見出しを含み `WishlistClient` でウィッシュリストアイテムを表示する | IMPL-WISHLIST-001 | `src/app/wishlist/page.tsx`, `src/app/wishlist/client.tsx` | `page.tsx` は RSC で `h1` "Wishlist" を持ち `<WishlistClient />` を内包 | 済 |
| FR-WISHLIST-002 | `WishlistClient` は `/api/wishlist` からデータを取得し読み込み中・エラー・空状態の各 UI を表示する | IMPL-WISHLIST-002 | `src/app/wishlist/client.tsx`, `src/app/api/wishlist/route.ts` | `useEffect` で `fetch('/api/wishlist')` 実行。loading / error / empty の各ブランチ実装済み。エラー時は `alert()` を使用 | 済 |
| FR-WISHLIST-003 | ウィッシュリストカードは商品画像・カテゴリ・商品名・価格を表示し商品詳細ページへ遷移できる | IMPL-WISHLIST-003 | `src/app/wishlist/client.tsx` | `Image` コンポーネントで `image_url`、カテゴリ、商品名、価格、`/item/${item.items.id}` リンクを表示 | 済 |
| FR-WISHLIST-004 | ユーザーはカード上の削除ボタンでアイテムを削除でき削除後に一覧を再レンダリングする | IMPL-WISHLIST-004 | `src/app/wishlist/client.tsx`, `src/app/api/wishlist/[id]/route.ts` | `DELETE /api/wishlist/${wishlistId}` 呼び出し後に `filter` で画面更新。エラー時は `alert()` のみ | 済 |
| FR-WISHLIST-005 | ウィッシュリスト API は GET / POST / DELETE を有し `session_id` に基づいてセッション間で管理する | IMPL-WISHLIST-005 | `src/app/api/wishlist/route.ts`, `src/app/api/wishlist/[id]/route.ts` | `GET` / `DELETE` はクライアントコードで実装済み。`POST` は商品詳細ページから呼び出し。`session_id` クッキーベース | 済 |
| FR-WISHLIST-006 | ウィッシュリストが空の場合は案内テキストと `/item` への継続購入リンクを提供する | IMPL-WISHLIST-006 | `src/app/wishlist/client.tsx` | 「ウィッシュリストは空です」と `Link href="/item"` 「買い物を続ける」を表示 | 済 |
| FR-WISHLIST-007 | 各カードに「カートに追加」ボタンを追加しウィッシュリストから直接購入に移せるようにする | IMPL-WISHLIST-007 | `src/app/wishlist/client.tsx` | 各カードに「カートに追加」ボタンを実装。`POST /api/cart` 成功時に画面メッセージ表示とカート件数更新を行う | 済 |
| FR-WISHLIST-008 | 削除ボタンに `aria-label="ウィッシュリストから削除"` を付与しカードリストに適切な role を設定する | IMPL-WISHLIST-008 | `src/app/wishlist/client.tsx` | 削除ボタンへ `aria-label` を付与し、一覧に `role="list"`、カードに `role="listitem"` を設定 | 済 |
| FR-WISHLIST-009 | 認証連携による永続化・デバイス間同期（WONT） | — | — | 現在は `session_id` クッキーベース。ログイン後の永続化・同期は現フェーズ対象外（WONT） | 対象外 |
| FR-WISHLIST-010 | `item.items` が `null` の場合のフォールバック UI と API レスポンスの型チェックを強化する | IMPL-WISHLIST-009 | `src/app/wishlist/client.tsx`, `src/app/api/wishlist/route.ts` | APIレスポンスのランタイム型チェックを追加し、`item.items === null` 時にフォールバックUIを表示してクラッシュを回避 | 済 |

---

## 実装タスク管理 (MKT-01)

**タスクID**: MKT-01  
**ステータス**: 未着手  
**元ファイル**: `docs/tasks/08_marketing_and_ux_ticket.md`

### チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| MKT-01-001 | プロモーション管理 API（`POST /api/promotions`） | IMPL-MKT-PROMO-01 | `src/app/api/promotions/route.ts` | 未実装 | 未 |

---

## ウィッシュリスト データ設計（WISHLIST-DATA）

| ユーザー種別 | 保存先 | マージ挙動 |
|---|---|---|
| 匿名ユーザー | Cookie（`session_id` ベース） | — |
| 会員 | DB（`wishlist` テーブル） | ログイン時に Cookie → DB へマージ |

- マージ時: Cookie のアイテムを `wishlist` テーブルに `INSERT ON CONFLICT DO NOTHING` で追加する。
- 会員ログアウト時: Cookie を削除し DB のウィッシュリストは保持する。

---

## API 仕様（WISHLIST-API）

| エンドポイント | メソッド | 概要 | 認証 |
|---|---|---|---|
| `/api/wishlist` | GET | ウィッシュリスト取得 | session_id / 会員 |
| `/api/wishlist` | POST | アイテム追加 | session_id / 会員 |
| `/api/wishlist/:id` | DELETE | アイテム削除 | session_id / 会員 |
| `/api/promotions` | POST | プロモーション作成（管理 API） | `admin` ロール |
| `/api/items/:id/notify` | POST | 入荷通知登録 | 任意 |

---

## マーケティング機能設計（MKT-DESIGN）

### プロモーション管理

- 管理画面でクーポン作成・セール設定が可能（開始/終了日時・適用条件）。
- プロモーション適用は**サーバ側検証のみ**で整合性を担保する（クライアント計算値は使用しない）。

### 入荷通知フロー

1. 在庫切れ商品ページで「入荷通知を受け取る」ボタン押下 → `POST /api/items/:id/notify` で登録
2. 在庫補充イベント発生時に通知リストを参照し、SendGrid / SES でメール送信
3. メール送信後は通知登録を削除する（ワンショット通知）

### パーソナライズ

- MVP: ルールベース（購入・閲覧履歴に基づくサーバサイド評価）
- 将来: ML ベースのレコメンドへの拡張を想定した設計にする
| MKT-01-002 | ウィッシュリスト処理（匿名→会員同期） | IMPL-MKT-WISH-SYNC-01 | `src/features/wishlist/services/` | 未実装 | 未 |
| MKT-01-003 | 入荷通知登録 `POST /api/items/:id/notify` 実装 | IMPL-MKT-NOTIFY-01 | `src/app/api/items/[id]/notify/route.ts` | 未実装 | 未 |
| MKT-01-004 | メール送信連携（SendGrid テンプレート） | IMPL-MKT-EMAIL-01 | `src/features/notifications/services/email.ts` | 未実装 | 未 |

### 実装ノート

- ウィッシュリストの現状: `session_id` Cookie ベースで保持。会員ログイン後の DB 同期は未実装
- メールテンプレート: ブランドガイドラインに準拠した SendGrid Dynamic Templates を使用予定
- 依存: `docs/tasks/09_integrations_ticket.md` (INTEG-01) の SendGrid 実装予定
