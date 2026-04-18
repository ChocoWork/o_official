# look_id セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/07_look_detail.md](../4_DetailDesign/07_look_detail.md)
- レビュー観点: フロントエンド詳細、バックエンド/API、DB/公開条件/関連商品/ストレージ を 3 パスで確認

| ファイル名 | よくない点 | 修正提案 |
|---|---|---|
| [migrations/019_add_public_select_policy_to_look_items.sql](../../migrations/019_add_public_select_policy_to_look_items.sql) | public.look_items の公開ポリシーが look の公開状態しか見ておらず、公開 look に private item が紐づいている場合でも item_id が匿名ユーザーに露出する | public.look_items の公開条件に item 側の status = published も加えるか、公開済み item だけを返す view / RPC に置き換える |
| [migrations/016_create_items_and_item_images_bucket.sql](../../migrations/016_create_items_and_item_images_bucket.sql) | item-images / look-images が public bucket で、アップロード直後に public URL を保存しているため、private look / private item の画像でも外部から直接取得できる | bucket を private に変更し、公開時のみ signed URL か公開用バケットへの移送を行う |
| [src/app/api/admin/looks/route.ts](../../src/app/api/admin/looks/route.ts) | 公開 look の作成・更新時に linked item の存在しか検証しておらず、private item を紐づけたまま published にできる | status が published のときは linked item 全件が published であることを必須化し、満たさない場合は 400 で拒否する |