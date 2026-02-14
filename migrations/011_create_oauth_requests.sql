-- migrations/011_create_oauth_requests.sql
-- OAuth (Google) state/PKCE request tracking (short-lived)

BEGIN;

-- gen_random_uuid() needs pgcrypto on many Supabase projects
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS oauth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  state text NOT NULL UNIQUE,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL,
  -- NOTE: required to exchange the auth code in server-side PKCE flow.
  -- This is short-lived (expires_at) and one-time (used_at).
  code_verifier text NOT NULL,
  redirect_to text NULL,
  client_ip inet NULL,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_requests_expires_at ON oauth_requests (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_requests_used_at ON oauth_requests (used_at);

COMMIT;
