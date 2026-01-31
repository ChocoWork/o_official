-- 002_create_audit_logs.sql
-- Create table for structured audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  action text NOT NULL,
  actor_id uuid,
  actor_email text,
  resource text,
  resource_id text,
  outcome text,
  detail jsonb,
  ip text,
  user_agent text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);
