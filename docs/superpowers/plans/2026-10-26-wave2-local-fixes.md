# 波 2 DB の権限・関数・制約の守りの直し（R4・R5・R17・R8-5）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 守りの穴の設計（`design-final.md`）の波 2 を直す。(1) 見本の画像の道筋を `items/e2e/…`・`looks/e2e/…`・`news/e2e/…` に直し、DB の CHECK と合わせる（R8-5・Q5）。(2) `items` は原価 2 列だけを外した列単位の SELECT にし、`item_cost_history` は「全員に全権限」をやめて管理者（`admin.finance.read`）の SELECT だけにし、認証の表 5 つと `profiles` の余分な権限を外す（R4: SEC-HOME-004・005・020、SEC-AUTH-011）。(3) 管理だけが書く表（`looks`・`look_items`・`news_articles`・`stockists`・`item_color_presets`）から anon・authenticated の書き込みを外し、R3 の「書き込みの穴」をここで塞ぐ（SEC-LOOK-003 AC-02・004、SEC-NEWS-002 AC-02・022、SEC-STOCKIST-003 AC-02・AC-03・008、SEC-HOME-003 AC-02、SEC-ADMIN-002 AC-01）。そのために、利用者の JWT で書いている取扱店・ニュースの管理の窓口を service role に移す。(4) 検索の関数 3 本の上限 8・`\` の逃がし・`search_public_*` の REVOKE、`look_items` の方針、DB の CHECK（`NOT VALID`）、`admin_update_look`（1 取引）、`stockists.type` の NOT NULL 外し、置き場 `look-images`・`news-images` の設定を移行に入れる（R5・R17）。(5) 権限の一覧を確かめる DB 結合試験と、「移行は GRANT を明示する」決まりを足す（I8）。

**Architecture:** 移行は小さく 6 本に分け、1 タスク 1 本にする。どの移行も冪等で、末尾に権限の自己検査（`has_table_privilege`・`has_function_privilege`・列の取りこぼしの検査）を持ち、ヘッダーのコメントに対のロールバックの SQL を残す。**共有の `supabase/migrations/`・`supabase/seed.sql`・`scripts/e2e/seed-storage.ts` は編集しない**（別セッション G が `supabase db reset` を頻繁に流すため）。新しい移行は `supabase/pending-wave2/<時刻>_<名前>.sql`、変える見本ファイルは全文の写しを `supabase/pending-wave2/seed/` の下の同じ相対パスに置き、単体試験は小さな補助 `tests/helpers/staged-supabase.ts`（移行は `supabase/migrations` を先に、見本は pending の写しを先に探す）で読む。controller が後で本物の置き場へ移す。コードは「窓口の書き手を service role にそろえる」（Task 3）と「LOOK の PUT を `admin_update_look` の rpc 1 回にする」（Task 7）だけを変える。`has_permission` 本体・G の表・共有の `rateLimit.ts`・`proxy.ts`・`next.config.ts` は触らない。

**Tech Stack:** PostgreSQL（Supabase ローカル / 本番）、PostgREST、Next.js `^16`（Route Handler）、TypeScript、Jest（単体・DB 結合）、Playwright（書くだけ）。依存は増やさない。

**Spec:** [`.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/wave2-decisions.md)（ユーザー承認 2026-10-26「波 2 に進んで」）。背景: 同ディレクトリの [`design-final.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/design-final.md) の R4・R5・R17・R8-5・§3-4、領域別の [`HOME.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/HOME.md)・[`LOOK.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/LOOK.md)・[`NEWS.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/NEWS.md)・[`SEARCH.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/SEARCH.md)・[`STOCKIST.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/STOCKIST.md)・[`AUTH.md`](../../../.superpowers/sdd/2026-10-25-security-gap-fixes/AUTH.md)。前の波の計画: [`2026-10-26-wave1b-local-fixes.md`](./2026-10-26-wave1b-local-fixes.md)（コミット `a824932e`）、[`2026-10-26-wave1c-local-fixes.md`](./2026-10-26-wave1c-local-fixes.md)（`a300074b`）。

---

## 概要

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026-10-26。コード・DB・テストは 1 行も変えていない（この計画の作成だけ） |
| 直す項目 | HOME 4（003 の AC-02・004・005・020）、AUTH 2（011・新規 033）、LOOK 7（002・003 の AC-02・004・005・010・015・023）、NEWS 6（002 の AC-02・003 の置き場・010・022・025 と書き手の移し替え）、SEARCH 3（003・007・008）、STOCKIST 4（003 の AC-02・AC-03・008・`type` の列）、ADMIN 1（002 の AC-01） |
| タスク | 10 つ（見本の道筋 1・取扱店の列 1・窓口の書き手 1・権限 2・検索 1・制約と関数 1・置き場 1・権限の一覧 1・最終確認 1） |
| 移行（6 本） | `stockists_type_optional`（Task 2）、`sec_grants_hardening`（Task 4）、`sec_grants_admin_tables`（Task 5。設計書の `sec_grants_hardening` から分けた）、`sec_search_functions`（Task 6）、`sec_rls_predicates_and_constraints`（Task 7）、`sec_storage_buckets`（Task 8）。置き場は `supabase/pending-wave2/` |
| 新しい ADR | `ADR-0462`〜`ADR-0468`（下の ID の割当） |
| 外す `test.fail` | 約 24 行（各タスクの「E2E の印」に行ごとに書く）。波 5（`has_permission` の aal2）で直る読み取りの印は外さない |
| 触らない共有文書 | `requirements.md`・`test-spec.md`・作業と指摘の台帳・`api-spec.md`・`route-inventory.md`・`tests/unit/docs/*-traceability.test.ts`・`db-migrations.md`。要る変更は Task 10 の報告に書く（`er.md` も共有として触らない） |
| 流さないもの | E2E・サーバー・3000 番・DB 結合試験・`db reset`・全体の `jest`・`trace:report`・`validate-trace --update-baseline`・`graphify update`。DB 結合試験と E2E は書くだけ |
| 本番 | この波は本番に何も当てない。本番の適用は G-1 が G-4 と波 1-A の移行 `20261026010000_auth_return_intents.sql` と一緒に当てる（Q27）。適用の前後に本番の権限（`has_table_privilege` など、読むだけ）と `get_advisors`（security）を比べる（Task 10 の手順） |

## 前提の読み（決定文の解釈。controller の確認を求める点を含む）

実装者はこの節を変えない。食い違いに気付いたら止めて報告する。

| # | 読み | 根拠・影響 |
| --- | --- | --- |
| P1 | 「本番相当の今の状態」は `20260901102912_remote_schema.sql`（本番から引いた写し）と、その後の移行を読んで決める。`items` から `stock_quantity` が消え（`20260921121038`）、`made_to_order_lead_days`（`20260919065336`）・`return_ineligible`（`20261020144439`）が足されている。今の `items` の列は 23 本。対象の表の GRANT は `remote_schema.sql:4142〜4202` の「anon・authenticated・postgres・service_role に 8 権限」のまま、後の移行は触っていない（`ALTER DEFAULT PRIVILEGES` も 0 件） | `items` の列権限の一覧は、移行の中で `information_schema.columns` と突き合わせて取りこぼしを移行ごと落とす（P3） |
| P2 | **設計書の前提「管理の書き込みは全部 service role」は、取扱店とニュースでは誤り。** `src/app/api/admin/stockists/route.ts`（POST）・`[id]/route.ts`（PUT・PATCH・DELETE）と `src/app/api/admin/news/route.ts`（POST）・`[id]/route.ts`（PUT・PATCH・DELETE）は、認可の後に `createClient(request)`（利用者の JWT で RLS を通る client）で書く。`items`・`item_color_presets`・`looks`・`look_items` の窓口は service role。`profiles` は利用者自身が JWT で書く（`/api/profile`） | authenticated の書き込みを外すと、Task 3 より先に取扱店・ニュースの管理が全部 42501 で止まる。Task 3（窓口の書き手を service role に移す）を Task 5 の前に出し、移行は Task 3 の後に移す。認可は窓口が先に済ませている（`authorizeAdminPermission`）ので守りは弱くならない。設計書 R4・R3 の前提の訂正として controller に報告する |
| P3 | `items` の列権限: 原価 2 列（`pattern_cost`・`mass_production_cost`）以外の 21 本（`id, name, description, price, category, image_url, image_urls, colors, sizes, product_details, status, created_at, updated_at, material, origin, sewing_region, care, season, product_note, made_to_order_lead_days, return_ineligible`）を anon・authenticated に SELECT だけ付ける。`product_note` はお客さん向けの注意書きなので公開のまま（Q7）。authenticated の INSERT・UPDATE・DELETE は付け直さない。service_role の権限は触らず、明示の GRANT を 1 文足すだけ。新しい列は自動では見えない（安全側） | 移行の末尾で「`items` の全列 − 原価 2 列 = anon が読める列」を `has_column_privilege` で検査する |
| P4 | Q8 の事実: 原価を計算する画面（`ProductCostSection`・`CostProfitSection`）は `/api/admin/accounting/product-costs` と `/api/admin/kpi/cost-profit` を呼び、どちらも `admin.finance.read` / `admin.finance.manage` で認可して service role で `admin_costing_items`・`admin_finance_*` を読む。**`item_cost_history` を読む画面・窓口・関数は `src` にも `scripts` にも 1 つも無い**（参照は E2E の `home-grant-test-utils.ts` が pg 直で行を入れるだけ）。だから表は残し、`admin.finance.read` を持つ authenticated の SELECT だけを方針で許す（新しい権限の印は作らない）。書き込みは service role だけ。この事実を報告する | 将来この表を読む画面を作る時は `admin.finance.read` の窓口（service role）か、この方針（`has_permission`）を使う。波 5 で `has_permission` に aal2 が入ると、この方針も自動で締まる |
| P5 | `item_color_presets` は anon に SELECT を付けない（authenticated の SELECT だけ。管理の読み方針 `has_permission('admin.items.read')` が authenticated 向けのため、anon が読める行は元から 0 件）。設計書 R4-4 は「anon と authenticated に SELECT」と一括りだが、最小権限（Supabase 公式「Grant the minimum privileges each role needs」）に合わせて anon を外す。`looks`・`look_items`・`news_articles`・`stockists` は公開の読み方針があるので anon と authenticated の両方に SELECT | anon の `item_color_presets` の select が「0 件の 200」から「42501」に変わる。E2E `FR-ADMIN-MISC-005` は anon で色見本を読む試験を持たない（Task 5 Step 1 で grep して確かめる） |
| P6 | 書き込みの RLS 方針（`admin … manage by permission insert/update/delete`）は **消さずに残す**。権限が無いので今は働かない二重の守りで、将来だれかが GRANT を戻した時の保険になる。波 5 が aal2 を足すのは「読みの管理の枝」だけ | 方針を消すと、戻す時の手順が増えるだけで得が無い |
| P7 | DB の CHECK（`looks.image_urls`・`news_articles.image_url`）は **関数を作らず式を直に書く**。CHECK は書く役（service_role・将来の authenticated）が評価するので、補助関数を作ると EXECUTE の付与と G の「関数の ACL を数える自己検査」への影響が増える。配列は `array_to_string(image_urls, E'\n')` を 1 本の正規表現 `^(P(\nP)*)?$`（P は 1 つの道筋）で検査し、NULL の要素は `array_position(image_urls, NULL) IS NULL` で断る。設計書 §R5 の `private.look_image_paths_ok` 案は採らない | 理由を ADR-0466 に書く。式はアプリの `isOwnLookImagePath`・`isOwnNewsImagePath`（`/^looks\/[A-Za-z0-9][A-Za-z0-9._-]*(\/…)*$/`）と同じ。DB 結合試験で受理・拒否の表を持つ |
| P8 | CHECK は `NOT VALID` で入れ、`VALIDATE` はこの波では書かない。`NOT VALID` でも既存の行の UPDATE では新しい値が検査されるので、本番の既存行の点検・正規化が先（Task 10 の「本番の事前の確認」）。長さは `char_length`（コードポイント数）で、窓口の zod（UTF-16 の長さ）より緩いか同じ | 本番の行を移行の中で書き換えない（読むだけ）。VALIDATE は点検の後の別の移行 |
| P9 | `admin_update_look(...)` は設計書の形（行の更新 → 関連の全削除 → 追加を 1 取引）に、**更新前の `image_urls` を返す**ことを足す。先頭で `SELECT … FOR UPDATE` で行を締めて古い値を読み、更新後に返す。窓口はその戻り値で「差し替えた古い画像」を決める。波 1-C のレビュー（Task 5 指摘 7）が記録した「同時の PUT で画像が残る」弱さを同じ関数で閉じるため。関数は SECURITY INVOKER・`search_path = ''`・service_role だけが EXECUTE | 設計書に無い戻り値の追加。controller の確認を求める（不要なら戻り値を `void` に戻し、Task 7 Step 4 の窓口の読みを元に戻すだけ） |
| P10 | 置き場の移行は `ON CONFLICT (id) DO UPDATE` で `public = false`・`file_size_limit = 5242880`・`allowed_mime_types = {image/jpeg, image/png, image/webp, image/gif}` に合わせる（本番の置き場は既にある。LOOK.md SEC-LOOK-005）。`storage.objects` に置き場を名指しする方針を作らない。**本番に当てる前に本番の `storage.buckets` の現状と `storage.objects` の方針を読む**。`item-images` は設計書 R17 の対象外なのでこの波では触らない（「回す物」） | 移行の末尾で、置き場の設定と「名指しする方針が 0 件」を検査する。本番に名指しの方針があれば移行が落ちて止まる（意図した止まり方） |
| P11 | 検索関数 3 本: 上限は 8、`limit_count` が NULL・0 以下でも 1〜8 に丸める（`GREATEST(1, LEAST(COALESCE(limit_count, 8), 8))`）。検索語は `left(search_query, 100)`。`\` を先に二重にしてから `%`・`_` を逃がす。**関数の署名・戻りの列・`SET search_path TO 'public', 'public', 'pg_temp'`・SECURITY INVOKER は変えない**（`CREATE OR REPLACE` で所有者と ACL が保たれる）。アプリの呼び元の最大は 8（`/api/search` の `limitPerType`、候補 8） | `search-functions.integration.test.ts` が今の挙動を固定している行（「21 を渡せば 21 件」「NULL は上限なし」「負は 2201W」「`search_public_*` は PUBLIC に許す」）は新しい挙動に書き換える |
| P12 | `search_public_items/looks/news` は **DROP せず** `REVOKE ALL … FROM PUBLIC, anon, authenticated`（NEWS の試験が 42501 しか許さない）。postgres・service_role の EXECUTE は残す | 移行の末尾で `has_function_privilege` と `aclexplode`（PUBLIC=grantee 0）で検査する（G-2 の `group_g2_public_function_acl` と同じ作法） |
| P13 | 移行の時刻は、書く直前の `ls supabase/migrations supabase/pending-wave2` の最新（今は `20261026101624_group_g4_orders_swap.sql`）より後にする。案: `20261026130100`〜`20261026130600`。controller が移す時に時刻を替えてもよいように、**試験は時刻でなく名前の末尾（`_sec_grants_hardening.sql` など）で移行を探す**（補助 `findMigration(suffix)`） | 本番の台帳の時刻は適用の時に決まる（memory「push のフックと CI の移行適用」）。時刻に依存する試験は適用後に壊れる |
| P14 | 見本の道筋は、`items/e2e/item-N-M.png`（`item-images`）・`looks/e2e/look-N-M.png`（`look-images`）・`news/e2e/news-N.png`（`news-images`）。商品画像の本物の道筋は `items/<日付>/<uuid>.<拡張子>`（`src/app/api/admin/items/route.ts:132`）で、`items/` の接頭辞に合わせる | 画像の署名の許可範囲（波 3）と DB の CHECK（Task 7）が `looks/`・`news/` の下だけを許すため、見本が外にあると E2E の画像が全部 null になる |

## Global Constraints

- 並行作業: 別セッション（G-3 発送・G-4 注文）が同じ作業ツリーの別ファイルを編集し、コミットの時に全体の `tsc` を通す。**`git add`・`git commit`・`git stash`・`git checkout`・`git reset`・`git restore` は実行しない**。コミットは作らない。
- **E2E・サーバー・3000 番・DB 結合試験・`db reset`・`supabase` の起動・全体の `jest`・`npm run test:trace-coverage`・`npm run trace:report`・`validate-trace --update-baseline` は実行しない**。流してよい `jest` は `npx jest <ファイル>` の対象指定だけ。DB 結合試験と E2E は書くだけ。
- `.ts` / `.tsx` を 1 つ編集するたびに `npx tsc --noEmit` を流し、自分の誤りをその場で直す。他者の誤りが出たら触らず報告に書く。`tsconfig.json` は `**/*.ts` を含むので、`supabase/pending-wave2/seed/` の `.ts` の写しも型検査の対象になる（Task 1 の注）。
- **ステージングの決まり（共有の DB）**: `supabase/migrations/`・`supabase/seed.sql`・`scripts/e2e/seed-storage.ts` を作らない・編集しない。新しい移行は `supabase/pending-wave2/<時刻>_<名前>.sql`、変える見本は全文の写しを `supabase/pending-wave2/seed/supabase/seed.sql`・`supabase/pending-wave2/seed/scripts/e2e/seed-storage.ts` に置く。移行を読む単体試験は `tests/helpers/staged-supabase.ts` の `findMigration(suffix)` を使う。
- 触らない: `src/lib/orders/**`、G-3・G-4 のファイル、`src/proxy.ts`、`next.config.ts`、`src/features/auth/middleware/rateLimit.ts`、`src/lib/auth/authenticate.ts`・`admin-rbac.ts`（呼ぶだけ）、`src/lib/audit.ts`、`src/lib/mail.ts`、`src/app/admin/page.tsx`、`has_permission` 本体、G の表（注文・発送・在庫・発注）、`tests/integration/db/helpers/group-g-allowlist.ts`。
- 共有文書は**編集しない**: `docs/02_Requirements/requirements.md`、`docs/05_Quality/tests/test-spec.md`、`docs/05_Quality/reviews/code/2026-09-25-working-diff-security-review.md`、`docs/03_BasicDesign/api/api-spec.md`、`docs/03_BasicDesign/api/route-inventory.md`、`docs/03_BasicDesign/data/er.md`、`tests/unit/docs/*-traceability.test.ts`、`docs/06_Operations/db-migrations.md`。必要な変更は各タスクの報告に「共有文書の変更案」として書く。
- 文書: 日本語。`documentation-guide`（`.claude/skills/documentation-guide/SKILL.md`）の項目の形（見出し直後の属性表）・ID の体系・TSDoc（`@packageDocumentation`・`@impl`・`@design`・`@remarks` に「なぜ」だけ）・テスト名の先頭に ID（単体は `DD-`、結合は `API-`・`DATA-`・`FLOW-`、E2E は `-AC-NN`）を守る。文書の冒頭の確認日は 2026-10-26。絵文字は使わない。範囲内の領域の要件は `docs/02_Requirements/areas/<area>.md`（`requirements.md` には書かない）。「今のコードは満たさない」は**直した項目だけ**外し、波 5（`has_permission` の aal2）・波 3 などに残る部分は残す。
- Supabase の構文は Supabase MCP の `search_docs` で確かめた形に合わせる: 列単位の権限は `GRANT SELECT (列, …) ON TABLE … TO role`（ワイルドカード `*` は制限された役に使えない）、権限を外す時は `REVOKE ALL … FROM PUBLIC, anon, authenticated`、関数は `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role`（`https://supabase.com/docs/guides/database/postgres/column-level-security`、`https://supabase.com/docs/guides/api/securing-your-api`、`https://supabase.com/docs/guides/database/hardening-data-api`）。
- 移行の書き方: `BEGIN; … COMMIT;`、`NOTIFY pgrst, 'reload schema';`、`SET search_path = ''` の関数は完全修飾、冪等（`DROP POLICY IF EXISTS`・`ON CONFLICT`・`IF EXISTS`）、**ヘッダーのコメントに対のロールバックの SQL（戻す GRANT・旧い関数の本体）**、末尾に自己検査の `DO` 文（失敗は `RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = '<名前>'`）。以後の移行は、要る GRANT（service_role を含む）を必ず明示する。
- 番号は**書く直前に再確認**する: `ls docs/03_BasicDesign/decisions | tail -3`（今は `ADR-0461` が最大）、`grep -rhoE "IMPL-(LOOK|NEWS|STOCKIST)-[0-9]+" src | sort -u | tail -3`、`SEC-AUTH-032` が最大。違えば割当表をずらして一貫させる。
- 実装は最小。決定に無い設定項目・追加の窓口・画面は作らない。作業ツリーに CRLF のファイルがある。編集は Edit で行い、`sed -i` は使わない（`\` が落ちて CRLF を壊す）。窓口（Route Handler）のファイルを増やさない。
- 道具: コードベースの質問は先に `.venv/Scripts/python.exe -m graphify query "<質問>"` で位置を取る（`graphify update` は自分で流さない）。

### ID の割当

| 種類 | ID | 題 | タスク |
| --- | --- | --- | --- |
| ADR | `ADR-0462` | 表・列・関数の権限は移行が明示し、`items` は列単位、管理だけが書く表は authenticated に SELECT だけを付ける | 4・5 |
| ADR | `ADR-0463` | `item_cost_history` は表を残し、`admin.finance.read` の SELECT 方針だけを持つ（読む画面は今は無い） | 4 |
| ADR | `ADR-0464` | 取扱店・ニュースの管理の書き込みは、認可の後に service role で行う | 3 |
| ADR | `ADR-0465` | 検索の関数は上限 8・検索語 100 字・`\` を先に逃がし、`search_public_*` は DROP せず REVOKE する | 6 |
| ADR | `ADR-0466` | 画像の道筋と長さの CHECK は関数を作らず式を直に書き、`NOT VALID` で入れる | 7 |
| ADR | `ADR-0467` | LOOK の更新は `admin_update_look` の 1 取引にし、更新前の画像を返す | 7 |
| ADR | `ADR-0468` | 置き場 `look-images`・`news-images` の設定は移行が持つ | 8 |
| 要件 | `SEC-AUTH-033`（AC-01・AC-02） | 公開スキーマの表・列・関数の権限は移行が明示し、一覧を DB 試験で守る | 9 |
| 補助 | `findMigration`・`resolveSeedPath`（`tests/helpers/staged-supabase.ts`。`@impl` は付けない。試験の補助） | 移行・見本の写しの探し方 | 1 |

---

## Review Focus（最も踏みやすい失敗 5 つ）

レビュアーと実装者は、各タスクの前後でこの 5 つを具体的な入力で確かめる。

1. **公開側が 42501 で壊れる（`items` の列権限と取りこぼし）。** (a) anon・authenticated の client で `select('*')`、`items(*)` の埋め込み、許可外の列（`pattern_cost`・`mass_production_cost`）を読む所が 1 か所でもあると 42501。`grep -rn "select('\*')" src`、`items(` の埋め込み（`cart-view.ts`・`availability.ts` は列を並べていて許可内）、`ITEM_SELECT_COLUMNS`、`/api/items/[id]`、wishlist、`look/server.ts`、`search_items`、方針・SECURITY INVOKER 関数・ビューが `items` の列を読む所（`item_colors` などの方針は `id`・`status` だけ）を全部確かめる。(b) 列の一覧の取りこぼし（`return_ineligible`・`made_to_order_lead_days` のような後から足した列）を移行の自己検査で落とす。(c) SECURITY DEFINER の `finalize_order…` 系は列権限に左右されないことを `pg_proc` で確かめる。
2. **authenticated の書き込みを外した時に、書き手が利用者の JWT のまま。** 取扱店・ニュースの管理の窓口（P2）が最初の例。同じ形が他に無いか、対象 5 表（と `item_cost_history`）への `.insert/.update/.delete/.upsert` を `src` 全体で洗い、`createClient(` で作った client を使う所を 0 にする。DB 結合試験の「管理者の JWT で書ける」を期待する行（`look_rls`・`look_permissions`・`news_permissions`・`news_articles_rls`・`stockist_rls`・`stockist_permissions`・`*_status_state`）は 42501 を期待する形に直す。E2E の補助が PostgREST に管理者の JWT で書く所も同じ。
3. **ステージングと順序。** 移行は pending に置いたまま、試験は `findMigration` で読む。見本の写しは本物より新しい（pending を先に探す）。移行の移し方の順序: Task 1 の見本（CHECK より先）→ Task 3 の窓口 → 移行 6 本（時刻の順）→ `db reset`。**LOOK の PUT（Task 7）は移行が無いと rpc が `PGRST202` で落ちる**ので、窓口の変更と移行は同じ日に移す。移す前に他セッションが E2E を流すと LOOK の更新が落ちる（controller が調整）。
4. **CHECK・見本・既存データ。** `NOT VALID` でも UPDATE は検査される。見本（Task 1）と、E2E・結合試験が DB に直に入れる値（`image_urls`・`image_url`・長いテーマ・長い本文）が新しい CHECK に当たらないか。配列の正規表現の `^(P(\nP)*)?$` が空配列・NULL 要素・改行を含む値・`looks/a/../b` を正しく扱うか。本番の既存行（旧い公開 URL・長いテーマ）は移行の前に読んで直す（Task 10）。
5. **関数の置き換えの退行。** `CREATE OR REPLACE` は所有者と ACL を保つが、`search_public_*` の REVOKE で PUBLIC・anon・authenticated が本当に外れたか（`aclexplode` の grantee 0）。上限 8 で `/api/search`（8）・候補（8）・プレビュー（3）が欠けないか。`\` の逃がしの順序（`\` が先）、LATERAL の 1 回計算。`admin_update_look` は 404（`P0002`）・外部キー違反（`23503`）・途中失敗で全部戻ること、同時の PUT で行の締めが効くこと。

---

## ファイルの全体像

| 区分 | ファイル | 操作 | タスク |
| --- | --- | --- | --- |
| 試験の補助 | `tests/helpers/staged-supabase.ts`・`tests/unit/helpers/staged-supabase.test.ts` | 新規 | 1 |
| 見本（写し） | `supabase/pending-wave2/seed/supabase/seed.sql`・`supabase/pending-wave2/seed/scripts/e2e/seed-storage.ts`・`supabase/pending-wave2/seed/scripts/e2e/environment.ts`（型検査のための薄い再公開。移さない） | 新規 | 1 |
| 単体試験 | `tests/unit/scripts/e2e/seed-storage.test.ts` | 変更 | 1 |
| E2E | 見本の道筋を参照する 11 ファイル（Task 1 の Files） | 変更 | 1 |
| 移行（6 本） | `supabase/pending-wave2/<時刻>_{stockists_type_optional,sec_grants_hardening,sec_grants_admin_tables,sec_search_functions,sec_rls_predicates_and_constraints,sec_storage_buckets}.sql` | 新規 | 2・4・5・6・7・8 |
| route | `src/app/api/admin/stockists/route.ts`・`[id]/route.ts`、`src/app/api/admin/news/route.ts`・`[id]/route.ts` | 変更 | 3 |
| route | `src/app/api/admin/looks/[id]/route.ts`（PUT を rpc に） | 変更 | 7 |
| DB 結合試験 | `tests/integration/db/` の新規 5 本と既存の書き換え（各タスク） | 新規・変更 | 2〜9 |
| 文書 | `docs/02_Requirements/areas/{home,auth,look,news,search,stockist,admin}.md`、`docs/05_Quality/security/threats/{home,auth,look,news,search,stockist,admin}.md`、`docs/03_BasicDesign/areas/{home,auth,look,news,search,stockist,admin}.md`、`docs/03_BasicDesign/decisions/ADR-0462〜0468`（新規）、`docs/04_DetailDesign/pages/{16-1_admin_news,16-3_admin_look,16-4_admin_stockist,10_stockist,19_search,01_home}.md` | 追記・更新 | 全部 |

**進める順。** 全体の順は Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10。並行にしてよいのは **(Task 2 → Task 3) と Task 4** だけ（src・試験・E2E・文書のファイルが重ならない）。それ以外は次のファイルが重なるので直列にする: `e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts`（Task 1・5・6・7・8）、`e2e/FR-NEWS-SEC-002-direct-db-access.spec.ts`（Task 5・6・7）、`tests/integration/db/look_rls.integration.test.ts`（Task 5・7）、`tests/integration/db/search-functions.integration.test.ts`（Task 6 だけ）、`docs/*/areas/{look,news}.md`（Task 5〜8）。

---

## Task 1: 見本の画像の道筋を `items/e2e`・`looks/e2e`・`news/e2e` に直す（R8-5・Q5）

**範囲:** 見本の行と置く画像の道筋、その単体試験、E2E の参照を、DB の CHECK（Task 7）とアプリの `isOwnLookImagePath`・`isOwnNewsImagePath` と同じ形にする。写しの置き場と探す補助も作る。**移行は無い。**

**Files:**

- Create: `tests/helpers/staged-supabase.ts`、`tests/unit/helpers/staged-supabase.test.ts`
- Create: `supabase/pending-wave2/seed/supabase/seed.sql`（現在の `supabase/seed.sql` の全文の写しを直したもの）、`supabase/pending-wave2/seed/scripts/e2e/seed-storage.ts`（同）、`supabase/pending-wave2/seed/scripts/e2e/environment.ts`（`export * from '../../../../../../scripts/e2e/environment';` の 1 行。**controller は移さない**。写しの `./environment` の import を型検査と単体試験で解決するためだけにある）
- Modify: `tests/unit/scripts/e2e/seed-storage.test.ts`
- Modify（E2E。意図が「見本の画像そのもの」の参照だけ。置き換えは `replace_all` を種類ごとに）: `e2e/home-test-utils.ts`（`SEEDED_ITEM_IMAGE` と 2 か所の `'e2e/news-1.png'`）、`e2e/look-admin-test-utils.ts`（`e2e/look-1-1.png` 2 か所と説明の文）、`e2e/FR-LOOK-ALL-042-season-label-and-hover-image-remaining.spec.ts`、`FR-LOOK-ALL-044-list-behaviour-and-grid-remaining.spec.ts`（2 か所）、`FR-LOOK-DETAIL-019-detail-content-and-links-remaining.spec.ts`、`FR-LOOK-SEC-002-postgrest-policies.spec.ts`（`SEEDED_LOOK_IMAGE`・`ITEM_IMAGE`）、`FR-LOOK-SEC-005-global-faults.spec.ts`、`FR-NEWS-DETAIL-009-detail-edge-cases-and-body-safety.spec.ts`、`FR-NEWS-SEC-001-public-data-exposure.spec.ts`（3 か所）、`FR-NEWS-SEC-003-http-hardening-and-rate-limit.spec.ts`（`createSignedUrl` の道筋と冒頭の説明）、`FR-SEARCH-020-search-db-function-grants.spec.ts`（3 か所）
- 読むだけ: `tests/unit/api/admin/looks/looks-id-*-route.test.ts`・`tests/unit/features/{look,news}/services/admin-images.test.ts`・`tests/integration/api/{look,news}-admin-item-*-api.test.ts`・`tests/unit/api/admin/news/news-admin-id-route.test.ts` の `'e2e/look-1-1.png'`・`'e2e/news-1.png'` は **「接頭辞の外の古い見本の道筋は消さない」ことを確かめる負の例なので変えない**（直すと意図が逆になる）。
- Docs: `docs/04_DetailDesign/pages/16-1_admin_news.md`（717 行付近）・`16-3_admin_look.md`（751 行付近）の「古い見本の道筋」の行に「波 2 で見本は `looks/e2e/`・`news/e2e/` に移った。この行は移行前の形の確認」と注記、`docs/03_BasicDesign/decisions/ADR-0160…`・`ADR-0025…` は変えない。`docs/02_Requirements/areas/{look,news}.md` の見本の道筋に触れる文があれば現行に合わせる（`grep -n "e2e/look-\|e2e/news-"`）。

**Interfaces:**

```ts
// tests/helpers/staged-supabase.ts（試験の補助。@impl は付けない）
import fs from 'node:fs';
import path from 'node:path';

/** 名前の末尾（例 'sec_grants_hardening'）で移行を探す。supabase/migrations を先に、無ければ supabase/pending-wave2。
 *  同じ場所に 2 本以上あれば、どちらを読むか決められないので throw。どこにも無ければ throw。root は試験用（既定は process.cwd()）。 */
export function findMigration(suffix: string, root: string = process.cwd()): string; // 絶対パスを返す
export function readMigration(suffix: string, root?: string): string;                // 文字列を返す

/** 見本・見本の置き場の script を探す。pending-wave2/seed/<rel> を先に、無ければ <rel>（rel は repo root からの相対）。 */
export function resolveSeedPath(rel: string, root?: string): string;
```

見本の道筋の規則: 商品 `items/e2e/item-<id>-<n>.png`、LOOK `looks/e2e/look-<id>-<n>.png`、NEWS `news/e2e/news-<id>.png`。置き場は `item-images`・`look-images`・`news-images`（道筋の先頭の語から決まる: `items`→`item-images`、`looks`→`look-images`、`news`→`news-images`）。

- [ ] **Step 1: 現状の確認（読むだけ）。** `git status --short supabase scripts/e2e` で `supabase/seed.sql`・`scripts/e2e/seed-storage.ts` が他者の変更中でないこと、行末（CRLF か）を確かめる（`file supabase/seed.sql`）。`grep -rnE "e2e/(item|look|news)-[0-9a-z]" e2e tests src scripts supabase --include=*.ts --include=*.tsx --include=*.sql` で参照の全部を出し、各参照が「見本の画像そのもの」か「接頭辞の外を表す負の例」かを 1 つずつ分ける。`grep -rn "extractItemImageObjectPath\|isOwnLookImagePath\|isOwnNewsImagePath" src` で本物の判定の関数名と所在を確かめる。
- [ ] **Step 2（RED）: 補助の単体試験を書く。** `staged-supabase.test.ts`（先頭 `DD-LOOK-` ではなく補助なので `TEST-HELPER-` など ID を持たない名前でよいが、`describe` の題は「staged-supabase」）。`fs.mkdtempSync` で小さな偽の repo を作り、(a) `supabase/migrations/20260101000000_sec_x.sql` と `supabase/pending-wave2/20260102000000_sec_x.sql` の両方があれば前者の絶対パスを返す、(b) pending だけにあれば pending の物を返す、(c) どこにも無ければ `not found` を含む例外、(d) 同じ場所に `_sec_x.sql` が 2 本あれば `ambiguous` を含む例外、(e) `resolveSeedPath('supabase/seed.sql')` は `supabase/pending-wave2/seed/supabase/seed.sql` があればそれを、無ければ `supabase/seed.sql` を返す。
- [ ] **Step 3（GREEN）: 補助を書く。** `tsc` を流す。
- [ ] **Step 4: 見本の写しを作る。** `supabase/seed.sql` を `supabase/pending-wave2/seed/supabase/seed.sql` に **全文コピー**してから、Edit の `replace_all` で `'e2e/item-` → `'items/e2e/item-`、`'e2e/look-` → `'looks/e2e/look-`、`'e2e/news-` → `'news/e2e/news-` を直す（`ARRAY['e2e/item-1-1.png', 'e2e/item-1-2.png']` の 2 つ目の要素もカンマと空白の後の `'e2e/item-` なので、同じ部分一致で全部当たることを `grep -c` で確かめる。当たった数は商品 9 行×3、LOOK 7 行×2、NEWS 8 行）。冒頭の説明に「画像の道筋は `items/`・`looks/`・`news/` の下（DB の CHECK とアプリの判定と同じ形）」と 1 行足す。`scripts/e2e/seed-storage.ts` も同じく全文コピーして `path: \`items/e2e/item-${id}-${n}.png\``・`looks/e2e/look-…`・`news/e2e/news-${id}.png` に直し、`SEED_STORAGE_OBJECTS` の説明を直す。`./environment` の import は**そのまま**（写しの隣の `environment.ts` が再公開する）。`npx tsc --noEmit`。
- [ ] **Step 5（RED→GREEN）: `seed-storage.test.ts` を直す。** 読む先を `resolveSeedPath` にする（`seed.sql` は `resolveSeedPath('supabase/seed.sql')`、モジュールは `require(resolveSeedPath('scripts/e2e/seed-storage.ts'))` で `SEED_STORAGE_OBJECTS`・`seedLocalStorage`・`SEED_IMAGE_PNG_BASE64` を受け、型は元の import の `type` を使う）。期待を直す: 件数 40 のまま、最初の `upload` の道筋は `items/e2e/item-1-1.png`、失敗の文は `item-images/items/e2e/item-1-1.png（Bucket not found）`。一致の試験は `seed.sql` を `/(?:items|looks|news)\/e2e\/(?:item|look|news)-[0-9-]+\.png/g` で読み、置く一覧と集合が等しいこと、各 `object.bucket` が先頭の語の対応（`items`→`item-images` など）になること。**足す断言**: (a) `seed.sql` に旧い形 `'e2e/(item|look|news)-` が 1 つも残らない（`expect(seed).not.toMatch(/'e2e\/(?:item|look|news)-/)`）。(b) `looks/`・`news/` で始まる見本の道筋が、アプリの `isOwnLookImagePath`・`isOwnNewsImagePath` を全部通る（DB の CHECK と同じ式を、アプリの判定で代表させる）。(c) `items/` の見本の道筋が `extractItemImageObjectPath` で変わらずに取り出せる。`npx jest tests/unit/scripts/e2e/seed-storage.test.ts tests/unit/helpers/staged-supabase.test.ts`。
- [ ] **Step 6: E2E の参照を直す（書くだけ）。** Step 1 の表のうち「見本の画像そのもの」だけを、種類ごとの `replace_all` で直す。`FR-LOOK-SEC-002:38-39` は `SEEDED_LOOK_IMAGE = 'looks/e2e/look-1-1.png'`・`ITEM_IMAGE = 'items/e2e/item-3-1.png'`、`home-test-utils.ts:31` は `SEEDED_ITEM_IMAGE = 'items/e2e/item-3-1.png'`。`FR-NEWS-SEC-001:335` の `for (const path of [pubPath, 'news/e2e/news-1.png'])` は「置き場に本物の画像がある」前提を保つ。`FR-NEWS-SEC-001` の `otherPath`（`other/…`）・`missingPath` は見本ではないので変えない。`grep -rnE "e2e/(item|look|news)-" e2e` で `'e2e/…'` の旧い形が残るのは負の例（単体・結合試験側）だけであること、`items/e2e/`・`looks/e2e/`・`news/e2e/` の形に直した数が Step 1 の表と一致することを確かめる。
- [ ] **Step 7: 文書。** 上の Docs。`docs/05_Quality/security/threats/{look,news}.md` に見本の道筋への言及があれば直す。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`（写しの `.ts` を含めて通ること）、`npm run validate-docs`、`npx jest tests/unit/scripts/e2e tests/unit/helpers`。
- [ ] **Step 9: 報告。** controller が移す物の表（`supabase/pending-wave2/seed/supabase/seed.sql` → `supabase/seed.sql`、`…/scripts/e2e/seed-storage.ts` → `scripts/e2e/seed-storage.ts`、`environment.ts` は移さず写しのフォルダごと消す）と、移した後に流す物（`npx jest tests/unit/scripts/e2e`、`db reset`、E2E の画像が出ること）。共有文書の変更案は無し（`test-spec.md` の見本の道筋の記述があれば）。

**検証コマンド:** `npx tsc --noEmit`、`npx jest tests/unit/scripts/e2e tests/unit/helpers`、`npm run validate-docs`。

---

## Task 2: `stockists.type` の NOT NULL を外す（SEC の印なし・FR-ADMIN-006-AC-02・FREQ-18-AC-01）

**範囲:** 窓口は元から `type` を入れない（ADR-0256）ので、列の NOT NULL が残る本番・手元では取扱店を 1 件も作れない。NOT NULL だけを外し、列と CHECK（`FLAGSHIP STORE`・`STORE`・`SELECT SHOP`）は残す（Q21）。独立して早く出せる。

**Files:**

- Create: `supabase/pending-wave2/<時刻>_stockists_type_optional.sql`、`tests/integration/db/stockist_type_optional.integration.test.ts`
- Modify: `e2e/FR-STOCKIST-013-admin-stockist-screens.spec.ts`（`test.fail` を 2 行外す）、`tests/integration/db/stockist_table.integration.test.ts`（`type` の NOT NULL を固定する行があれば）
- Docs: `docs/02_Requirements/areas/stockist.md`（FR-ADMIN-006-AC-02・FREQ-18-AC-01 の「今のコードは満たさない」）、`docs/05_Quality/security/threats/stockist.md`、`docs/03_BasicDesign/areas/stockist.md`（`DATA-STOCKIST-001`: `type` は NULL 可。窓口は入れない）

**移行（骨格）:**

```sql
-- ROLLBACK（Task 2）:
--   UPDATE public.stockists SET type = 'STORE' WHERE type IS NULL;   -- NULL の行ができていれば先に値を入れる
--   ALTER TABLE public.stockists ALTER COLUMN type SET NOT NULL;
BEGIN;
DO $stockists_type_optional$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'stockists' AND column_name = 'type') THEN
    ALTER TABLE public.stockists ALTER COLUMN type DROP NOT NULL;
  END IF;
END
$stockists_type_optional$;
-- 自己検査: 列があるなら is_nullable = 'YES'、stockists_type_check は残っている
NOTIFY pgrst, 'reload schema';
COMMIT;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "type" src/app/api/admin/stockists/route.ts src/features/stockist/schemas.ts` で窓口が `type` を入れないこと、`grep -rn "stockists" tests/integration/db/stockist_table.integration.test.ts | grep -i "type"` で NOT NULL を固定した行を出す。`FR-STOCKIST-013:119・237` の `test.fail` の行番号を取り直す。
- [ ] **Step 2（RED）: DB 結合試験を書く（流さない）。** `stockist_type_optional.integration.test.ts`（先頭 `DATA-STOCKIST-001`）: (a) `information_schema.columns` の `type` が `is_nullable = 'YES'`。(b) 取引の中で `type` を省いた `insert into public.stockists (name, address, phone, time, holiday, status) values (…)` が通り、`type` が NULL（最後に rollback）。(c) `type = 'BAD'` の insert は SQLSTATE `23514`（`stockists_type_check`）、`'STORE'`・`'FLAGSHIP STORE'`・`'SELECT SHOP'` は通る。(d) 見本の行（`supabase/seed.sql` の取扱店）の `type` が消えていない。(e) 移行の形（DB なし）: `readMigration('stockists_type_optional')` が `DROP NOT NULL` を 1 回だけ含み、`DROP COLUMN` を含まず、ヘッダーに `ROLLBACK` の節がある。
- [ ] **Step 3（GREEN）: 移行を書く。** 時刻は P13 のとおり。自己検査は `RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'stockists_type_optional'`。
- [ ] **Step 4: 既存の DB 試験を直す。** `stockist_table.integration.test.ts` などが「`type` は NOT NULL」「`type` 無しの insert は 23502」を固定していれば、NULL 可に直す。
- [ ] **Step 5: E2E の印（書くだけ）。** 外す: `FR-STOCKIST-013:119`（`FR-ADMIN-006-AC-02`）、`:237`（`FREQ-18-AC-01`）。外さない: `:320`・`:332`（`SEC-STOCKIST-019` は波 4）。
- [ ] **Step 6: 文書。** 上の Docs。`stockists.type` を列ごと消す案は seed・E2E 補助・結合試験の全書き換えと本番の種別の消失を伴うので後回し、と `threats/stockist.md` か ADR の「結果」に 1 行。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`、`npx jest tests/integration/db/stockist_type_optional.integration.test.ts`（DB なしの形の試験だけが走り、DB の試験は `DATABASE_URL` 未設定で skip される）。
- [ ] **Step 8: 報告。** 共有文書の変更案（`db-migrations.md` に移行の行と本番適用前の確認「`select is_nullable from information_schema.columns where table_name='stockists' and column_name='type'`」、`er.md` の `stockists.type`）。本番の事前の確認: `stockists.type` の `is_nullable`。

**検証コマンド:** `npx tsc --noEmit`、`npx jest tests/integration/db/stockist_type_optional.integration.test.ts`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`。

---

## Task 3: 取扱店・ニュースの管理の書き込みを service role に移す（P2・Task 5 の前提）

**範囲:** `createClient(request)`（利用者の JWT）で書いている 2 領域の管理の窓口の書き込み（POST・PUT・PATCH・DELETE）を、認可の後に `createServiceRoleClient()` で行う。GET（一覧・詳細）は変えない。**窓口の応答・監査・404 の意味は変えない。** 移行は無い。

**Files:**

- Modify: `src/app/api/admin/stockists/route.ts`（POST）、`src/app/api/admin/stockists/[id]/route.ts`（PUT・PATCH・DELETE。GET は `createClient` のまま）、`src/app/api/admin/news/route.ts`（POST。`dbSupabase`・`uploadSupabase` を 1 つの service role client にまとめる）、`src/app/api/admin/news/[id]/route.ts`（PUT・PATCH・DELETE。同上）
- Test: `tests/unit/api/admin/stockists/stockists-route.test.ts`・`stockists-id-route.test.ts`・`tests/unit/api/admin/stockists-security.test.ts`、`tests/unit/api/admin/news/`（`news-admin-*` の単体）、`tests/integration/api/stockist-admin-{create,item-put,item-patch,item-delete,write-path,guards}*.test.ts`、`tests/integration/api/news-admin-{item-put,item-delete,write-path}*.test.ts`（`createClient` のモックに書き込みの連鎖を持たせている所を `createServiceRoleClient` に替える）
- Docs: `docs/03_BasicDesign/decisions/ADR-0464-admin-stockist-news-writes-use-service-role.md`（新規）、`docs/03_BasicDesign/areas/{stockist,news}.md`（管理の書き込みの client の記述。`ARC-NEWS-003`・`ARC-STOCKIST-` 周辺）、`docs/04_DetailDesign/pages/{16-4_admin_stockist,16-1_admin_news}.md`（`@remarks` に対応する `DD-`）、`docs/05_Quality/security/threats/{stockist,news}.md`、`docs/02_Requirements/areas/{stockist,news}.md`（波 1-B が書いた「利用者の session の client なので aal2 でない時や RLS が隠す時に 403 でなく 404 になりうる」の注記を外す。`grep -rn "利用者の session の client\|RLS が隠す" docs`）

**Interfaces:**

```ts
// 4 ファイルとも、書き込みの関数の中で:
//   const authz = await authorizeAdminPermission('admin.<area>.manage', request);   // 認可・aal2・回数・CSRF は今のまま、先に
//   ...入力の検証（今のまま）...
//   const supabase = await createServiceRoleClient();                              // createClient(request) をやめる
// 0 行 → 404、error → 500、監査の呼び出しは今のまま。GET は createClient(request) のまま。
// news の POST・PUT は、行の書き込みと置き場の書き込みに同じ client を使う（uploadSupabase と dbSupabase を 1 つに）。
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `grep -n "createClient\|createServiceRoleClient" src/app/api/admin/stockists/route.ts src/app/api/admin/stockists/\[id\]/route.ts src/app/api/admin/news/route.ts src/app/api/admin/news/\[id\]/route.ts` で、どの関数がどの client を使うかを表にする（stockists POST=114 行、PUT=144、PATCH=271、DELETE=358、GET=43・65。news POST=115-116、PUT=166-167、PATCH=334、DELETE=380、GET=102-103・209-210）。**対象 5 表への書き込みを `src` 全体で洗う**: `grep -rnE "\.from\('(looks|look_items|news_articles|stockists|item_color_presets|item_cost_history)'\)" src --include=*.ts --include=*.tsx` の各行で、使われる client が `createServiceRoleClient` であること（`looks`・`look_items`・`item_color_presets` の窓口は確認済み）を 1 つずつ確かめ、利用者の JWT の書き込みが他に無いこと（`src/lib/look/server.ts` と `src/features/news/services/public.ts`・`src/features/stockist/services/public.ts` は読みだけ）を報告に書く。
- [ ] **Step 2（RED）: 単体試験を直す・足す。** 各窓口の試験に、(a) POST・PUT・PATCH・DELETE が `createServiceRoleClient` を 1 回呼び、`createClient` を**呼ばない**（`expect(createClient).not.toHaveBeenCalled()`）。(b) GET は `createClient` を呼ぶ（変えていない）。(c) 認可が 401/403 の時はどちらの client も作らない。(d) 0 行 → 404・error → 500・監査の `outcome` は今までと同じ（既存の期待をそのまま通す）。テスト名の先頭は `DD-STOCKIST-034`・`035`・`DD-NEWS-065` など既存の `DD-`。
- [ ] **Step 3（GREEN）: 4 ファイルを直す。** 書き込みの関数の `createClient(request)` を `createServiceRoleClient()` に替える。news の POST・PUT は `dbSupabase`・`uploadSupabase` を 1 つにまとめ、後始末（`cleanupClient`）の参照も揃える。`tsc` を流す。`@remarks` に「書き込みは認可の後に service role で行う。RLS の書き込み方針は権限を外した後も二重の守りとして残る（ADR-0464）」を足す。
- [ ] **Step 4: 結合試験のモックを直す。** `createClient` のモックが書き込みの連鎖（`insert/update/delete().eq().select()`）を持つ所を、`createServiceRoleClient` のモックに移す。読みの連鎖（GET）は `createClient` に残す。
- [ ] **Step 5: 対象の `jest`。** `npx jest tests/unit/api/admin/stockists tests/unit/api/admin/stockists-security.test.ts tests/unit/api/admin/news tests/integration/api/stockist-admin-create-api.test.ts tests/integration/api/stockist-admin-item-put-api.test.ts tests/integration/api/stockist-admin-item-patch-api.test.ts tests/integration/api/stockist-admin-item-delete-api.test.ts tests/integration/api/stockist-admin-write-path.test.ts tests/integration/api/stockist-admin-guards.test.ts tests/integration/api/news-admin-item-put-api.test.ts tests/integration/api/news-admin-item-delete-api.test.ts tests/integration/api/news-admin-write-path.test.ts`（存在しない名前は `ls tests/integration/api | grep -E "stockist-admin|news-admin"` で取り直す）。
- [ ] **Step 6: E2E の印と期待（書くだけ）。** 外す印は無い。`FR-STOCKIST-015`・`FR-NEWS-SEC-005` の期待（404・監査）が変わらないことを読んで確かめる。
- [ ] **Step 7: 文書。** 上の Docs。`ADR-0464` の「結果」に、窓口の認可が唯一の守りになるので `authorizeAdminPermission` の位置（本文の検証より前）を変えないこと、波 5 の `has_permission` の aal2 は読みの方針だけが対象になること。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`、`npm run validate-trace -- NEWS`。
- [ ] **Step 9: 報告。** 設計書 R3・R4 の前提（管理の書き込みは全部 service role）の訂正、Step 1 の表、共有文書の変更案（`api-spec.md` は応答が変わらないので無し。`route-inventory.md` の client の列があれば）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- STOCKIST`・`-- NEWS`。

---

## Task 4: `items` の列権限・`item_cost_history`・認証の表・`profiles`（R4: SEC-HOME-004・005・020・003 AC-02、SEC-AUTH-011）

**範囲:** 移行 `sec_grants_hardening` を作る。(1) `items`: 全権限を外し、原価 2 列以外の 21 列を anon・authenticated の SELECT だけにする。(2) `item_cost_history`: 方針 `"Allow all"` を消し、権限を外し、`admin.finance.read` の SELECT 方針と authenticated の SELECT を付ける。(3) `sessions`・`password_reset_tokens`・`rate_limit_counters`・`audit_logs`・`audit_logs_backups`: anon・authenticated から全権限を外す。連番 `rate_limit_counters_id_seq` も。(4) `profiles`: anon から全権限、authenticated から `TRUNCATE`・`REFERENCES`・`TRIGGER`・`MAINTAIN`。service_role の GRANT を明示する。

**Files:**

- Create: `supabase/pending-wave2/<時刻>_sec_grants_hardening.sql`、`tests/integration/db/home_items_grants.integration.test.ts`
- Modify: `tests/integration/db/auth_sessions_table.integration.test.ts`・`auth_password_reset_tokens_table.integration.test.ts`（anon・authenticated で「0 行」を期待する箇所を `42501` に。RLS の方針が 3 本ある旨の検査は残す）、`tests/integration/db/rate_limit_counters.integration.test.ts`・`sessions.integration.test.ts`（役を替えて読む行があれば）
- Modify（E2E）: `e2e/FR-HOME-024-home-table-grants.spec.ts`（`test.fail` を 4 行外す。`columnSets`・`secrets`・結合の列の並びから `product_note` を外す）、`e2e/home-grant-test-utils.ts`（`product_note` が原価の仲間として扱われていれば）、`e2e/FR-LOGIN-031-supabase-direct-bypass.spec.ts`（011 の印を外し、`AUTH_TABLES` に `audit_logs_backups` を足す）
- Docs: `docs/02_Requirements/areas/home.md`（SEC-HOME-004: 公開のままの列に `product_note` を入れ「原価 2 列」に言い直す。SEC-HOME-005: authenticated の INSERT・UPDATE・DELETE は「付け直さない（書き込みは service role）」に直す。SEC-HOME-020: 表は残し管理者の SELECT 方針だけ）、`areas/auth.md`（SEC-AUTH-011）、`docs/05_Quality/security/threats/{home,auth}.md`、`docs/03_BasicDesign/areas/home.md`（`DATA-HOME-001` を新設: `items` の列権限と公開の列）・`areas/auth.md`（`DATA-AUTH-001`・`002`・`003` の権限の記述）、`ADR-0462`・`ADR-0463`（新規）

**移行（骨格。列の一覧は書く時に `information_schema.columns` の現物と突き合わせる）:**

```sql
-- ROLLBACK（Task 4。適用前に本番の旧い状態を読んで、下を合わせる）:
--   DROP POLICY IF EXISTS "admin item_cost_history read by finance permission" ON public.item_cost_history;
--   CREATE POLICY "Allow all" ON public.item_cost_history FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
--   REVOKE SELECT (id, name, ..., return_ineligible) ON TABLE public.items FROM anon, authenticated;
--   GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE
--     public.items, public.item_cost_history, public.sessions, public.password_reset_tokens,
--     public.rate_limit_counters, public.audit_logs, public.audit_logs_backups, public.profiles TO anon, authenticated;
--   GRANT ALL ON SEQUENCE public.rate_limit_counters_id_seq TO anon, authenticated;
BEGIN;
-- 1. items: 列単位
REVOKE ALL ON TABLE public.items FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, name, description, price, category, image_url, image_urls, colors, sizes, product_details,
              status, created_at, updated_at, material, origin, sewing_region, care, season, product_note,
              made_to_order_lead_days, return_ineligible)
  ON TABLE public.items TO anon, authenticated;
GRANT ALL ON TABLE public.items TO service_role;
-- 2. item_cost_history: 管理者の読みだけ
DROP POLICY IF EXISTS "Allow all" ON public.item_cost_history;
REVOKE ALL ON TABLE public.item_cost_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.item_cost_history TO authenticated;
GRANT ALL ON TABLE public.item_cost_history TO service_role;
DROP POLICY IF EXISTS "admin item_cost_history read by finance permission" ON public.item_cost_history;
CREATE POLICY "admin item_cost_history read by finance permission" ON public.item_cost_history
  FOR SELECT TO authenticated USING ((SELECT public.has_permission('admin.finance.read'::text)));
-- 3. 認証の表（RLS の全拒否の方針は残す）と連番
REVOKE ALL ON TABLE public.sessions, public.password_reset_tokens, public.rate_limit_counters,
  public.audit_logs, public.audit_logs_backups FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE <同じ 5 表> TO service_role;
REVOKE ALL ON SEQUENCE public.rate_limit_counters_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.rate_limit_counters_id_seq TO service_role;
-- 4. profiles
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.profiles FROM authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;
-- 5. 自己検査（DO）: 下の「自己検査の中身」
NOTIFY pgrst, 'reload schema';
COMMIT;
```

自己検査の中身: (a) `items` に原価 2 列以外の列が増えていて、一覧に無い（= 取りこぼし）なら失敗（`information_schema.columns` の列名の集合 − 一覧 − 原価 2 列 が空）。(b) anon・authenticated が `pattern_cost`・`mass_production_cost` を `has_column_privilege(…, 'SELECT')` で読めない。(c) anon・authenticated の `items` の表単位の `has_table_privilege(…, 'SELECT')` が偽、書き込み系 7 権限が偽。(d) 認証の 5 表で anon・authenticated の 8 権限がすべて偽。(e) `profiles` の anon が全部偽、authenticated の `TRUNCATE`・`REFERENCES`・`TRIGGER`・`MAINTAIN` が偽で `SELECT`・`INSERT`・`UPDATE`・`DELETE` が真。(f) `item_cost_history` の anon が全部偽、authenticated は `SELECT` だけ真。(g) service_role が 8 表で `SELECT`・`INSERT`・`UPDATE`・`DELETE` を持つ。

- [ ] **Step 1: 現状の確認（読むだけ）。** `information_schema.columns` を読めないので、`remote_schema.sql:572-600` と `ALTER TABLE … items` を出す移行（`20260919065336`・`20260921121038`・`20261020144439`）で列の一覧を作り、P3 の 21 列と一致することを確かめる。**公開側の読みを全部洗う**: `grep -rn "select('\*')" src --include=*.ts --include=*.tsx` の各行の client が service role であること、`items(` の埋め込み（`cart-view.ts:32`・`availability.ts:64`）が許可内の列だけであること、`ITEM_SELECT_COLUMNS`（`src/lib/items/public.ts`）・`/api/items/[id]/route.ts`・wishlist・`look/server.ts`・`kpi/route.ts:315`（`id, status`）、`search_items` が許可内であること。方針・SECURITY INVOKER 関数・ビューが `items` の列を読む所: `grep -nE "(FROM|JOIN) (public\.)?\"?items\"?" supabase/migrations/*.sql` の方針・INVOKER の部分（`item_colors`・`item_sizes` の方針は `id`・`status` だけ）。SECURITY DEFINER の関数（`finalize_order…` 系）は列権限に左右されないこと（`pg_proc.prosecdef`）。結果を表で報告に書く。
- [ ] **Step 2: 認証の 5 表と `profiles` の書き手を確かめる（読むだけ）。** `grep -rnE "\.from\('(sessions|password_reset_tokens|rate_limit_counters|audit_logs|audit_logs_backups)'\)" src` の各行の client が service role、`rate_limit_counters` は SECURITY DEFINER の rpc 経由、`profiles` は `/api/profile`・`/api/profile/addresses` が利用者の JWT で SELECT・upsert・DELETE すること（authenticated の 4 権限を残す理由）を報告に書く。
- [ ] **Step 3（RED）: DB 結合試験を書く（流さない）。** `home_items_grants.integration.test.ts`（先頭 `DATA-HOME-001`）と、権限の一覧の試験は Task 9 に分ける。ここでは移行ごとの断言: (a) `has_column_privilege('anon', 'public.items', 'pattern_cost', 'SELECT')` と `mass_production_cost` が偽、同じ列を authenticated も偽。(b) 21 列は anon・authenticated ともに真（`test.each`）。(c) `has_table_privilege('anon', 'public.items', 'SELECT')` は偽（列単位だけ）、`has_any_column_privilege` は真。(d) anon・authenticated の `INSERT`・`UPDATE`・`DELETE`・`TRUNCATE`・`REFERENCES`・`TRIGGER`・`MAINTAIN` が `items` で偽（表単位・列単位の両方: `has_any_column_privilege(…, 'INSERT')`）。(e) 役を替えて（`set local role anon`）`select pattern_cost from public.items limit 1` と `select * from public.items limit 1` が SQLSTATE `42501`、`select id, name, product_note, status from public.items where status = 'published' limit 1` が通る（見本の商品が公開）。(f) `item_cost_history`: anon の `select` が `42501`、authenticated の会員（権限なし）の `select` は 0 行、`admin.finance.read` を持つ authenticated（`auth.users`・`user_roles`・`role_permissions` の行を取引の中で作り `request.jwt.claims` に `sub`・`role`・`aal2` を入れる。既存の `look_permissions.integration.test.ts` の補助を参照）は取引の中で入れた行が見える、`insert/update/delete/truncate` はどの役も `42501`（service_role は通る）、`"Allow all"` の方針が `pg_policies` に無い。(g) 5 表: `set local role anon / authenticated` での `select` が `42501`（0 行ではない）、`service_role` は通る。連番 `rate_limit_counters_id_seq` の `has_sequence_privilege('anon', …, 'USAGE')` が偽、service_role は真。(h) `profiles`: anon の `select` が `42501`、authenticated は自分の行を `select/insert/update/delete` でき、`truncate` は `42501`。(i) 移行の形（DB なし）: `readMigration('sec_grants_hardening')` に `GRANT SELECT (` の列の一覧があり、`pattern_cost`・`mass_production_cost` を含まない、`ALTER DEFAULT PRIVILEGES` を含まない、`ROLLBACK` の節がある、一覧の列が Step 1 で作った 21 列と一致する。
- [ ] **Step 4（GREEN）: 移行を書く。** 上の骨格に自己検査を足す。
- [ ] **Step 5: 既存の DB 試験を直す。** `auth_sessions_table`・`auth_password_reset_tokens_table` の「anon・authenticated からは行が見えない（0 行）」を `42501` に。`grep -rln "set local role \(anon\|authenticated\)" tests/integration/db | xargs grep -ln "sessions\|password_reset_tokens\|rate_limit_counters\|audit_logs"` で他にも無いか確かめる。
- [ ] **Step 6: E2E の印と期待（書くだけ）。**
  - 外す: `FR-HOME-024:134`（`SEC-HOME-003-AC-02`。幅ごとの繰り返しの中の 1 本。aal1 の管理者の `items` の update・delete が `expectDeniedOrZero` で断られる）、`:185`（`SEC-HOME-004-AC-01`。`columnSets` の `'product_note'` と `'pattern_cost,mass_production_cost,product_note'` を `'pattern_cost,mass_production_cost'` に、`secrets` から `item.note` を外す。`product_note` を選ぶ対照の読みを足す: 公開の列として 200 で値が返る）、`:297`（`SEC-HOME-005-AC-01`）、`:306`（`SEC-HOME-020-AC-01`）。`FR-LOGIN-031:325` 付近（`SEC-AUTH-011-AC-01`）。
  - 外さない: `FR-HOME-024:96`（`SEC-HOME-003-AC-01` は非公開の行の読み取り。波 5）、`FR-LOGIN-031:234`・`:258`（`SEC-AUTH-005`）・`:282`（`SEC-AUTH-010` は `orders`。G の表）。
  - 予想は読んだだけなので、controller が流して「予想外の失敗」（外した印のテストが落ちる）が出たら、その印を元に戻して報告する。
- [ ] **Step 7: 文書。** 上の Docs。`SEC-HOME-004` の「`product_note` も読めない」を訂正した経緯（Q7）を `ADR-0462` の根拠に書く。`ADR-0463` に P4 の事実（読む画面は無い）。
- [ ] **Step 8: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- HOME`・`-- AUTH`、`npx jest tests/integration/db/home_items_grants.integration.test.ts`（DB なしの形の試験だけが走る）。
- [ ] **Step 9: 報告。** Q8 の事実（原価の画面は `item_cost_history` を読まない）、Step 1・2 の表、共有文書の変更案（`db-migrations.md`: 移行の行と、本番の事前の確認「`has_table_privilege('anon','public.items','select')`・`has_column_privilege('anon','public.items','pattern_cost','select')`・`select count(*) from public.item_cost_history`」、`er.md`: `items` の列権限・`item_cost_history`・`profiles`）。**本番の事前の確認（読むだけ）**: 上の 3 つ、`select count(*) from item_cost_history`（行があれば原価が公開されていた期間の記録として報告）、`pg_policies` の `item_cost_history`・認証の 5 表。

**検証コマンド:** `npx tsc --noEmit`、`npx jest tests/integration/db/home_items_grants.integration.test.ts`、`npm run validate-docs`、`npm run validate-trace -- HOME`・`-- AUTH`。

---

## Task 5: 管理だけが書く表から anon・authenticated の書き込みを外す（R4-4。SEC-LOOK-003 AC-02・004、SEC-NEWS-002 AC-02・022、SEC-STOCKIST-003 AC-02・AC-03・008、SEC-ADMIN-002 AC-01）

**範囲:** 移行 `sec_grants_admin_tables`。`looks`・`look_items`・`news_articles`・`stockists` は anon・authenticated に SELECT だけ、`item_color_presets` は authenticated に SELECT だけ（P5）。連番 `stockists_id_seq` の anon・authenticated の権限を外し、service_role に USAGE・SELECT を明示する。RLS の方針は残す（P6）。**Task 3 が済んでから。**

**Files:**

- Create: `supabase/pending-wave2/<時刻>_sec_grants_admin_tables.sql`、`tests/integration/db/look_sec_grants_admin_tables.integration.test.ts`（1 本にまとめ、`look_` で始めて LOOK の glob に当てる。テスト名の先頭の ID で領域を分ける: `DATA-LOOK-003`・`DATA-NEWS-002`・`DATA-STOCKIST-002`・`DATA-ADMIN-`）
- Modify（DB 結合試験。管理者の JWT で書けることを期待する行を `42501` に）: `look_rls`・`look_permissions`・`look_items_table`・`look_table`・`look_status_state`、`news_articles_rls`・`news_permissions`・`news_articles_table`・`news_status_state`、`stockist_rls`・`stockist_permissions`・`stockist_table`・`stockist_status_state`、`admin-misc/admin_item_color_presets_table.integration.test.ts`（各 `.integration.test.ts`）
- Modify（E2E）: `e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts`、`e2e/FR-NEWS-SEC-002-direct-db-access.spec.ts`、`e2e/FR-STOCKIST-016-direct-db-access-and-session.spec.ts`、`e2e/FR-ADMIN-MISC-005-item-color-presets-and-direct-db-access.spec.ts`
- Docs: `docs/02_Requirements/areas/{look,news,stockist,admin}.md`、`docs/05_Quality/security/threats/{look,news,stockist,admin}.md`、`docs/03_BasicDesign/areas/{look,news,stockist,admin}.md`（`DATA-LOOK-003`・`DATA-NEWS-002`・`DATA-STOCKIST-002` と色見本の DATA）

**移行（骨格）:**

```sql
-- ROLLBACK（Task 5。本番の旧い状態を適用前に読んで合わせる）:
--   GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE
--     public.looks, public.look_items, public.news_articles, public.stockists, public.item_color_presets TO anon, authenticated;
--   GRANT ALL ON SEQUENCE public.stockists_id_seq TO anon, authenticated;
BEGIN;
REVOKE ALL ON TABLE public.looks, public.look_items, public.news_articles, public.stockists,
  public.item_color_presets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.looks, public.look_items, public.news_articles, public.stockists TO anon, authenticated;
GRANT SELECT ON TABLE public.item_color_presets TO authenticated;
GRANT ALL ON TABLE public.looks, public.look_items, public.news_articles, public.stockists,
  public.item_color_presets TO service_role;
REVOKE ALL ON SEQUENCE public.stockists_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.stockists_id_seq TO service_role;
-- 自己検査: 5 表で anon・authenticated の INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN が偽、SELECT が上の表のとおり、
--           service_role が 4 権限を持つ、stockists_id_seq の USAGE が anon・authenticated で偽・service_role で真、
--           書き込みの方針（admin … manage by permission …）が pg_policies に残っている
NOTIFY pgrst, 'reload schema';
COMMIT;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** Task 3 が済んでいること（`grep -n "createClient" src/app/api/admin/{stockists,news}/**` の書き込みの関数が 0）を確かめる。`grep -rln "set local role authenticated" tests/integration/db` と `grep -rn "rest/v1/\(looks\|look_items\|news_articles\|stockists\|item_color_presets\)" e2e | grep -E "post|patch|delete"` で、管理者の JWT で書いて**成功を期待する**試験・補助を全部洗う（対照として aal2 の管理者の書き込みの成功を求める所は、service role か窓口経由に直す）。`FR-ADMIN-MISC-005` が anon で色見本を読む試験を持たないこと（P5）。`test.fail` の行番号を取り直す。
- [ ] **Step 2（RED）: DB 結合試験を書く（流さない）。** 先頭は `DATA-LOOK-003`・`DATA-NEWS-002`・`DATA-STOCKIST-002`・`DATA-ADMIN-` の既存の ID。(a) `test.each` で 5 表×{anon, authenticated}×{INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN} が偽（`has_table_privilege`）。(b) SELECT: `looks`・`look_items`・`news_articles`・`stockists` は anon・authenticated とも真、`item_color_presets` は anon 偽・authenticated 真。(c) 役を替えた書き込みが `42501`（`set local role authenticated` に管理者の `request.jwt.claims`（aal2、`admin.looks.manage` などを持つ）を入れた `insert/update/delete`。RLS の違反 `42501` と区別するため、**文言が `permission denied for table`** であること）、service_role は通る。(d) 公開の読み: anon は公開済みの行だけ読める（方針が変わっていない）。(e) 連番: `has_sequence_privilege('anon','public.stockists_id_seq','USAGE')` 偽、service_role 真。service_role の `insert into public.stockists (…)` が通る（連番の USAGE がある）。(f) 書き込みの方針が `pg_policies` に残る（P6）。
- [ ] **Step 3（GREEN）: 移行を書く。** 骨格のとおり。
- [ ] **Step 4: 既存の DB 試験を直す。** Step 1 の一覧の各行を、管理者の JWT の書き込みは `42501`、service_role の書き込みは通る、に直す。「`DATA-LOOK-003 admin.looks.read と admin.looks.manage を持つ会員は LOOK も関連も追加・更新・削除ができる`」は題を「…書き込みは権限の誤り（42501）で断られる」に。「`DATA-LOOK-003 DB は aal を見ないので、aal1 の JWT でも権限があれば非公開を読み書きできる`（`look_rls:419`）」は**読みの部分だけ**を残し（波 5 で反転する今の穴の固定）、書きの部分は 42501 にする。`stockist_rls:328`・`news_articles_rls` の同種も同じ。
- [ ] **Step 5: E2E の印と期待（書くだけ）。**
  - 外す: `FR-LOOK-SEC-002:295`（`SEC-LOOK-003-AC-02`）・`:369`（`SEC-LOOK-004-AC-01`）・`:396`（`SEC-LOOK-004-AC-02`）、`FR-NEWS-SEC-002:305`（`SEC-NEWS-002-AC-02`）・`:484`（`SEC-NEWS-022-AC-01`）、`FR-STOCKIST-016:253`（`SEC-STOCKIST-003-AC-02`）・`:310`（`SEC-STOCKIST-003-AC-03`。失効後の token の update が権限の誤りで断られる）、`FR-ADMIN-MISC-005:158`（`SEC-ADMIN-002-AC-01`。対照は aal2 の管理者の SELECT で、SELECT を残すので通る）。
  - 外さない（波 5。`has_permission` の aal2 と session の生存）: `FR-LOOK-SEC-002:269`（`SEC-LOOK-003-AC-01`）、`FR-NEWS-SEC-002:261`・`:362`（`SEC-NEWS-002-AC-01`・`AC-03`）、`FR-STOCKIST-016:214`（`SEC-STOCKIST-003-AC-01`）、`FR-ADMIN-MISC-005:202`（`SEC-ADMIN-002-AC-02`）、`FR-HOME-024:96`。
  - `FR-LOOK-SEC-002:369` の期待は「`permission denied for table looks|look_items`」の 42501。`stockists`・`news_articles` にも同じ形の期待を足す必要は無い（DB 結合試験が持つ）。
- [ ] **Step 6: 文書。** `areas/look.md`: `SEC-LOOK-003-AC-02`・`SEC-LOOK-004` の「今のコードは満たさない」を外す（`SEC-LOOK-003-AC-01` は残す）。要件の文「管理の方針が使う INSERT・UPDATE・DELETE は残す」を「付け直さない（書き込みは service role。ADR-0462）」に直す（FREQ-540 との食い違いを ADR に書く）。`areas/news.md`: `SEC-NEWS-002-AC-02`・`SEC-NEWS-022`。`areas/stockist.md`: `SEC-STOCKIST-003-AC-02`・`AC-03`・`SEC-STOCKIST-008`（表・連番の権限）。`areas/admin.md`: `SEC-ADMIN-002-AC-01`。各 `threats/*.md`（THR-LOOK-003・004、THR-NEWS-002・022、THR-STOCKIST-003・008、THR-ADMIN-002）の「今のコードは満たさない」。構造設計の DATA の「表の付与」。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- LOOK`・`-- NEWS`・`-- STOCKIST`・`-- ADMIN`、`npx jest tests/integration/db/look_sec_grants_admin_tables.integration.test.ts`（DB なしの形）。
- [ ] **Step 8: 報告。** 共有文書の変更案（`db-migrations.md`、`er.md` の付与の記述）。本番の事前の確認（読むだけ）: 5 表の `has_table_privilege('anon'|'authenticated', …, 'insert'|'truncate')`、`pg_policies`、`stockists_id_seq` の ACL。**必ず Task 3 の窓口が配備された後にこの移行を本番に当てること**（順序）を書く。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- LOOK`・`-- NEWS`・`-- STOCKIST`・`-- ADMIN`。

---

## Task 6: 検索の関数 3 本と `search_public_*`（R5-1・R5-2。SEC-SEARCH-003・007・008、SEC-LOOK-010、SEC-NEWS-010）

**範囲:** 移行 `sec_search_functions`。`search_items`・`search_looks`・`search_news` を `CREATE OR REPLACE`（上限 8、検索語 100 字、`\` を先に逃がす）、`search_public_items/looks/news` を `REVOKE ALL … FROM PUBLIC, anon, authenticated`。SEARCH・LOOK・NEWS が共有する 1 本。

**Files:**

- Create: `supabase/pending-wave2/<時刻>_sec_search_functions.sql`
- Modify: `tests/integration/db/search-functions.integration.test.ts`（今の挙動を固定した行を書き換える）、`tests/integration/db/search-popular-items.integration.test.ts`（影響があれば）
- Modify（E2E）: `e2e/FR-SEARCH-020-search-db-function-grants.spec.ts`、`e2e/FR-SEARCH-021-search-injected-rows.spec.ts`、`e2e/FR-NEWS-SEC-002-direct-db-access.spec.ts`、`e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts`
- Docs: `docs/02_Requirements/areas/{search,look,news}.md`、`docs/05_Quality/security/threats/{search,look,news}.md`、`docs/03_BasicDesign/areas/{search,look,news}.md`（`DATA-SEARCH-001`・`DATA-SEARCH-003`・`DATA-LOOK-004`・`DATA-NEWS-003`）、`docs/04_DetailDesign/pages/19_search.md`、`ADR-0465`（新規）

**移行（骨格）:** 関数の本体は `remote_schema.sql:2139-2237`（`search_items`・`search_looks`・`search_news`）と `:2240-2330`（`search_public_*`）の最新を**そのまま写し**、下だけを変える。

```sql
-- ROLLBACK（Task 6）: search_items / search_looks / search_news を remote_schema.sql の旧い本体（LIMIT limit_count と
--   replace(replace(…, '%', '\%'), '_', '\_')）に CREATE OR REPLACE で戻し、
--   GRANT EXECUTE ON FUNCTION public.search_public_items(text, integer), public.search_public_looks(text, integer),
--     public.search_public_news(text, integer) TO PUBLIC, anon, authenticated;
BEGIN;
CREATE OR REPLACE FUNCTION public.search_items (search_query text, limit_count integer DEFAULT 8)
  RETURNS TABLE (id bigint, name text, description text, category text, image_url text, price integer)
  LANGUAGE sql STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
AS $function$
  SELECT i.id::bigint, i.name::text, i.description::text, i.category::text, i.image_url::text, i.price::int
  FROM public.items AS i
  CROSS JOIN LATERAL (
    SELECT '%' || replace(replace(replace(left(search_query, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pat
  ) AS p
  WHERE i.status = 'published'
    AND (i.name ILIKE p.pat ESCAPE '\' OR i.description ILIKE p.pat ESCAPE '\' OR i.category ILIKE p.pat ESCAPE '\')
  ORDER BY i.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(limit_count, 8), 8));
$function$;
-- search_looks（theme・theme_description）、search_news（title・content・category。ORDER BY published_date DESC）も同じ形
REVOKE ALL ON FUNCTION public.search_public_items(text, integer), public.search_public_looks(text, integer),
  public.search_public_news(text, integer) FROM PUBLIC, anon, authenticated;
-- 自己検査（DO）: search_* 3 本は anon・authenticated が EXECUTE できる・PUBLIC に無い・SECURITY INVOKER・proconfig が元のまま・
--   本体に 'LEAST(COALESCE(limit_count, 8), 8)' を含む。search_public_* 3 本は anon・authenticated が EXECUTE できず、
--   aclexplode の grantee 0 が無く、postgres・service_role は EXECUTE できる。
NOTIFY pgrst, 'reload schema';
COMMIT;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `search-functions.integration.test.ts` の固定行を一覧にする（`:156-165` 付近の「21 を渡せば 21 件・100 なら 22 件・NULL は上限なし・負は 2201W」、`:170` 付近の `search_public_*` を PUBLIC に許す期待、`:231` の `search_public_looks` を所有者の接続で比較に使う行）。`search_public_looks` を所有者（postgres）の接続で呼ぶ比較は REVOKE の後も通る（postgres の EXECUTE は残す）ことを確かめる。`src/features/search/services/search.service.ts:254-256・396-398` の `limit_count` の最大が 8 であること、`/api/suggest` の `limit` が 8 以下であること（`getSearchSuggestions(query, limit = 8)` の呼び元）を確かめる。`test.fail` の行番号を取り直す。
- [ ] **Step 2（RED）: DB 結合試験を直す・足す（流さない）。** 先頭 `DATA-SEARCH-001`・`DATA-SEARCH-003`・`DATA-LOOK-004`・`DATA-NEWS-003`。(a) 上限: `limit_count` に 21・100・10000 を渡すと 8 件以下（公開の行を 9 件以上入れた取引の中で）、NULL でも 8 件以下、0・負でも 1 件（エラーにならない）、`search_news` は `published_date DESC` の並びが変わらない。(b) 検索語: 101 字以上の語は先頭 100 字で比べる。(c) `\`: 名前が `100%\off`・`a\%b`・`a\_b` の公開の商品を取引の中で入れ、語 `\` は `\` を含む行だけに当たる、語 `\%` は文字 `\%` を含む行だけ（`\\%` の「生きたワイルドカード」にならない）、語 `%` は `%` を含む行だけ、語 `_` は `_` を含む行だけ（`search_items`・`search_looks`・`search_news` の 3 本）。(d) 公開だけ: 非公開の行は 3 本とも返らない。(e) ACL: `search_*` は anon・authenticated が EXECUTE できる、`search_public_*` は anon・authenticated が `42501`（`set local role` で呼ぶ）、PUBLIC に無い（`aclexplode` の grantee 0）、postgres・service_role は EXECUTE できる。(f) 関数の定義: `prosecdef` が偽、`proconfig` が `search_path=public, public, pg_temp`、戻りの列が変わっていない。(g) 移行の形（DB なし）: `readMigration('sec_search_functions')` が `DROP FUNCTION` を含まず、`CREATE OR REPLACE FUNCTION` を 3 回、`REVOKE ALL ON FUNCTION` を含み、ヘッダーに `ROLLBACK` の節がある。
- [ ] **Step 3（GREEN）: 移行を書く。** `search_looks`・`search_news` は旧い本体の列・条件・並びを写して、`left(…, 100)`・LATERAL・上限だけを変える。
- [ ] **Step 4: 既存の DB 試験を書き換える。** 固定行を (a)〜(e) の新しい期待に。
- [ ] **Step 5: E2E の印と期待（書くだけ）。** 外す: `FR-SEARCH-020:297`（`SEC-SEARCH-007`）・`:320`（`SEC-SEARCH-008`）、`FR-SEARCH-021:238`（`SEC-SEARCH-003`）、`FR-NEWS-SEC-002:410`（`SEC-NEWS-010-AC-01`）・`:434`（`SEC-NEWS-010-AC-02`）、`FR-LOOK-SEC-002:442`（`SEC-LOOK-010-AC-02`）。外さない: `FR-SEARCH-021:273`・`:383`（`SEC-SEARCH-016`・`015` は署名。波 3）。`FR-SEARCH-020` が `MAX_ROWS = 8` で件数を見ていることを読んで確かめる。
- [ ] **Step 6: 文書。** `areas/search.md`・`look.md`・`news.md` の該当 SEC の「今のコードは満たさない」を外す。`DATA-SEARCH-001` の「未使用（削除の判断待ち）の `search_public_*`」は「呼べない（REVOKE 済み）。DROP は NEWS の試験を直した後に別の判断」に。`ADR-0465`。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`・`-- LOOK`・`-- NEWS`、`npx jest tests/integration/db/search-functions.integration.test.ts`（DB なしの形だけ）。
- [ ] **Step 8: 報告。** 共有文書の変更案（`db-migrations.md`、`er.md`）。本番の事前の確認: `has_function_privilege('anon', 'public.search_public_items(text,integer)', 'execute')` ほか 6 本、PostgREST の `max_rows`（運用）。

**検証コマンド:** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- SEARCH`・`-- LOOK`・`-- NEWS`。

---

## Task 7: `look_items` の方針・CHECK・`admin_update_look`（R5-3〜5。SEC-LOOK-002・015・023、SEC-NEWS-025）

**範囲:** 移行 `sec_rls_predicates_and_constraints`。(1) `look_items` の読み方針 2 本を作り直し、「親の LOOK が公開」かつ「紐づく商品が公開」を明示（管理の枝は今の `has_permission('admin.looks.read')` のまま。波 5 が aal2 を AND する）。(2) `looks`・`news_articles` の CHECK（`NOT VALID`、P7・P8）。(3) `admin_update_look`（P9）と、LOOK の PUT をその rpc 1 回にする窓口の変更。**Task 1（見本）が移された後でなければ移行は通らない。**

**Files:**

- Create: `supabase/pending-wave2/<時刻>_sec_rls_predicates_and_constraints.sql`、`tests/integration/db/look_update_function.integration.test.ts`、`tests/integration/db/look_news_constraints.integration.test.ts`
- Modify: `src/app/api/admin/looks/[id]/route.ts`（PUT）
- Test（単体・結合）: `tests/unit/api/admin/looks/looks-id-put-route.test.ts`、`tests/integration/api/look-admin-item-put-api.test.ts`・`look-admin-write-path.test.ts`・`look-image-signing.test.ts`、`tests/integration/db/look_rls.integration.test.ts`（`look_items` の読みと方針名の固定）、`look_items_table`・`look_table`・`news_articles_table`（長さ・道筋の制約の固定）
- Modify（E2E）: `e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts`、`e2e/FR-LOOK-SEC-004-admin-write-integrity.spec.ts`、`e2e/FR-NEWS-SEC-002-direct-db-access.spec.ts`
- Docs: `docs/02_Requirements/areas/{look,news}.md`、`docs/05_Quality/security/threats/{look,news}.md`、`docs/03_BasicDesign/areas/{look,news}.md`（`DATA-LOOK-001`〜`003`・`DATA-NEWS-001`、`API-LOOK-` の PUT）、`docs/04_DetailDesign/pages/16-3_admin_look.md`（PUT の `DD-`）、`ADR-0466`・`ADR-0467`（新規）、`ADR-0160`（「同時の PUT の弱さ」の記述を「`admin_update_look` が閉じた」に）

**Interfaces:**

```sql
-- look_items の読み（作り直す 2 本。既存の名前は DROP POLICY IF EXISTS してから）
CREATE POLICY "anon reads links of published looks to published items" ON public.look_items
  FOR SELECT TO anon USING (
    EXISTS (SELECT 1 FROM public.looks AS l WHERE l.id = look_items.look_id AND l.status = 'published')
    AND EXISTS (SELECT 1 FROM public.items AS i WHERE i.id = look_items.item_id AND i.status = 'published'));
CREATE POLICY "authenticated reads published links, admins read all" ON public.look_items
  FOR SELECT TO authenticated USING (
    (EXISTS (SELECT 1 FROM public.looks AS l WHERE l.id = look_items.look_id AND l.status = 'published')
      AND EXISTS (SELECT 1 FROM public.items AS i WHERE i.id = look_items.item_id AND i.status = 'published'))
    OR (SELECT public.has_permission('admin.looks.read'::text)));

-- CHECK（NOT VALID）。P = looks/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*
ALTER TABLE public.looks
  ADD CONSTRAINT looks_theme_length_check CHECK (char_length(theme) BETWEEN 1 AND 200) NOT VALID,
  ADD CONSTRAINT looks_theme_description_length_check CHECK (char_length(theme_description) <= 4000) NOT VALID,
  ADD CONSTRAINT looks_image_urls_path_check CHECK (
    array_position(image_urls, NULL) IS NULL
    AND array_to_string(image_urls, E'\n') ~ '^(P(\nP)*)?$') NOT VALID;      -- P は実際の正規表現に展開して書く
ALTER TABLE public.news_articles
  ADD CONSTRAINT news_articles_title_length_check CHECK (char_length(title) <= 200) NOT VALID,
  ADD CONSTRAINT news_articles_content_length_check CHECK (char_length(content) <= 2000) NOT VALID,
  ADD CONSTRAINT news_articles_detailed_content_length_check CHECK (char_length(detailed_content) <= 10000) NOT VALID,
  ADD CONSTRAINT news_articles_image_url_path_check CHECK (
    image_url ~ '^news/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$') NOT VALID;
-- 冪等にするため、各制約は IF NOT EXISTS 相当（pg_constraint を見る DO 文）で足す

-- admin_update_look（P9）
CREATE OR REPLACE FUNCTION public.admin_update_look(
  _look_id bigint, _season_year integer, _season_type text, _theme text, _theme_description text,
  _image_urls text[], _status text, _item_ids bigint[])
RETURNS text[]
LANGUAGE plpgsql
SET search_path = ''
AS $admin_update_look$
DECLARE v_previous text[];
BEGIN
  SELECT l.image_urls INTO v_previous FROM public.looks AS l WHERE l.id = _look_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LOOK_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.looks SET season_year = _season_year, season_type = _season_type, theme = _theme,
    theme_description = _theme_description, image_urls = _image_urls, status = _status WHERE id = _look_id;
  DELETE FROM public.look_items WHERE look_id = _look_id;
  INSERT INTO public.look_items (look_id, item_id)
    SELECT _look_id, x FROM (SELECT DISTINCT unnest(COALESCE(_item_ids, ARRAY[]::bigint[])) AS x) AS d;
  RETURN v_previous;
END
$admin_update_look$;
REVOKE ALL ON FUNCTION public.admin_update_look(bigint, integer, text, text, text, text[], text, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_look(bigint, integer, text, text, text, text[], text, bigint[]) TO service_role;
```

```ts
// src/app/api/admin/looks/[id]/route.ts PUT の更新の部分（置き場への上げ・古い画像の削除の順は波 1-C のまま）
//   const { data: previousImageUrls, error } = await supabase.rpc('admin_update_look', {
//     _look_id: Number(id), _season_year, _season_type, _theme, _theme_description, _image_urls: imageUrls,
//     _status, _item_ids: parsedPayload.data.linkedItemIds });
//   error.code === 'P0002' → 404 'Look not found'（監査 failure 'Look not found'。新しく上げた画像は消す）
//   error.code === '23503' → 400 'Some linked items do not exist'（同上）
//   その他の error → 500 'Failed to update look'（新しく上げた画像は消す。行は 1 取引なので変わっていない）
//   成功 → 差し替えた古い画像 = listRemovableLookImagePaths(previousImageUrls（rpc の戻り）, newImagePaths) を消す
//   look_items の delete・insert の 2 つの呼び出し（deleteLookItemsError・insertLookItemsError の枝）は消える
```

- [ ] **Step 1: 現状の確認（読むだけ）。** `remote_schema.sql:3499-3533` の `look_items` の方針名と式、`looks`・`news_articles` の CHECK の現状（`:639-680`）、`src/app/api/admin/looks/[id]/route.ts` の PUT（`:280-560`）の枝を表にする。E2E・結合試験・補助が DB に直に入れる `looks`・`news_articles` の値が新しい CHECK に当たらないか: `grep -rnE "insert into public\.(looks|news_articles)|insert into (looks|news_articles)" e2e tests` の各行の `image_urls`・`image_url`（Task 1 で直した見本か `looks/…`・`news/…` の形）、`theme`（201 字以上）、`content`（2001 字以上）を確かめる。長い値を入れる試験（`FR-LOOK-SEC-002:460` の 201 字は CHECK の違反を期待する側）以外は当たらないこと。
- [ ] **Step 2（RED）: DB 結合試験を書く（流さない）。**
  - `look_news_constraints.integration.test.ts`（先頭 `DATA-LOOK-001`・`DATA-NEWS-001`）: 受理 — `looks/2026-10-24/00000000-0000-4000-8000-000000000000.png`、`looks/e2e/look-1-1.png`、`looks/a.png`、空配列。拒否（SQLSTATE `23514`）— `other/x.png`、`looks/../y.png`、`looks//y.png`、`/looks/y.png`、`looks/.hidden/y.png`、`https://evil.example/looks/x.png`、`looks/a.png\nother/b.png`（改行で 2 つ目が外）、配列に NULL を含む、201 字のテーマ、空のテーマ、4001 字の説明。`news_articles` も同じ形（`news/e2e/news-1.png` 受理、`e2e/news-1.png`・`news/../x.png` 拒否、201 字の題、2001 字の `content`、10001 字の `detailed_content`）。`NOT VALID` の確かめは `pg_constraint.convalidated` が 7 本とも偽であることだけにする（旧い形の行を CHECK を外さずに作る手段が無いため、「旧い行の UPDATE が 23514 で落ちる」は試験にせず ADR-0466 と Task 10 の本番の事前の確認で扱う）。
  - `look_update_function.integration.test.ts`（先頭 `DATA-LOOK-001`・`API-LOOK-`）: (a) service_role で呼ぶと行・関連が更新され、戻り値が更新前の `image_urls`。(b) 存在しない `_look_id` は SQLSTATE `P0002`・メッセージ `LOOK_NOT_FOUND`。(c) 存在しない商品の id を含めると SQLSTATE `23503` で、**行・`look_items` が呼ぶ前のまま**（1 取引で戻る）。(d) 重なった `_item_ids` は 1 行ずつ。(e) 空配列で関連が 0 件になる。(f) ACL: anon・authenticated は `42501`（`set local role`）、service_role は通る、PUBLIC が無い（`aclexplode`）、`prosecdef` が偽、`proconfig` が `search_path=""`。(g) 同時: 別の接続（`connectLocalDb()`）で同じ LOOK を呼ぶと、先の取引が終わるまで待つ（`set lock_timeout = '300ms'` で `55P03`）。用意した行は commit して `finally` で消す。
  - `look_rls.integration.test.ts` に: anon・一般会員は「公開の LOOK につながる**非公開の商品**の関連」を読めない、公開の商品の関連は読める、`admin.looks.read` を持つ会員は非公開の関連も読める（今の穴の固定が 1 つ減る）、方針名が上の 2 本になっている（`DATA-LOOK-003 look_items の方針は設計の6つ…` の名前の一覧を新しい名前に）。
  - 単体: `looks-id-put-route.test.ts`（先頭 `DD-LOOK-` の PUT の ID）— (a) 更新は `supabase.rpc('admin_update_look', {…})` 1 回で、`from('looks').update`・`from('look_items').delete/insert` を呼ばない。(b) rpc の引数の名前と値（`_look_id` が数値、`_item_ids` が `linkedItemIds`）。(c) `P0002` → 404・`23503` → 400・他 → 500。いずれも新しく上げた画像を消し、古い画像は消さない。(d) 成功では rpc の戻りと新しい画像から決めた古い画像だけを消す。(e) 戻りが `null`・非配列でも落ちない（消さない側に倒れる）。
- [ ] **Step 3（GREEN）: 移行を書く。** 順番: 方針 → 関数 → CHECK（`NOT VALID`）→ 自己検査（`look_items` の方針名と式に `items` の `status` を含む、CHECK 7 本が `convalidated = false`、関数の ACL、`proconfig`）。ヘッダーのロールバック: 方針を旧い 2 本（`remote_schema.sql:3499-3504`・`:3528-3533`）に戻す、`ALTER TABLE … DROP CONSTRAINT` を 7 本、`DROP FUNCTION public.admin_update_look(...)`。
- [ ] **Step 4（GREEN）: 窓口を直す。** `[id]/route.ts` の PUT の `update`・`delete`・`insert` を上の rpc に。`tsc` を流す。`@remarks` に ADR-0467。
- [ ] **Step 5: 既存の試験を直す。** `look-admin-item-put-api.test.ts`・`look-admin-write-path.test.ts`・`look-image-signing.test.ts` の supabase の連鎖のモックを `rpc` に。`look_table`・`look_items_table`・`news_articles_table` の長さ・道筋を通していた行を新しい期待に。
- [ ] **Step 6: E2E の印と期待（書くだけ）。** 外す: `FR-LOOK-SEC-002:224`（`SEC-LOOK-002-AC-01`）・`:246`（`SEC-LOOK-002-AC-02`）・`:460`（`SEC-LOOK-023-AC-01`）、`FR-LOOK-SEC-004:450`（`SEC-LOOK-015-AC-01`。幅ごとの繰り返しの 1 本。rpc が 1 取引なので、関連の追加を失敗させても行が元のまま）、`FR-NEWS-SEC-002:449`（`SEC-NEWS-025-AC-01`）。外さない: `FR-LOOK-SEC-004:299`（`SEC-LOOK-012-AC-03`）・`:429`（`SEC-LOOK-020-AC-02` は IP。波 4）。
- [ ] **Step 7: 文書。** `areas/look.md`: `SEC-LOOK-002`・`015`・`023` の「今のコードは満たさない」を外し、`SEC-LOOK-023` の画像の道筋の式を「`looks/` の下の安全な文字」（LOOK-007 の判断）に。`areas/news.md`: `SEC-NEWS-025`。`ADR-0160` の「結果」を更新。`threats/look.md`・`news.md`。
- [ ] **Step 8: 対象の `jest` と確かめ。** `npx jest tests/unit/api/admin/looks tests/integration/api/look-admin-item-put-api.test.ts tests/integration/api/look-admin-write-path.test.ts tests/integration/api/look-image-signing.test.ts tests/integration/db/look_update_function.integration.test.ts tests/integration/db/look_news_constraints.integration.test.ts`（DB の試験は skip）、`npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- LOOK`・`-- NEWS`。
- [ ] **Step 9: 報告。** 共有文書の変更案（`db-migrations.md`、`er.md` の CHECK と関数、`api-spec.md` は PUT の応答が変わらないので無し）。**本番の事前の確認（読むだけ）**: `select distinct split_part(image_urls[1], '/', 1) from looks`、`select distinct split_part(image_url, '/', 1) from news_articles`、`select id from looks where char_length(theme) > 200 or char_length(theme_description) > 4000`、`select id from news_articles where char_length(title) > 200 or char_length(content) > 2000 or char_length(detailed_content) > 10000`、旧い公開 URL（`…/object/public/…`）の行の数。ある行は VALIDATE の前に正規化する（この波では書かない）。**窓口の変更と移行は同じ日に移す**（Review Focus 3）。

**検証コマンド:** `npx tsc --noEmit`、上の `jest`、`npm run validate-docs`、`npm run validate-trace -- LOOK`・`-- NEWS`。

---

## Task 8: 置き場 `look-images`・`news-images` の設定を移行に入れる（R17。SEC-LOOK-005、SEC-NEWS-003）

**範囲:** 移行 `sec_storage_buckets`。`ON CONFLICT (id) DO UPDATE` で `public = false`・5 MB・4 種類に合わせる（P10）。`storage.objects` に置き場を名指しする方針は作らない。

**Files:**

- Create: `supabase/pending-wave2/<時刻>_sec_storage_buckets.sql`
- Modify: `tests/integration/db/look_images_bucket.integration.test.ts`（`:62` 付近の「上限を付けない」を新しい設定に）、`tests/integration/db/news_images_bucket.integration.test.ts`（同種）
- Modify（E2E）: `e2e/FR-LOOK-SEC-002-postgrest-policies.spec.ts`（`:408`）。`FR-NEWS-SEC-001`・`FR-NEWS-SEC-003` の置き場の設定を見る試験があれば期待を合わせる
- Docs: `docs/02_Requirements/areas/{look,news}.md`、`docs/05_Quality/security/threats/{look,news}.md`、`docs/03_BasicDesign/areas/{look,news}.md`（`DATA-LOOK-005`・`DATA-NEWS-004`）、`ADR-0468`（新規）

**移行（骨格）:**

```sql
-- ROLLBACK（Task 8）: 適用前に本番の storage.buckets の 2 行を読んで記録し、その値に戻す。手元の見本と同じ状態へ戻すなら:
--   UPDATE storage.buckets SET file_size_limit = NULL, allowed_mime_types = NULL WHERE id IN ('look-images', 'news-images');
BEGIN;
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('look-images', 'look-images', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('news-images', 'news-images', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
-- 自己検査: 2 行とも public が偽・上限 5242880・種類の集合が 4 つ、storage.objects の方針で
--           qual / with_check に 'look-images'・'news-images' を含むものが 0 件
NOTIFY pgrst, 'reload schema';
COMMIT;
```

- [ ] **Step 1: 現状の確認（読むだけ）。** 窓口の許す種類と大きさ（`allowedImageTypes`・`maxImageBytes`）が 4 種類・5 MB であること（`src/app/api/admin/{looks,news}/route.ts`）、`supabase/seed.sql` の置き場の行（`ON CONFLICT (id) DO NOTHING`）が移行の後に入っても設定を壊さないこと、G-2 の前例（`20261024153505_group_g2_purchasing_foundation.sql` の「13. Storage bucket」と末尾の自己検査）を読む。
- [ ] **Step 2（RED）: DB 結合試験を直す・足す（流さない）。** 先頭 `DATA-LOOK-005`・`DATA-NEWS-004`。(a) `look-images`・`news-images` が `public = false`・`file_size_limit = 5242880`・`allowed_mime_types` の集合が 4 つ。(b) `storage.objects` の方針に置き場を名指しする物が 0 件（既存の試験を残す）。(c) 既存の「anon・authenticated は置き場の物を読めず・足せない」の試験はそのまま通る。(d) 移行の形（DB なし）: `readMigration('sec_storage_buckets')` が `DO UPDATE` を含み、`CREATE POLICY` を含まず、`ROLLBACK` の節がある。
- [ ] **Step 3（GREEN）: 移行を書く。**
- [ ] **Step 4: 既存の DB 試験を直す。** 「上限を付けない」を新しい設定に。
- [ ] **Step 5: E2E の印（書くだけ）。** 外す: `FR-LOOK-SEC-002:408`（`SEC-LOOK-005-AC-01`）。`SEC-LOOK-005-AC-02`（公開の URL は 4xx）は印が無く、今も緑のまま。
- [ ] **Step 6: 文書。** `areas/look.md`: `SEC-LOOK-005` の「今のコードは満たさない」を外す。`areas/news.md`: `SEC-NEWS-003` の置き場が移行に無い旨を外す。`threats/*`、`DATA-LOOK-005`・`DATA-NEWS-004`、`ADR-0468`（本番の置き場が既にあるので `DO UPDATE`、既存の 5 MB 超のファイルは残り新規だけ断られる）。
- [ ] **Step 7: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- LOOK`・`-- NEWS`。
- [ ] **Step 8: 報告。** 共有文書の変更案（`db-migrations.md`、`er.md`）。**本番の事前の確認（読むだけ。移行を当てる前に必須）**: `select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('look-images','news-images')`、`select policyname, qual, with_check from pg_policies where schemaname='storage' and tablename='objects'`（名指しの方針があれば移行の自己検査で止まる）、`select bucket_id, count(*), max(metadata->>'size') from storage.objects ... group by bucket_id`（5 MB 超の既存ファイルの数）。結果をロールバックの値として保存する。

**検証コマンド:** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- LOOK`・`-- NEWS`。

---

## Task 9: 権限の一覧を確かめる DB 結合試験と、GRANT を明示する決まり（I8。SEC-AUTH-033）

**範囲:** 波 2 が決めた権限を 1 本の試験で守る。(1) 一覧の表・列・関数・連番・置き場の権限を `has_*_privilege` で確かめる。(2) 「一覧にも既知の例外にも無い表」の anon・authenticated に書き込み・TRUNCATE が付いたら落ちる（新しい表に自動で付く権限への歯止め）。(3) 決まり「以後の移行は要る GRANT（service_role を含む）を明示する」を ADR と報告に書く。**他領域の表の広い権限（注文・会計・問い合わせ・権限の表など）は直さず、既知の例外の一覧に載せる。**

**Files:**

- Create: `tests/integration/db/auth_grants_inventory.integration.test.ts`（名前は AUTH の glob `tests/integration/db/auth_*.integration.test.ts` に当たる）
- Modify: `docs/02_Requirements/areas/auth.md`（`SEC-AUTH-033` と `AC-01`・`AC-02` を新設。`SEC-AUTH-011` の上位に並べる）、`docs/05_Quality/security/threats/auth.md`（`THR-AUTH-033`）、`docs/03_BasicDesign/areas/auth.md`、`ADR-0462`（Task 4 が作った物に「決まり」の節）
- Docs（新規の運用の決まりは共有の `db-migrations.md` に書くので、本文は報告に）

**一覧（試験の定数）:**

| 区分 | 表・対象 | anon | authenticated | service_role |
| --- | --- | --- | --- | --- |
| 公開の読み | `looks`・`look_items`・`news_articles`・`stockists` | SELECT のみ | SELECT のみ | SELECT・INSERT・UPDATE・DELETE |
| 管理の読み | `item_color_presets`・`item_cost_history` | なし | SELECT のみ | 同上 |
| 閉じた表 | `sessions`・`password_reset_tokens`・`rate_limit_counters`・`audit_logs`・`audit_logs_backups` | なし | なし | 同上 |
| 自分の行 | `profiles` | なし | SELECT・INSERT・UPDATE・DELETE（TRUNCATE・REFERENCES・TRIGGER・MAINTAIN は無し） | 同上 |
| 列単位 | `items` | 21 列の SELECT のみ。表単位は無し。原価 2 列は無し | 同左 | 同上 |
| 関数 | `search_items/looks/news` | EXECUTE 可 | EXECUTE 可 | 可 |
| 関数 | `search_public_items/looks/news`・`admin_update_look` | 不可 | 不可 | 可（`search_public_*` は postgres も） |
| 連番 | `stockists_id_seq`・`rate_limit_counters_id_seq` | 不可 | 不可 | USAGE・SELECT |
| 置き場 | `look-images`・`news-images` | `public = false` | - | - |

**既知の例外（直さず一覧に載せる。他の領域・波の持ち物）:** `admin_finance_*`・`admin_kpi_*`・`admin_costing_items`・`admin_expense_cost_allocations`（会計）、`contact_inquiries`・`contact_messages`・`contact_reply_templates`（問い合わせ）、`carts`・`checkout_drafts`・`orders`・`order_items`・`wishlist`（注文・カート）、`permissions`・`roles`・`role_permissions`・`user_roles`（権限）、`postal_code_cache`・`refresh_token_history`・`stripe_webhook_events`。G の表（注文・発送・在庫・発注）は各移行が明示の GRANT を持つ前提で、歯止めの対象に含める（**例外に載せない**）。

- [ ] **Step 1: 現状の確認（読むだけ）。** `remote_schema.sql:4100-4260` の「`TO "anon", "authenticated"` の全権限」の表を出し、上の既知の例外と一致することを確かめる。後の移行（`20261008220825_cart_wishlist_ownership.sql`・`20260927100000〜` の注文系・G の移行）が一部を締めている可能性があるので、**例外の一覧は「持っているかもしれない」上限**として扱う（締まっていても落ちない）。`tests/integration/db/helpers/local-db.ts` の `describeLocalDb` と、`group_g2_public_function_acl.integration.test.ts` の `failureAs`（役を替えて SQLSTATE を取る補助）を読む。
- [ ] **Step 2（RED）: 試験を書く（流さない）。** 先頭は `SEC-AUTH-033-AC-01`・`SEC-AUTH-033-AC-02`。
  - **AC-01**（一覧どおり）: 上の表の各行を `test.each` で確かめる。表: `has_table_privilege(role, table, 'SELECT'|'INSERT'|'UPDATE'|'DELETE'|'TRUNCATE'|'REFERENCES'|'TRIGGER'|'MAINTAIN')`。`items`: `has_table_privilege(…, 'SELECT')` が偽・`has_column_privilege` が 21 列で真・`pattern_cost`・`mass_production_cost` で偽。さらに「`items` の全列 − 原価 2 列 = anon が `SELECT` できる列」（`information_schema.columns` と突き合わせ。新しい列が足されたらこの試験が落ち、足した人に権限の判断を迫る）。関数: `has_function_privilege` と `aclexplode` の grantee 0（PUBLIC）。連番: `has_sequence_privilege`。置き場: `storage.buckets.public`。
  - **AC-02**（歯止め）: `pg_class` の `public` の通常の表（`relkind in ('r','p')`）のうち、anon または authenticated が `INSERT`・`UPDATE`・`DELETE`・`TRUNCATE` のどれかを持つ表の集合から、**既知の例外**を引いた残りが空であること。残りがあれば表の名前を出して落ちる。あわせて「既知の例外のうち、今は広い権限を持たない表」を `console.info` に一覧で出す（締まった表を例外から外す目安。落ちない）。「既知の例外の表でも anon に `TRUNCATE` は付けない」という強い断言は、例外の実態が不明なので `test.todo('anon の TRUNCATE を既知の例外の表からも外す')` として残す（直すのは他領域の波）。
  - 移行の形（DB なし）: 波 2 の 6 本のいずれにも `ALTER DEFAULT PRIVILEGES` が無い（Q9 は今回やらない）、各移行のヘッダーに `ROLLBACK` の節がある、各移行に service_role の GRANT が明示されている（`sec_grants_*` の 2 本）。
- [ ] **Step 3: 要件・脅威・設計。** `areas/auth.md` に `SEC-AUTH-033`（上位 `THR-AUTH-033`、確かめ方「結合テスト」、出どころ「設計書 I8」）と `AC-01`・`AC-02` を 7 の形で書く。`SEC-AUTH-033` の本文に「Supabase 公式は既定の権限が project ごとに違い、自動で付く権限は外される方向（`hardening-data-api`）。だから移行が要る GRANT を明示し、広い権限を新しい表に残さない」。`threats/auth.md` に `THR-AUTH-033`。`ADR-0462` に「決まり」の節（以後の移行は、新しい表・関数ごとに anon・authenticated・service_role の GRANT/REVOKE を明示する。`ALTER DEFAULT PRIVILEGES` は project 全体に効くので別の判断（Q9））。
- [ ] **Step 4: 確かめ。** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`、`npx jest tests/integration/db/auth_grants_inventory.integration.test.ts`（DB なしの形の試験だけが走る）。
- [ ] **Step 5: 報告。** 共有文書の変更案: `db-migrations.md` に「以後の移行は GRANT を明示する」の決まりの本文（上の SEC-AUTH-033 の文と、新しい表の雛形 `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT … TO …; GRANT ALL … TO service_role;`）。既知の例外の一覧が実態と合うかは、controller が DB で流した最初の結果で直す（落ちた表の名前を見て、本当に例外か・今回直すかを判断する）。

**検証コマンド:** `npx tsc --noEmit`、`npm run validate-docs`、`npm run validate-trace -- AUTH`。

---

## Task 10: 最終確認と controller への報告

**Files:** 変更なし（読むだけ）。報告だけを返す。

- [ ] **Step 1: 全体の型と文書。** `npx tsc --noEmit`（他者の誤りは分けて書く）、`npm run validate-docs`、`npm run validate-trace`（全領域。`--update-baseline` はしない。基準より増えた違反が 0 件）。
- [ ] **Step 2: 触らない約束の確認。** `git status --short` と `git diff --stat` で、次が**変わっていない**ことを確かめる: `supabase/migrations/**`、`supabase/seed.sql`、`scripts/e2e/seed-storage.ts`、共有文書、`tests/unit/docs/*-traceability.test.ts`、`src/proxy.ts`、`next.config.ts`、`src/lib/orders/**`、`src/app/admin/page.tsx`。`supabase/pending-wave2/` の中身が計画どおり（移行 6 本、`seed/` の写し 3 本）であること。`grep -rn "ALTER DEFAULT PRIVILEGES" supabase/pending-wave2` が 0 件。
- [ ] **Step 3: `test.fail` の突き合わせ。** `grep -rn "test.fail" e2e/FR-HOME-024* e2e/FR-LOGIN-031* e2e/FR-LOOK-SEC-00[24]* e2e/FR-NEWS-SEC-002* e2e/FR-SEARCH-02[01]* e2e/FR-STOCKIST-01[36]* e2e/FR-ADMIN-MISC-005*` の結果が、各タスクの「外さない」と一致する。外した行の一覧（ファイル:元の行:要件 ID）を報告に載せる。
- [ ] **Step 4: 移行の対の確認。** 6 本それぞれに (a) ヘッダーの `ROLLBACK`、(b) 末尾の自己検査、(c) 冪等、(d) service_role の GRANT の明示、(e) 時刻が `ls supabase/migrations supabase/pending-wave2` の最新より後、(f) `findMigration` で読む DB なしの形の試験、(g) 権限を確かめる DB 結合試験、があることを表にする。
- [ ] **Step 5: controller への報告を返す。** 次を含める。
  1. **controller が移す物と順序**: (i) Task 1 の見本の写し 2 本を本物の場所へ（`environment.ts` は移さない）、`supabase/pending-wave2/seed/` を消す。(ii) Task 3 と Task 7 の窓口の変更が作業ツリーにある状態で、(iii) 移行 6 本を `supabase/migrations/` へ時刻の順に移す（時刻は最新より後に付け替えてよい）、(iv) `db reset`、(v) DB 結合試験（Task 2・4・5・6・7・8・9 と書き換えた既存）、(vi) E2E（本番ビルド・手元の Supabase・3000 番を空けてから）で外した印の行と画像の表示、(vii) `npm run trace:report`・`test:trace-coverage`。移す前に他セッションが E2E を流すと LOOK の更新（rpc 無し）と画像（見本の道筋）が落ちる。
  2. **共有文書の変更案**: `db-migrations.md`（6 本の行と、本番適用前の確認、GRANT 明示の決まり）、`er.md`（`items` の列権限・`item_cost_history`・`stockists.type`・CHECK 7 本・`admin_update_look`・置き場の設定）、`test-spec.md`（新しい試験と書き換えた試験）、作業と指摘の台帳（W-08 の状態欄: HOME-004・005・020、AUTH-011、LOOK-002・004・005・010・015・023、NEWS-010・022・025、SEARCH-003・007・008、STOCKIST の列、書き込みの穴の部分）、`requirements.md`（波 2 の要件は `areas/` に書いたので無し）、`api-spec.md`・`route-inventory.md`（窓口の増減・応答の変更は無し）、`tests/unit/docs/*-traceability.test.ts`（窓口の数は変わらない）。
  3. **設計書の訂正**: P2（取扱店・ニュースの管理の書き込みは利用者の JWT だった）、`product_note` は公開（Q7）、R4-4 の「anon にも SELECT」を `item_color_presets` では外した（P5）、CHECK の補助関数を作らない（P7）。
  4. **本番の事前の確認（読むだけの SQL。Q27 のとおり G-1 が G-4 を当てる前後に、controller かユーザーが Supabase MCP で）**: Task 2・4・5・6・7・8 の各報告の SQL をまとめて表にする。適用の前に `get_advisors`（security）を保存し、適用の後に比べる（`has_permission` の WARN が増えていないこと、`rls_enabled_no_policy`・`security_definer_view` などが増えていないこと。`item_cost_history` は方針が 1 件になるので INFO が 1 つ減る）。ロールバックの値（`storage.buckets` の 2 行・各表の旧い ACL）をその結果から確定する。
  5. **ユーザーに確認を求める点**: P9（`admin_update_look` が更新前の画像を返す）、P5（`item_color_presets` の anon の SELECT を付けない）、Task 3（書き込みの client を service role に移すこと）。
  6. **回す物**（下の表）。

---

## 回す物（この波で直さない。理由つき）

### 1-B の行の割り当て

`design-final.md` §3-2 の波 1-B の行の全項目を 1 つずつ見た。1-B の行は波 1-B（`a824932e`）で直し終えており、波 2 の作業に入るのは DB の変更が絡む残りだけ。

| 1-B の行の項目 | 状態・行き先 |
| --- | --- |
| R15: SEC-ADMIN-014・015、SEC-AUTH-017・006 | 波 1-B で済み。波 2 の作業なし |
| R2: SEC-AUTH-031 の局所版（`enroll-totp`） | 波 1-B で済み。共有版・DB 版は **回す: 波 5**（`authenticate.ts`・DB の共有部品） |
| R13: SEC-AUTH-022 本文 | 波 1-B で済み。no-store（AC-02）は **回す: 波 3**（`proxy.ts`） |
| R7: SEC-AUTH-009・016-AC-03、SEC-ADMIN-006 | 波 1-B で済み。波 2 の作業なし |
| R11: SEC-ADMIN-007・008・021、SEC-STOCKIST-013、SEC-NEWS-016 | 波 1-B で済み。波 2 の作業なし |
| R12: SEC-ADMIN-012・013・018、SEC-STOCKIST-011・014 | 波 1-B で済み。波 2 の作業なし |
| R14・R13 の局所分: SEC-NEWS-005、SEC-STOCKIST-009・018、SEC-HOME-013、SEC-ADMIN-020 | 波 1-B で済み。波 2 の作業なし |
| 1-B が「DB の変更が要る → 波 2」とした物: `stockists.type` の NOT NULL | **Task 2** |
| 同: SEC-AUTH-011（認証の表の権限） | **Task 4** |
| 同: SEC-STOCKIST-003 のうち書き込み（AC-02・AC-03）と表の余分な権限（SEC-STOCKIST-008） | **Task 5**。読み取り（AC-01）は **回す: 波 5**（`has_permission` の aal2。R3） |
| 同: SEC-ADMIN-002 のうち書き込み（AC-01） | **Task 5**。選択後の失効（AC-02）は **回す: 波 5** |
| 同: SEC-AUTH-010（`orders` の aal1 の読み） | **回す: 波 5**。G の表で、`has_permission` の共有部品 |

### 波 2 の決定の範囲で、タスクに入れない物

| 項目 | 理由・行き先 |
| --- | --- |
| R3（`has_permission` の aal2 と session の生存）: SEC-HOME-003-AC-01、SEC-LOOK-003-AC-01、SEC-NEWS-002-AC-01・AC-03、SEC-STOCKIST-003-AC-01、SEC-ADMIN-002-AC-02、SEC-AUTH-010 | 共有部品（`has_permission` 本体）で、G の DB 試験の claims を直す必要がある → **波 5**。書き込みは Task 5 が閉じるので、波 5 を待つのは「非公開の行が読める」だけ |
| `look_items` の管理の枝に aal2 を AND する（`private.is_live_aal2_session()`） | R3 と同じ → 波 5。Task 7 は管理の枝を今の `has_permission` のまま残す |
| `ALTER DEFAULT PRIVILEGES`（プロジェクト全体の既定の権限。Q9） | 決定: 今回やらない。表ごとに明示の REVOKE/GRANT（Task 4・5）と、歯止めの DB 試験（Task 9）で代える |
| CHECK の `VALIDATE CONSTRAINT` と、本番の既存行の点検・正規化 | 本番の行を読んでから → 点検の後の別の移行。この波では `NOT VALID` まで（P8） |
| `item-images` の置き場の設定（移行にも無い。`seed.sql` だけ） | 設計書 R17 は `look-images`・`news-images` だけを対象にしている。ITEM は範囲外で、本番の値が未読 → **ユーザー判断**（同じ形の移行を足すか）。`finance-receipts`・`return-photos` などは既に移行にある |
| 他領域の表の広い権限（会計・問い合わせ・注文・カート・権限の表など。Task 9 の既知の例外） | 9 領域の外、または G・注文の表。各領域の波・G の作業で `REVOKE`/`GRANT` を明示する。Task 9 の歯止めが「新しい表」を止める |
| `search_public_items/looks/news` の DROP | REVOKE で権限は閉じる。DROP は NEWS の試験（42501 だけを許す）を直した後の別の掃除 |
| 画像の署名の許可範囲・期限（SEC-SEARCH-014〜016、SEC-LOOK-007・008、SEC-NEWS-007・008、SEC-HOME-006・007） | 共有ライブラリ（`item/look/news-images.ts`）→ **波 3**。見本の道筋（Task 1）はその前提 |
| `og:image`・CSP・`next/image` の `remotePatterns`（R9） | `proxy.ts`・`next.config.ts` → **波 3** |
| IP の信頼（R6）、`rateLimit.ts` の順序、SEC-LOOK-020、SEC-STOCKIST-012・019・020・021、SEC-ADMIN-009・022 | 共有部品 → **波 4** |
| PostgREST の `max_rows`、本番ダッシュボードの設定（漏洩パスワード・`otp_expiry`・TOTP・IP の枠）、`supabase/config.toml` | 運用・設定 → **波 6** |
| `has_permission` を authenticated が RPC で直接呼べる WARN（`get_advisors`） | `has_permission` 本体の波 → 波 5 |
| Q8 の将来: `item_cost_history` を読む画面 | 今は無い（P4）。作る時は `admin.finance.read` の窓口（service role）か Task 4 の方針を使う |

---

## 自己点検（計画の作成者が行った確認）

- **範囲の網羅。** `wave2-decisions.md` の範囲（R4・R5・R17・R8-5）と、Q5・Q7・Q8・Q9・Q21・Q27 の答えを 1 つずつ見て、R4 の項目（HOME-004・005・020、AUTH-011、LOOK-004、NEWS-022、STOCKIST-008）は Task 4・5、R5 の項目（検索の関数 3 本、`search_public_*`、`look_items`、`stockists.type`、CHECK、`admin_update_look`）は Task 2・6・7、R17 の置き場は Task 8、R8-5 は Task 1、I8（権限の一覧の試験と決まり）は Task 9 に載せた。波 1-B の行は上の表で全部を割り当てるか回した。
- **ファイルの重なり。** 重なりは「進める順」の表に書いた。`FR-LOOK-SEC-002` の E2E は Task 1・5・6・7・8 の全部が触るので、直列。並行にしてよいのは (Task 2 → 3) と Task 4 だけ。
- **共有部品・共有文書。** 触るのは窓口の書き手（取扱店・ニュース・LOOK の PUT）と、新しい小さなファイル（`staged-supabase.ts`）の追加だけ。`has_permission` 本体・G の表・`proxy.ts`・`next.config.ts`・`rateLimit.ts` の変更は無い。共有文書は 1 つも編集せず、変更案を Task 10 の報告に集める。
- **ステージング。** `supabase/migrations/`・`seed.sql`・`seed-storage.ts` を作らない・編集しない。移行は pending、見本は `pending-wave2/seed/` の全文の写し。試験は名前の末尾（`findMigration`）で読む。写しの `.ts` が全体の `tsc` に入る問題は、隣の `environment.ts`（再公開）で解いた。
- **危ない読みを `前提の読み` に出した。** P2（設計書の前提の誤り。取扱店・ニュースの書き手）、P5（`item_color_presets` の anon）、P7（CHECK の補助関数を作らない）、P9（`admin_update_look` の戻り値）は設計書から外れるので、controller の確認を求める。
- **確かめていないこと。** 本番の権限・置き場・行・`item_cost_history` の行数は読んでいない（Task 10 の報告に読むだけの SQL を集めた）。`test.fail` の反転の予想（特に `SEC-ADMIN-002-AC-01`・`SEC-STOCKIST-003-AC-03`・`SEC-HOME-003-AC-02`）はコードとテストを読んだ予想で、流して外れたら印を戻す。`items` の `select('*')`・埋め込みの全数は Task 4 Step 1 で取り直す。既知の例外の一覧（Task 9）は `remote_schema.sql` の GRANT からの上限で、DB で流した最初の結果で直す。
- **行番号。** E2E の `test.fail` の行番号は 2026-10-26 時点の `grep` の結果。実装者は編集の前に `grep -n "test.fail"` で取り直す。
- **残るリスク。** (1) Task 3 を移す前に Task 5 の移行を本番に当てると、取扱店・ニュースの管理が止まる（順序）。(2) 移行 6 本と Task 7 の窓口は同時に移さないと LOOK の更新が落ちる。(3) `items` の列の取りこぼしは公開の画面を壊す（自己検査とレビューで止める）。(4) 本番の `look-images` に名指しの方針があると Task 8 の移行が落ちる（意図した止まり方）。(5) 本番の旧い形の `image_urls`・`image_url` は CHECK の後に UPDATE で落ちるので、VALIDATE の前に直す。

---

## 最終のタスクの一覧

| 順 | タスク | 移行 | 前に要るタスク |
| --- | --- | --- | --- |
| 1 | 見本の画像の道筋（R8-5・Q5）と写しの補助 | なし | なし |
| 2 | `stockists.type` の NOT NULL を外す | `stockists_type_optional` | 1（`findMigration`） |
| 3 | 取扱店・ニュースの管理の書き込みを service role へ | なし | なし |
| 4 | `items` の列権限・`item_cost_history`・認証の表・`profiles` | `sec_grants_hardening` | 1 |
| 5 | 管理だけが書く表から書き込みを外す | `sec_grants_admin_tables` | 1・3 |
| 6 | 検索の関数 3 本と `search_public_*` | `sec_search_functions` | 1 |
| 7 | `look_items` の方針・CHECK・`admin_update_look` | `sec_rls_predicates_and_constraints` | 1・5 |
| 8 | 置き場 `look-images`・`news-images` | `sec_storage_buckets` | 1・7 |
| 9 | 権限の一覧の DB 試験と GRANT を明示する決まり | なし | 4〜8 |
| 10 | 最終確認と controller への報告 | なし | 1〜9 |
