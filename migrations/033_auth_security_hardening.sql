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

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS previous_refresh_token_hash text,
  ADD COLUMN IF NOT EXISTS csrf_token_hash text,
  ADD COLUMN IF NOT EXISTS csrf_prev_token_hash text,
  ADD COLUMN IF NOT EXISTS quarantined boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_refresh_token_hash
  ON public.sessions(refresh_token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_previous_refresh_token_hash
  ON public.sessions(previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.increment_rate_limit_counter(
  p_ip inet,
  p_endpoint text,
  p_bucket timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_count integer;
BEGIN
  INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count, created_at, last_seen_at)
  VALUES (p_ip, p_endpoint, p_bucket, 1, now(), now())
  ON CONFLICT (ip, endpoint, bucket)
  DO UPDATE SET
    count = public.rate_limit_counters.count + 1,
    last_seen_at = now()
  RETURNING count INTO next_count;

  RETURN next_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz) FROM PUBLIC;

ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;