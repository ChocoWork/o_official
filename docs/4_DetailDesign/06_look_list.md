# 1.6 ルック一覧ページ（LOOK LIST）詳細設計

## 機能要件対応表

| 要件ID | 要件内容 | 実装ID | 実装対象ファイル | 実装概要 | 実装ステータス |
|--------|----------|--------|----------------|----------|--------------|
| FR-LOOK-ALL-001 | 公開済みルックをカードグリッドで一覧表示する | IMPL-LOOK-LIST-001 | `src/app/look/page.tsx`, `src/features/look/components/PublicLookGrid.tsx` | `PublicLookGrid variant="catalog"` で RSC として実装。`getPublishedLooks` でデータ取得しレスポンシブグリッド表示 | 済 |
| FR-LOOK-ALL-002 | ルックカードはシーズンラベル・テーマタイトル・メインビジュアル・紐づけ商品名を表示しクリックで詳細ページへ遷移する | IMPL-LOOK-LIST-002 | `src/features/look/components/PublicLookGrid.tsx` | `formatLookSeason` でシーズンラベル、`look.theme` でタイトル、メインビジュアル（`alt=look.theme`）、`look.linkedItems.map` で商品名リンクを表示 | 済 |
| FR-LOOK-ALL-003 | /look ページは全公開ルックをカタログ表示し少なくともページングまたは無限スクロールで6件以上を表示する | IMPL-LOOK-LIST-003 | `src/features/look/components/PublicLookGrid.tsx` | 全件を一括表示。件数制限・ページネーション未実装。データ量増加時のパフォーマンス改善が課題 | 済 |
| FR-LOOK-ALL-004 | HOME の LOOK セクションは `PublicLookGrid variant="home"` を使用し最大6件表示しつつ「VIEW LOOKBOOK」で一覧に誘導する | IMPL-LOOK-LIST-004 | `src/app/page.tsx`, `src/features/look/components/PublicLookGrid.tsx` | ホームページで `<PublicLookGrid variant="home" />` を使用。"VIEW LOOKBOOK" ボタン付き | 済 |
| FR-LOOK-ALL-005 | LOOK 一覧ページに `generateMetadata` を実装し SEO メタ情報を設定する | IMPL-LOOK-LIST-005 | `src/app/look/page.tsx` | `generateMetadata` エクスポートがない。SEO 未対応 | 未 |
| FR-LOOK-ALL-006 | シーズン別・テーマ別・アイテム別のフィルタやソート機能を追加する（WONT） | — | — | 現フェーズ対象外。将来対応 | 未 |
