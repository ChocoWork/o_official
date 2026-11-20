# パスキーの移行を本番に当てる手順書

> 状態: 手順（本番には何も当てていない。当てるのは調整役だけで、オーナーの許可を得た時だけ） | 確認日: 2026-11-20 | 対象: `supabase/migrations/` のパスキーの移行 A〜I の9本、ダッシュボードの設定、アプリのデプロイ、定期処理 | 設計: [パスキー設計](../superpowers/specs/2026-11-07-passkey-auth-design.md)（8-1・8-2）、計画: [段3b の計画](../superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md)（Task 23）

## 概要

この手順書は、パスキーの移行9本（A〜I。J は無い。2026-11-19 にオーナーが、GoTrue を直に叩く鍵の削除の穴を認めた＝22b は行わない）を本番へ当てる順・確かめ・戻し方を1か所にまとめる。各移行の中身と手元の確認は [db-migrations.md](./db-migrations.md) の各節が正本で、ここはそれを順に流すための手順にする。

- 当てるのは調整役だけで、**オーナーの許可を得た時だけ**。本番へ向けて流す SQL・操作には「調整役がオーナーの許可を得てから」と書く。書いていない SQL は読むだけの `select`。
- 移行は Supabase の MCP の `apply_migration` で1本ずつ当てる。`supabase db push`（どの形でも）と `workflow_dispatch` は流さない。
- 本番の独自のドメインが決まるまで、1本も当てない（オーナー決定 2026-11-16・2026-11-19）。
- この master を、手順の途中でアプリとして本番にデプロイしない。デプロイは節2の決まった位置で行う（店員のパスワード＋TOTP の入り方は、この master のアプリと移行・フックで止まる）。

## 1. 前提（全部そろうまで1本も当てない）

次の9つが全部そろっていること。1つでも欠けたら止めて報告する。

1. 本番の独自のドメイン・`rp_id`・`rp_origins` が決まっている（後から変えると全員のパスキーが使えなくなる）。
2. 本番の GoTrue が v2.196.0 である（違えば、設計の試し T1〜T7 の前提を見直す）。
3. Passkeys が、今のプランでダッシュボードから有効にできる。
4. `postgres` の権限が足りる。本番で次を読み、全部 `true` であること（読むだけ）。
   ```sql
   select has_table_privilege('postgres','auth.webauthn_credentials','TRIGGER') as webauthn_trigger,
          has_table_privilege('postgres','auth.webauthn_credentials','SELECT')  as webauthn_select,
          has_table_privilege('postgres','auth.webauthn_credentials','DELETE')  as webauthn_delete,
          has_table_privilege('postgres','auth.mfa_factors','DELETE')           as mfa_delete,
          has_table_privilege('postgres','auth.users','UPDATE')                 as users_update,
          has_table_privilege('postgres','auth.sessions','SELECT')              as sessions_select,
          to_regclass('auth.webauthn_credentials') is not null                   as webauthn_table,
          to_regnamespace('extensions') is not null                              as extensions_schema;
   ```
   C の前の確かめが `TRIGGER`、A の関数が `SELECT`、H の前の確かめが `DELETE`・`UPDATE`・`SELECT` を見る。
5. **店長にする人のアカウントが本番にある**。無ければ、ダッシュボードの Authentication で、パスワード無し・メール確認済みで作る（**調整役がオーナーの許可を得てから**。最初の店長の手順は節2の5と [最初の店長と店長本人の最後の手段の手順書](./passkey-staff-recovery.md)）。
6. `Sb-Forwarded-For` の運用が決まっている（[supabase-auth-config.md](./supabase-auth-config.md) の「パスキーのログインの始めと `Sb-Forwarded-For`」）。
7. 本番の `ops_job_heartbeats_job_check` を、ほかの移行が変えていないか見られる（I の行の前の確かめ）。
8. **普段の開発（`npm run dev`）が手元の Supabase を向いている**（設計 4-3。2026-11-08 に切り替え済みだが、`.env.development.local` がずれていないか、オーナーに確認日を聞いて確かめる）。本番の DB に当てると、本番を向いた開発の画面では店長が管理画面に入れなくなる。
9. **既存の店員の TOTP の要素の扱いが決まっている**（設計 8-1・6-2）。H の招待の取引は、招待された人の `auth.mfa_factors` だけを消す。招待・やり直しをしない既存の店員の TOTP の要素は残る（パスワードは使えなくなるので入れないが、要素が残る）。移す時に全部消すか（読むだけで数を見る。有効で期限内の `admin`・`supporter` の役割の人の TOTP の要素を、人数と本数で数える: `select count(distinct f.user_id) as users, count(*) as factors from auth.mfa_factors f where f.factor_type = 'totp' and exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = f.user_id and r.code in ('admin', 'supporter') and ur.active and (ur.expires_at is null or ur.expires_at > now()));`）、各店員を招待かやり直しで入り直させて消すかを決める。消すのも**調整役がオーナーの許可を得てから**。

## 2. 当てる順

1. A → B → C → D → F → G → H → **I** を、**1本ずつ**当てる（節3の表）。1本当てるたびに、節3の突き合わせを済ませてから次へ進む。
   - **H は G の列に依存する**。**G の前に H を当てない**（H の前の確かめが G の3列 `lease_token`・`last_error_code`・`finished_at` を見て、無ければ `passkey_h_g_columns` で止まる）。H は F の関数 `passkey_is_staff` も使うので、F の後。
   - I は A と G の後。
   - C は本番の `postgres` が `TRIGGER` を持つこと（節1の4）が前提。
2. ダッシュボードで、Passkeys の有効化と RP（`rp_id`・`rp_origins`）を設定する。次に、**B を当てた後で** Custom Access Token フック（`public.passkey_access_token_hook`）を登録する（B より先に登録すると、全員のログインが止まる）。手順は [supabase-auth-config.md](./supabase-auth-config.md)（**調整役がオーナーの許可を得てから**）。
3. アプリをデプロイする（**調整役がオーナーの許可を得てから**）。**D はデプロイの前**に当てておく（アプリの `admin-rbac` が `staff_idle_check` を呼ぶ。A も同じ）。
4. `supabase/pending/schedule_stripe_webhook_worker.sql` を、新しい版の移行として当てる（`supabase/pending/README.md` の手順。**アプリのデプロイの後**。登録した時点から入口が毎分呼ばれる。死んだ知らせの点検と worker の心拍は、この毎分の入口の終わりで動くので、I はこの前に当てておく）。
   - **これは Stripe の webhook の worker も本番で動かし始める**。開店の準備の行3の保留の定期処理4本と一緒に、オーナーと決める。
   - 前提は Vault の `cron_secret`・`app_base_url`（名前の存在だけを確かめ、値は見ない）。
   - 戻し方 (1)「定期処理とアプリを止める」と対になる。
   - **調整役がオーナーの許可を得てから**。
5. 最初の店長（[手順書](./passkey-staff-recovery.md)。関数 `private.staff_invite_issue_manual` で招待を出す）が、パスキーを2本登録して役割が有効になる。これで「認めた鍵が2本の店員」が出来る。
6. **E は最後に当てる**（調整役がオーナーの許可を得てから）。E の前の確かめが止まるのは、**有効な店員がいるのに、認めた鍵が足りる店員が1人もいない時だけ**。有効な店員が1人もいない時は止まらずに通る（誰も権限を持たない状態で当たる）。だから、最初の店長が有効な `admin` で認めた鍵2本以上であることを、E の前に次の読むだけの SQL で必ず確かめる（1行以上返り、`approved` が `required` 以上。`required` は設定の最小の本数で、E の確かめと同じ式で読む）。
   ```sql
   select ur.user_id, public.passkey_approved_count(ur.user_id) as approved,
          (private.passkey_staff_settings() ->> 'min_approved_passkeys')::integer as required
     from public.user_roles ur join public.roles r on r.id = ur.role_id
    where r.code = 'admin' and ur.active and (ur.expires_at is null or ur.expires_at > now());
   ```
   **E は権限を奪う側**（`has_permission` を切り替え、全員の管理の権限をパスキーの入り方だけに絞る）なので、他の物と一緒に「害の無い物」に入れない。当てたら、最初の店長が `/admin` に入れることを確かめる。
7. TOTP を止める（ダッシュボード。**調整役がオーナーの許可を得てから**）。戻す時は節4の (2b)。

## 3. 1本ごとの手順の表

当て方（A〜I 共通。**調整役がオーナーの許可を得てから**）。

1. 「前の確かめ」の SQL（読むだけ）を流し、期待どおりであること。
2. MCP の `apply_migration` を、`name` をファイル名から版を除いた部分（例 `passkey_foundation_tables`）にして呼ぶ。内容はファイルの全文。
3. 当てた後に、次を読む（読むだけ）。
   ```sql
   select version, name, md5(statements[1]), array_length(statements, 1) as n_statements from supabase_migrations.schema_migrations where name = '<name>';
   ```
4. **突き合わせ**: `md5(statements[1])` を**ファイルの MD5**（下の表）と比べる。
   - MCP の `apply_migration` で当てると、本番はファイル全体を1つの文として記録する。だから `n_statements` は1で、`statements[1]` の MD5 はファイルの MD5 と同じになる（`n_statements` が1でなければ、この前提が崩れているので止める）。
   - **手元の `db reset` の値とは比べない**。手元は CLI が文を分けて記録するので `md5(statements[1])` が別の値になる（各節の「手元の値（参考）」）。
   - 違えば、当てる途中で字が変わっている（全角の空白など）。止めて報告する。
5. ファイルの名前を、当てた版に付け替える（[db-migrations.md](./db-migrations.md) の「MCP の apply_migration で当てた場合」と同じ）。付け替えると手元の順は当てた順（A→…→I→E）になる。**間に作った移行が passkey の物に依存していないか**を、付け替えの後の `db reset` で確かめる。
   - **付け替えたら、古いファイル名と古い版への参照を全部そろえる**（会計の移行の前例 Ruling T15b-apply。[db-migrations.md](./db-migrations.md) の「付け直したら、ファイル名を固定で書いた試験と文書の参照も同じ版にそろえる」）。`grep -rn <古い版> tests e2e src docs scripts` を流し、該当を全部、同じコミットで新しい版に直す。ファイルを名前で読む結合試験（`tests/integration/db/auth_passkey_*` と `auth_has_permission_passkey*` の `readFileSync`）、`src/lib/auth/staff-passkey-*.ts` の注釈、`db-migrations.md` の各節が該当する。直した後に、その結合試験を `--runInBand` で流す。
6. 前の確かめで途中で止まったら、止めて、すでに当てた物は戻さない（単独で権限を奪わない物から先に当てる順にしてあるため）。

大きさと MD5 は、2026-11-20 に `wc -c`・`md5sum` で測った値（LF・BOM なし・ASCII だけ）。`db-migrations.md` の各節の値と全部一致した。

| 順 | ファイル | 大きさ | MD5 | 単独で権限を奪うか | `name` |
| --- | --- | --- | --- | --- | --- |
| 1 | `20261116215034_passkey_foundation_tables.sql`（A） | 14424 | `dc73b6e294108890433058b56d2c70dc` | 奪わない（表と関数を足すだけ） | `passkey_foundation_tables` |
| 2 | `20261116230000_passkey_access_token_hook.sql`（B） | 8454 | `39fc2e72e8fe8f5bc4a8a6df3f7533d2` | 奪わない（登録するまで効かない） | `passkey_access_token_hook` |
| 3 | `20261116232141_passkey_credential_events.sql`（C） | 8049 | `fd522cc9974488668fc89e70fb371dce` | 奪わない（鍵の足し・消しで知らせと認めを動かす） | `passkey_credential_events` |
| 4 | `20261117001500_passkey_staff_entry_conditions_fn.sql`（D） | 16750 | `b50ea103050e223af93d8ffe1339e0ec` | 奪わない（関数と表を足すだけ。E が呼ぶ） | `passkey_staff_entry_conditions_fn` |
| 5 | `20261117123620_passkey_server_endpoint_fns.sql`（F） | 12085 | `b8b22d4844ac4c51d7744737e650c43c` | 奪わない（関数を足し `passkey_approve` を直す） | `passkey_server_endpoint_fns` |
| 6 | `20261118044338_passkey_notification_sending.sql`（G） | 21265 | `505f615cfbc19562a72799a0b2da3f03` | 奪わない | `passkey_notification_sending` |
| 7 | `20261118130000_passkey_staff_invites.sql`（H） | 47537 | `c871a2bf2f2878590ec271f2cecb9b47` | 奪わない（`admin_set_user_role` が、店員にする変更を今の有効な店員だけに絞る） | `passkey_staff_invites` |
| 8 | `20261119181323_passkey_notification_ops.sql`（I） | 9655 | `33a8d3641f63b311de45c0c0f0c56c6d` | 奪わない | `passkey_notification_ops` |
| 最後 | `20261117013000_passkey_staff_entry_conditions.sql`（E） | 10120 | `24839a6932a684ee47d491cc532806f0` | **奪う**（`has_permission` を切り替える） | `passkey_staff_entry_conditions` |

ファイルの一覧は `ls supabase/migrations | grep passkey` と同じ9本。版の昇順は A, B, C, D, E, F, G, H, I で、**E は版では D の次だが、当てるのは最後**（表の最後の欄）。

### 前の確かめ（読むだけ。期待どおりでなければ当てない）

**A**
```sql
select to_regclass('private.passkey_staff_config');   -- 期待: null
select to_regclass('auth.webauthn_credentials');       -- 期待: null でない
```

**B**
```sql
select to_regprocedure('public.passkey_approved_count(uuid)');   -- 期待: null でない（A）
```

**C**（移行自身も、表が足りない・`TRIGGER` の権限が無い時に `passkey_trigger_precheck`・`passkey_trigger_privilege` で止まる）
```sql
select to_regclass('private.approved_passkeys'), to_regclass('private.passkey_notification_outbox'),
       to_regclass('private.passkey_registration_windows'), to_regclass('public.user_roles');   -- 期待: 全部 null でない
select has_table_privilege('postgres','auth.webauthn_credentials','TRIGGER');                    -- 期待: true
```

**D**（移行自身が、A の関数が無ければ `passkey_entry_precheck` で止まる）
```sql
select to_regprocedure('private.passkey_staff_settings()'), to_regprocedure('public.passkey_approved_count(uuid)');   -- 期待: 全部 null でない
```

**F**
```sql
select to_regprocedure('public.passkey_approve(uuid,uuid,text)');   -- 期待: null でない（A）
select to_regprocedure('public.passkey_is_staff(uuid)');            -- 期待: null
```

**G**
```sql
select to_regclass('private.passkey_notification_outbox');   -- 期待: null でない（A）
select to_regclass('private.order_email_send_pause');        -- 期待: null でない（注文のメールの共有の止め印）
select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox'
  and column_name = 'actor_email';                           -- 期待: 1（A）
select to_regclass('auth.webauthn_credentials');             -- 期待: null でない
```

**H**（**G の後**。G の3列が無ければ `passkey_h_g_columns` で止まる。`admin_set_user_role` の本体は `md5(prosrc)` で釘付け）
```sql
select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox'
  and column_name in ('lease_token','last_error_code','finished_at');   -- 期待: 3（G）
select has_table_privilege('postgres','auth.mfa_factors','DELETE');          -- 期待: true
select has_table_privilege('postgres','auth.webauthn_credentials','DELETE'); -- 期待: true
select has_table_privilege('postgres','auth.users','UPDATE');                -- 期待: true
select has_table_privilege('postgres','auth.sessions','SELECT');             -- 期待: true
select to_regclass('private.staff_invites');                                 -- 期待: null
select md5(prosrc) from pg_proc where oid = 'private.admin_set_user_role(uuid,uuid,text)'::regprocedure;
                                                                             -- 期待: 0cb9f532f16aa5c56c6b425694f7209b
select to_regnamespace('extensions') is not null;                            -- 期待: true
select to_regprocedure('public.passkey_is_staff(uuid)');                     -- 期待: null でない（F）
```

**I**（送り箱の5列・job の一覧を、移行自身が確かめる。**当てる前に、今の job の CHECK を必ず控える**）
```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'ops_job_heartbeats_job_check';   -- 控える（戻し方 (4) が、この定義に戻す）
select to_regclass('private.passkey_notification_outbox');   -- 期待: null でない（A）
select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox'
  and column_name in ('status', 'finished_at', 'last_error_code', 'attempts', 'kind');   -- 期待: 5（A・G）
```
- 控えた定義の job の集合で、I の前の確かめが次のどちらかに分かれる。(a) 既知の8つ（`accounting_post` まで）ちょうど: CHECK を9つに作り直す。(b) すでに `passkey_notification_worker` を含む: NOTICE（`passkey_i_job_check_already_present`）を出して CHECK は触らない。**(b) で当てた時は、戻しでも CHECK を触らない**。
- 上のどちらでもない時は `passkey_i_job_check_drift`（`PASSKEY_MIGRATION_PRECHECK_FAILED`）で止まる。**止まったら、本番の今の job の一覧を読み**（控えた定義）、**I の中の2つの一覧の両方に足す**: (1) 前の確かめの既知の job の集合（`passkey_i_job_check_drift` を出す比べ。**新しい job は字の順の位置に入れる**。比べは `ORDER BY` で並べた配列と、字の順に並べた文字列の配列の一致なので、末尾に足すと同じ止まりをまた起こす）と、(2) 作り直す CHECK の一覧（`passkey_notification_worker` を含む9つ）。片方だけ足すと、前の確かめは通るのに CHECK がその job を含まず、その job の心拍の行が既にあれば ALTER が落ち、無ければ後の心拍の書き込みが落ちる。足したら**大きさと MD5 を測り直し**（調整役）、`tests/integration/db/auth_passkey_notification_ops.integration.test.ts` を `--runInBand` で流し、この表と [db-migrations.md](./db-migrations.md) の I の節を直してから当てる。
- 後で `ops_job_heartbeats_job_check` を変える移行は、`passkey_notification_worker` を一覧に残す。

**E**（最後）
```sql
select md5(prosrc) from pg_proc where oid = 'public.has_permission(text)'::regprocedure;   -- 期待: 3c4826933eca194a3486f430d361891c
select to_regprocedure('private.staff_passkey_amr_ok(jsonb)'), to_regprocedure('private.staff_passkey_count_ok(uuid)'),
       to_regprocedure('private.staff_idle_ok(uuid)');   -- 期待: 全部 null でない（D）
```
- 移行自身が止まるのは、**有効な店員がいるのに、認めた鍵が足りる店員が1人もいない時だけ**（`passkey_entry_switch_no_ready_staff`）。有効な店員が1人もいない時（例: 最後の手段の招待は有効化までは `user_roles.active = false`）は通るので、移行の確かめに頼らず、上の SQL を必ず先に流す。止まったら E は当てない。最初の店長の登録（節2の5）を先に済ませる。

## 4. 戻し方の順（全部の箇所でこの1つ）

**先に知っておくこと**: 戻しは、店員が入る道（パスキー）を外す。H の招待の取引は招待された人の TOTP の要素を消しており、**どの `ROLLBACK` もそれを戻さない**。最初の店長もパスワード無しで作る（節1の5）ので、E まで戻した後の店長は、パスワードも TOTP も無い。だから下の (2b)・(3b) で入る道を作る。

(1) 毎分の定期処理（`process-stripe-webhooks`）を止める（**調整役がオーナーの許可を得てから**。`select cron.unschedule('process-stripe-webhooks');` は本番を変える SQL）。**再開しない**。本番は今この定期処理が無いので、止めたままが当てる前の状態。続けて、**アプリを、パスキー前のコミットに戻してデプロイする**（**調整役がオーナーの許可を得てから**）。
   - **戻し先は `c336e0b5`**（最初のパスキーのコミット `fd0bafd1` の1つ前。`git log` で `fd0bafd1` の親が `c336e0b5` であることを確かめた。アプリのコードはパスキー前）。**本番には、この master より前のデプロイが無い**（最初のデプロイが節2の3）ので、Vercel の Instant Rollback は使えない。「そのコミットを production にデプロイする」ことが戻しになる。その時点の他の移行・環境変数と合うかを、デプロイの前に確かめる。
   - **最初の本番のデプロイが実際に起きたら、調整役が、その時点の本当の「前のデプロイ」（あれば）をここと台帳に記録し直す**。それまでは、この戻し先は変わりうる。
   - **master を載せたままにしない**: `admin-rbac` は E に関係なくパスキーの `amr` と認めた鍵2本を求めるので、(3b) のパスワード＋TOTP で入れない。さらに (8)・(11) の後は、master の管理の入口が呼ぶ関数（`staff_idle_check`〔D〕・`passkey_approved_count`〔A〕）が無くなり、管理の API は全員 503 になる。(7) の後は F が足した関数（`passkey_is_staff`・`passkey_credential_is_approved`・`passkey_approved_ids`）が無くなり、master の登録・ログインの道（登録の入口の確かめ・パスキーのログインの仕上げ・TOTP の登録）が失敗する（管理の API の 503 ではなく、登録・ログインの失敗）。
   - アプリを戻す時、outbox に新しい種類の行が残っていたら `skipped` にする。
   - **お客さんへの影響**: パスキー前のアプリは、パスワード＋メールのコードの入り方だけ。段2のメールのコードで登録した（パスワードの無い）お客さんは、パスワードの再設定をするまで入れない。戻しが開店後なら、オーナーがこの影響を決めて、お客さんに知らせる。
→ (2) ダッシュボードのフックの登録を外す（**調整役がオーナーの許可を得てから**。外さずに B を戻すと、全員のログインが止まる）。
→ (2b) **TOTP を止めていたら、ダッシュボードの Authentication の Multi-Factor で TOTP を有効に戻す**（**調整役がオーナーの許可を得てから**。手順は [supabase-auth-config.md](./supabase-auth-config.md)）。(3) の後の `has_permission` は `aal2`（TOTP を通ったセッション）を求めるので、TOTP が止まったままだと店長が入れない。
→ (2c) **Passkeys を無効に戻すかを決める**（**調整役がオーナーの許可を得てから**）。外すと全員のパスキーが使えなくなる。ドメインを変えない戻しなら、有効のままでもよい。
→ (3) **E**（`has_permission` を `20261029120100_sec_has_permission_aal2_member_rls.sql` の本体に戻す。D の関数を使わなくなる）。
→ (3b) **店長がまた入る道を作る**（**調整役がオーナーの許可を得てから**）。E を戻した後の店長にはパスワードも TOTP も無い。まず、店長の今の状態を読むだけの SQL で確かめる（`'<店長の id>'` に置き換える）。
   ```sql
   select ur.active, ur.expires_at, u.raw_app_meta_data ->> 'role' as app_role
     from auth.users u
     left join public.user_roles ur
       on ur.user_id = u.id and ur.role_id = (select id from public.roles where code = 'admin')
    where u.id = '<店長の id>';
   ```
   - **`active` が真・`expires_at` が空か未来・`app_role` が `admin`（有効化が済んでいた）**: 古いアプリの入り方がそのまま使える。ダッシュボードで店長のパスワードを設定する（設定できるかをここで確かめる。できなければ**パスワードの再設定のメールを使う**。むしろメールを先に使ってもよい）→ 店長がパスワード＋メールのコードで入り、最初のログインで TOTP を登録し直す（[first-admin-bootstrap.md](./first-admin-bootstrap.md) の最初のログインの TOTP の登録と同じ）→ `/admin` に入れることを確かめる。
   - **上の1つ目に当てはまらないもの**（`active` が偽または空〔`null` = `admin` の役割の行が無い〕・`active` が真でも `expires_at` が過去・`app_role` が `user` など。最初の店長の有効化が済む前に戻した、節2の5の登録が失敗した、など）**: 最後の手段の招待の取引（H の `staff_invite_issue_core`）が、その人の全部の役割の行を `active = false` にし（行が無い新しいアカウントには、行は作られない）、`app_metadata.role` を `user` にしている（さらに TOTP の要素と鍵を消し、招待と窓を開いている）。有効化（`staff_role_activate`）だけがそれを戻す。このままだと古いアプリは、役割を `app_metadata` から読むので TOTP の登録が 403 になり、`has_permission` も偽で、入れない。次の2つのどちらか（**調整役がオーナーの許可を得てから**）。
     1. **取引の逆を流す**（1つの取引。招待と窓も閉じる）。
        ```sql
        begin;
        select pg_advisory_xact_lock(190519, 0);
        update private.staff_invites set cancelled_at = now()
         where user_id = '<店長の id>' and cancelled_at is null and activated_at is null;
        update private.passkey_registration_windows set closed_at = now()
         where user_id = '<店長の id>' and closed_at is null;
        insert into public.user_roles (user_id, role_id, active, expires_at)
        select '<店長の id>', r.id, true, null from public.roles r where r.code = 'admin'
        on conflict (user_id, role_id) do update set active = true, expires_at = null;
        update auth.users set raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{role}', '"admin"'), updated_at = now()
         where id = '<店長の id>';
        commit;
        ```
        これは有効化（H の `staff_role_activate`）が最後に付ける状態と同じ（`active = true`・`expires_at` なし・`app_metadata.role = 'admin'`）。役割の行は、有効化と同じ「無ければ入れ、あれば有効にする」で入れる（衝突の対象 `(user_id, role_id)` は `user_roles` の主キー）。`active` が真で `expires_at` が過去の行も、この SQL が `expires_at` を空にして直す。流した後に上の読むだけの SQL をもう一度流し、`active` 真・`admin` を確かめてから、前の枝のパスワードと TOTP の手順へ進む。
     2. **別のメールで `admin:bootstrap` を使う**（有効な店長が1人もいない時だけ動く。`countActiveAdmins = 0`）。**同じメールでは作れない**（その人の Auth の利用者がすでにあり、`email_taken` で失敗する）。別のアドレスの新しい店長を作り、パスワードを設定して TOTP を登録する。
   - まとめると、場合は3つ。(i) `admin` の役割の行がある（有効なら1つ目の枝、無効なら2つ目の枝）。(ii) 利用者はいるが役割の行が無い（新しく作った最初の店長。2つ目の枝の SQL が行を入れる）。(iii) **利用者がそもそもいない**（作る前に戻した）: `admin:bootstrap` にそのメールを渡して作るか、先に節1の5でアカウントを作る。有効な店長がすでにいる時は `admin:bootstrap` は断る（`admin_exists`）。
   - **H が消した店員の TOTP の要素は、戻しでは戻らない**。ほかの店員も、パスワードの設定と TOTP の登録し直しが要る。
→ (4) **I**（**先に** `delete from public.ops_job_heartbeats where job = 'passkey_notification_worker';` で心拍の行を消す。次に CHECK を、I の前に控えた定義に戻す。(b) で当てて CHECK を変えていない時は触らない。最後に関数2本・索引・列 `dead_notified_at` を `DROP`）。
→ (5) **H**（H は G の列を使うので、G より先に落とす）。
→ (6) **G**。
→ (7) **F**（3つの新しい関数を `DROP`。`passkey_approve` を A の本体に戻す。A の本体は `md5(prosrc)` が `e0b5dc02ecfcb5533cd91a00edc55fe4`・876文字）。
→ (8) **D**（E を戻した後。E の `has_permission` が呼ぶので、E より先に落とすと管理の権限が全部偽になる）。
→ (9) **C**（先に関数を空の `RETURN NULL` だけにする。引き金の削除は `supabase_auth_admin` の手順で、**サポートに依頼**）。
→ (10) **B**（`DROP FUNCTION public.passkey_access_token_hook(jsonb);`。登録を外した後）。
→ (11) **A**（(9) で C の関数を空にする前は、C の引き金が生きている間は A を戻さない。引き金が `approved_passkeys` を消そうとして、鍵の削除がすべて失敗する）。

各移行の戻しは、ファイルのヘッダーの `ROLLBACK`（正本）。**戻しの SQL を本番に流すのは、調整役がオーナーの許可を得てから**。

## 5. 環境変数・Vault（名前だけ。値は文書に書かない）

- Vercel: `SUPABASE_SECRET_KEY`（`sb_secret_` の鍵）、`NEXT_PUBLIC_PASSKEY_START_MODE`（始めの切り替え。(b) にする時は再ビルドが要る）、`CRON_SECRET`、`SHOP_ALERT_EMAIL`（死んだ知らせ・worker の停止の知らせの宛先）、`RESEND_API_KEY`・`MAIL_FROM_ADDRESS`（知らせのメール）、`SUPABASE_SERVICE_ROLE_KEY`・`NEXT_PUBLIC_SUPABASE_URL`・`NEXT_PUBLIC_SUPABASE_ANON_KEY`。
- 本番に置かない: `PASSKEY_START_DEV_IP`（手元の `next dev` だけ。本番とVercel では値があるとビルドと起動が止まる）。
- Vault: `cron_secret`・`app_base_url`（毎分の定期処理が読む。名前の存在だけを確かめる）。
- 名前と使い道の正本: [secrets.md](./secrets.md)。

## 6. 設計 8-2 の確認の表

当てた後（ダッシュボードの設定と、アプリのデプロイの後）に、調整役とオーナーで確かめる。**本番の GoTrue を直に叩く確認（1・2・8）と、本物の Google・本物の拒否を起こす確認（5・9）は、本番に触れる操作なので、**調整役がオーナーの許可を得てから**流す**。外れたら、「外れた時」の列のとおりに直し、記録する。1〜9は[設計 8-2](../superpowers/specs/2026-11-07-passkey-auth-design.md)、10〜12は段2が足した（[supabase-auth-config.md](./supabase-auth-config.md) の「本番の確認の一覧」）。

| 項 | いつ・どの画面 | 期待する結果 | 外れた時 |
| --- | --- | --- | --- |
| 1 | 本番でパスキーを有効にした後。GoTrue を直に（アプリを通さず）叩く | 始めの回数の制限が IP ごとに効く（IP A で31回目が 429、IP B は 200）。手順は supabase-auth-config.md の「有効にする手順」の5 | 添え書きが効かなければ (b)（`NEXT_PUBLIC_PASSKEY_START_MODE=browser`）に切り替える。31回目も 200 なら記録してオーナーに諮る |
| 2 | 同上。`sb_secret_` で呼ぶ | `sb_secret_` が captcha を免除される | 免除されなければ別の計画（(a) の始めにも Turnstile のトークンが要る） |
| 3 | 当てた後。GoTrue の更新（再デプロイ・設定の変更）の後 | 引き金 `passkey_credentials_notify` が消えていない | 消えていたら C を作り直す（引き金の作成は `supabase_auth_admin`。サポートに依頼） |
| 4 | 開店前 | PIN の無い物理キーで、ログインの印（UV）と、一覧を渡さないログインが動く | 物理キーの人が入れなければ、案内を書く（守りは UV の印で保たれる） |
| 5 | 本番でパスキーを有効にした後。**本物の Google で店員を入れてみる** | アプリが `/login?error=staff_passkey_required` に戻す（本物の Google ログインの `amr` と、フックの拒否の形） | `oauth/callback` の拒否の見分けを直す（`src/app/api/auth/oauth/callback/route.ts`）。**3a の Task 10 では本物の形を確かめられなかった**（実装タスクにはしない） |
| 6 | 本番のダッシュボード | Passkeys を有効にできる（今のプラン） | 有効にできなければ、プランか別の道をオーナーに諮る（前提1・3） |
| 7 | 節1 | 本番の GoTrue が v2.196.0 | 違えば、試し T1〜T7 の前提を見直す |
| 8 | 本番。GoTrue を直に叩く | 古い形の `service_role` の鍵が captcha を免除されるか。**パスキーの始め (a) は古い鍵を使わない**が、**`createServiceRoleAuthClient` を使う窓口は全部、`SUPABASE_SERVICE_ROLE_KEY`（古い形）で `/otp`・`/signup`・`/token` を呼ぶ**（`src/lib/auth/service-role-auth-client.ts`）。使う窓口は、メールのコードの始めと再送（`email-code/start`・`email-code/resend`）、パスワードのログインとその再送（`login`・`login/resend`）、新規登録（`register`）、パスワード変更の確かめ（`features/auth/services/password-change.ts`）。見るのは、この古い鍵の呼び出しが captcha を通るか | 免除されず、captcha を有効にした後にメールのコードが止まる時は、12 の判断（`createServiceRoleAuthClient` を `sb_secret_` に替える。別の計画）へ |
| 9 | フックの登録後。**本物の拒否を起こす**（パスワードで入ろうとする店員など） | 拒否の応答（403・`unknown`・フックの文）が手元と同じ。アプリが文で「店員はパスキーで」と見分ける | `src/app/api/auth/oauth/callback/route.ts` と更新の窓口（`refresh`）の見分けを直す。**3a の Task 10 では本物の形を確かめられなかった** |
| 10 | 本番の Confirm email オンのまま | 未登録のアドレスにコードが届き、確定でログインできる（`createUser` → `signInWithOtp`） | 本番の設定（Confirm email・雛形）を直す |
| 11 | 本番の Auth の設定 | `magic_link` の雛形に `{{ .Token }}` が在り、`otp_length` が8・`otp_expiry` が300 | 設定を直す |
| 12 | 本番。`(b)` の切り替えの実機と、`/otp` の IP の枠 | `(b)` に切り替えて動く。`/otp` にも `Sb-Forwarded-For` を添えられるか、`createServiceRoleAuthClient`（今は `SUPABASE_SERVICE_ROLE_KEY`）を `sb_secret_` に替える要否が決まる（台帳の「8-2 の1行」） | 替える時は別の計画 |

段3b が足した確認（本番のアプリをデプロイし、定期処理を動かした後）。

| 確認 | いつ・どの画面 | 期待する結果 | 外れた時 |
| --- | --- | --- | --- |
| 店長への知らせが、実在の宛先に届く（Task 14・15） | 最初の店長の後、2人目の店長を招待する・店長を降格する時。管理画面の店員の操作 | 知らせは「本人を除く、有効で、停止・削除されていない店長全員」に届く。**オーナーが実在のメールで受け取れること**（本番の店長のアドレスに実際に届くか）を確かめる。最後の手段（`last_resort`）では出ない | 宛先を直す。本人に届く・止まった人に届く時は、宛先の規則（`passkey_notification_recipients`）を調べる |
| 死んだ知らせの点検（Task 17） | 毎分の定期処理が動いた後 | `dead` の行があれば、1時間に1回・まとめて1通が `SHOP_ALERT_EMAIL` に届き、同じ行が2度届かない。メールにアドレス・本文が無い | 届かなければ `SHOP_ALERT_EMAIL`・Resend の設定と、`list_unnotified_dead_passkey_notifications` を調べる |
| worker の心拍（Task 17） | 毎分の定期処理が動いた後 | 心拍の行 `passkey_notification_worker` が1分ごとに更新される（読むだけ: `select job, last_succeeded_at, last_failed_at from public.ops_job_heartbeats where job = 'passkey_notification_worker';` を数分おいて2回流し、`last_succeeded_at` が進む） | 動かなければ、まず `delivery_tracking` など**ほかの job の心拍が進むか**を見る。ほかも止まっていれば定期処理（Vault の名前・アプリのデプロイ）と `CRON_SECRET` の一致。**ほかは進むのにこの行だけ進まない（行が無い）なら、worker 自身が `disabled` か `config` で止まっている**（心拍は書かれない）。`disabled` の原因は、Vercel の `VERCEL_ENV` が `production` でないこと（preview・development の公開）など。`config` の原因は、`MAIL_PROVIDER`・`MAIL_FROM_ADDRESS`・`RESEND_API_KEY`（`MAIL_PROVIDER` が `resend` の時）、連絡先の URL を作る `NEXT_PUBLIC_SITE_URL`。これらの設定と、ログの `[passkey-notification-worker]`（`skipped`・`send config is not ready`）を調べる。最初の成功の前は行が無いのが普通 |

30分の停止の知らせは**本番では試さない**。この点検は、毎分の入口の中で worker の後に動く。定期処理を止めると点検も止まり、再開すれば worker が先に心拍を更新するので、知らせは出ない（止めても確かめにならない）。しかも定期処理は Stripe の webhook の worker も動かすので、止めると本番の決済の処理が止まる。30分の知らせは、入口が動き続けて worker だけが30分成功しない時（最初の成功の後。取り出しの失敗（DB が読めない）・worker の例外・`disabled`・`config` で30分成功しない時）に出る。送りの失敗が続く行は心拍を止めず、9回目で `dead` になって死んだ知らせの点検が知らせる（約4時間）。この動きは Task 17 の単体試験と DB 結合試験が確かめている。

## 7. 残る危険の一覧

当てても残る危険。段3b の最終の確かめで、オーナーが受け入れた。

- **GoTrue を直に叩いた鍵の削除は、認めの処理と直列にならない**。今、鍵ごとの錠（`hashtextextended('passkey_approve:' || user, 0)`）を取るのは、`passkey_approve`・`passkey_delete_with_floor`（店員の削除の道）・`staff_invite_issue_core`（`public.staff_invite_issue` を通る）など DB の関数だけ。GoTrue の管理 API や、`auth.webauthn_credentials` への直の `DELETE` は錠を取らないので、認めの処理の途中に割り込める。結果は2本の下限を越えること（店員自身のログインを失うだけ。店長のやり直しで戻る。引き金が知らせを積むので気づける）。22b は行わない（オーナーの答え1＝A）ので、この行は残る。出どころは移行 F のヘッダーの KNOWN REMAINING RISK。
- 引き金で拾えない道（`TRUNCATE` ほか）。
- 複製された鍵の検知はしない。
- 降格した店長が出した招待は、降格で取り消される（Task 13。窓も閉じる）。
- 最初の店長を `admin:bootstrap` で作ると、H の `STAFF_INVITE_REQUIRED` が効かない（段4まで）。
- この master を本番に出すと、パスワード＋TOTP の店長は入れない（節2の順で、最初の店長を作ってから E を当てる）。

## 8. アプリの外で店長を消す・止めた時

Supabase のダッシュボードで店長の利用者を消す・止める前に、**アプリで降格する**。降格は、その店長が出した未使用の招待を同じ取引で取り消し、登録の窓を閉じる。

やむを得ず消した時は、その店長が出した招待を手で取り消す。**ダッシュボードの SQL エディタで流す。流す前にオーナーの許可を得る（調整役がオーナーの許可を得てから）**。`'<消した店長の id>'` はその人の利用者の id に置き換える。

```sql
begin;
select pg_advisory_xact_lock(190519, 0);
with c as (
  update private.staff_invites set cancelled_at = now()
   where issued_by = '<消した店長の id>' and cancelled_at is null and activated_at is null
  returning user_id
)
update private.passkey_registration_windows set closed_at = now()
 where user_id in (select user_id from c) and closed_at is null;
commit;
```

取り消した招待の本人の窓だけを閉じる（その店長が過去に招待した、有効化済みの店員の窓は閉じない。アプリの `private.staff_cancel_invites_issued_by` と同じ範囲）。1つの取引で流す。

## 9. 開店前の残り

- 設計 8-1 のとおり、本番の試し用の4人はパスワードが使えなくなる。店員がいれば、招待かやり直しで入り直す。
- 一度も入らなかったメールのコードのアカウントの後始末（判断10）。
- 物理キー（PIN 無し）の確認（節6の4）。
- 本物の Google の確認（節6の5・9）。
- 節6の8-2 の残り（特に1・2・12）。
- 店長への知らせの宛先の確認（節6の段3b の確認）。実在のメールに届くことをオーナーが確かめる。
- 毎分の定期処理（Stripe の webhook の worker）を本番で動かし始める判断（節2の4）。開店の準備の行3の保留の定期処理4本と一緒に決める。
