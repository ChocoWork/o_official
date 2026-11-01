-- Wave 6 / Task 4 (M3): the one-time code table for changing a member's password (SEC-AUTH-034, SEC-AUTH-015-AC-02;
-- ADR-0421, DATA-AUTH-009 / DATA-AUTH-010). This migration only ADDS a table and two functions. It changes no
-- existing behaviour; nothing calls it until the password-change window (wave 6 Task 5) ships.
--
-- Why a table (plan ruling 3):
--   * The application sends an 8 digit code by e-mail after the member proved the current password (step "start"), and
--     asks for it again together with the new password (step "confirm"). A signed cookie alone cannot make the code
--     single use, cannot count wrong guesses and cannot let a newer code invalidate an older one.
--   * public.password_change_challenges
--       auth_session_id  the GoTrue session that asked for the code. A code asked for in one session is useless in another.
--       code_hash        HMAC-SHA256 (hex, 64 chars) made by the application from
--                        'password_change:' || user_id || ':' || auth_session_id || ':' || code, keyed with JWT_SECRET.
--                        The plain code is never stored. A bare sha256 would be reversible: there are only 10^8 codes.
--       attempts         wrong guesses. Five wrong guesses lock the code.
--       expires_at       the caller passes a TTL; the application uses 10 minutes (the function accepts 60..900 seconds).
--       used_at          set when the code is consumed or replaced by a newer one.
--   * public.issue_password_change_challenge(user, auth session, code_hash, ttl)
--       voids every open code of the user, deletes rows older than one day, inserts the new row and returns its id.
--       One transaction; calls for one user are serialised by a transaction advisory lock.
--   * public.consume_password_change_challenge(user, auth session, code_hash) returns
--       'ok'      the code matched; used_at is now set (a second call returns 'none').
--       'invalid' the code did not match; attempts was raised by one in the same locked row.
--       'locked'  attempts is already 5 or more; even the right code is refused.
--       'none'    no open, unexpired row for this user and this auth session (also: a different session).
--     The row is read with SELECT ... FOR UPDATE, so parallel guesses queue up and attempts can not pass 5.
--   * Only service_role may read, write or call. anon and authenticated are denied by privileges and by RLS policies
--     (the same shape as password_reset_tokens). Nothing here uses ALTER DEFAULT PRIVILEGES (ADR-0414).
--
-- The table is not idempotent on purpose: an unexpected existing table must fail the migration. Functions use
-- CREATE OR REPLACE (db-migrations.md) and restate SET search_path.
--
-- BEFORE applying to production (read only; keep the results as the rollback reference):
--   select max(version) from supabase_migrations.schema_migrations;   -- expect 20261029130600 or later; this file's timestamp is provisional
--   select to_regclass('public.password_change_challenges');          -- expect null
--   select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname in ('issue_password_change_challenge', 'consume_password_change_challenge');  -- expect 0 rows
--
-- Apply boundary: safe to apply before the application ships (nothing calls it). It MUST be applied before the
-- password-change window (Task 5) and its screen (Task 6) run against this database.
--
-- ROLLBACK (stop the password-change window and screen first):
--   DROP FUNCTION IF EXISTS public.consume_password_change_challenge(uuid, uuid, text);
--   DROP FUNCTION IF EXISTS public.issue_password_change_challenge(uuid, uuid, text, integer);
--   DROP TABLE IF EXISTS public.password_change_challenges;
BEGIN;

-- 1. The table, its partial index and the closed access (RLS + privileges).
CREATE TABLE public.password_change_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  auth_session_id uuid NOT NULL,
  code_hash text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_change_challenges_open_idx ON public.password_change_challenges (user_id)
  WHERE used_at IS NULL;

ALTER TABLE public.password_change_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "password_change_challenges_deny_anon_all" ON public.password_change_challenges
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

CREATE POLICY "password_change_challenges_deny_authenticated_all" ON public.password_change_challenges
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "password_change_challenges_service_role_all" ON public.password_change_challenges
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.password_change_challenges FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.password_change_challenges TO service_role;

-- 2. Issue a code: void the open ones, sweep old rows, insert the new one.
CREATE OR REPLACE FUNCTION public.issue_password_change_challenge(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_code_hash text,
  p_ttl_seconds integer
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_auth_session_id IS NULL THEN
    RAISE EXCEPTION 'invalid password change challenge request' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 900 THEN
    RAISE EXCEPTION 'invalid password change challenge ttl' USING ERRCODE = '22023';
  END IF;
  -- The stored value must be the keyed hash (hex, 64 chars), never a plain code.
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid password change challenge hash' USING ERRCODE = '22023';
  END IF;

  -- One caller per user at a time: two parallel starts can not leave two open codes.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('password_change:' || p_user_id::text, 0));

  UPDATE public.password_change_challenges
     SET used_at = pg_catalog.now()
   WHERE user_id = p_user_id
     AND used_at IS NULL;

  DELETE FROM public.password_change_challenges
   WHERE created_at < pg_catalog.now() - interval '1 day';

  INSERT INTO public.password_change_challenges (user_id, auth_session_id, code_hash, expires_at)
  VALUES (p_user_id, p_auth_session_id, p_code_hash, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
ALTER FUNCTION public.issue_password_change_challenge(uuid, uuid, text, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.issue_password_change_challenge(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_password_change_challenge(uuid, uuid, text, integer) TO service_role;

-- 3. Consume a code: ok / invalid / locked / none. The row lock keeps parallel guesses from passing 5 attempts.
CREATE OR REPLACE FUNCTION public.consume_password_change_challenge(
  p_user_id uuid,
  p_auth_session_id uuid,
  p_code_hash text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_code_hash text;
  v_attempts smallint;
BEGIN
  SELECT c.id, c.code_hash, c.attempts
    INTO v_id, v_code_hash, v_attempts
    FROM public.password_change_challenges AS c
   WHERE c.user_id = p_user_id
     AND c.auth_session_id = p_auth_session_id
     AND c.used_at IS NULL
     AND c.expires_at > pg_catalog.now()
   ORDER BY c.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'none';
  END IF;

  IF v_attempts >= 5 THEN
    RETURN 'locked';
  END IF;

  IF p_code_hash IS NOT NULL AND v_code_hash = p_code_hash THEN
    UPDATE public.password_change_challenges
       SET used_at = pg_catalog.now()
     WHERE id = v_id;
    RETURN 'ok';
  END IF;

  UPDATE public.password_change_challenges
     SET attempts = attempts + 1
   WHERE id = v_id;
  RETURN 'invalid';
END;
$$;
ALTER FUNCTION public.consume_password_change_challenge(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.consume_password_change_challenge(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_password_change_challenge(uuid, uuid, text) TO service_role;

-- 4. Self check: any failure rolls the whole migration back.
DO $sec_password_change_challenges_assert$
DECLARE
  v_column record;
  v_signature text;
  v_privilege text;
  v_role text;
BEGIN
  -- columns: type and NOT NULL
  FOR v_column IN
    SELECT * FROM (VALUES
      ('id', 'uuid', 'NO'),
      ('user_id', 'uuid', 'NO'),
      ('auth_session_id', 'uuid', 'NO'),
      ('code_hash', 'text', 'NO'),
      ('attempts', 'smallint', 'NO'),
      ('expires_at', 'timestamp with time zone', 'NO'),
      ('used_at', 'timestamp with time zone', 'YES'),
      ('created_at', 'timestamp with time zone', 'NO')
    ) AS expected(column_name, data_type, is_nullable)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'password_change_challenges'
        AND c.column_name = v_column.column_name AND c.data_type = v_column.data_type
        AND c.is_nullable = v_column.is_nullable
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: column ' || v_column.column_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'password_change_challenges') <> 8 THEN
    RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: column count';
  END IF;

  -- the foreign key to auth.users with ON DELETE CASCADE
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint k
    WHERE k.conrelid = 'public.password_change_challenges'::regclass
      AND k.contype = 'f'
      AND k.confrelid = 'auth.users'::regclass
      AND k.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: foreign key';
  END IF;

  -- the partial index
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = 'public.password_change_challenges'::regclass
      AND ic.relname = 'password_change_challenges_open_idx'
      AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: partial index';
  END IF;

  -- RLS on, three policies
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid = 'public.password_change_challenges'::regclass AND c.relrowsecurity
  ) OR (SELECT count(*) FROM pg_catalog.pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = 'password_change_challenges') <> 3 THEN
    RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: row level security';
  END IF;

  -- table privileges: anon and authenticated have none; service_role has the four row operations
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.password_change_challenges', v_privilege) THEN
        RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: table privilege ' || v_role;
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT pg_catalog.has_table_privilege('service_role', 'public.password_change_challenges', v_privilege) THEN
      RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: service_role ' || v_privilege;
    END IF;
  END LOOP;

  -- the two functions: owner, SECURITY DEFINER, empty search_path, EXECUTE for service_role only, never PUBLIC
  FOREACH v_signature IN ARRAY ARRAY[
    'public.issue_password_change_challenge(uuid,uuid,text,integer)',
    'public.consume_password_change_challenge(uuid,uuid,text)'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = v_signature::regprocedure
        AND p.proowner = 'postgres'::regrole
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=""']
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: function definition ' || v_signature;
    END IF;
    IF pg_catalog.has_function_privilege('anon', v_signature::regprocedure, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature::regprocedure, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature::regprocedure, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('postgres', v_signature::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: function execute ' || v_signature;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
    WHERE p.oid = ANY (ARRAY[
      'public.issue_password_change_challenge(uuid,uuid,text,integer)'::regprocedure,
      'public.consume_password_change_challenge(uuid,uuid,text)'::regprocedure
    ])
      AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE6_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_password_change_challenges: function open to PUBLIC';
  END IF;
END
$sec_password_change_challenges_assert$;

NOTIFY pgrst, 'reload schema';

COMMIT;
