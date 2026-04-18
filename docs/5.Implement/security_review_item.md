# item セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/04_item_list.md](../4_DetailDesign/04_item_list.md)
- レビュー観点: フロントエンド一覧、バックエンド/API、DB/公開条件/ストレージ を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/lib/items/public.ts](../../src/lib/items/public.ts) | 公開一覧 API の取得列に status、created_at、updated_at が含まれており、一覧表示に不要な内部メタデータが未認証クライアントへ露出している | 公開 API 用の返却 DTO を分離し、一覧 UI に必要な最小列だけを select する |
| [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts) | 公開詳細 API が stock_quantity、status、created_at、updated_at をそのまま返している | stock_quantity は out、low、in のような粗い公開用状態に集約し、内部メタデータ列は公開レスポンスから除外する |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | category、size、color、collection、collectionSeasons が enum、長さ、文字種まで検証されず、そのまま検索条件と後段フィルタに流れている | クエリ全体を Zod object で定義し、カテゴリ enum、文字列長上限、配列要素数上限、許可文字を明示して不正入力を 400 で拒否する |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | 未認証の一覧 API にレート制限とアクセス監査がない | IP またはセッション単位の rate limit を追加し、超過時は 429 を返し、異常アクセスを監査ログやメトリクスへ送る |
| [migrations/016_create_items_and_item_images_bucket.sql](../../migrations/016_create_items_and_item_images_bucket.sql) | item-images バケットが public=true で作成されており、下書きや非公開商品の画像が URL 既知時に露出する | バケットを private に変更して署名 URL で配信するか、published 用と draft 用を分離し、Storage policy で公開条件を item の公開状態と一致させる |