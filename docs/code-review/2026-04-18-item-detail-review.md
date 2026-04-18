# Code Review: item/[id]
**Ready for Production**: No
**Critical Issues**: 6

## Scope

- src/app/item/[id]/page.tsx
- src/app/item/[id]/ItemDetailClient.tsx
- src/app/api/items/[id]/route.ts
- src/app/api/items/route.ts
- src/features/items/components/RelatedItems.tsx
- src/lib/items/public.ts
- src/app/api/cart/route.ts
- src/app/api/wishlist/route.ts
- src/app/api/checkout/create-session/route.ts
- src/app/api/checkout/complete/route.ts
- src/lib/supabase/server.ts
- migrations/016_create_items_and_item_images_bucket.sql
- migrations/020_create_cart_table.sql
- migrations/021_create_wishlist_table.sql
- migrations/023_add_acl_rbac_tables_and_policies.sql
- migrations/031_add_stock_quantity_to_items.sql
- docs/4_DetailDesign/05_item_detail.md

## Priority 1 (Must Fix) ⛔

- src/lib/supabase/server.ts | Cookie header、認証 Cookie、Bearer token の存在を通常リクエスト処理で詳細ログ出力しており、item 詳細ページの metadata 生成と /api/items/[id] 経由でも認証関連情報がサーバログに露出する | 認証トークン、Cookie 値、Authorization ヘッダーのログを削除し、必要なら request id や cookie 件数のみをマスク済みで出力する
- src/app/api/cart/route.ts | service role で items を参照しつつ status='published' を確認していないため、非公開 item_id を直接 POST すると private 商品をカート投入でき、その後 GET /api/cart で商品名・価格・画像・カテゴリが露出する | items 参照は anon/auth クライアントで RLS を効かせるか、少なくとも item 存在確認・一覧取得の両方で status='published' を必須化し、private 商品は 404 にする
- src/app/api/wishlist/route.ts | service role で items を参照し status='published' を確認していないため、private 商品を wishlist に追加でき、GET で private 商品のメタデータが露出する | cart と同様に service role をやめて RLS を有効化し、item 追加確認と取得の両方で status='published' を必須化する
- src/app/api/checkout/create-session/route.ts | カート内 item_id に対して service role で items を引き、published 制約なしで Stripe セッションを作成するため、private 商品を checkout に進められる | checkout 直前に items.status='published' を強制し、非公開商品が混入したカートは 400/409 で拒否して除去を促す
- src/app/api/checkout/complete/route.ts | 注文確定時も published 制約なしで items を参照して order_items を生成するため、private 商品が受注データに混入し得る | 注文確定でも published 条件を必須にし、非公開商品は注文明細生成対象から除外ではなく決済完了前に失敗扱いとして停止する
- src/app/api/items/[id]/route.ts, src/app/item/[id]/ItemDetailClient.tsx, migrations/031_add_stock_quantity_to_items.sql | 仕様は SOLD OUT / 残りわずか表示で足りるのに公開 API が stock_quantity の生値を返しており、item_id 列挙で SKU 単位ではないにせよ実在庫の近似値を収集できる | 公開 API では生の stock_quantity を返さず、stock_status のような段階化済みフィールドのみ返す。厳密在庫値は checkout サーバ側でのみ使用する
- migrations/016_create_items_and_item_images_bucket.sql | item-images バケットが public=true の一括公開設定で、private 商品画像も URL が分かれば items.status に関係なく直接取得できる | private/published でバケットまたはパスを分離し、少なくとも private 商品画像は非公開バケットへ移し署名 URL 経由にする

## Recommended Changes

- src/app/api/items/[id]/route.ts と src/app/api/items/route.ts に公開 API 用の rate limit を導入し、連番 id や絞り込み条件を使った収集を抑制する
- src/app/api/cart/route.ts と src/app/api/wishlist/route.ts で item_id、quantity、color、size の Zod バリデーションを追加し、想定外型や過大 quantity を明示的に拒否する
- cart / wishlist / checkout の item 解決は共通の public item resolver に寄せ、published 条件と返却列を一元化する

## Residual Risks

- public.items には migration 上で公開 SELECT と admin ACL の RLS ポリシーが存在するが、現状の service role API がその防御を迂回している
- item 詳細 UI 自体では dangerouslySetInnerHTML や生 HTML 描画は確認できず、表示系の即時 XSS リスクは低い
- item 詳細の id は文字列のまま API に渡るが、Supabase クエリはパラメータ化されており SQL injection の直接リスクは見当たらない