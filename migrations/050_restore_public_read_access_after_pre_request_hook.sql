BEGIN;

GRANT USAGE ON SCHEMA private TO authenticator, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION private.set_request_context() TO authenticator, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.increment_rate_limit_counter(
  _ip inet,
  _endpoint text,
  _bucket timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_count integer;
BEGIN
  INSERT INTO public.rate_limit_counters (ip, endpoint, bucket, count, created_at, last_seen_at)
  VALUES (_ip, _endpoint, _bucket, 1, now(), now())
  ON CONFLICT (ip, endpoint, bucket)
  DO UPDATE SET
    count = public.rate_limit_counters.count + 1,
    last_seen_at = now()
  RETURNING count INTO next_count;

  RETURN next_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_rate_limit_counter(inet, text, timestamptz, integer) TO service_role;

COMMIT;