# stockist セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/10_stockist.md](../4_DetailDesign/10_stockist.md)
- レビュー観点: フロントエンド、バックエンド/API、DB/RLS/監査 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/app/api/admin/stockists/route.ts](../../src/app/api/admin/stockists/route.ts) | 管理系の POST、PUT、PATCH、DELETE が Cookie ベース認証も受け付ける一方で、CSRF 検証を実施していない | 変更系 stockist API で CSRF 検証を必須化し、失敗時は 403 を返すようにする |
| [src/app/api/admin/stockists/[id]/route.ts](../../src/app/api/admin/stockists/%5Bid%5D/route.ts) | 管理 API にレート制限がなく、漏えいした管理トークンやセッションで大量列挙、大量更新、大量削除を短時間で実行できる | actor と IP 単位のレート制限を追加し、変更系は読み取り系より厳しい閾値に分けて 429 を返す |
| [src/lib/audit.ts](../../src/lib/audit.ts) | stockist の作成、更新、公開切替、削除で監査ログが記録されず、誰が何を変えたか追跡できない | 成功と失敗の両方を監査ログへ記録し、actor_id、resource、resource_id、変更要約を残す |
| [migrations/027_create_stockists_and_acl.sql](../../migrations/027_create_stockists_and_acl.sql) | DB には stockists の RLS policy があるが、管理 API は service role client を使うため実運用経路では RLS をバイパスしている | 可能な操作は request-scoped client と RLS で実行し、service role は限定用途に閉じる |