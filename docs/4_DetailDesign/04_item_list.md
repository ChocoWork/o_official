# 1.4 商品一覧ページ（ITEM LIST）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ITEM-ALL-001 | 公開済み商品をカテゴリ・コレクション別に一覧表示する | IMPL-ITEM-LIST-001 | `src/app/item/page.tsx`, `src/features/items/components/PublicItemGrid.tsx` | `getPublishedItems()` で全公開商品を取得し `PublicItemGrid variant="catalog"` で表示。カテゴリ絞り込みはクライアント側の `selectedCategories` ステートで実施 | 済 |
| FR-ITEM-ALL-002 | 商品カードはカテゴリ・商品名・価格・サムネイルを表示し判別性を高める | IMPL-ITEM-LIST-002 | `src/features/items/components/PublicItemGrid.tsx` | カードにカテゴリ・商品名・価格・画像を表示（ラベル表示なし） | 済 |
| FR-ITEM-ALL-003 | URL ベースのカテゴリフィルタリングを実装しブラウザの戻る/進むで絞り込み状態を復元できるようにする | IMPL-ITEM-LIST-003 | `src/features/items/components/PublicItemGrid.tsx` | `useSearchParams` / `useRouter` でカテゴリをURL同期し、履歴復元に対応 | 済 |
| FR-ITEM-ALL-004 | サーバ側カテゴリ絞り込みを実装し `category` に基づく DB フィルタを行う | IMPL-ITEM-LIST-004 | `src/app/item/page.tsx`, `src/lib/items/public.ts`, `src/app/api/items/route.ts` | `searchParams` と `category` をサーバで解釈し、DBクエリに反映 | 済 |
| FR-ITEM-ALL-005 | 無限スクロール方式を採用し追加読み込みで結果を継続表示できるようにする | IMPL-ITEM-LIST-005 | `src/features/items/components/PublicItemGrid.tsx` | IntersectionObserver による追加ページ読込を実装 | 済 |
| FR-ITEM-ALL-006 | コレクション・サイズ・カラー・価格など複数属性で絞り込み可能とする | IMPL-ITEM-LIST-006 | `src/features/items/components/PublicItemGrid.tsx` | コレクション/サイズ/カラー/価格範囲フィルタをURL同期で実装 | 済 |
| FR-ITEM-ALL-007 | 一覧にソート機能を追加し新着順・価格昇順/降順・人気順などの切り替えを提供する | IMPL-ITEM-LIST-007 | `src/features/items/components/PublicItemGrid.tsx`, `src/app/api/items/route.ts` | `sort` クエリとUIセレクタでソート切替を実装 | 済 |
| FR-ITEM-ALL-008 | ITEM ページに `generateMetadata` を実装し `title` / `description` を設定する | IMPL-ITEM-LIST-008 | `src/app/item/page.tsx` | `generateMetadata` を追加し `title` / `description` を設定 | 済 |
| FR-ITEM-ALL-009 | `GET /api/items` でフィルタ/ソート対応の商品一覧 API を提供する | IMPL-ITEMS-LIST-API-01 | `src/app/api/items/route.ts`, `src/lib/items/public.ts` | クエリ検証（Zod）とフィルタ/ソート/ページング応答を実装 | 済 |
| FR-ITEM-ALL-010 | `GET /api/items/:id` で PDP 用の商品詳細データを取得する | IMPL-ITEMS-DETAIL-API-01 | `src/app/api/items/[id]/route.ts` | `useEffect` で fetch 済み | 済 |
| FR-ITEM-ALL-012 | ITEMS API に対して単体テストとパフォーマンステスト（目標: P95 < 200ms）を整備する | IMPL-ITEMS-TEST-01 | `tests/items/`, `e2e/FR-ITEM-ALL-012-items-api-performance.spec.ts` | Jest単体テストとPlaywright性能試験を追加 | 済 |
| FR-ITEM-ALL-013 | ITEMラベル（NEW / STANDARD 等）を非表示とし関連ロジックを削除する | IMPL-ITEM-LIST-013 | `src/features/items/components/PublicItemGrid.tsx` | バッジ描画と判定処理を削除 | 済 |
| FR-ITEM-ALL-014 | カテゴリ（ALL/TOPS/BOTTOMS/OUTERWEAR/ACCESSORIES）フィルタをDrawerに統合する | IMPL-ITEM-LIST-014 | `src/features/items/components/PublicItemGrid.tsx` | FILTER Drawer の COLOR セクション上に CATEGORY セクションを追加 | 済 |
| FR-ITEM-ALL-015 | COLLECTION フィルタで年範囲とAW/SS選択を可能にし、デフォルトで全年数かつAW/SS両方を対象にする | IMPL-ITEM-LIST-015 | `src/features/items/components/PublicItemGrid.tsx`, `src/app/api/items/route.ts`, `src/lib/items/collection-utils.ts` | `product_details` から年/季節を解析し、`collectionYearMin/Max` と `collectionSeasons` に対応 | 済 |
| FR-ITEM-ALL-016 | FILTER Drawer の PRICE UI を PRICE RANGE Slider に変更する | IMPL-ITEM-LIST-016 | `src/features/items/components/PublicItemGrid.tsx`, `src/components/ui/Slider.tsx` | Drawer 内のPRICE入力をレンジスライダーへ置換 | 済 |
| FR-ITEM-ALL-017 | FILTER Drawer の COLOR に色丸（スウォッチ）を表示する | IMPL-ITEM-LIST-017 | `src/features/items/components/PublicItemGrid.tsx` | Admin登録済み `colors[].hex` / `colors[].name` を利用してスウォッチ表示 | 済 |

### TODO（未要件）

- [x] FR-ITEM-ALL-002: カテゴリ表示と判別性バッジ（NEW / SALE / SOLD OUT）を商品カードに追加する
- [x] FR-ITEM-ALL-003: URL クエリとカテゴリフィルタの同期（戻る/進むで復元）を実装する
- [x] FR-ITEM-ALL-004: サーバ側カテゴリ絞り込み（`category`）を実装する
- [x] FR-ITEM-ALL-005: 無限スクロールで追加読み込みを実装する
- [x] FR-ITEM-ALL-006: コレクション・サイズ・カラー・価格の複数属性フィルタを実装する
- [x] FR-ITEM-ALL-007: 新着順・価格昇順/降順・人気順のソートを実装する
- [x] FR-ITEM-ALL-008: ITEM 一覧ページに `generateMetadata` を実装する
- [x] FR-ITEM-ALL-009: `/api/items` にフィルタ/ソート/ページングを実装する
- [x] FR-ITEM-ALL-012: ITEMS API の単体テストと性能テスト（P95 < 200ms 目標）を追加する
- [x] FR-ITEM-ALL-013: 商品カードのNEW/STANDARDなどのラベル表示を削除する
- [x] FR-ITEM-ALL-014: CATEGORYフィルタをFILTER Drawerへ追加しCOLORの上に配置する
- [x] FR-ITEM-ALL-015: COLLECTIONを年範囲 + AW/SS選択に対応させる（デフォルトは全年 + AW/SS）
- [x] FR-ITEM-ALL-016: PRICEフィルタをSlider UIへ変更する
- [x] FR-ITEM-ALL-017: COLORフィルタにカラーコード由来の色丸スウォッチを表示する

### 要件削除

- FR-ITEM-ALL-011 は要件から削除（本設計書・API仕様・試験対象から除外）

### 運用メモ

- BUG-PUBLIC-001: `src/app/api/items/route.ts` の数値クエリは未指定値を `0` に強制変換しないこと。`priceMin` / `priceMax` / `collectionYearMin` / `collectionYearMax` が `null` のまま解釈されないと、匿名一覧 API が意図せず空配列を返す。
- BUG-PUBLIC-001: wishlist 向け pre-request フック導入後は `private` schema の `USAGE` 権限が公開一覧 API にも波及する。`migrations/050_restore_public_read_access_after_pre_request_hook.sql` を公開一覧の前提条件として維持する。

### 修正計画（実装前）

1. サーバデータ取得層の拡張
  - `src/lib/items/public.ts` の取得関数を拡張し、`category`/`collection`/`size`/`color`/`priceMin`/`priceMax`/`sort`/`page`/`pageSize` を受け取れるようにする
2. ITEM 一覧ページのサーバ実装
  - `src/app/item/page.tsx` で `searchParams` を解釈し、サーバ側で初期フィルタ済みデータを取得
  - `generateMetadata` を実装
3. 一覧 UI の機能拡張
  - `src/features/items/components/PublicItemGrid.tsx` に URL 同期、複合フィルタ、ソート、無限スクロール、カテゴリ表示、バッジ表示を追加
4. API 拡張
  - `src/app/api/items/route.ts` でクエリバリデーション（Zod）とサーバ側フィルタ/ソート/ページングを追加
5. テスト整備
  - Playwright 要件別試験を追加
  - `tests/items/` に API 単体・性能テストを追加

### Playwright試験ファイル（要件別・実装前に作成）

- `e2e/FR-ITEM-ALL-001-published-items-list.spec.ts`
- `e2e/FR-ITEM-ALL-002-item-card-fields-and-badges.spec.ts`
- `e2e/FR-ITEM-ALL-003-category-query-sync-and-history.spec.ts`
- `e2e/FR-ITEM-ALL-004-server-category-filter.spec.ts`
- `e2e/FR-ITEM-ALL-005-infinite-scroll.spec.ts`
- `e2e/FR-ITEM-ALL-006-multi-attribute-filter.spec.ts`
- `e2e/FR-ITEM-ALL-007-sort-options.spec.ts`
- `e2e/FR-ITEM-ALL-008-item-list-metadata.spec.ts`
- `e2e/FR-ITEM-ALL-009-items-api-filter-sort.spec.ts`
- `e2e/FR-ITEM-ALL-010-item-detail-api.spec.ts`
- `e2e/FR-ITEM-ALL-012-items-api-performance.spec.ts`

---

## 依存関係

- CDN / オブジェクトストレージ: `item-images` Supabase Storage バケットで対応済み
- 検索インデックス基盤: 未整備

---

## データモデル（ITEMS-DATA）

> 元ファイル: `docs/2_Specs/02_items.md`

```sql
products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text,
  metadata    jsonb,
  created_at  timestamptz DEFAULT now()
);

skus (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  sku        text UNIQUE NOT NULL,
  price      integer NOT NULL,  -- 最小単位（円）で管理。浮動小数点禁止
  stock      integer NOT NULL DEFAULT 0
);
```

### バリデーションルール

| フィールド | ルール |
|-----------|-------|
| `products.title` | 必須、最大 255 文字 |
| `skus.price` | 整数（最小単位）、0 以上 |
| `skus.stock` | 整数、0 以上 |

---

## API 仕様（ITEMS-API）

| メソッド | パス | 概要 | NFR |
|---------|------|------|-----|
| GET | `/api/items` | 商品一覧取得（クエリ: `category`, `filters`, `sort`, `page`） | P95 < 200ms |
| GET | `/api/items/:id` | 商品詳細取得（バリアント含む） | P95 < 200ms |

---

## インデックス整合性・ソースオブトゥルース方針

- **Source of Truth**: 在庫・価格などの正確性は DB (Postgres) を根拠とする。検索インデックスやキャッシュは派生データ。
- **インデックス更新**: 商品・在庫更新は DB 書き込み後、非同期でインデックスを更新（イベントキュー + バックグラウンドジョブ）。インデックス遅延による一時的不整合は許容するが、注文確定は必ず DB の在庫で検証する。
- **リコンシリエーション（夜次）**:
  1. DB とインデックスの在庫値を比較する。
  2. 差分が閾値（在庫の 1%超 または 10 個超）を超える場合、自動修正候補としてマーク。
  3. 最新注文ログ・reservoir ログを参照し訂正の安全性を確認。
  4. 手動レビューが必要な場合はオペレータにタスクを作成。
