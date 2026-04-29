-- Migration: create audit_logs table
-- WARNING: review before applying in production

-- Ensure uuid generation function available (pgcrypto)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  actor_id uuid NULL,
  actor_email text NULL,
  resource text NULL,
  resource_id text NULL,
  outcome text NOT NULL,
  detail text NULL,
  ip text NULL,
  user_agent text NULL,
  metadata jsonb NULL,
  entry_hash text NULL
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON public.audit_logs (created_at);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON public.audit_logs (action);

ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS entry_hash text;
CREATE INDEX IF NOT EXISTS audit_logs_entry_hash_idx ON public.audit_logs (entry_hash);

CREATE OR REPLACE FUNCTION public.audit_logs_compute_entry_hash()
RETURNS trigger AS $$
BEGIN
  NEW.entry_hash := encode(
    digest(
      COALESCE(NEW.created_at::text, '') || '|' ||
      COALESCE(NEW.action, '') || '|' ||
      COALESCE(NEW.actor_id::text, '') || '|' ||
      COALESCE(NEW.actor_email, '') || '|' ||
      COALESCE(NEW.resource, '') || '|' ||
      COALESCE(NEW.resource_id, '') || '|' ||
      COALESCE(NEW.outcome, '') || '|' ||
      COALESCE(NEW.detail, '') || '|' ||
      COALESCE(NEW.ip, '') || '|' ||
      COALESCE(NEW.user_agent, '') || '|' ||
      COALESCE(NEW.metadata::text, ''),
      'sha256'
    ),
    'hex'
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_audit_logs_entry_hash ON public.audit_logs;
CREATE TRIGGER trigger_audit_logs_entry_hash
  BEFORE INSERT OR UPDATE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_compute_entry_hash();

UPDATE public.audit_logs
SET entry_hash = encode(
  digest(
    COALESCE(created_at::text, '') || '|' ||
    COALESCE(action, '') || '|' ||
    COALESCE(actor_id::text, '') || '|' ||
    COALESCE(actor_email, '') || '|' ||
    COALESCE(resource, '') || '|' ||
    COALESCE(resource_id, '') || '|' ||
    COALESCE(outcome, '') || '|' ||
    COALESCE(detail, '') || '|' ||
    COALESCE(ip, '') || '|' ||
    COALESCE(user_agent, '') || '|' ||
    COALESCE(metadata::text, ''),
    'sha256'
  ),
  'hex'
)
WHERE entry_hash IS NULL OR entry_hash = '';

ALTER TABLE public.audit_logs ALTER COLUMN entry_hash SET NOT NULL;
COMMENT ON COLUMN public.audit_logs.entry_hash IS 'SHA256 hash of audit log row content for tamper detection';

-- Enable RLS for audit logs so only service-role access is allowed.
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

-- By default, SELECT/INSERT are denied unless one of the explicit policies above matches.

COMMENT ON TABLE public.audit_logs IS 'Audit logs for authentication and admin actions';
