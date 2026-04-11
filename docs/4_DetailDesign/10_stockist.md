# 1.10 商品扱い店舗ページ（STOCKIST）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-STOCKIST-001 | 公開済みのストックリストを `PublicStockistGrid variant="catalog"` で表示しレスポンシブグリッドレイアウトに対応する | IMPL-STOCKIST-001 | `src/app/stockist/page.tsx`, `src/features/stockist/components/PublicStockistGrid.tsx` | `PublicStockistGrid` は RSC で `getPublicStockists()` を呼び出し `grid-cols-1 sm:grid-cols-2 xl:grid-cols-3` でレスポンシブ表示 | 済 |
| FR-STOCKIST-002 | 各ストックリストカードに店舗名・住所・電話番号・営業時間・定休日を含め店舗情報を判別しやすくする | IMPL-STOCKIST-002 | `src/features/stockist/components/PublicStockistGrid.tsx` | `Card` コンポーネントで `shop.name`（h2）、`shop.address`、`shop.phone`、`shop.time`、`shop.holiday` を Remixicon アイコン付き行として表示 | 済 |
| FR-STOCKIST-003 | Supabase の `stockists` テーブルから `status = 'published'` の店舗データを取得し取得失敗時は空状態またはエラーハンドリングを行う | IMPL-STOCKIST-003 | `src/features/stockist/services/public.ts` | `getPublicStockists()` で `.eq('status', 'published')` フィルタを適用 | 済 |
| FR-STOCKIST-004 | HOME 用 `PublicStockistGrid variant="home"` は最大6件を優先表示しモバイルでは上位3件を表示してタブレット以上で全件を見せる | IMPL-STOCKIST-004 | `src/app/page.tsx`, `src/features/stockist/components/PublicStockistGrid.tsx`, `src/features/stockist/services/public.ts` | `getHomePublicStockists()` が `limit: 6` で最大6件を取得。コンポーネント側では `mobileLimit = 3` でモバイル3件・タブレット以上で全件表示 | 済 |
| FR-STOCKIST-005 | STOCKIST ページに `generateMetadata` で `title` / `description` を設定する | IMPL-STOCKIST-005 | `src/app/stockist/page.tsx` | `generateMetadata` エクスポートがない。SEO 未対応 | 未 |
| FR-STOCKIST-006 | 都道府県/エリア別フィルター・キーワード検索・ソート・ページネーションを提供する（WONT） | — | — | 現フェーズ対象外。将来対応 | 未 |
| FR-STOCKIST-007 | ストックリストカードに Google Maps リンク・外部リンク・取扱カテゴリ・店舗画像またはロゴを含める（WONT） | — | — | 基本情報のみ。Maps リンク等は現フェーズ対象外 | 未 |
| FR-STOCKIST-008 | カードのキーには `shop.name` ではなく `id` やユニークキーを使用しスクリーンリーダー対応を改善する | IMPL-STOCKIST-006 | `src/features/stockist/components/PublicStockistGrid.tsx`, `src/features/stockist/types.ts` | `key={shop.name}` を使用。`PublicStockist` 型に `id` が含まれていないため型の見直しが必要。`StockistRecord` には `id` が存在する | 未 |
