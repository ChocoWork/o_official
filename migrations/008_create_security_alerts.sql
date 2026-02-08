-- 008_create_security_alerts.sql
-- Create schema/tables for security alerting and a helper RPC

CREATE SCHEMA IF NOT EXISTS security;

-- events table: raw event rows written by Edge Function (and optionally triggers)
CREATE TABLE IF NOT EXISTS security.alert_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  action text NOT NULL,
  detail text,
  ip_address text,
  actor_id uuid,
  actor_email text,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

-- alerts table: recorded alerts to avoid duplicate notifications (cooldown)
CREATE TABLE IF NOT EXISTS security.security_alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  key text NOT NULL,            -- e.g. ip|actor_id|action
  action text NOT NULL,
  detail text,
  count int NOT NULL,
  window_minutes int NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_by_ip ON security.alert_events (ip_address);
CREATE INDEX IF NOT EXISTS idx_alert_events_by_actor ON security.alert_events (actor_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_created_at ON security.alert_events (created_at);

-- RPC: count recent matching events for a given action/detail in the time window
CREATE OR REPLACE FUNCTION security.count_recent_events(
  action_text text,
  detail_text text,
  ip_text text DEFAULT NULL,
  actor_text text DEFAULT NULL,
  window_minutes int DEFAULT 5
)
RETURNS TABLE(count bigint)
LANGUAGE sql STABLE
AS $$
  SELECT count(*)::bigint FROM security.alert_events e
  WHERE e.action = action_text
    AND (detail_text IS NULL OR e.detail = detail_text)
    AND e.created_at >= now() - (window_minutes || ' minutes')::interval
    AND (
      (ip_text IS NULL OR (e.ip_address IS NOT NULL AND e.ip_address = ip_text))
      OR (actor_text IS NULL OR (e.actor_id IS NOT NULL AND e.actor_id::text = actor_text))
    );
$$;

-- Optional: grant privileges for functions/tables to the service role if you manage roles
-- GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA security TO postgres;

-- End of migration
