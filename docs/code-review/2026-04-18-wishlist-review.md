# Code Review: Wishlist

**Ready for Production**: No
**Critical Issues**: 4

## Review Scope

- Pass 1: フロントエンド、表示データ、XSS、情報露出
- Pass 2: API、バックエンド、認証認可、CSRF、レート制限
- Pass 3: DB、RLS、公開条件、監査、シークレット

## Priority 1 (Must Fix)

1. `src/app/api/wishlist/route.ts` が service role で `items` を参照し、`status='published'` を確認せず private 商品の存在確認・取得を行っているため、wishlist API 経由で非公開商品のメタデータが露出します。
2. `src/lib/supabase/server.ts` が Authorization ヘッダー、Cookie ヘッダー、認証 Cookie 断片をログ出力しており、item 取得や login/account 系 API を通じて認証情報がサーバログへ露出します。
3. `src/app/api/auth/logout/route.ts` と `src/proxy.ts` の組み合わせでは logout 後も `session_id` が残り、wishlist が匿名セッションに結びついたまま共有端末上で次ユーザーへ引き継がれます。
4. `src/app/api/wishlist/route.ts` と `src/app/api/wishlist/[id]/route.ts` にレート制限がなく、公開 API として高頻度の列挙・重複投入・削除試行を抑止できません。

## Findings

### src/app/api/wishlist/route.ts

- service role クライアントで `wishlist` と `items` を直接参照しており、RLS と public item 制約を迂回しています。
- `POST` の item 存在確認は `id` のみで、`status='published'` を見ていません。
- `GET` の item 結合でも `status='published'` を見ていないため、private 商品が wishlist に入ると商品名・価格・画像・カテゴリがそのまま返ります。
- 公開 API に `enforceRateLimit` 相当がなく、IP や `session_id` 単位の濫用制御がありません。

### src/app/api/wishlist/[id]/route.ts

- DELETE は `session_id` 一致で削除対象を絞っていますが、レート制限や Origin 検証がなく、高頻度試行への防御がありません。

### src/lib/supabase/server.ts

- Bearer token 検出ログ、Cookie ヘッダー先頭、`sb-*` / `access` / `refresh` / `session` Cookie の内容断片を出力しています。
- wishlist から遷移する item 詳細、login/account/profile 系 API がこの共通ヘルパーを使うため、認証情報の横断的なログ露出経路になっています。

### src/proxy.ts / src/app/api/auth/logout/route.ts

- `session_id` は 30 日の httpOnly Cookie として発行されますが、logout 時に削除もローテーションもされません。
- wishlist が匿名セッション ID ベースで保持される実装のため、共有ブラウザでは前ユーザーの wishlist 状態を次ユーザーが引き継げます。

### migrations/021_create_wishlist_table.sql

- guest 用 RLS は `current_setting('app.session_id', true)` 前提ですが、現行 API ではこの設定値を流し込んでいません。
- 実運用では service role API に依存しており、DB 側の最小権限防御が有効に使われていません。

## Recommended Changes

- wishlist API は service role をやめ、anon/authenticated クライアントで RLS を効かせるか、少なくとも item 解決に `status='published'` を強制する。
- `POST /api/wishlist` と `DELETE /api/wishlist/:id` に IP + `session_id` ベースのレート制限を導入し、`item_id` は Zod で整数・範囲を検証する。
- logout 時に `session_id` を clear し、login 時にも匿名セッションを rotate して、将来の会員連携では cookie -> user_id への安全な merge を実装する。
- `src/lib/supabase/server.ts` の認証関連ログを削除し、必要なら request id や Cookie 件数だけをマスク済みで出力する。