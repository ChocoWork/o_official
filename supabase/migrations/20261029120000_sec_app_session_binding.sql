-- Wave 5 / Task 1 (M1): bind the application session to the GoTrue session (R2 / R3 shared guard: SEC-AUTH-005,
-- SEC-AUTH-010, SEC-AUTH-031; ADR-0417, DATA-AUTH-007). This migration only ADDS things. It changes no existing
-- behaviour: has_permission and every policy are untouched (that is M2, 20261029120100).
--
-- Why:
--   * The anon key is public. Anyone can obtain a valid access token through /auth/v1/token?grant_type=password or
--     /auth/v1/otp -> /auth/v1/verify without ever going through the application's login flow
--     (password -> e-mail OTP -> TOTP when needed). The token's `amr` cannot tell "OTP only" from the application's
--     own flow, so the application records the GoTrue session id (JWT claim `session_id`) of every session it
--     created in public.sessions.auth_session_id, and later checks (API: authenticateRequest, DB: M2) that a live
--     public.sessions row exists for the JWT's session_id.
--   * public.sessions.auth_session_id        nullable uuid. NULL = a row the application did not bind (every row that
--                                            exists today stays NULL, which is intended).
--   * sessions_auth_session_id_live_idx      partial, NOT unique: the application inserts the new row first and revokes
--                                            the old row afterwards (session.ts persistNewSession), so two live rows
--                                            share one auth_session_id for a moment.
--   * private.app_session_is_live(uuid)      true when auth.sessions has the id (not_after empty or in the future) AND
--                                            public.sessions has an un-revoked row with the same auth_session_id and the
--                                            same user. public.sessions.expires_at is NOT consulted (its meaning differs
--                                            between writers: access token expiry vs 7 days). GoTrue owns expiry.
--   * public.is_app_session_active(uuid)     service_role entry used by the application (authenticateRequest) through
--                                            supabase-js rpc. Calls the private function only.
--   * private.is_app_bound_live_session()    reads the caller's JWT session_id (shape checked with a regex before the
--                                            cast, never raises) and calls the private function. Used by M2 policies and
--                                            public.has_permission.
--   public.is_auth_session_active (G-2 ACL list) is NOT changed.
--
-- Not idempotent on purpose for ADD COLUMN / CREATE INDEX: an unexpected existing column or index must fail the
-- migration. Functions use CREATE OR REPLACE (db-migrations.md), and every one restates SET search_path.
--
-- BEFORE applying to production (read only; keep the results as the rollback reference):
--   select max(version) from supabase_migrations.schema_migrations;                       -- expect 20261026130600 or later
--   select column_name, data_type, is_nullable from information_schema.columns
--     where table_schema = 'public' and table_name = 'sessions' order by ordinal_position;  -- 15 columns, no auth_session_id
--   select md5(pg_get_functiondef('public.has_permission(text)'::regprocedure));            -- unchanged by M1; M2 compares it
--   select count(*) filter (where revoked_at is null) as live, count(*) as total from public.sessions;
--
-- Apply boundary: M1 is safe to apply before the application's writer ships (the column is nullable and nothing reads
-- it). The writer (Task 2) inserts auth_session_id on every login, so M1 MUST be applied before that code runs
-- against this database. M2 must not be applied before the application code (Tasks 2 and 3) is live.
--
-- ROLLBACK (run M2's rollback first if M2 was applied):
--   DROP FUNCTION IF EXISTS public.is_app_session_active(uuid);
--   DROP FUNCTION IF EXISTS private.is_app_bound_live_session();
--   DROP FUNCTION IF EXISTS private.app_session_is_live(uuid);
--   DROP INDEX IF EXISTS public.sessions_auth_session_id_live_idx;
--   ALTER TABLE public.sessions DROP COLUMN auth_session_id;
BEGIN;

-- 1. The column and its partial index (not unique: see P6 in the plan).
ALTER TABLE public.sessions ADD COLUMN auth_session_id uuid;

CREATE INDEX sessions_auth_session_id_live_idx ON public.sessions (auth_session_id)
  WHERE revoked_at IS NULL AND auth_session_id IS NOT NULL;

-- 2. The core check. Internal: nobody but the owner may execute it.
CREATE OR REPLACE FUNCTION private.app_session_is_live(p_session_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_session_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM auth.sessions AS s
    JOIN public.sessions AS ps
      ON ps.auth_session_id = s.id AND ps.user_id = s.user_id AND ps.revoked_at IS NULL
    WHERE s.id = p_session_id
      AND (s.not_after IS NULL OR s.not_after > pg_catalog.now()));
$$;
ALTER FUNCTION private.app_session_is_live(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.app_session_is_live(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 3. The application's entry (supabase-js rpc with the service role).
CREATE OR REPLACE FUNCTION public.is_app_session_active(p_session_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.app_session_is_live(p_session_id);
$$;
ALTER FUNCTION public.is_app_session_active(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_app_session_active(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_app_session_active(uuid) TO service_role;

-- 4. The caller's own JWT. A missing / empty / malformed session_id is false, never an error.
CREATE OR REPLACE FUNCTION private.is_app_bound_live_session() RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id text;
BEGIN
  v_session_id := (SELECT auth.jwt()) ->> 'session_id';
  IF v_session_id IS NULL
     OR v_session_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN private.app_session_is_live(v_session_id::uuid);
END;
$$;
ALTER FUNCTION private.is_app_bound_live_session() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.is_app_bound_live_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_app_bound_live_session() TO authenticated, service_role;

-- 5. Self check: any failure rolls the whole migration back.
DO $sec_app_session_binding_assert$
DECLARE
  v_signature text;
  v_privilege text;
  v_role text;
BEGIN
  -- the column: uuid, nullable
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'sessions' AND c.column_name = 'auth_session_id'
      AND c.data_type = 'uuid' AND c.is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: auth_session_id column';
  END IF;

  -- the index: partial and not unique
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = 'public.sessions'::regclass
      AND ic.relname = 'sessions_auth_session_id_live_idx'
      AND NOT i.indisunique
      AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: partial non-unique index';
  END IF;

  -- the three functions: owner, SECURITY DEFINER, empty search_path
  FOREACH v_signature IN ARRAY ARRAY[
    'private.app_session_is_live(uuid)', 'public.is_app_session_active(uuid)', 'private.is_app_bound_live_session()'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = v_signature::regprocedure
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=""']
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: function definition ' || v_signature;
    END IF;
  END LOOP;

  -- EXECUTE: private.app_session_is_live nobody; public.is_app_session_active service_role only;
  -- private.is_app_bound_live_session authenticated + service_role (not anon, not PUBLIC)
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF pg_catalog.has_function_privilege(v_role, 'private.app_session_is_live(uuid)'::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: app_session_is_live execute ' || v_role;
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('anon', 'public.is_app_session_active(uuid)'::regprocedure, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.is_app_session_active(uuid)'::regprocedure, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'public.is_app_session_active(uuid)'::regprocedure, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('postgres', 'public.is_app_session_active(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: is_app_session_active execute';
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'private.is_app_bound_live_session()'::regprocedure, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', 'private.is_app_bound_live_session()'::regprocedure, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'private.is_app_bound_live_session()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: is_app_bound_live_session execute';
  END IF;
  -- no function is open to PUBLIC (aclexplode grantee 0)
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
    WHERE p.oid = ANY (ARRAY[
      'private.app_session_is_live(uuid)'::regprocedure, 'public.is_app_session_active(uuid)'::regprocedure,
      'private.is_app_bound_live_session()'::regprocedure
    ])
      AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: function open to PUBLIC';
  END IF;

  -- public.sessions stays closed to the Data API roles (wave 2, sec_grants_hardening)
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.sessions', v_privilege) THEN
        RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: sessions table privilege ' || v_role;
      END IF;
    END LOOP;
    IF pg_catalog.has_column_privilege(v_role, 'public.sessions', 'auth_session_id', 'SELECT')
       OR pg_catalog.has_column_privilege(v_role, 'public.sessions', 'auth_session_id', 'INSERT')
       OR pg_catalog.has_column_privilege(v_role, 'public.sessions', 'auth_session_id', 'UPDATE') THEN
      RAISE EXCEPTION 'SEC_WAVE5_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_app_session_binding: auth_session_id column privilege ' || v_role;
    END IF;
  END LOOP;
END
$sec_app_session_binding_assert$;

NOTIFY pgrst, 'reload schema';

COMMIT;
