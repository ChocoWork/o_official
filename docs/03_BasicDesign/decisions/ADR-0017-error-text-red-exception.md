# ADR-0017 取り出しの失敗の文だけは、モノクロの決まりの例外として赤で出す

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/features/news/components/PublicNewsGrid.tsx` | 基準コミット: `a03beaff`

## 概要

NEWS の部品が記事の取り出しに失敗した時の文だけを `text-red-500` の赤で出し、ほかの文はモノクロのままにする。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の NEWS |
| 対応する ID | DRV-NEWS-006 |
| 対象のコード | `src/features/news/components/PublicNewsGrid.tsx` |
| 関連文書 | `docs/05_Quality/reviews/uiux/uiux_review_news.md` |
| 要件の文書 | `docs/02_Requirements/areas/news.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0017 取り出しの失敗の文だけは、モノクロの決まりの例外として赤で出す

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-NEWS-006 |
| 根拠 | 大きな失敗の文をほかの文と同じ色にすると見落とされるため、読めるように最小限の赤を許す。モノクロの見た目を崩さないよう多用しない（uiux レビューの「あえて従わない」判断） |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_news.md` |

#### 背景

サイトの見た目はモノクロを原則にする。uiux の点検の決まり（implement-uiux）に従うと、失敗の文の赤もそろえる対象になる。

#### 決定

- 取り出しの失敗の文（`renderError`）だけを `text-red-500` で出す（`PublicNewsGrid.tsx`）
- 記事が無い時・絞った結果が0件の時の文は赤にしない（`PublicNewsGrid.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 失敗の文もモノクロにそろえる（implement-uiux の原則） | 大きな失敗が読み落とされる |

#### 結果

- 良くなること: 失敗が起きた時に利用者が気づける
- 見直す条件: 赤を使う所をほかに増やす時

## 未確認事項

- 無し
