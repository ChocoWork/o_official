# ADR-0311 検索は関数が 1 つでも失敗したら全体を失敗にする

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `src/features/search/services/search.service.ts`、`src/app/api/search/route.ts` | 基準コミット: `413d8b36`

## 概要

`/api/search` が呼ぶ 3 つの検索関数（`search_items`・`search_looks`・`search_news`）のうち 1 つでも失敗したら、取り出しの関数 `executeSearch` が `SearchBackendError` を投げ、窓口は固定の文の 500 を返す。画面は既存の失敗の表示（「検索結果を読み込めませんでした」）を出す。候補の窓口 `/api/suggest` は添え物なので、失敗した種別を飛ばして成功した種別で返し、失敗した関数名と符号を記録する。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | DRV-SEARCH-003、SEC-SEARCH-017、SEC-SEARCH-018、THR-SEARCH-017 |
| 対象のコード | `src/features/search/services/search.service.ts`（`SearchBackendError`・`executeSearch`・`getSearchSuggestions`）、`src/app/api/search/route.ts` |
| 関連文書 | `docs/02_Requirements/areas/search.md`、`docs/05_Quality/security/threats/search.md`、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`（Q17） |
| 調べた時点 | 2026-10-26（単体・結合の試験で確かめた。本番ビルドの画面は E2E `FR-SEARCH-022` が確かめる。流していない） |

## 判断

### ADR-0311 検索は関数が 1 つでも失敗したら全体を失敗にする

| 属性 | 値 |
| --- | --- |
| 上位 | DRV-SEARCH-003、SEC-SEARCH-017、SEC-SEARCH-018 |
| 根拠 | 一部の種別だけ失敗したのに残りを検索結果として返すと、見つからないのか障害なのか利用者にも運用にも区別がつかない。権限の誤り（EXECUTE を外した時など）も長く見過ごされる。1 種別でも失敗なら全体を失敗にする案を、ユーザーの承認（2026-10-26 の既定で進める物の Q17）で採った |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/wave1c-decisions.md`、`design-final.md`（R14） |

#### 背景

- 以前は、失敗した種別を空として扱い、全部が空なら「検索結果はありません」になった（DRV-SEARCH-003 の旧い決まり）
- 失敗の記録は Supabase の誤りを丸ごと `console.error` に渡しており、検索語が入りうる（SEC-SEARCH-018）

#### 決定

- `executeSearch` は 3 つの結果を見て、誤りがあれば失敗した関数ごとに `{ fn, name, code }`（`describeErrorForLog` で名前と符号だけにした物）を 1 回ずつ記録し、最初の失敗の `SearchBackendError`（`fn`・`code` だけを持つ）を投げる
- 窓口は `{ error: 'Failed to search content' }` の 500 を返し、記録は名前と符号だけにする。検索語・誤りの文は応答にも記録にも出さない
- 語が空の時は検索の関数を呼ばないので、失敗にならない
- `getSearchSuggestions` は投げない。失敗した種別の関数名と符号を記録して、成功した種別の候補を返す
- 人気商品の関数の失敗は、空の一覧で続けるまま（記録は名前と符号だけ）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| 失敗した種別だけ空にして、200 に失敗の印（`partial: true`）を付ける | 窓口の応答の形と画面の見せ方が増える。決定にない設定項目・画面を作らない |
| 3 つとも失敗した時だけ失敗にする | 1 つだけの失敗（EXECUTE を 1 関数だけ外した時など）が長く見過ごされる |

#### 結果

- 良くなること: 障害が「検索結果はありません」に隠れず、画面と運用の両方で気づける
- 悪くなること: 1 種別だけの一時的な失敗でも検索全体が失敗として見える（再読み込みで直る）

## 未確認事項

- 本番で関数の EXECUTE を外した時の画面（E2E `FR-SEARCH-022` の `SEC-SEARCH-017-AC-01` は書いたが流していない）
