-- 001_create_password_reset_tokens.sql
-- Create table for storing password reset tokens (hashed)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid,
  email text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash ON password_reset_tokens (token_hash);
