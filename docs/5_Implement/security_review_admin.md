# admin セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/16_admin.md](../4_DetailDesign/16_admin.md), [docs/3_ArchitectureDesign/hybrid-rbac.md](../3_ArchitectureDesign/hybrid-rbac.md)
- レビュー観点: フロントエンド権限表示、バックエンド/API、DB/RLS/監査 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/admin/create-user/route.ts](../../src/app/api/admin/create-user/route.ts) | Service Role の auth.admin.createUser を使う管理用 API に認証・認可チェックがない | [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts) の権限チェックを必須化し、少なくとも admin.users.manage を要求して actor を監査記録する | Closed | High |
| [src/app/api/admin/audit-logs/route.ts](../../src/app/api/admin/audit-logs/route.ts) | x-admin-token と ADMIN_API_KEY の一致だけで通しており、ユーザー単位の認証認可と RBAC をバイパスしている | 共有トークン方式を廃止し、通常の管理セッションに紐づく権限検証へ統一する | Closed | High |
| [src/app/api/admin/revoke-user-sessions/route.ts](../../src/app/api/admin/revoke-user-sessions/route.ts) | 共有秘密 1 本で実行でき、actor 特定と権限監査がない | 管理セッション + RBAC + 監査ログを必須化する | Closed | High |
| [src/app/api/admin/orders/[id]/refund/route.ts](../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts) | 返金 API が admin.orders.manage だけで通り supporter でも実行できる | 返金専用権限を分離するか、権限確認後に admin ロールを必須化する | Closed | High |
| [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts) | DB ACL と token role の OR 判定になっており、DB 側で失効しても app_metadata.role が残っていれば権限が継続する | DB ACL を最終判定源にし、token role は UI 最適化または整合確認用途に限定する | Closed | High |
| [src/app/admin/page.tsx](../../src/app/admin/page.tsx) | 管理画面表示で 2FA/MFA 状態の確認がなく、仕様の admin 2FA 必須化と不整合 | 管理画面ガードと authorizeAdminPermission の両方で MFA 完了状態を必須化する | Closed | High |
| [src/app/api/admin/users/route.ts](../../src/app/api/admin/users/route.ts) | 権限変更 PATCH が重要操作なのに監査ログを残していない | 変更前後ロール、actor、対象 user_id、IP、user-agent を成功・失敗ともに監査記録する | Closed | High |
| [migrations/007_create_audit_logs.sql](../../migrations/007_create_audit_logs.sql) | audit_logs テーブルに RLS、追記専用制御、改ざん検知用ハッシュなどがない | audit_logs に entry_hash と tamper-detection トリガーを追加し、更新削除を禁止した実質的な不変監査ログとする | Closed | High |
| [migrations/025_create_orders.sql](../../migrations/025_create_orders.sql) | orders 系は本人向け RLS しかなく、管理 API は Service Role 直アクセスで DB 側の admin 権限制御を受けていない | orders と関連集計対象に管理権限用の RLS を追加し、可能な範囲で Service Role 依存を減らして DB 側でも強制する | Closed | High |

> ※2026-04-20 時点レビュー: `migrations/037_add_admin_orders_rls.sql` を追加し、`orders` と `order_items` に管理権限 RLS ポリシーを導入しました。`src/app/api/admin/orders/route.ts`、`src/app/api/admin/orders/[id]/status/route.ts`、`src/app/api/admin/orders/[id]/refund/route.ts`、`src/app/api/admin/kpi/route.ts` を `createClient(request)` に切り替え、管理ユーザーの認証済みセッションで DB 側 RLS を適用するようにしました。

---

## 追加レビュー追記（2026-04-29）

### サマリー

- High: 0件
- Medium: 3件
- Low: 4件

### セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/api/admin/create-user/route.ts](../../src/app/api/admin/create-user/route.ts), [src/app/api/admin/users/route.ts](../../src/app/api/admin/users/route.ts), [src/app/api/admin/orders/[id]/refund/route.ts](../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts), [src/app/api/admin/orders/[id]/status/route.ts](../../src/app/api/admin/orders/%5Bid%5D/status/route.ts) | 変更系 API の CSRF 適用が不統一 | 変更系 admin API 全体に共通 CSRF 検証を適用する | Open | stockists 系のみ適用済みを確認 | Medium |
| [src/app/api/admin/create-user/route.ts](../../src/app/api/admin/create-user/route.ts), [src/app/api/admin/orders/[id]/refund/route.ts](../../src/app/api/admin/orders/%5Bid%5D/refund/route.ts) | 重要操作のレート制限が未統一 | actor+IP の二軸制限を管理操作に標準適用する | Open | looks/stockists は適用済み、他に差分あり | Medium |
| [src/app/api/admin/items/route.ts](../../src/app/api/admin/items/route.ts), [src/app/api/admin/items/[id]/route.ts](../../src/app/api/admin/items/%5Bid%5D/route.ts) | 商品系変更の監査ログ粒度が不足 | users/news と同等に成功/失敗監査を追加する | Open | 商品系で監査不足を確認 | Medium |
| [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts), [src/app/api/admin/kpi/targets/route.ts](../../src/app/api/admin/kpi/targets/route.ts) | 500 応答で内部詳細を返し過ぎる | クライアント向けは固定文言、詳細は内部ログへ分離する | Open | details 返却あり | Low |
| [src/app/api/admin/kpi/migration-status/route.ts](../../src/app/api/admin/kpi/migration-status/route.ts) | 診断情報 API が本番露出しやすい | 本番無効化または super-admin 限定へ制限する | Open | テーブル存在/エラー詳細返却を確認 | Low |
| [src/app/api/admin/items/route.ts](../../src/app/api/admin/items/route.ts) | ファイル名由来拡張子依存が残る | MIME ベース固定拡張子へ統一する | Open | 実害は低いが防御一貫性不足 | Low |
| [src/lib/auth/admin-rbac.ts](../../src/lib/auth/admin-rbac.ts) | 決定ログの情報量が多い | 通常ログの情報を最小化する | Open | 運用ログ露出面の縮小余地 | Low |

### 重点観点ごとの結論

1. 認可基盤は改善済みだが、変更操作保護（CSRF/Rate limit）が未統一。
2. 監査ログの機能差分解消が必要。
3. 低優先度の情報最小化を進めると運用安全性が上がる。

### 推奨対応順序

1. 変更系 admin API へ CSRF 共通適用（Medium）
2. 返金/権限変更のレート制限統一（Medium）
3. 商品系監査ログ追加（Medium）
4. Low 項目を運用ハードニングとして順次対応

