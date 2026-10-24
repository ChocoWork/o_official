# ADR-0308 検索の履歴を端末に残さず、入力中の候補はサーバーの候補だけにする

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/features/search/components/SearchPageClient.tsx` | 基準コミット: `4e84d5c5`

## 概要

RECENT SEARCHES の表示を外し、表示のためだけにあった localStorage の `search.history` の保存と読み出しも一緒に外した。検索の画面は検索語を端末に保存しない。入力中の候補は `/api/suggest` の候補（ADR-0307）だけが担う。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | FREQ-189-REQ-01、SEC-SEARCH-011 |
| 対象のコード | `src/features/search/components/SearchPageClient.tsx`（localStorage・sessionStorage の呼び出しが無いことを検索で確かめた） |
| 関連文書 | `docs/02_Requirements/requirements.md`（FR-SEARCH-005 の廃止、FREQ-189）、`docs/05_Quality/reviews/security/security_review_search.md`、`e2e/FR-SEARCH-005-search-history.spec.ts` |
| 要件の文書 | `docs/02_Requirements/areas/search.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0308 検索の履歴を端末に残さず、入力中の候補はサーバーの候補だけにする

| 属性 | 値 |
| --- | --- |
| 上位 | FREQ-189-REQ-01、SEC-SEARCH-011 |
| 根拠 | RECENT SEARCHES の表示を消すと、`search.history` の保存は読み手がいなくなる。読み手のいない保存を残さないため、表示と一緒に保存と読み出しも外した（FREQ-189）。セキュリティのレビューは、平文の履歴が共有の端末に検索語を残すことを挙げていた |
| 状態 | 現行 |
| 出どころ | `docs/02_Requirements/requirements.md`（FREQ-189）、`docs/05_Quality/reviews/security/security_review_search.md` |

#### 背景

FR-SEARCH-005 は、検索の履歴を localStorage に残し、再訪の時に候補に出すと決めていた（`requirements.md`）。FREQ-189 がこれを廃止にした。

#### 決定

- 検索の入力欄の下の RECENT SEARCHES の見出しと履歴の候補を外した
- localStorage の `search.history` への保存と読み出しを外した。検索の画面は検索語を端末の保存の場所に書かない
- 入力中の候補は `/api/suggest` の SUGGESTIONS（FREQ-190、ADR-0307）だけにした

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 表示だけを外し、保存は残す | 読み手のいない保存が残る（FREQ-189-REQ-01） |
| 履歴を残したまま、期限や消す画面を付ける（レビューの提案） | 表示ごと外したので要らなくなった（推定） |

#### 結果

- 良くなること: 共有の端末で、前の利用者の検索語が残らない
- 残ること: 検索語は URL の `q` に残る。FR-SEARCH-001 が決めた形で、ブラウザの履歴に残る危険は受け入れている（`security_review_search.md`、Medium・Open）
- 食い違い: セキュリティのレビューの行（`security_review_search.md`）は Open のまま

## 未確認事項

- 撤去した時のコミット（git の履歴の文には FREQ-189 が見つからなかった）
