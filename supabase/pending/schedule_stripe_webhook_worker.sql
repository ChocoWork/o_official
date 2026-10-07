-- 署名検証済みイベントをDBへ保存した後に処理するworkerを毎分起動する（設計書 2026-10-05 グループ B の 4-1。R-32）。
-- 受け取り口は保存の後にその場で1回 worker を動かす（after()）ので、毎分の起動は取りこぼしを拾う役目。
-- 10秒ごとだと実行の記録（cron.job_run_details）が1日8,640行溜まるので、毎分（1,440行）にした。
-- 本番適用は開店のとき、手順書（docs/06_Operations/webhook-queue-operations.md）の順番どおり、明示承認後。
-- app_base_url と cron_secret は既存のVault secretを再利用し、値をジョブに埋め込まない。
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_secret')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'app_base_url') THEN
    RAISE WARNING 'vault secrets (cron_secret / app_base_url) are missing; process-stripe-webhooks will fail until set';
  END IF;
END $$;

SELECT cron.schedule(
  'process-stripe-webhooks',
  '* * * * *',
  $$
    DO $job$
    DECLARE
      v_base_url text;
      v_cron_secret text;
    BEGIN
      SELECT decrypted_secret INTO v_base_url
      FROM vault.decrypted_secrets
      WHERE name = 'app_base_url';

      SELECT decrypted_secret INTO v_cron_secret
      FROM vault.decrypted_secrets
      WHERE name = 'cron_secret';

      IF v_base_url IS NULL OR v_cron_secret IS NULL THEN
        RAISE EXCEPTION 'process-stripe-webhooks: vault secrets (app_base_url / cron_secret) are missing';
      END IF;

      PERFORM net.http_post(
        url := pg_catalog.rtrim(v_base_url, '/') || '/api/cron/process-stripe-webhooks',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_cron_secret
        ),
        timeout_milliseconds := 60000
      );
    END
    $job$;
  $$
);