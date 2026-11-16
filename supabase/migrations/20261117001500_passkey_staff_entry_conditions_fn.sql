-- Passkey stage 1a / Task 8 (migration D): the three admin-entry conditions as SQL functions (SR-AUTH-014, DD-AUTH-047, ADR-0463, SEC-AUTH-039).
-- It only ADDS three functions. has_permission and the API gate are NOT changed here (Task 9 wires them), so nothing changes for anyone yet.
--
-- private.staff_passkey_amr_ok(claims jsonb) boolean     conditions 1 and 2 (cheap; reads claims and settings only)
--   claims.amr must be a JSON array. Valid elements: object, method = 'passkey', timestamp a JSON number holding an integer.
--   The latest valid timestamp T wins. true when 0 <= floor(now) - T <= staff_max_session_seconds (future T is false).
--   Anything else (no claims, amr missing / null / not an array / empty, string timestamp, only oauth / otp) is false.
-- private.staff_passkey_count_ok(p_user_id uuid) boolean  condition 3, counted in the DB on every call (never from the JWT hint
--   staff_passkeys_ok): public.passkey_approved_count(user) >= min_approved_passkeys (same join incl. credential_id).
-- private.staff_passkey_entry_ok(p_user_id uuid, claims jsonb) boolean   both; the cheap check first.
-- All: STABLE, SECURITY DEFINER, owner postgres, search_path empty, fail closed (any error -> false).
-- 86400 and 2 are read from private.passkey_staff_settings(); the TS constants come from defaultStaffPasskeySettings().
--
-- Grants: execute is revoked from PUBLIC, anon, authenticated AND service_role (same as private.app_session_is_live). has_permission is
-- SECURITY DEFINER owned by postgres, so Task 9 can call these from it; nobody else needs them. No new grant is given.
--
-- ROLLBACK: DROP FUNCTION private.staff_passkey_entry_ok(uuid, jsonb), private.staff_passkey_count_ok(uuid), private.staff_passkey_amr_ok(jsonb);
--   (only before Task 9 uses them.)
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
  v_max := (private.passkey_staff_settings() ->> 'staff_max_session_seconds')::numeric;
  SELECT max(t.ts) INTO v_ts
    FROM (
      SELECT CASE WHEN jsonb_typeof(e -> 'timestamp') = 'number' THEN (e -> 'timestamp')::numeric END AS ts
        FROM jsonb_array_elements(claims -> 'amr') AS e
       WHERE jsonb_typeof(e) = 'object' AND e ->> 'method' = 'passkey'
    ) t
   WHERE t.ts IS NOT NULL AND t.ts = trunc(t.ts);
  IF v_ts IS NULL OR v_max IS NULL THEN
    RETURN false;
  END IF;
  v_now := floor(extract(epoch FROM now()));
  RETURN v_now - v_ts >= 0 AND v_now - v_ts <= v_max;
EXCEPTION WHEN OTHERS THEN
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
  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION private.staff_passkey_entry_ok(p_user_id uuid, claims jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN private.staff_passkey_amr_ok(claims) AND private.staff_passkey_count_ok(p_user_id);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$$;

ALTER FUNCTION private.staff_passkey_amr_ok(jsonb) OWNER TO postgres;
ALTER FUNCTION private.staff_passkey_count_ok(uuid) OWNER TO postgres;
ALTER FUNCTION private.staff_passkey_entry_ok(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.staff_passkey_amr_ok(jsonb), private.staff_passkey_count_ok(uuid),
  private.staff_passkey_entry_ok(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- PASSKEY_D_FINAL_ASSERT
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['private.staff_passkey_amr_ok(jsonb)', 'private.staff_passkey_count_ok(uuid)',
    'private.staff_passkey_entry_ok(uuid,jsonb)'] LOOP
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
-- PASSKEY_D_FINAL_ASSERT_END
COMMIT;
