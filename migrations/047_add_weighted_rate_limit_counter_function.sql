-- migrations/047_add_weighted_rate_limit_counter_function.sql
-- Add an overloaded atomic increment function so endpoints can consume
-- arbitrary quota units (for example upload bytes) in the shared
-- rate_limit_counters table without race conditions.

DROP FUNCTION IF EXISTS public.increment_rate_limit_counter(inet, text, timestamptz, integer);

CREATE FUNCTION public.increment_rate_limit_counter(
  _ip inet,
  _endpoint text,
  _bucket timestamptz,
  _increment integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_count integer;
  normalized_increment integer;
BEGIN
  normalized_increment := GREATEST(COALESCE(_increment, 1), 1);

  INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count, created_at, last_seen_at)
  VALUES (_ip, _endpoint, _bucket, normalized_increment, now(), now())
  ON CONFLICT (ip, endpoint, bucket)
  DO UPDATE SET
    count = public.rate_limit_counters.count + normalized_increment,
    last_seen_at = now()
  RETURNING count INTO next_count;

  RETURN next_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz, integer) FROM PUBLIC;