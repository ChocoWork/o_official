# ADR-0255 住所は地図を埋め込まず、Google Maps の検索へのリンクにする

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/stockist/components/PublicStockistGrid.tsx` | 基準コミット: `4facf63b`

## 概要

取扱店のカードの住所を Google Maps の検索へのリンクにし、新しいタブで開く。地図の埋め込みは置かない。UI/UX のレビュー（2026-06-23）で決めたが、要件 FR-STOCKIST-007（地図のリンクは WONT）と食い違う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | DRV-STOCKIST-002、SEC-STOCKIST-016、FR-STOCKIST-007 |
| 対象のコード | `src/features/stockist/components/PublicStockistGrid.tsx`、`src/features/stockist/services/public.ts` |
| 関連文書 | `docs/05_Quality/reviews/uiux/uiux_review_stockist.md`、`docs/05_Quality/reviews/security/security_review_stockist.md`、`docs/02_Requirements/requirements.md` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0255 住所は地図を埋め込まず、Google Maps の検索へのリンクにする

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-STOCKIST-002、SEC-STOCKIST-016 |
| 根拠 | 住所から道順へすぐ移れる来店の導線を作りつつ、外のサイトの地図の埋め込みを頁に置かないため。UI/UX のレビューで「住所のリンクで地図の導線を確保したので、埋め込みは要らない」と判断した。要件 FR-STOCKIST-007 は地図のリンクを WONT にしており、食い違うので推定 |
| 状態 | 推定 |
| 出どころ | `docs/05_Quality/reviews/uiux/uiux_review_stockist.md`（S-2 の修正反映）、`docs/05_Quality/reviews/uiux/uiux_review_stockist.md`（S-4 の修正反映） |

#### 背景

- UI/UX のレビューの S-2 は、住所が文字だけで来店の導線が切れると指摘した（`uiux_review_stockist.md`）
- S-4 は、コメントアウトのまま残った地図の埋め込みを、使うか消すか決めるよう求めた

#### 決定

- 住所を Google Maps の検索の URL へのリンクにし、住所は URL 用に符号化して入れる。新しいタブで開き、開いた先から元の頁を触れない印を付ける（`PublicStockistGrid.tsx`）
- 地図の埋め込みは消した（`uiux_review_stockist.md`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 地図を頁に埋め込む | 住所のリンクで導線が足りるので不要と判断した（`uiux_review_stockist.md`） |
| 住所を文字のまま出す | 来店の導線が切れる（S-2） |

#### 結果

- 良くなること: カードから道順へひと押しで移れる。外の地図を頁に読み込まない
- 悪くなること: 要件 FR-STOCKIST-007（`requirements.md`）と食い違い、E2E の FR-STOCKIST-007 は skip のまま。安全のレビューの「地図 URL は固定定数、動的な URL は作らない」（`security_review_stockist.md`）は今のコードと合わない。埋め込みの URL の定数は使われずに残る（`public.ts`）
- 見直す条件: FR-STOCKIST-007 の扱いをユーザーが決めた時

## 未確認事項

- FR-STOCKIST-007 の WONT と、レビューで足した地図のリンクのどちらを正とするか
