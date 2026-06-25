# ITEM（商品一覧）UI/UX レビュー

- 対象: [src/app/item/page.tsx](../../src/app/item/page.tsx) / 実体 [src/features/items/components/PublicItemGrid.tsx](../../src/features/items/components/PublicItemGrid.tsx)（catalog variant）
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

コアペルソナは「数より質」で**1点を吟味して買う**層。一覧では**価格・在庫・カラー・素材感**を一目で比較したい。現状カードは画像+名前+価格のみで、在庫/カラー/コレクション等の判断材料が乏しく、比較検討に必要な情報が不足。絞り込み機能は非常に充実しているが、**結果の可視性（件数・適用中フィルタ・空状態の回復）**が弱い。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| I-1 | catalog全体（[item/page.tsx:59-68](../../src/app/item/page.tsx#L59-L68)） | ページ見出し(h1)が無い（SectionTitle は home variant のみ）。現在地が分からず、h1欠如はWCAG/SEOにも不利。視覚的階層/メンタルモデル | 一覧上部に「ITEM」見出し（h1）+ 任意でパンくず | High | 対応済 |
| I-2 | グリッド（[PublicItemGrid.tsx:1241-1252](../../src/features/items/components/PublicItemGrid.tsx#L1241-L1252)） | 絞り込み結果0件が「商品が見つかりません」の**テキストのみ**で、フィルタ解除の導線が無い。エラー回復/空状態に次アクション | 「条件をリセット」ボタン（resetDraftFilters）+ 解除のヒントを併設 | High | 対応済 |
| I-3 | カード価格（[PublicItemGrid.tsx:822-832](../../src/features/items/components/PublicItemGrid.tsx#L822-L832)） | 価格が `--lk-size-3xs`（極小）。価格は購入意思決定の中核情報（PSM分析の要）。可読性/対比（部分的逸脱の対象） | 価格は最低でも商品名と同等以上のサイズへ。名前と価格のコントラストを付ける | Mid | 対応済 |
| I-4 | カード（[PublicItemGrid.tsx:796-833](../../src/features/items/components/PublicItemGrid.tsx#L796-L833)） | SOLD OUT/在庫・カラー数がカードに非表示（在庫は内部判定のみ）。一覧での比較情報不足。図と地/情報設計 | 在庫切れバッジ、カラー数 or スウォッチ、コレクション(SS/AW)を控えめに表示 | Mid | 対応済 |
| I-5 | 結果可視性（フィルタ適用後） | 件数表示・適用中フィルタのチップが無く、何で絞っているか・何件かが分からない（特にモバイルはドロワーを閉じると不可視）。Visibility of system status | 「○件」表示 + 適用中フィルタのチップ（×で個別解除） | Mid | 対応済 |
| I-6 | ローディング（[PublicItemGrid.tsx:1259-1263](../../src/features/items/components/PublicItemGrid.tsx#L1259-L1263)） | 追加読込が「読み込み中...」テキスト。NEWSはスケルトン実装済みで**一貫性が無い**。反復/Doherty/CLS | スケルトンカードに統一（NewsGridのパターン流用） | Mid | 対応済 |
| I-7 | 無限スクロール終端 | hasMore=false の時の終端表示が無く「これで全部」か不明。閉合（Closure） | 末尾に控えめな終端表示（罫線/「以上」）を追加 | Low | 対応済 |
| I-8 | 画像なし（[PublicItemGrid.tsx:808-812](../../src/features/items/components/PublicItemGrid.tsx#L808-L812)） | フォールバックが `object-cover` クラス付きの素の div に「No Image」。レイアウト崩れ・未スタイル。反復 | プレースホルダ画像 or 中央寄せの体裁を整える | Low | 対応済 |
| I-9 | カードホバー | hover で scale-105 のみ。クイックビュー/ウィッシュ追加など軽い操作余地が無い（任意）。インタラクション | 任意: ホバー時にウィッシュリスト ♡ を控えめに表示 | Low | 対応済 |

---

## 良い点（維持）

- カテゴリ/カラー/在庫/サイズ/シーズン/価格レンジの多面的フィルタは高機能。`IntersectionObserver` の無限スクロールは Doherty 的に良。
- カード全体をリンク化（大ターゲット）で Fitts 良好。`group-hover:scale-105`/duration-500 の抑制演出はブランド適合。
- 絞り込みドロワーの `aria-haspopup`/`aria-expanded` 付与は適切。

---

## implement-uiux に「あえて従わない」判断

- **価格・名前を派手に強調しない**: スキルは対比強調を促すが、本ブランドは静謐さが命。I-3 は「極端な拡大や色付け」ではなく、**サイズ階層を1〜2段だけ整える**“最小限の可読性確保”に留める。
- **フィルタを常時展開のサイドバーで見せる現状は維持**（Hick より一覧性を優先しても良い領域。プロ顧客の比較行動に合致）。
- 16px下限はラベル類で適用しない（ブランドの editorial タイポ維持）。ただし価格は意思決定情報のため例外的に底上げ（I-3）。

---

## 修正反映（2026-06-23）

- **I-1**: `item/page.tsx` に「ITEM」h1 + パンくず（HOME > ITEM）を追加。
- **I-2**: 0件時に適用中フィルタがあれば「条件をリセット」ボタン（全フィルタ解除・sort維持）を併設。
- **I-3**: カード価格を `--lk-size-3xs` → `--lk-size-2xs`（商品名と同等）に底上げし、`text-black font-medium` で名前とのコントラストを付与。
- **I-4**: catalog カードに SOLD OUT バッジ（`!isItemInStock`）/カラースウォッチ（最大4 + 残数）/コレクション（SS/AW）を控えめに表示。home の curated 表示には影響させない（catalog 限定）。
- **I-5**: グリッド上部に「件数 + 適用中フィルタのチップ（×で個別解除）」バーを追加（カテゴリ/カラー/サイズ/コレクション/シーズン/在庫/価格）。`updateQuery` でURL同期解除。
- **I-6**: 追加読み込みの「読み込み中...」を NEWS と同様のスケルトンカードに統一。
- **I-7**: `!hasMore` 時に終端表示「ALL ITEMS SHOWN」（罫線付き）を追加。
- **I-8**: 画像なしフォールバックを中央寄せの「NO IMAGE」プレースホルダに整形。
- **I-9（任意・見送り）**: ホバー時のウィッシュ♡は、エディトリアルグリッドの静けさ維持（ブランド restraint）と、アンカー内インタラクティブ要素の複雑化回避のため**意図的に非採用**。ウィッシュ追加は商品詳細ページ（PDP）に集約する方針を確定。
- 実装: [src/features/items/components/PublicItemGrid.tsx](../../src/features/items/components/PublicItemGrid.tsx) / [src/app/item/page.tsx](../../src/app/item/page.tsx)。

---

## 総評（ITEM）

機能は充実。改善の核は**「現在地（h1）・結果の可視化（件数/フィルタチップ）・空状態の回復（リセット）・価格の可読性」**。これらは比較検討する高LTV層の体験を直接底上げする。
