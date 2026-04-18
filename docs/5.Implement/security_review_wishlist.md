# wishlist セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/11_wishlist.md](../4_DetailDesign/11_wishlist.md)
- レビュー観点: フロントエンド、バックエンド/API、DB/公開条件/セッション管理 を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts) | service role で wishlist / items を直接参照し、private item に対する published 条件確認なしで存在確認と一覧取得を行っているため、非公開商品の名前・価格・画像・カテゴリが露出する | service role 利用をやめて RLS を効かせるか、少なくとも item 追加確認と一覧取得の両方で status = published を必須化する |
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Authorization ヘッダー検出、Cookie ヘッダー先頭、sb 系 / access / refresh / session Cookie 断片をログ出力しており、認証情報がサーバログへ露出する | 認証トークンと Cookie 値のログ出力を削除し、必要なら request id や Cookie 件数のみをマスク済みで記録する |
| [src/app/api/auth/logout/route.ts](../../src/app/api/auth/logout/route.ts) | logout 時に [src/proxy.ts](../../src/proxy.ts) が発行した session_id を削除・ローテーションしておらず、共有端末では次ユーザーが前ユーザーの wishlist を閲覧できる | logout 時に session_id を clear し、login 時にも session_id を rotate したうえで、将来の会員連携では cookie から user_id への安全な merge に切り替える |
| [src/app/api/wishlist/[id]/route.ts](../../src/app/api/wishlist/%5Bid%5D/route.ts) | GET / POST / DELETE にレート制限がなく、item_id 列挙、重複投入、削除試行を高頻度で実行できる | IP と session_id の両方をキーにしたレート制限を追加し、item_id を Zod 等で整数・範囲検証する |