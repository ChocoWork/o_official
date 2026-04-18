# account セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/15_account.md](../4_DetailDesign/15_account.md), [docs/4_DetailDesign/14_login.md](../4_DetailDesign/14_login.md)
- レビュー観点: フロントエンド、バックエンド/API、DB/RLS を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダ先頭と認証 Cookie の raw/decoded 断片をログ出力しており、セッショントークンがログ経由で露出する | Cookie ヘッダとトークン値のログ出力を削除し、必要なら存在有無や request id のみを記録する |
| [src/contexts/LoginContext.tsx](../../src/contexts/LoginContext.tsx) | OTP 検証後の access token と refresh token を localStorage に保存しており、同一オリジンの XSS でセッション奪取に直結する | トークンの localStorage 保存をやめ、HttpOnly な Cookie ベースに統一する。必要なら bearer はメモリ保持のみにする |
| [src/app/api/profile/route.ts](../../src/app/api/profile/route.ts) | POST と DELETE は本人認証のみで通り、既存の CSRF ミドルウェア検証が入っていない | POST と DELETE の先頭で [src/lib/csrfMiddleware.ts](../../src/lib/csrfMiddleware.ts) の検証を必須化し、logout と同じ方式で拒否する |
| [migrations/004_create_sessions.sql](../../migrations/004_create_sessions.sql) | sessions テーブルに対して RLS 有効化と deny by default のポリシー定義が確認できない | RLS を有効化し、anon/authenticated からの直接アクセスを禁止するポリシーを追加する |
| [migrations/007_create_audit_logs.sql](../../migrations/007_create_audit_logs.sql) | audit_logs テーブルに対して RLS 有効化とアクセス制御ポリシー定義が確認できない | RLS を有効化し、監査ログを service role または専用サーバー経路のみに限定するポリシーを追加する |