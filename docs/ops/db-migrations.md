# DB マイグレーション運用

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
