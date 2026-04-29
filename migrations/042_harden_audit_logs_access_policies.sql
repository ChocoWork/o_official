-- 042_harden_audit_logs_access_policies.sql
-- Tighten audit_logs access with explicit least-privilege RLS policies.

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_logs_admin_read" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_service_role_insert" ON public.audit_logs;
DROP POLICY IF EXISTS "Deny direct select on audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Deny direct insert on audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Deny direct update on audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Deny direct delete on audit_logs" ON public.audit_logs;

CREATE POLICY "audit_logs_admin_read"
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (public.has_permission('admin.audit.read'));

CREATE POLICY "audit_logs_service_role_insert"
  ON public.audit_logs
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Deny direct update on audit_logs"
  ON public.audit_logs
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

CREATE POLICY "Deny direct delete on audit_logs"
  ON public.audit_logs
  FOR DELETE
  USING (false);
