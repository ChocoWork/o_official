-- 会計の計上係を10分ごとに呼ぶ（計画2 Task 10）。POST /api/cron/accounting-post が、Webhook の worker と各画面の操作が
-- 流す係の取りこぼしを拾い、ops_job_heartbeats の accounting_post に成功・失敗を残す（30分止まると見回りが知らせる）。
--
-- 【保留中】本番の公開時に入れる。supabase/migrations/ に置くと CI の db push が本番へ流すので、
-- ここ（supabase/pending/）に置いている。入れる手順は supabase/pending/README.md と
-- docs/06_Operations/webhook-queue-operations.md（会計の運用の手順 3）。
--
-- CRON_SECRET と本番URL は Vault に置き、ジョブの実行時に復号して使う（worker・照合と同じ）。

create extension if not exists pg_net with schema extensions;

-- 秘密が無い環境（ローカル・CI・プレビュー）でも、マイグレーションはここで止めない。
-- 足りないことは警告で知らせるだけにして、実際の保護はジョブ本体で行う。
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
     or not exists (select 1 from vault.decrypted_secrets where name = 'app_base_url') then
    raise warning 'vault secrets (cron_secret / app_base_url) are missing; accounting-post will fail on every run until they are set';
  end if;
end $$;

-- 秘密が欠けたまま送ると、認証ヘッダの無い要求が毎回 401 になる。送る前に例外で止め、
-- cron.job_run_details に status=failed と理由を残す。文言には秘密の名前だけを書き、値は出さない。
select cron.schedule(
  'accounting-post',
  '*/10 * * * *',
  $$
    do $job$
    declare
      v_base_url text;
      v_cron_secret text;
    begin
      select decrypted_secret into v_base_url
      from vault.decrypted_secrets
      where name = 'app_base_url';

      select decrypted_secret into v_cron_secret
      from vault.decrypted_secrets
      where name = 'cron_secret';

      if v_base_url is null or v_cron_secret is null then
        raise exception 'accounting-post: vault secrets (app_base_url / cron_secret) are missing';
      end if;

      perform net.http_post(
        url := pg_catalog.rtrim(v_base_url, '/') || '/api/cron/accounting-post',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_cron_secret
        ),
        -- 係は最大20回まで繰り返す。pg_net の既定（2秒）では応答を待てない。60秒で待つのをやめても実行は続く
        timeout_milliseconds := 60000
      );
    end
    $job$;
  $$
);
