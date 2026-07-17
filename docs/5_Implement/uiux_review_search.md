# SEARCH（検索）UI/UX レビュー

- 対象: [src/app/search/page.tsx](../../src/app/search/page.tsx) / 実体 [src/features/search/components/SearchPageClient.tsx](../../src/features/search/components/SearchPageClient.tsx)
- 共通 Header/Footer は [uiux_review_home.md](./uiux_review_home.md) を参照
- レビュー基準: `implement-uiux` + ブランド適合（[brand.md](../1_RequirementsDifinition/brand.md)）

---

## ステータス凡例

| ステータス | 意味 |
|---|---|
| 未対応 | 未着手 |
| 対応中 | 一部対応・設計検討中 |
| 対応済 | 修正完了 |

---

## ペルソナ適合サマリー

横断検索（商品/ルック/ニュース）。サジェスト・履歴・ハイライト・空状態の人気商品提示など**UXは充実**。ただし**配色と角丸が他ページと異質**で、ブランドの「静かで強い」モノクローム×シャープな世界観から浮いている。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| SR-1 | ハイライト/背景色（[SearchPageClient.tsx:54](../../src/features/search/components/SearchPageClient.tsx#L54) `#f2e6bf`、[336](../../src/features/search/components/SearchPageClient.tsx#L336)/[370](../../src/features/search/components/SearchPageClient.tsx#L370)/[384](../../src/features/search/components/SearchPageClient.tsx#L384) `#fafafa`/cream） | ハイライトのベージュ `#f2e6bf` 等、Key Color（黒/グレー/白）外の暖色が混入。準ペルソナA「色展開が派手」を嫌う。ブランド適合/反復 | ハイライトはモノトーン（下線/太字/淡グレー網掛け）へ。背景は白〜極淡グレーに統一 | Mid | 対応済 |
| SR-2 | 角丸（[SearchPageClient.tsx:90](../../src/features/search/components/SearchPageClient.tsx#L90) `rounded-2xl`、[348](../../src/features/search/components/SearchPageClient.tsx#L348) `rounded-full`、[370](../../src/features/search/components/SearchPageClient.tsx#L370)/[384](../../src/features/search/components/SearchPageClient.tsx#L384) `rounded-[28px]`） | 結果カード/ピル/枠が大きな角丸。サイト他所はシャープ基調で**視覚言語が不一致**。反復（一貫性）/ブランド適合 | サイトの角丸ポリシー（ほぼ直角〜`--radius`）に統一 | Mid | 対応済 |
| SR-3 | 見出し階層（[SearchPageClient.tsx:95](../../src/features/search/components/SearchPageClient.tsx#L95),[112](../../src/features/search/components/SearchPageClient.tsx#L112)） | セクション見出しが h2、結果カードのタイトルも h2 で**同階層が重複**。WCAG 1.3.1/2.4.6 | カードタイトルは h3 に降格 | Mid | 対応済 |
| SR-4 | エラー色（[SearchPageClient.tsx:367](../../src/features/search/components/SearchPageClient.tsx#L367) `#b42318`） | 他ページは `red-500/600`。検索だけ独自の赤トークンで不統一。反復 | エラー色を共通トークンに集約 | Low | 対応済 |
| SR-5 | 「VIEW PREVIEW ON HOME」（[SearchPageClient.tsx:420-426](../../src/features/search/components/SearchPageClient.tsx#L420-L426)） | 検索結果ページから、機能が下位のホームプレビューへ戻す導線。意図が伝わらず混乱。アフォーダンス | 削除、または「ホームに戻る」等の明確な意図に変更 | Low | 対応済 |
| SR-6 | サジェスト操作（[SearchPageClient.tsx:342-354](../../src/features/search/components/SearchPageClient.tsx#L342-L354)） | サジェスト/履歴がボタン群で、combobox/listbox の ARIA・上下キー選択が無い。キーボード操作性/アクセシビリティ | combobox パターン（aria-expanded/activedescendant）化を検討 | Low | 対応済 |
| SR-7 | ローディング（[SearchPageClient.tsx:381-382](../../src/features/search/components/SearchPageClient.tsx#L381-L382)） | 「検索中です…」テキストのみ。Doherty/反復 | 結果カードのスケルトンに | Low | 対応済 |

---

## 良い点（維持）

- **h1 を持ち**、横断検索の説明・タブ・履歴/サジェスト・ハイライト・空状態（人気商品提示）と、検索体験の基本を網羅。一覧ページが見習うべき情報設計。
- 検索語の URL 保持・履歴の localStorage 永続化で再訪体験が良い。
- 空/0件で「別キーワード提案 + 人気商品」を出す回復設計は implement-uiux 準拠。

---

## implement-uiux に「あえて従わない」判断

- **ハイライトの“目立たせ方”は色相に頼らない**: スキルは強調＝色を許すが、本ブランドはモノトーン純度を優先。SR-1 は網掛けより**下線/太字**で十分機能する。
- カード装飾（角丸/影）も**最小限**に。検索結果も他の一覧と同じ静かなトーンで揃える。

---

## 修正反映（2026-06-23）

- **SR-1**: ハイライト `mark` を `#f2e6bf` → `bg-black/10`+`font-medium`（モノトーン網掛け+太字）へ。各セクション/サジェストの cream `#fafafa` → `bg-black/[0.02]`（極淡グレー）に統一。
- **SR-2**: 結果カード `rounded-2xl`・サジェストパネル `rounded-2xl`・ピル `rounded-full`・空/開始セクション `rounded-[28px]` を全て角丸撤去（サイトのシャープ基調に統一）。
- **SR-3**: 結果カードのタイトルを `h2` → `h3` に降格（セクション h2 との重複解消）。
- **SR-4**: エラー色 `#b42318` → 共通の `text-red-600` + `role="alert"`。
- **SR-5**: 「VIEW PREVIEW ON HOME」リンク（機能下位のホームプレビューへ戻す混乱導線）を削除。
- **SR-6**: サジェスト/履歴ボタン群に `role="group"` + `aria-labelledby` を付与（ボタンは Tab/Enter で操作可能）。※完全な combobox（aria-activedescendant + 上下キー仮想フォーカス）は、現状の Tab 操作可能なボタン群で実用上充足するため、フォーカス管理の大規模化を避け本対応に留めた。
- **SR-7**: 「検索中です…」を結果カードのスケルトングリッドに置換。
- 実装: [src/features/search/components/SearchPageClient.tsx](../../src/features/search/components/SearchPageClient.tsx)。

---

## 総評（SEARCH）

機能・UXは高品質。課題は**ブランド表現の統一（SR-1 配色 / SR-2 角丸）**。検索ページだけ別デザイン言語になっているのを揃えれば、世界観の一貫性が回復する。
