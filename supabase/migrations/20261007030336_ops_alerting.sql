-- 定期処理の最後の成功と、店への知らせの回数の上限（設計書 2026-10-05 グループ B の 4-6・5-2・6・8-1）。
-- あわせて、要確認の理由に「支払いから作った注文」を足し、定期処理の実行の記録を7日で消す（4-4）。
BEGIN;

CREATE TABLE IF NOT EXISTS public.ops_job_heartbeats (
  job text PRIMARY KEY CHECK (job IN ('webhook_worker', 'order_sweep', 'stripe_reconcile')),
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE IF NOT EXISTS public.ops_alert_state (
  alert_key text PRIMARY KEY CHECK (alert_key ~ '^[a-z0-9_]{1,64}$'),
  window_started_at timestamptz,
  window_count integer NOT NULL DEFAULT 0 CHECK (window_count >= 0),
  last_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.ops_job_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ops_alert_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny direct client access" ON public.ops_job_heartbeats;
CREATE POLICY "deny direct client access" ON public.ops_job_heartbeats
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny direct client access" ON public.ops_alert_state;
CREATE POLICY "deny direct client access" ON public.ops_alert_state
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

-- このプロジェクトは public の新しい表に anon・authenticated の全権限を自動で付けるので、先に剥がす。
-- 読むのも書くのも関数だけ（service_role にも表の権限を与えない）。
REVOKE ALL ON TABLE public.ops_job_heartbeats FROM anon, authenticated, service_role;
REVOKE ALL ON TABLE public.ops_alert_state FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ops_heartbeats()
RETURNS TABLE (job text, last_succeeded_at timestamptz, last_failed_at timestamptz, last_error_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT h.job, h.last_succeeded_at, h.last_failed_at, h.last_error_code
  FROM public.ops_job_heartbeats h
  ORDER BY h.job
$$;

CREATE OR REPLACE FUNCTION public.record_ops_heartbeat(
  _job text,
  _succeeded boolean,
  _error_code text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.ops_job_heartbeats AS h (job, last_succeeded_at, last_failed_at, last_error_code, updated_at)
  VALUES (
    _job,
    CASE WHEN _succeeded THEN pg_catalog.now() END,
    CASE WHEN _succeeded THEN NULL ELSE pg_catalog.now() END,
    CASE WHEN _succeeded THEN NULL ELSE _error_code END,
    pg_catalog.now()
  )
  ON CONFLICT (job) DO UPDATE SET
    last_succeeded_at = CASE WHEN _succeeded THEN pg_catalog.now() ELSE h.last_succeeded_at END,
    last_failed_at = CASE WHEN _succeeded THEN h.last_failed_at ELSE pg_catalog.now() END,
    last_error_code = CASE WHEN _succeeded THEN h.last_error_code ELSE _error_code END,
    updated_at = pg_catalog.now();
END;
$$;

-- 短い間の件数を数える（署名不正・モード違い）。1件ずつ行を足さず、同じ1行を更新する（R-05）。
CREATE OR REPLACE FUNCTION public.bump_ops_signal(_alert_key text, _window_seconds integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF _window_seconds IS NULL OR _window_seconds <= 0 THEN
    RAISE EXCEPTION 'INVALID_WINDOW_SECONDS' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ops_alert_state AS s (alert_key, window_started_at, window_count, updated_at)
  VALUES (_alert_key, pg_catalog.now(), 1, pg_catalog.now())
  ON CONFLICT (alert_key) DO UPDATE SET
    window_started_at = CASE
      WHEN s.window_started_at IS NULL
        OR s.window_started_at <= pg_catalog.now() - pg_catalog.make_interval(secs => _window_seconds)
      THEN pg_catalog.now()
      ELSE s.window_started_at
    END,
    window_count = CASE
      WHEN s.window_started_at IS NULL
        OR s.window_started_at <= pg_catalog.now() - pg_catalog.make_interval(secs => _window_seconds)
      THEN 1
      ELSE s.window_count + 1
    END,
    updated_at = pg_catalog.now()
  RETURNING s.window_count INTO v_count;
  RETURN v_count;
END;
$$;

-- 知らせを送る権利を取る。最後に送ってから _cooldown_seconds 以内なら取れない（同時に動いても2通にならない）。
CREATE OR REPLACE FUNCTION public.claim_ops_alert(_alert_key text, _cooldown_seconds integer)
RETURNS TABLE (claimed boolean, claimed_at timestamptz, previous_sent_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_previous timestamptz;
BEGIN
  IF _cooldown_seconds IS NULL OR _cooldown_seconds <= 0 THEN
    RAISE EXCEPTION 'INVALID_COOLDOWN_SECONDS' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ops_alert_state (alert_key) VALUES (_alert_key)
  ON CONFLICT (alert_key) DO NOTHING;

  SELECT s.last_sent_at INTO v_previous
  FROM public.ops_alert_state s
  WHERE s.alert_key = _alert_key
  FOR UPDATE;

  IF v_previous IS NOT NULL
     AND v_previous > pg_catalog.now() - pg_catalog.make_interval(secs => _cooldown_seconds) THEN
    RETURN QUERY SELECT false, NULL::timestamptz, v_previous;
    RETURN;
  END IF;

  UPDATE public.ops_alert_state
  SET last_sent_at = pg_catalog.now(), updated_at = pg_catalog.now()
  WHERE alert_key = _alert_key;

  RETURN QUERY SELECT true, pg_catalog.now(), v_previous;
END;
$$;

-- 送れなかったとき、取った権利を返す。後から別の誰かが取っていたら（時刻が違えば）何もしない。
CREATE OR REPLACE FUNCTION public.release_ops_alert(
  _alert_key text,
  _claimed_at timestamptz,
  _previous_sent_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.ops_alert_state
  SET last_sent_at = _previous_sent_at, updated_at = pg_catalog.now()
  WHERE alert_key = _alert_key
    AND last_sent_at = _claimed_at;
  RETURN FOUND;
END;
$$;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_review_reason_check,
  ADD CONSTRAINT orders_review_reason_check
    CHECK (review_reason IN ('stock_not_reserved', 'recovered_from_payment'));

-- 見回りが「注文の無い支払い」から作った注文に、要確認を付ける（設計書 3-6）。
-- 在庫の理由（stock_not_reserved）が先に付いていれば、それを残す。付けた後の理由を返す。
CREATE OR REPLACE FUNCTION public.mark_order_recovered_from_payment(_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_reason text;
BEGIN
  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'order_sweep_recovered_from_payment', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  UPDATE public.orders AS o
  SET review_reason = 'recovered_from_payment',
      review_marked_at = pg_catalog.now()
  WHERE o.id = _order_id
    AND o.review_reason IS NULL
    AND o.reviewed_at IS NULL;

  SELECT o.review_reason INTO v_reason FROM public.orders o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN v_reason;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ops_heartbeats() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_ops_heartbeat(text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_ops_signal(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_ops_alert(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ops_alert(text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_recovered_from_payment(uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_ops_heartbeats() TO service_role;
GRANT EXECUTE ON FUNCTION public.record_ops_heartbeat(text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_ops_signal(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_ops_alert(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ops_alert(text, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_recovered_from_payment(uuid) TO service_role;

-- 定期処理の実行の記録は自動では消えない。Supabase の例どおり、7日を残して毎日消す（R-32）。
-- 同名のジョブは置き換わる（cron.schedule はジョブ名で upsert する）。cron スキーマへの grant は書かない。
SELECT cron.schedule(
  'cron-job-run-details-retention',
  '0 19 * * *',
  $$ DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days' $$
);

COMMIT;
