# ADR-0302 検索の関数は呼び手の権限で動かし、関数の中でも公開済みに絞る

> 状態: 推定 | 確認日: 2026-10-24 | 対象: `search_items`・`search_looks`・`search_news`（範囲外の DB）、`src/features/search/services/search.service.ts` | 基準コミット: `4e84d5c5`

## 概要

検索の関数に SECURITY DEFINER を付けず、呼び手の権限で動かして表の RLS を効かせる。そのうえで関数の中でも `status = 'published'` で絞る。検索とサジェストは利用者の session の client で関数を呼び、service role の client は使わない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH |
| 対応する ID | SEC-SEARCH-001、SEC-SEARCH-002 |
| 対象のコード | `src/features/search/services/search.service.ts`、`supabase/migrations/20260901102912_remote_schema.sql`（範囲外の DB） |
| 関連文書 | `migrations/048_create_search_rpc_functions.sql`、`docs/05_Quality/reviews/code/2026-04-18-search-review.md`、`docs/05_Quality/reviews/security/security_review_search.md` |
| 要件の文書 | `docs/02_Requirements/areas/search.md` |
| 調べた時点 | 2026-10-24 の作業ツリー（コードは読んだだけで、動かしての確かめはしていない） |

## 判断

### ADR-0302 検索の関数は呼び手の権限で動かし、関数の中でも公開済みに絞る

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-001、SEC-SEARCH-002 |
| 根拠 | 関数を呼び手の権限で動かせば、商品・ルック・ニュースの表の RLS がそのまま効く（移行 048 の注）。RLS は管理の読み取りの権限を持つ session に下書きを通すので、関数の中でも公開済みに絞り、片方が崩れても下書きを返さない2段にしたと推定（SEC-SEARCH-002）。移行 048 の注が記録するのは INVOKER で RLS を効かせることだけで、2段にした理由と「`has_permission` が `aal` を見ない」点は 2026-10-24 にコードを読んで起こした推定（THR-SEARCH-002）。NEWS の同じ判断 ADR-0003 も推定 |
| 状態 | 推定 |
| 出どころ | `migrations/048_create_search_rpc_functions.sql`（INVOKER の部分）、`docs/05_Quality/reviews/code/2026-04-18-search-review.md`、実装から推定（2段の理由） |

#### 背景

ADR-0300 で検索を DB の関数に移した時、関数を誰の権限で動かすかを決める要があった。2026-04-18 のレビューは「search API が service role を直接使っていない点は妥当」とした。

#### 決定

- 3つの関数に SECURITY DEFINER を付けない（`remote_schema.sql`）
- 関数の中で `status = 'published'` の行だけを返す
- EXECUTE は anon・authenticated（と postgres・service_role）に付ける
- 検索とサジェストは利用者の session の client（`createClient`）で呼ぶ（`search.service.ts`）。service role の client は人気商品と画像の署名にだけ使う（ADR-0304・ADR-0305）

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| SECURITY DEFINER にして関数の中だけで絞る | RLS を飛ばすので、関数の中の条件が崩れた時に守りが残らない（移行 048 の注、推定） |
| service role の client で検索する | RLS を飛ばす。レビューは使っていない点を妥当とした |
| 関数の中で絞らず RLS だけに任せる | 管理の読み取りの権限の session で下書きが返る（SEC-SEARCH-002） |

#### 結果

- 良くなること: 下書きを返さない守りが、関数の条件と表の RLS の2段になる。NEWS の同じ形は ADR-0003・ADR-0004
- 悪くなること: anon の鍵があれば PostgREST から関数を直接呼べ、アプリの回数の制限も1種別8件の上限も通らない。`limit_count` を関数の中で上限に丸めていない（`remote_schema.sql`、SEC-SEARCH-007）。読めるのは公開済みの行だけなので、害は DB の負荷とまとめての吸い出し
- 残ること: 使われていない `search_public_items`・`search_public_looks`・`search_public_news` が PUBLIC に開いている（`remote_schema.sql`、SEC-SEARCH-008）
- 残ること: 関数の `search_path` に `public` が2回書かれている（`remote_schema.sql`）

## 未確認事項

- 本番の DB の関数の権限と、PostgREST の返す行数の上限
- 管理の読み取りの権限の session で関数を直接呼ぶ試験は無い（SEC-SEARCH-002-AC-01）
