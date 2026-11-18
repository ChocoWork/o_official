-- Passkey stage 1a / Task 8 (migration D): the three admin-entry conditions as SQL functions (SR-AUTH-014, DD-AUTH-047, ADR-0463, SEC-AUTH-039).
-- It only ADDS functions and one table (the three entry-condition functions, plus the staff idle table and its four functions below).
-- has_permission and the API gate are NOT changed here (migration E wires them), so nothing changes for anyone yet.
--
-- private.staff_passkey_amr_ok(claims jsonb) boolean     conditions 1 and 2 (cheap; reads claims and settings only)
--   claims.amr must be a JSON array. Valid elements: object, method = 'passkey', timestamp a JSON number holding an integer.
--   The latest valid timestamp T wins. true when -60 <= floor(now) - T <= staff_max_session_seconds (T more than 60 s in the future is false).
--   Anything else (no claims, amr missing / null / not an array / empty, string timestamp, only oauth / otp) is false.
-- private.staff_passkey_count_ok(p_user_id uuid) boolean  condition 3, counted in the DB on every call (never from the JWT hint
--   staff_passkeys_ok): public.passkey_approved_count(user) >= min_approved_passkeys (same join incl. credential_id).
-- private.staff_passkey_entry_ok(p_user_id uuid, claims jsonb) boolean   both; the cheap check first.
--
-- Stage 3a / Task 3 (SR-AUTH-028, FR-AUTH-044, DD-AUTH-074, DATA-AUTH-021, ADR-0472, SEC-AUTH-055): staff idle 1 hour (condition 4).
-- private.staff_session_activity(session_id uuid pk, user_id uuid, last_seen_at timestamptz)   RLS on, no anon / authenticated privilege.
--   The idle clock is an app table, not auth.sessions.refreshed_at (GoTrue moves that only on a token refresh, not on a page use).
-- public.staff_session_touch(p_session_id, p_user_id, p_min_interval_seconds default 60) boolean   service_role. Insert when no row;
--   update when the row is at least the interval old (true); otherwise false. A write also deletes that user's rows older than 2 days.
-- private.staff_idle_ok(p_session_id uuid) boolean   STABLE, SECURITY DEFINER. Row present: last_seen_at > now() - staff_idle_seconds.
--   No row: the same compare on coalesce(auth.sessions.refreshed_at AT TIME ZONE 'UTC', created_at) (a session that never went through the
--   login finish, such as E2E, local dev and DB-integration JWTs, or one whose write failed, passes for one hour). Not in auth.sessions: false.
-- public.staff_idle_check(p_session_id, p_user_id) boolean   service_role. staff_idle_ok, then (when true) the same throttled touch. One call.
-- public.staff_idle_peek(p_session_id) boolean   service_role. staff_idle_ok only; never moves the clock (/api/auth/me).
-- Idle seconds (3600) are read from private.passkey_staff_settings(). All fail closed (any error -> false, with a RAISE WARNING).
-- All: STABLE, SECURITY DEFINER, owner postgres, search_path empty, fail closed (any error -> false, with a RAISE WARNING
-- carrying SQLSTATE and SQLERRM; entry_ok has no handler of its own because both parts already catch).
-- 86400 and 2 are read from private.passkey_staff_settings(); the TS constants come from defaultStaffPasskeySettings().
--
-- Grants: execute on the private functions (the three entry functions and private.staff_idle_ok) is revoked from PUBLIC, anon,
-- authenticated AND service_role (same as private.app_session_is_live). has_permission is SECURITY DEFINER owned by postgres, so
-- migration E can call these from it; nobody else needs them. The three public idle functions are granted to service_role only.
--
-- ROLLBACK (after rolling back E, because E's has_permission calls the functions):
--   DROP FUNCTION public.staff_idle_peek(uuid), public.staff_idle_check(uuid, uuid), public.staff_session_touch(uuid, uuid, integer),
--     private.staff_idle_ok(uuid), private.staff_passkey_entry_ok(uuid, jsonb), private.staff_passkey_count_ok(uuid),
--     private.staff_passkey_amr_ok(jsonb);
--   DROP TABLE private.staff_session_activity;
-- NOT applied to production until stage 1b and 3 are done.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('private.passkey_staff_settings()') IS NULL
     OR to_regprocedure('public.passkey_approved_count(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_precheck';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION private.staff_passkey_amr_ok(claims jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_max numeric;
  v_ts numeric;
  v_now numeric;
BEGIN
  IF claims IS NULL OR jsonb_typeof(claims) <> 'object' OR jsonb_typeof(claims -> 'amr') <> 'array' THEN
    RETURN false;
  END IF;
  SELECT max(t.ts) INTO v_ts
    FROM (
      SELECT CASE WHEN jsonb_typeof(e -> 'timestamp') = 'number' THEN (e -> 'timestamp')::numeric END AS ts
        FROM jsonb_array_elements(claims -> 'amr') AS e
       WHERE jsonb_typeof(e) = 'object' AND e ->> 'method' = 'passkey'
    ) t
   WHERE t.ts IS NOT NULL AND t.ts = trunc(t.ts);
  IF v_ts IS NULL THEN
    RETURN false;
  END IF;
  -- settings are read only when a passkey element exists (customers have none, so they never reach the settings read)
  v_max := (private.passkey_staff_settings() ->> 'staff_max_session_seconds')::numeric;
  IF v_max IS NULL THEN
    RETURN false;
  END IF;
  v_now := floor(extract(epoch FROM now()));
  -- 60 s of clock skew is allowed (GoTrue stamps the amr time after the DB transaction started)
  RETURN v_now - v_ts >= -60 AND v_now - v_ts <= v_max;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'staff_passkey_amr_ok failed: % %', SQLSTATE, SQLERRM;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION private.staff_passkey_count_ok(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(
    public.passkey_approved_count(p_user_id) >= (private.passkey_staff_settings() ->> 'min_approved_passkeys')::integer,
    false);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'staff_passkey_count_ok failed: % %', SQLSTATE, SQLERRM;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION private.staff_passkey_entry_ok(p_user_id uuid, claims jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN private.staff_passkey_amr_ok(claims) AND private.staff_passkey_count_ok(p_user_id);
END
$$;

CREATE TABLE IF NOT EXISTS private.staff_session_activity (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_session_activity_user_seen_idx ON private.staff_session_activity (user_id, last_seen_at);
ALTER TABLE private.staff_session_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.staff_session_activity FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.staff_idle_ok(p_session_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_idle integer;
  v_seen timestamptz;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN false;
  END IF;
  v_idle := (private.passkey_staff_settings() ->> 'staff_idle_seconds')::integer;
  IF v_idle IS NULL THEN
    RETURN false;
  END IF;
  SELECT a.last_seen_at INTO v_seen FROM private.staff_session_activity a WHERE a.session_id = p_session_id;
  IF NOT FOUND THEN
    -- no activity row: the auth.sessions time (refreshed_at is timestamp without time zone, UTC; created_at is timestamptz)
    SELECT coalesce(s.refreshed_at AT TIME ZONE 'UTC', s.created_at) INTO v_seen FROM auth.sessions s WHERE s.id = p_session_id;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;
  RETURN COALESCE(v_seen > now() - pg_catalog.make_interval(secs => v_idle), false);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'staff_idle_ok failed: % %', SQLSTATE, SQLERRM;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION public.staff_session_touch(p_session_id uuid, p_user_id uuid, p_min_interval_seconds integer DEFAULT 60)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_written boolean;
BEGIN
  IF p_session_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO private.staff_session_activity AS a (session_id, user_id, last_seen_at)
  VALUES (p_session_id, p_user_id, now())
  ON CONFLICT (session_id) DO UPDATE SET last_seen_at = now()
    WHERE a.user_id = EXCLUDED.user_id
      AND a.last_seen_at <= now() - pg_catalog.make_interval(secs => GREATEST(COALESCE(p_min_interval_seconds, 60), 0))
  RETURNING true INTO v_written;
  IF NOT COALESCE(v_written, false) THEN
    RETURN false;
  END IF;
  DELETE FROM private.staff_session_activity d
   WHERE d.user_id = p_user_id AND d.session_id <> p_session_id AND d.last_seen_at < now() - interval '2 days';
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'staff_session_touch failed: % %', SQLSTATE, SQLERRM;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION public.staff_idle_check(p_session_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.staff_idle_ok(p_session_id) THEN
    RETURN false;
  END IF;
  PERFORM public.staff_session_touch(p_session_id, p_user_id);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'staff_idle_check failed: % %', SQLSTATE, SQLERRM;
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION public.staff_idle_peek(p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT private.staff_idle_ok(p_session_id);
$$;

ALTER FUNCTION private.staff_passkey_amr_ok(jsonb) OWNER TO postgres;
ALTER FUNCTION private.staff_passkey_count_ok(uuid) OWNER TO postgres;
ALTER FUNCTION private.staff_passkey_entry_ok(uuid, jsonb) OWNER TO postgres;
ALTER FUNCTION private.staff_idle_ok(uuid) OWNER TO postgres;
ALTER FUNCTION public.staff_session_touch(uuid, uuid, integer) OWNER TO postgres;
ALTER FUNCTION public.staff_idle_check(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.staff_idle_peek(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.staff_passkey_amr_ok(jsonb), private.staff_passkey_count_ok(uuid),
  private.staff_passkey_entry_ok(uuid, jsonb), private.staff_idle_ok(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.staff_session_touch(uuid, uuid, integer), public.staff_idle_check(uuid, uuid),
  public.staff_idle_peek(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_session_touch(uuid, uuid, integer), public.staff_idle_check(uuid, uuid),
  public.staff_idle_peek(uuid) TO service_role;

-- PASSKEY_D_FINAL_ASSERT
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['private.staff_passkey_amr_ok(jsonb)', 'private.staff_passkey_count_ok(uuid)',
    'private.staff_passkey_entry_ok(uuid,jsonb)', 'private.staff_idle_ok(uuid)'] LOOP
    IF NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = f::regprocedure AND p.prosecdef AND p.provolatile = 's' AND p.proowner = 'postgres'::regrole
            AND p.proconfig @> ARRAY['search_path=""'])
       OR has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR has_function_privilege('service_role', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_function_acl';
    END IF;
  END LOOP;
END
$$;
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.staff_session_touch(uuid,uuid,integer)', 'public.staff_idle_check(uuid,uuid)',
    'public.staff_idle_peek(uuid)'] LOOP
    IF NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = f::regprocedure AND p.prosecdef AND p.proowner = 'postgres'::regrole
            AND p.proconfig @> ARRAY['search_path=""'])
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_idle_function_acl';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'private.staff_session_activity'::regclass AND c.relrowsecurity)
     OR has_table_privilege('anon', 'private.staff_session_activity', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'private.staff_session_activity', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_idle_table_acl';
  END IF;
END
$$;
-- PASSKEY_D_FINAL_ASSERT_END
COMMIT;
