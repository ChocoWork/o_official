# login セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/14_login.md](../4_DetailDesign/14_login.md), [docs/4_DetailDesign/01_auth_seq.md](../4_DetailDesign/01_auth_seq.md)
- レビュー観点: フロントエンド認証導線、バックエンド/API/OAuth、DB/セッション/監査 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/contexts/LoginContext.tsx](../../src/contexts/LoginContext.tsx) | HttpOnly Cookie を発行している一方で、アクセストークンとリフレッシュトークンを JSON 返却し、クライアントで localStorage に保存している | トークンの JSON 返却をやめ、認証状態はサーバ発行の HttpOnly Cookie のみに統一する | Open | High |
| [src/app/auth/callback/page.tsx](../../src/app/auth/callback/page.tsx) | 実際の Google OAuth が client-side exchangeCodeForSession で完結しており、設計書で定義された server-managed の state/PKCE 保管と再利用防止フローを通っていない | Google ログイン開始を [src/app/api/auth/oauth/start/route.ts](../../src/app/api/auth/oauth/start/route.ts) 経由に統一し、code 交換は [src/app/api/auth/oauth/callback/route.ts](../../src/app/api/auth/oauth/callback/route.ts) のみで実施する | Open | High |
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | OAuth code の有無、access token 先頭、Cookie ヘッダ、sb 系 Cookie の先頭値をログ出力しており、認証情報の断片がログに漏れる | トークン値・Cookie 値・その prefix を一切ログしない | Open | High |
| [src/app/api/auth/password-reset/request/route.ts](../../src/app/api/auth/password-reset/request/route.ts) | パスワード再設定トークンを query string に載せて配布し、クライアントページでそのまま処理している | reset token はサーバ側 route で即時検証・消費し、no-store と no-referrer を付けてクリーン URL へリダイレクトする | Open | High |
| [src/app/api/auth/refresh/route.ts](../../src/app/api/auth/refresh/route.ts) | refresh フローで current_jti、previous_refresh_token_hash、quarantined を使った再利用検知を実施していない | refresh 時に旧トークンと現在 JTI を照合し、再利用検知時は全セッション失効と監査記録を必須化する | Open | High |
| [migrations/004_create_sessions.sql](../../migrations/004_create_sessions.sql) | sessions、rate_limit_counters、audit_logs、oauth_requests に RLS 有効化と deny-by-default のポリシーが見当たらない | これらのテーブルに RLS を有効化し、service role のみアクセス可能な明示ポリシーを追加する | Open | High |
| [src/app/api/auth/password-reset/request/route.ts](../../src/app/api/auth/password-reset/request/route.ts) | パスワード再設定で deprecated な public.users を参照しており、auth.users を source of truth とする設計と不整合 | user 解決は Supabase Auth admin API または auth.users ベースに統一し、public.users 依存を除去する | Open | High |
| [src/app/api/auth/password-reset/confirm/route.ts](../../src/app/api/auth/password-reset/confirm/route.ts) | password_reset_tokens を使用しているが、対応 migration が確認できない | password_reset_tokens の作成 migration を追加し、expires_at、used、一意制約、掃除ジョブ、RLS/ポリシーまで定義する | Open | High |