# home セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/01_home.md](../4_DetailDesign/01_home.md)
- レビュー観点: フロントエンド、バックエンド/API、DB/RLS を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 | ステータス |
|---|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Authorization ヘッダー、Cookie ヘッダー先頭、認証系 Cookie 名と値断片をログ出力しており、ホーム表示や検索 API を含む通常リクエストでセッション関連情報がサーバログへ露出する | 認証トークン、Cookie 値、Authorization ヘッダーに関するログを削除し、必要なら request id や件数など値を含まない監視情報だけを残す | 対応済み |
| [src/lib/look/public.ts](../../src/lib/look/public.ts) | 公開 LOOK の関連商品取得で items に published 条件を付けておらず、閲覧者セッションが有効な実行経路では非公開商品メタデータを公開ページ経路で取得し得る | 関連商品取得に published 条件を明示追加し、公開ページ用データ取得は閲覧者セッションを引き継がない公開専用クライアントへ分離する | 未対応 |
| [src/app/api/search/route.ts](../../src/app/api/search/route.ts) | ホームの検索プレビューが利用する公開検索 API にレート制限が実装されておらず、濫用による列挙や負荷増大を防ぐ制御がない | IP またはセッション単位のレート制限を追加し、preview リクエストにはより厳しい上限を設定する | 未対応 |