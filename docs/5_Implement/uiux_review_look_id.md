# LOOK 詳細（/look/[id]）UI/UX レビュー

- 対象: [src/app/look/[id]/page.tsx](../../src/app/look/[id]/page.tsx)（gallery: [src/features/look/components/LookImageGallery.tsx](../../src/features/look/components/LookImageGallery.tsx)）
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

「ルックで惹いて、構成アイテムへ送客する」ページ。準ペルソナB（1枚で雰囲気）/C（写真映え・世界観）に効く。画像ギャラリー+STYLING ITEMS+前後ナビの構造は良好。**惜しいのは導線の一貫性（breadcrumb無し）と shop-the-look の弱さ、空descriptionの体裁**。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| LD-1 | 戻り導線（[look/[id]/page.tsx:70-74](../../src/app/look/[id]/page.tsx#L70-L74)） | item_id / news_id は breadcrumb があるのに本ページは「Back to Lookbook」リンクのみ。導線の一貫性欠如。Jakob/反復 | 他詳細ページと同じ breadcrumb（HOME > LOOK > テーマ）に統一 | Mid | 対応済 |
| LD-2 | テーマ説明（[look/[id]/page.tsx:91-95](../../src/app/look/[id]/page.tsx#L91-L95)） | `themeDescription` 空時に `' '`（半角空白）を表示。border-top+padding の**空ブロックが残る**視覚アーティファクト。整列/図と地 | 空なら当該セクションごと非表示にする | Mid | 対応済 |
| LD-3 | STYLING ITEMS（[look/[id]/page.tsx:106-118](../../src/app/look/[id]/page.tsx#L106-L118)） | 構成アイテムは個別リンクのみで、ルック全体の「まとめてカートに追加」(shop the look) が無い。準ペルソナBの「1枚で雰囲気」CVを取りこぼす。クロスセル | 「このルックの一式をカートへ」等の一括導線を検討 | Mid | 対応済 |
| LD-4 | not found（[look/[id]/page.tsx:44-55](../../src/app/look/[id]/page.tsx#L44-L55)） | 「Look not found」英語のみで素っ気ない。ブランドトーン/Peak-End（失敗体験の回復） | 日本語併記 + LOOK一覧/HOMEへのCTAを丁寧に | Low | 対応済 |
| LD-5 | 共有（ページ全体） | 写真映えを重視する準ペルソナC向けの共有（SNS/リンクコピー）導線が無い。ブランド適合（IG拡散） | 共有ボタン（モノトーン）を控えめに追加 | Low | 対応済 |
| LD-6 | currencyFormatter（[look/[id]/page.tsx:61-65](../../src/app/look/[id]/page.tsx#L61-L65)） | レンダー毎に生成（軽微なパフォーマンス） | モジュールスコープ化 | Low | 対応済 |

---

## 良い点（維持）

- 前後ルックナビ（PREV/NEXT）に `aria-label` 付き。連続性（continuity）を満たす良い回遊設計。
- STYLING ITEMS のクロスセル（List showcase）→ 各 /item へ。購入導線として正しい。
- `lg:grid-cols-2` の画像/情報分割、`leading-[2]` の説明文は世界観に適合。

---

## implement-uiux に「あえて従わない」判断

- **情報は最小限・画像主役を維持**: スペック羅列はせず、ルックの世界観→構成アイテムの順で“見せる”構成が本ページの正解。LD-3 の一括導線も**主張しすぎない**ボタンで。

---

## 修正反映（2026-06-23）

- **LD-1**: 「Back to Lookbook」を breadcrumb（HOME > LOOK > テーマ、`aria-current`）に統一。item_id/news_id と一貫化。
- **LD-2**: `themeDescription` が空（trim後）なら説明セクションごと非表示にし、空ブロックの罫線/余白アーティファクトを解消。
- **LD-3**: STYLING ITEMS を「SHOP THE LOOK」に再フレーミング（h2化）+ 補足文を追加し、クロスセル意図を明確化。**一括カート投入は現状見送り**: 本ビューの `PublicLookLinkedItem` はサイズ/在庫情報を持たず、商品はサイズ選択が必要で、CartContext に一括追加APIも無いため、誤バリアント投入を避ける判断。各アイテムの個別購入導線（→ /item/[id]）を維持。サイズ/在庫を含む一括導線は別途データ拡張時に対応。
- **LD-4**: not found を日本語見出し+説明に変更し、「LOOK 一覧へ」「ホームへ」CTAを丁寧に配置。
- **LD-5**: モノトーンの共有ボタン（汎用 [ShareButtons.tsx](../../src/components/ShareButtons.tsx)：X / LINE / リンクコピー）を控えめに追加。
- **LD-6**: `Intl.NumberFormat` をモジュールスコープへ移動。
- 実装: [src/app/look/[id]/page.tsx](../../src/app/look/[id]/page.tsx) / [src/components/ShareButtons.tsx](../../src/components/ShareButtons.tsx)。

---

## 総評（LOOK 詳細）

完成度は高い。**breadcrumb統一（LD-1）と空description対策（LD-2）** を最優先で、余力があれば shop-the-look（LD-3）でCVを取りにいく。
