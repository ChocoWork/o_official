# item 一覧 セキュリティレビュー

- 対象仕様: [docs/4_DetailDesign/04_item_list.md](../4_DetailDesign/04_item_list.md)
- レビュー観点: OWASP Top 10（A01/A03/A04/A05/A10）を中心に、列挙耐性・レート制限・公開条件・入力検証・キャッシュ・過剰データ返却・検索条件 fail-fast を重点確認

---

## ステータス凡例

|ステータス|意味|
|---|---|
| Open | 未修正 |
| Partially Fixed | 一部対処済みだが防御境界が不足 |
| Fixed | 修正済み |

---

## サマリ

- High: 1件（Open）
- Medium: 4件（Open）
- Low: 2件（Open）
- Fixed/N/A: 6件

`items` 一覧は公開条件（published）と基本的な入力検証は実装済みですが、**レート制限の信頼境界（IP ヘッダ信頼）**、**数値条件の fail-fast 不足**、**HTTP キャッシュ方針の未明示**、**一覧 API の過剰返却列**に改善余地があります。

---

## セキュリティレビュー結果

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/features/auth/middleware/rateLimit.ts](../../src/features/auth/middleware/rateLimit.ts) | `x-forwarded-for` / `x-real-ip` を無条件に信頼しており、配信構成によってはヘッダ偽装で IP ベース制限を回避可能 | 信頼済みプロキシ経由時のみ転送ヘッダを採用し、それ以外はプラットフォーム提供 IP を利用。公開 API は session/user 併用制限を追加 | Open | `getIpFromRequest()` がヘッダ値を直接採用。`GET /api/items` の `items:list` 制限品質に直結 | High |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | 数値条件（`page/pageSize/priceMin/priceMax/collectionYearMin/collectionYearMax`）で不正値を 400 拒否せず、既定値へフォールバックして fail-open になる | 数値パラメータも文字列と同様に Zod object で一括検証し、不正値は 400 で fail-fast | Open | `parseOptionalIntParam()` は parse 失敗時 `{ success: false }` を返し、呼び出し側で既定値に置換 | Medium |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | 範囲整合性チェックがなく、`priceMin > priceMax` / `collectionYearMin > collectionYearMax` を受理する | クロスフィールド検証（min <= max）を追加し、矛盾条件は 400 で拒否 | Open | 現状は矛盾条件でも処理継続し、結果空配列にフォールバック | Medium |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | `collectionSeasons` が `AW/SS` 以外でも正規表現を通過し、後段で空配列化されて「未指定扱い」になる（fail-open） | `AW`,`SS`,`AW,SS`,`SS,AW` のみ許可する厳格 enum/transform を導入し、無効値は 400 | Open | 例: `collectionSeasons=XYZ` が 400 にならず `selectedSeasons=[]` となり、季節フィルタなしで検索続行 | Medium |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | 一覧 API の HTTP キャッシュ方針が未明示で、共有キャッシュに署名 URL 付きレスポンスが保持される余地がある | `Cache-Control` を明示（例: `private, no-store` または要件に応じた短寿命方針）し、署名 URL TTL と整合 | Open | アプリ内 `Map` キャッシュ（30s）はあるが、レスポンスヘッダでの外部キャッシュ制御が未指定 | Medium |
| [src/lib/items/public.ts](../../src/lib/items/public.ts) | 一覧 API の取得列が UI 最小要件より広く、`description` / `image_urls` 等が未認証クライアントに返却される（過剰データ返却） | 一覧専用 DTO をさらに最小化し、必要列のみ返却。詳細情報は item 詳細 API に限定 | Open | `ITEM_SELECT_COLUMNS` は `description, image_urls, product_details` を含み、カード表示要件（カテゴリ/商品名/価格/サムネ）を超過 | Low |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | インメモリ `Map` キャッシュが件数上限なしで、クエリ組み合わせ増加時にメモリ圧迫リスク（可用性低下） | LRU/上限件数/期限掃除を追加し、DoS 耐性を強化 | Open | `itemsListResponseCache` は TTL のみで上限管理なし | Low |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | 一覧 API にレート制限・監査がない | `enforceRateLimit` + レート超過監査ログを実装して列挙耐性を上げる | Fixed | `items:list`（120 req/60s）適用、超過時 `logAudit(action='items.list', outcome='rate_limited')` を記録 | High |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | フィルタ文字列の入力検証が不足 | category enum + 長さ + 文字種を Zod で受け口検証し 400 拒否 | Fixed | `stringFilterSchema` で `category/size/color/collection/collectionSeasons` の形式検証を実施 | High |
| [src/lib/items/public.ts](../../src/lib/items/public.ts) | 公開条件（published）が API 層依存で DB 側と不一致 | API/DB 両層で `status='published'` を強制し二重防御 | Fixed | `getPublishedItemsPage()` で `.eq('status', 'published')`。加えて RLS policy（公開 SELECT）で published のみ許可 | High |
| [migrations/016_create_items_and_item_images_bucket.sql](../../migrations/016_create_items_and_item_images_bucket.sql) | 画像バケット公開設定により private item 画像露出の懸念 | private bucket + 署名 URL 配信へ変更 | Fixed | 後続 `migrations/044_harden_item_images_bucket_private.sql` で `public=false` 化済み。配信は署名 URL 化済み | High |
| [src/features/items/components/RelatedItems.tsx](../../src/features/items/components/RelatedItems.tsx) | 関連商品 category をそのままクエリへ渡しうる | allowlist 検証後のみクエリ反映 | Fixed | `ITEM_CATEGORIES` + `normalizeAllowedCategory()` により許可カテゴリのみ送信 | Medium |
| [src/app/api/items/[id]/route.ts](../../src/app/api/items/%5Bid%5D/route.ts) | 詳細 API の `id` 検証不足 | `z.coerce.number().int().positive()` で受け口検証 | Fixed | 不正 id は 400、`Cache-Control: no-store` も全分岐で適用 | Medium |

---

## 重点観点ごとの結論

1. 列挙耐性: **レート制限自体は実装済みだが、IP 信頼境界に課題（Open）**
2. レート制限: **`items:list` は適用済み。ただし識別子品質の改善が必要（Partially Fixed）**
3. 公開条件: **`status='published'` + RLS で防御できている（Fixed）**
4. 入力検証: **文字列は良好、数値・範囲整合・季節条件で fail-fast 不足（Open）**
5. キャッシュ: **アプリ内キャッシュはあるが HTTP キャッシュ方針未明示（Open）**
6. 過剰データ返却: **一覧 API で最小化余地あり（Open）**
7. 検索条件 fail-fast: **一部 fail-open（既定値フォールバック）を確認（Open）**

---

## 推奨対応順序

1. `rateLimit` の IP 信頼境界修正（High）
2. `/api/items` の数値・範囲・季節条件を厳格 fail-fast 化（Medium）
3. `/api/items` の `Cache-Control` 明示とキャッシュ設計統一（Medium）
4. 一覧 API の返却列最小化（Low）
5. `itemsListResponseCache` の上限管理（Low）

---

## 追加レビュー（2026-04-29, 差分）

### サマリー

- 追加 High: 0件
- 追加 Medium: 1件（Open）
- 追加 Low: 3件（Open）

既存指摘（入力 fail-fast、キャッシュ方針、IP 信頼境界）に加え、**SSR 直呼び経路での検証/制限の不一致**と、**関連サービス層の最小権限・情報露出の境界**を追加で確認しました。

### 表（追加指摘のみ）

| ファイル名 | よくない点 | 修正提案 | ステータス | 調査結果 | 優先度 |
|---|---|---|---|---|---|
| [src/app/item/page.tsx](../../src/app/item/page.tsx) | SSR の初回データ取得が `/api/items` を経由せず `getPublishedItemsPage()` を直接呼び、API 側で実装済みの入力検証・レート制限・監査境界と不一致 | SSR 側も API と同一の Zod スキーマを共有して検証するか、初回取得も `/api/items` 経由に統一して防御境界を一本化 | Open | `searchParams` を受け取り (`line 44`)、`getPublishedItemsPage()` を直接呼び出し (`line 49`)、`category/size` は API 層の Zod 検証を通らない | Medium |
| [src/lib/items/public.ts](../../src/lib/items/public.ts) | 公開一覧用途でも `createClient()` を使い、閲覧者 Cookie/Bearer を取り込みうる実装で最小権限原則に反する設計余地 | 公開 read 専用処理は `createPublicClient()` に寄せ、セッション非依存・匿名固定でデータアクセス境界を明確化 | Open | `getPublishedItems()` と `getPublishedItemsPage()` が `createClient()` を使用 (`line 31`, `line 63`)。公開用途としては匿名固定の方が安全 | Low |
| [src/lib/storage/item-images.ts](../../src/lib/storage/item-images.ts) | 署名 URL 生成失敗時に `rawUrl` をそのまま返し、private bucket のオブジェクトパス等の内部情報が公開 API 応答へ残る可能性 | 署名失敗時は `null` 返却またはプレースホルダ画像へフォールバックし、生 URL を返さない | Open | `signItemImageUrl()` が `return signedUrl ?? rawUrl` (`line 98`)。`signItemImageUrls()` でも同様に `rawUrl` を残す分岐あり | Low |
| [src/app/api/items/route.ts](../../src/app/api/items/route.ts) | バリデーション失敗時に `fieldErrors` をそのまま返し、攻撃者へ検証ルールの詳細を提供する可能性 | 外部向けは汎用エラーコードに抑え、詳細は監査ログ側のみ保持（本番では最小情報開示） | Open | `Invalid filter parameter` 応答に `parsedStringFilters.error.flatten().fieldErrors` を同梱 (`line 88`) | Low |

### 重点結論

1. 防御境界の一貫性: **`/api/items` と SSR 直呼びの検証ポリシーが分離しており、A04（Insecure Design）観点で改善余地あり**
2. 最小権限: **公開一覧サービスは匿名固定クライアント化で境界を明確にできる（A01 予防）**
3. 情報露出: **画像署名失敗時フォールバックと詳細バリデーションエラーは A09/A05 観点で縮小推奨**

### 推奨順序

1. SSR と API の入力検証境界を統一（Medium）
2. 公開一覧サービスを `createPublicClient()` 化（Low）
3. 署名 URL 失敗時の `rawUrl` 返却を停止（Low）
4. バリデーションエラー応答を最小化（Low）