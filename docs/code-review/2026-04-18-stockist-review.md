# Code Review: Stockist

Ready for Production: No
Critical Issues: 4

## Review Plan

1. Pass 1: フロントエンド、地図/住所表示、XSS
2. Pass 2: API、バックエンド、入力検証、認可、レート制限
3. Pass 3: DB、RLS、公開条件、監査

## Related Files

- src/app/stockist/page.tsx
- src/features/stockist/components/PublicStockistGrid.tsx
- src/features/stockist/services/public.ts
- src/features/stockist/types.ts
- src/app/api/admin/stockists/route.ts
- src/app/api/admin/stockists/[id]/route.ts
- src/app/admin/stockist/StockistForm.tsx
- src/components/StockistSection.tsx
- src/lib/client-fetch.ts
- src/lib/cookie.ts
- src/lib/auth/admin-rbac.ts
- src/lib/supabase/server.ts
- src/lib/audit.ts
- migrations/027_create_stockists_and_acl.sql
- migrations/028_seed_stockists.sql
- migrations/029_drop_stockist_home_feature_and_display_order.sql
- migrations/030_remove_stockist_type.sql
- docs/4_DetailDesign/10_stockist.md

## Priority 1 (Must Fix) ⛔

### 1. Stockist 管理 API の変更系エンドポイントに CSRF 検証がない
- Files: src/app/api/admin/stockists/route.ts, src/app/api/admin/stockists/[id]/route.ts, src/lib/supabase/server.ts, src/lib/cookie.ts
- Issue: 管理 API は Cookie ベースの認証トークンも受け付けますが、POST/PUT/PATCH/DELETE で requireCsrfOrDeny 相当の検証がありません。
- Why this matters: SameSite=Lax は一定の緩和になりますが、状態変更 API の CSRF 防御を Cookie 属性だけに依存しています。設計上も CSRF ミドルウェアが存在するため、防御層が欠けています。
- Suggested fix: stockist の変更系 API で CSRF 検証を必須化し、失敗時は 403 を返す。Cookie 認証を許可する全管理系更新 API に同じ方針を適用する。

### 2. Stockist 管理 API にレート制限がない
- Files: src/app/api/admin/stockists/route.ts, src/app/api/admin/stockists/[id]/route.ts
- Issue: 一覧取得・作成・更新・削除・公開切替の全てにレート制限や異常利用抑止がありません。
- Why this matters: 管理トークンやセッションが漏えいした場合に、短時間で大量の列挙・改ざん・削除を実行できます。認可があっても濫用耐性は別途必要です。
- Suggested fix: IP と actor 単位のレート制限を追加し、超過時は 429 を返す。特に変更系はより厳しい閾値に分ける。

## Important Issues

### 3. Stockist 管理操作の監査ログが残らない
- Files: src/app/api/admin/stockists/route.ts, src/app/api/admin/stockists/[id]/route.ts, src/lib/audit.ts
- Issue: stockist の作成、更新、公開切替、削除で logAudit が呼ばれておらず、変更主体と変更内容の監査証跡が残りません。
- Why this matters: 不正操作や誤操作の追跡、インシデント調査、公開状態の変更履歴確認が困難になります。
- Suggested fix: 成功/失敗の両方を logAudit へ記録し、actor_id、resource、resource_id、変更内容の要約を残す。重要操作は DB 側の監査トリガーも検討する。

### 4. DB に RLS はあるが、実運用の管理経路では service role によりバイパスされている
- Files: src/app/api/admin/stockists/route.ts, src/app/api/admin/stockists/[id]/route.ts, src/lib/supabase/server.ts, migrations/027_create_stockists_and_acl.sql
- Issue: migrations では stockists の RLS を定義していますが、管理 API は常に createServiceRoleClient() を使うため、DB の policy が最終防衛線として機能していません。
- Why this matters: ルート側の認可ロジックに欠陥が入った場合、DB 側で拒否できず、全件読み書きが通ります。Zero Trust と最小権限の観点で防御が一層減っています。
- Suggested fix: 可能な操作は request-scoped client と RLS で実行し、service role は限定的な用途に閉じる。service role が必要な場合も RPC や DB 関数で操作面を狭める。

## Residual Risk

- Pass 1 では React の自動エスケープと固定の地図 URL により、直ちに exploitable な XSS は確認できませんでした。
- 公開取得は status = 'published' の二重条件で絞られており、公開条件自体は妥当です。
- ただし管理経路の CSRF、監査、RLS バイパスが残る限り、管理面の防御深度は不足しています。