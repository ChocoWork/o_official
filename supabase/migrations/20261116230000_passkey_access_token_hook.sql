-- Passkey stage 1a / Task 5 (migration B): the Custom Access Token hook FUNCTION (SR-AUTH-011, DD-AUTH-044,
-- ADR-0464, SEC-AUTH-037). This migration only ADDS the function. It is NOT enabled in config.toml here (Task 9
-- enables it together with the admin-gate switch), so nothing calls it and no existing login changes.
--
-- public.passkey_access_token_hook(event jsonb) returns jsonb   SECURITY DEFINER, owner postgres, search_path empty.
-- Behaviour (design 5-2). "Staff" = an active, unexpired user_roles row with role code admin or supporter.
--   staff, authentication_method passkey / token_refresh, claims.amr (a jsonb array) holds a passkey element whose
--     numeric timestamp T satisfies T <= now + 60 and now - T <= staff_max_session_seconds  -> pass (60 s clock skew: GoTrue
--     stamps T with its own clock AFTER this transaction started, so T can sit one second ahead of now()); claims.staff_passkeys_ok
--     is added (true when public.passkey_approved_count(user) >= min_approved_passkeys; a HINT only, never a decision)
--   staff, authentication_method otp / token_refresh / passkey and an open registration window for BOTH
--     claims.session_id and user_id -> pass (staff_passkeys_ok false; amr has no fresh passkey, so the admin gate stops)
--   staff, anything else (otp, oauth, password, stale passkey / refresh, closed window, unknown method) -> reject
--     {"error":{"http_code":403,"message":"[staff-passkey-required] ..."}}
--   customer: rejected only when authentication_method = 'password' AND reject_customer_password, with its own marker
--     "[customer-password-disabled]" (never the staff marker); else event unchanged
--   if counting approved passkeys raises, staff_passkeys_ok is false (it is only a hint) and the fresh passkey still passes
--   never raises: EXCEPTION WHEN OTHERS -> if the user was already known NOT to be staff, return the event;
--     otherwise (staff, or staff could not be determined) reject. A staff user never passes by accident.
-- The hook never writes the window table (plan B).
--
-- Grants: EXECUTE for supabase_auth_admin only (no table select: the function runs as owner postgres).
-- ROLLBACK:  DROP FUNCTION public.passkey_access_token_hook(jsonb);
--
-- BEFORE applying to production (read only): NOT applied to production until stage 1b and 3 are done.
--   select to_regprocedure('public.passkey_approved_count(uuid)');   -- expect not null (migration A)

BEGIN;

DO $$
BEGIN
  IF to_regclass('private.passkey_staff_config') IS NULL
     OR to_regclass('private.passkey_registration_windows') IS NULL
     OR to_regclass('public.user_roles') IS NULL
     OR to_regprocedure('private.passkey_staff_settings()') IS NULL
     OR to_regprocedure('public.passkey_approved_count(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_hook_precheck';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.passkey_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_reject CONSTANT jsonb := jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', '[staff-passkey-required] staff must sign in with a fresh passkey'));
  c_reject_customer CONSTANT jsonb := jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', '[customer-password-disabled] password sign-in is no longer available'));
  v_uid uuid;
  v_method text;
  v_claims jsonb;
  v_cfg jsonb;
  v_is_staff boolean;
  v_customer_known boolean := false;
  v_max numeric;
  v_min integer;
  v_now numeric;
  v_ts numeric;
  v_sid uuid;
  v_window boolean := false;
  v_ok boolean;
BEGIN
  v_uid := (event ->> 'user_id')::uuid;
  v_method := event ->> 'authentication_method';
  v_claims := event -> 'claims';

  IF v_uid IS NULL THEN
    RETURN c_reject;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = v_uid
       AND ur.active
       AND (ur.expires_at IS NULL OR ur.expires_at > now())
       AND r.code IN ('admin', 'supporter')
  ) INTO v_is_staff;
  IF v_is_staff IS NULL THEN
    RETURN c_reject;
  END IF;

  IF NOT v_is_staff THEN
    v_customer_known := true;
    v_cfg := private.passkey_staff_settings();
    IF v_method = 'password' AND COALESCE((v_cfg ->> 'reject_customer_password')::boolean, false) THEN
      RETURN c_reject_customer;
    END IF;
    RETURN event;
  END IF;

  -- Staff from here. Any failure below ends in the EXCEPTION handler, which rejects.
  v_cfg := private.passkey_staff_settings();
  v_max := (v_cfg ->> 'staff_max_session_seconds')::numeric;
  v_min := (v_cfg ->> 'min_approved_passkeys')::integer;

  IF v_method IN ('passkey', 'token_refresh')
     AND jsonb_typeof(v_claims) = 'object'
     AND jsonb_typeof(v_claims -> 'amr') = 'array' THEN
    v_now := floor(extract(epoch FROM now()));
    SELECT max((e ->> 'timestamp')::numeric) INTO v_ts
      FROM jsonb_array_elements(v_claims -> 'amr') AS e
     WHERE jsonb_typeof(e) = 'object'
       AND e ->> 'method' = 'passkey'
       AND jsonb_typeof(e -> 'timestamp') = 'number'
       AND (e ->> 'timestamp') ~ '^[0-9]+$';
    IF v_ts IS NOT NULL AND v_ts <= v_now + 60 AND v_now - v_ts <= v_max THEN
      -- staff_passkeys_ok is only a hint: if counting fails, say false and still let the fresh passkey through.
      BEGIN
        v_ok := public.passkey_approved_count(v_uid) >= v_min;
      EXCEPTION WHEN OTHERS THEN
        v_ok := false;
      END;
      RETURN jsonb_set(event, '{claims,staff_passkeys_ok}', to_jsonb(COALESCE(v_ok, false)));
    END IF;
  END IF;

  IF v_method IN ('otp', 'token_refresh', 'passkey') AND jsonb_typeof(v_claims) = 'object'
     AND jsonb_typeof(v_claims -> 'session_id') = 'string' THEN
    BEGIN
      v_sid := (v_claims ->> 'session_id')::uuid;
      SELECT EXISTS (
        SELECT 1 FROM private.passkey_registration_windows w
         WHERE w.user_id = v_uid AND w.session_id = v_sid AND w.closed_at IS NULL AND w.expires_at > now()
      ) INTO v_window;
    EXCEPTION WHEN OTHERS THEN
      v_window := false;
    END;
    IF v_window THEN
      RETURN jsonb_set(event, '{claims,staff_passkeys_ok}', 'false'::jsonb);
    END IF;
  END IF;

  RETURN c_reject;
EXCEPTION WHEN OTHERS THEN
  IF v_customer_known THEN
    RETURN event;
  END IF;
  RETURN c_reject;
END
$$;

ALTER FUNCTION public.passkey_access_token_hook(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.passkey_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.passkey_access_token_hook(jsonb) TO supabase_auth_admin;

-- PASSKEY_B_FINAL_ASSERT
DO $$
DECLARE
  f CONSTANT text := 'public.passkey_access_token_hook(jsonb)';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = f::regprocedure AND p.prosecdef AND p.proowner = 'postgres'::regrole
       AND p.proconfig @> ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_hook_attrs';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('service_role', f, 'EXECUTE')
     OR NOT has_function_privilege('supabase_auth_admin', f, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_hook_acl';
  END IF;
  IF has_table_privilege('supabase_auth_admin', 'private.passkey_staff_config', 'SELECT')
     OR has_table_privilege('supabase_auth_admin', 'private.passkey_notification_outbox', 'SELECT')
     OR has_table_privilege('supabase_auth_admin', 'private.approved_passkeys', 'SELECT')
     OR has_table_privilege('supabase_auth_admin', 'private.passkey_registration_windows', 'SELECT') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_hook_table_acl';
  END IF;
END
$$;
-- PASSKEY_B_FINAL_ASSERT_END
COMMIT;
