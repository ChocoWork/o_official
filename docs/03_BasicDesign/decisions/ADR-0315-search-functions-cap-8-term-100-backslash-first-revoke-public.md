# ADR-0315 検索の関数は上限 8・検索語 100 字・`\` を先に逃がし、`search_public_*` は DROP せず REVOKE する

> 状態: 推定 | 確認日: 2026-10-26 | 対象: `search_items`・`search_looks`・`search_news`・`search_public_items`・`search_public_looks`・`search_public_news`（`supabase/migrations/20261026130400_sec_search_functions.sql`） | 基準コミット: `10b211a8`（作業ツリー）

## 概要

anon・authenticated が PostgREST から直接呼べる検索の関数 3 本（`search_items`・`search_looks`・`search_news`）の中で、(1) 件数を 1〜8 に丸め（NULL・0・負の値も誤りにせず丸める）、(2) 検索語を先頭 100 字に切り、(3) `\` を先に二重にしてから `%`・`_` を逃がす。`search_public_items`・`search_public_looks`・`search_public_news` は DROP せず、PUBLIC・anon・authenticated の EXECUTE を外す。関数の署名・戻りの列・`SET search_path TO 'public', 'public', 'pg_temp'`・SECURITY INVOKER は変えない。

## 範囲と根拠

| 項目 | 内容 |
| --- | --- |
| 範囲 | `scripts/trace/scope.json` の SEARCH・LOOK・NEWS が共有する 1 本の移行 `sec_search_functions`（波 2 の Task 6） |
| 対応する ID | SEC-SEARCH-003、SEC-SEARCH-007、SEC-SEARCH-008、SEC-LOOK-010、SEC-NEWS-010、DATA-SEARCH-001、DATA-SEARCH-003 |
| 対象のコード | `supabase/migrations/20261026130400_sec_search_functions.sql`（`remote_schema.sql:2139-2238` の旧い本体を移行のヘッダーに全文残す） |
| 関連文書 | `docs/02_Requirements/areas/{search,look,news}.md`、`docs/05_Quality/security/threats/{search,look,news}.md`、`docs/superpowers/plans/2026-10-26-wave2-local-fixes.md`（Task 6、P11・P12）、`.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`（R5） |
| 調べた時点 | 2026-10-26（移行を読み、DB なしの形の試験を流した。DB 結合試験と E2E は書いただけで流していない） |

## 判断

### ADR-0315 検索の関数は上限 8・検索語 100 字・`\` を先に逃がし、`search_public_*` は DROP せず REVOKE する

| 属性 | 値 |
| --- | --- |
| 上位 | SEC-SEARCH-003、SEC-SEARCH-007、SEC-SEARCH-008 |
| 根拠 | 検索の関数は anon の鍵で PostgREST から直接呼べ、アプリの回数の制限も 8 件の上限も通らない。件数を呼び手の値のまま `LIMIT` に使うと、21 でも 10000 でも NULL でも多くの行を返す。`\` を逃がさないと、語の `\%` が「`\` のあとに何でも」になり、語の末尾の `\` が後ろの `%` を字に変えて模様を変える。未使用の `search_public_*` は PUBLIC に開き、語を逃がさない。アプリの呼び元の件数は最大 8 なので、上限 8 で欠けない |
| 状態 | 推定 |
| 出どころ | `.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md`（R5-1・R5-2）、`wave2-decisions.md` |

#### 背景

- `search_items`・`search_looks`・`search_news` は `LIMIT limit_count` をそのまま使っていた（`remote_schema.sql:2170,2203,2236`）。`limit_count` に 21 を渡せば 21 件、NULL なら上限なし、負の値なら `2201W` の誤り
- 模様は `replace(replace(search_query, '%', '\%'), '_', '\_')` で、`\` 自体は逃がさなかった。語 `\%` は `\\%`（字の `\` のあとに生きた `%`）になり、`\` を含む行に広く当たる
- アプリの呼び元は `/api/search` の `limitPerType`（通常 8、プレビュー 3）と候補の `limit`（8）で、どれも 8 以下（`src/app/api/search/route.ts:68`、`src/app/api/suggest/route.ts:52`）
- `search_public_*` は `src` のどこからも呼ばれず、`p_limit` は 1〜20 に丸めるが語を逃がさない。PUBLIC に EXECUTE が付いている（`remote_schema.sql:4020-4024`）
- NEWS の E2E（`FR-NEWS-SEC-002` SEC-NEWS-010-AC-02）は `search_public_news` を anon が呼ぶと権限の誤り `42501` になることだけを許す。関数が無い誤り（`PGRST202`）は許さない

#### 決定

- 3 本の本体を `CREATE OR REPLACE` で置き換える。署名・戻りの列・`LANGUAGE sql STABLE`・`SET search_path TO 'public', 'public', 'pg_temp'`・SECURITY INVOKER・所有者・ACL はそのまま
- 件数は `LIMIT GREATEST(1, LEAST(COALESCE(limit_count, 8), 8))`。NULL は 8、0 と負は 1 に丸め、誤りにしない（呼び元に誤りの分岐を増やさない）
- 検索語は `left(search_query, 100)`。模様は `CROSS JOIN LATERAL` で 1 回だけ作り、`replace(replace(replace(left(search_query, 100), '\', '\\'), '%', '\%'), '_', '\_')` の順（`\` が先）にする。ILIKE の `ESCAPE '\'` は変えない
- `search_public_items/looks/news` は DROP しない。`REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated` だけにし、postgres（所有者）と service_role の EXECUTE は残す（service_role は明示の GRANT を 1 文足す）
- 移行のヘッダーに、戻すための旧い本体 3 本を 1 字も変えずに全文写す。戻す GRANT（`search_public_*` を PUBLIC・anon・authenticated へ）も書く
- 移行の末尾の自己検査（`DO` 文）が、`search_*` の ACL（anon・authenticated・service_role は EXECUTE できる・PUBLIC の grantee 0 が無い）・SECURITY INVOKER・`search_path` の設定・本体に上限と 100 字の切り詰めが入っていること、`search_public_*` の ACL（anon・authenticated は EXECUTE できない・PUBLIC の grantee 0 が無い・postgres と service_role は EXECUTE できる）を確かめ、外れたら `SEC_WAVE2_MIGRATION_ASSERTION_FAILED` で全体を戻す

#### 業界の定番との突き合わせ

| 論点 | 定番 | この決定 |
| --- | --- | --- |
| 関数の既定の EXECUTE | Postgres は関数の作成時に PUBLIC へ EXECUTE を付ける。Supabase の Data API は公開スキーマの関数を RPC に出すので、使わない関数は PUBLIC・anon・authenticated から外す（Supabase 公式「Securing your API」・「Hardening the Data API」） | `search_public_*` を REVOKE。検索の 3 本はアプリが anon の鍵で呼ぶので EXECUTE を残す |
| 件数の上限 | 呼び手が決める LIMIT は、サーバー側でも上限に丸める（OWASP ASVS V11.1.4、API4:2023 Unrestricted Resource Consumption） | 8 に丸める。誤りで断らず 1〜8 に寄せる |
| LIKE の逃がし | エスケープ文字そのものを先に逃がしてから `%`・`_` を逃がす（PostgreSQL の LIKE の ESCAPE の定義） | `\` を最初に二重にする |
| 使わない関数 | 消す前に参照を数え、まず権限を外して様子を見るのが安全 | REVOKE にとどめ、DROP は NEWS の試験を直した後に別に判断する |

#### 退けた案

| 案 | 退けた理由 |
| --- | --- |
| `search_public_*` を DROP する | NEWS の E2E が `42501` だけを許し、`PGRST202`（関数が無い）で失敗する。DROP は試験を直してから別の判断 |
| `search_*` の EXECUTE を anon・authenticated から外し、窓口の service role だけにする | アプリは利用者の session の client から関数を呼ぶ（RLS を通す設計）。EXECUTE を外すと検索が止まり、呼び出しの client の変更が要る。波 2 の範囲外 |
| 上限を超えたら誤りで断る | 呼び元に誤りの分岐が増える。アプリの値は 8 以下なので、丸めれば足りる |
| 上限を 20 にする（`search_public_*` に合わせる） | アプリの最大が 8。広げる理由が無く、直接叩く負荷が増える |
| 検索語を窓口の zod だけで 100 字に切る | PostgREST の直接の呼び出しは窓口を通らない。関数の中で切る |
| 旧い本体を移行に残さず git の履歴に任せる | 本番へ当てた後で戻す時に、履歴から正しい本体を探す手間と誤りが出る。ヘッダーに全文を残す |

#### 結果

- 良くなること: 直接の呼び出しで返る行は最大 8。語の `\` が字として探され、広い一致にならない。使われない入口 3 つが外から呼べなくなる
- 悪くなること: `limit_count` を 8 より大きくしたい呼び元は、その関数を使えない（今は無い）。`search_public_*` は呼べないまま残る（DROP は別の判断）。戻す時は移行のヘッダーの旧い本体を流す
- 本番の PostgREST の `max_rows` は運用で確認する（コードでは決められない）

## 未確認事項

- 本番の `search_public_items/looks/news` の ACL（`has_function_privilege('anon', 'public.search_public_items(text,integer)', 'execute')` ほか 6 本）。適用の前と後で読んで比べる
- 本番の PostgREST の `max_rows`
- `search_public_*` を DROP してよい時期（NEWS の `FR-NEWS-SEC-002` の SEC-NEWS-010-AC-02 が `PGRST202` も許す形に直してから。LOOK の `FR-LOOK-SEC-002` と SEARCH の `FR-SEARCH-020` は今も許している）
