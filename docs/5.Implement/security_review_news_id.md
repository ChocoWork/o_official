# news_id セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/03_news_detail.md](../4_DetailDesign/03_news_detail.md)
- レビュー観点: フロントエンド詳細、バックエンド/API、DB/公開条件/画像公開 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス | 優先度 |
|---|---|---|---|---|
| [src/app/api/news/route.ts](../../src/app/api/news/route.ts) | 公開 API にレート制限がなく、limit も上限未設定のため、匿名での大量スクレイピングと DB 負荷増幅を許している | 既存レート制限を適用し、limit は小さい最大値に clamp する | Open | High |
| [migrations/013_create_news_images_bucket.sql](../../migrations/013_create_news_images_bucket.sql) | news-images バケットが public=true のため、非公開記事用にアップロードされた画像でも URL が漏れれば公開状態に関係なく直接参照できる | バケットを private に変更し、公開済み画像のみ署名 URL またはサーバープロキシ経由で配信する | Open | High |