# Code Review: Item Page

Ready for Production: No
Critical Issues: 4

## Review Plan

1. Pass 1: フロントエンド、検索条件、XSS、情報露出
2. Pass 2: API、バックエンド、入力検証、認可、レート制限
3. Pass 3: DB、RLS、公開条件、Storage 公開範囲、監査

## Related Files

- src/app/item/page.tsx
- src/features/items/components/PublicItemGrid.tsx
- src/features/items/components/RelatedItems.tsx
- src/features/items/hooks/usePublicItems.ts
- src/app/api/items/route.ts
- src/app/api/items/[id]/route.ts
- src/lib/items/public.ts
- src/lib/items/collection-utils.ts
- migrations/016_create_items_and_item_images_bucket.sql
- migrations/023_add_acl_rbac_tables_and_policies.sql
- migrations/031_add_stock_quantity_to_items.sql
- migrations/032_create_search_indexes.sql
- docs/4_DetailDesign/04_item_list.md

## Priority 1 (Must Fix) ⛔

### 1. Public item detail API exposes raw inventory counts
- Files: src/app/api/items/[id]/route.ts, migrations/031_add_stock_quantity_to_items.sql
- Issue: 公開 API が `stock_quantity` をそのまま返しており、未認証クライアントが SKU 単位の在庫水準を推定できます。
- Why this matters: 競合調査、買い占めボット、再入荷監視の精度を上げる情報露出です。UI では SOLD OUT / LOW STOCK 程度の粗い状態しか使っていません。
- Suggested fix: API では `stock_quantity` を返さず、`stockState: 'unknown' | 'out' | 'low' | 'in'` のような集約値だけを返す。正確な在庫数は認可済みの管理 API に限定する。

### 2. Public list/detail APIs expose unnecessary internal metadata
- Files: src/lib/items/public.ts, src/app/api/items/[id]/route.ts
- Issue: 一覧 API と詳細 API が `status`, `created_at`, `updated_at` を未認証利用者へ返しています。
- Why this matters: 公開面に不要な内部運用情報を露出し、公開タイミング、更新頻度、運用パターンの推測を容易にします。
- Suggested fix: 公開 API 用 DTO を分け、一覧/詳細それぞれで UI に必要な最小フィールドだけを select する。

### 3. Public item images are stored in a fully public bucket without publication-state isolation
- Files: migrations/016_create_items_and_item_images_bucket.sql
- Issue: `item-images` バケットが `public = true` で作成されており、item の `status` と無関係にオブジェクト配信が可能です。
- Why this matters: 下書き・非公開商品でも画像 URL が分かれば直接参照でき、公開制御が DB の `status = 'published'` に閉じません。
- Suggested fix: バケットを private にして署名 URL で配信するか、公開済み assets 専用バケットへ分離する。少なくとも draft 用パスと published 用パスを分け、Storage policy で公開条件を明示する。

## Important Issues

### 4. Items APIs have no request throttling or abuse telemetry
- Files: src/app/api/items/route.ts, src/app/api/items/[id]/route.ts
- Issue: 未認証の一覧 API / 詳細 API にレート制限もアクセス監査もありません。
- Why this matters: カタログ全件スクレイピング、在庫ポーリング、ID 列挙を低コストで実行できます。公開 API でも bot 耐性は必要です。
- Suggested fix: IP / session / UA ベースの rate limit を追加し、超過時は 429 を返す。あわせて異常アクセスを監査ログやメトリクスへ送る。

### 5. Free-form filters are not fully schema-validated
- Files: src/app/api/items/route.ts
- Issue: `category`, `size`, `color`, `collection`, `collectionSeasons` は Zod で enum / length / character-set 検証されず、そのまま検索条件と後段フィルタに流れます。
- Why this matters: SQL injection ではないものの、極端に長い値や不正形式を許し、想定外の負荷・キャッシュ汚染・挙動不整合の入口になります。
- Suggested fix: クエリ全体を Zod object で定義し、カテゴリ enum、文字列長上限、配列要素数上限、許可文字を明示したうえで reject する。

## Residual Risk

- Pass 1 では React の自動エスケープにより直ちに exploitable な XSS は確認できませんでした。
- ただし公開 API と public bucket の組み合わせにより、スクレイピングと公開前 asset 露出の残留リスクは高めです。