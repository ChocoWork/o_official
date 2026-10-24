# ADR-0012 一覧の分類の絞り込みは左のサイドバーの複数選択にし、横のタブにしない

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/features/news/components/PublicNewsGrid.tsx` | 基準コミット: `a03beaff`

## 概要

NEWS の一覧の分類の絞り込みは、ITEM・LOOK と同じ左のサイドバー（モバイル・タブレットは FILTER の引き出し）の複数選択にする。上の横のタブにする案は採らない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | DRV-NEWS-001、FREQ-48-REQ-01、FREQ-119-REQ-01、FR-NEWS-ALL-002 |
| 対象のコード | `src/features/news/components/PublicNewsGrid.tsx` |
| 関連文書 | `docs/05_Quality/reviews/uiux/uiux_review_news.md`、`docs/03_BasicDesign/ui/screen-list.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0012 一覧の分類の絞り込みは左のサイドバーの複数選択にし、横のタブにしない

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-NEWS-001、FREQ-48-REQ-01、FREQ-119-REQ-01、FR-NEWS-ALL-002 |
| 根拠 | ITEM・LOOK の一覧と同じ、直近まで調整を続けたサイドバーのフィルターにそろえるため。NEWS は分類が多いのでサイドバーが空きすぎず、NEWS だけ横のタブに変えると一覧どうしのそろいが崩れる（uiux レビューの「あえて従わない」判断） |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_news.md` |

#### 背景

uiux のレビュー（N-5）は、分類のサイドバーが空いて左右が釣り合わないとして、上の横のタブかセグメントにする案を出した。

#### 決定

- デスクトップは左の sticky のサイドバー、モバイル・タブレットは FILTER の引き出しに、`MultiSelect` で ALL と分類を並べる（`PublicNewsGrid.tsx`）
- 複数を選べ、ALL とは一緒に選べない（`PublicNewsGrid.tsx`、DRV-NEWS-001）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 上の横のタブ・セグメント（uiux N-5 の提案） | 一覧どうしのそろいが崩れる。NEWS は分類が多いのでサイドバーが空きすぎない |

#### 結果

- FREQ-47・48・49・119・274 で、FILTER のボタン・選択肢・幅・余白を ITEM にそろえ続けている
- 食い違い: 詳細設計 `docs/04_DetailDesign/pages/02_news_list.md` と要件の表 `docs/02_Requirements/requirements.md` は「タブ」と書く
- 見直す条件: ITEM・LOOK のフィルターの形を変える時

## 未確認事項

- 無し
