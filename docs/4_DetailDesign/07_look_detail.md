# 1.7 ルック詳細ページ（LOOK DETAIL）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-LOOK-DETAIL-001 | 公開済みルックの詳細ページを表示しテーマ・シーズンラベル・メインビジュアル・説明文を含める | IMPL-LOOK-DETAIL-001 | `src/app/look/[id]/page.tsx` | RSC でシーズンラベル（`formatLookSeason`）、`h1` にテーマ、メインビジュアル（`imageUrls[0]`）、`themeDescription` を表示 | 済 |
| FR-LOOK-DETAIL-002 | 紐づけ商品（STYLING ITEMS）を一覧表示し各商品への遷移リンクを提供する | IMPL-LOOK-DETAIL-002 | `src/app/look/[id]/page.tsx`, `src/components/ui/List.tsx` | `List` コンポーネントで商品名・カテゴリ・価格・画像を表示。`/item/${item.id}` へのリンク付き | 済 |
| FR-LOOK-DETAIL-003 | 前後のルックへのナビゲーションリンクを表示し連続して閲覧できるようにする | IMPL-LOOK-DETAIL-003 | `src/app/look/[id]/page.tsx` | `getPublishedLooks()` で全件取得後にインデックスで前後ルックを特定し PREV/NEXT リンクを表示（全件取得はパフォーマンス改善余地あり） | 済 |
| FR-LOOK-DETAIL-004 | 存在しないルック ID の場合はエラーメッセージと `/look` への戻るリンクを表示する | IMPL-LOOK-DETAIL-004 | `src/app/look/[id]/page.tsx` | `currentIndex < 0` で "Look not found" を表示し "Back to Lookbook" リンク（`href="/look"`）を提供 | 済 |
| FR-LOOK-DETAIL-005 | `currentLook.imageUrls` の複数画像をサムネイル付きギャラリーまたはカルーセルで表示する | IMPL-LOOK-DETAIL-005 | `src/app/look/[id]/page.tsx` | `imageUrls[0]`（1枚目）のみ表示。複数画像がある場合でも1枚しか表示されない | 未 |
| FR-LOOK-DETAIL-006 | `generateMetadata` を実装しページタイトルと description を設定する。また "Back to Lookbook" リンクと適切な `aria-label` を追加する | IMPL-LOOK-DETAIL-006 | `src/app/look/[id]/page.tsx` | `generateMetadata` エクスポートなし。正常時画面に "Back to Lookbook" リンクなし（404 時のみ存在）。PREV/NEXT リンクにも `aria-label` なし | 未 |
| FR-LOOK-DETAIL-007 | 同シーズンや関連コーディネートの推薦セクションを追加する（WONT） | — | — | 現フェーズ対象外。将来対応 | 未 |
