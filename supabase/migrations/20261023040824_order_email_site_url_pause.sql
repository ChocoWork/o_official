-- 本番のサイトの住所の設定で注文メールを一時停止する（波1 Task 4 / J-17）。
BEGIN;

ALTER TABLE private.order_email_send_pause
  DROP CONSTRAINT order_email_send_pause_reason_check;
ALTER TABLE private.order_email_send_pause
  ADD CONSTRAINT order_email_send_pause_reason_check CHECK (
    reason IS NULL
    OR reason IN ('config_api_key', 'config_sender_domain', 'config_provider', 'config_site_url', 'quota_daily', 'quota_monthly')
  );

CREATE OR REPLACE FUNCTION private.set_order_email_pause(_reason text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_was_paused boolean;
BEGIN
  IF _reason IS NULL
     OR _reason NOT IN ('config_api_key', 'config_sender_domain', 'config_provider', 'config_site_url', 'quota_daily', 'quota_monthly') THEN
    RAISE EXCEPTION 'INVALID_PAUSE_REASON' USING ERRCODE = '22023';
  END IF;

  SELECT p.paused INTO v_was_paused FROM private.order_email_send_pause AS p WHERE p.id FOR UPDATE;

  UPDATE private.order_email_send_pause AS p
  SET paused = true,
      reason = _reason,
      paused_at = CASE WHEN p.paused THEN p.paused_at ELSE pg_catalog.now() END,
      -- 1日の上限は UTC 0時（日本時間 9時）に戻る。それまで試さない
      next_probe_at = CASE
        WHEN _reason = 'quota_daily'
          THEN (pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
        -- 毎分の設定点検で、既に決めた試しの時刻を先へ延ばさない（止めている間は表の CHECK で必ず入っている）
        WHEN p.paused THEN p.next_probe_at
        ELSE pg_catalog.now() + interval '15 minutes'
      END,
      updated_at = pg_catalog.now()
  WHERE p.id;

  RETURN NOT COALESCE(v_was_paused, false);
END;
$$;

REVOKE ALL ON FUNCTION private.set_order_email_pause(text) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
COMMIT;
