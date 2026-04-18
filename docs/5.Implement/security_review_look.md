# look セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/06_look_list.md](../4_DetailDesign/06_look_list.md)
- レビュー観点: フロントエンド一覧、バックエンド/API、DB/公開条件/ストレージ を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie ヘッダ先頭や access/refresh token の一部をサーバーログへ出力しており、認証情報の漏えい面を作っている | 認証トークン値・Cookie 値のログ出力を削除し、必要なら有無や件数などのメタ情報だけを記録する |
| [migrations/018_create_looks_and_look_images_bucket.sql](../../migrations/018_create_looks_and_look_images_bucket.sql) | look-images バケットが public のため、private または未公開 look の画像でも URL を知っていれば直接取得できる | バケットを private に変更し、公開済み look のみ署名付き URL かアプリ経由配信にする |
| [src/app/api/admin/looks/route.ts](../../src/app/api/admin/looks/route.ts) | 管理者向け look 作成 API にレート制限がなく、侵害済み管理アカウントや内部誤操作でストレージ枯渇・高負荷を起こしやすい | 管理 API にユーザー単位と IP 単位のレート制限、1 リクエストあたりの画像数上限、時間あたりの総アップロード量制限を追加する |
| [src/app/api/admin/looks/[id]/route.ts](../../src/app/api/admin/looks/%5Bid%5D/route.ts) | 管理者向け look 更新 API にレート制限がなく、繰り返し画像差し替えでストレージとバックエンド資源を消費できる | 作成 API と同じ制限を PUT、PATCH、DELETE にも適用し、特に画像更新系は厳しめに制限する |
| [src/app/api/admin/looks/route.ts](../../src/app/api/admin/looks/route.ts) | look の作成成功・失敗が audit_logs に記録されず、誰がどの look を公開したか追跡できない | 作成成功・失敗時に actor、look id、公開状態、関連 item id を監査ログへ記録する |
| [src/app/api/admin/looks/[id]/route.ts](../../src/app/api/admin/looks/%5Bid%5D/route.ts) | look の更新、公開状態変更、削除が audit_logs に記録されない | 更新、公開切替、削除の成功・失敗をすべて監査ログへ記録する |