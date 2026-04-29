-- migrations/045_harden_auth_internal_tables_rls.sql
-- Enforce explicit service_role-only access and deny-by-default policies
-- for internal auth/security tables.

BEGIN;

-- Ensure RLS is enabled on all target tables.
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.oauth_requests ENABLE ROW LEVEL SECURITY;

-- sessions: clear existing direct-deny policies and enforce explicit service_role-only policy.
DROP POLICY IF EXISTS "Deny direct select on sessions" ON public.sessions;
DROP POLICY IF EXISTS "Deny direct insert on sessions" ON public.sessions;
DROP POLICY IF EXISTS "Deny direct update on sessions" ON public.sessions;
DROP POLICY IF EXISTS "Deny direct delete on sessions" ON public.sessions;
DROP POLICY IF EXISTS "sessions_service_role_all" ON public.sessions;

CREATE POLICY "sessions_service_role_all"
  ON public.sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "sessions_deny_authenticated_all"
  ON public.sessions
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "sessions_deny_anon_all"
  ON public.sessions
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

-- rate_limit_counters: explicit service_role-only with deny-by-default policies.
DROP POLICY IF EXISTS "rate_limit_counters_service_role_all" ON public.rate_limit_counters;
DROP POLICY IF EXISTS "rate_limit_counters_deny_authenticated_all" ON public.rate_limit_counters;
DROP POLICY IF EXISTS "rate_limit_counters_deny_anon_all" ON public.rate_limit_counters;

CREATE POLICY "rate_limit_counters_service_role_all"
  ON public.rate_limit_counters
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "rate_limit_counters_deny_authenticated_all"
  ON public.rate_limit_counters
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "rate_limit_counters_deny_anon_all"
  ON public.rate_limit_counters
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

-- audit_logs: remove broader read policy and enforce service_role-only.
DROP POLICY IF EXISTS "audit_logs_admin_read" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_service_role_insert" ON public.audit_logs;
DROP POLICY IF EXISTS "Deny direct select on audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Deny direct insert on audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Deny direct update on audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Deny direct delete on audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_service_role_all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_deny_authenticated_all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_deny_anon_all" ON public.audit_logs;

CREATE POLICY "audit_logs_service_role_all"
  ON public.audit_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "audit_logs_deny_authenticated_all"
  ON public.audit_logs
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "audit_logs_deny_anon_all"
  ON public.audit_logs
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

-- oauth_requests: explicit service_role-only with deny-by-default policies.
DO $$
BEGIN
  IF to_regclass('public.oauth_requests') IS NOT NULL THEN
    DROP POLICY IF EXISTS "oauth_requests_service_role_all" ON public.oauth_requests;
    DROP POLICY IF EXISTS "oauth_requests_deny_authenticated_all" ON public.oauth_requests;
    DROP POLICY IF EXISTS "oauth_requests_deny_anon_all" ON public.oauth_requests;

    CREATE POLICY "oauth_requests_service_role_all"
      ON public.oauth_requests
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);

    CREATE POLICY "oauth_requests_deny_authenticated_all"
      ON public.oauth_requests
      FOR ALL
      TO authenticated
      USING (false)
      WITH CHECK (false);

    CREATE POLICY "oauth_requests_deny_anon_all"
      ON public.oauth_requests
      FOR ALL
      TO anon
      USING (false)
      WITH CHECK (false);
  END IF;
END
$$;

COMMIT;
