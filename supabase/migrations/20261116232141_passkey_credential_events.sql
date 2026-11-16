-- Passkey stage 1a / Task 6 (migration C): the trigger on auth.webauthn_credentials that queues notifications in
-- private.passkey_notification_outbox and removes approval rows (SR-AUTH-012, DD-AUTH-045, ADR-0465, SEC-AUTH-038).
-- It only ADDS one function and one trigger. The outbox is not sent yet (stage 2 / 3).
--
-- private.passkey_credentials_notify() returns trigger   SECURITY DEFINER, owner postgres, search_path empty, no execute for anyone.
-- Trigger passkey_credentials_notify: AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW on auth.webauthn_credentials.
--   INSERT -> passkey_added. DELETE -> passkey_removed and the approval row of the same passkey_id is deleted.
--   UPDATE only when credential_id or public_key changed -> passkey_key_replaced and the approval row is deleted.
--     Name / sign_count / last_used_at updates do nothing.
--   Order: (1) delete the approval row, outside any exception block, and keep FOUND in v_was_approved on the very next
--   statement; (2) only the outbox insert is inside BEGIN ... EXCEPTION WHEN OTHERS THEN RAISE WARNING, so a failing
--   outbox never blocks deleting a key or a user, and never rolls back the approval delete.
--   subject_is_staff = active staff (admin / supporter in user_roles, same rule as the access token hook) OR the key
--   was approved. notify_subject = the auth.users row still exists. A customer deleted by cascade queues nothing.
--   subject_email is copied from auth.users.email when notify_subject is true.
--
-- NOT covered (SEC-AUTH-038): TRUNCATE, DISABLE TRIGGER, session_replication_role = replica, a failing outbox write
--   (WARNING only), a cloned credential detected by GoTrue. The approved count also checks auth.webauthn_credentials (same id, user and credential_id, so an approval whose credential_id no longer matches is not counted).
-- NOT verified: whether production lets postgres create this trigger, and whether a GoTrue update drops it
--   (design 8-2 item 3). Check before production: select has_table_privilege('postgres','auth.webauthn_credentials','TRIGGER');
--
-- ROLLBACK (postgres does NOT own auth.webauthn_credentials, so it cannot DROP or DISABLE the trigger):
--   1. as postgres, make the function a no-op:
--        CREATE OR REPLACE FUNCTION private.passkey_credentials_notify() RETURNS trigger LANGUAGE plpgsql
--          SECURITY DEFINER SET search_path = '' AS $f$ BEGIN RETURN NULL; END $f$;
--   2. as supabase_auth_admin (the table owner; support step):
--        DROP TRIGGER passkey_credentials_notify ON auth.webauthn_credentials;
--      then, as postgres:  DROP FUNCTION private.passkey_credentials_notify();
-- NOT applied to production until stage 1b and 3 are done.

BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.webauthn_credentials') IS NULL
     OR to_regclass('private.approved_passkeys') IS NULL
     OR to_regclass('private.passkey_notification_outbox') IS NULL
     OR to_regclass('public.user_roles') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_trigger_precheck';
  END IF;
  IF NOT has_table_privilege(current_user, 'auth.webauthn_credentials', 'TRIGGER') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_trigger_privilege';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION private.passkey_credentials_notify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_kind text;
  v_user uuid;
  v_pid uuid;
  v_name text;
  v_was_approved boolean := false;
  v_is_staff boolean;
  v_email text;
  v_exists boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_kind := 'passkey_added'; v_user := NEW.user_id; v_pid := NEW.id; v_name := NEW.friendly_name;
  ELSIF TG_OP = 'DELETE' THEN
    v_kind := 'passkey_removed'; v_user := OLD.user_id; v_pid := OLD.id; v_name := OLD.friendly_name;
    DELETE FROM private.approved_passkeys WHERE passkey_id = OLD.id;
    v_was_approved := FOUND;
  ELSE
    IF NEW.credential_id IS NOT DISTINCT FROM OLD.credential_id AND NEW.public_key IS NOT DISTINCT FROM OLD.public_key THEN
      RETURN NULL;
    END IF;
    v_kind := 'passkey_key_replaced'; v_user := OLD.user_id; v_pid := OLD.id; v_name := NEW.friendly_name;
    DELETE FROM private.approved_passkeys WHERE passkey_id = OLD.id;
    v_was_approved := FOUND;
  END IF;

  BEGIN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = v_user AND ur.active
         AND (ur.expires_at IS NULL OR ur.expires_at > now())
         AND r.code IN ('admin', 'supporter')
    ) INTO v_is_staff;
    v_is_staff := COALESCE(v_is_staff, false) OR v_was_approved;

    SELECT true, u.email INTO v_exists, v_email FROM auth.users u WHERE u.id = v_user;
    v_exists := COALESCE(v_exists, false);

    IF v_is_staff OR v_exists THEN
      INSERT INTO private.passkey_notification_outbox
        (user_id, kind, passkey_id, friendly_name, subject_is_staff, notify_subject, subject_email)
      VALUES
        (v_user, v_kind, v_pid, v_name, v_is_staff, v_exists, CASE WHEN v_exists THEN v_email END);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'passkey_credentials_notify: outbox write failed (%): %', SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END
$$;

ALTER FUNCTION private.passkey_credentials_notify() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.passkey_credentials_notify() FROM PUBLIC, anon, authenticated, service_role;

-- Create only when missing: a re-run must not need table ownership (the function above is replaced in place).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'auth.webauthn_credentials'::regclass AND t.tgname = 'passkey_credentials_notify' AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER passkey_credentials_notify
      AFTER INSERT OR UPDATE OR DELETE ON auth.webauthn_credentials
      FOR EACH ROW EXECUTE FUNCTION private.passkey_credentials_notify();
  END IF;
END
$$;

-- PASSKEY_C_FINAL_ASSERT
DO $$
DECLARE
  f CONSTANT text := 'private.passkey_credentials_notify()';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'auth.webauthn_credentials'::regclass AND t.tgname = 'passkey_credentials_notify'
       AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = f::regprocedure
       AND t.tgtype = 29 AND t.tgattr = ''::int2vector AND t.tgqual IS NULL
  ) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_trigger_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = f::regprocedure AND p.prosecdef AND p.proowner = 'postgres'::regrole
       AND p.proconfig @> ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_trigger_attrs';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('service_role', f, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_trigger_acl';
  END IF;
END
$$;
-- PASSKEY_C_FINAL_ASSERT_END
COMMIT;
