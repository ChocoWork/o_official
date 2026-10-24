# ADR-0251 都道府県は DB の列を持たず、住所の先頭の県名から決める

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `src/features/stockist/region.ts`、`src/features/stockist/components/PublicStockistGrid.tsx` | 基準コミット: `4facf63b`

## 概要

取扱店の表に県の列を足さず、住所の文字の先頭が47都道府県のどれで始まるかで店の県を決める。突き合わせの方法は要求の文が決めている。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の STOCKIST |
| 対応する ID | FREQ-57-REQ-01、FR-STOCKIST-010 |
| 対象のコード | `src/features/stockist/region.ts`、`src/features/stockist/components/PublicStockistGrid.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md`、`supabase/migrations/20260901102912_remote_schema.sql` |
| 要件の文書 | `docs/02_Requirements/areas/stockist.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0251 都道府県は DB の列を持たず、住所の先頭の県名から決める

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-57-REQ-01、FR-STOCKIST-010 |
| 根拠 | 絞り込みのために表と管理のフォームに県の欄を足さず、今ある住所の文字だけで県を決めるため。突き合わせの方法は FREQ-57-REQ-01 の「選択中の都道府県は店舗住所の先頭都道府県名と突き合わせる」が決めている |
| 状態 | 推定 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-57 の要求の行）、`docs/02_Requirements/requirements.md`（FR-STOCKIST-010） |

#### 背景

- 取扱店の表に県の列は無い（`remote_schema.sql`）。管理のフォームの欄は店舗名・住所・電話・営業時間・定休日と公開の状態だけ（DRV-STOCKIST-015）
- 日本の住所は県名から書くのが慣わし（`region.ts` のコメント）

#### 決定

- `region.ts` に8つの地方と47都道府県の対応を持つ（`region.ts`）
- 住所の前後の空白を除き、先頭が県名で始まるかで県を決める。見つからなければ「県なし」
- 「県なし」の店は、県を選んでいる間は出ない。何も選んでいない時は出る（`PublicStockistGrid.tsx`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 表に県の列を足し、管理で選ばせる | 移行とフォームの欄が増える（推定。記録は無い） |
| 住所を外のサービスで解析する | 外への依存が増える（推定。記録は無い） |

#### 結果

- 良くなること: DB と管理のフォームを変えずに絞り込みを足せた
- 悪くなること: 住所を県名から書いていない店（郵便番号や市から書いた店）は、県で絞ると出ない。管理のフォームと窓口はこの前提を確かめない
- 見直す条件: 住所の書き方がそろわない店が出た時

## 未確認事項

- 本番の店の住所が全部県名から始まっているか（DB は読んでいない）
