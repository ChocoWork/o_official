# ADR-0309 並び順の表示は消さずに注として残し、操作できる並べ替えを作るまで隠す

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/features/search/components/SearchPageClient.tsx` | 基準コミット: `4e84d5c5`

## 概要

結果の見出しの行の右の並び順の表示（RELEVANCE とシェブロン）を画面から隠した。並べ替えを作る時に戻せるよう、コードからは消さずに注（コメント）として残している。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | FREQ-196-REQ-01 |
| 対象のコード | `src/features/search/components/SearchPageClient.tsx` |
| 関連文書 | `docs/02_Requirements/requirements.md`（FREQ-191・FREQ-196）、`e2e/FR-SEARCH-006-two-column-redesign.spec.ts` |
| 要件の文書 | `docs/02_Requirements/areas/search.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0309 並び順の表示は消さずに注として残し、操作できる並べ替えを作るまで隠す

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-196-REQ-01 |
| 根拠 | 並び順の表示は RELEVANCE に決まっていて操作もできない飾りで、並べ替えの作り方も決まっていないため隠した。並べ替えを作る時に戻せるよう、消さずに注として残す（FREQ-196） |
| 状態 | 現行 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-196）、`src/features/search/components/SearchPageClient.tsx` の注 |

#### 背景

FREQ-191 は「SORT BY」を消して RELEVANCE だけを出すと決めた（`requirements.md`）。並べ替えの操作は無く、並びはアプリの点の順だけ（ADR-0303）。

#### 決定

- 並び順の表示の塊を注にした（`SearchPageClient.tsx`）
- この表示だけが使うシェブロンの定義と字の大きさの指定も注にした
- 「{件数} RESULTS」の表示は残した
- `ResultListHeader` の `showSort` は、戻す時のために受け取ったまま使わない（未使用（削除の判断待ち））

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| RELEVANCE を出したままにする（FREQ-191 の形） | 操作できない飾りになる（FREQ-196） |
| 表示のコードを消す | 並べ替えを作る時に作り直す手間になる（FREQ-196-REQ-01） |

#### 結果

- 良くなること: 押せない表示が無くなる
- 悪くなること: 使わない `showSort` と注のコードが残る（未使用（削除の判断待ち）の候補。`docs/05_Quality/reports/unused-code.md` の判断に回す）
- FREQ-191-AC-01（RELEVANCE が出る）は今は成り立たない

## 未確認事項

- 並べ替えを作るかどうか
