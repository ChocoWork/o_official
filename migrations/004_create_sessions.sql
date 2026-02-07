-- migrations/004_create_sessions.sql
-- Create sessions table for refresh token management and session tracking

-- Ensure pgcrypto for gen_random_uuid
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,
  current_jti text,
  ip inet,
  user_agent text,
  device_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON public.sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen_at ON public.sessions(last_seen_at);

-- Note: refresh_token_hash should be stored as a secure hash; application code must hash refresh tokens before insert.
