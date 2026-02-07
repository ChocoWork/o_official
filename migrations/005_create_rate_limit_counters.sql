-- migrations/005_create_rate_limit_counters.sql
-- Create rate_limit_counters table to support IP/endpoint/bucket counting for rate-limiting

CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  id bigserial PRIMARY KEY,
  ip inet,
  endpoint text NOT NULL,
  bucket timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_limit_counters_unique UNIQUE(ip, endpoint, bucket)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_ip_endpoint_bucket ON public.rate_limit_counters (ip, endpoint, bucket);
CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket ON public.rate_limit_counters (bucket);

-- Upsert example (to be used by application):
-- INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count)
-- VALUES ($1, $2, $3, 1)
-- ON CONFLICT (ip, endpoint, bucket) DO UPDATE SET count = rate_limit_counters.count + 1, last_seen_at = now();
