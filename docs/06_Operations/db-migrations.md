# DB マイグレーション運用

> 状態: 運用方針（グループ G-1 の移行の節は 2026-10-24 に、グループ G-2 の移行の節は 2026-10-25 に追記。G-2 は Task 1 の基盤と Task 2 の発注書の9表と Task 3 の在庫一覧表の読取と、Task 4 の2本目の移行〔発注の作成とロック helper〕と、Task 5 の発注一覧表・発注書の詳細の読取〔基盤の移行の節15〕と、Task 6 の数量の確定・訂正・打切り・発注先の訂正〔2本目の移行の節3〜5〕と、Task 7 の受け取りとその取消〔2本目の移行の節6・7〕と、Task 8 の取引書類の原本〔基盤の移行の節16の検索、2本目の移行の節8の予約・確定・訂正〕と、Task 9 の書き手の閉じた一覧・全入口の並行・末尾の確かめの完成〔「適用の手順と確認」〕と、Task 11 の本番適用の記録まで） | 確認日: 2026-10-25 | 本番適用状況: G-1 の移行は 2026-10-24 に、G-2 の移行2本は 2026-10-25 12:39 JST に適用済み

## 概要

本書はデータベースマイグレーションの現行手順と過去の移行記録をまとめる。実際の適用対象は `supabase/migrations/` と `.github/workflows/db-migrations.yml` で確認し、本番台帳は実行前に読み直す。グループ G-1 の移行（本番のテスト用の注文を消す清掃を含む1本）の内容・当て方・記録は「グループ G-1 在庫の割当の移行」に書く。グループ G-2 の移行（発注・受け取り・原本の添付）は末尾の「グループ G-2 発注・受け取りの移行」に書く。

本番 Supabase（`pjidrgofvaglnuuznnyj`）へのスキーマ適用手順と、
マイグレーションの書き方の規約。

## なぜ変えたか

旧 `.github/workflows/db-migrations.yml` は毎回こうしていた。

```bash
for f in migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

問題が3つある。

1. **適用済み台帳が無い。** 毎回全ファイルを頭から流すので、全 migration が冪等でないと壊れる。
2. **トランザクションで包まれない。** `psql -f` は文ごとに autocommit する。
   `CREATE OR REPLACE FUNCTION` の直後に `REVOKE` を書く形（092・093）だと、
   その間だけ PUBLIC が EXECUTE できる窓ができる。`revoke_auth_session` は
   任意の auth セッションを消せるので、この窓は塞ぐ必要がある。
3. **ファイルと本番が一致していない。** `scripts/apply-legacy-migrations.mjs` が
   `scripts/replay-missing-objects.sql`（本番にあるがマイグレーションが作っていない
   手作りオブジェクト）を必要としている時点で、`migrations/` は本番を再現できていない。

Supabase CLI の `db push` は `supabase_migrations.schema_migrations` を台帳として
適用済みをスキップするので 1 が解決する。2 は各ファイルへ明示的に `BEGIN;` / `COMMIT;`
を書いて塞ぐ（ツールの挙動に依存しない）。3 はベースライン化で解決する（下記）。

## ベースライン化（初回のみ・要 Docker と DB パスワード）

> **実施済み（2026-09-01）。** 以下は記録。再実行は不要。
>
> - `migration repair --status reverted` で旧 105 件を台帳から落とし、
>   `db pull` で `supabase/migrations/20260901102912_remote_schema.sql`（4233 行）を生成。
>   同バージョンは台帳へ `applied` として記録済み。
> - 実施後の確認: `migration list` がローカル / リモートとも `20260901102912` の 1 件のみ。
>   `db push --dry-run` は `Remote database is up to date`。
> - 本番スキーマは無変更（テーブル 51 / 関数 40 / RLS ポリシー 139 / 拡張 7 が前後で一致）。
>   `revoke_auth_session` の EXECUTE は `postgres, service_role` のまま。
> - 生成物の検査結果: トップレベルの `DROP` は無し（公式が警告する
>   `DROP EXTENSION pg_net;` も出なかった）。`http` 拡張の復活も無し。
>   092 のロックダウン（anon / authenticated へ EXECUTE を出さない）は保存されている。
>   機密値の混入も無し。

2026-09-01 時点の実測:

- 本番の台帳 `supabase_migrations.schema_migrations`: **105 行**
  （最新は `auth_user_lookup_and_token_hygiene` = 093、`092_lock_down_rpc_surface`、
  `091_auth_session_revocation`。いずれも MCP の apply_migration 経由で適用され、
  台帳にも記録されている）
- ローカルの `supabase/migrations/`: **0 件**

CLI はこの2つを突き合わせて「台帳に無いファイル」だけを適用する。
リモート 105 / ローカル 0 は完全な不整合なので、`db push` は sync エラーになり
`supabase migration repair` を促される。

本番の現状（テーブル 51 / 関数 40 / RLS ポリシー 139）をそのまま
`supabase/migrations/` の最初の 1 本に固定して、この食い違いを解消する。

```bash
npx supabase login                                  # ブラウザでアクセストークンを発行
npx supabase link --project-ref pjidrgofvaglnuuznnyj  # DB パスワードを聞かれる
npx supabase migration list                         # 適用前にローカルとリモートの差を確認
npx supabase db pull                                # supabase/migrations/<timestamp>_remote_schema.sql が出る
```

`db pull` は生成したファイルを台帳へ「適用済み」として記録するので、
後続の `db push` が再適用することはない。出力には 092・093 の内容も含まれる。

**コミット前に生成されたファイルを読むこと。** `db pull` は本番とローカルスタックの
既定構成を差分するため、意図しない文が混ざることがある（公式が挙げている例:
ローカルスタックが既定で有効化している拡張に対する `DROP EXTENSION pg_net;`）。
これらは `db reset` 時に黙って適用され、ローカルのスキーマを変えてしまう。

```bash
git add supabase/migrations && git commit -m "chore(db): baseline production schema"
```

旧 `migrations/*.sql` は履歴として残し、以後の追加はしない。

台帳と実体がずれたときは repair で台帳側だけを直す（SQL は実行されない）。

```bash
npx supabase migration repair --status applied <version>   # 実体はあるが台帳に無い
npx supabase migration repair --status reverted <version>  # 台帳にあるが実体が無い
```

## 以後の追加手順

```bash
npx supabase migration new <name>      # supabase/migrations/<timestamp>_<name>.sql
# SQL を書く（規約は下記）
git commit && git push                 # master への push で CI が db push する
```

PR を作ると CI が `supabase db push --dry-run` で「何が当たるか」だけを出す。
master への push で実際に適用される。

### 本番に当てる前の試行（取り消し前提）

データに依存するマイグレーション（既存行の後埋め、列の型変更、トリガーの一時無効化など）は、
本番のデータで通るかを先に試す。全体を1つの `DO` ブロックに入れ、各ファイルの SQL を
`EXECUTE` で流し（トップレベルの `BEGIN;` / `COMMIT;` は外す）、確かめたい値を集めてから
最後に `RAISE EXCEPTION` で全体を取り消す。例外の文言に結果を載せれば、何も残さずに結果だけを得られる。

```sql
do $dryrun$
declare r text;
begin
  execute $m0$ /* 1本目の SQL */ $m0$;
  execute $m1$ /* 2本目の SQL */ $m1$;
  select format('rows=%s', (select count(*) from public.some_table)) into r;
  raise exception 'DRYRUN (rolled back): %', r;
end
$dryrun$;
```

実行後に、作られるはずのオブジェクトが無いこと（取り消されたこと）を確かめる。
2026-09-19 のバリアント在庫6本は、この試行で結果（生成件数・検算0行・既存明細の紐付け）を確かめてから当てた。

#### RLS を変えるときは、立場ごとの件数を前後で比べる

同じ `DO` ブロックの中で「変更前に数える → `EXECUTE` で当てる → 変更後に数える」を行い、件数が一致することを確かめる。
立場は `SET LOCAL ROLE` と JWT のクレーム、セッション ID で切り替える（`auth.uid()` と `current_app_role()` はクレームから読む）。

```sql
execute 'set local role authenticated';
perform set_config('request.jwt.claims',
  json_build_object('sub', '<user_id>', 'role', 'authenticated',
                    'app_metadata', json_build_object('role', 'user'))::text, true);
perform set_config('app.session_id', '<session_id>', true);
execute 'select count(*) from public.orders' into n;
execute 'reset role';
```

- 匿名・一般会員・サポーター・管理者に加え、セッションで見える行（ゲストのカート・注文）も数える。ACL で管理者権限を持つ会員を「一般会員」に使うと、権限の経路しか試せない
- 書き込みの条件は、行を変えない `UPDATE ... SET col = col` の件数で比べる。トリガーの無い表に限る
- 流した SQL がファイルと同じであることは、本文の `md5()` をローカルで計算した値と比べて確かめる
- 索引の使用回数（`pg_stat_user_indexes`）は取り消されない。試行の検索で使われた索引は、advisor の unused_index から外れる

2026-09-19 の FREQ-382（RLS 15本の書き換えと会計3表の分割）は、9つの立場×8表で件数が前後一致することを確かめてから当てた。

### MCP の apply_migration で当てた場合

MCP の `apply_migration` は、**当てた時刻**を version として台帳に書く。ファイル名の番号とは一致しない。
当てた直後に `list_migrations` で記録された version を確かめ、ファイル名をその version に直す。

```text
supabase/migrations/<作ったときの番号>_<name>.sql  →  <台帳に記録された version>_<name>.sql
```

直さないと、次の `db push` が「台帳にある version がローカルに無い」で止まる。

### まだ本番に入れないマイグレーション

`supabase/migrations/` に置いたものは、master への push で本番に流れる。
公開時まで入れないものは `supabase/pending/` に置く（[supabase/pending/README.md](../../supabase/pending/README.md)）。
入れるときは新しい version を付けて `supabase/migrations/` へ移す。元の古い日付のまま戻さないこと。

### 新しい移行を前提にするコードは、当てるまで本番の DB につながない

新しいコードが新しい移行（列・表・関数の追加）を前提にする時は、push の後、移行を本番に当てるまで、普段の開発（`npm run dev`。DB は本番のまま）で新しいコードを本番の DB につながない。
移行の無い DB を読んで、画面と窓口が動かない。
例: グループ E-2 は移行 A〜C が無いと、注文の一覧・全部の種類のメールの材料・返金が動かない。
当てるまでの確かめは、手元の Supabase（`npm run db:start`・`npm run db:reset`）で行う。

### `--include-all` を使わない

本番の最新より古い日付の未適用ファイルがあると、`db push` は
`Found local migration files to be inserted before the last migration on remote database.` で止まる。
`--include-all` はこの確認を外すだけで、適用順が崩れる。止まったら、ファイル名と台帳のずれを直す。

## 書き方の規約

**オブジェクトの種別で冪等性の扱いを分ける。**
「全部を冪等にする」は一見安全だが、テーブルに対しては逆効果になる。

### 冪等にする — 関数 / ビュー / RLS ポリシー / GRANT

再実行しても同じ結果になる形で書く。ファイルが唯一の正になる。
Flyway の repeatable migration（`R__`）と同じ考え方。

```sql
CREATE OR REPLACE FUNCTION public.foo(...) ... ;

DROP POLICY IF EXISTS "name" ON public.bar;
CREATE POLICY "name" ON public.bar ...;

REVOKE ALL ON FUNCTION public.foo(...) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.foo(...) TO service_role;
```

### 冪等にしない — テーブル / 列 / データ移行

`CREATE TABLE IF NOT EXISTS` は「既にあるが形が違う」を**黙って見逃す**。
ドリフトを隠すので、事故に気づくのが遅れる。台帳が「一度だけ実行」を保証するので
冪等性は要らない。**想定外の状態では黙って飛ばさず、落ちること。**

```sql
-- 良い: 想定と違えば落ちる
ALTER TABLE public.sessions ADD COLUMN auth_session_id uuid;

-- 避ける: 既存の列の型が違っても素通りする
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS auth_session_id uuid;
```

### 必ずトランザクションで包む

```sql
BEGIN;
-- ...
COMMIT;
```

`CREATE FUNCTION` → `REVOKE` の順で書く箇所は、包まないと権限の窓ができる。
`CREATE INDEX CONCURRENTLY` などトランザクション内で実行できない文だけは
別ファイルに分け、その旨をコメントに書くこと。

### SECURITY DEFINER 関数は search_path の最後に `pg_temp` を書く

`CREATE OR REPLACE FUNCTION` は関数の設定（`pg_proc.proconfig`）を丸ごと置き換える。
本番で実測した結果（巻き戻し済み）:

| 書き方 | 適用後の `proconfig` |
| --- | --- |
| `SET search_path = public, pg_temp` | `search_path=public, pg_temp` |
| `SET search_path TO 'public'` | `search_path=public`（`pg_temp` が消える） |
| `SET` 句なし | `NULL`（設定ごと消える） |

`20260921011535_harden_security_definer_search_path.sql` は `ALTER FUNCTION ... SET` で
既存 20 本に `pg_temp` を足している。**ALTER は関数定義の中に残らない**ため、それより前の
マイグレーションを雛形にして貼り直すと、対策が静かに巻き戻る。

- 新しい SECURITY DEFINER 関数は `SET search_path = <スキーマ>, pg_temp` と書く
- 既存の関数を `CREATE OR REPLACE` で差し替えるときは、雛形にした版が古くても `pg_temp` を足す
- 雛形にするなら、その関数を最後に定義しているファイルを選ぶ（`ls supabase/migrations | grep <関数名>` で探せない場合は `grep -l`）
- 適用済みのファイルは書き換えない（台帳と md5 がずれる）。直すときは新しいマイグレーションを足す

`tests/unit/migrations/security-definer-search-path-guard.test.ts` が、上記の ALTER より後の
ファイルについてこれを機械的に確認する。DB 側の実際の状態は
`tests/integration/db/security_definer_search_path.integration.test.ts` が見る。

## 必要な GitHub Secrets

| 名前 | 取得元 |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase ダッシュボード > Account > Access Tokens |
| `SUPABASE_DB_PASSWORD` | プロジェクト > Settings > Database > Database password |
| `SUPABASE_PROJECT_ID` | `pjidrgofvaglnuuznnyj` |

## ローカル開発について

`npx supabase db reset` はローカル Docker のスタックを対象にする。本番には触れない。
ベースラインが入ったので、`db reset` は本番相当のスキーマを再現できる。
ただし `supabase/seed.sql` はまだ無いためデータは空。
`scripts/hooks/pre-push` の E2E をローカル DB 前提にするかは未決（seed の整備が先）。

## 付録: 台帳の旧 105 件をどうするか

ベースラインを作る前は、こうなっていた。

- 台帳: 105 行
- ローカルのファイル: 0 件

この状態では `db pull` 自体が先に止まる（`The remote database's migration history
does not match local files in supabase/migrations directory.`）。
`db push` も同様に「台帳にあるがローカルに無いバージョン」で停止する。

旧 105 件の内容はベースラインに吸収されるので、台帳から落として 1 対 1 に揃える。

`migration repair` は**台帳だけを書き換える。SQL は実行しないし、スキーマは変わらない。**

**2026-09-01 に実施済み。** 実際に `db pull` がこのエラーで停止したため、
次のコマンドを 1 行で実行して解消した（CLI は 1 件ずつの実行を提案してくるが、
バージョンを並べれば 1 回で済む）。以下は記録用。

```bash
npx supabase migration repair --status reverted 20260221083223 20260221084906 20260221091645 20260221100658 20260221103324 20260221103333 20260221103453 20260221103758 20260221103805 20260221103848 20260221104024 20260221104036 20260221104044 20260221104137 20260221104221 20260221104235 20260221104302 20260221104344 20260221104407 20260221104410 20260221104415 20260221104419 20260221104423 20260221104428 20260221104433 20260221104437 20260221104441 20260221104454 20260221104458 20260221104504 20260222101348 20260222101501 20260222101642 20260222103644 20260222115552 20260222120847 20260223012929 20260223012936 20260223091236 20260309135458 20260313124449 20260330160643 20260404024730 20260404024947 20260404031308 20260412055512 20260418055307 20260419012931 20260419014223 20260419015007 20260419015138 20260419071338 20260419081341 20260421120514 20260423105818 20260426004430 20260426004558 20260426031046 20260426031226 20260426073120 20260426073316 20260426080244 20260426080605 20260426115752 20260426122154 20260619224233 20260701131932 20260701132205 20260701132220 20260705034750 20260705041303 20260720084636 20260720084711 20260725080853 20260725103539 20260725130756 20260725135133 20260726063437 20260726090505 20260726113851 20260726123039 20260726130334 20260801033014 20260801090848 20260801132041 20260801153101 20260801153307 20260801153729 20260809120849 20260810062052 20260810071751 20260811132742 20260811132755 20260812105842 20260812121910 20260812230300 20260812230331 20260814000138 20260814015227 20260816022459 20260816025424 20260824104133 20260829110448 20260830005833 20260830225148
```

（2026-09-01 時点の台帳の全 105 件。最古 20260221083223、最新 20260830225148 = 093）

実行後に確認する。

```bash
npx supabase migration list      # ローカルとリモートが一致していること
npx supabase db push --dry-run   # 「適用対象なし」になること
```

適用履歴そのものは `migrations/*.sql` と git のコミット履歴に残るので、
台帳から落としても追跡性は失われない。

## 付録: 台帳とファイル名のずれを揃えた記録（2026-09-19）

レビュー指摘⑪。FREQ-380。

| ずれ | 原因 | 対処 |
|---|---|---|
| 本番は `20260911235714` / `20260913005807` / `20260913005917`、ファイルは `20260912000000` / `20260912010000` / `20260912015000` | MCP の `apply_migration` で当てた後、ファイル名を記録された version に直していなかった。SQL の中身は同一（コメント・`BEGIN`/`COMMIT`・空白を除いて一致） | ファイル名を本番の version に直した。本番は変更していない |
| バリアント在庫の6本（`20260906090000`〜`090500`）が未適用で、本番の最新より古い日付 | 在庫台帳の方針が決まるまで保留していた | 本番へ適用し（取り消し前提の試行で結果を確かめてから）、ファイル名を記録された version（`20260919065336`〜`20260919065518`）に直した |
| 掃除ジョブ（`20260912020000`）が未適用で、本番の最新より古い日付 | 呼び先のアプリが本番に無く、Vault の秘密も未登録 | `supabase/pending/` へ移した |

揃えた後の状態: ローカル17本と本番の台帳17件が1対1で一致し、`db push` で流れる未適用ファイルは無い。

この状態で CLI が勧める `migration repair --status reverted` だけを行い `--include-all` で流すと、
`20260911235714`（保持ジョブ）の SQL が再実行され、2026-09-14 に取り消した pg_cron の自己付与が戻る
（以後の `create extension pg_cron` が `dependent privileges exist` で失敗する）。台帳を書き換えず、
ファイル名を台帳に合わせたのはこのため。

## 権限を狭めるマイグレーションの順序

`REVOKE` を含むマイグレーションは、**アプリの新しいコードが動いてから**当てること。
順序を逆にすると、旧コードが剥がされた権限を使い続けて本番が壊れる。

例: `20260901120426_lock_down_guest_cart_rpc.sql` は `delete_cart_item_secure` /
`update_cart_item_quantity_secure` の EXECUTE を anon から剥がす。カート API が
service role 経由に変わっている必要がある。両者が同じ push に乗ると、
CI（DB）とホスティング（アプリ）のどちらが先に終わるかは保証されない。

2026-09-01 時点では Vercel にプロジェクトが無く、アプリはどこにもデプロイされて
いないため実害は無い。**ホスティングを用意したらこの節を読み直すこと。**
対処は次のいずれか。

- 権限を広げる変更を先に出し、狭める変更は次のリリースへ回す（2 段階デプロイ）
- メンテナンス時間を取って、アプリのデプロイ完了を確認してから `db push` を手で流す

## グループ G-1 在庫の割当の移行（20261023211425）

[設計書](../superpowers/specs/2026-10-23-group-g-design.md)の11章（切り替え）と[実装計画](../superpowers/plans/2026-10-24-group-g1-allocation.md)の Task 1・14・19 に従う。**2026-10-24 21:35（日本時間）に本番へ適用済み**。内容は[ER 図](../03_BasicDesign/data/er.md)の「在庫の割当と品物の状態の履歴」、流れは[在庫の割当の流れ](../04_DetailDesign/sequence/inventory-allocation.md)に書く。

### 記録

| 項目 | 値 |
| --- | --- |
| 移行ファイル | `supabase/migrations/20261023211425_group_g1_allocation.sql`（1本。先頭の `BEGIN;` と末尾の `COMMIT;` を1組だけ持つ。528,284 バイト、MD5 `7ecf481abdb351fb4b126e68c5746360`） |
| 本番適用版 | `20261023211425`（2026-10-24 21:35 JST、Supabase CLI の `db push --linked` で適用。CLI はファイルの版のまま記録するので改名なし） |
| 清掃件数 | オーナーが確認した件数（適用の直前に2回読み、同じ値）: `orders` 16、`order_items` 18、`order_revisions` 13、`checkout_drafts` 140、`private.order_email_outbox` 8、ほかの26の対象は0。`item_variants` は21行すべて元から在庫0（変化なし）。Webhook の `dead` への移し0、payout の計算し直し0、問い合わせの関連の解除0 |
| 適用後の照合 | 履歴の文 591個と、その連結の MD5 がローカルの `db reset` の履歴と一致。関数328（本文・所有者・設定）・トリガー108・列983 もローカルと一致。清掃の対象は全部0 |

件数は表名・条件・件数だけを書き、ID・メール・本文は書かない。

### 何をするか

1本のファイルが次の順に1取引で動く。途中までの適用はしない。

| 順 | 内容 |
| --- | --- |
| 1 | `SET LOCAL lock_timeout = '15s'`、共通の鍵 `pg_advisory_xact_lock(190521, 1)`、清掃の31表の `ACCESS EXCLUSIVE` ロック。cron の設定は変えず、この鍵と表のロックで cron・worker と直列にする。ロックごとに15秒が掛かるので、全体が15秒で必ず終わるとは言わない。取れなければ SQLSTATE `55P03` で全部戻る |
| 2 | **清掃**。開始時に削除対象の表のユーザートリガーが通常有効か、法定保存の2つの削除保護（`protect_legal_order_delete`・`protect_legal_order_item_delete`）があるか、循環 FK の形が想定どおりかを確かめ、違えば `GROUP_G_CLEANUP_PRECONDITION`（55000）で始めない。確かめた後、この取引の中だけユーザートリガーを無効にして消し、同じ取引の中で有効に戻す。循環 FK `order_items_exchange_return_line_id_fkey` は一時的に外し、同名・同じ列・`ON DELETE RESTRICT` で戻す |
| 3 | **本体**。4表・2列・台帳の理由・割当の鍵と FIFO・状態の投影と履歴・各入口の置き換え（受付・入金・解放・返金・申し込み・返品・交換・配送）・書き手の閉じた一覧。詳細は ER 図 |
| 4 | **旧入口の停止**。旧の発送4関数と仕上がりの手動記録2関数を、処理せず拒否する定義に置き換える（SQLSTATE 55000）。仕上がりの表への書込みを止める。旧の写しの関数2本を消す。**G-3 の発送票が出るまで、管理画面から発送・発送の取消・伝票番号の訂正・手動の配達済み・仕上がりの記録はできない** |
| 5 | **末尾の確かめ**（3つのブロック）。清掃後の状態、新しい表・列・制約・トリガー・関数・権限の期待、書き手の集合を比べる。1つでも違えば `GROUP_G_MIGRATION_ASSERTION_FAILED`（55000）で、清掃も本体も含めて全部戻る（全部成功か何も起きないか）。続けて `NOTIFY pgrst, 'reload schema'`、`COMMIT` |

清掃で消す・直すもの（31の永続表）:

| 操作 | 表 |
| --- | --- |
| 全件削除（25表） | `private.order_email_outbox`・`private.order_status_links`・`private.fulfillment_tracking_registrations`、`public` の `order_fulfillment_attention`・`order_fulfillment_events`・`order_fulfillment_tracking_changes`・`order_return_photos`・`order_return_photo_uploads`・`order_cancel_request_lines`・`order_cancel_requests`・`order_return_receipt_lines`・`order_return_receipts`・`order_refund_lines`・`stock_movements`・`order_refunds`・`order_return_lines`・`order_fulfillment_lines`・`order_item_completions`・`order_items`・`order_fulfillments`・`order_returns`・`order_revisions`・`payment_exceptions`・`checkout_drafts`・`orders`（削除の順は外部キーに従い、`stripe_refunds`・`stripe_balance_transactions` の注文に結ぶ行を先に消してから `orders` を消す） |
| 注文に結ぶ行だけ削除（2表） | `stripe_refunds`・`stripe_balance_transactions`（消す注文に結ぶ行） |
| 関連だけ外す（1表） | `contact_inquiries.order_id` を空にする。本文と子メッセージは残す |
| 在庫を0にする（1表） | `item_variants.stock_quantity`（無効な variant も含む全部）。**適用後は全商品が、再入荷を記録するまで売り切れ表示になる** |
| 集計を直す（1表） | `stripe_payouts`。影響を受ける payout だけ、残る balance の net の合計で `reconciled_net` を計算し直し、照合状態を `pending` に戻す（行は残す） |
| 終端にする（1表） | `stripe_webhook_events`。消す注文に結ぶ未完了のイベントだけ `dead` にし、理由 `group_g1_test_data_cleanup` と通知済み時刻を同じ更新で入れる（削除しない。テストデータについて知らせのメールは送らない） |

商品・variant・色・サイズ、利用者と全 ACL・G-0 の履歴、問い合わせの本文、注文に結ばない Stripe の写し、payout の行、Resend の重複防止の記録、Webhook の全行、監査ログ、Storage の全オブジェクトは残す。写真は注文に結ぶ DB の行だけを消す。条件の正確な文は計画の Task 1 の表が唯一の正本で、本書はその要約。

### 当て方

計画では Supabase MCP の `apply_migration` でファイル全文を1回だけ当てる予定だった。実際は、ファイルが 528KB と大きく1回の呼び出しで渡せないため、オーナーの指示で **Supabase CLI の `db push --linked`** で当てた（ローカルの `db reset` と同じ仕組みでファイルをそのまま1取引で当てる。CLI はログイン済みの印で一時的な役割を作って接続し、DB のパスワードは扱っていない）。清掃だけ・本体だけの個別適用と、移行履歴への手の INSERT はしない。読み取りは MCP の `execute_sql`。

| 順 | 内容 |
| --- | --- |
| 1 | 全体検証（型・単体・DB 結合・E2E を最新の基準と比較・最終レビュー）を終える |
| 2 | MCP で件数だけを読む（31表の条件別の件数、全 variant の件数と在庫の合計、削除する balance の件数、影響する payout の件数、問い合わせの解除件数、未完了の Webhook の件数）。ID・メール・本文は読まない。本番とローカルの関数の指紋・所有者・`search_path`・権限・トリガー・FK も読み比べ、差があれば止める |
| 3 | 適用前に次を確かめる（最終レビューの推奨）。(a) `anon`・`authenticated`・`service_role` の `pg_auth_members` と `pg_write_all_data`・`pg_read_all_data`・`pg_maintain` の所属（所属があると台帳の INSERT 権限の確かめが落ちて全部戻る）。(b) 清掃の対象27表のユーザートリガーの `tgenabled`（`O` 以外があると開始時に止まる。安全側だが時間枠を無駄にする）。(c) 本番にだけある関数の有無（本番とローカルの関数の集合を両方向で比べる） |
| 4 | 移行ファイルの文字を固定する（UTF-8・BOMなし・LF、全角空白 U+3000 と CR が0、ドル引用の外のトップレベルの `BEGIN`・`COMMIT` が各1）。MD5（小文字）とバイト数を保存し、以後ファイルを変えたら検証・レビュー・この固定からやり直す |
| 5 | 手元で動くアプリと worker を止める（3000番の E2E 用のアプリも）。止めたことを棚卸しで確かめ、master の対象コミットだけを push する |
| 6 | 適用の直前に、writer（アプリ・worker）、cron の登録（jobname・schedule・active・関数名だけ。command の本文は出さない）、31表の件数を読み直す。**前回より多くても少なくても止めて**原因を確かめ、連続2回の読み取りが一致する安定した件数を作る。cron の設定は変えない |
| 7 | オーナーに31表の条件と件数を示し、**明示の確認**を取る（一般の実装の承認や時間経過では代えない）。確認後に件数や時間枠が変わったら 6 に戻る |
| 8 | `supabase migration list --linked` で本番に無いのが G-1 だけであることを、`supabase db push --linked --dry-run` で当てるのが G-1 の1本だけ（seed・役割なし）であることを確かめ、`supabase db push --linked` を1回流す |
| 9 | 当てた文を照合する。CLI は文ごとに分けて記録するので、`array_length(statements,1)` と `md5(array_to_string(statements, E'\n'))` を、ローカルで `db reset` した履歴の同じ値と比べる。新しい表・列・関数・権限、旧入口の停止、31表の結果（件数・全 variant が0・Webhook の `dead`）、`private` スキーマの `USAGE`、G-0 の保持を読み取りで確かめる。本番で試験の注文は作らない |
| 10 | 版はファイルのまま記録されるので改名しない。上の記録を埋めてコミットし、push する |

### 失敗したとき・戻すとき

- `55P03`（15秒でロックが取れない）、`40P01`（deadlock）を含む失敗は、全部戻る。移行履歴にも残らないことを読み取りで確かめる。個別の節の適用や、すぐの強制再試行はしない。後の時間枠で 2 からやり直す。cron の設定を変えて通さない。
- 適用に成功した後の巻き戻しは用意しない。清掃で消したテスト用の注文と関連記録は戻せない。後からの直しは新しい移行で行う。
- 適用の前に、ローカルの DB でも同じ全文を、故障を注入して実行する試験（`group_g1_cleanup.integration.test.ts`）があり、末尾の確かめが失敗したときに清掃・新しい表・列・関数がすべて戻ることを確かめている。本番での実行を意味しない。

### 適用後に残る作業

- 旧の発送4関数と仕上がりの2関数は、G-3 の発送票まで再開しない。
- 適用の前後の読み比べで、G-1 と関係のない前からの差が2つ見つかった（G-1 は触っていない）。後でどちらに揃えるかを決める。
  - 11の関数（`cleanup_password_reset_tokens`・`clear_admin_expense_cost_allocations`・`create_profile_for_new_auth_user`・`find_auth_user_id_by_email`・`increment_rate_limit_counter` の2つ・`is_auth_session_active`・`record_admin_finance_entry_revision`・`replace_admin_expense_cost_allocations`・`revoke_auth_session`・`revoke_auth_sessions_for_user`）の EXECUTE 権限が、本番は `postgres`・`service_role` だけ、ローカル（移行ファイル）は `anon`・`authenticated` にも付く。本番の方が狭い。**G-2 の最初の移行（`20261024153505_group_g2_purchasing_foundation.sql`）が、ローカル側の `anon`・`authenticated`・PUBLIC の EXECUTE を外して本番に揃える**（下の「グループ G-2 発注・受け取りの移行」）。
  - `admin_finance_summary_options` の2つの CHECK 制約の定義の括弧の付き方が違う（意味は同じ）。
  - 7つの関数の本文の改行（CR の有無）が違う（CR を除くと同じ）。

## グループ G-2 発注・受け取りの移行（20261024153505〜）

[設計書](../superpowers/specs/2026-10-23-group-g-design.md)と[実装計画](../superpowers/plans/2026-10-24-group-g2-purchasing.md)に従う。移行は2本（Task 1 で作り Task 2 以降が足す基盤と、Task 4 で作り Task 6 以降が足す書込みの `writers`）。ここには基盤の移行を書き（Task 1 の分と Task 2 の発注書の9表と Task 3 の在庫一覧表の読取と Task 5 の発注の読取）、`writers` の移行は下の「writers の移行」に書く。**2本とも 2026-10-25 12:39 JST に本番へ適用済み**（全体の検証の後に、基盤・書込みの順で。記録は下の「本番適用の記録」）。基盤のファイルの 100,000 バイトの上限は Task 3 で外した（本番は `npx supabase db push --linked` でファイルごとに1取引で当て、CLI は大きなファイルも扱える）。移行は2本のまま。

### 記録（Task 1 の基盤）

| 項目 | 値 |
| --- | --- |
| 移行ファイル | `supabase/migrations/20261024153505_group_g2_purchasing_foundation.sql`（先頭の `BEGIN;` と末尾の `COMMIT;` を1組だけ持つ。本体は `-- G2A_BODY_BEGIN`〜`-- G2A_BODY_END`、末尾の確かめは `-- G2A_FINAL_ASSERT_BEGIN`〜`-- G2A_FINAL_ASSERT_END`。UTF-8・BOMなし・LF） |
| 本番適用版 | `20261024153505`（2026-10-25 12:39 JST、Supabase CLI の `db push --linked` で適用。版はファイルのまま） |
| 書込みの移行 | `supabase/migrations/20261024180500_group_g2_purchasing_writers.sql`（Task 4。常に基盤の後。節の印は `-- G2B_BODY_BEGIN`〜`-- G2B_BODY_END` と `-- G2B_FINAL_ASSERT_BEGIN`〜`-- G2B_FINAL_ASSERT_END`。UTF-8・BOMなし・LF・ASCII のみ）。本番適用版 `20261024180500`（同じ push で基盤の直後に適用） |

### 何をするか

G-1 の適用済みの移行は変えず、新しい移行の本体で次を行う。

| 順 | 内容 |
| --- | --- |
| 1 | 内部の部品 `private.group_g_actor_has_permissions(_actor_id, _codes)` を足す。実行者の有効な（`active` かつ期限なしか未来の）全ての役割の権限の**和集合**が `_codes` を全て含む時だけ true（窓口の `authorizeAdminPermissions` と同じ意味）。NULL・空配列・未登録コードは false。誰にも EXECUTE を付けない（G-2 の DB 関数の権限の確かめはこれ1つ） |
| 2 | 内部の部品 `private.group_g_open_work_order_ids(_variant_ids)` を足す。そのバリアントを含み、受注生産の数がありうる注文の id を昇順で返す先絞り（NULL は全バリアント）。投影（`group_g_item_state_ranges`）が受注生産と数えうる注文の**上位集合**で、外すのは数えようのない注文だけ: `payment_in_progress`・`abandoned`（投影が隠す）、未発送で取り消されていない数（明細の数 − 取り消していない発送の数 − 発送前返金の数〔`awaiting_response`・`pending`・`succeeded`〕が正）が無く、未解決の返品・返金・取消申請・発送前返金の失敗も無い `shipped`（投影の「残り > 取消」と同じ条件）、入金の記録（`paid_at`・`paid_amount`）も paid の割当も発送も無い `pending`・`failed`、割当も発送も無い `cancelled`（G-1 の規則で全部が取消の数）。`paid`・上の条件を満たす `shipped`（発送の記録が無い発送済みの注文を含む）・入金の記録か paid の割当か発送がある `pending`・`failed` は残す。発送か割当のある `cancelled` は、投影が何も数えない形でも残す（既知の費用。先絞りは上位集合のままにして、決めるのは投影）。誰にも EXECUTE を付けない |
| 3 | `private.admin_record_stock_movement` の権限の確かめだけを `admin.items.manage` から `admin.stock.manage` ＋ `admin.stock.read`（1で足した部品）へ替える。ほかは G-1 のまま（`CREATE OR REPLACE`。署名・所有者・ACL・戻り型は同じ） |
| 4 | `private.list_group_g_variant_inventory` の受注生産の数え方を、そのバリアントを持った全注文でなく、2で足した先絞りが返す注文だけに投影を掛ける（`CREATE OR REPLACE`）。先絞りが上位集合なので、絞らない投影と同じ数になる（試験が variant ごとに比べる）。`lock_group_g_inventory` は変えない（その閉包は、割当も保留も残らない閉じた注文を入れないが、`pending`・`payment_in_progress`・期限切れでない失敗の注文と、割当か保留が残る注文〔状態に関わらず〕は入れる） |
| 5 | `private.guard_group_g_paid_at` に、`orders.paid_at` の最初の値（NULL から値）は共通の鍵 `(190521,1)` を持つ接続だけが書ける、という確かめを足す（`GROUP_G_INVENTORY_LOCK_REQUIRED`／55000）。値から別の値・NULL は今までどおり `GROUP_G_PAID_AT_IMMUTABLE` |
| 6 | 認証・会計の公開関数11本の EXECUTE を `PUBLIC`・`anon`・`authenticated` から外す（`GRANT` は足さない。`service_role` と `postgres` は触らない） |
| 7 | 発注書の9表を作る（Task 2。`purchase_orders`・`purchase_order_lines`・`purchase_order_revisions`・`purchase_order_short_closures`・`purchase_order_receipts`・`purchase_order_receipt_lines`・`purchase_order_attachment_reservations`・`purchase_order_attachments`・`purchase_order_attachment_revisions`。すべて public・所有者 postgres・主キー uuid。外部キー22本はすべて `ON DELETE RESTRICT`、操作の受付 `private.group_g_operations` への5本だけ遅延）。データを入れる文は無い |
| 8 | 追記専用の7表に `*_no_update`・`*_no_delete`・`*_no_truncate` を付け（G-1 と同じ `private.reject_group_g_event_mutation()`）、`purchase_orders`・`purchase_order_lines` の削除と TRUNCATE を同じ関数で断る |
| 9 | `private.guard_group_g_purchase_order_change()` を `purchase_orders`・`purchase_order_lines` の BEFORE UPDATE に付ける（識別の列の変更を断る・変わる更新は `version` +1 と共通の鍵の保持を要る） |
| 10 | `private.check_purchase_order_receipt_line()`（受取行の BEFORE INSERT。台帳の無タグの行との突き合わせと相殺元の確かめ）と `private.check_purchase_order_line_received()`（納品数と受取行の合計・相殺の超過を commit の時に確かめる遅延トリガー）を足す |
| 11 | 9表の RLS・拒否だけの `RESTRICTIVE` の方針・全権限の剥奪。service_role に `SELECT` を残すのは `purchase_order_attachments` と `purchase_order_attachment_reservations` だけ |
| 12 | 非公開の置き場 `purchase-order-documents`（20 MiB・PDF／JPEG／PNG）を `storage.buckets` に1行足す（`ON CONFLICT (id) DO NOTHING`）。`storage.objects` の方針は作らない |
| 14 | 在庫一覧表の読取 `private.list_admin_inventory(_actor_id)` と public 入口を足す（Task 3。下の「14 の在庫一覧表の読取について」）。10 の受取行の確かめには、受け取りの種類と行の符号を結ぶ確かめ（`DETAIL` は `kind`）も足した |
| 15 | 発注の読取の3関数と public 入口2本を足す（Task 5。下の「15 の発注の読取について」）: 内部の helper `private.purchase_order_display_stages(uuid[])`（表示段階を導く唯一の場所。誰にも EXECUTE を付けない）、`private.list_admin_purchase_order_lines(_limit, _offset, _actor_id)`、`private.get_admin_purchase_order(_purchase_order_id, _actor_id)` と、後の2つの同名の public 入口。末尾に `$g2a_final_purchase_reads$`（`DETAIL` は `purchase_read_functions`）を足した |
| 13 | 末尾の確かめ（`GROUP_G_MIGRATION_ASSERTION_FAILED`／55000、`DETAIL` が項目名）。Task 1 の `public_function_acl`（11本が存在し、anon・authenticated・PUBLIC〔有効な ACL で見る。`proacl` が NULL なら既定の ACL〕が EXECUTE できず、service_role が EXECUTE できる）に、Task 2 の `$g2a_final_objects$`（9表に今の取引が書いた行が無いこと・RLS・所有者・方針・列・制約87本・索引25本・トリガー30本・3関数・置き場の値と方針の無さ。`purchase_tables`・`purchase_table_rows`・`purchase_table_policies`・`purchase_table_columns`・`purchase_table_constraints`・`purchase_table_indexes`・`purchase_table_triggers`・`purchase_functions`・`purchase_bucket`・`purchase_bucket_policies`）と `$g2a_final_table_acl$`（`purchase_table_acl`。表の権限を意味で比べ、PostgreSQL 17 以降は `MAINTAIN` も「無い」の一覧に入れる）を足した。Task 9 は `$g2a_final_objects$` に、足した2つの部品と置き換えた G-1 の3関数の所有者・SECURITY・volatility・search_path・EXECUTE（`foundation_functions`）、この file の14関数の名前の関数が他に無いこと（`foundation_function_set`）、service_role が EXECUTE できるのは読取の本体4本と入口4本だけであること（`foundation_service_role_execute`）を足し、`purchase_table_rows` を「今の取引が書いた行が無い」（`created_at` が取引の開始時刻と同じ行が無い）に直した（後から確定した別の取引の行で確かめが落ちないように）。違えば全部戻る。続けて `NOTIFY pgrst, 'reload schema'`、`COMMIT` |

### 6 の公開関数11本の EXECUTE について（セキュリティ）

ベースの移行（`20260901102912_remote_schema.sql`）は、この11本について `PUBLIC` を外して `postgres`・`service_role` に付けただけで、Supabase の既定の権限が付けた `anon`・`authenticated` の直接の EXECUTE が残った。移行から作った DB（ローカルの `db reset` など）では、anon が `revoke_auth_sessions_for_user` などを呼び、他の利用者のセッションを消せた。**本番は 2026-10-24 の読み取りで `postgres`・`service_role` だけが持つことを確かめてあり、本番の状態は変わらない**（適用の直前にもう一度読み取って確かめる）。

呼び出し元は全て `createServiceRoleClient`（service_role）で、anon・authenticated のクライアントから呼ぶ箇所は無い（2026-10-25 に再確認: `revoke_auth_sessions_for_user` は password-reset の confirm・logout・admin の revoke-user-sessions、`revoke_auth_session` は logout、`is_auth_session_active` は `authenticate.ts`、`find_auth_user_id_by_email` は register と password-reset の request・link、`increment_rate_limit_counter` は `features/auth/ratelimit`、`replace_` と `clear_admin_expense_cost_allocations` は accounting の product-costs。`cleanup_password_reset_tokens` は src に呼び手が無く、`create_profile_for_new_auth_user` と `record_admin_finance_entry_revision` はトリガー関数で、PostgreSQL はトリガー関数の EXECUTE を作成時にしか確かめないので発火に影響しない）。新しいコードを前提にする移行ではなく、権限を狭めるだけの移行なので、アプリの順序の制約（「権限を狭めるマイグレーションの順序」）は、呼び手が全て service_role のため本番では満たされている。

### 7〜13 の発注書の9表について（Task 2）

- **本番への影響**: 新しい表・関数・トリガー・方針と `storage.buckets` の1行を足すだけで、既存の表・行は変えない。データを変える文（清掃・補完・権限行の再投入）は無いので、適用の前の owner 確認は要らない。構造と列・制約・索引・トリガー・権限は移行の末尾の確かめが全部見る。
- **適用の直前に読み取って確かめる**: `storage.buckets` に `purchase-order-documents` がまだ無いこと。既にあって設定が違うと（`public = true`・上限・種類）、`ON CONFLICT (id) DO NOTHING` は何も変えず、末尾の確かめ（`purchase_bucket`）が移行全体を戻す。その時は置き場の設定を確かめてから決める（黙って直さない）。
- **外部キーと TRUNCATE**: 追記専用の表の TRUNCATE は、PostgreSQL が外部キーの確かめをトリガーより先に行うので、その表を指す表を同じ文に並べない限りトリガーに届かない（届かなくても全消しはできない）。G-1 の `group_g1_model`（操作の受付の全消し）と `stock_movements`（台帳の全消し）の試験は、新しく指す表を同じ文に足して「追記専用」の拒否を確かめ続けた。操作の受付 `private.group_g_operations` を指す外部キーは 4 本から 9 本（遅延）になった。
- **大きさ**: 基盤の移行は Task 2 の後で約 76 KB、Task 3 の後で約 84 KB。100,000 バイトの上限は Task 3 で外した（上の記録のとおり、CLI は大きなファイルも扱える）。3 本目に分けず、移行は2本のまま。バイト数と MD5 は適用の直前に固定して記録する。

### 14 の在庫一覧表の読取について（Task 3）

- **足すもの**: `private.list_admin_inventory(_actor_id uuid)` と、同じ名前・引数・戻り型の public 入口（`LANGUAGE sql STABLE SECURITY INVOKER`）。戻り列は `variant_id`・`item_id`・`item_name`・`color_name`・`size_label`・`is_active`・`free`・`paid_allocated`・`payment_held`・`on_hand`・`order_quantity`・`on_order`・`required` の13。private 本体は `plpgsql STABLE SECURITY DEFINER SET search_path = ''`、所有者 postgres。private 本体も public 入口も `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける（public 入口は INVOKER なので、private 本体にも `service_role` の EXECUTE が要る）。`private` schema の USAGE には触れない。
- **何をするか**: 最初に `private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.stock.read'])` を確かめ、偽なら `GROUP_G_FORBIDDEN`／42501（何も読む前）。一つの SQL の中で、在庫は G-1 と同じ（`on_hand` = 空き＋入金済みの割当＋支払い前の仮確保）、注文数は `group_g_item_state_ranges(group_g_open_work_order_ids(NULL))` の `in_production`＋`ready`、発注済みは数量確定済みの発注の未納（`outstanding_quantity`）、`required` = `max(0, 注文数 − 在庫 − 発注済み)`。表示は、販売中か、在庫・未納・注文数のどれかがある variant。並びは商品・色の位置・サイズの位置・variant の番号。**何も書かず、variant を作らない**（STABLE なので全体が呼び出しの snapshot を共有する）。
- **本番への影響**: 新しい関数を足すだけ。表・行・権限は変えない。
- **末尾の確かめ**: `$g2a_final_inventory_list$`（`DETAIL` は `inventory_list_functions`）が、2関数の存在・所有者・`SECURITY DEFINER` か INVOKER か・言語・`STABLE`・集合を返すこと・`search_path` が空・引数と戻り列の名前／型／順・anon／authenticated／PUBLIC が EXECUTE できず service_role ができること、を見る。
- **Task 2 のレビューからの持ち越し（M1）**: `private.check_purchase_order_receipt_line()` に、受け取りの種類と行の符号の確かめを足した。種類 `receive` の受け取りは正の行だけ、種類 `reverse` の受け取りは負の行だけ。違えば `GROUP_G_PO_RECEIPT_LINE_MISMATCH`／23514（`DETAIL` は `kind`）。まだ本番に当てていない移行の中の関数なので、同じファイルの中で直した。

### 15 の発注の読取について（Task 5）

- **足すもの**: 次の5関数（すべて所有者 postgres、`search_path` 空）。
  - `private.purchase_order_display_stages(_purchase_order_ids uuid[])`（`plpgsql STABLE SECURITY DEFINER`）: 発注書ごとに 表示段階・納品の合計・未納の合計・`has_active_short_close` を返す。**表示段階を導く唯一の場所**（規則は[発注書の状態](../04_DetailDesign/states/purchasing.md)。打切りを戻すのは数量が実際に変わる `quantity` の版だけで、単価だけの版は戻さない）。`PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE し、GRANT しない（呼ぶのは同じ所有者の DEFINER 関数だけ）。
  - `private.list_admin_purchase_order_lines(_limit integer, _offset integer, _actor_id uuid)`（`plpgsql STABLE SECURITY DEFINER`）と、同じ名前・引数・戻り型の public 入口（`LANGUAGE sql STABLE SECURITY INVOKER`）: 明細ごとの行を発注書番号の降順（`COLLATE "C"`）・明細番号順で返し、各行に全明細の数 `total` を持たせる。`_limit` は 1〜100、`_offset` は 0 以上（外は `GROUP_G_ARGUMENT_INVALID`／22023。権限の確かめの後）。
  - `private.get_admin_purchase_order(_purchase_order_id uuid, _actor_id uuid)`（`plpgsql STABLE SECURITY DEFINER`、戻りは jsonb）と public 入口（`LANGUAGE sql STABLE SECURITY INVOKER`）: 発注書の詳細を camelCase の jsonb で返し、無ければ NULL。`storage_path` と内部の操作 ID は含まず、`sha256` は含む。書類の `current` は最新の版だが、`replacesAttachmentId` は版1にしか保存されない（表の CHECK）ので版1から返す。
  - 4本の読取とも `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける（public 入口は INVOKER なので private 本体にも要る）。`private` schema の USAGE には触れない。
- **権限**: 一覧も詳細も、最初に `private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.read'])` を確かめ、偽なら `GROUP_G_FORBIDDEN`／42501（何も読む前）。`manage` は要らない。
- **何も書かず、鍵も取らない**: 3つとも STABLE で、呼び出しの snapshot を共有する。共通の鍵・行の鍵・動的な SQL は使わない（G-1 の「書き手の閉じた一覧」の走査に掛からない）。
- **本番への影響**: 新しい関数を足すだけ。表・行・権限は変えない。データを変える文は無いので、適用の前の owner 確認は要らない。
- **末尾の確かめ**: `$g2a_final_purchase_reads$`（`DETAIL` は `purchase_read_functions`）が、5関数の存在・所有者・`SECURITY DEFINER` か INVOKER か・言語（plpgsql／sql）・`STABLE`・集合を返すか・戻り型・`search_path` が空・引数名と戻り列の名前／型／順・anon／authenticated／PUBLIC が EXECUTE できないこと・service_role の EXECUTE（helper だけ無し、他の4本は有り）を見る。
- **大きさ**: 基盤の移行は Task 5 の後で約 104 KB（約 84 KB から約 20 KB 増えた。上限は Task 3 で外してあり、移行は2本のまま）。バイト数と MD5 は適用の直前に固定して記録する。

### 16 の取引書類の検索について（Task 8）

- **足すもの**: `private.search_purchase_order_documents(_date_from date, _date_to date, _amount_min bigint, _amount_max bigint, _counterparty text, _purchase_order_number text, _kind text, _include_history boolean, _limit integer, _offset integer, _actor_id uuid)`（`plpgsql STABLE SECURITY DEFINER`、所有者 postgres、`search_path` 空、集合を返す）と、同じ名前・引数・戻り型の public 入口（`LANGUAGE sql STABLE SECURITY INVOKER`）。戻り列は `total`・`attachment_id`・`purchase_order_id`・`purchase_order_number`・`kind`・`original_file_name`・`mime_type`・`size_bytes`・`revision_no`・`is_current`・`transaction_date`・`amount_yen`・`currency`・`counterparty`・`voided`・`reason`・`replaces_attachment_id`・`created_at` の18で、**`storage_path` は返さない**。private 本体も public 入口も `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける。`private` schema の USAGE には触れない。
- **何をするか**: 最初に `private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.purchase_orders.read'])` を確かめ、偽なら `GROUP_G_FORBIDDEN`／42501（何も読む前）。次に引数（`_kind` は quote・invoice・NULL、`_include_history` は NULL でない、`_limit` は 1〜100、`_offset` は 0 以上。外は `GROUP_G_ARGUMENT_INVALID`／22023）。既定は各添付の最新の版だけ、`_include_history` が真なら全ての版を対象にして `is_current` で最新と区別する。取引日・金額は両端を含む範囲、取引先は大小文字を区別しない部分一致（`strpos`。`% _ \` は文字）、発注書番号は大小文字を区別しない前方一致、種類は一致、全て AND。並びは `transaction_date DESC, created_at DESC（版の記録）, 版の id`。`total` は頁を切る前の件数。何も書かず、鍵も取らない。
- **本番への影響**: 新しい関数を足すだけ。表・行・権限は変えない。データを変える文は無いので、適用の前の owner 確認は要らない。
- **末尾の確かめ**: `$g2a_final_purchase_reads$`（`DETAIL` は `purchase_read_functions`）の対象に、この2関数（存在・所有者・DEFINER か INVOKER か・言語・`STABLE`・集合を返す・戻り型・`search_path` 空・引数名と戻り列の名前／型／順・anon／authenticated／PUBLIC が EXECUTE できず service_role ができる）を足した。基盤の移行は Task 8 の後で約 115 KB。予約の表に差し替え元 `replaces_attachment_id uuid`（NULL 可。添付への外部キー `purchase_order_attachment_reservations_replaces_fkey`、`ON DELETE RESTRICT`）を足した（最後の確かめの列の並びと制約の一覧にも入れた。版の表の同じ列〔版1だけ〕と同じ向き）。発注書の詳細の `pendingUploads` の各要素は `replacesAttachmentId` を持ち、書類検索の `replaces_attachment_id` は版1から読む。バイト数と MD5 は適用の直前に固定して記録する。

### writers の移行（Task 4・6・7・8。発注の作成とロック helper、数量の確定・訂正・打切り・発注先の訂正、受け取りとその取消・数量訂正、取引書類の原本の予約・確定・訂正）

`20261024180500_group_g2_purchasing_writers.sql` は、基盤の移行が作った表に書く関数だけを持つ（発注の作成・数量の確定と訂正・打切り・発注先の訂正・受け取りとその取消・取引書類の原本の書込みが、Task 4・6・7・8 でここに入った）。データを変える文は無く、**本番の変更は関数の追加と書き手の一覧の置き換えだけ**（owner 確認は要らない）。Task 6 は同じファイルに節3〜5（下の順 3〜5）を足し、書き手の一覧を60本にした（ファイルは約 25 KB から約 52 KB）。Task 7 は節6・7（下の順 6・7）を足し、書き手の一覧を62本にした（約 81 KB）。Task 8 は節8（下の順 8。取引書類の原本の3関数）を足し、書き手の一覧を65本にした（約 103 KB。バイト数と MD5 は適用の直前に固定して記録する）。レビューの後、差し替え元を予約の行に残す形にしたので、予約の関数は `_replaces_attachment_id` を取り（署名は 6 引数）、確定の関数は取らない（署名は 12 引数）。この移行は本番へ未適用なので、適用済みの SQL を変えることにはならない。

| 順 | 内容 |
| --- | --- |
| 1 | ロック helper `private.lock_group_g_purchase_orders(_purchase_order_ids uuid[], _with_inventory boolean) RETURNS uuid[]`（`SECURITY DEFINER`・所有者 postgres・`search_path` 空）を足す。**最初の文が共通の鍵 `pg_advisory_xact_lock(190521,1)`**。`_with_inventory` が真なら、その鍵の**後**に発注書の行の `variant_id` を読み、`lock_group_g_inventory(その variant, [], NULL)`（鍵は再入できる）で在庫の閉包を取って、ロックした注文の id（昇順）を返す。偽なら空の配列。続けて `purchase_orders`（id 昇順）→ `purchase_order_lines`（id 昇順）を `FOR UPDATE` で取る。`SKIP LOCKED` は使わない。呼び手は対象を後から足して前の段に戻らない。**誰にも EXECUTE を付けない**（service_role にも） |
| 2 | `private.admin_create_purchase_order(_supplier_name, _memo, _lines, _actor_id, _request_key) RETURNS jsonb` と、同じ名前・引数・戻り型の public 入口（`LANGUAGE sql SECURITY INVOKER`）を足す。private 本体も public 入口も `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける。処理の順は **引数の検証（`22023`）→ ロック helper（鍵だけ）→ 権限（`admin.purchase_orders.manage` ＋ `read` の和集合。`42501`）→ 指紋と再送・衝突（`23505`）→ variant の存在（`22023`）→ 番号 → INSERT**。詳細は[発注の作成の順序図](../04_DetailDesign/sequence/purchasing.md) |
| 3 | **発注先・メモの訂正**（Task 6）`private.admin_update_purchase_order_header(_purchase_order_id uuid, _expected_version integer, _supplier_name text, _memo text, _reason text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{version, replayed}`）と同名・同引数・同戻り型の public 入口。操作の種類 `purchase_order_header_update`。理由が必須（`GROUP_G_PO_REASON_REQUIRED`／22023、引数検証の段）。発注先もメモも変わらなければ 22023。履歴は種類 `header`（`line_id` NULL、前後の発注先とメモ）で `revision_no` ＝ 新しい版、発注書の版 +1。どの段階でも直せる |
| 4 | **数量の確定・訂正**（Task 6）`private.admin_confirm_purchase_order_quantities(_purchase_order_id uuid, _expected_version integer, _lines jsonb, _reason text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{version, changedLines, replayed}`）と public 入口。操作の種類 `purchase_order_quantities`。`_lines` は `[{lineId, quantity 0〜99999, unitPriceYen 0〜9999999 または null}]` で、各要素は3項目ちょうど、発注書の全行をちょうど1回ずつ（不足・重複・他の発注書の行は 22023）。段階 `ordered` は最初の確定（理由は任意）で全行の確定数量と単価を決めて段階を `quantity_confirmed` にし（全行の版が進む）、`quantity_confirmed` は訂正（理由が必須。納品済み未満は `GROUP_G_PO_QUANTITY_BELOW_RECEIVED`／23514、何も変わらなければ 22023）。履歴 `quantity` は、**最初の確定は全行に**（確定そのものを追記専用の履歴に残す。仮数量のまま・単価なしの行も、理由と実行者つきで書く）、訂正は変わった行（数量または単価。NULL と 0 は別）だけに足す。`changedLines` は実際に変わった行だけを数える。前の数量は確定数量（最初の確定は仮数量）で、**単価だけの変更も `before_quantity` ＝ `after_quantity`（現在の数量）で書く**（基盤の節15の表示段階は、数量が実際に変わる `quantity` の版だけを打切りの取消として数える）。発注書の版 +1 |
| 5 | **残りの打切り・確定前の取消**（Task 6）`private.admin_short_close_purchase_order(_purchase_order_id uuid, _expected_version integer, _line_ids uuid[], _reason text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{version, closedQuantity, replayed}`）と public 入口。操作の種類 `purchase_order_short_close`。理由が必須（`GROUP_G_PO_REASON_REQUIRED`、引数検証の段）。`_line_ids` は1次元で1〜100件・NULL と重複なし（他の発注書の行は 22023）。段階 `quantity_confirmed`: 選んだ行の未納に0があれば `GROUP_G_PO_NOTHING_TO_CLOSE`／55000。各行の確定数量を納品済みまで下げ、履歴 `short_close`（前＝確定数量、後＝納品済み）と `purchase_order_short_closures`（`closed_quantity` ＝ 未納）を足す。段階 `ordered`（確定前の取消）: 全行をちょうど1回ずつ渡した時だけ（一部は 22023）、全行の確定数量を 0 にして段階を `quantity_confirmed` へ進め、履歴（前＝仮数量、後＝0）と打切り（`closed_quantity` ＝ 仮数量）を足す。どちらも発注書の版 +1、入庫・台帳・割当・受取は動かさない |
| 6 | **受け取り**（Task 7）`private.admin_receive_purchase_order(_purchase_order_id uuid, _expected_version integer, _received_on date, _memo text, _lines jsonb, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{receiptId, version, allocatedQuantity, replayed}`）と public 入口。操作の種類 `purchase_order_receive`。権限は `admin.receiving.manage` ＋ `admin.purchase_orders.read`。ロック helper は `_with_inventory = true`（鍵 → 発注書の行の variant を鍵の後に読む → 在庫の閉包 → 発注書 → 明細）。`_lines` は `[{lineId, quantity 1〜99999}]`（各要素は2項目ちょうど、1〜100件・lineId の重複なし）。順は **引数の検証 → ロック → 権限 → 指紋と再送 → 存在（P0002）→ 段階（数量確定前は `GROUP_G_PO_NOT_CONFIRMED`／55000）→ 版 → 受取日（発注日から今日・日本時間。`GROUP_G_PO_RECEIVED_ON_INVALID`／22023）→ 行が当発注書の物か（22023）と未納以下か（`GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING`／23514）→ 書込み**。書込みは 状態の保存（`capture_group_g_item_states`）→ `app.group_g_operation_id` を設定 → 受取（`receive`）→ 行（lineId 昇順）ごとに台帳 `restock`（+q・備考「発注 PO-… の受け取り」・**無タグ**）・受取行・納品済み +q・行の版 +1 → 発注書の版 +1 → `allocate_group_g_fifo`（受け取った variant だけ）→ 状態の履歴（理由 `purchase_order_receive`）→ 操作の記録 → `app.group_g_operation_id` を戻す（失敗でも戻す。G-1 の形）。備考の日本語は、この移行が ASCII のみなので `U&'\XXXX'` の文字の列で組む |
| 7 | **受け取りの取消・数量訂正**（Task 7。同じ操作）`private.admin_reverse_purchase_order_receipt(_purchase_order_id uuid, _expected_version integer, _receipt_id uuid, _lines jsonb, _reason text, _expected_release_quantity integer, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{receiptId, version, releasedQuantity, replayed}`）と public 入口。操作の種類 `purchase_order_receipt_reverse`。権限と鍵は受け取りと同じ。`_lines` は `[{receiptLineId, quantity 1〜99999}]`。理由が必須（`GROUP_G_PO_REASON_REQUIRED`／22023、引数検証の段。外す割当が0でも必須）、`_expected_release_quantity` は NULL か 0 以上。検査は全て書込みの前: 存在 → 版 → 受取が当発注書の `receive` か（22023）→ 各行が当受取の正の行か（22023。相殺の行は不可）→ 取り消す数 ≤ 取り消せる数（`GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED`／23514）→ variant ごとに 取り消す数 q ≤ 空き在庫 F ＋ 外せる支払い済みの割当 A（`GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT`／23514。仮確保は外さず数えない）→ 外す点数 n ＝ variant ごとの max(q − F, 0) の合計が 0 でないのに確認の数が無い・違う時 `GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED`／55000（`DETAIL` は `{"releasedQuantity": n}`。G-1 の `admin_record_stock_movement` と同じ判定式）。書込みは G-1 の減らし方: 相殺の受取（`reverse`・日本時間の今日・理由）→ 行（receiptLineId 昇順）ごとに空き在庫の次に支払い済みの割当を新しい注文から外す（割当の残りと版、台帳 `allocation_release`〔+n・タグ付き・注文と明細つき・備考＝理由〕、割当イベント `release`〔理由 `stock_adjustment`〕）→ 台帳 `adjustment`（−q・無タグ）・負の受取行（相殺元つき）・納品済み −q・行の版 +1 → 発注書の版 +1 → FIFO（余りが無いので0点）→ 状態の履歴（理由 **`stock_move`**。G-1 の在庫を減らす操作と同じ値。計画の `stock_adjustment` 案より G-1 との一致を優先）→ 操作の記録。外れるのは未発送の割当だけ（消費された数量は `remaining_quantity` に残らない） |
| 8（Task 8） | **取引書類の原本**（FREQ-530）の3関数と public 入口。どれも発注書・在庫・台帳・割当・注文を読みも書きもせず、書くのは予約・添付・版の表と `private.group_g_operations` だけ（追記だけで、UPDATE・DELETE は無い）。処理の順は 引数の検証（`22023`）→ ロック helper（`ARRAY[発注書]`・在庫を動かさない）→ 権限（`admin.purchase_orders.manage` ＋ `read`）→ 指紋と再送・衝突（`23505`）→ 存在（`P0002`）→ 業務規則 → 書込み → 操作の記録。置き場は一切使わない（検査済みの種類・大きさ・ハッシュは呼び手が渡す）。通貨は JPY 固定（列は3文字の英大文字を許す）。(a) `private.admin_reserve_purchase_order_attachment(_purchase_order_id uuid, _kind text, _file_name text, _replaces_attachment_id uuid, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{reservationId, storagePath, expiresAt, replayed}`）: 操作の種類 `purchase_order_attachment_reserve`。種類は quote・invoice、ファイル名は前後の空白を落として1〜255字で制御文字なし、拡張子は pdf・jpg・jpeg・png（大小は問わず保存キーでは小文字。他は `22023`）。保存キー `<発注書の id>/<gen_random_uuid()>.<拡張子>`、`expires_at = now() + 24時間`。差し替えの予約だけ `_replaces_attachment_id`（NULL は新しい書類）を取り、存在の確かめの後に、その発注書の添付でなければ `GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID`／22023（予約も操作の記録も残らない）、合えば予約の行の `replaces_attachment_id` に残す。指紋にも入る（同じ要求番号で差し替え元が違えば `23505`）。(b) `private.admin_attach_purchase_order_document(_reservation_id uuid, _purchase_order_id uuid, _mime_type text, _size_bytes bigint, _sha256 text, _sha256_source text, _transaction_date date, _amount_yen bigint, _currency text, _counterparty text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{attachmentId, revisionNo: 1, replayed}`）: 操作の種類 `purchase_order_attachment_attach`。種類は PDF・JPEG・PNG、大きさ 1〜20971520、`sha256` は64桁の小文字、`sha256_source` は browser／server、取引日は2000-01-01以降の有限の日付、金額は0〜99999999999、取引先は1〜100字（他は `22023`）。予約が当発注書の物でなければ `GROUP_G_PO_DOCUMENT_RESERVATION_INVALID`／55000、すでに添付に結ばれていれば `GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED`／55000。差し替え元は引数で受けず、予約の `replaces_attachment_id` を版1へ写す（頁を読み直した後の再開でも変わらない）。予約の期限は見ない（期限切れでも確定できる）。添付（種類・原ファイル名・保存キーは予約から）と版1（`replaces_attachment_id` は版1だけ）を追記する。(c) `private.admin_revise_purchase_order_document(_attachment_id uuid, _purchase_order_id uuid, _transaction_date date, _amount_yen bigint, _currency text, _counterparty text, _voided boolean, _reason text, _actor_id uuid, _request_key uuid) RETURNS jsonb`（`{attachmentId, revisionNo, replayed}`）: 操作の種類 `purchase_order_attachment_revise`。理由が必須（`GROUP_G_PO_REASON_REQUIRED`、201字以上は `22023`）、前の版と同じ内容・他の発注書の添付・存在しない添付は `22023`、`revision_no` は最大＋1。3本とも private 本体も public 入口（`LANGUAGE sql SECURITY INVOKER`）も `PUBLIC`・`anon`・`authenticated`・`service_role` を個別に REVOKE してから `service_role` だけに EXECUTE を付ける。指紋は 操作・対象・全ての入力・実行者（版は無い）。原因は `purchase_order`＝発注書の id |
| 8（一覧。旧 8） | `private.group_g_writer_allowlist()` を置き換える（`CREATE OR REPLACE`。署名・所有者・ACL は同じ）。G-1 の56本は1文字も変えず、`private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)`（Task 4）、続けて Task 6 の `private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)`・`private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)`・`private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)` を足した60本に、Task 7 の `private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)`・`private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)` を足した62本に、Task 8 の `private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)`・`private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)`・`private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)` を足した**65本**（9本とも `private.group_g_operations` へ書く書き手で、public 入口は private 本体へ委ねるだけ。受け取りの2本は台帳・割当・受取の表にも書く。原本の3本は予約・添付・版の表にだけ書く）。G-2 で書き手の一覧は65本で閉じており、増やす時は末尾の確かめと構造の試験も一緒に直す |
| 9 | 末尾の確かめ（`GROUP_G_MIGRATION_ASSERTION_FAILED`／55000、`DETAIL` が項目名）。`$g2b_final_objects$`: 19関数（ロック helper と、作成・訂正・確定・打切り・受け取り・受け取りの取消・原本の予約・原本の確定・原本の訂正の private 本体と public 入口）の存在・所有者・`SECURITY DEFINER` か INVOKER か・言語・戻り型・引数名・`search_path` 空・anon／authenticated／PUBLIC〔有効な ACL で見る〕が EXECUTE できないこと・service_role の EXECUTE（`purchase_writer_functions`）、ロック helper の本体で鍵が在庫の閉包と `FOR UPDATE` より先にあること（`purchase_writer_lock_order`）、一覧の65本が全て関数に解決すること（`purchase_writer_allowlist_missing`）、一覧が期待の65本と同じ集合であること（`purchase_writer_allowlist`）、この19関数の名前の関数が public・private に他に無いこと〔余分な overload と欠け。per-function の EXECUTE の確かめと合わせて、service_role が EXECUTE できるのは書込みの本体9本と入口9本だけ〕（`purchase_writer_function_set`。Task 9）。`$g2b_final_table_acl$`: 書き込む8表（`purchase_orders`・`purchase_order_lines`・`purchase_order_revisions`・`purchase_order_short_closures`・`purchase_order_receipts`・`purchase_order_receipt_lines`・`purchase_order_attachment_revisions`・`private.group_g_operations`）の権限を意味で比べ、postgres は全権限、PUBLIC・anon・authenticated・service_role は列の権限も含め無し、PostgreSQL 17 以降は `MAINTAIN` も「無い」の一覧に入れる（`purchase_writer_table_acl`）。違えば全部戻る。続けて `NOTIFY pgrst, 'reload schema'`、`COMMIT` |

- **発注番号**: `PO-` ＋ 日本時間（`Asia/Tokyo`）の `YYYYMMDD` ＋ `-` ＋ 4桁の連番。連番は同じ日の最大＋1で、共通の鍵の下で採り、`purchase_orders.number` の UNIQUE が守る。別の日の番号は数えない。9999 を超えると `GROUP_G_PO_NUMBER_EXHAUSTED`／55000 で何も残さず止まる（窓口は固定の500）。
- **冪等**: 操作の種類 `purchase_order_create`・原因 `purchase_order`＝新しい発注書の id。指紋は `{operation, supplier_name, memo, lines〔variantId 昇順〕, actor_id}` の SHA-256。同じ要求番号・同じ指紋は保存した結果に `replayed: true` を足して返し、指紋が違えば `GROUP_G_REQUEST_KEY_CONFLICT`／23505。権限の確かめは再送の判定より先なので、権限の無い人には再送の結果も見せない。Task 6 の3本も同じ規則（原因＝書き換える発注書の id）で、指紋は 操作・発注書の id・内容・理由・実行者の SHA-256 で**版を含めない**（版が進んだ後に古い版で再送しても保存した結果を返す。再送の判定は存在と版の確かめより先）。
- **在庫を動かすのは Task 7 の2本だけ**: 作成と Task 6 の3本は在庫・割当・台帳・状態の履歴・注文を読みも書きもしない（読むのは variant・商品・色・サイズ・発注書・操作の受付だけ。Task 6 の3本は発注書・明細・履歴・打切り・操作の受付だけを書き、受取や台帳は読みもしない）。受け取りとその取消（Task 7）だけがロック helper の `_with_inventory = true` を使い、台帳（`restock`・`allocation_release`・`adjustment`）・割当・割当イベント・状態の履歴・受取・受取行を書く。受け取りの台帳は**無タグ**（付けると G-1 の整合の trigger が一致する割当イベントを求めて `GROUP_G_ALLOCATION_BOUNDS` で落ちる）で、タグが付くのは FIFO の `purchase` 行と、取消が外す `allocation_release` だけ。
- **適用の順**: 常に基盤の移行の後（ファイル名が後ろ）。基盤が先に当たっていないと、この移行は表が無くて関数の末尾の確かめで止まる。

### 適用の手順と確認（Task 9 で完成）

**2 本の移行**（常にこの順。どちらも先頭の `BEGIN;` と末尾の `COMMIT;` を1組だけ持ち、UTF-8・BOMなし・LF・ASCII のみ。全角空白・NBSP・CR は無い）:

| 順 | ファイル | バイト数 | MD5 |
| --- | --- | --- | --- |
| 1 | `supabase/migrations/20261024153505_group_g2_purchasing_foundation.sql` | 121,715 | `5248d3da2923b2476f79b6be1c42acca` |
| 2 | `supabase/migrations/20261024180500_group_g2_purchasing_writers.sql` | 106,412 | `b4813a3fb1a2c360264b02d6a441214b` |

バイト数と MD5（小文字）は 2026-10-25 の適用前の固定で計り直した値（Task 9 の書き上がりから変わっていない。BOM・CR・全角空白・NBSP は0、トップレベルの `BEGIN;`・`COMMIT;` は各1）。以後ファイルを変えたら検証からやり直す。1 本あたり 100,000 バイトの目安は Task 3 で外した（MCP の `apply_migration` の上限のための目安で、本番は CLI がファイルごとに1つの取引で当てる。G-1 の移行は 528 KB で通った）。

**当て方（本番）**: 適用の直前の読み取りで (1) 本番の移行の台帳の末尾が `20261023211425` であること、(2) `storage.buckets` に `purchase-order-documents` が無いこと（あれば設定が同じこと）、(3) 認証・会計の公開関数11本の EXECUTE が `postgres`・`service_role` だけであることを確かめ、(4) 次の段落の名前の衝突の読み取りが 0 を返すことを確かめ、`npx supabase db push --linked` で2本を順に当てる。各ファイルは1つの取引で、**末尾の確かめが1つでも落ちるとそのファイルは巻き戻り**（`GROUP_G_MIGRATION_ASSERTION_FAILED`／55000、`DETAIL` は項目名だけ）、2本目は当たらない。データを変える文は無く、本番の変更は新しい表・関数・トリガー・方針・置き場の1行・書き手の一覧の置き換え・11関数の権限を狭める REVOKE（本番では何も変わらない）だけ。

**適用前の名前の衝突の読み取り（読み取りだけ。G-2 の前は 0 になる）**: 2本の移行は関数を `CREATE FUNCTION`（`OR REPLACE` なし）で作り、末尾の確かめは名前で関数の集合を比べる。本番にだけある同じ名前の関数（別の引数の型の過負荷を含む）があると、2本目まで流してから落ちるか、集合の確かめで落ちる。基盤の移行が作る10名（`group_g_actor_has_permissions`・`group_g_open_work_order_ids`・`purchase_order_display_stages`・`guard_group_g_purchase_order_change`・`check_purchase_order_receipt_line`・`check_purchase_order_line_received`・`list_admin_inventory`・`list_admin_purchase_order_lines`・`get_admin_purchase_order`・`search_purchase_order_documents`）と、書込みの移行が作る10名（`lock_group_g_purchase_orders`・`admin_create_purchase_order`・`admin_update_purchase_order_header`・`admin_confirm_purchase_order_quantities`・`admin_short_close_purchase_order`・`admin_receive_purchase_order`・`admin_reverse_purchase_order_receipt`・`admin_reserve_purchase_order_attachment`・`admin_attach_purchase_order_document`・`admin_revise_purchase_order_document`）が、`public` と `private` に1つも無いことを、適用の直前に次で数える（0 以外なら適用を止めて、本番にある関数の定義を調べる）。

```sql
SELECT count(*) AS existing_g2_functions
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'private')
  AND p.proname IN (
    'group_g_actor_has_permissions', 'group_g_open_work_order_ids', 'purchase_order_display_stages',
    'guard_group_g_purchase_order_change', 'check_purchase_order_receipt_line', 'check_purchase_order_line_received',
    'list_admin_inventory', 'list_admin_purchase_order_lines', 'get_admin_purchase_order', 'search_purchase_order_documents',
    'lock_group_g_purchase_orders', 'admin_create_purchase_order', 'admin_update_purchase_order_header',
    'admin_confirm_purchase_order_quantities', 'admin_short_close_purchase_order', 'admin_receive_purchase_order',
    'admin_reverse_purchase_order_receipt', 'admin_reserve_purchase_order_attachment', 'admin_attach_purchase_order_document',
    'admin_revise_purchase_order_document');
```

この数は適用の前だけの確かめで、適用の後は 0 にならない。適用後の関数の集合は、末尾の確かめ（`foundation_function_set`・`purchase_writer_function_set`）が OID まで見る。

**末尾の確かめは環境によらない**: 局所で作られる名前（自動の制約名など）を使わず、制約・トリガー・索引は名前で、ACL は意味で（`has_function_privilege`・`has_table_privilege`・`aclexplode`。`proacl` が NULL の既定には PUBLIC が含まれるので有効な ACL で見る）、PostgreSQL 17 の `MAINTAIN` は版（`server_version_num >= 170000`）で守って比べる。本番に別の grantee（`supabase_admin` など）が付いていても通る。9表に「この取引が書いた行」が無いことの確かめ（`purchase_table_rows`）は、行の `created_at` が今の取引の開始時刻と同じ物だけを数える（この移行はデータを書かないので、別の取引が後で確定した行までは数えない。確かめを後から流し直しても通る）。

**適用の後の確認**: `db reset` で作った DB と本番で、次を流して通ること。
- 末尾の確かめの節（`-- G2A_FINAL_ASSERT_BEGIN`〜`END`、`-- G2B_FINAL_ASSERT_BEGIN`〜`END`）をそのまま流し直すと通る（`tests/integration/db/group_g2_migration_asserts.integration.test.ts` が、取引の中で関数を落とす・EXECUTE を変える・トリガーの名前を変える・書き手の一覧を変える、のそれぞれで項目名つきで止まることまで確かめる）。
- 書き手の閉じた一覧は65本（G-1 の56本＋新9本）で、`private.group_g_writer_allowlist()` が固定の65本と OID まで同じ。pg_proc の走査（`group_g1_writer_inventory`）は、発注書の9表を含む16表への書込みを持つ関数が、この65本の中だけにあることを見る。
- service_role が EXECUTE できる発注書の関数は、書込みの本体9本とその public 入口9本、読取の本体4本とその入口4本の26本だけ。ロック helper `lock_group_g_purchase_orders`・`group_g_actor_has_permissions`・`group_g_open_work_order_ids`・`purchase_order_display_stages` は誰にも EXECUTE を付けない。anon・authenticated・PUBLIC は全関数で持たない。
- 9つの書込み関数のそれぞれが共通の鍵 `(190521,1)` を、発注書の表・`item_variants`・`stock_movements` への最初の参照より前に取る（`group_g1_writer_inventory`）。別接続の並行は `group_g2_concurrency`（各関数が鍵だけを別接続が持つ間は行の鍵を取らず待つこと、受け取り対受け取り・入荷・入金・返金の受理・数量確定・残りの打切り・取消対入金／FIFO／棚卸減で deadlock が無く二重に動かないこと）。この試験が commit した材料（発注書・受取・注文、原本の予約・添付）は追記専用なので残り、DB 結合の他の試験は自分の発注書の id か番号に絞って確かめる（局所の DB を `db reset` しなくても、続けて何度流しても通る）。

**先絞りの索引（Task 1 の確かめ直しで残った点）**: `group_g_open_work_order_ids` の発送済みの注文ごとの合計が引く列（`order_fulfillment_lines.order_item_id`・`order_refund_lines.order_item_id`・`order_items.order_id`・`order_item_allocations.order_item_id`・`order_returns.order_id`〔`(order_id, number)` の一意制約の先頭〕・`order_refunds.order_id`・`order_cancel_requests.order_id`、結合は主キー）には、先頭の列が全行を覆う索引がすでにある。**新しい索引は足さない**（`group_g2_g1_followups` が、これらの索引が先頭の列に残っていることを確かめる）。実測（2026-10-25、手元の DB で取引の中に作って戻した材料: 注文 30,490・明細 60,511・発送の明細 60,045・返金約 6,000）: variant を絞った読み（`list_group_g_variant_inventory` の経路）は 27 ms で、発送の明細の合計・返金の明細の合計・注文の明細・注文の主キーのどれも索引走査（`order_fulfillment_lines_order_item_idx`・`order_refund_lines_item_idx`・`idx_order_items_order_id`・`order_items_variant_id_idx`・各主キー）。逐次走査になったのは件数が数十行の表（返品・取消申請）だけ。全 variant の読み（`list_admin_inventory` の経路、NULL）は 166 ms で、注文・明細・発送の明細を各1回ずつ走査する（全件を見る読みなので避けられない）が、行ごとの合計は索引走査のまま（60,511 回）。返金の表が小さい（数十行）間は計画が逐次走査を選ぶが、約 6,000 行では `order_refund_lines_item_idx` を使う。

### 本番適用の記録（2026-10-25）

| 段 | 結果 |
| --- | --- |
| 適用前の読み取り（MCP、読み取りだけ・件数だけ） | 台帳の末尾 `20261023211425`、G-2 の版・9表・置き場は無し。`role_permissions` は店長30・サポーター8（G-0／G-1 の記録と同じ）。注文0・明細0・台帳0・variant 21・在庫の合計0（G-1 の清掃の後のまま）。`storage.objects` の方針は0件。G-2 の20の名前の関数は0。anon・authenticated・service_role の役割の所属は無し。11関数は anon・authenticated・PUBLIC が EXECUTE できず service_role だけ（Task 1 の REVOKE は本番では何も変えない） |
| 置き換える関数の照合 | `admin_record_stock_movement`（public・private）・`list_group_g_variant_inventory`（public・private）・`private.guard_group_g_paid_at()` の5つの `pg_get_functiondef` の MD5 が、本番と手元で G-1 まで当てた DB（`db reset --version 20261023211425`）で全部一致 |
| ファイルの固定 | 基盤 121,715 バイト・`5248d3da2923b2476f79b6be1c42acca`、書込み 106,412 バイト・`b4813a3fb1a2c360264b02d6a441214b`。BOM・CR・全角空白・NBSP は0、トップレベルの `BEGIN;`・`COMMIT;` は各1 |
| 適用 | `supabase migration list --linked` で本番に無いのは G-2 の2本だけ、`db push --linked --dry-run` も2本だけ（seed・役割なし）を確かめ、`db push --linked --yes` で基盤・書込みの順に適用（2026-10-25 12:39 JST、パスワードの入力なし） |
| 当てた文の照合 | `20261024153505`: 文 137・`md5(array_to_string(statements, E'\n'))` `14ececdfee43e8d464349c2150d72a45`。`20261024180500`: 文 81・`e2cfbddd720d2f18a5eac48949efe1f9`。本番と手元の `db reset` の履歴で一致 |
| 適用後の形の照合（本番と手元で同じ値） | 発注書の9表（RLS・強制 RLS・anon／authenticated／service_role の表の権限）、方針9、トリガー30、public 186・private 175 の関数（定義〔CR を除く〕・`SECURITY DEFINER`・設定・3役割の EXECUTE）の指紋が全部一致（G-0／G-1 の既存の関数は置き換えた3つ以外変わらず、前回の記録の「本番だけ ACL が狭い11関数」の差も無くなった）。置き場 `purchase-order-documents` は非公開・20,971,520 バイト・PDF／JPEG／PNG。書き手の一覧 65本。`role_permissions` は店長30・サポーター8 のまま |
| 適用後の件数 | 発注書の9表・置き場の物はすべて0。注文0・台帳0・在庫の合計0（データを変える文は無い）。本番で試験の発注書は作っていない |

### 試験

DB 結合は `group_g2_stock_permissions`・`group_g2_g1_followups`・`group_g2_public_function_acl`・`group_g2_purchase_model`・`group_g2_inventory_list`（Task 3）・`group_g2_purchase_create`（Task 4）・`group_g2_purchase_reads`（Task 5）・`group_g2_purchase_quantities`（Task 6）・`group_g2_purchase_receipts`・`group_g2_purchase_receipt_reversals`（Task 7）・`group_g2_purchase_documents`（Task 8）・`group_g2_concurrency`・`group_g2_migration_asserts`（Task 9）の13本（共通の確認は `db reset` の後に PostgREST の smoke → 上の13本と、`admin_revoke_sessions_function`・`auth_db_functions`・`rate_limit_counters`・G-1 の `group_g1_stock_api`・`group_g1_inventory_reads`・`group_g1_payment`・`group_g1_exchange_fee`・`group_g1_concurrency`・`group_g1_fifo`・`group_g1_model`・`group_g1_writer_inventory`・`stock_movements`）。対応は[試験仕様](../05_Quality/tests/test-spec.md)の「グループ G-2 のテスト」。
