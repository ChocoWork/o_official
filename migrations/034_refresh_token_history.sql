CREATE TABLE IF NOT EXISTS public.refresh_token_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_token_history_user_id
  ON public.refresh_token_history(user_id, recorded_at DESC);

ALTER TABLE public.refresh_token_history ENABLE ROW LEVEL SECURITY;