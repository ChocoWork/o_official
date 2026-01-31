-- 003_create_sessions.sql
-- Optional sessions table for server-side session tracking (refresh tokens hashed)
CREATE TABLE IF NOT EXISTS sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  refresh_token_hash text NOT NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  user_agent text,
  ip inet
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions (refresh_token_hash);
