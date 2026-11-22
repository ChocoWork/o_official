-- Passkey stage 4 / Task 32 (migration K): drop the password-era tables and functions that no code calls any more
-- (SR-AUTH-030, FR-AUTH-053, SEC-AUTH-060, ADR-0476). Tasks 26-31 removed every caller from the app.
--   functions: public.issue_password_change_challenge(uuid, uuid, text, integer), public.consume_password_change_challenge(uuid, uuid, text),
--              public.cleanup_password_reset_tokens(integer)
--   tables:    public.password_change_challenges, public.password_reset_tokens
-- No CASCADE: if anything still depends on an object, this migration stops. The audit tables and rows, auth_return_intents and
-- rate_limit_counters are NOT touched. Rows already in the two tables are one-time hashes that expire; they are NOT restored by the ROLLBACK.
--
-- ROLLBACK (one transaction). It recreates the objects in their FINAL shape as captured from the local DB before K was written
-- (pg_dump --schema-only of the two tables, pg_get_functiondef / proacl / proconfig of the three functions, relacl, policy counts),
-- including every later tightening (search_path 20260921011535, function EXECUTE 20261024153505, grants 20261026130200).
-- Do NOT replay the original 20260901102912 statements instead: they would GRANT the tables to anon and authenticated again.
-- Deleted rows do not come back.
--
--   BEGIN;
--   CREATE TABLE public.password_change_challenges (
--     id uuid DEFAULT gen_random_uuid() NOT NULL,
--     user_id uuid NOT NULL,
--     auth_session_id uuid NOT NULL,
--     code_hash text NOT NULL,
--     attempts smallint DEFAULT 0 NOT NULL,
--     expires_at timestamp with time zone NOT NULL,
--     used_at timestamp with time zone,
--     created_at timestamp with time zone DEFAULT now() NOT NULL,
--     CONSTRAINT password_change_challenges_pkey PRIMARY KEY (id),
--     CONSTRAINT password_change_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
--   );
--   CREATE INDEX password_change_challenges_open_idx ON public.password_change_challenges USING btree (user_id) WHERE (used_at IS NULL);
--   CREATE TABLE public.password_reset_tokens (
--     id uuid DEFAULT gen_random_uuid() NOT NULL,
--     user_id uuid,
--     email text NOT NULL,
--     token_hash text NOT NULL,
--     expires_at timestamp with time zone NOT NULL,
--     used boolean DEFAULT false NOT NULL,
--     created_at timestamp with time zone DEFAULT now() NOT NULL,
--     CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id),
--     CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
--   );
--   CREATE INDEX idx_password_reset_tokens_email_expires_at ON public.password_reset_tokens USING btree (email, expires_at DESC);
--   CREATE INDEX idx_password_reset_tokens_email_used ON public.password_reset_tokens USING btree (email, used);
--   CREATE UNIQUE INDEX idx_password_reset_tokens_token_hash ON public.password_reset_tokens USING btree (token_hash);
--   ALTER TABLE public.password_change_challenges OWNER TO postgres;
--   ALTER TABLE public.password_reset_tokens OWNER TO postgres;
--   ALTER TABLE public.password_change_challenges ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY password_change_challenges_deny_anon_all ON public.password_change_challenges TO anon USING (false) WITH CHECK (false);
--   CREATE POLICY password_change_challenges_deny_authenticated_all ON public.password_change_challenges TO authenticated USING (false) WITH CHECK (false);
--   CREATE POLICY password_change_challenges_service_role_all ON public.password_change_challenges TO service_role USING (true) WITH CHECK (true);
--   CREATE POLICY password_reset_tokens_deny_anon_all ON public.password_reset_tokens TO anon USING (false) WITH CHECK (false);
--   CREATE POLICY password_reset_tokens_deny_authenticated_all ON public.password_reset_tokens TO authenticated USING (false) WITH CHECK (false);
--   CREATE POLICY password_reset_tokens_service_role_all ON public.password_reset_tokens TO service_role USING (true) WITH CHECK (true);
--   REVOKE ALL ON TABLE public.password_change_challenges, public.password_reset_tokens FROM PUBLIC, anon, authenticated;
--   GRANT ALL ON TABLE public.password_change_challenges, public.password_reset_tokens TO service_role;
--   CREATE OR REPLACE FUNCTION public.issue_password_change_challenge(p_user_id uuid, p_auth_session_id uuid, p_code_hash text, p_ttl_seconds integer)
--    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
--   AS $function$
--   DECLARE
--     v_id uuid;
--   BEGIN
--     IF p_user_id IS NULL OR p_auth_session_id IS NULL THEN
--       RAISE EXCEPTION 'invalid password change challenge request' USING ERRCODE = '22023';
--     END IF;
--     IF p_ttl_seconds IS NULL OR p_ttl_seconds < 60 OR p_ttl_seconds > 900 THEN
--       RAISE EXCEPTION 'invalid password change challenge ttl' USING ERRCODE = '22023';
--     END IF;
--     IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
--       RAISE EXCEPTION 'invalid password change challenge hash' USING ERRCODE = '22023';
--     END IF;
--     PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('password_change:' || p_user_id::text, 0));
--     UPDATE public.password_change_challenges SET used_at = pg_catalog.now() WHERE user_id = p_user_id AND used_at IS NULL;
--     DELETE FROM public.password_change_challenges WHERE created_at < pg_catalog.now() - interval '1 day';
--     INSERT INTO public.password_change_challenges (user_id, auth_session_id, code_hash, expires_at)
--     VALUES (p_user_id, p_auth_session_id, p_code_hash, pg_catalog.now() + pg_catalog.make_interval(secs => p_ttl_seconds))
--     RETURNING id INTO v_id;
--     RETURN v_id;
--   END;
--   $function$;
--   CREATE OR REPLACE FUNCTION public.consume_password_change_challenge(p_user_id uuid, p_auth_session_id uuid, p_code_hash text)
--    RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
--   AS $function$
--   DECLARE
--     v_id uuid;
--     v_code_hash text;
--     v_attempts smallint;
--   BEGIN
--     SELECT c.id, c.code_hash, c.attempts INTO v_id, v_code_hash, v_attempts
--       FROM public.password_change_challenges AS c
--      WHERE c.user_id = p_user_id AND c.auth_session_id = p_auth_session_id AND c.used_at IS NULL AND c.expires_at > pg_catalog.now()
--      ORDER BY c.created_at DESC LIMIT 1 FOR UPDATE;
--     IF NOT FOUND THEN RETURN 'none'; END IF;
--     IF v_attempts >= 5 THEN RETURN 'locked'; END IF;
--     IF p_code_hash IS NOT NULL AND v_code_hash = p_code_hash THEN
--       UPDATE public.password_change_challenges SET used_at = pg_catalog.now() WHERE id = v_id;
--       RETURN 'ok';
--     END IF;
--     UPDATE public.password_change_challenges SET attempts = attempts + 1 WHERE id = v_id;
--     RETURN 'invalid';
--   END;
--   $function$;
--   CREATE OR REPLACE FUNCTION public.cleanup_password_reset_tokens(p_retain_days integer DEFAULT 7)
--    RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
--   AS $function$
--   DECLARE
--     deleted integer;
--     cutoff timestamptz := now() - make_interval(days => greatest(p_retain_days, 0));
--   BEGIN
--     DELETE FROM public.password_reset_tokens WHERE created_at < cutoff AND (used = true OR expires_at < now());
--     GET DIAGNOSTICS deleted = ROW_COUNT;
--     RETURN deleted;
--   END;
--   $function$;
--   REVOKE ALL ON FUNCTION public.issue_password_change_challenge(uuid, uuid, text, integer),
--     public.consume_password_change_challenge(uuid, uuid, text), public.cleanup_password_reset_tokens(integer) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.issue_password_change_challenge(uuid, uuid, text, integer),
--     public.consume_password_change_challenge(uuid, uuid, text), public.cleanup_password_reset_tokens(integer) TO service_role;
--   COMMIT;
--
-- Expected after the ROLLBACK (the values captured before K): relacl of both tables {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres};
-- proacl of the three functions {postgres=X/postgres,service_role=X/postgres}; proconfig {search_path=""}; 3 policies on each table.
--
-- BEFORE applying to production (read only): this migration is NOT applied to production until the production domain is decided.
-- Order: after J, and after the deployed app is confirmed not to call the removed entries.
--   select count(*) from public.password_reset_tokens;          -- the NOTICE below prints it too; a large number does not stop K
--   select count(*) from public.password_change_challenges;
--   select to_regclass('public.password_reset_tokens'), to_regclass('public.password_change_challenges');   -- expect not null before K

BEGIN;

DO $$
DECLARE
  v_reset bigint;
  v_challenge bigint;
BEGIN
  IF to_regclass('public.password_reset_tokens') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.password_reset_tokens' INTO v_reset;
    RAISE NOTICE 'passkey_k_password_reset_tokens_rows=%', v_reset;
  END IF;
  IF to_regclass('public.password_change_challenges') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.password_change_challenges' INTO v_challenge;
    RAISE NOTICE 'passkey_k_password_change_challenges_rows=%', v_challenge;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.issue_password_change_challenge(uuid, uuid, text, integer);
DROP FUNCTION IF EXISTS public.consume_password_change_challenge(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.cleanup_password_reset_tokens(integer);
DROP TABLE IF EXISTS public.password_change_challenges;
DROP TABLE IF EXISTS public.password_reset_tokens;

DO $$
BEGIN
  IF to_regclass('public.password_reset_tokens') IS NOT NULL OR to_regclass('public.password_change_challenges') IS NOT NULL
     OR to_regprocedure('public.issue_password_change_challenge(uuid, uuid, text, integer)') IS NOT NULL
     OR to_regprocedure('public.consume_password_change_challenge(uuid, uuid, text)') IS NOT NULL
     OR to_regprocedure('public.cleanup_password_reset_tokens(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_POSTCHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_drop_password_objects_postcheck';
  END IF;
END
$$;

COMMIT;
