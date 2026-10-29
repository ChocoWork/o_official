-- Wave 5 / Task 6 (M2): public.has_permission requires aal2 AND an application-bound live session, and the member's
-- own-row tables (profiles, orders, order_items) get a RESTRICTIVE policy that requires the same bound live session
-- (R2 / R3: SEC-AUTH-005-AC-02, SEC-AUTH-010-AC-03, SEC-ADMIN-002, SEC-LOOK-003, SEC-NEWS-002, SEC-STOCKIST-003,
-- SEC-HOME-003; ADR-0418, DATA-AUTH-008). THIS is the migration that takes effect. M1 (20261029120000) only added things.
--
-- Why:
--   * has_permission looked only at the ACL tables. A JWT obtained without the application (password only, e-mail OTP
--     only, any anon-key session) therefore reached every RLS policy that calls has_permission (about 100 policies),
--     and reached the member's own rows through auth.uid() = user_id.
--   * One function body changes, so every policy that calls it follows without being rewritten:
--       1. auth.uid() empty                                       -> false (unchanged)
--       2. claims.aal is not 'aal2' (missing = aal1)              -> false (cheap check first: members and anon never
--                                                                    reach the ACL tables)
--       3. ACL EXISTS (copied from 20261023175712 unchanged)      -> false when no permission
--       4. only when the ACL is true: private.app_session_is_live(claims.session_id), the id cast only after a regex
--          shape check, so a malformed session_id is false, never an error.
--   * A public read policy of the form (status = 'published' OR has_permission(...)) is NOT made RESTRICTIVE: the OR
--     branch simply stops matching for unbound / aal1 callers, so ordinary members keep reading published rows.
--   * profiles / orders / order_items return a member's own rows through auth.uid() = user_id, which does not call
--     has_permission. Each gets ONE policy "require app bound live session": AS RESTRICTIVE FOR ALL TO authenticated
--     USING / WITH CHECK ((SELECT private.is_app_bound_live_session())). Not applied to anon: guest orders are read
--     through app.session_id and that path is unchanged. carts / wishlists / checkout_drafts / contact_* /
--     refresh_token_history / postal_code_cache already deny direct client access (RESTRICTIVE false or full deny), and
--     user_roles goes through has_permission('admin.users.read'), so no other table returns a member's row to PostgREST.
--   * private.group_g_actor_has_permissions(_actor_id, ...) does not use auth.uid() or has_permission, so the
--     G-2 / G-3 / G-4 writers are unchanged.
--   CREATE OR REPLACE keeps the owner and the EXECUTE grants (authenticated, service_role, postgres; anon revoked), so
--   no GRANT / REVOKE is written for has_permission here. SET search_path = '' is restated: omitting it would drop it.
--
-- BEFORE applying to production (read only; keep the results as the rollback reference):
--   select md5(pg_get_functiondef('public.has_permission(text)'::regprocedure));  -- the 20261023175712 body; M1 does not change it
--   select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies
--     where schemaname = 'public' and tablename in ('profiles', 'orders', 'order_items') order by 2, 3;
--   select tablename, policyname from pg_policies where schemaname = 'public'
--     and (qual like '%auth.uid()%' or with_check like '%auth.uid()%' or qual like '%auth.jwt()%') order by 1, 2;
--                                                    -- expect only profiles (4), orders (1), order_items (1); a member table
--                                                    -- added later by G-4 / H needs the same RESTRICTIVE policy
--   select count(*) filter (where revoked_at is null and auth_session_id is not null) as bound_live from public.sessions;
--
-- Apply boundary: M1 is applied AND the application's writer (Task 2) and reader (Task 3) are live AND everyone has
-- logged in again. The moment this migration commits, every existing session that is not bound reads 0 rows from the
-- member tables, and has_permission is false for every session that is not aal2 and bound. A flag cannot undo it
-- (AUTH_REQUIRE_APP_SESSION is not read by the database); only the ROLLBACK below does.
--
-- ROLLBACK:
--   DROP POLICY IF EXISTS "require app bound live session" ON public.profiles;
--   DROP POLICY IF EXISTS "require app bound live session" ON public.orders;
--   DROP POLICY IF EXISTS "require app bound live session" ON public.order_items;
--   CREATE OR REPLACE FUNCTION public.has_permission (
--     permission_code text
--   )
--     RETURNS boolean
--     LANGUAGE plpgsql
--     STABLE
--     SECURITY DEFINER
--     SET search_path = ''
--     AS $function$
--   DECLARE
--     uid uuid;
--     acl_allowed boolean;
--   BEGIN
--     uid := auth.uid();
--     IF uid IS NULL THEN
--       RETURN false;
--     END IF;
--
--     SELECT EXISTS (
--       SELECT 1
--       FROM public.user_roles ur
--       JOIN public.roles r ON r.id = ur.role_id
--       JOIN public.role_permissions rp ON rp.role_id = r.id
--       JOIN public.permissions p ON p.id = rp.permission_id
--       WHERE ur.user_id = uid
--         AND ur.active = true
--         AND (ur.expires_at IS NULL OR ur.expires_at > now())
--         AND p.code = permission_code
--     ) INTO acl_allowed;
--
--     RETURN COALESCE(acl_allowed, false);
--   END;
--   $function$;
BEGIN;

-- 0. M1 must already be applied. Stop with a clear detail before changing anything.
DO $sec_has_permission_aal2_precheck$
BEGIN
  IF pg_catalog.to_regprocedure('private.app_session_is_live(uuid)') IS NULL
     OR pg_catalog.to_regprocedure('private.is_app_bound_live_session()') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = 'sessions' AND c.column_name = 'auth_session_id'
     ) THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_has_permission_aal2: apply M1 (sec_app_session_binding) first';
  END IF;
END
$sec_has_permission_aal2_precheck$;

-- 1. has_permission: the 20261023175712 body plus two checks (aal2 before the ACL, bound live session after it).
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
  IF COALESCE(claims ->> 'aal', 'aal1') <> 'aal2' THEN
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

  RETURN private.app_session_is_live(
    CASE
      WHEN claims ->> 'session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (claims ->> 'session_id')::uuid
    END
  );
END;
$function$;
-- CREATE OR REPLACE preserves owner and EXECUTE grants (anon remains revoked).

-- 2. The member's own-row tables: authenticated callers need a bound live session. anon is not touched.
DROP POLICY IF EXISTS "require app bound live session" ON public.profiles;
CREATE POLICY "require app bound live session" ON public.profiles
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT private.is_app_bound_live_session()))
  WITH CHECK ((SELECT private.is_app_bound_live_session()));

DROP POLICY IF EXISTS "require app bound live session" ON public.orders;
CREATE POLICY "require app bound live session" ON public.orders
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT private.is_app_bound_live_session()))
  WITH CHECK ((SELECT private.is_app_bound_live_session()));

DROP POLICY IF EXISTS "require app bound live session" ON public.order_items;
CREATE POLICY "require app bound live session" ON public.order_items
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT private.is_app_bound_live_session()))
  WITH CHECK ((SELECT private.is_app_bound_live_session()));

-- 3. Self check: any failure rolls the whole migration back.
DO $sec_has_permission_aal2_assert$
DECLARE
  v_definition text;
  v_table text;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef('public.has_permission(text)'::regprocedure);
  IF v_definition NOT LIKE '%''aal2''%'
     OR v_definition NOT LIKE '%app_session_is_live%'
     OR v_definition NOT LIKE '%user_roles%' THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_has_permission_aal2: function body';
  END IF;

  -- the aal check comes before the ACL query, the session check after it
  IF pg_catalog.strpos(v_definition, '''aal2''') > pg_catalog.strpos(v_definition, 'user_roles')
     OR pg_catalog.strpos(v_definition, 'app_session_is_live') < pg_catalog.strpos(v_definition, 'user_roles') THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_has_permission_aal2: check order';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.has_permission(text)'::regprocedure
      AND p.proowner = 'postgres'::regrole
      AND p.prosecdef
      AND p.provolatile = 's'
      AND p.proconfig @> ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_has_permission_aal2: function settings';
  END IF;

  IF NOT pg_catalog.has_function_privilege('authenticated', 'public.has_permission(text)'::regprocedure, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.has_permission(text)'::regprocedure, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'public.has_permission(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_has_permission_aal2: execute privileges';
  END IF;

  -- exactly one RESTRICTIVE ALL policy for authenticated on each member table
  FOREACH v_table IN ARRAY ARRAY['profiles', 'orders', 'order_items'] LOOP
    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy pol
      WHERE pol.polrelid = pg_catalog.format('public.%I', v_table)::regclass
        AND pol.polname = 'require app bound live session'
        AND NOT pol.polpermissive
        AND pol.polcmd = '*'
        AND pol.polroles = ARRAY['authenticated'::regrole::oid]
    ) <> 1 THEN
      RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_has_permission_aal2: member policy ' || v_table;
    END IF;
  END LOOP;
END
$sec_has_permission_aal2_assert$;

NOTIFY pgrst, 'reload schema';

COMMIT;
