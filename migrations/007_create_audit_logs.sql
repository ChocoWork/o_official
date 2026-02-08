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
  metadata jsonb NULL
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON public.audit_logs (created_at);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON public.audit_logs (action);

COMMENT ON TABLE public.audit_logs IS 'Audit logs for authentication and admin actions';
