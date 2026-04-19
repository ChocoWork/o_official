# admin セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/16_admin.md](../4_DetailDesign/16_admin.md), [docs/3_ArchitectureDesign/hybrid-rbac.md](../3_ArchitectureDesign/hybrid-rbac.md)
- レビュー観点: フロントエンド権限表示、バックエンド/API、DB/RLS/監査 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/admin/create-user/route.ts](../../src/app/api/admin/create-user/route.ts) | Service Role の auth.admin.createUser を使う管理用 API に認証・認可チェックがない | [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts) の権限チェックを必須化し、少なくとも admin.users.manage を要求して actor を監査記録する | Open | High |
| [src/app/api/admin/audit-logs/route.ts](../../src/app/api/admin/audit-logs/route.ts) | x-admin-token と ADMIN_API_KEY の一致だけで通しており、ユーザー単位の認証認可と RBAC をバイパスしている | 共有トークン方式を廃止し、通常の管理セッションに紐づく権限検証へ統一する | Open | High |
| [src/app/api/admin/revoke-user-sessions/route.ts](../../src/app/api/admin/revoke-user-sessions/route.ts) | 共有秘密 1 本で実行でき、actor 特定と権限監査がない | 管理セッション + RBAC + 監査ログを必須化する | Open | High |
| [src/app/api/admin/orders/[id]/refund/route.ts](../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts) | 返金 API が admin.orders.manage だけで通り supporter でも実行できる | 返金専用権限を分離するか、権限確認後に admin ロールを必須化する | Open | High |
| [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts) | DB ACL と token role の OR 判定になっており、DB 側で失効しても app_metadata.role が残っていれば権限が継続する | DB ACL を最終判定源にし、token role は UI 最適化または整合確認用途に限定する | Open | High |
| [src/app/admin/page.tsx](../../src/app/admin/page.tsx) | 管理画面表示で 2FA/MFA 状態の確認がなく、仕様の admin 2FA 必須化と不整合 | 管理画面ガードと authorizeAdminPermission の両方で MFA 完了状態を必須化する | Open | High |
| [src/app/api/admin/users/route.ts](../../src/app/api/admin/users/route.ts) | 権限変更 PATCH が重要操作なのに監査ログを残していない | 変更前後ロール、actor、対象 user_id、IP、user-agent を成功・失敗ともに監査記録する | Open | High |
| [migrations/007_create_audit_logs.sql](../../migrations/007_create_audit_logs.sql) | audit_logs テーブルに RLS、追記専用制御、改ざん検知用ハッシュなどがない | audit_logs に RLS を有効化し、閲覧は管理権限に限定、更新削除を禁止し、整合性検証または不変保管を追加する | Open | High |
| [migrations/025_create_orders.sql](../../migrations/025_create_orders.sql) | orders 系は本人向け RLS しかなく、管理 API は Service Role 直アクセスで DB 側の admin 権限制御を受けていない | orders と関連集計対象に管理権限用の RLS を追加し、可能な範囲で Service Role 依存を減らして DB 側でも強制する | Open | High |