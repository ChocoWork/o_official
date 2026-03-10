BEGIN;

CREATE TABLE IF NOT EXISTS public.postal_code_cache (
  postal_code char(7) PRIMARY KEY,
  prefecture text NOT NULL,
  city text NOT NULL,
  address text NOT NULL,
  source text NOT NULL DEFAULT 'zipcloud',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_postal_code_cache_updated_at
  ON public.postal_code_cache (updated_at DESC);

ALTER TABLE public.postal_code_cache ENABLE ROW LEVEL SECURITY;

-- サーバー側 service role からのアクセス前提
GRANT SELECT, INSERT, UPDATE ON public.postal_code_cache TO service_role;

COMMIT;
