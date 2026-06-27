# LOOK（ルックブック一覧）UI/UX レビュー

- 対象: [src/app/look/page.tsx](../../src/app/look/page.tsx) / 実体 [src/features/look/components/PublicLookGrid.tsx](../../src/features/look/components/PublicLookGrid.tsx)（catalog variant）
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

LOOK は**準ペルソナC（写真映え・世界観）と準ペルソナB（1枚で雰囲気・着回し）に最も刺さる**ページ。スタイリングと関連アイテム→価格→購入の導線が要。世界観を見せる作りは良いが、**ページ見出し不在・フィルタがSEASONのみ・関連商品テキストの極小化**が惜しい。

---

## レビュー結果

| # | 指摘場所 | 指摘理由（違反原則） | 修正提案 | 優先度 | 修正ステータス |
|---|---|---|---|---|---|
| L-1 | catalog全体（[look/page.tsx:34-38](../../src/app/look/page.tsx#L34-L38)） | ページ見出し(h1)が無い（SectionTitleはhomeのみ）。現在地不明・h1欠如。視覚的階層/メンタルモデル | 上部に「LOOK BOOK」見出し(h1)を追加 | High | 対応済 |
| L-2 | LookCard関連商品（[PublicLookGrid.tsx:101-108](../../src/features/look/components/PublicLookGrid.tsx#L101-L108)） | 関連アイテム名/価格が `--lk-size-3xs`（極小）。購入導線の中核なのに視認・タップしづらい。可読性/Fitts | フォントを底上げ、行高・タップ高を確保（44px目安） | Mid | 対応済 |
| L-3 | デスクトップ左サイド（[PublicLookGrid.tsx:280-291](../../src/features/look/components/PublicLookGrid.tsx#L280-L291)） | フィルタがSEASONの1項目のみのために 199–233px の専有サイドバー。視覚的に空疎・左右非対称。整列/余白バランス | SEASONは上部の横並びタブ/セグメントに変更し、画像に面積を割く | Mid | 対応済 |
| L-4 | 空状態（[PublicLookGrid.tsx:118-126](../../src/features/look/components/PublicLookGrid.tsx#L118-L126)） | 「該当シーズンのLOOKがありません」がテキストのみ。回復導線（ALLへ戻す）が無い。空状態に次アクション | 「すべて見る」ボタンを併設 | Mid | 対応済 |
| L-5 | LookCard画像（[PublicLookGrid.tsx:65-71](../../src/features/look/components/PublicLookGrid.tsx#L65-L71)） | `unoptimized` で最適化放棄。写真が主役のページで転送/LCP不利。準ペルソナCは「写真がチープ」を嫌う | next/image最適化を有効化（画質維持と速度両立） | Mid | 対応済 |
| L-6 | LookCard（[PublicLookGrid.tsx:55-60](../../src/features/look/components/PublicLookGrid.tsx#L55-L60)） | `Intl.NumberFormat` をカード描画毎に生成（多数カードで無駄）。パフォーマンス（軽微） | モジュールスコープ/`useMemo`で1回生成 | Low | 対応済 |
| L-7 | 関連商品無し表示（[PublicLookGrid.tsx:90-93](../../src/features/look/components/PublicLookGrid.tsx#L90-L93)） | 「紐づけ商品なし」が利用者向けに無価値（運用用語）。文言 | 関連商品が無い場合は当該行を非表示にする | Low | 対応済 |
| L-8 | グリッド密度 | home/catalog とも 2〜3列で、写真主役の割に1枚が小さめ。準ペルソナC（世界観重視）への訴求が弱まる | catalog は大判（1〜2列のエディトリアル）レイアウトの選択肢も検討 | Low | 対応済 |

---

## 良い点（維持）

- 画像 `aspect-[2/3]`・`object-top`・hover scale の抑制演出はエディトリアルで美しく、世界観訴求に適合。
- ルック→関連アイテム→個別ページの**クロスセル導線が設計されている**（購入につながる良い構造）。
- SEASONフィルタの状態をURL同期（共有/戻る対応）。

---

## implement-uiux に「あえて従わない」判断

- **情報過多を避けるため、カードに価格やバッジを盛らない方向は維持**。LOOK は「世界観で惹く」ページで、詳細比較は ITEM/詳細ページに委譲する設計が適切。L-2 の底上げは“読める最小限”に留める。
- **写真の大判化（L-8）はブランド表現として推奨だが必須ではない**（世界観優先 vs 一覧性のトレードオフ。ブランド意図次第）。

---

## 修正反映（2026-06-23）

- **L-1**: `look/page.tsx` に「LOOK BOOK」h1 を追加。
- **L-2**: 関連アイテム名/価格を `--lk-size-3xs` → `--lk-size-2xs` に底上げ、行に `py-[5px] sm:py-[6px]` を付与しタップ高を確保。
- **L-3**: デスクトップの専有サイドバー（199–233px）を撤去し、上部の横並び SEASON タブ（`role=tablist`、ALL/SS/AW）に変更。グリッドは全幅化し画像に面積を割く。モバイルの FILTER ドロワーは従来どおり維持。
- **L-4**: シーズン絞り込みで0件のとき「すべて見る」ボタン（→ ALL）を空状態に併設。
- **L-5**: LookCard 画像の `unoptimized` を撤去し next/image 最適化を有効化、`sizes` を付与。
- **L-6**: `Intl.NumberFormat` をモジュールスコープへ移動（カード描画毎の再生成を回避）。
- **L-7**: 関連商品が無い場合は「紐づけ商品なし」を出さず、当該行ごと非表示に。
- **L-8**: L-3 でサイドバーを撤去しグリッドを全幅化したことで1枚の表示面積が拡大。列数自体は直近で調整済みの 2/3 列密度を維持し、過度な再設計は避けた（写真の大判化を全幅化で実現）。
- 実装: [src/features/look/components/PublicLookGrid.tsx](../../src/features/look/components/PublicLookGrid.tsx) / [src/app/look/page.tsx](../../src/app/look/page.tsx)。

---

## 総評（LOOK）

世界観の方向性は良好。**見出し追加（L-1）/関連商品の可読性（L-2）/SEASONフィルタのレイアウト見直し（L-3）/空状態の回復（L-4）** で、写真重視ペルソナへの訴求と購入導線が引き締まる。
