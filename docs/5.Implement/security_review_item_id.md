# item_id セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/05_item_detail.md](../4_DetailDesign/05_item_detail.md)
- レビュー観点: フロントエンド詳細、バックエンド/API、DB/公開条件/ストレージ を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [src/lib/supabase/server.ts](../../src/lib/supabase/server.ts) | Cookie header、認証 Cookie、Bearer token の存在を通常リクエスト処理で詳細ログ出力しており、item 詳細表示と items API 経由でも認証情報断片がサーバログへ露出する | トークン値と Cookie 値のログを削除し、必要なら request id や cookie 件数だけをマスク済みで出力する |
| [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts) | 公開 API が stock_quantity の生値を返しており、在庫近似情報を収集できる | 公開レスポンスは段階化済みの stockStatus のみ返し、厳密在庫値は checkout サーバ側だけで利用する |
| [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts) | 公開 item 詳細 API にレート制限がなく、連番 id を使った列挙と在庫状態収集を抑止できない | IP またはセッション単位のレート制限を付ける |
| [src/app/api/cart/route.ts](../../src/app/api/cart/route.ts) | service role で items を参照しつつ status が published か確認していないため、private 商品を直接カート投入できる | items 参照は RLS を効かせた公開クライアントへ寄せるか、少なくとも item 存在確認と取得の両方で status = published を必須化する |
| [src/app/api/wishlist/route.ts](../../src/app/api/wishlist/route.ts) | service role で items を参照し status が published か確認していないため、private 商品を wishlist に追加できる | cart と同様に service role をやめるか、item 追加確認と取得の両方で status = published を必須化する |
| [src/app/api/checkout/create-session/route.ts](../../src/app/api/checkout/create-session/route.ts) | カート内 item_id に対して published 制約なしで Stripe セッションを作成するため、private 商品を checkout に進められる | checkout 開始前に items.status = published を強制し、非公開商品が混入したカートは 400 または 409 で拒否する |
| [src/app/api/checkout/complete/route.ts](../../src/app/api/checkout/complete/route.ts) | 注文確定時も published 制約なしで items を参照して order_items を生成するため、private 商品が受注データに混入し得る | 注文確定でも status = published を必須化し、非公開商品が含まれる場合は注文明細生成前に失敗させる |
| [migrations/016_create_items_and_item_images_bucket.sql](../../migrations/016_create_items_and_item_images_bucket.sql) | item-images バケットが public で一括公開されており、private 商品画像も URL が分かれば直接取得できる | private 商品画像は非公開バケットまたは非公開パスへ分離し、公開時だけ署名 URL または公開用バケットへ切り替える |