-- Passkey stage 3a / Task 2 (migration H, first half): the staff invite table and the issue / consume / bind / activate /
-- cancel / open functions (SR-AUTH-026, FR-AUTH-034, FR-AUTH-035, DATA-AUTH-020, SEC-AUTH-053, DD-AUTH-070, ADR-0471).
-- The second half (Task 2b, same file while unapplied) is at the end: admin_set_user_role rebuilt, staff_demote, the dashboard
-- last resort and passkey_delete_with_floor (SEC-AUTH-054, FR-AUTH-037, DD-AUTH-073).
-- It ADDS one table, two private functions and eight public functions, and REPLACES one body (private.admin_set_user_role).
-- Nothing calls the new ones yet (stage 3a Task 4+).
--
-- Table private.staff_invites (RLS on, no policy, no privilege for anon / authenticated / service_role, owner postgres):
--   id, user_id (FK auth.users, cascade), role_code (admin | supporter), kind (invite | redo | promote | last_resort),
--   token_hash bytea unique (SHA-256 of the UTF-8 bytes of the base64url token string), issued_by, reason, expires_at,
--   consumed_at, session_id, bound_at, activated_at, cancelled_at, created_at.
--   At most ONE row per user that is neither cancelled nor activated (partial unique index).
--
-- Functions (SECURITY DEFINER, search_path empty, owner postgres):
--   private.staff_invite_issue_core(...)  NO execute for anyone. Only the two doors below call it (Task 2: staff_invite_issue;
--     Task 2b: private.staff_invite_issue_manual). One transaction, in this order:
--       1. lock 190519 (global, the same key admin_set_user_role takes), THEN the per-user key
--          hashtextextended('passkey_approve:' || user, 0) (the same key passkey_approve takes). ORDER MATTERS: always
--          global first, user key second. admin_set_user_role takes only 190519; passkey_approve takes only the user key; a
--          function that takes the user key first and 190519 second can deadlock with the global holder. Keep this order in
--          every function of this file that takes both (issue, activate, cancel, bind).
--       2. after the locks: the issuer must still be an active, unexpired admin holding admin.users.manage
--          (ROLE_PERMISSION_FORBIDDEN; skipped only for the last resort); the user must exist (USER_NOT_FOUND, P0002);
--       3. the target is the only active admin -> LAST_ADMIN_REQUIRED (skipped for the last resort); issuer = target ->
--          SELF_ROLE_CHANGE_FORBIDDEN;
--       4. cancel the user's old open invite, close the user's open windows;
--       5. delete the user's auth.webauthn_credentials (the C trigger removes the approvals and queues one
--          passkey_removed notice per key) and every leftover approved_passkeys row;
--       6. delete EVERY auth.mfa_factors row of the user (totp, phone, webauthn: GoTrue asks for aal2 when any factor is left);
--       7. user_roles.active = false for all rows, raw_app_meta_data.role = 'user';
--       8. mark the passkey_removed notices queued in step 5 as skipped (last_error_code staff_invite_issue): the owner is told
--          once by the stage 3b mail instead of once per key;
--       9. insert the new invite row and return its id.
--   public.staff_invite_issue(user, role, kind, issued_by, reason, token_hash, ttl_seconds default 86400) returns uuid
--     kind must be invite | redo | promote (anything else, last_resort included, raises STAFF_INVITE_KIND_FORBIDDEN, so the
--     app key cannot reach the last resort). A current staff member needs kind redo (STAFF_ALREADY_STAFF otherwise).
--   public.staff_invite_consume(token_hash) returns (invite_id, user_id, role_code): marks an unused, uncancelled, unexpired
--     row consumed and returns it; otherwise no row. It does NOT open a window.
--   public.staff_invite_bind_window(invite_id, session_id): plan B step 2. For a consumed, unbound, live invite, stores the
--     session and opens the registration window for (user, session). A second call raises STAFF_INVITE_ALREADY_BOUND.
--   public.staff_role_activate(user, session) returns jsonb: plan B step 3. The row is found by (user, session) in the
--     database. One gate: the window is still open (STAFF_ACTIVATE_NO_WINDOW) and EVERY key of the user is an approved key
--     that was approved by a window at or after bound_at, at least min_approved_passkeys of them (fewer keys than that:
--     STAFF_ACTIVATE_KEYS_SHORT; any key that is not approved, or approved by reauth / script / before bound_at:
--     STAFF_ACTIVATE_KEYS_NOT_WINDOW). Then it turns the role on (assigned_by = issued_by), stamps activated_at and closes
--     the window. No row / activated / cancelled: STAFF_ACTIVATE_INVITE_INVALID.
--   public.staff_invite_cancel(actor, user): the actor must still be an active admin with admin.users.manage (checked after
--     the locks); cancels the open invite and closes the windows; keys and roles stay.
--   public.staff_invite_open(user) returns boolean: an uncancelled, unactivated, unexpired invite row exists.
--   public.* : execute for service_role only.
--
-- Second half (Task 2b):
--   private.admin_set_user_role(actor, user, role): the body of 20261023175712 with ONE change. For role admin | supporter, a
--     person who is not a current staff member (passkey_is_staff false) raises STAFF_INVITE_REQUIRED (42501). The precheck
--     below stops the migration unless the body being replaced still has md5(prosrc) 0cb9f532f16aa5c56c6b425694f7209b.
--   public.staff_demote(actor, user) returns void: 190519 then the per-user key, THEN the actor check (ROLE_PERMISSION_FORBIDDEN).
--     Last admin / self refused (LAST_ADMIN_REQUIRED, SELF_ROLE_CHANGE_FORBIDDEN, USER_NOT_FOUND). Role -> user, the approved
--     rows go, the keys stay, the open invite is cancelled and the windows are closed. service_role only.
--   private.staff_invite_issue_manual(email, role default 'admin', ttl default 3600) returns text: dashboard SQL only. Only
--     postgres can execute it. Returns the raw 43-character token; the table keeps its UTF-8 SHA-256. One audit row.
--   public.passkey_delete_with_floor(user, passkey) returns void: takes the per-user key; a current staff member whose approved
--     keys after the delete would be fewer than min_approved_passkeys gets STAFF_MIN_KEYS (P0001) ONLY when the key being
--     deleted is itself an approved key (an unapproved key can always be deleted). service_role only.
--
-- ROLLBACK (one transaction, only while nothing uses them):
--   DROP FUNCTION public.passkey_delete_with_floor(uuid, uuid), private.staff_invite_issue_manual(text, text, integer),
--     public.staff_demote(uuid, uuid);
--   -- then put private.admin_set_user_role back to the body of 20261023175712 (CREATE OR REPLACE with that file's text).
--   DROP FUNCTION public.staff_invite_open(uuid), public.staff_invite_cancel(uuid, uuid), public.staff_role_activate(uuid, uuid),
--     public.staff_invite_bind_window(uuid, uuid), public.staff_invite_consume(bytea),
--     public.staff_invite_issue(uuid, text, text, uuid, text, bytea, integer),
--     private.staff_invite_issue_core(uuid, text, text, uuid, text, bytea, integer, boolean);
--   DROP TABLE private.staff_invites;
--
-- BEFORE applying to production (read only): this migration is NOT applied to production until stage 3b.
--   select has_table_privilege('postgres','auth.mfa_factors','DELETE');          -- expect true
--   select has_table_privilege('postgres','auth.webauthn_credentials','DELETE'); -- expect true
--   select has_table_privilege('postgres','auth.users','UPDATE');                -- expect true
--   select has_table_privilege('postgres','auth.sessions','SELECT');             -- expect true
--   select to_regclass('private.staff_invites');                                 -- expect null
--   select md5(prosrc) from pg_proc where oid = 'private.admin_set_user_role(uuid,uuid,text)'::regprocedure;
--                                                                                -- expect 0cb9f532f16aa5c56c6b425694f7209b
--   select to_regnamespace('extensions') is not null;                            -- expect true (gen_random_bytes, digest)

BEGIN;

DO $$
BEGIN
  IF to_regclass('private.approved_passkeys') IS NULL
     OR to_regclass('private.passkey_registration_windows') IS NULL
     OR to_regclass('private.passkey_notification_outbox') IS NULL
     OR to_regclass('private.passkey_staff_config') IS NULL
     OR to_regclass('auth.mfa_factors') IS NULL
     OR to_regclass('auth.webauthn_credentials') IS NULL
     OR to_regclass('auth.sessions') IS NULL
     OR to_regclass('auth.users') IS NULL
     OR to_regclass('public.user_roles') IS NULL
     OR to_regclass('public.roles') IS NULL
     OR to_regprocedure('public.passkey_window_open(uuid,uuid)') IS NULL
     OR to_regprocedure('public.passkey_window_is_open(uuid,uuid)') IS NULL
     OR to_regprocedure('public.passkey_is_staff(uuid)') IS NULL
     OR to_regprocedure('private.admin_set_user_role(uuid,uuid,text)') IS NULL
     OR to_regclass('public.audit_logs') IS NULL
     OR to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL
     OR to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h_precheck';
  END IF;
  -- The body that the second half replaces must be the one from 20261023175712, so a drifted body is not overwritten blind.
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = 'private.admin_set_user_role(uuid,uuid,text)'::regprocedure)
       <> '0cb9f532f16aa5c56c6b425694f7209b' THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h_admin_set_user_role_body';
  END IF;
  IF NOT has_table_privilege('postgres', 'auth.mfa_factors', 'DELETE')
     OR NOT has_table_privilege('postgres', 'auth.webauthn_credentials', 'DELETE')
     OR NOT has_table_privilege('postgres', 'auth.users', 'UPDATE')
     OR NOT has_table_privilege('postgres', 'auth.sessions', 'SELECT') THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h_precheck';
  END IF;
END
$$;

CREATE TABLE private.staff_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  role_code text NOT NULL CHECK (role_code IN ('admin', 'supporter')),
  kind text NOT NULL CHECK (kind IN ('invite', 'redo', 'promote', 'last_resort')),
  token_hash bytea NOT NULL UNIQUE,
  issued_by uuid,
  reason text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  session_id uuid,
  bound_at timestamptz,
  activated_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_invites_one_open_per_user_idx
  ON private.staff_invites (user_id) WHERE cancelled_at IS NULL AND activated_at IS NULL;
CREATE INDEX staff_invites_user_session_idx ON private.staff_invites (user_id, session_id);

ALTER TABLE private.staff_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.staff_invites FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE private.staff_invites OWNER TO postgres;

CREATE OR REPLACE FUNCTION private.staff_invite_issue_core(
  p_user_id uuid, p_role_code text, p_kind text, p_issued_by uuid, p_reason text,
  p_token_hash bytea, p_ttl_seconds integer, p_allow_last_admin boolean
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_removed uuid[];
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_role_code IS NULL OR p_role_code NOT IN ('admin', 'supporter')
     OR p_kind IS NULL OR p_kind NOT IN ('invite', 'redo', 'promote', 'last_resort')
     OR p_token_hash IS NULL OR length(p_token_hash) <> 32
     OR p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_INVITE_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  -- Lock order: the global key first, the per-user key second (see the header). Never reverse it.
  PERFORM pg_advisory_xact_lock(190519, 0);
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0));
  -- The issuer is checked after the locks, so a manager demoted a moment ago is not let through. The last resort has
  -- no issuer (a database operator runs it).
  IF NOT COALESCE(p_allow_last_admin, false) AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = p_issued_by AND ur.active = true
       AND (ur.expires_at IS NULL OR ur.expires_at > now())
       AND r.code = 'admin' AND p.code = 'admin.users.manage'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FORBIDDEN', ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM auth.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0002';
  END IF;
  IF NOT COALESCE(p_allow_last_admin, false)
     AND EXISTS (
       SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
        WHERE ur.user_id = p_user_id AND r.code = 'admin' AND ur.active = true
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
        WHERE ur.user_id <> p_user_id AND r.code = 'admin' AND ur.active = true
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
     ) THEN
    RAISE EXCEPTION USING MESSAGE = 'LAST_ADMIN_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF p_issued_by IS NOT DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION USING MESSAGE = 'SELF_ROLE_CHANGE_FORBIDDEN', ERRCODE = '42501';
  END IF;

  UPDATE private.staff_invites i SET cancelled_at = now()
   WHERE i.user_id = p_user_id AND i.cancelled_at IS NULL AND i.activated_at IS NULL;
  UPDATE private.passkey_registration_windows w SET closed_at = now()
   WHERE w.user_id = p_user_id AND w.closed_at IS NULL;

  WITH removed AS (
    DELETE FROM auth.webauthn_credentials c WHERE c.user_id = p_user_id RETURNING c.id
  )
  SELECT COALESCE(array_agg(removed.id), '{}'::uuid[]) INTO v_removed FROM removed;
  DELETE FROM private.approved_passkeys a WHERE a.user_id = p_user_id;
  DELETE FROM auth.mfa_factors f WHERE f.user_id = p_user_id;

  UPDATE public.user_roles ur SET active = false WHERE ur.user_id = p_user_id;
  UPDATE auth.users u
     SET raw_app_meta_data = jsonb_set(COALESCE(u.raw_app_meta_data, '{}'::jsonb), '{role}', to_jsonb('user'::text)),
         updated_at = now()
   WHERE u.id = p_user_id;

  UPDATE private.passkey_notification_outbox o
     SET status = 'skipped', last_error_code = 'staff_invite_issue', finished_at = now()
   WHERE o.user_id = p_user_id AND o.kind = 'passkey_removed' AND o.passkey_id = ANY (v_removed)
     AND o.status = 'pending';

  INSERT INTO private.staff_invites (user_id, role_code, kind, token_hash, issued_by, reason, expires_at)
  VALUES (p_user_id, p_role_code, p_kind, p_token_hash, p_issued_by, p_reason, now() + make_interval(secs => p_ttl_seconds))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION public.staff_invite_issue(
  p_user_id uuid, p_role_code text, p_kind text, p_issued_by uuid, p_reason text,
  p_token_hash bytea, p_ttl_seconds integer DEFAULT 86400
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('invite', 'redo', 'promote') THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_INVITE_KIND_FORBIDDEN', ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_INVITE_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  -- Same lock order as the core (global, then user). The keys are re-entrant inside one transaction.
  PERFORM pg_advisory_xact_lock(190519, 0);
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0));
  IF p_kind <> 'redo' AND public.passkey_is_staff(p_user_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_ALREADY_STAFF', ERRCODE = 'P0001';
  END IF;
  RETURN private.staff_invite_issue_core(p_user_id, p_role_code, p_kind, p_issued_by, p_reason, p_token_hash, p_ttl_seconds, false);
END
$$;

CREATE OR REPLACE FUNCTION public.staff_invite_consume(p_token_hash bytea)
RETURNS TABLE (invite_id uuid, user_id uuid, role_code text)
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE private.staff_invites i SET consumed_at = now()
   WHERE i.token_hash = p_token_hash AND i.consumed_at IS NULL AND i.cancelled_at IS NULL
     AND i.activated_at IS NULL AND i.expires_at > now()
  RETURNING i.id, i.user_id, i.role_code;
$$;

CREATE OR REPLACE FUNCTION public.staff_invite_bind_window(p_invite_id uuid, p_session_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_row private.staff_invites%ROWTYPE;
BEGIN
  SELECT i.user_id INTO v_user FROM private.staff_invites i WHERE i.id = p_invite_id;
  IF v_user IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_INVITE_INVALID', ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(190519, 0);
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey_approve:' || v_user::text, 0));
  SELECT * INTO v_row FROM private.staff_invites i WHERE i.id = p_invite_id FOR UPDATE;
  IF NOT FOUND OR v_row.consumed_at IS NULL OR v_row.cancelled_at IS NOT NULL OR v_row.activated_at IS NOT NULL
     OR v_row.expires_at <= now() THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_INVITE_INVALID', ERRCODE = 'P0001';
  END IF;
  IF v_row.session_id IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_INVITE_ALREADY_BOUND', ERRCODE = 'P0001';
  END IF;
  UPDATE private.staff_invites i SET session_id = p_session_id, bound_at = now() WHERE i.id = p_invite_id;
  PERFORM public.passkey_window_open(v_row.user_id, p_session_id);
END
$$;

CREATE OR REPLACE FUNCTION public.staff_role_activate(p_user_id uuid, p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row private.staff_invites%ROWTYPE;
  v_min integer;
  v_all integer;
  v_good integer;
  v_role_id bigint;
BEGIN
  IF p_user_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_ACTIVATE_INVITE_INVALID', ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(190519, 0);
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0));
  SELECT * INTO v_row FROM private.staff_invites i
   WHERE i.user_id = p_user_id AND i.session_id = p_session_id
   ORDER BY i.bound_at DESC, i.created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR v_row.cancelled_at IS NOT NULL OR v_row.activated_at IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_ACTIVATE_INVITE_INVALID', ERRCODE = 'P0001';
  END IF;
  IF NOT public.passkey_window_is_open(p_user_id, p_session_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_ACTIVATE_NO_WINDOW', ERRCODE = 'P0001';
  END IF;
  SELECT c.min_approved_passkeys INTO v_min FROM private.passkey_staff_config c WHERE c.id;
  SELECT count(*)::integer INTO v_all FROM auth.webauthn_credentials k WHERE k.user_id = p_user_id;
  SELECT count(*)::integer INTO v_good
    FROM auth.webauthn_credentials k
    JOIN private.approved_passkeys ap
      ON ap.passkey_id = k.id AND ap.user_id = k.user_id AND ap.credential_id = k.credential_id
   WHERE k.user_id = p_user_id AND ap.approved_via = 'window' AND ap.approved_at >= v_row.bound_at;
  IF v_min IS NULL OR v_all < v_min THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_ACTIVATE_KEYS_SHORT', ERRCODE = 'P0001';
  END IF;
  IF v_good <> v_all THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_ACTIVATE_KEYS_NOT_WINDOW', ERRCODE = 'P0001';
  END IF;

  SELECT r.id INTO v_role_id FROM public.roles r WHERE r.code = v_row.role_code;
  UPDATE public.user_roles ur SET active = false WHERE ur.user_id = p_user_id;
  INSERT INTO public.user_roles (user_id, role_id, active, expires_at, assigned_by, assigned_at)
  VALUES (p_user_id, v_role_id, true, NULL, v_row.issued_by, now())
  ON CONFLICT (user_id, role_id) DO UPDATE
    SET active = true, expires_at = NULL, assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at;
  UPDATE auth.users u
     SET raw_app_meta_data = jsonb_set(COALESCE(u.raw_app_meta_data, '{}'::jsonb), '{role}', to_jsonb(v_row.role_code)),
         updated_at = now()
   WHERE u.id = p_user_id;
  UPDATE private.staff_invites i SET activated_at = now() WHERE i.id = v_row.id;
  UPDATE private.passkey_registration_windows w SET closed_at = now()
   WHERE w.user_id = p_user_id AND w.closed_at IS NULL;
  RETURN jsonb_build_object('role', v_row.role_code);
END
$$;

CREATE OR REPLACE FUNCTION public.staff_invite_cancel(p_actor_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_INVITE_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(190519, 0);
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = p_actor_id AND ur.active = true
       AND (ur.expires_at IS NULL OR ur.expires_at > now())
       AND r.code = 'admin' AND p.code = 'admin.users.manage'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FORBIDDEN', ERRCODE = '42501';
  END IF;
  UPDATE private.staff_invites i SET cancelled_at = now()
   WHERE i.user_id = p_user_id AND i.cancelled_at IS NULL AND i.activated_at IS NULL;
  IF FOUND THEN
    UPDATE private.passkey_registration_windows w SET closed_at = now()
     WHERE w.user_id = p_user_id AND w.closed_at IS NULL;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.staff_invite_open(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM private.staff_invites i
     WHERE i.user_id = p_user_id AND i.cancelled_at IS NULL AND i.activated_at IS NULL AND i.expires_at > now()
  );
$$;

ALTER FUNCTION private.staff_invite_issue_core(uuid, text, text, uuid, text, bytea, integer, boolean) OWNER TO postgres;
ALTER FUNCTION public.staff_invite_issue(uuid, text, text, uuid, text, bytea, integer) OWNER TO postgres;
ALTER FUNCTION public.staff_invite_consume(bytea) OWNER TO postgres;
ALTER FUNCTION public.staff_invite_bind_window(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.staff_role_activate(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.staff_invite_cancel(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION public.staff_invite_open(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.staff_invite_issue_core(uuid, text, text, uuid, text, bytea, integer, boolean),
  public.staff_invite_issue(uuid, text, text, uuid, text, bytea, integer),
  public.staff_invite_consume(bytea), public.staff_invite_bind_window(uuid, uuid),
  public.staff_role_activate(uuid, uuid), public.staff_invite_cancel(uuid, uuid),
  public.staff_invite_open(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_invite_issue(uuid, text, text, uuid, text, bytea, integer),
  public.staff_invite_consume(bytea), public.staff_invite_bind_window(uuid, uuid),
  public.staff_role_activate(uuid, uuid), public.staff_invite_cancel(uuid, uuid),
  public.staff_invite_open(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- Second half (Task 2b): admin_set_user_role rebuilt, staff_demote, the dashboard-only last resort, the delete floor.
-- ---------------------------------------------------------------------------------------------------------------------

-- Same body as 20261023175712 (private.admin_set_user_role). The ONLY change: when the new role is admin or supporter and the
-- person is not a current staff member (active, unexpired admin / supporter row), raise STAFF_INVITE_REQUIRED (42501). A
-- customer, or someone whose staff row is inactive or expired, now has to go through an invite. Moves between staff roles and
-- the move to 'user' behave as before. The signature, the owner and the ACL are unchanged (CREATE OR REPLACE keeps them).
CREATE OR REPLACE FUNCTION private.admin_set_user_role(_actor_id uuid, _user_id uuid, _role_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  metadata jsonb;
  previous_role text;
  target_role_id bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190519, 0);
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
    JOIN public.role_permissions rp ON rp.role_id = r.id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = _actor_id AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND r.code = 'admin' AND p.code = 'admin.users.manage'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FORBIDDEN', ERRCODE = '42501';
  END IF;
  IF _user_id IS NULL OR _role_code IS NULL OR _role_code NOT IN ('admin', 'supporter', 'user') THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  SELECT r.id INTO target_role_id FROM public.roles r WHERE r.code = _role_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  SELECT u.raw_app_meta_data INTO metadata FROM auth.users u WHERE u.id = _user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0002';
  END IF;
  -- Match the existing PATCH audit contract; metadata is never used for authorization.
  previous_role := CASE WHEN pg_catalog.jsonb_typeof(metadata -> 'role') = 'string'
    THEN metadata ->> 'role' ELSE 'unknown' END;
  IF _role_code <> 'admin' AND NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
    WHERE r.code = 'admin' AND ur.user_id <> _user_id AND ur.active = true
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'LAST_ADMIN_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF _actor_id = _user_id THEN
    RAISE EXCEPTION USING MESSAGE = 'SELF_ROLE_CHANGE_FORBIDDEN', ERRCODE = '42501';
  END IF;
  IF _role_code IN ('admin', 'supporter') AND NOT public.passkey_is_staff(_user_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_INVITE_REQUIRED', ERRCODE = '42501';
  END IF;
  UPDATE public.user_roles SET active = false WHERE user_id = _user_id;
  INSERT INTO public.user_roles (user_id, role_id, active, expires_at, assigned_by, assigned_at)
    VALUES (_user_id, target_role_id, true, NULL, _actor_id, now())
    ON CONFLICT (user_id, role_id) DO UPDATE SET active = true, expires_at = NULL,
      assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at;
  UPDATE auth.users SET raw_app_meta_data = pg_catalog.jsonb_set(
    COALESCE(metadata, '{}'::jsonb), '{role}', pg_catalog.to_jsonb(_role_code)), updated_at = now()
    WHERE id = _user_id;
  RETURN pg_catalog.jsonb_build_object('previousRole', previous_role, 'role', _role_code);
END;
$$;

-- Demote to a customer. Lock order as everywhere in this file: 190519, then the per-user key. The actor is checked AFTER
-- the locks. Keys stay (they become the customer's passkeys); the approvals go; an open invite is cancelled, windows closed.
CREATE OR REPLACE FUNCTION public.staff_demote(p_actor_id uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user_role_id bigint;
BEGIN
  IF p_actor_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_ARGUMENT_INVALID', ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(190519, 0);
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = p_actor_id AND ur.active = true
       AND (ur.expires_at IS NULL OR ur.expires_at > now())
       AND r.code = 'admin' AND p.code = 'admin.users.manage'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'ROLE_PERMISSION_FORBIDDEN', ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM auth.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'USER_NOT_FOUND', ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
     WHERE r.code = 'admin' AND ur.user_id <> p_user_id AND ur.active = true
       AND (ur.expires_at IS NULL OR ur.expires_at > now())
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'LAST_ADMIN_REQUIRED', ERRCODE = 'P0001';
  END IF;
  IF p_actor_id = p_user_id THEN
    RAISE EXCEPTION USING MESSAGE = 'SELF_ROLE_CHANGE_FORBIDDEN', ERRCODE = '42501';
  END IF;

  SELECT r.id INTO v_user_role_id FROM public.roles r WHERE r.code = 'user';
  UPDATE public.user_roles ur SET active = false WHERE ur.user_id = p_user_id;
  INSERT INTO public.user_roles (user_id, role_id, active, expires_at, assigned_by, assigned_at)
    VALUES (p_user_id, v_user_role_id, true, NULL, p_actor_id, now())
    ON CONFLICT (user_id, role_id) DO UPDATE SET active = true, expires_at = NULL,
      assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at;
  UPDATE auth.users u
     SET raw_app_meta_data = jsonb_set(COALESCE(u.raw_app_meta_data, '{}'::jsonb), '{role}', to_jsonb('user'::text)),
         updated_at = now()
   WHERE u.id = p_user_id;
  DELETE FROM private.approved_passkeys a WHERE a.user_id = p_user_id;
  UPDATE private.staff_invites i SET cancelled_at = now()
   WHERE i.user_id = p_user_id AND i.cancelled_at IS NULL AND i.activated_at IS NULL;
  UPDATE private.passkey_registration_windows w SET closed_at = now()
   WHERE w.user_id = p_user_id AND w.closed_at IS NULL;
END
$$;

-- The last resort, for the dashboard SQL editor only. Only postgres can execute it (no PostgREST door, no service_role).
-- Returns the RAW token (43 base64url characters, no padding). The table keeps only the SHA-256 of its UTF-8 string. The
-- ttl defaults to one hour because the token appears on the dashboard result screen. One audit row, target id only.
CREATE OR REPLACE FUNCTION private.staff_invite_issue_manual(
  p_email text, p_role_code text DEFAULT 'admin', p_ttl_seconds integer DEFAULT 3600
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid;
  v_token text;
BEGIN
  SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = lower(p_email) LIMIT 1;
  IF v_user IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'STAFF_MANUAL_USER_NOT_FOUND', ERRCODE = 'P0002';
  END IF;
  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  PERFORM private.staff_invite_issue_core(
    v_user, p_role_code, 'last_resort', NULL, NULL,
    extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), p_ttl_seconds, true);
  INSERT INTO public.audit_logs (action, actor_id, resource, resource_id, outcome, detail)
  VALUES ('staff.last_resort.issue', NULL, 'user', v_user::text, 'success', v_user::text);
  RETURN v_token;
END
$$;

-- Delete a passkey while keeping the staff floor inside the database. Takes the per-user key (the one passkey_approve
-- takes), so the count and the delete are one step: three keys, two deletes at once, one is refused.
CREATE OR REPLACE FUNCTION public.passkey_delete_with_floor(p_user_id uuid, p_passkey_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_min integer;
  v_approved integer;
  v_this_approved boolean;
BEGIN
  IF p_user_id IS NULL OR p_passkey_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'PASSKEY_NOT_FOUND', ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('passkey_approve:' || p_user_id::text, 0));
  PERFORM 1 FROM auth.webauthn_credentials c WHERE c.id = p_passkey_id AND c.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'PASSKEY_NOT_FOUND', ERRCODE = 'P0002';
  END IF;
  IF public.passkey_is_staff(p_user_id) THEN
    SELECT c.min_approved_passkeys INTO v_min FROM private.passkey_staff_config c WHERE c.id;
    SELECT count(*)::integer, COALESCE(bool_or(k.id = p_passkey_id), false) INTO v_approved, v_this_approved
      FROM private.approved_passkeys ap
      JOIN auth.webauthn_credentials k
        ON k.id = ap.passkey_id AND k.user_id = ap.user_id AND k.credential_id = ap.credential_id
     WHERE ap.user_id = p_user_id;
    IF v_this_approved AND (v_min IS NULL OR v_approved - 1 < v_min) THEN
      RAISE EXCEPTION USING MESSAGE = 'STAFF_MIN_KEYS', ERRCODE = 'P0001';
    END IF;
  END IF;
  DELETE FROM auth.webauthn_credentials c WHERE c.id = p_passkey_id AND c.user_id = p_user_id;
  DELETE FROM private.approved_passkeys a WHERE a.user_id = p_user_id AND a.passkey_id = p_passkey_id;
END
$$;

ALTER FUNCTION public.staff_demote(uuid, uuid) OWNER TO postgres;
ALTER FUNCTION private.staff_invite_issue_manual(text, text, integer) OWNER TO postgres;
ALTER FUNCTION public.passkey_delete_with_floor(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.staff_demote(uuid, uuid), private.staff_invite_issue_manual(text, text, integer),
  public.passkey_delete_with_floor(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_demote(uuid, uuid), public.passkey_delete_with_floor(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION private.staff_invite_issue_manual(text, text, integer) TO postgres;

-- PASSKEY_H_FINAL_ASSERT
DO $$
DECLARE
  f text;
BEGIN
  IF has_table_privilege('anon', 'private.staff_invites', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'private.staff_invites', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role', 'private.staff_invites', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT (SELECT relrowsecurity AND relowner = 'postgres'::regrole FROM pg_class WHERE oid = 'private.staff_invites'::regclass) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h_table_acl';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.staff_invite_issue(uuid,text,text,uuid,text,bytea,integer)', 'public.staff_invite_consume(bytea)',
    'public.staff_invite_bind_window(uuid,uuid)', 'public.staff_role_activate(uuid,uuid)',
    'public.staff_invite_cancel(uuid,uuid)', 'public.staff_invite_open(uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h_function_acl';
    END IF;
  END LOOP;
  f := 'private.staff_invite_issue_core(uuid,text,text,uuid,text,bytea,integer,boolean)';
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('service_role', f, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h_function_acl';
  END IF;
  -- Second half: staff_demote and passkey_delete_with_floor are service_role only; the manual door is postgres only.
  FOREACH f IN ARRAY ARRAY['public.staff_demote(uuid,uuid)', 'public.passkey_delete_with_floor(uuid,uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h2_function_acl';
    END IF;
  END LOOP;
  f := 'private.staff_invite_issue_manual(text,text,integer)';
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('service_role', f, 'EXECUTE') OR NOT has_function_privilege('postgres', f, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h2_manual_acl';
  END IF;
  -- admin_set_user_role keeps its ACL: service_role only, never anon / authenticated / PUBLIC.
  FOREACH f IN ARRAY ARRAY['private.admin_set_user_role(uuid,uuid,text)', 'public.admin_set_user_role(uuid,uuid,text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = f::regprocedure AND a.grantee = 0) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h2_set_role_acl';
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['private.staff_invite_issue_core(uuid,text,text,uuid,text,bytea,integer,boolean)',
    'public.staff_invite_issue(uuid,text,text,uuid,text,bytea,integer)', 'public.staff_invite_consume(bytea)',
    'public.staff_invite_bind_window(uuid,uuid)', 'public.staff_role_activate(uuid,uuid)',
    'public.staff_invite_cancel(uuid,uuid)', 'public.staff_invite_open(uuid)',
    'public.staff_demote(uuid,uuid)', 'private.staff_invite_issue_manual(text,text,integer)',
    'public.passkey_delete_with_floor(uuid,uuid)', 'private.admin_set_user_role(uuid,uuid,text)'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = f::regprocedure AND p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig @> ARRAY['search_path=""']
    ) THEN
      RAISE EXCEPTION 'PASSKEY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_h_function_attrs';
    END IF;
  END LOOP;
END
$$;
-- PASSKEY_H_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
