# ADR-0301 検索は DB の関数の中の部分一致（ILIKE）で行い、全文検索や外の検索の仕組みを使わない

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `search_items`・`search_looks`・`search_news`（範囲外の DB）、`src/features/search/services/search.service.ts` | 基準コミット: `4e84d5c5`

## 概要

商品・ルック・ニュースの検索は、DB の関数の中で語全体を ILIKE の部分一致で探し、公開済みの行を新しい順に上限まで返す。文書が一次と書く全文検索（tsvector と GIN の索引）も、Meilisearch・Algolia も使っていない。部分一致を選んだ理由の記録は無い。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | FR-SEARCH-003 |
| 対象のコード | `supabase/migrations/20260901102912_remote_schema.sql`（範囲外の DB）、`src/features/search/services/search.service.ts` |
| 関連文書 | `docs/02_Requirements/requirements.md`（INT-004・INT-010・TECH-LIB-005・TECH-OPT-002）、旧版の詳細設計（`git show 40acae8a:docs/04_DetailDesign/pages/19_search.md` の「検索アーキテクチャ」の節）、今の `docs/04_DetailDesign/pages/19_search.md`（旧版から引き継がなかった節）、`migrations/032_create_search_indexes.sql`、`migrations/048_create_search_rpc_functions.sql` |
| 要件の文書 | `docs/02_Requirements/areas/search.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0301 検索は DB の関数の中の部分一致（ILIKE）で行い、全文検索や外の検索の仕組みを使わない

| 属性 | 値 |
| --- | --- |
| 上位 | FR-SEARCH-003 |
| 根拠 | FR-SEARCH-003 は3種の検索を求めるだけで、方式を決めていない。外の検索の仕組みは要求の表が「段階導入」とし、まず最小の構成で始めると書くので入れていない（INT-004・INT-010）。全文検索を一次とする文書と違って部分一致にした理由の記録は無い。`'simple'` の設定の tsvector は空白の無い日本語を語に分けないので、語の途中の一致を拾うために部分一致にしたと推定 |
| 状態 | 推定 |
| 出どころ | 実装から推定（`supabase/migrations/20260901102912_remote_schema.sql`）。`docs/02_Requirements/requirements.md` |

#### 背景

- 要求の表の INT-004 は「Supabase フルテキスト検索（一次）→ Meilisearch（段階導入）」、旧版の詳細設計は「`tsvector` + `GIN インデックス`」を一次と書いた（`git show 40acae8a:docs/04_DetailDesign/pages/19_search.md` の）。書き直した今の詳細設計は、これを今のコードに無い物として引き継いでいない（`19_search.md`）
- `migrations/032_create_search_indexes.sql` は3つの表に `to_tsvector('simple', …)` の GIN の索引を作った
- 検索の関数の移行の題は「full-text search」（`migrations/048_create_search_rpc_functions.sql`）だが、中身は ILIKE

#### 決定

- 商品は名前・説明・カテゴリ、ルックはテーマ・テーマの説明、ニュースは題・本文・分類を、語全体の `ILIKE '%語%'` で見る（`remote_schema.sql`）
- 公開済みの行を、商品・ルックは作った日、ニュースは公開日の新しい順に、`limit_count` 件まで返す
- 並べ直しはアプリが行う（ADR-0303）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| tsvector と GIN の索引の全文検索 | 理由の記録は無い。`'simple'` の設定では日本語の語の途中が当たらない（推定） |
| Meilisearch・Algolia（TECH-LIB-005・TECH-OPT-002） | INT-010 が、最小の構成で始めて後から入れると書く |

#### 結果

- 良くなること: 日本語の語の途中でも当たる。DB のほかに検索の仕組みを持たない
- 悪くなること: 前後に `%` の付く ILIKE は B-tree の索引も 032 の GIN の索引も使えず、行が増えると全部の行を見る（推定。実行計画は見ていない）
- 悪くなること: 語全体で一致を見るので、離れた2語の検索は DB で落ちる。アプリの語ごとの点（ADR-0303）は並べ直しにしか効かない（推定）
- 食い違い: INT-004、旧版の詳細設計（`40acae8a` の `19_search.md`）、移行 048 の題は全文検索と書く。今の詳細設計は部分一致を書く（`19_search.md`）。要件の側（INT-004）にどちらを合わせるかは決めていない

## 未確認事項

- 部分一致を選んだ時の記録（git の履歴と文書には見つからなかった）
- 本番の DB の関数の定義と、032 の索引が今も残っているか
- 行が増えた時の速さ（旧版の詳細設計 `40acae8a` の `19_search.md` が置いた P95 < 200ms は測っていない。今の詳細設計は引き継いでいない、`19_search.md`）
