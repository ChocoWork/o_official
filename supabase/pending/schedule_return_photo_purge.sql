-- E-3 段2の写真の保持期限を守るため、アプリ公開後の開店時にだけ登録する。
-- 保留のままでは実行されない。昇格の手順は supabase/pending/README.md。
-- 毎日19:20 UTC（日本時間は翌日4:20）に、認証したアプリの窓口で消す。
-- Vault の値はジョブの実行時に読むため、定義に秘密の値を埋め込まない。

create extension if not exists pg_net with schema extensions;

-- 秘密の無い環境でも登録の SQL は止めず、ジョブ本体で HTTP の前に止める。
do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
     or not exists (select 1 from vault.decrypted_secrets where name = 'app_base_url') then
    raise warning 'vault secrets (cron_secret / app_base_url) are missing; purge-return-photos will fail until set';
  end if;
end $$;

select cron.schedule(
  'purge-return-photos',
  '20 19 * * *',
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
        raise exception 'purge-return-photos: vault secrets (app_base_url / cron_secret) are missing';
      end if;

      -- DB の物理行を消すと実体が残るため、Storage API を使うアプリの窓口へ送る。
      perform net.http_post(
        url := pg_catalog.rtrim(v_base_url, '/') || '/api/cron/purge-return-photos',
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_cron_secret
        ),
        -- アプリの実行上限60秒に合わせ、処理中に既定の2秒で諦めない。
        timeout_milliseconds := 60000
      );
    end
    $job$;
  $$
);
