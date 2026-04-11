# 1.4 商品一覧ページ（ITEM LIST）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-ITEM-ALL-001 | 公開済み商品をカテゴリ・コレクション別に一覧表示する | IMPL-ITEM-LIST-001 | `src/app/item/page.tsx`, `src/features/items/components/PublicItemGrid.tsx` | `getPublishedItems()` で全公開商品を取得し `PublicItemGrid variant="catalog"` で表示。カテゴリ絞り込みはクライアント側の `selectedCategories` ステートで実施 | 済 |
| FR-ITEM-ALL-002 | 商品カードはカテゴリ・商品名・価格・サムネイルを表示しバッジで判別性を高める | IMPL-ITEM-LIST-002 | `src/features/items/components/PublicItemGrid.tsx` | カード内に `item.name`（h3）と `item.price` のみ表示。カテゴリ表示なし。バッジ（NEW / SALE / SOLD OUT）は未実装。Item 型にバッジ用フラグもない | 未 |
| FR-ITEM-ALL-003 | URL ベースのカテゴリフィルタリングを実装しブラウザの戻る/進むで絞り込み状態を復元できるようにする | IMPL-ITEM-LIST-003 | `src/features/items/components/PublicItemGrid.tsx` | `useSearchParams` / `useRouter` 未使用。URL との同期が未実装 | 未 |
| FR-ITEM-ALL-004 | サーバ側カテゴリ絞り込みを実装し `category` に基づく DB フィルタを行う | IMPL-ITEM-LIST-004 | `src/app/item/page.tsx`, `src/features/items/` | `getPublishedItems(limit?)` はカテゴリパラメータを受け付けない。ページ側でも `searchParams` を参照していない。全件取得後クライアントで絞り込む実装のまま | 未 |
| FR-ITEM-ALL-005 | 無限スクロール方式を採用し追加読み込みで結果を継続表示できるようにする | IMPL-ITEM-LIST-005 | `src/features/items/components/PublicItemGrid.tsx` | 未実装。全件を一括取得して表示 | 未 |
| FR-ITEM-ALL-006 | コレクション・サイズ・カラー・価格など複数属性で絞り込み可能とする | IMPL-ITEM-LIST-006 | `src/features/items/components/PublicItemGrid.tsx` | 未実装。カテゴリ（TOPS, BOTTOMS 等）のみクライアント側で絞り込み可能 | 未 |
| FR-ITEM-ALL-007 | 一覧にソート機能を追加し新着順・価格昇順/降順・人気順などの切り替えを提供する | IMPL-ITEM-LIST-007 | `src/features/items/components/PublicItemGrid.tsx` | 未実装 | 未 |
| FR-ITEM-ALL-008 | ITEM ページに `generateMetadata` を実装し `title` / `description` を設定する | IMPL-ITEM-LIST-008 | `src/app/item/page.tsx` | `generateMetadata` エクスポートがない。SEO 未対応 | 未 |

---

## 実装タスク管理 (ITEMS-01)

**タスクID**: ITEMS-01  
**ステータス**: 一部実装済  
**元ファイル**: `docs/tasks/02_items_ticket.md`

### API チェックリスト

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| ITEMS-01-001 | `GET /api/items` フィルタ/ソート対応 | IMPL-ITEMS-LIST-API-01 | `src/app/api/items/route.ts` | 全件取得のみ。サーバ側フィルタ未実装 | 未 |
| ITEMS-01-002 | `GET /api/items/:id` PDP データ取得 | IMPL-ITEMS-DETAIL-API-01 | `src/app/api/items/[id]/route.ts` | `useEffect` で fetch 済み | 済 |
| ITEMS-01-003 | `POST /api/items/:id/notify` 入荷通知登録 | IMPL-ITEMS-NOTIFY-01 | `src/app/api/items/[id]/notify/route.ts` | 未実装 | 未 |
| ITEMS-01-004 | 単体テスト + パフォーマンステスト（目標: 95% < 200ms） | IMPL-ITEMS-TEST-01 | `tests/items/` | 未実装 | 未 |

### 依存関係

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
| POST | `/api/items/:id/notify` | 入荷通知メール登録 | — |

---

## インデックス整合性・ソースオブトゥルース方針

- **Source of Truth**: 在庫・価格などの正確性は DB (Postgres) を根拠とする。検索インデックスやキャッシュは派生データ。
- **インデックス更新**: 商品・在庫更新は DB 書き込み後、非同期でインデックスを更新（イベントキュー + バックグラウンドジョブ）。インデックス遅延による一時的不整合は許容するが、注文確定は必ず DB の在庫で検証する。
- **リコンシリエーション（夜次）**:
  1. DB とインデックスの在庫値を比較する。
  2. 差分が閾値（在庫の 1%超 または 10 個超）を超える場合、自動修正候補としてマーク。
  3. 最新注文ログ・reservoir ログを参照し訂正の安全性を確認。
  4. 手動レビューが必要な場合はオペレータにタスクを作成。
