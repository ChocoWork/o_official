-- migrations/046_create_password_reset_tokens_and_policies.sql
-- Backfill password_reset_tokens table and strict RLS policies for environments
-- where older auth security migrations were not applied.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash
  ON public.password_reset_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email_expires_at
  ON public.password_reset_tokens(email, expires_at DESC);

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "password_reset_tokens_service_role_all" ON public.password_reset_tokens;
DROP POLICY IF EXISTS "password_reset_tokens_deny_authenticated_all" ON public.password_reset_tokens;
DROP POLICY IF EXISTS "password_reset_tokens_deny_anon_all" ON public.password_reset_tokens;

CREATE POLICY "password_reset_tokens_service_role_all"
  ON public.password_reset_tokens
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "password_reset_tokens_deny_authenticated_all"
  ON public.password_reset_tokens
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "password_reset_tokens_deny_anon_all"
  ON public.password_reset_tokens
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);

COMMIT;
