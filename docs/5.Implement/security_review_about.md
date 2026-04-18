# about セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/08_about.md](../4_DetailDesign/08_about.md)
- レビュー観点: フロントエンド、バックエンド/API、DB/RLS を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダ先頭、認証系 Cookie 名、デコード後のトークン断片などを server log に出力しており、認証情報の情報露出になる | 認証トークンや Cookie 値のログ出力を削除し、必要なら件数や有無だけの非機微な構造化ログに置き換える |
| [src/app/api/auth/identify/route.ts](../../src/app/api/auth/identify/route.ts) | 未認証のリクエストで service role の admin.createUser を実行し、email_confirm: true で任意メールアドレスの確認済みユーザーを作成している | 事前の confirmed user 作成をやめ、メール所有権の検証完了後にのみ確認済み状態にする。OTP サインインまたは通常の sign-up フローに寄せる |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | レート制限の DB エラー時に fail-open でリクエストを通しており、認証導線の abuse 防止が無効化される | 認証系エンドポイントでは fail-closed に変更するか、少なくとも代替のメモリ/エッジレート制限を入れて防御を維持する |
| [src/features/auth/ratelimit/index.ts](../../src/features/auth/ratelimit/index.ts) | rate_limit_counters の更新が select → update/insert の非原子的実装で、同時実行時にカウントの取りこぼしが起き、実効レート制限を回避できる | 単一 SQL の upsert か DB 関数で原子的に加算する実装へ変更する |