# STOCKIST（取扱店舗）UI/UX レビュー

- 対象: [src/app/stockist/page.tsx](../../src/app/stockist/page.tsx) / 実体 [src/features/stockist/components/PublicStockistGrid.tsx](../../src/features/stockist/components/PublicStockistGrid.tsx)（catalog variant）
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

ブランドは「EC直販中心・ポップアップは戦略的に」。STOCKIST は補助的だが、実物を確認したい層（高単価＝失敗したくない）には重要。カード設計は整っているが、**見出し不在・店舗への行動導線（地図/電話リンク）欠如**が惜しい。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| S-1 | catalog全体（[stockist/page.tsx:19-24](../../src/app/stockist/page.tsx#L19-L24)） | ページ見出し(h1)が無い（SectionTitleはhomeのみ）。現在地不明・h1欠如。視覚的階層 | 「STOCKIST」見出し(h1)+ 一言の説明を追加 | High | 対応済 |
| S-2 | 住所（[PublicStockistGrid.tsx:53-56](../../src/features/stockist/components/PublicStockistGrid.tsx#L53-L56)） | 住所がテキストのみで地図リンク無し。来店導線が切れる（Jakob: 店舗情報は地図/経路が期待される）。Fitts | 住所を Google Maps 検索/経路リンクの `<a>` 化 | High | 対応済 |
| S-3 | 電話（[PublicStockistGrid.tsx:57-60](../../src/features/stockist/components/PublicStockistGrid.tsx#L57-L60)） | 電話番号がテキストのみで `tel:` リンク無し。モバイルでタップ発信できない。Fitts/モバイル | `<a href="tel:...">` 化 | Mid | 対応済 |
| S-4 | 地図（[PublicStockistGrid.tsx:83-98](../../src/features/stockist/components/PublicStockistGrid.tsx#L83-L98)） | 地図埋め込みがコメントアウトされたまま放置。視覚的な所在の把握が出来ない | 必要なら地図を有効化、不要ならデッドコード削除（運用判断） | Low | 対応済 |
| S-5 | 空状態 | 店舗ゼロ件時の表示が無い（resolvedStockists が空でも何も出ない）。空状態設計 | 「現在取扱店舗はありません／ECで販売中」等の空状態+CTAを用意 | Mid | 対応済 |
| S-6 | カード行アイコン（[PublicStockistGrid.tsx:54-67](../../src/features/stockist/components/PublicStockistGrid.tsx#L54-L67)） | アイコンに `aria-hidden` 指定が無く、ラベル無しアイコンがSRに読まれうる。アクセシビリティ | 装飾アイコンに `aria-hidden="true"`、必要に応じ視覚的ラベル付与 | Low | 対応済 |
| S-7 | コンテンツ密度 | 店舗が少数だと3カラムで余白過多・寂しい印象。整列/余白バランス | 件数に応じカラム数を可変（少数は中央寄せ1〜2列） | Low | 対応済 |

---

## 良い点（維持）

- カードの identity → divider → 詳細行の構造、`stockist-card-*` トークンによる黄金比ベースの余白設計は端正でブランド適合。
- `hoverable` Card と抑制された装飾は世界観に合致。

---

## implement-uiux に「あえて従わない」判断

- **店舗を派手なカラーピン地図やバッジで飾らない**: モノクローム・静謐の世界観維持。地図を入れる場合もモノトーン基調のスタイルを優先。
- それ以外（地図/電話リンク・空状態・aria）はスキル指針どおり従うべき（実利アクションの欠落は世界観と無関係）。

---

## 修正反映（2026-06-23）

- **S-1**: `stockist/page.tsx` に「STOCKIST」h1 + 一言の説明を追加。
- **S-2**: 住所を Google Maps 検索リンク（`maps/search/?api=1&query=...`、`target=_blank` `rel=noopener noreferrer`）へ。
- **S-3**: 電話を `tel:`（非数字を除去）リンクへ。phone 空のときは行ごと非表示。
- **S-4**: コメントアウト放置の地図 iframe（未定義 `STOCKIST_MAP_EMBED_URL` 参照）を削除。S-2 の住所→Maps リンクで地図導線を確保したため埋め込みは不要と判断。
- **S-5**: 取扱店舗ゼロ件時に空状態（「現在、取扱店舗はございません。オンラインストアにて販売中です。」+ VIEW COLLECTION → /item）を表示。
- **S-6**: 4種の装飾アイコンに `aria-hidden="true"` を付与。
- **S-7**: 件数に応じカラム数を可変（1件=1列中央/2件=2列中央/3件以上=3列）。少数時の余白過多を解消。
- 実装: [src/features/stockist/components/PublicStockistGrid.tsx](../../src/features/stockist/components/PublicStockistGrid.tsx) / [src/app/stockist/page.tsx](../../src/app/stockist/page.tsx)。

---

## 総評（STOCKIST）

カード品質は高い。**見出し(h1)（S-1）と来店アクション（地図/電話リンク S-2/S-3）/空状態（S-5）** の追加で、補助ページとしての実用性が完成する。
