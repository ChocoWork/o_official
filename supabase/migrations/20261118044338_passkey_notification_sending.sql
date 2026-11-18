-- Passkey stage 2 / Task 8 (migration G): DB functions that let a worker claim and finish the notification rows
-- the stage 1a triggers queue in private.passkey_notification_outbox (SR-AUTH-025, FR-AUTH-030, DATA-AUTH-019,
-- DD-AUTH-066, SEC-AUTH-051).
-- Adds 5 columns + 2 CHECKs + 1 index to the outbox, and 5 functions. Nothing calls them until Task 9 ships the worker.
-- Existing rows stay 'pending'. No new table.
--
-- Columns added to private.passkey_notification_outbox:
--   lease_token uuid, lease_expires_at timestamptz   set together with status 'sending' (CHECK), cleared otherwise
--   last_error_code text                             ^[a-z0-9_]{1,64}$
--   sent_at timestamptz, finished_at timestamptz     sent_at on 'sent'; finished_at on 'sent' / 'skipped' / 'dead'
--
-- Functions (SECURITY DEFINER, search_path empty, owner postgres, execute for service_role only):
--   public.claim_passkey_notification(_lease_seconds integer)   returns the oldest due row (seq order), FOR UPDATE SKIP
--                                                             LOCKED, as 'sending' with attempts + 1 and a new lease_token.
--                                                             First puts expired leases back to 'retry_wait' ('dead' when
--                                                             attempts >= 9), waiting the same backoff as fail. _lease_seconds must be 30..900 (else 22023).
--                                                             While the shared order mail send pause is on, only a due
--                                                             retry_wait row whose last_error_code is a sender config code
--                                                             (quota_*, config_*) is claimed; none due -> nothing; no such
--                                                             row (retry_wait or sending) -> 1 normal row (the first probe).
--                                                             The name is read at claim time: friendly_name is set to the
--                                                             credential's current name in auth.webauthn_credentials (a removed
--                                                             key keeps the name recorded at delete time), because GoTrue
--                                                             inserts the key as 'Passkey' and the screen renames it afterwards.
--                                                             A passkey_added row that has a passkey_id is not claimed for 30 seconds
--                                                             after occurred_at, so the rename lands first.
--   public.complete_passkey_notification(_id, _lease_token)    'sent' only when the token matches; else false.
--                                                             Also clears the shared send pause.
--   public.fail_passkey_notification(_id, _lease_token, _error_code, _retry_after_seconds, _count_attempt DEFAULT true)
--                                                             _count_attempt true: 'dead' at attempts >= 9, else 'retry_wait' with
--                                                             next_attempt_at = now() + max(least(_retry_after_seconds, 86400),
--                                                             60 * 2^(attempts-1) seconds, capped at 128 minutes). No jitter.
--                                                             _count_attempt false (sender config failure: quota, key,
--                                                             sender domain): attempts - 1, retry_wait, due in
--                                                             max(900, _retry_after_seconds) s (capped at 86400) and not before the
--                                                             pause's next probe time, never dead, and
--                                                             private.set_order_email_pause in the same transaction
--                                                             (same as fail_order_email 'config').
--   public.skip_passkey_notification(_id, _lease_token, _reason)  'skipped' (row has no recipient)
--   public.passkey_notification_recipients(_id)                (email, audience): subject_customer / subject_staff first,
--                                                             then every active, unexpired admin when subject_is_staff.
--                                                             Admins with auth.users.deleted_at set or banned_until in the
--                                                             future are excluded.
--
-- ROLLBACK (one transaction, only while nothing uses them):
--   DROP FUNCTION public.passkey_notification_recipients(uuid), public.skip_passkey_notification(uuid, uuid, text),
--     public.fail_passkey_notification(uuid, uuid, text, integer, boolean), public.complete_passkey_notification(uuid, uuid),
--     public.claim_passkey_notification(integer);
--   DROP INDEX private.passkey_notification_outbox_lease_idx;
--   ALTER TABLE private.passkey_notification_outbox DROP CONSTRAINT passkey_notification_outbox_lease_check,
--     DROP CONSTRAINT passkey_notification_outbox_last_error_code_check,
--     DROP COLUMN lease_token, DROP COLUMN lease_expires_at, DROP COLUMN last_error_code,
--     DROP COLUMN sent_at, DROP COLUMN finished_at;
--
-- BEFORE applying to production (read only): this migration is NOT applied to production until stage 3.
--   select to_regclass('private.passkey_notification_outbox');   -- expect not null (migration A)
--   select to_regclass('private.order_email_send_pause');        -- expect not null (order mail; the shared send pause)
--   select to_regclass('auth.webauthn_credentials');             -- expect not null (claim reads the current key name)

BEGIN;

DO $$
BEGIN
  IF to_regclass('private.passkey_notification_outbox') IS NULL
     OR to_regclass('private.order_email_send_pause') IS NULL
     OR to_regclass('public.user_roles') IS NULL
     OR to_regclass('public.roles') IS NULL
     OR to_regclass('auth.users') IS NULL
     OR to_regclass('auth.webauthn_credentials') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_g_precheck';
  END IF;
END
$$;

ALTER TABLE private.passkey_notification_outbox
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN finished_at timestamptz;
ALTER TABLE private.passkey_notification_outbox
  ADD CONSTRAINT passkey_notification_outbox_last_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT passkey_notification_outbox_lease_check
    CHECK ((status = 'sending') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL));
CREATE INDEX passkey_notification_outbox_lease_idx
  ON private.passkey_notification_outbox (lease_expires_at) WHERE status = 'sending';

CREATE OR REPLACE FUNCTION public.claim_passkey_notification(_lease_seconds integer)
RETURNS TABLE (
  id uuid, seq bigint, user_id uuid, kind text, passkey_id uuid, friendly_name text,
  subject_is_staff boolean, notify_subject boolean, subject_email text, occurred_at timestamptz,
  attempts integer, lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_id uuid;
  v_paused boolean;
BEGIN
  IF _lease_seconds IS NULL OR _lease_seconds < 30 OR _lease_seconds > 900 THEN
    RAISE EXCEPTION 'claim_passkey_notification: lease seconds out of range' USING ERRCODE = '22023';
  END IF;

  UPDATE private.passkey_notification_outbox o
     SET status = CASE WHEN o.attempts >= 9 THEN 'dead' ELSE 'retry_wait' END,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error_code = 'lease_expired',
         next_attempt_at = pg_catalog.now()
           + pg_catalog.make_interval(secs => 60 * (2 ^ LEAST(GREATEST(o.attempts - 1, 0), 7))),
         finished_at = CASE WHEN o.attempts >= 9 THEN pg_catalog.now() END
   WHERE o.status = 'sending' AND o.lease_expires_at <= pg_catalog.now();

  -- While the shared order mail send pause is on, this worker is its own prober (order mail's claim moves the pause's probe
  -- time only when a probe is due, then 15 minutes ahead; it does not move it every minute). A row whose last failure
  -- was a sender config failure (last_error_code is one of the config codes, which only a no-count fail writes) is the probe: only that row may be claimed, and only when it is due. With no such
  -- row yet, one normal row is claimed (the first probe). A probe row that is being held (sending) also blocks the others.
  -- The config code list below (both places in this function) is the same list as private.set_order_email_pause's allowed
  -- reasons and the order_email_send_pause reason CHECK: when one changes, change all of them together.
  SELECT p.paused INTO v_paused FROM private.order_email_send_pause p WHERE p.id;
  IF COALESCE(v_paused, false) AND EXISTS (
       SELECT 1 FROM private.passkey_notification_outbox o
        WHERE o.status IN ('retry_wait', 'sending')
          AND o.last_error_code IN ('config_api_key', 'config_sender_domain', 'config_provider', 'config_site_url', 'quota_daily', 'quota_monthly')) THEN
    SELECT o.id INTO v_id
      FROM private.passkey_notification_outbox o
     WHERE o.status = 'retry_wait' AND o.next_attempt_at <= pg_catalog.now()
       AND o.last_error_code IN ('config_api_key', 'config_sender_domain', 'config_provider', 'config_site_url', 'quota_daily', 'quota_monthly')
       AND NOT (o.kind = 'passkey_added' AND o.passkey_id IS NOT NULL AND o.occurred_at > pg_catalog.now() - interval '30 seconds')
     ORDER BY o.seq
     LIMIT 1
     FOR UPDATE SKIP LOCKED;
  ELSE
    SELECT o.id INTO v_id
      FROM private.passkey_notification_outbox o
     WHERE o.status IN ('pending', 'retry_wait') AND o.next_attempt_at <= pg_catalog.now()
       AND NOT (o.kind = 'passkey_added' AND o.passkey_id IS NOT NULL AND o.occurred_at > pg_catalog.now() - interval '30 seconds')
     ORDER BY o.seq
     LIMIT 1
     FOR UPDATE SKIP LOCKED;
  END IF;
  IF v_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH u AS (
    UPDATE private.passkey_notification_outbox o
       SET status = 'sending',
           attempts = o.attempts + 1,
           friendly_name = COALESCE((SELECT w.friendly_name FROM auth.webauthn_credentials w
                                      WHERE w.id = o.passkey_id AND w.user_id = o.user_id), o.friendly_name),
           lease_token = gen_random_uuid(),
           lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => _lease_seconds)
     WHERE o.id = v_id
    RETURNING o.id, o.seq, o.user_id, o.kind, o.passkey_id, o.friendly_name, o.subject_is_staff,
              o.notify_subject, o.subject_email, o.occurred_at, o.attempts, o.lease_token
  )
  SELECT u.id, u.seq, u.user_id, u.kind, u.passkey_id, u.friendly_name, u.subject_is_staff,
         u.notify_subject, u.subject_email, u.occurred_at, u.attempts, u.lease_token
    FROM u;
END
$$;

CREATE OR REPLACE FUNCTION public.complete_passkey_notification(_id uuid, _lease_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE private.passkey_notification_outbox o
     SET status = 'sent', sent_at = pg_catalog.now(), finished_at = pg_catalog.now(),
         lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL
   WHERE o.id = _id AND o.status = 'sending' AND o.lease_token = _lease_token;
  IF FOUND THEN
    -- like complete_order_email: a finished send clears the shared send pause (the passkey worker probes while it is paused)
    UPDATE private.order_email_send_pause p
       SET paused = false, reason = NULL, paused_at = NULL, next_probe_at = NULL, updated_at = pg_catalog.now()
     WHERE p.id AND p.paused;
    RETURN true;
  END IF;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION public.fail_passkey_notification(
  _id uuid, _lease_token uuid, _error_code text, _retry_after_seconds integer, _count_attempt boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _error_code IS NULL OR _error_code !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'fail_passkey_notification: invalid error code' USING ERRCODE = '22023';
  END IF;
  IF _count_attempt IS FALSE THEN
    UPDATE private.passkey_notification_outbox o
       SET status = 'retry_wait', attempts = GREATEST(o.attempts - 1, 0),
           next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(_retry_after_seconds, 0), 900), 86400)),
           last_error_code = _error_code, lease_token = NULL, lease_expires_at = NULL
     WHERE o.id = _id AND o.status = 'sending' AND o.lease_token = _lease_token;
    IF FOUND THEN
      -- same transaction as order mail's fail 'config': the shared send pause (same sender) is written with the row
      PERFORM private.set_order_email_pause(_error_code);
      -- probe cadence like order mail: not before the pause's own next probe time (quota_daily: UTC midnight); at least 900 s
      UPDATE private.passkey_notification_outbox o
         SET next_attempt_at = GREATEST(o.next_attempt_at,
               COALESCE((SELECT p.next_probe_at FROM private.order_email_send_pause p WHERE p.id), o.next_attempt_at))
       WHERE o.id = _id;
      RETURN true;
    END IF;
    RETURN false;
  END IF;
  UPDATE private.passkey_notification_outbox o
     SET status = CASE WHEN o.attempts >= 9 THEN 'dead' ELSE 'retry_wait' END,
         next_attempt_at = CASE WHEN o.attempts >= 9 THEN o.next_attempt_at ELSE
           pg_catalog.now() + pg_catalog.make_interval(secs => GREATEST(
             LEAST(GREATEST(COALESCE(_retry_after_seconds, 0), 0), 86400)::double precision,
             60 * (2 ^ LEAST(GREATEST(o.attempts - 1, 0), 7))
           )) END,
         finished_at = CASE WHEN o.attempts >= 9 THEN pg_catalog.now() END,
         last_error_code = _error_code,
         lease_token = NULL, lease_expires_at = NULL
   WHERE o.id = _id AND o.status = 'sending' AND o.lease_token = _lease_token;
  RETURN FOUND;
END
$$;

CREATE OR REPLACE FUNCTION public.skip_passkey_notification(_id uuid, _lease_token uuid, _reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _reason IS NULL OR _reason !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'skip_passkey_notification: invalid reason' USING ERRCODE = '22023';
  END IF;
  UPDATE private.passkey_notification_outbox o
     SET status = 'skipped', finished_at = pg_catalog.now(), last_error_code = _reason,
         lease_token = NULL, lease_expires_at = NULL
   WHERE o.id = _id AND o.status = 'sending' AND o.lease_token = _lease_token;
  RETURN FOUND;
END
$$;

CREATE OR REPLACE FUNCTION public.passkey_notification_recipients(_id uuid)
RETURNS TABLE (email text, audience text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH o AS (
    SELECT n.subject_email, n.subject_is_staff, n.notify_subject
      FROM private.passkey_notification_outbox n WHERE n.id = _id
  ),
  everyone AS (
    SELECT btrim(o.subject_email) AS addr,
           CASE WHEN o.subject_is_staff THEN 'subject_staff' ELSE 'subject_customer' END AS aud,
           0 AS ord
      FROM o
     WHERE o.notify_subject AND btrim(COALESCE(o.subject_email, '')) <> ''
    UNION ALL
    SELECT btrim(u.email), 'admin', 1
      FROM o
      JOIN public.user_roles ur ON o.subject_is_staff
      JOIN public.roles r ON r.id = ur.role_id
      JOIN auth.users u ON u.id = ur.user_id
     WHERE r.code = 'admin' AND ur.active
       AND (ur.expires_at IS NULL OR ur.expires_at > pg_catalog.now())
       AND btrim(COALESCE(u.email, '')) <> ''
       AND u.deleted_at IS NULL
       AND (u.banned_until IS NULL OR u.banned_until <= pg_catalog.now())
  ),
  ranked AS (
    SELECT e.addr, e.aud, e.ord,
           row_number() OVER (PARTITION BY lower(e.addr) ORDER BY e.ord, e.addr) AS rn
      FROM everyone e
  )
  SELECT k.addr, k.aud FROM ranked k WHERE k.rn = 1 ORDER BY k.ord, k.addr
$$;

REVOKE ALL ON FUNCTION public.claim_passkey_notification(integer),
  public.complete_passkey_notification(uuid, uuid),
  public.fail_passkey_notification(uuid, uuid, text, integer, boolean),
  public.skip_passkey_notification(uuid, uuid, text),
  public.passkey_notification_recipients(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_passkey_notification(integer),
  public.complete_passkey_notification(uuid, uuid),
  public.fail_passkey_notification(uuid, uuid, text, integer, boolean),
  public.skip_passkey_notification(uuid, uuid, text),
  public.passkey_notification_recipients(uuid) TO service_role;

ALTER FUNCTION public.claim_passkey_notification(integer) OWNER TO postgres;
ALTER FUNCTION public.complete_passkey_notification(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.fail_passkey_notification(uuid, uuid, text, integer, boolean) OWNER TO postgres;
ALTER FUNCTION public.skip_passkey_notification(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION public.passkey_notification_recipients(uuid) OWNER TO postgres;

-- PASSKEY_G_FINAL_ASSERT
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.claim_passkey_notification(integer)', 'public.complete_passkey_notification(uuid,uuid)',
    'public.fail_passkey_notification(uuid,uuid,text,integer,boolean)', 'public.skip_passkey_notification(uuid,uuid,text)',
    'public.passkey_notification_recipients(uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_g_function_acl';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = f::regprocedure AND p.prosecdef AND p.proowner = 'postgres'::regrole
        AND p.proconfig @> ARRAY['search_path=""']
    ) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_g_function_attrs';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'private' AND table_name = 'passkey_notification_outbox'
         AND column_name IN ('lease_token', 'lease_expires_at', 'last_error_code', 'sent_at', 'finished_at')) <> 5
     OR (SELECT count(*) FROM pg_constraint
          WHERE conrelid = 'private.passkey_notification_outbox'::regclass
            AND conname IN ('passkey_notification_outbox_lease_check', 'passkey_notification_outbox_last_error_code_check')) <> 2
     OR has_table_privilege('anon', 'private.passkey_notification_outbox', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'private.passkey_notification_outbox', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_g_outbox';
  END IF;
END
$$;
-- PASSKEY_G_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
