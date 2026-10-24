# ADR-0300 検索の語は DB の関数の引数で渡し、フィルタの文字列につながない

> 状態: 現行 | 確認日: 2026-10-24 | 対象: `src/features/search/services/search.service.ts`、`src/app/api/search/route.ts`、`src/app/api/suggest/route.ts` | 基準コミット: `4e84d5c5`

## 概要

検索とサジェストは、利用者の語を PostgREST の `.or()` の文字列につながず、DB の検索の関数（`search_items`・`search_looks`・`search_news`）の引数として渡す。関数は ILIKE に使う前に `%`・`_` を逃がす。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | SEC-SEARCH-003、FR-SEARCH-003、NFR-SEC-007（範囲外） |
| 対象のコード | `src/features/search/services/search.service.ts`、`supabase/migrations/20260901102912_remote_schema.sql`（範囲外の DB） |
| 関連文書 | `docs/05_Quality/reviews/code/2026-04-18-search-review.md`、`migrations/048_create_search_rpc_functions.sql` |
| 要件の文書 | `docs/02_Requirements/areas/search.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0300 検索の語は DB の関数の引数で渡し、フィルタの文字列につながない

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-003、FR-SEARCH-003、NFR-SEC-007（範囲外） |
| 根拠 | 2026-04-18 のレビューが、`.or()` に語をつなぐ作りを「フィルタの構文の注入」として Must Fix にしたため。語を関数の引数にすれば、`,`・`)` などの記号を含む語でも条件の形を書き換えられない（NFR-SEC-007 のパラメータ化したクエリを検索に当てはめた） |
| 状態 | 現行 |
| 出どころ | `docs/05_Quality/reviews/code/2026-04-18-search-review.md`、`migrations/048_create_search_rpc_functions.sql` |

#### 背景

前の作りは、`buildLikePattern()` で `%`・`_` だけを除いた語を `.or(...)` の文字列につないでいた。PostgREST のフィルタで意味を持つ `,`・`)` を止めておらず、条件の改変・広すぎる検索・誤りの出方からの観測ができた（レビュー）。

#### 決定

- 検索とサジェストは3つの関数を `supabase.rpc` で呼び、語を `search_query` の引数で渡す（`search.service.ts`）
- 関数は ILIKE の前に `%`・`_` を逃がす（`remote_schema.sql`）
- 前の組み立ての関数は消し、消した理由を注に残した（`search.service.ts`）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `.or()` の文字列のまま使う | フィルタの構文の注入が残る（レビューの Must Fix） |
| `.or()` のまま、使える字を許す一覧で絞る | レビューは「少なくとも」の案として出したが、記号の抜けが残りやすい。採らなかった理由の記録は無い（推定） |
| 全文検索（`websearch_to_tsquery`・`plainto_tsquery`）に替える | レビューが並べたもう1つの案。部分一致を選んだ判断は ADR-0301 |

#### 結果

- 良くなること: 記号を含む語でも、検索の条件は変わらない
- 残ること: 関数は `\` を逃がさない（SEC-SEARCH-003）
- 残ること: `/api/suggest` は制御文字を 400 で断るが、`/api/search` は長さだけを見る（`src/app/api/search/route.ts`、`src/app/api/suggest/route.ts`、SEC-SEARCH-004）
- 食い違い: `src/app/api/suggest/route.ts` の注は `,().` も断ると書くが、正規表現は制御文字だけを見る

## 未確認事項

- 本番の DB の関数の定義（手元の移行だけを読んだ）
- 関数に記号を含む語を渡す結合テストは無い
