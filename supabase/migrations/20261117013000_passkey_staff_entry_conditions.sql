-- Passkey stage 1a / Task 9 (migration E): public.has_permission switches from the aal2 branch to the admin-entry conditions
-- (SR-AUTH-014, DD-AUTH-047, ADR-0463, SEC-AUTH-039 / SEC-AUTH-040). This is the SWITCH: together with enabling the Custom Access Token hook
-- (supabase/config.toml) and src/lib/auth/admin-rbac.ts, nobody but a passkey-entered staff member passes has_permission any more.
--
-- Body = 20261029120100_sec_has_permission_aal2_member_rls.sql, with only the aal2 branch replaced. Order inside the function:
--   1. auth.uid() empty                                               -> false (unchanged)
--   2. private.staff_passkey_amr_ok(claims)  (conditions 1 and 2)     -> false. Cheap: claims and settings only. Same position as the old aal2 check,
--                                                                        so customers and anon never reach the ACL tables or approved_passkeys.
--   3. ACL EXISTS (unchanged)                                         -> false when no permission
--   4. private.staff_passkey_count_ok(uid)   (condition 3)            -> false. Counted in the DB on every call (never from the JWT hint
--                                                                        staff_passkeys_ok). Only reached when the ACL is true, because has_permission is
--                                                                        called per row by about 100 RLS policies and customers must not reach approved_passkeys.
--   5. private.app_session_is_live(claims.session_id), cast only after a regex shape check (unchanged).
-- Owner, SECURITY DEFINER, STABLE, SET search_path = '' and the EXECUTE grants (authenticated, service_role, postgres; anon revoked) are kept by
-- CREATE OR REPLACE. The JWT aal is NOT looked at any more (a passkey login stays aal1).
-- Cost note: a policy that calls has_permission without (select ...) wrapping runs it per row; the count (step 4) then runs once per row for a
-- caller that already passed steps 2 and 3 (staff only). Customers stop at step 2 or 3.
--
-- Replaced body md5 (select md5(pg_get_functiondef('public.has_permission(text)'::regprocedure)), local DB right before this migration):
--   61536a72ff10e073a731a903ed6acd10
--
-- BEFORE applying to production (read only; NOT applied to production until stage 1b and 3 are done):
--   select md5(pg_get_functiondef('public.has_permission(text)'::regprocedure));   -- expect the md5 above
--   select to_regprocedure('private.staff_passkey_amr_ok(jsonb)'), to_regprocedure('private.staff_passkey_count_ok(uuid)');   -- expect not null (migration D)
-- Applying this before the passkey entry is usable means nobody holds an admin permission (every staff JWT lacks the passkey amr).
--
-- ROLLBACK: CREATE OR REPLACE FUNCTION public.has_permission with the body of 20261029120100_sec_has_permission_aal2_member_rls.sql
--   (the aal2 branch: IF COALESCE(claims ->> 'aal', 'aal1') <> 'aal2' THEN RETURN false; END IF; before the ACL, no count check).
BEGIN;

DO $passkey_entry_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('private.staff_passkey_amr_ok(jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('private.staff_passkey_count_ok(uuid)') IS NULL
     OR pg_catalog.to_regprocedure('private.app_session_is_live(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_precheck';
  END IF;
END
$passkey_entry_precheck$;

CREATE OR REPLACE FUNCTION public.has_permission (
  permission_code text
)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
  AS $function$
DECLARE
  uid uuid;
  acl_allowed boolean;
  claims jsonb;
BEGIN
  uid := auth.uid();
  IF uid IS NULL THEN
    RETURN false;
  END IF;

  claims := (SELECT auth.jwt());
  IF NOT private.staff_passkey_amr_ok(claims) THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = uid
      AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND p.code = permission_code
  ) INTO acl_allowed;

  IF NOT COALESCE(acl_allowed, false) THEN
    RETURN false;
  END IF;

  IF NOT private.staff_passkey_count_ok(uid) THEN
    RETURN false;
  END IF;

  RETURN private.app_session_is_live(
    CASE
      WHEN claims ->> 'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (claims ->> 'session_id')::uuid
    END
  );
END;
$function$;

-- PASSKEY_E_FINAL_ASSERT
DO $passkey_entry_assert$
DECLARE
  v_definition text;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef('public.has_permission(text)'::regprocedure);
  IF v_definition LIKE '%aal2%'
     OR v_definition NOT LIKE '%staff_passkey_amr_ok%'
     OR v_definition NOT LIKE '%staff_passkey_count_ok%'
     OR v_definition NOT LIKE '%app_session_is_live%'
     OR v_definition NOT LIKE '%user_roles%' THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_body';
  END IF;
  -- order: amr check < ACL < count check < session check
  IF pg_catalog.strpos(v_definition, 'staff_passkey_amr_ok') > pg_catalog.strpos(v_definition, 'user_roles')
     OR pg_catalog.strpos(v_definition, 'staff_passkey_count_ok') < pg_catalog.strpos(v_definition, 'user_roles')
     OR pg_catalog.strpos(v_definition, 'app_session_is_live') < pg_catalog.strpos(v_definition, 'staff_passkey_count_ok') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_order';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.has_permission(text)'::regprocedure
      AND p.proowner = 'postgres'::regrole
      AND p.prosecdef
      AND p.provolatile = 's'
      AND p.proconfig @> ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_settings';
  END IF;
  IF NOT pg_catalog.has_function_privilege('authenticated', 'public.has_permission(text)'::regprocedure, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.has_permission(text)'::regprocedure, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'public.has_permission(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_execute';
  END IF;
END
$passkey_entry_assert$;
-- PASSKEY_E_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';

COMMIT;
