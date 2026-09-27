-- 未入金注文の掃除ジョブを毎日 04:00 UTC に呼ぶ（FREQ-356 / FREQ-368）
--
-- 【保留中】本番の公開時に入れる。supabase/migrations/ に置くと CI の db push が本番へ流すので、
-- ここ（supabase/pending/）に置いている。入れる手順は supabase/pending/README.md。
-- 以前の名前は 20260912020000_schedule_expire_pending_orders.sql（本番には一度も当てていない）。
--
-- CRON_SECRET と本番URL は Vault に置き、ジョブの実行時に復号して使う。
-- （Supabase の pg_cron + pg_net + Vault のサンプルと同じ形。値をジョブ定義へ焼き込まないので、
--   秘密をローテーションしてもジョブを作り直さなくてよい）
-- 本番では次を1回だけ実行しておくこと（値はアプリの環境変数と同じもの）:
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
--   select vault.create_secret('<本番URL>', 'app_base_url');

create extension if not exists pg_net with schema extensions;

-- 秘密が無い環境（ローカル・CI・プレビュー）でも、マイグレーションはここで止めない。
-- 止めると以降のマイグレーションも当たらず、DB を作り直せなくなる（レビュー指摘⑦）。
-- 足りないことは警告で知らせるだけにして、実際の保護はジョブ本体で行う。
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
     or not exists (select 1 from vault.decrypted_secrets where name = 'app_base_url') then
    raise warning 'vault secrets (cron_secret / app_base_url) are missing; expire-pending-orders will fail on every run until they are set';
  end if;
end $$;

-- ジョブ本体。秘密が欠けたまま送ろうとすると、ローカル DB での実測では次のようになる。
--   両方無い        : url が null になり not-null 違反。リクエストは積まれない
--   cron_secret のみ無い: Authorization が null のまま積まれ、endpoint は毎晩 401 を返す
-- 後者は「動いているように見えて実は何もしていない」状態なので、送信前に止める。
-- 例外にすると cron.job_run_details に status=failed と理由が残り、運用で拾える。
-- 文言には秘密の名前だけを書き、値は出さない（OWASP ASVS 7.1.1）。
select cron.schedule(
  'expire-pending-orders',
  '0 4 * * *',
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
        raise exception 'expire-pending-orders: vault secrets (app_base_url / cron_secret) are missing';
      end if;

      perform net.http_post(
        url := v_base_url || '/api/cron/expire-pending-orders',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_cron_secret
        ),
        -- 呼ばれる側（src/app/api/cron/expire-pending-orders/route.ts）は
        -- maxDuration=60s、ループの打ち切りは 45s。ここを 30s にすると、ルートが
        -- まだ働いている最中に pg_net が諦め、net._http_response にはタイムアウトだけが
        -- 残る。運用からは「毎晩失敗している」としか見えず、何件片付いたか分からない。
        -- ルートの実行上限に合わせる（pg_net の既定は 2000ms、上限の定めは無い）。
        timeout_milliseconds := 60000
      );
    end
    $job$;
  $$
);
