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
--   5. private.staff_idle_ok(session_id)   (condition 4, stage 3a / SR-AUTH-028)  -> false. Staff idle for more than one hour. Reached only by staff
--                                                                        that passed 2-4 (same cost rule as the count). A malformed session_id becomes NULL
--                                                                        after the regex shape check, so idle_ok returns false (never an exception).
--   6. private.app_session_is_live(claims.session_id), cast only after a regex shape check (unchanged).
-- Owner, SECURITY DEFINER, STABLE, SET search_path = '' and the EXECUTE grants (authenticated, service_role, postgres; anon revoked) are kept by
-- CREATE OR REPLACE. The JWT aal is NOT looked at any more (a passkey login stays aal1).
-- Cost note: a policy that calls has_permission without (select ...) wrapping runs it per row; the count (step 4) then runs once per row for a
-- caller that already passed steps 2 and 3 (staff only). Customers stop at step 2 or 3.
--
-- Replaced body md5 (select md5(prosrc) from pg_proc where oid = 'public.has_permission(text)'::regprocedure, local DB right before this migration).
-- prosrc is only the text between the dollar quotes, so the value does not depend on the PG version (pg_get_functiondef does):
--   3c4826933eca194a3486f430d361891c
--
-- BEFORE applying to production (read only; NOT applied to production until stage 1b and 3 are done):
--   select md5(prosrc) from pg_proc where oid = 'public.has_permission(text)'::regprocedure;   -- expect the md5 above
--   select to_regprocedure('private.staff_passkey_amr_ok(jsonb)'), to_regprocedure('private.staff_passkey_count_ok(uuid)'),
--          to_regprocedure('private.staff_idle_ok(uuid)');   -- expect not null (migration D)
-- The migration itself stops (PASSKEY_MIGRATION_PRECHECK_FAILED) when the has_permission md5 differs from the value above, and when active
-- staff exist but none of them has the required number of approved keys (never `db push` while these migrations are in supabase/migrations).
-- Applying this before the passkey entry is usable means nobody holds an admin permission (every staff JWT lacks the passkey amr).
--
-- ROLLBACK (before rolling back D, whose idle table and functions this body calls): CREATE OR REPLACE FUNCTION public.has_permission with the body of 20261029120100_sec_has_permission_aal2_member_rls.sql
--   (the aal2 branch: IF COALESCE(claims ->> 'aal', 'aal1') <> 'aal2' THEN RETURN false; END IF; before the ACL, no count or idle check).
BEGIN;

DO $passkey_entry_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('private.staff_passkey_amr_ok(jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('private.staff_passkey_count_ok(uuid)') IS NULL
     OR pg_catalog.to_regprocedure('private.app_session_is_live(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_precheck';
  END IF;
  IF pg_catalog.to_regprocedure('private.staff_idle_ok(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_idle_fn';
  END IF;
END
$passkey_entry_precheck$;

-- Baseline check (M-4): the has_permission being replaced must be the one this migration was written against (the aal2 body of
-- 20261029120100). If someone changed it since, stop instead of silently overwriting that change.
DO $passkey_entry_baseline$
BEGIN
  IF (SELECT pg_catalog.md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = 'public.has_permission(text)'::regprocedure) IS DISTINCT FROM '3c4826933eca194a3486f430d361891c' THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_baseline';
  END IF;
END
$passkey_entry_baseline$;

-- Lock-out guard (I-2): stop when at least one active staff member (admin or supporter in user_roles) exists and none of them has
-- min_approved_passkeys approved keys. Applying this switch then would lock every staff member out of RLS. Locally, db reset runs the
-- migrations before the seed, so user_roles is empty and the guard passes.
DO $passkey_entry_staff_guard$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id
       WHERE r.code IN ('admin', 'supporter')
         AND ur.active = true
         AND (ur.expires_at IS NULL OR ur.expires_at > now())
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id
       WHERE r.code IN ('admin', 'supporter')
         AND ur.active = true
         AND (ur.expires_at IS NULL OR ur.expires_at > now())
         AND public.passkey_approved_count(ur.user_id)
             >= (private.passkey_staff_settings() ->> 'min_approved_passkeys')::integer
     ) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_no_ready_staff';
  END IF;
END
$passkey_entry_staff_guard$;

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
  v_session uuid;
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

  v_session := CASE
    WHEN claims ->> 'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (claims ->> 'session_id')::uuid
  END;

  IF NOT private.staff_idle_ok(v_session) THEN
    RETURN false;
  END IF;

  RETURN private.app_session_is_live(v_session);
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
     OR v_definition NOT LIKE '%staff_idle_ok%'
     OR v_definition NOT LIKE '%app_session_is_live%'
     OR v_definition NOT LIKE '%user_roles%' THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_entry_switch_body';
  END IF;
  -- order: amr check < ACL < count check < idle check < session check
  IF pg_catalog.strpos(v_definition, 'staff_passkey_amr_ok') > pg_catalog.strpos(v_definition, 'user_roles')
     OR pg_catalog.strpos(v_definition, 'staff_passkey_count_ok') < pg_catalog.strpos(v_definition, 'user_roles')
     OR pg_catalog.strpos(v_definition, 'staff_idle_ok') < pg_catalog.strpos(v_definition, 'staff_passkey_count_ok')
     OR pg_catalog.strpos(v_definition, 'app_session_is_live') < pg_catalog.strpos(v_definition, 'staff_idle_ok') THEN
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
