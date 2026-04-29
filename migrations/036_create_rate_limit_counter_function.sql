-- migrations/036_create_rate_limit_counter_function.sql
-- Create an atomic increment function for the rate_limit_counters table.

DROP FUNCTION IF EXISTS public.increment_rate_limit_counter(inet, text, timestamptz);

CREATE FUNCTION public.increment_rate_limit_counter(
  _ip inet,
  _endpoint text,
  _bucket timestamptz
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  new_count integer;
BEGIN
  INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count, created_at, last_seen_at)
  VALUES (_ip, _endpoint, _bucket, 1, now(), now())
  ON CONFLICT (ip, endpoint, bucket)
  DO UPDATE SET count = public.rate_limit_counters.count + 1, last_seen_at = now()
  RETURNING count INTO new_count;

  RETURN new_count;
END;
$$;
