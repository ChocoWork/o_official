-- Stripe の知らせのキュー: 受け取った時刻・退避（dead）・倍々のやり直し（設計書 2026-10-05 グループ B の 3-2・3-4・8-1）
--
-- - received_at: 受け取った時刻。processed_at は取り出すたびに書き換わるので、溜まりの点検に使えない
-- - 失敗した試行の回数 n に対し、次の試行は 2^(n-1) 分後（1・2・4…128分）。最初の試行と合わせて9回試し、
--   9回目も失敗したら dead（退避）にして取り出さない（Shopify の「4時間で8回やり直す」に合わせた）
-- - 処理の途中で担当の期限（5分）が切れた試行も1回の失敗として数える（原因 lease_expired）
BEGIN;

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_notified_at timestamptz;

-- 今ある行は、最後に取り出した時刻で埋める（それより前の受け取った時刻は残っていない）
UPDATE public.stripe_webhook_events SET received_at = processed_at WHERE received_at IS NULL;

ALTER TABLE public.stripe_webhook_events
  ALTER COLUMN received_at SET DEFAULT pg_catalog.now(),
  ALTER COLUMN received_at SET NOT NULL;

ALTER TABLE public.stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_processing_status_check,
  ADD CONSTRAINT stripe_webhook_events_processing_status_check
    CHECK (processing_status IN ('queued', 'processing', 'completed', 'failed', 'dead'));

-- 溜まりの点検（受け取ってから15分以上たって完了していない知らせ）
CREATE INDEX IF NOT EXISTS stripe_webhook_events_backlog_idx
  ON public.stripe_webhook_events (received_at)
  WHERE processing_status IN ('queued', 'processing', 'failed');

-- まだ店へ知らせていない退避
CREATE INDEX IF NOT EXISTS stripe_webhook_events_dead_unnotified_idx
  ON public.stripe_webhook_events (dead_at)
  WHERE processing_status = 'dead' AND dead_notified_at IS NULL;

CREATE OR REPLACE FUNCTION private.stripe_webhook_max_attempts()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT 9
$$;

CREATE OR REPLACE FUNCTION private.stripe_webhook_retry_delay(_failed_attempts integer)
RETURNS interval
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT pg_catalog.make_interval(mins => (2 ^ GREATEST(_failed_attempts - 1, 0))::integer)
$$;

CREATE OR REPLACE FUNCTION public.claim_stripe_webhook_event()
RETURNS TABLE (
  event_id text,
  event_type text,
  raw_payload jsonb,
  claim_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 処理の途中で担当の期限が切れた試行は、1回の失敗として数える。9回目なら退避にする。
  UPDATE public.stripe_webhook_events AS e
  SET processing_status = CASE
        WHEN e.attempt_count >= private.stripe_webhook_max_attempts() THEN 'dead'
        ELSE 'failed'
      END,
      dead_at = CASE
        WHEN e.attempt_count >= private.stripe_webhook_max_attempts() THEN pg_catalog.now()
        ELSE NULL
      END,
      claim_token = NULL,
      lease_expires_at = NULL,
      last_error = 'lease_expired',
      next_attempt_at = pg_catalog.now() + private.stripe_webhook_retry_delay(e.attempt_count)
  WHERE e.processing_status = 'processing'
    AND COALESCE(e.lease_expires_at, e.processed_at + interval '5 minutes') <= pg_catalog.now();

  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM public.stripe_webhook_events e
    WHERE e.raw_payload IS NOT NULL
      AND e.processing_status IN ('queued', 'failed')
      AND e.next_attempt_at <= pg_catalog.now()
    ORDER BY e.next_attempt_at, e.received_at, e.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.stripe_webhook_events AS e
  SET processing_status = 'processing',
      attempt_count = e.attempt_count + 1,
      processed_at = pg_catalog.now(),
      claim_token = pg_catalog.gen_random_uuid(),
      lease_expires_at = pg_catalog.now() + interval '5 minutes',
      last_error = NULL
  FROM candidate c
  WHERE e.id = c.id
  RETURNING e.id, e.event_type, e.raw_payload, e.claim_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_stripe_webhook_event(
  _event_id text,
  _claim_token uuid,
  _error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stripe_webhook_events AS e
  SET processing_status = CASE
        WHEN e.attempt_count >= private.stripe_webhook_max_attempts() THEN 'dead'
        ELSE 'failed'
      END,
      dead_at = CASE
        WHEN e.attempt_count >= private.stripe_webhook_max_attempts() THEN pg_catalog.now()
        ELSE NULL
      END,
      claim_token = NULL,
      lease_expires_at = NULL,
      completed_at = NULL,
      last_error = pg_catalog.left(COALESCE(_error, 'unexpected_error'), 1000),
      next_attempt_at = pg_catalog.now() + private.stripe_webhook_retry_delay(e.attempt_count)
  WHERE e.id = _event_id
    AND e.processing_status = 'processing'
    AND e.claim_token = _claim_token;

  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_stripe_webhook_dead_notified(_event_ids text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.stripe_webhook_events AS e
  SET dead_notified_at = pg_catalog.now()
  WHERE e.id = ANY(_event_ids)
    AND e.processing_status = 'dead'
    AND e.dead_notified_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 溜まりの点検: 受け取ってから _older_than_seconds 以上たって完了していない知らせを、状態ごとに数える。
-- 中身（raw_payload）は返さない。原因の記号だけを返す。
CREATE OR REPLACE FUNCTION public.get_stripe_webhook_backlog(_older_than_seconds integer)
RETURNS TABLE (
  processing_status text,
  event_count integer,
  oldest_received_at timestamptz,
  last_errors text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.processing_status,
         pg_catalog.count(*)::integer,
         pg_catalog.min(e.received_at),
         pg_catalog.array_remove(pg_catalog.array_agg(DISTINCT e.last_error), NULL)
  FROM public.stripe_webhook_events e
  WHERE e.processing_status IN ('queued', 'processing', 'failed')
    AND e.received_at <= pg_catalog.now() - pg_catalog.make_interval(secs => _older_than_seconds)
  GROUP BY e.processing_status
  ORDER BY e.processing_status
$$;

-- まだ店へ知らせていない退避を、古い順に _limit 件まで返す。total_count は上限に関係なく全件の数。
CREATE OR REPLACE FUNCTION public.list_unnotified_dead_stripe_webhook_events(_limit integer)
RETURNS TABLE (
  event_id text,
  event_type text,
  last_error text,
  received_at timestamptz,
  attempt_count integer,
  dead_at timestamptz,
  total_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.event_type, e.last_error, e.received_at, e.attempt_count, e.dead_at,
         (pg_catalog.count(*) OVER ())::integer
  FROM public.stripe_webhook_events e
  WHERE e.processing_status = 'dead'
    AND e.dead_notified_at IS NULL
  ORDER BY e.dead_at, e.id
  LIMIT _limit
$$;

REVOKE ALL ON FUNCTION private.stripe_webhook_max_attempts() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.stripe_webhook_retry_delay(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_stripe_webhook_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_stripe_webhook_event(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_stripe_webhook_dead_notified(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_stripe_webhook_backlog(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unnotified_dead_stripe_webhook_events(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_stripe_webhook_event() TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_stripe_webhook_event(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_stripe_webhook_dead_notified(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_stripe_webhook_backlog(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_unnotified_dead_stripe_webhook_events(integer) TO service_role;

COMMIT;
