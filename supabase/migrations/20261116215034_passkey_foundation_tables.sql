-- Passkey stage 1a / Task 4 (migration A): staff passkey settings, registration windows, approved passkeys and the
-- notification outbox, plus the window / approval functions (SR-AUTH-010, DD-AUTH-043, ADR-0464, SEC-AUTH-036).
-- This migration only ADDS tables and functions. Nothing calls them until the access token hook (Task 5) and the
-- triggers (Task 6) ship. It changes no existing behaviour.
--
-- Tables (all in schema private; anon / authenticated get nothing; RLS on, no policy):
--   private.passkey_staff_config            one row: staff_max_session_seconds 86400, staff_idle_seconds 3600,
--                                           window_minutes 30, min_approved_passkeys 2, reject_customer_password false
--   private.approved_passkeys               passkeys the app approved. user_id has NO foreign key on purpose: a cascade
--                                           from auth.users would delete the row before the trigger can tell whether the
--                                           owner was staff. Only the Task 6 trigger deletes rows.
--   private.passkey_registration_windows    plan B: the app opens a window for (user_id, session_id) after it knows the
--                                           session id. At most one open window per session_id (partial unique index).
--   private.passkey_notification_outbox     rows queued by the Task 6 triggers; sending is stage 2 / 3.
--
-- Measured on the local GoTrue (2026-11-16, \d auth.webauthn_credentials):
--   id uuid pk default gen_random_uuid(); user_id uuid not null (fk auth.users on delete cascade);
--   credential_id bytea not null (unique); public_key bytea not null; attestation_type text not null default '';
--   aaguid uuid; sign_count bigint not null default 0; transports jsonb not null default '[]';
--   backup_eligible boolean not null; backed_up boolean not null; friendly_name text not null default '';
--   created_at, updated_at timestamptz not null default now(); last_used_at timestamptz.
-- So approved_passkeys.credential_id is bytea.
--
-- Functions (SECURITY DEFINER, search_path empty):
--   private.passkey_staff_settings() jsonb            STABLE; no execute for public / anon / authenticated (has_permission
--                                                     and the hook run as owner)
--   public.passkey_approve(user, passkey, via)        copies credential_id from auth.webauthn_credentials; raises when the
--                                                     key is missing or owned by someone else; idempotent
--   public.passkey_window_open(user, session)         checks auth.sessions; returns expires_at (existing one if open)
--   public.passkey_window_close(session)
--   public.passkey_window_is_open(user, session)
--   public.passkey_approved_count(user)               counts only approvals whose key still exists for that user
--   public.passkey_* : execute for service_role only.
--
-- ROLLBACK (reverse order; run in one transaction, only when nothing uses them yet):
--   DROP FUNCTION public.passkey_approved_count(uuid), public.passkey_window_is_open(uuid, uuid),
--     public.passkey_window_close(uuid), public.passkey_window_open(uuid, uuid),
--     public.passkey_approve(uuid, uuid, text), private.passkey_staff_settings();
--   DROP TABLE private.passkey_notification_outbox, private.passkey_registration_windows,
--     private.approved_passkeys, private.passkey_staff_config;
--
-- BEFORE applying to production (read only): this migration is NOT applied to production until stage 1b and 3 are done.
--   select to_regclass('private.passkey_staff_config');   -- expect null
--   select to_regclass('auth.webauthn_credentials');       -- expect not null (passkeys need the beta Auth version)

BEGIN;

DO $$
BEGIN
  IF to_regclass('auth.webauthn_credentials') IS NULL OR to_regnamespace('private') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_precheck';
  END IF;
END
$$;

CREATE TABLE private.passkey_staff_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  staff_max_session_seconds integer NOT NULL DEFAULT 86400 CHECK (staff_max_session_seconds > 0),
  staff_idle_seconds integer NOT NULL DEFAULT 3600 CHECK (staff_idle_seconds > 0),
  window_minutes integer NOT NULL DEFAULT 30 CHECK (window_minutes > 0),
  min_approved_passkeys integer NOT NULL DEFAULT 2 CHECK (min_approved_passkeys >= 1),
  reject_customer_password boolean NOT NULL DEFAULT false
);
INSERT INTO private.passkey_staff_config (id) VALUES (true);

CREATE TABLE private.approved_passkeys (
  passkey_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  credential_id bytea NOT NULL UNIQUE,
  approved_via text NOT NULL CHECK (approved_via IN ('window', 'reauth', 'script')),
  approved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approved_passkeys_user_id_idx ON private.approved_passkeys (user_id);

CREATE TABLE private.passkey_registration_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz
);
CREATE UNIQUE INDEX passkey_registration_windows_open_session_idx
  ON private.passkey_registration_windows (session_id) WHERE closed_at IS NULL;
CREATE INDEX passkey_registration_windows_user_id_idx ON private.passkey_registration_windows (user_id);

CREATE TABLE private.passkey_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('passkey_added', 'passkey_removed', 'passkey_key_replaced')),
  passkey_id uuid,
  friendly_name text,
  subject_is_staff boolean NOT NULL,
  notify_subject boolean NOT NULL,
  subject_email text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'retry_wait', 'sent', 'skipped', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkey_notification_outbox_due_idx
  ON private.passkey_notification_outbox (next_attempt_at) WHERE status IN ('pending', 'retry_wait');

ALTER TABLE private.passkey_staff_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.approved_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.passkey_registration_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.passkey_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.passkey_staff_config, private.approved_passkeys,
  private.passkey_registration_windows, private.passkey_notification_outbox FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.passkey_staff_settings()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT to_jsonb(c) - 'id' FROM private.passkey_staff_config c WHERE c.id;
$$;
REVOKE ALL ON FUNCTION private.passkey_staff_settings() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.passkey_approve(p_user_id uuid, p_passkey_id uuid, p_via text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
  v_cred bytea;
BEGIN
  SELECT c.user_id, c.credential_id INTO v_owner, v_cred
    FROM auth.webauthn_credentials c WHERE c.id = p_passkey_id;
  IF NOT FOUND OR v_owner IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'passkey_not_owned' USING ERRCODE = '42501';
  END IF;
  INSERT INTO private.approved_passkeys (passkey_id, user_id, credential_id, approved_via)
  VALUES (p_passkey_id, p_user_id, v_cred, p_via)
  ON CONFLICT (passkey_id) DO NOTHING;
END
$$;

CREATE OR REPLACE FUNCTION public.passkey_window_open(p_user_id uuid, p_session_id uuid)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_minutes integer;
  v_expires timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = p_session_id AND s.user_id = p_user_id) THEN
    RAISE EXCEPTION 'session_not_owned' USING ERRCODE = '42501';
  END IF;
  UPDATE private.passkey_registration_windows w SET closed_at = now()
    WHERE w.session_id = p_session_id AND w.closed_at IS NULL AND w.expires_at <= now();
  SELECT c.window_minutes INTO v_minutes FROM private.passkey_staff_config c WHERE c.id;
  INSERT INTO private.passkey_registration_windows (user_id, session_id, expires_at)
  VALUES (p_user_id, p_session_id, now() + make_interval(mins => v_minutes))
  ON CONFLICT (session_id) WHERE closed_at IS NULL DO NOTHING;
  SELECT w.expires_at INTO v_expires FROM private.passkey_registration_windows w
    WHERE w.session_id = p_session_id AND w.closed_at IS NULL;
  RETURN v_expires;
END
$$;

CREATE OR REPLACE FUNCTION public.passkey_window_close(p_session_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE private.passkey_registration_windows SET closed_at = now()
    WHERE session_id = p_session_id AND closed_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.passkey_window_is_open(p_user_id uuid, p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.passkey_registration_windows w
    WHERE w.user_id = p_user_id AND w.session_id = p_session_id AND w.closed_at IS NULL AND w.expires_at > now()
  );
$$;

CREATE OR REPLACE FUNCTION public.passkey_approved_count(p_user_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT count(*)::integer
    FROM private.approved_passkeys ap
    JOIN auth.webauthn_credentials c ON c.id = ap.passkey_id AND c.user_id = ap.user_id
   WHERE ap.user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.passkey_approve(uuid, uuid, text), public.passkey_window_open(uuid, uuid),
  public.passkey_window_close(uuid), public.passkey_window_is_open(uuid, uuid),
  public.passkey_approved_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passkey_approve(uuid, uuid, text), public.passkey_window_open(uuid, uuid),
  public.passkey_window_close(uuid), public.passkey_window_is_open(uuid, uuid),
  public.passkey_approved_count(uuid) TO service_role;

-- PASSKEY_A_FINAL_ASSERT
DO $$
DECLARE
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['passkey_staff_config', 'approved_passkeys', 'passkey_registration_windows',
    'passkey_notification_outbox'] LOOP
    IF has_table_privilege('anon', 'private.' || t, 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'private.' || t, 'SELECT,INSERT,UPDATE,DELETE')
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('private.' || t)::regclass) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_table_acl';
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.passkey_approve(uuid,uuid,text)', 'public.passkey_window_open(uuid,uuid)',
    'public.passkey_window_close(uuid)', 'public.passkey_window_is_open(uuid,uuid)',
    'public.passkey_approved_count(uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_function_acl';
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'private.passkey_staff_settings()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.passkey_staff_settings()', 'EXECUTE')
     OR (SELECT count(*) FROM private.passkey_staff_config) <> 1 THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_settings';
  END IF;
END
$$;
-- PASSKEY_A_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
