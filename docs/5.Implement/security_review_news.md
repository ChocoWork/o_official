# news セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/02_news_list.md](../4_DetailDesign/02_news_list.md)
- レビュー観点: フロントエンド一覧、バックエンド/API、DB/公開条件/ストレージ を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス |
|---|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | public news ページと API から到達する共通 Supabase クライアントで、Bearer 検出や Cookie ヘッダ先頭をサーバログに出しており、認証トークン断片やセッション情報の漏えい面を作っている | 認証情報に関する console.log を削除し、必要なら request id 程度の非機微メタデータだけを構造化ログに残す | 対応済み |
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | 公開 API にレート制限がなく、limit も上限なしで受け付けるため、一覧スクレイピングや過大件数取得による負荷増幅に弱い | endpoint 固有のレート制限を適用し、limit は安全な最大値に clamp する | 対応済み |
| [migrations/013_create_news_images_bucket.sql](../../migrations/013_create_news_images_bucket.sql) | news-images バケットを public=true で作っており、private 状態の記事でも画像がアップロード時点で恒久公開 URL 化される | 未公開記事用の画像は private バケットに分離し、公開済み記事のみ署名 URL か公開用パスへ昇格させる | 未対応 |
| [src/app/api/admin/news/route.ts](../../src/app/api/admin/news/route.ts) | News 記事の作成・更新・公開状態変更・削除、および画像アップロードに対して監査記録がない | 管理系 news API で actor、resource_id、status 変更前後、storage object path、結果を audit_logs に記録する | 未対応 |