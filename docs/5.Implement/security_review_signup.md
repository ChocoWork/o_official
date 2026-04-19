# signup セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/14_login.md](../4_DetailDesign/14_login.md)
- 対象補足: signup 専用ページは未確認のため、signup 相当の OTP/register/confirm 導線をレビュー
- レビュー観点: フロントエンド導線、バックエンド/API、DB/セッション/監査 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/auth/otp/verify/route.ts](../../src/app/api/auth/otp/verify/route.ts) | 認証成功時に access token / refresh token を JSON と localStorage に露出しており、XSS 1 回でセッション奪取が成立する | トークンは HttpOnly Cookie のみで扱い、API レスポンスから除去する | Open | High |
| [src/app/api/auth/identify/route.ts](../../src/app/api/auth/identify/route.ts) | JIT 作成で email_confirm: true を使っており、メール所有確認前に確認済みアカウントを作成している | email_confirm: true を廃止し、未確認状態のまま OTP/confirm 完了時に確定させる | Open | High |
| [src/lib/redirect.ts](../../src/lib/redirect.ts) | x-forwarded-host / x-forwarded-proto を無条件で信頼して origin を組み立てており、確認メールリンクや confirm リダイレクトで Host header poisoning が成立しうる | origin は設定済み allowlist で固定し、信頼済み proxy 由来ヘッダのみ採用する | Open | High |
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダや token の一部をログ出力しており、認証情報がサーバログやブラウザコンソールに残る | 認証トークン、Cookie、Authorization ヘッダはログ出力しない | Open | High |
| [migrations/004_create_sessions.sql](../../migrations/004_create_sessions.sql) | sessions、rate_limit_counters、audit_logs に RLS/policy 定義がなく、認証系保護テーブルの防御が不足している | 全テーブルで RLS を有効化し、service_role のみ全面許可、必要最小限の authenticated policy のみに絞る | Open | High |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | DB 障害時に rate limit が fail-open で素通しになり、認証 API の総当たり防御が消える | 高リスク endpoint は fail-closed、少なくとも edge/in-memory fallback を追加する | Open | High |