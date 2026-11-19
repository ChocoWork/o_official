-- Passkey stage 3b / Task 17 (migration I): the dead-notification check and the heartbeat of the passkey notification worker
-- (SR-AUTH-029, FR-AUTH-049, DATA-AUTH-022, SEC-AUTH-058, DD-AUTH-089, ADR-0474, ARC-AUTH-014).
-- It ADDS one column (private.passkey_notification_outbox.dead_notified_at), one partial index and two public functions, and
-- widens ops_job_heartbeats_job_check with the ninth job passkey_notification_worker. No new table.
--
-- Column: dead_notified_at timestamptz (NULL = the shop was not told yet). Partial index on (finished_at, seq) for
--   status = 'dead' AND dead_notified_at IS NULL.
--
-- Functions (SECURITY DEFINER, search_path empty, owner postgres, execute for service_role only; neither returns an address or a body):
--   public.list_unnotified_dead_passkey_notifications(_limit integer)
--     returns table (id uuid, kind text, attempts integer, last_error_code text, finished_at timestamptz, total bigint)
--     the dead rows with dead_notified_at NULL, oldest finished_at first; _limit is clamped to 0..100; total = all rows waiting.
--   public.mark_passkey_notification_dead_notified(_ids uuid[]) returns integer
--     stamps dead_notified_at on the given rows that are still dead and not stamped; a second call returns 0.
--
-- Any later migration that changes ops_job_heartbeats_job_check MUST keep 'passkey_notification_worker' in the list
-- (the precheck below stops this migration on a list it does not know).
--
-- ROLLBACK (one transaction; step 1 first, because the CHECK cannot be restored while the heartbeat row exists):
--   1. DELETE FROM public.ops_job_heartbeats WHERE job = 'passkey_notification_worker';
--   2. restore the CHECK to the definition saved BEFORE applying I (see below). If I was applied in case (b) (the list already held
--      passkey_notification_worker, NOTICE 'passkey_i_job_check_already_present'), I did not change the CHECK: do not touch it.
--        ALTER TABLE public.ops_job_heartbeats DROP CONSTRAINT ops_job_heartbeats_job_check,
--          ADD CONSTRAINT ops_job_heartbeats_job_check <the saved definition, as printed by pg_get_constraintdef>;
--   3. DROP FUNCTION public.mark_passkey_notification_dead_notified(uuid[]),
--        public.list_unnotified_dead_passkey_notifications(integer);
--      DROP INDEX private.passkey_notification_outbox_dead_unnotified_idx;
--      ALTER TABLE private.passkey_notification_outbox DROP COLUMN dead_notified_at;
--
-- BEFORE applying to production (read only): this migration is NOT applied to production until stage 3b is released.
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'ops_job_heartbeats_job_check';   -- SAVE the output (ROLLBACK step 2)
--   select to_regclass('private.passkey_notification_outbox');   -- expect not null (migration A)
--   select count(*) from information_schema.columns where table_schema='private' and table_name='passkey_notification_outbox'
--     and column_name in ('status', 'finished_at', 'last_error_code', 'attempts', 'kind');   -- expect 5 (A and G)

BEGIN;

-- 1. precheck. The job list is compared as a SET (names pulled out with regexp_matches and sorted), not as a string.
--    (a) exactly the 8 known jobs: step 2 rebuilds the CHECK with 9. (b) it already holds passkey_notification_worker: NOTICE, the
--    CHECK is not touched. Anything else (another job a later migration or production added): stop.
DO $$
DECLARE
  v_def text;
  v_names text[];
BEGIN
  IF to_regclass('private.passkey_notification_outbox') IS NULL
     OR to_regclass('public.ops_job_heartbeats') IS NULL
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'private' AND table_name = 'passkey_notification_outbox'
            AND column_name IN ('status', 'finished_at', 'last_error_code', 'attempts', 'kind')) <> 5 THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_i_precheck';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.ops_job_heartbeats'::regclass AND c.conname = 'ops_job_heartbeats_job_check' AND c.contype = 'c';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_i_job_check_drift';
  END IF;

  SELECT array_agg(m[1] ORDER BY m[1]) INTO v_names FROM regexp_matches(v_def, '''([^'']+)''::text', 'g') AS m;

  IF v_names @> ARRAY['passkey_notification_worker'] THEN
    RAISE NOTICE 'passkey_i_job_check_already_present: ops_job_heartbeats_job_check already holds passkey_notification_worker; it is left as it is';
  ELSIF v_names IS DISTINCT FROM ARRAY['accounting_post', 'delivery_tracking', 'order_email_delivery_check', 'order_email_worker',
      'order_sweep', 'return_photo_purge', 'stripe_reconcile', 'webhook_worker'] THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_i_job_check_drift';
  END IF;
END
$$;

-- 2. the job CHECK with the ninth job (skipped when the set already holds it: case (b))
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.ops_job_heartbeats'::regclass AND c.conname = 'ops_job_heartbeats_job_check' AND c.contype = 'c';
  IF v_def NOT LIKE '%''passkey_notification_worker''%' THEN
    ALTER TABLE public.ops_job_heartbeats
      DROP CONSTRAINT ops_job_heartbeats_job_check,
      ADD CONSTRAINT ops_job_heartbeats_job_check CHECK (
        job IN ('webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check', 'return_photo_purge', 'delivery_tracking', 'accounting_post', 'passkey_notification_worker')
      );
  END IF;
END
$$;

-- 3. the column and the partial index
ALTER TABLE private.passkey_notification_outbox ADD COLUMN dead_notified_at timestamptz;
CREATE INDEX passkey_notification_outbox_dead_unnotified_idx
  ON private.passkey_notification_outbox (finished_at, seq) WHERE status = 'dead' AND dead_notified_at IS NULL;

-- 4. the two functions (no address, no body)
CREATE OR REPLACE FUNCTION public.list_unnotified_dead_passkey_notifications(_limit integer)
RETURNS TABLE (id uuid, kind text, attempts integer, last_error_code text, finished_at timestamptz, total bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.id, o.kind, o.attempts, o.last_error_code, o.finished_at, pg_catalog.count(*) OVER ()
  FROM private.passkey_notification_outbox AS o
  WHERE o.status = 'dead'
    AND o.dead_notified_at IS NULL
  ORDER BY o.finished_at, o.seq
  LIMIT LEAST(GREATEST(COALESCE(_limit, 0), 0), 100)
$$;

CREATE OR REPLACE FUNCTION public.mark_passkey_notification_dead_notified(_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE private.passkey_notification_outbox AS o
  SET dead_notified_at = pg_catalog.now()
  WHERE o.id = ANY(_ids)
    AND o.status = 'dead'
    AND o.dead_notified_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.list_unnotified_dead_passkey_notifications(integer),
  public.mark_passkey_notification_dead_notified(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_unnotified_dead_passkey_notifications(integer),
  public.mark_passkey_notification_dead_notified(uuid[]) TO service_role;
ALTER FUNCTION public.list_unnotified_dead_passkey_notifications(integer) OWNER TO postgres;
ALTER FUNCTION public.mark_passkey_notification_dead_notified(uuid[]) OWNER TO postgres;

-- PASSKEY_I_FINAL_ASSERT
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.list_unnotified_dead_passkey_notifications(integer)', 'public.mark_passkey_notification_dead_notified(uuid[])'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_i_function_acl';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = f::regprocedure AND p.prosecdef AND p.proowner = 'postgres'::regrole
        AND p.proconfig @> ARRAY['search_path=""']
    ) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_i_function_attrs';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'private' AND table_name = 'passkey_notification_outbox' AND column_name = 'dead_notified_at')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes
                     WHERE schemaname = 'private' AND indexname = 'passkey_notification_outbox_dead_unnotified_idx') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_i_column';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.ops_job_heartbeats'::regclass AND c.conname = 'ops_job_heartbeats_job_check'
                    AND pg_get_constraintdef(c.oid) LIKE '%''passkey_notification_worker''%') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_i_job_check';
  END IF;
END
$$;
-- PASSKEY_I_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
