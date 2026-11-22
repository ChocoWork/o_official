# パスキーの移行を本番に当てる手順書

> 状態: 手順（本番には何も当てていない。当てるのは調整役だけで、オーナーの許可を得た時だけ） | 確認日: 2026-11-22 | 対象: `supabase/migrations/` のパスキーの移行 A〜K の11本、ダッシュボードの設定、アプリのデプロイ、定期処理 | 設計: [パスキー設計](../superpowers/specs/2026-11-07-passkey-auth-design.md)（8-1・8-2）、計画: [段3b の計画](../superpowers/plans/2026-11-19-passkey-stage3b-staff-ops.md)（Task 23）・[段4の計画](../superpowers/plans/2026-11-20-passkey-stage4-cleanup.md)（Task 35）

## 概要

この手順書は、パスキーの移行11本（A〜K）を本番へ当てる順・確かめ・戻し方を1か所にまとめる。A〜I は段1〜3b で作った。**J・K は段4（2026-11-22）で足した**: J はお客さんの `password` でのログインをフックで拒否する旗を真にする（1行の `UPDATE`）。K は使わなくなったパスワード用の表2つと関数3つを消す。なお、2026-11-19 にオーナーが、GoTrue を直に叩く鍵の削除の穴を認めた（22b は行わない）。各移行の中身と手元の確認は [db-migrations.md](./db-migrations.md) の各節が正本で、ここはそれを順に流すための手順にする。

- 当てるのは調整役だけで、**オーナーの許可を得た時だけ**。本番へ向けて流す SQL・操作には「調整役がオーナーの許可を得てから」と書く。書いていない SQL は読むだけの `select`。
- 移行は Supabase の MCP の `apply_migration` で1本ずつ当てる。`supabase db push`（どの形でも）と `workflow_dispatch` は流さない。
- 本番の独自のドメインが決まるまで、1本も当てない（オーナー決定 2026-11-16・2026-11-19）。J・K も A〜I と同じで、手元だけにあり、本番には当てていない。
- この master を、手順の途中でアプリとして本番にデプロイしない。デプロイは節2の決まった位置で行う（店員のパスワード＋TOTP の入り方は、この master のアプリと移行・フックで止まる。段4で、パスワードと認証アプリ〔TOTP〕のログインの窓口・画面とコマンド `admin:bootstrap` を消した）。
- **アプリをデプロイしたら、J まで間を空けない**（節2の8）。J を当てるまでは、GoTrue への直のパスワードの道（`grant_type=password`）が開いたままで、他人が先に付けたパスワードで入れる。

## 1. 前提（全部そろうまで1本も当てない）

次の11項目が全部そろっていること。1つでも欠けたら止めて報告する。

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
9. **既存の店員の TOTP の要素の扱いが決まっている**（設計 8-1・6-2）。段4のコードは TOTP を使わない（登録も確認もしない）ので、残った要素は使われない。H の招待の取引は、招待された人の `auth.mfa_factors` だけを消す。招待・やり直しをしない既存の店員の TOTP の要素は残る（パスワードは使えなくなるので入れないが、要素が残る）。移す時に全部消すか（読むだけで数を見る。有効で期限内の `admin`・`supporter` の役割の人の TOTP の要素を、人数と本数で数える: `select count(distinct f.user_id) as users, count(*) as factors from auth.mfa_factors f where f.factor_type = 'totp' and exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id where ur.user_id = f.user_id and r.code in ('admin', 'supporter') and ur.active and (ur.expires_at is null or ur.expires_at > now()));`）、各店員を招待かやり直しで入り直させて消すかを決める。消すのも**調整役がオーナーの許可を得てから**。
10. **本番の `auth.users` の状態を読む**（読むだけ。段4）。お客さんの数・確認前のパスワード登録の数・パスワードを持つお客さんの数・店員の TOTP の要素の数を、1回で数える（店員 = `admin`・`supporter` の役割の行が1つでもある人。有効かどうかは問わない）。
    ```sql
    select
      (select count(*) from auth.users u
        where u.deleted_at is null
          and not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
                           where ur.user_id = u.id and r.code in ('admin', 'supporter'))) as customers,
      (select count(*) from auth.users u
        where u.deleted_at is null and u.email_confirmed_at is null) as unconfirmed_signups,
      (select count(*) from auth.users u
        where u.deleted_at is null and coalesce(u.encrypted_password, '') <> ''
          and not exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
                           where ur.user_id = u.id and r.code in ('admin', 'supporter'))) as customers_with_password,
      (select count(*) from auth.mfa_factors f
        where f.factor_type = 'totp'
          and exists (select 1 from public.user_roles ur join public.roles r on r.id = ur.role_id
                       where ur.user_id = f.user_id and r.code in ('admin', 'supporter'))) as staff_totp_factors;
    ```
    - 記録の上では、本番の4人は役割の印が店長の試し用で、お客さんではない。パスワードだけのお客さんと確認前の登録は0人。**読んで数え、記録と違えば止めて報告する**。
    - **`unconfirmed_signups` が1件でもあれば、消すか、確認を済ませるかを、オーナーが決める**（オーナーの答え1は A。確認メールに8桁の数字を入れる運用が前提で、確認前の人もその数字で入れる。決まるまで J を当てない）。消す・確認済みにするのも**調整役がオーナーの許可を得てから**。
    - `customers_with_password` は、J を当てると `password` で入れなくなる人の数（メールのコード・Google・パスキーで入る）。0でなければ、オーナーに知らせる。
11. **本番の権限が手元の最終の姿と同じ**（K の戻しの正本は手元の最終の姿なので、K を当てる前に比べる。読むだけ）。本番の `relacl`・`proacl`・`proconfig`・方針の数が、手元と同じであること。違えば K を当てず、報告する（K の戻しで戻る権限が、本番の今の権限と食い違う）。
    ```sql
    select c.relname, c.relacl::text, c.relrowsecurity,
           (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
     where c.oid in ('public.password_reset_tokens'::regclass, 'public.password_change_challenges'::regclass)
     order by c.relname;
    select p.proname, p.proacl::text, p.proconfig::text, p.prosecdef, pg_get_userbyid(p.proowner) as owner
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('issue_password_change_challenge', 'consume_password_change_challenge', 'cleanup_password_reset_tokens')
     order by p.proname;
    ```
    期待（手元で K の前に控えた値）: 2表とも `relacl` が `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`・RLS 有効（`relrowsecurity` が `t`）・`policies` が3。3関数とも `proacl` が `{postgres=X/postgres,service_role=X/postgres}`・`proconfig` が `{search_path=""}`・`prosecdef` が `t`・`owner` が `postgres`。**この SQL（読むだけ）も、本番へは調整役がオーナーの許可を得てから流す**。

## 2. 当てる順

1. A → B → C → D → F → G → H → **I** を、**1本ずつ**当てる（節3の表）。1本当てるたびに、節3の突き合わせを済ませてから次へ進む。
   - **H は G の列に依存する**。**G の前に H を当てない**（H の前の確かめが G の3列 `lease_token`・`last_error_code`・`finished_at` を見て、無ければ `passkey_h_g_columns` で止まる）。H は F の関数 `passkey_is_staff` も使うので、F の後。
   - I は A と G の後。
   - C は本番の `postgres` が `TRIGGER` を持つこと（節1の4）が前提。
2. ダッシュボードで、Passkeys の有効化と RP（`rp_id`・`rp_origins`）を設定する。次に、**B を当てた後で** Custom Access Token フック（`public.passkey_access_token_hook`）を登録する（B より先に登録すると、全員のログインが止まる）。手順は [supabase-auth-config.md](./supabase-auth-config.md)（**調整役がオーナーの許可を得てから**）。
3. アプリをデプロイする（**調整役がオーナーの許可を得てから**）。**D はデプロイの前**に当てておく（アプリの `admin-rbac` が `staff_idle_check` を呼ぶ。A も同じ）。
   - **2b. デプロイの前に、本番のダッシュボードの確認メールの雛形を貼り替える**（変えるのは**オーナー**。2026-11-06 の決定で、オーナーが同じ文に変えると回答済み。段4でアプリの確認の窓口 `/api/auth/confirm` を消したので、今の雛形のリンクは無効になり、本文はパスワードを案内していて、確認前の人が入れなくなる）。ダッシュボードの Authentication → Emails → **Confirm sign up**。件名は `メールアドレスの確認` のまま。本文は **Source** に切り替え、中身を全部消してから、次を一字一句そのまま貼る（`{{ .Token }}` は Supabase が8桁の数字に置き換える印。1字でも変えると壊れる。リンクと、パスワードの案内の文は無い）。手順の詳細は [supabase-auth-config.md](./supabase-auth-config.md) の「手順 2」。
     ```html
     <h2>メールアドレスの確認</h2>
     <p>ログインの確認コード: {{ .Token }}</p>
     <p>ログインの画面にこの8桁の数字を入れると、会員登録が終わります。</p>
     <p>有効期限は5分です。心当たりがない場合は、このメールを破棄してください。</p>
     ```
   - **2c. 答え5は A**: 確認前のアカウントの確認メールにも `{{ .Token }}`（8桁。有効期限・桁数はメールのコードと同じ。`mailer_otp_length` が8・`mailer_otp_exp` が300）が入る。デプロイの後、**確認前のアカウントで、メールの数字を入れて入れることを1回確かめる**（手元の Task 26 (e) と同じ確かめを、J を当てる前に本番で1回。**調整役がオーナーの許可を得てから**。確かめに使うアドレスはオーナーのもので、本番の `auth.users` に1行できる。終わったら、そのアカウントを管理 API で消すかをオーナーが決める）。入れなければ J を当てない。
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
7. **TOTP を止める**（ダッシュボード。**調整役がオーナーの許可を得てから**）。段4のコードは TOTP を使わない（登録も確認もしない）ので、**Authentication → Multi-Factor の Authenticator App (TOTP) の Enroll と Verify を、両方オフにする**（鍵名は `mfa_totp_enroll_enabled`・`mfa_totp_verify_enabled`。手順は [supabase-auth-config.md](./supabase-auth-config.md) の「手順 4」）。止める前の値を控える（戻す時に使う）。戻す時は節4の (2b)。
   - **店員の TOTP の要素の残り**: H の招待・やり直しの取引が、招待された人の要素を消す。招待・やり直しをしない店員の要素は残る（Verify を止めたので使えない。害は無いが、数を読んで記録する）。残りを読む（読むだけ。**調整役がオーナーの許可を得てから**本番へ流す）。
     ```sql
     select count(distinct f.user_id) as users, count(*) as factors
       from auth.mfa_factors f
      where f.factor_type = 'totp';
     ```
     全員が招待かやり直しで入り直したなら `factors` は0になる。0でなければ、残りを消すかをオーナーが決める（消すのも**調整役がオーナーの許可を得てから**。普段はアプリの招待・やり直しに任せ、手で消さない）。
8. **J を当てる**（**調整役がオーナーの許可を得てから**）。**アプリをデプロイしたら、J まで間を空けない**。順は次のとおり。
   1. アプリをデプロイし（節2の3）、確認メールの雛形（上の 2b）が貼り替わっていること。
   2. **お客さんがメールのコードで入れることを確かめる**（上の 2c の確かめ）。
   3. すぐ J を当てる（節3の表の J の行。前の確かめ → `apply_migration` → 突き合わせ → 成功の印）。
   - 間を空けない理由: J を当てるまでは、GoTrue への直のパスワードの道（`grant_type=password`）が開いたままで、他人が先に付けたパスワードで入れる。本番は公開前でお客さんは記録の上で0人なので危険は小さいが、間を空けない。
   - 外れたら: 当てない。J を当てた後に問題が出たら、節4の (0b)（旗の戻し）で戻る。
9. **K を当てる**（**調整役がオーナーの許可を得てから**）。**J の後**。デプロイしたアプリが、消した窓口（パスワードの再設定・変更の窓口と、パスワードのログインの窓口）を呼ぶ物が無いことを確かめてから（アプリのログに、消した窓口への呼び出しや、消した表・関数を呼ぶ失敗が無いこと）。前の確かめに節1の10・11を含める。当てた後、成功の印は節3の表の K の行。

## 3. 1本ごとの手順の表

当て方（A〜K 共通。**調整役がオーナーの許可を得てから**）。

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

大きさと MD5 は、A〜I は2026-11-20、J・K は2026-11-22 に `wc -c`・`md5sum` で測った値（LF・BOM なし・ASCII だけ）。`db-migrations.md` の各節の値と全部一致した。表の「前の確かめの SQL」「成功の印」の列は、下の「前の確かめ」の節と同じ中身を1行で言ったもの（正本は移行ファイルの頭書き）。

| 順 | ファイル | 大きさ | MD5 | 単独で権限を奪うか | `name` | 前の確かめの SQL（読むだけ。期待は `true` など） | 成功の印（当てた後。読むだけ） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `20261116215034_passkey_foundation_tables.sql`（A） | 14424 | `dc73b6e294108890433058b56d2c70dc` | 奪わない（表と関数を足すだけ） | `passkey_foundation_tables` | `select to_regclass('private.passkey_staff_config') is null and to_regclass('auth.webauthn_credentials') is not null;` が `true` | 突き合わせ（`md5(statements[1])`＝ファイルの MD5、`n_statements` が1）。`select to_regclass('private.passkey_staff_config') is not null and to_regprocedure('public.passkey_approved_count(uuid)') is not null;` が `true` |
| 2 | `20261116230000_passkey_access_token_hook.sql`（B） | 8454 | `39fc2e72e8fe8f5bc4a8a6df3f7533d2` | 奪わない（登録するまで効かない） | `passkey_access_token_hook` | `select to_regprocedure('public.passkey_approved_count(uuid)') is not null;` が `true`（A） | 突き合わせ。`select to_regprocedure('public.passkey_access_token_hook(jsonb)') is not null;` が `true` |
| 3 | `20261116232141_passkey_credential_events.sql`（C） | 8049 | `fd522cc9974488668fc89e70fb371dce` | 奪わない（鍵の足し・消しで知らせと認めを動かす） | `passkey_credential_events` | `select to_regclass('private.approved_passkeys') is not null and to_regclass('private.passkey_notification_outbox') is not null and to_regclass('private.passkey_registration_windows') is not null and to_regclass('public.user_roles') is not null and has_table_privilege('postgres','auth.webauthn_credentials','TRIGGER');` が `true` | 突き合わせ。`select count(*) from pg_trigger where tgname = 'passkey_credentials_notify' and not tgisinternal;` が `1` |
| 4 | `20261117001500_passkey_staff_entry_conditions_fn.sql`（D） | 16750 | `b50ea103050e223af93d8ffe1339e0ec` | 奪わない（関数と表を足すだけ。E が呼ぶ） | `passkey_staff_entry_conditions_fn` | `select to_regprocedure('private.passkey_staff_settings()') is not null and to_regprocedure('public.passkey_approved_count(uuid)') is not null;` が `true` | 突き合わせ。`select to_regprocedure('private.staff_idle_ok(uuid)') is not null and to_regprocedure('private.staff_passkey_amr_ok(jsonb)') is not null;` が `true` |
| 5 | `20261117123620_passkey_server_endpoint_fns.sql`（F） | 12085 | `b8b22d4844ac4c51d7744737e650c43c` | 奪わない（関数を足し `passkey_approve` を直す） | `passkey_server_endpoint_fns` | `select to_regprocedure('public.passkey_approve(uuid,uuid,text)') is not null and to_regprocedure('public.passkey_is_staff(uuid)') is null;` が `true` | 突き合わせ。`select to_regprocedure('public.passkey_is_staff(uuid)') is not null;` が `true` |
| 6 | `20261118044338_passkey_notification_sending.sql`（G） | 21265 | `505f615cfbc19562a72799a0b2da3f03` | 奪わない | `passkey_notification_sending` | `select to_regclass('private.passkey_notification_outbox') is not null and to_regclass('private.order_email_send_pause') is not null and to_regclass('auth.webauthn_credentials') is not null and (select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox' and column_name = 'actor_email') = 1;` が `true` | 突き合わせ。`select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox' and column_name in ('lease_token','last_error_code','finished_at');` が `3` |
| 7 | `20261118130000_passkey_staff_invites.sql`（H） | 47537 | `c871a2bf2f2878590ec271f2cecb9b47` | 奪わない（`admin_set_user_role` が、店員にする変更を今の有効な店員だけに絞る） | `passkey_staff_invites` | 下の「H」の select を1つにした `select (select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox' and column_name in ('lease_token','last_error_code','finished_at')) = 3 and has_table_privilege('postgres','auth.mfa_factors','DELETE') and has_table_privilege('postgres','auth.webauthn_credentials','DELETE') and has_table_privilege('postgres','auth.users','UPDATE') and has_table_privilege('postgres','auth.sessions','SELECT') and to_regclass('private.staff_invites') is null and (select md5(prosrc) from pg_proc where oid = 'private.admin_set_user_role(uuid,uuid,text)'::regprocedure) = '0cb9f532f16aa5c56c6b425694f7209b' and to_regnamespace('extensions') is not null and to_regprocedure('public.passkey_is_staff(uuid)') is not null;` が `true` | 突き合わせ。`select to_regclass('private.staff_invites') is not null and to_regprocedure('private.staff_invite_issue_manual(text,text,integer)') is not null;` が `true` |
| 8 | `20261119181323_passkey_notification_ops.sql`（I） | 9655 | `33a8d3641f63b311de45c0c0f0c56c6d` | 奪わない | `passkey_notification_ops` | **先に** `select pg_get_constraintdef(oid) from pg_constraint where conname = 'ops_job_heartbeats_job_check';` を控える。`select to_regclass('private.passkey_notification_outbox') is not null and (select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox' and column_name in ('status','finished_at','last_error_code','attempts','kind')) = 5;` が `true` | 突き合わせ。`select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox' and column_name = 'dead_notified_at';` が `1`、`select to_regprocedure('public.list_unnotified_dead_passkey_notifications(integer)') is not null;` が `true` |
| 9（A〜I の最後） | `20261117013000_passkey_staff_entry_conditions.sql`（E） | 10120 | `24839a6932a684ee47d491cc532806f0` | **奪う**（`has_permission` を切り替える） | `passkey_staff_entry_conditions` | `select md5(prosrc) from pg_proc where oid = 'public.has_permission(text)'::regprocedure;` が `3c4826933eca194a3486f430d361891c`。加えて節2の6の SQL（最初の店長の `approved` が `required` 以上で、1行以上返る） | 突き合わせ。同じ `md5(prosrc)` が `3c4826933eca194a3486f430d361891c` でなくなる。最初の店長が `/admin` に入れる |
| 10 | `20261122070400_passkey_reject_customer_password.sql`（J） | 2503 | `fb2976f8f687198719eda0d687a85dd5` | 奪わない（お客さんの `password` のログインだけを止める。店員は旗に関係なく止まっている） | `passkey_reject_customer_password` | `select (select count(*) from private.passkey_staff_config) = 1 and to_regprocedure('public.passkey_access_token_hook(jsonb)') is not null and to_regprocedure('private.passkey_staff_settings()') is not null;` が `true`。加えて節2の8の確かめ（アプリのデプロイ済み・お客さんがメールのコードで入れる） | 突き合わせ。`select count(*) from private.passkey_staff_config where reject_customer_password is true;` が `1` |
| 11 | `20261122070500_drop_password_auth_objects.sql`（K） | 10578 | `c66df54ef45d6aa9d9c53321afdef8ff` | 奪わない（使わない表2つと関数3つを消す。`CASCADE` なし） | `drop_password_auth_objects` | `select to_regclass('public.password_reset_tokens') is not null and to_regclass('public.password_change_challenges') is not null;` が `true`。加えて節1の11の読み（権限が手元の最終の姿と同じ）と、`select count(*) from public.password_reset_tokens;`・`select count(*) from public.password_change_challenges;`（行数。多くても止めない） | 突き合わせ。`select to_regclass('public.password_reset_tokens') is null and to_regclass('public.password_change_challenges') is null and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('issue_password_change_challenge','consume_password_change_challenge','cleanup_password_reset_tokens')) = 0;` が `true` |

ファイルの一覧は `ls supabase/migrations | grep -e passkey -e drop_password_auth_objects` と同じ11本（A〜I の9本と、段4の J・K）。版の昇順は A, B, C, D, E, F, G, H, I, J, K で、**E は版では D の次だが、A〜I の中では最後に当てる**（表の「順」の欄。J・K は E の後）。

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

**J**（段4。**アプリのデプロイと、お客さんがメールのコードで入れることの確認の後、間を空けずに**。移行自身の `DO` ブロックも、A・B が無い時は `passkey_reject_customer_password_precheck`〔`PASSKEY_MIGRATION_PRECHECK_FAILED`／55000〕で止まる）
```sql
select count(*) from private.passkey_staff_config;                    -- 期待: 1（A）
select to_regprocedure('public.passkey_access_token_hook(jsonb)');    -- 期待: null でない（B）
select to_regprocedure('private.passkey_staff_settings()');           -- 期待: null でない（A）
select reject_customer_password from private.passkey_staff_config;    -- 期待: false（当てる前）
```
- J は旗を真にする1行の `UPDATE` だけ。末尾の確かめは、旗が真の行がちょうど1つ（`passkey_reject_customer_password_postcheck`）。
- 店員の `password` は、旗に関係なく、もともとフックが店員の印で拒否している。J が止めるのはお客さんの `password` だけ。

**K**（段4。J の後。消した窓口を呼ぶ物が無いことの確認の後）
```sql
select to_regclass('public.password_reset_tokens'), to_regclass('public.password_change_challenges');   -- 期待: 両方 null でない
select count(*) from public.password_reset_tokens;          -- 行数を控える。移行も NOTICE で出す。多くても止めない（期限つきの確認用のハッシュだけ）
select count(*) from public.password_change_challenges;
```
- 加えて、節1の11の読み（本番の `relacl`・`proacl`・`proconfig`・方針の数が手元の最終の姿と同じ）。
- K は `CASCADE` なし。表・関数に依存する物が残っていれば止まる。監査の表・行、`private.auth_return_intents`、`rate_limit_counters` は触らない。
- 末尾の確かめ: 2表・3関数が無い（`passkey_drop_password_objects_postcheck`）。**消した行は、`ROLLBACK` でも戻らない**。

## 4. 戻し方の順（全部の箇所でこの1つ）

**開店前は、古い仕組みへ戻す必要が無いので、この節の (1)〜(11) は使わない見込み**（オーナーの答え4。開店前なので、古いパスワード＋TOTP の入り方へ戻さない）。使う時は、**先に K、次に J を戻す**（下の (0)・(0b)）。その後に (1)〜(11)。(1)〜(11) の本文は段3b のまま。

**戻しの順の表**（調整役が1行ずつ追う。各行に「前の確かめの SQL」と「成功の印」を置く。**戻す操作はどの行も、調整役がオーナーの許可を得てから**。操作の正本は表の下の本文と、各移行ファイルの頭書きの `ROLLBACK`）。

| 順 | 戻すもの | 前の確かめの SQL（読むだけ） | 成功の印（戻した後。読むだけ） |
| --- | --- | --- | --- |
| (0) | **K**（K の `ROLLBACK`。表2つ・関数3つを、K の前の最終の姿で作り直す） | `select to_regclass('public.password_reset_tokens') is null and to_regclass('public.password_change_challenges') is null;` が `true`（K が当たっている） | 同じ SQL が `false`（両方在る）。節1の11の SQL を流し、`relacl`・`proacl`・`proconfig`・方針の数・`prosecdef`・`owner` が、節1の11の期待と同じ。**消した行は戻らない** |
| (0b) | **J**（`UPDATE private.passkey_staff_config SET reject_customer_password = false WHERE id;`）。古いアプリへ戻すなら、**(1) より前**に済ませる | `select reject_customer_password from private.passkey_staff_config where id;` が `true` | 同じ SQL が `false`（お客さんの `password` が再び通る） |
| (1) | 定期処理を止め、アプリをパスキー前のコミット `c336e0b5` へ戻す | `select jobname from cron.job where jobname = 'process-stripe-webhooks';`（0行か1行。止めてから戻す） | 同じ SQL が0行。アプリは Vercel の production のデプロイが `c336e0b5`（SQL なし。デプロイ一覧で見る） |
| (2) | ダッシュボードのフックの登録を外す | SQL なし（ダッシュボードの設定）。Authentication → Hooks に `public.passkey_access_token_hook` が登録されている | Hooks に Custom Access Token が登録されていない。ログインが通る |
| (2b) | TOTP を有効に戻す（止めていた時） | SQL なし（ダッシュボードの設定）。Multi-Factor の Authenticator App (TOTP) の Enroll・Verify がオフ | Enroll・Verify がオン（Enabled） |
| (2c) | Passkeys を無効に戻すかを決める | SQL なし（ダッシュボードの設定）。Passkeys が有効 | 決めた状態になっている（有効のままでもよい） |
| (3) | **E**（`has_permission` を `20261029120100_sec_has_permission_aal2_member_rls.sql` の本体に戻す） | `select md5(prosrc) from pg_proc where oid = 'public.has_permission(text)'::regprocedure;` が `3c4826933eca194a3486f430d361891c` **でない**（E が当たっている） | 同じ SQL が `3c4826933eca194a3486f430d361891c` |
| (3b) | 店長がまた入る道を作る | 本文 (3b) の読むだけの SQL（`active`・`expires_at`・`app_role`） | 同じ SQL が `active` 真・`expires_at` が空か未来・`app_role` が `admin`。店長が `/admin` に入れる |
| (4) | **I**（先に心拍の行を消す） | `select count(*) from public.ops_job_heartbeats where job = 'passkey_notification_worker';`（消す前の数を控える） | 同じ SQL が `0`。`select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox' and column_name = 'dead_notified_at';` が `0`。`select to_regprocedure('public.list_unnotified_dead_passkey_notifications(integer)');` が `null` |
| (5) | **H** | `select to_regclass('private.staff_invites') is not null;` が `true` | `select to_regclass('private.staff_invites') is null and (select md5(prosrc) from pg_proc where oid = 'private.admin_set_user_role(uuid,uuid,text)'::regprocedure) = '0cb9f532f16aa5c56c6b425694f7209b';` が `true` |
| (6) | **G** | `select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox' and column_name in ('lease_token','lease_expires_at','last_error_code','sent_at','finished_at');` が `5` | 同じ SQL が `0` |
| (7) | **F** | `select to_regprocedure('public.passkey_is_staff(uuid)') is not null;` が `true` | `select to_regprocedure('public.passkey_is_staff(uuid)') is null and (select md5(prosrc) from pg_proc where oid = 'public.passkey_approve(uuid,uuid,text)'::regprocedure) = 'e0b5dc02ecfcb5533cd91a00edc55fe4';` が `true` |
| (8) | **D**（E を戻した後） | `select to_regprocedure('private.staff_idle_ok(uuid)') is not null;` が `true` | 同じ SQL が `false`。`select to_regclass('private.staff_session_activity');` が `null` |
| (9) | **C**（先に関数を空にし、引き金の削除はサポートに依頼） | `select count(*) from pg_trigger where tgname = 'passkey_credentials_notify' and not tgisinternal;` が `1` | 関数を空にした後: `select prosrc from pg_proc where oid = 'private.passkey_credentials_notify()'::regprocedure;` が `RETURN NULL` だけ。引き金の削除（サポート）の後: 上の `count(*)` が `0`、`select to_regprocedure('private.passkey_credentials_notify()');` が `null` |
| (10) | **B**（フックの登録を外した後） | `select to_regprocedure('public.passkey_access_token_hook(jsonb)') is not null;` が `true` | 同じ SQL が `false` |
| (11) | **A**（C の引き金が無くなった後） | `select to_regclass('private.passkey_staff_config') is not null;` が `true` | `select to_regclass('private.passkey_staff_config') is null;` が `true` |

(0)・(0b) は、K・J を当てた後に戻す時だけ要る。K・J を当てる前に戻すなら、(1) から始める。**J を (1) より先に戻す理由**: (1) で古いアプリを出してから (2) でフックの登録を外すまでの間も、旗が効いたままだと、お客さんが入れない。(2) でフックの登録を外せば旗は効かなくなるので、この順の理由は、その間を守るため。K を先に戻す理由は、K の戻しが消した表・関数を作り直す（古いアプリが呼ぶ）ためで、J の前に済ませる。

**(0) の本文**（K を戻す）: K のファイルの頭書きの `ROLLBACK` の文（`BEGIN;` から `COMMIT;` まで。1つの取引）を、そのまま流す（**調整役がオーナーの許可を得てから**）。K を当てる前の最終の姿（締め直した権限を含む）に作り直す。`20260901102912` の文を代わりに流さない（`anon`・`authenticated` への権限が戻ってしまう）。流した後に、節1の11の SQL で `relacl`・`proacl` を読み、期待と同じことを確かめる。**消した行は戻らない**（中身は期限つきの確認用のハッシュだけ）。

**(0b) の本文**（J を戻す）: `UPDATE private.passkey_staff_config SET reject_customer_password = false WHERE id;`（**調整役がオーナーの許可を得てから**）。古いアプリへ戻すことがあれば、**その前にこれを済ませる**。

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
     2. **別のアドレスの店長が要るなら、ダッシュボードの Authentication の Users で利用者を作ってから（メール確認済み。作り方は節1の5）、上の1の取引の逆の SQL で有効にする**。コマンド `admin:bootstrap` は段4で消したので使えない。
   - **master のアプリ（パスキー）で入り直せる状態なら、最後の手段は招待**: オーナーが、ダッシュボードの SQL エディタで `private.staff_invite_issue_manual` を**自分で**流す（[手順書](./passkey-staff-recovery.md)）。**AI・MCP・CLI では流さない**（結果に、生の招待の合言葉が出るため）。古いアプリ（`c336e0b5`）では、この招待の画面が無いので使えない。
   - まとめると、場合は3つ。(i) `admin` の役割の行がある（有効なら1つ目の枝、無効なら2つ目の枝）。(ii) 利用者はいるが役割の行が無い（新しく作った最初の店長。2つ目の枝の SQL が行を入れる）。(iii) **利用者がそもそもいない**（作る前に戻した）: 先に節1の5でアカウントを作ってから、(i)・(ii) に従う。
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
| 8 | 本番。GoTrue を直に叩く | 古い形の `service_role` の鍵が captcha を免除されるか。**パスキーの始め (a) は古い鍵を使わない**が、**`createServiceRoleAuthClient` を使う窓口は全部、`SUPABASE_SERVICE_ROLE_KEY`（古い形）で `/otp`・`/signup`・`/token` を呼ぶ**（`src/lib/auth/service-role-auth-client.ts`）。使う窓口は、メールのコードの始めと再送（`email-code/start`・`email-code/resend`）だけ（段4で、パスワードのログイン・新規登録・パスワード変更の窓口は消した）。見るのは、この古い鍵の呼び出しが captcha を通るか | 免除されず、captcha を有効にした後にメールのコードが止まる時は、12 の判断（`createServiceRoleAuthClient` を `sb_secret_` に替える。別の計画）へ |
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
- GoTrue 自身の `/recover`・`/signup`（アプリの窓口ではなく、GoTrue が持つ道）は、段4で消えない。ただし、J で旗が真になり、フックがお客さんの `password` での入室を拒否するので、パスワードを付けても入れない（店員は元から拒否される）。GoTrue の `/recover` が送るパスワード変更の通知のメールの文（`supabase/templates/password_changed_notification.html`）には「パスワードを再設定のうえ」とあり、段4の方針（パスワードで入らない）と合わない。**雛形は変えない**（段4は新しい文を作らない）。この文の見直しは、開店前の確認（節9）で決める。
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
- 本番の確認メールの雛形の貼り替え（節2の3の 2b）とメールの数字で入れる確かめ（2c）。J・K を当てる前に済ませる（調整役がオーナーの許可を得てから）。
- 本番の `auth.users` の状態の読み（節1の10）。確認前のパスワード登録が1件でもあれば、消すか確認を済ませるかをオーナーが決める。
- GoTrue の `/recover` が送るパスワード変更の通知の雛形（`supabase/templates/password_changed_notification.html`）の「パスワードを再設定のうえ」の文を、開店前に見直すか決める（節7）。
- 段3b の持ち越し **M-3**: `src/lib/stripe/webhook-worker.ts` の `hardDeadlineMs`（`startedAt + 45_000`）の余裕。passkey の段が遅いと、後ろの点検が60秒の上限に近づく（翌分にまた走るので飢えない）。**段4では直さない**。毎分の定期処理を本番で有効にする時（節2の4）に、`startedAt + 60_000 - 15_000 - 8_000`（37秒）のように、送りの時間切れの分まで余裕を取る案か、`runOrderEmailOpsChecks` を passkey の段の前へ動かす案を決める。
- 段3b の持ち越し **M-4 のコード側**: 心拍は、`idle` と `budget` の両方、および予算が足りず段を飛ばした時（`passkeyBudget < 1000`）にも「成功」を書く。毎分飛ばし続けても、行が `dead` にならず、止まりの知らせも出ない。実際には Stripe の知らせの溜まりの警報が先に鳴る見込みで、**段4では直さない**。直す時は、「予算で飛ばした」を書き込み無しにするか、「古い未送信が30分より古い」を点検に足す。
- 段3b の持ち越し **M-6**: H のヘッダーの冒頭が、private の関数の数を3本と書いている（実際は4本。`ROLLBACK` の一覧と `db-migrations.md` は4本で正しい）。見た目だけの食い違いで、動きに影響しない。**H を直す時だけ**同時に直す（直すとファイルの MD5・大きさが変わるので、この手順書の表と `db-migrations.md` の測り直しが要る）。単独では直さない。
