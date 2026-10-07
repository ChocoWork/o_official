-- Stripe との照合（入金・返金・会計・Stripe からの入金）を毎日 18:00 UTC（日本時間 3:00）に呼ぶ
-- （設計書 2026-10-05 グループ B の 4-1）。照合の入口は POST（pg_net は POST で呼ぶ）。
--
-- 【保留中】本番の公開時に入れる。supabase/migrations/ に置くと CI の db push が本番へ流すので、
-- ここ（supabase/pending/）に置いている。入れる手順は supabase/pending/README.md と
-- docs/06_Operations/webhook-queue-operations.md。
--
-- CRON_SECRET と本番URL は Vault に置き、ジョブの実行時に復号して使う（worker・見回りと同じ）。

create extension if not exists pg_net with schema extensions;

-- 秘密が無い環境（ローカル・CI・プレビュー）でも、マイグレーションはここで止めない。
-- 足りないことは警告で知らせるだけにして、実際の保護はジョブ本体で行う。
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
     or not exists (select 1 from vault.decrypted_secrets where name = 'app_base_url') then
    raise warning 'vault secrets (cron_secret / app_base_url) are missing; stripe-reconcile will fail on every run until they are set';
  end if;
end $$;

-- 秘密が欠けたまま送ると、認証ヘッダの無い要求が毎回 401 になる。送る前に例外で止め、
-- cron.job_run_details に status=failed と理由を残す。文言には秘密の名前だけを書き、値は出さない。
select cron.schedule(
  'stripe-reconcile',
  '0 18 * * *',
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
        raise exception 'stripe-reconcile: vault secrets (app_base_url / cron_secret) are missing';
      end if;

      perform net.http_post(
        url := pg_catalog.rtrim(v_base_url, '/') || '/api/cron/stripe-reconcile',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_cron_secret
        ),
        -- 照合は Stripe の一覧を順に読むので時間がかかる。pg_net の既定（2秒）では応答を待てない
        timeout_milliseconds := 60000
      );
    end
    $job$;
  $$
);
