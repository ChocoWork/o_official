-- Passkey stage 1b / Task 1 (migration F): functions the server endpoints use, and two hardenings of
-- public.passkey_approve (SR-AUTH-016, DATA-AUTH-018, DD-AUTH-050, SEC-AUTH-041).
--
-- New functions (SECURITY DEFINER, search_path empty, owner postgres, execute for service_role only):
--   public.passkey_is_staff(user) boolean                    STABLE. Same staff definition as the access token hook
--                                                            (an active, unexpired public.user_roles row whose role code
--                                                            is admin or supporter). null / unknown user: false. A DB error is
--                                                            NOT answered as false (fail closed: it propagates; the TS wrapper
--                                                            turns it into { ok: false }).
--   public.passkey_credential_is_approved(user, cred) bool   STABLE. cred is the RAW credential id (the caller turns the
--                                                            response rawId from base64url into bytes; PostgREST passes
--                                                            it as a \x hex string). Same join as passkey_approved_count
--                                                            (id, user_id and credential_id must all match). null / empty
--                                                            / unknown: false.
--   public.passkey_approved_ids(user) uuid[]                 STABLE. passkey ids counted by passkey_approved_count.
--
-- Changed function (CREATE OR REPLACE, same signature and grants):
--   public.passkey_approve(user, passkey, via)
--     1. A row for the same passkey_id with ANOTHER credential_id no longer passes silently (ON CONFLICT DO NOTHING hid
--        it and the key was never counted). It raises 23505 'passkey_approve: stale approval for this passkey'. The same
--        credential_id is still a quiet no-op. Fix by an operator: delete the stale row in SQL (SEC-AUTH-041).
--     2. via = 'window' takes a per-user transaction lock first, recounts passkey_approved_count under the lock and, when
--        it is already min_approved_passkeys or more (or the setting is missing: NULL), raises 55000 'passkey_approve: window limit reached' (no row is
--        added). This closes the race of two window approvals at once. A repeat for an already approved key adds no row,
--        so it is not blocked. reauth and script have no limit.
--     3. Every branch (window, reauth, script) takes the same per-user lock first, with the namespaced key
--        hashtextextended('passkey_approve:' || user, 0) (not the bare uuid text). An approval is serialized only with a deleter that
--        takes the same lock: public.passkey_delete_with_floor (the staff delete path) and private.staff_invite_issue_core
--        (migration H; the other H functions that take it are staff_demote, staff_role_activate and the invite cancel / bind).
--        NOT serialized (they reach GoTrue without the lock): the customer branch of passkey/[id]/route.ts, the cleanup delete in
--        register/finish/route.ts, and any delete made straight against GoTrue (see KNOWN REMAINING RISK below).
--        via = 'reauth' raises 42501 'PASSKEY_REAUTH_NOT_ALLOWED' when the user has no
--        approved key yet (SEC-AUTH-052).
--     Unchanged: another user's key raises 42501; the same credential_id under another passkey_id raises 23505.
--
-- KNOWN REMAINING RISK: a delete that goes straight to GoTrue (auth.webauthn_credentials removed through the GoTrue admin
-- API or a direct SQL DELETE) does NOT take this function's per-user lock, so it can still interleave with an approval.
-- The production runbook lists it as an operator caution.
--
-- This migration changes no existing behaviour for anything that calls passkey_approve with a fresh key (the 1a triggers,
-- the dev staff script). It is NOT applied to production until stage 3. Never db push it.
--
-- ROLLBACK (one transaction, only when nothing uses the new functions yet):
--   DROP FUNCTION public.passkey_approved_ids(uuid), public.passkey_credential_is_approved(uuid, bytea),
--     public.passkey_is_staff(uuid);
--   then CREATE OR REPLACE public.passkey_approve(uuid, uuid, text) with the body of migration A
--   (20261116215034_passkey_foundation_tables.sql). The A body has md5(prosrc) = e0b5dc02ecfcb5533cd91a00edc55fe4
--   (876 characters) measured on the local database before this migration. Keep owner postgres and the grants.
--
-- BEFORE applying to production (read only):
--   select to_regprocedure('public.passkey_approve(uuid,uuid,text)');   -- expect not null (migration A)
--   select to_regprocedure('public.passkey_is_staff(uuid)');            -- expect null

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.passkey_approve(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.passkey_approved_count(uuid)') IS NULL
     OR to_regprocedure('private.passkey_staff_settings()') IS NULL
     OR to_regclass('private.approved_passkeys') IS NULL
     OR to_regclass('auth.webauthn_credentials') IS NULL
     OR to_regclass('public.user_roles') IS NULL
     OR to_regclass('public.roles') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_f_precheck';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.passkey_is_staff(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE((
    SELECT EXISTS (
      SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = p_user_id
         AND ur.active
         AND (ur.expires_at IS NULL OR ur.expires_at > now())
         AND r.code IN ('admin', 'supporter')
    )
  ), false);
END
$$;

CREATE OR REPLACE FUNCTION public.passkey_credential_is_approved(p_user_id uuid, p_credential_id bytea)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(
    p_user_id IS NOT NULL
    AND p_credential_id IS NOT NULL
    AND length(p_credential_id) > 0
    AND EXISTS (
      SELECT 1
        FROM private.approved_passkeys ap
        JOIN auth.webauthn_credentials c ON c.id = ap.passkey_id AND c.user_id = ap.user_id AND c.credential_id = ap.credential_id
       WHERE ap.user_id = p_user_id
         AND ap.credential_id = p_credential_id
    ),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.passkey_approved_ids(p_user_id uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(ap.passkey_id ORDER BY ap.approved_at, ap.passkey_id), '{}'::uuid[])
    FROM private.approved_passkeys ap
    JOIN auth.webauthn_credentials c ON c.id = ap.passkey_id AND c.user_id = ap.user_id AND c.credential_id = ap.credential_id
   WHERE ap.user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.passkey_approve(p_user_id uuid, p_passkey_id uuid, p_via text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
  v_cred bytea;
  v_min integer;
BEGIN
  -- Every approval (window, reauth, script) is serialised per user under one namespaced lock, and the counts below are
  -- read under it (SEC-AUTH-041, SEC-AUTH-052). The 'passkey_approve:' prefix keeps this key apart from any other feature
  -- that locks on hashtextextended(uuid::text, 0).
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0));
  SELECT c.user_id, c.credential_id INTO v_owner, v_cred
    FROM auth.webauthn_credentials c WHERE c.id = p_passkey_id;
  IF NOT FOUND OR v_owner IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'passkey_not_owned' USING ERRCODE = '42501';
  END IF;
  -- Only the Task 6 trigger deletes approval rows. A row with the same credential_id under another passkey_id is
  -- refused, not replaced.
  IF EXISTS (SELECT 1 FROM private.approved_passkeys a WHERE a.credential_id = v_cred AND a.passkey_id <> p_passkey_id) THEN
    RAISE EXCEPTION 'passkey_approve: credential already approved under another passkey' USING ERRCODE = '23505';
  END IF;
  -- A row for this passkey with another credential_id is stale: say so instead of passing silently.
  IF EXISTS (SELECT 1 FROM private.approved_passkeys a WHERE a.passkey_id = p_passkey_id AND a.credential_id <> v_cred) THEN
    RAISE EXCEPTION 'passkey_approve: stale approval for this passkey' USING ERRCODE = '23505';
  END IF;
  -- reauth only adds a key for a user who already has an approved one. The first keys of a staff member come in only by
  -- window or script. The caller (passkey-recent-auth.ts) checks the 5 minute passkey re-authentication (SEC-AUTH-052).
  IF p_via = 'reauth' AND public.passkey_approved_count(p_user_id) < 1 THEN
    RAISE EXCEPTION 'PASSKEY_REAUTH_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  IF p_via = 'window'
     AND NOT EXISTS (SELECT 1 FROM private.approved_passkeys a WHERE a.passkey_id = p_passkey_id) THEN
    v_min := (private.passkey_staff_settings() ->> 'min_approved_passkeys')::integer;
    IF v_min IS NULL OR public.passkey_approved_count(p_user_id) >= v_min THEN
      RAISE EXCEPTION 'passkey_approve: window limit reached' USING ERRCODE = '55000';
    END IF;
  END IF;
  INSERT INTO private.approved_passkeys (passkey_id, user_id, credential_id, approved_via)
  VALUES (p_passkey_id, p_user_id, v_cred, p_via)
  ON CONFLICT (passkey_id) DO NOTHING;
END
$$;

REVOKE ALL ON FUNCTION public.passkey_is_staff(uuid), public.passkey_credential_is_approved(uuid, bytea),
  public.passkey_approved_ids(uuid), public.passkey_approve(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passkey_is_staff(uuid), public.passkey_credential_is_approved(uuid, bytea),
  public.passkey_approved_ids(uuid), public.passkey_approve(uuid, uuid, text) TO service_role;

ALTER FUNCTION public.passkey_is_staff(uuid) OWNER TO postgres;
ALTER FUNCTION public.passkey_credential_is_approved(uuid, bytea) OWNER TO postgres;
ALTER FUNCTION public.passkey_approved_ids(uuid) OWNER TO postgres;
ALTER FUNCTION public.passkey_approve(uuid, uuid, text) OWNER TO postgres;

-- PASSKEY_F_FINAL_ASSERT
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.passkey_is_staff(uuid)', 'public.passkey_credential_is_approved(uuid,bytea)',
    'public.passkey_approved_ids(uuid)', 'public.passkey_approve(uuid,uuid,text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_f_function_acl';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid = f::regprocedure AND p.prosecdef AND p.proowner = 'postgres'::regrole
        AND p.proconfig @> ARRAY['search_path=""']
    ) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_f_function_attrs';
    END IF;
  END LOOP;
  IF position('stale approval' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.passkey_approve(uuid,uuid,text)'::regprocedure)) = 0
     OR position('window limit reached' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.passkey_approve(uuid,uuid,text)'::regprocedure)) = 0
     OR position('hashtextextended(''passkey_approve:'' || p_user_id::text, 0)' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.passkey_approve(uuid,uuid,text)'::regprocedure)) = 0
     OR position('PASSKEY_REAUTH_NOT_ALLOWED' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.passkey_approve(uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_f_approve_body';
  END IF;
END
$$;
-- PASSKEY_F_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
