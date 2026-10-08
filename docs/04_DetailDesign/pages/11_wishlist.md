# 1.11 ウィッシュリストページ（WISHLIST）詳細設計

> 状態: 既存設計 | 実装状況は項目ごとに要再照合

## 概要

本書は「1.11 ウィッシュリストページ（WISHLIST）詳細設計」の既存設計を記録する。要件IDと設計意図を保持しているが、表中の実装状況は現在のコードと一括再照合していない。

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-WISHLIST-001 | `/wishlist` ページは `h1` 見出しを含み `WishlistClient` でウィッシュリストアイテムを表示する | IMPL-WISHLIST-001 | `src/app/wishlist/page.tsx`, `src/app/wishlist/client.tsx` | `page.tsx` は RSC で `h1` "Wishlist" を持ち `<WishlistClient />` を内包 | 済 |
| FR-WISHLIST-002 | `WishlistClient` は `/api/wishlist` からデータを取得し読み込み中・エラー・空状態の各 UI を表示する | IMPL-WISHLIST-002 | `src/app/wishlist/client.tsx`, `src/app/api/wishlist/route.ts` | `useEffect` で `fetch('/api/wishlist')` 実行。loading / error / empty の各ブランチ実装済み。エラー時は `alert()` を使用 | 済 |
| FR-WISHLIST-003 | ウィッシュリストカードは商品画像・カテゴリ・商品名・価格を表示し商品詳細ページへ遷移できる | IMPL-WISHLIST-003 | `src/app/wishlist/client.tsx` | `Image` コンポーネントで `image_url`、カテゴリ、商品名、価格、`/item/${item.items.id}` リンクを表示 | 済 |
| FR-WISHLIST-004 | ユーザーはカード上の削除ボタンでアイテムを削除でき削除後に一覧を再レンダリングする | IMPL-WISHLIST-004 | `src/app/wishlist/client.tsx`, `src/app/api/wishlist/[id]/route.ts` | `DELETE /api/wishlist/${wishlistId}` 呼び出し後に `filter` で画面更新。エラー時は `alert()` のみ | 済 |
| FR-WISHLIST-005 | ウィッシュリスト API は GET / POST / DELETE を持ち、wishlist Cookie または会員の ID で管理する | IMPL-WISHLIST-005 | `src/app/api/wishlist/route.ts`, `src/app/api/wishlist/[id]/route.ts` | 持ち主と wishlist_lines をサーバーで照合。GET の各行に販売中の `variants:[{id,color,size}]` を添え、会員の書き換えには CSRF を求める | 済 |
| FR-WISHLIST-006 | ウィッシュリストが空の場合は案内テキストと `/item` への継続購入リンクを提供する | IMPL-WISHLIST-006 | `src/app/wishlist/client.tsx` | 「ウィッシュリストは空です」と `Link href="/item"` 「買い物を続ける」を表示 | 済 |
| FR-WISHLIST-007 | 各カードからカートへの追加または色・サイズの選択へ進める | IMPL-WISHLIST-007 | `src/app/wishlist/page.tsx` | 選択が必要なら商品詳細へ進む。選択が不要なら販売中のバリアントで `POST /api/cart/add` に `{items:[{id,quantity:1}]}` を送り、成功で件数を更新、失敗で description を案内する | 済 |
| FR-WISHLIST-008 | 削除ボタンに `aria-label="ウィッシュリストから削除"` を付与しカードリストに適切な role を設定する | IMPL-WISHLIST-008 | `src/app/wishlist/client.tsx` | 削除ボタンへ `aria-label` を付与し、一覧に `role="list"`、カードに `role="listitem"` を設定 | 済 |
| FR-WISHLIST-009 | 認証連携による永続化・デバイス間同期（旧 WONT は FREQ-429・431 で置き換え） | — | `src/features/cart/services/guest-shopping-merge.ts` | 会員の ID でサーバーに保持し、ログインでゲストのお気に入りと合わせる。ログアウトで端末の Cookie は消し、会員の分は次のログインで戻る | 済 |
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
| ゲスト | サーバーの wishlists・wishlist_lines。ブラウザは `wishlist` Cookie の印だけ | DBには印のSHA-256（guest_token_hash）だけを保存。ログインで会員へ合わせる |
| 会員 | 同じ2表を会員の ID で読む | ゲストと会員に同じ商品があれば1件。会員の分が無ければ持ち主を付け替える |

2026-10-08（FREQ-429・431・432）: `wishlist` Cookie は HttpOnly・SameSite=Lax・Path=/・2週間（書き換えで延長）。最後に使ってから30日を過ぎたゲストの分を毎日削除し、会員の分は残す。ログインで合わせるのに失敗してもログインは止めず、Cookieを残して次の読み出しで再試行する。ログアウトは `cart`・`wishlist` Cookieを消し、会員のデータは保持する。

根拠: [持ち主と明細の移行](../../../supabase/migrations/20261008130000_cart_wishlist_ownership.sql)、[合わせ込み](../../../src/features/cart/services/guest-shopping-merge.ts)、[設計](../../superpowers/specs/2026-10-08-cart-wishlist-carryover-design.md)。

---

## API 仕様（WISHLIST-API）

| エンドポイント | メソッド | 概要 | 認証 |
|---|---|---|---|
| `/api/wishlist` | GET | 公開商品の明細と販売中の `variants:[{id,color,size}]` を取得 | wishlist Cookie または会員 |
| `/api/wishlist` | POST | 商品番号で追加。重複は409 `{error:"Item already in wishlist"}`。会員はCSRF必須 | wishlist Cookie または会員 |
| `/api/wishlist/:id` | DELETE | 持ち主の明細だけ削除（他人は404）。会員はCSRF必須 | wishlist Cookie または会員 |
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
| MKT-01-002 | ウィッシュリスト処理（ゲスト→会員の引き継ぎ、FREQ-429） | IMPL-MKT-WISH-SYNC-01 | `src/features/cart/services/guest-shopping-merge.ts` | merge_guest_into_memberで同じ商品を1件にする | 済 |
| MKT-01-003 | 入荷通知登録 `POST /api/items/:id/notify` 実装 | IMPL-MKT-NOTIFY-01 | `src/app/api/items/[id]/notify/route.ts` | 未実装 | 未 |
| MKT-01-004 | メール送信連携（SendGrid テンプレート） | IMPL-MKT-EMAIL-01 | `src/features/notifications/services/email.ts` | 未実装 | 未 |

### 実装ノート

- ウィッシュリストの現状: ゲストは `wishlist` Cookie、会員は会員の ID でサーバーに保持し、ログインでゲストの分を会員の分へ合わせる。同じ商品は1件にし、ログアウトで端末の Cookie を消す。会員の分は次のログインで戻る（FR-WISHLIST-009・MKT-01-002、FREQ-429・431）
- メールテンプレート: ブランドガイドラインに準拠した SendGrid Dynamic Templates を使用予定
- 依存: `docs/tasks/09_integrations_ticket.md` (INTEG-01) の SendGrid 実装予定
