-- 署名検証済み Stripe Event を永続化してから HTTP 2xx を返す。
-- 本番適用は明示承認後。Worker が稼働するまで入口をデプロイしない。
BEGIN;

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE public.stripe_webhook_events
  ALTER COLUMN processing_status SET DEFAULT 'queued',
  ALTER COLUMN attempt_count SET DEFAULT 0;

ALTER TABLE public.stripe_webhook_events
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_processing_status_check,
  DROP CONSTRAINT IF EXISTS stripe_webhook_events_attempt_count_check,
  ADD CONSTRAINT stripe_webhook_events_processing_status_check
    CHECK (processing_status IN ('queued', 'processing', 'completed', 'failed')),
  ADD CONSTRAINT stripe_webhook_events_attempt_count_check
    CHECK (attempt_count >= 0);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_ready_idx
  ON public.stripe_webhook_events (next_attempt_at, processed_at, id)
  WHERE processing_status IN ('queued', 'failed');

CREATE OR REPLACE FUNCTION public.enqueue_stripe_webhook_event(
  _event_id text,
  _event_type text,
  _payload jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inserted_id text;
  existing_type text;
  existing_payload jsonb;
BEGIN
  IF _event_id IS NULL OR _event_id !~ '^evt_[A-Za-z0-9_]+$'
     OR _event_type IS NULL OR pg_catalog.btrim(_event_type) = ''
     OR _payload IS NULL OR pg_catalog.jsonb_typeof(_payload) <> 'object'
     OR _payload->>'id' IS DISTINCT FROM _event_id
     OR _payload->>'type' IS DISTINCT FROM _event_type THEN
    RAISE EXCEPTION 'INVALID_STRIPE_WEBHOOK_EVENT' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.stripe_webhook_events (
    id, event_type, raw_payload, processing_status, attempt_count,
    processed_at, completed_at, last_error, next_attempt_at
  ) VALUES (
    _event_id, _event_type, _payload, 'queued', 0,
    pg_catalog.now(), NULL, NULL, pg_catalog.now()
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING id INTO inserted_id;

  IF inserted_id IS NOT NULL THEN
    RETURN true;
  END IF;

  SELECT e.event_type, e.raw_payload
    INTO existing_type, existing_payload
  FROM public.stripe_webhook_events e
  WHERE e.id = _event_id;

  -- Stripe Eventのdataは不変。pending_webhooks等の配信メタデータは再送間で異なり得る。
  IF existing_type IS DISTINCT FROM _event_type
     OR existing_payload->'data' IS DISTINCT FROM _payload->'data'
     OR existing_payload->>'account' IS DISTINCT FROM _payload->>'account'
     OR existing_payload->>'livemode' IS DISTINCT FROM _payload->>'livemode' THEN
    RAISE EXCEPTION 'STRIPE_WEBHOOK_EVENT_ID_COLLISION' USING ERRCODE = '23505';
  END IF;

  RETURN false;
END;
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
  RETURN QUERY
  WITH candidate AS (
    SELECT e.id
    FROM public.stripe_webhook_events e
    WHERE e.raw_payload IS NOT NULL
      AND (
        (e.processing_status IN ('queued', 'failed')
          AND e.next_attempt_at <= pg_catalog.now())
        OR (e.processing_status = 'processing'
          AND COALESCE(e.lease_expires_at, e.processed_at + interval '5 minutes')
            <= pg_catalog.now())
      )
    ORDER BY e.next_attempt_at, e.processed_at, e.id
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

CREATE OR REPLACE FUNCTION public.complete_stripe_webhook_event(
  _event_id text,
  _claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.stripe_webhook_events AS e
  SET processing_status = 'completed',
      completed_at = pg_catalog.now(),
      claim_token = NULL,
      lease_expires_at = NULL,
      last_error = NULL
  WHERE e.id = _event_id
    AND e.processing_status = 'processing'
    AND e.claim_token = _claim_token;

  RETURN FOUND;
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
  SET processing_status = 'failed',
      claim_token = NULL,
      lease_expires_at = NULL,
      completed_at = NULL,
      last_error = pg_catalog.left(COALESCE(_error, 'Unknown processing error'), 1000),
      next_attempt_at = pg_catalog.now()
        + pg_catalog.make_interval(secs => LEAST(1800, 30 * e.attempt_count))
  WHERE e.id = _event_id
    AND e.processing_status = 'processing'
    AND e.claim_token = _claim_token;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON TABLE public.stripe_webhook_events
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_stripe_webhook_event(text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_stripe_webhook_event()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_stripe_webhook_event(text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_stripe_webhook_event(text, uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_stripe_webhook_event(text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_stripe_webhook_event()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_stripe_webhook_event(text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_stripe_webhook_event(text, uuid, text)
  TO service_role;

COMMIT;