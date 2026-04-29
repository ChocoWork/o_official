# account セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/15_account.md](../4_DetailDesign/15_account.md), [docs/4_DetailDesign/14_login.md](../4_DetailDesign/14_login.md)
- レビュー観点: フロントエンド、バックエンド/API、DB/RLS を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダ先頭と認証 Cookie の raw/decoded 断片をログ出力しており、セッショントークンがログ経由で露出する | Cookie ヘッダとトークン値のログ出力を削除し、必要なら存在有無や request id のみを記録する | Closed | High |
| [src/contexts/LoginContext.tsx](../../src/contexts/LoginContext.tsx) | OTP 検証後の access token と refresh token を localStorage に保存しており、同一オリジンの XSS でセッション奪取に直結する | トークンの localStorage 保存をやめ、HttpOnly な Cookie ベースに統一する。必要なら bearer はメモリ保持のみにする | Closed | High |
| [src/app/api/profile/route.ts](../../src/app/api/profile/route.ts) | POST と DELETE は本人認証のみで通り、既存の CSRF ミドルウェア検証が入っていない | POST と DELETE の先頭で [src/lib/csrfMiddleware.ts](../../src/lib/csrfMiddleware.ts) の検証を必須化し、logout と同じ方式で拒否する | Closed | High |
| [migrations/004_create_sessions.sql](../../migrations/004_create_sessions.sql) | sessions テーブルに対して RLS 有効化と deny by default のポリシー定義が確認できない | RLS を有効化し、anon/authenticated からの直接アクセスを禁止するポリシーを追加する | Closed | High |
| [migrations/007_create_audit_logs.sql](../../migrations/007_create_audit_logs.sql) | audit_logs テーブルに対して RLS 有効化とアクセス制御ポリシー定義が確認できない | RLS を有効化し、監査ログを service role または専用サーバー経路のみに限定するポリシーを追加する | Closed | High |

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 0件
- Medium: 3件
- Low: 3件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/auth/login/route.ts](../../src/app/api/auth/login/route.ts), [src/app/api/auth/refresh/route.ts](../../src/app/api/auth/refresh/route.ts), [src/app/api/auth/register/route.ts](../../src/app/api/auth/register/route.ts) | Cookie 運用と並行して `access_token` を JSON 本文で返却している | 本文からトークンを除去し、認証は HttpOnly Cookie に統一する | Open | 3 経路とも本文返却を確認 | Medium |
| [src/app/api/profile/route.ts](../../src/app/api/profile/route.ts), [src/app/api/orders/route.ts](../../src/app/api/orders/route.ts) | account 機微 API で `Cache-Control: no-store` が未統一 | profile/orders の全応答で no-store を明示する | Open | `auth/me` は設定済みだが profile/orders は不足 | Medium |
| [src/features/auth/services/register.ts](../../src/features/auth/services/register.ts) | セッション永続化で await 漏れ由来の不整合余地 | token hash 計算を await 徹底し、回帰テストを追加する | Open | 実装上の整合性リスクを確認 | Medium |
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | IP 抽出の信頼境界がインフラ設定依存 | trusted proxy 条件を明文化し、未信頼経路のヘッダ値は不採用にする | Open | 悪用可否は環境依存 | Low |
| [src/app/api/profile/route.ts](../../src/app/api/profile/route.ts) | バリデーション詳細をそのまま返し、内部ルールを過開示 | 外部応答は汎用化し、詳細は内部ログへ限定する | Open | details 返却あり | Low |
| [src/lib/csrf.ts](../../src/lib/csrf.ts) | トークン文字集合の厳格化が不足 | base64url/hex へ統一し、伝送安全性を上げる | Open | 強度は十分だが運用安定性の改善余地あり | Low |

### 重点観点ごとの結論

1. account 領域の主論点はトークン露出面とキャッシュ制御。
2. セッション完全性は実装の細部ミスで崩れるため、テストで固定化が必要。
3. 情報最小化（レスポンス・ログ）は継続強化対象。

### 推奨対応順序

1. 認証 API の本文トークン返却を廃止（Medium）
2. profile/orders の no-store を統一（Medium）
3. register 永続化の整合性修正（Medium）
4. 残り Low 項目を順次ハードニング
