-- Wave 2 / Task 6: search functions get a hard row cap of 8, a 100-character search term and a
-- backslash-first LIKE escape; the unused search_public_* functions lose their Data API access
-- (R5-1 / R5-2: SEC-SEARCH-003 / 007 / 008, SEC-LOOK-010, SEC-NEWS-010; ADR-0315).
--
-- Why:
--   * search_items / search_looks / search_news are called by anon and authenticated through PostgREST with
--     limit_count straight from the caller. 21 gave 21 rows, 10000 gave every published row and NULL meant
--     "no limit". The application never asks for more than 8 (/api/search limitPerType 8, suggestions 8,
--     preview 3), so the cap is 8 and NULL / 0 / negative values are clamped to 1..8 instead of failing.
--   * The search term is cut to its first 100 characters, so one request cannot make three ILIKE scans over
--     a megabyte pattern.
--   * The old escape replaced % and _ but not the backslash itself. A term ending in a backslash turned the
--     closing '%' of the pattern into a literal, and a term like \% became "backslash, any string". The
--     backslash is now doubled first, then % and _ are escaped, and the pattern is built once in a LATERAL
--     subquery instead of three times.
--   * search_public_items / search_public_looks / search_public_news are called by nothing in src. They do not
--     escape their term at all, and their ACL still has PUBLIC. They are NOT dropped (the NEWS E2E expects
--     42501 and nothing else); EXECUTE is revoked from PUBLIC, anon and authenticated. postgres (owner) and
--     service_role keep EXECUTE. Dropping them is a separate decision after the NEWS test is changed.
--   * Signatures, return columns, SET search_path TO 'public', 'public', 'pg_temp' and SECURITY INVOKER are
--     unchanged; CREATE OR REPLACE keeps the owner and the ACL of the existing functions.
--
-- Idempotent: CREATE OR REPLACE, REVOKE and GRANT are repeatable.
--
-- ROLLBACK (Task 6): run the three function definitions below exactly as they are (they are the bodies from
--   20260901102912_remote_schema.sql lines 2139-2238; none of the three was replaced by a later migration),
--   then run
--     GRANT EXECUTE ON FUNCTION public.search_public_items(text, integer), public.search_public_looks(text, integer),
--       public.search_public_news(text, integer) TO PUBLIC, anon, authenticated;
--   (same as remote_schema.sql lines 4020-4024).
--   Old bodies (verbatim; the "-- " prefix is the only thing added):
--
-- CREATE OR REPLACE FUNCTION public.search_items (
--   search_query text,
--   limit_count  integer DEFAULT 8
-- )
--   RETURNS TABLE (
--     id          bigint,
--     name        text,
--     description text,
--     category    text,
--     image_url   text,
--     price       integer
--   )
--   LANGUAGE sql
--   STABLE
--   SET search_path TO 'public', 'public', 'pg_temp'
--   AS $function$
--   SELECT
--     i.id::bigint,
--     i.name::text,
--     i.description::text,
--     i.category::text,
--     i.image_url::text,
--     i.price::int
--   FROM items AS i
--   WHERE i.status = 'published'
--     AND (
--       i.name        ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
--       OR i.description ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
--       OR i.category   ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
--     )
--   ORDER BY i.created_at DESC
--   LIMIT limit_count;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.search_looks (
--   search_query text,
--   limit_count  integer DEFAULT 8
-- )
--   RETURNS TABLE (
--     id                bigint,
--     season_year       integer,
--     season_type       text,
--     theme             text,
--     theme_description text,
--     image_urls        text[]
--   )
--   LANGUAGE sql
--   STABLE
--   SET search_path TO 'public', 'public', 'pg_temp'
--   AS $function$
--   SELECT
--     l.id::bigint,
--     l.season_year::int,
--     l.season_type::text,
--     l.theme::text,
--     l.theme_description::text,
--     l.image_urls::text[]
--   FROM looks AS l
--   WHERE l.status = 'published'
--     AND (
--       l.theme           ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
--       OR l.theme_description ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
--     )
--   ORDER BY l.created_at DESC
--   LIMIT limit_count;
-- $function$;
--
-- CREATE OR REPLACE FUNCTION public.search_news (
--   search_query text,
--   limit_count  integer DEFAULT 8
-- )
--   RETURNS TABLE (
--     id             bigint,
--     title          text,
--     category       text,
--     image_url      text,
--     content        text,
--     published_date text
--   )
--   LANGUAGE sql
--   STABLE
--   SET search_path TO 'public', 'public', 'pg_temp'
--   AS $function$
--   SELECT
--     a.id::bigint,
--     a.title::text,
--     a.category::text,
--     a.image_url::text,
--     a.content::text,
--     a.published_date::text
--   FROM news_articles AS a
--   WHERE a.status = 'published'
--     AND (
--       a.title    ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
--       OR a.content  ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
--       OR a.category ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
--     )
--   ORDER BY a.published_date DESC
--   LIMIT limit_count;
-- $function$;
--
BEGIN;

CREATE OR REPLACE FUNCTION public.search_items (
  search_query text,
  limit_count  integer DEFAULT 8
)
  RETURNS TABLE (
    id          bigint,
    name        text,
    description text,
    category    text,
    image_url   text,
    price       integer
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
  SELECT
    i.id::bigint,
    i.name::text,
    i.description::text,
    i.category::text,
    i.image_url::text,
    i.price::int
  FROM public.items AS i
  CROSS JOIN LATERAL (
    SELECT '%' || replace(replace(replace(left(search_query, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pat
  ) AS p
  WHERE i.status = 'published'
    AND (
      i.name        ILIKE p.pat ESCAPE '\'
      OR i.description ILIKE p.pat ESCAPE '\'
      OR i.category   ILIKE p.pat ESCAPE '\'
    )
  ORDER BY i.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(limit_count, 8), 8));
$function$;

CREATE OR REPLACE FUNCTION public.search_looks (
  search_query text,
  limit_count  integer DEFAULT 8
)
  RETURNS TABLE (
    id                bigint,
    season_year       integer,
    season_type       text,
    theme             text,
    theme_description text,
    image_urls        text[]
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
  SELECT
    l.id::bigint,
    l.season_year::int,
    l.season_type::text,
    l.theme::text,
    l.theme_description::text,
    l.image_urls::text[]
  FROM public.looks AS l
  CROSS JOIN LATERAL (
    SELECT '%' || replace(replace(replace(left(search_query, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pat
  ) AS p
  WHERE l.status = 'published'
    AND (
      l.theme           ILIKE p.pat ESCAPE '\'
      OR l.theme_description ILIKE p.pat ESCAPE '\'
    )
  ORDER BY l.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(limit_count, 8), 8));
$function$;

CREATE OR REPLACE FUNCTION public.search_news (
  search_query text,
  limit_count  integer DEFAULT 8
)
  RETURNS TABLE (
    id             bigint,
    title          text,
    category       text,
    image_url      text,
    content        text,
    published_date text
  )
  LANGUAGE sql
  STABLE
  SET search_path TO 'public', 'public', 'pg_temp'
  AS $function$
  SELECT
    a.id::bigint,
    a.title::text,
    a.category::text,
    a.image_url::text,
    a.content::text,
    a.published_date::text
  FROM public.news_articles AS a
  CROSS JOIN LATERAL (
    SELECT '%' || replace(replace(replace(left(search_query, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pat
  ) AS p
  WHERE a.status = 'published'
    AND (
      a.title    ILIKE p.pat ESCAPE '\'
      OR a.content  ILIKE p.pat ESCAPE '\'
      OR a.category ILIKE p.pat ESCAPE '\'
    )
  ORDER BY a.published_date DESC
  LIMIT GREATEST(1, LEAST(COALESCE(limit_count, 8), 8));
$function$;

-- The three search functions stay callable by the Data API roles (the application calls them with the anon key).
REVOKE ALL ON FUNCTION public.search_items(text, integer), public.search_looks(text, integer),
  public.search_news(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_items(text, integer), public.search_looks(text, integer),
  public.search_news(text, integer) TO anon, authenticated, service_role;

-- The unused search_public_* functions are closed to the Data API roles; postgres (owner) and service_role keep them.
REVOKE ALL ON FUNCTION public.search_public_items(text, integer), public.search_public_looks(text, integer),
  public.search_public_news(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_items(text, integer), public.search_public_looks(text, integer),
  public.search_public_news(text, integer) TO service_role;

-- Self check: any failure rolls the whole migration back.
DO $sec_search_functions_assert$
DECLARE
  v_signature text;
  v_oid oid;
  v_public_grantee boolean;
BEGIN
  -- (a) search_*: still callable by anon / authenticated / service_role, not by PUBLIC, SECURITY INVOKER,
  --     search_path unchanged, and the row cap and the term cut are in the body
  FOREACH v_signature IN ARRAY ARRAY[
    'public.search_items(text,integer)', 'public.search_looks(text,integer)', 'public.search_news(text,integer)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_search_functions:missing:' || v_signature;
    END IF;
    IF NOT (has_function_privilege('anon', v_oid, 'EXECUTE')
            AND has_function_privilege('authenticated', v_oid, 'EXECUTE')
            AND has_function_privilege('service_role', v_oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_search_functions:search_execute:' || v_signature;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM pg_proc AS p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
      WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) INTO v_public_grantee;
    IF v_public_grantee THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_search_functions:search_public_grantee:' || v_signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc AS p
      WHERE p.oid = v_oid
        AND NOT p.prosecdef
        AND p.proconfig = ARRAY['search_path=public, public, pg_temp']
        AND p.prosrc LIKE '%LEAST(COALESCE(limit_count, 8), 8)%'
        AND p.prosrc LIKE '%left(search_query, 100)%'
    ) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_search_functions:search_definition:' || v_signature;
    END IF;
  END LOOP;

  -- (b) search_public_*: closed to anon / authenticated, no PUBLIC grantee (grantee 0), owner and service_role keep EXECUTE
  FOREACH v_signature IN ARRAY ARRAY[
    'public.search_public_items(text,integer)', 'public.search_public_looks(text,integer)',
    'public.search_public_news(text,integer)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_search_functions:missing:' || v_signature;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_search_functions:public_execute:' || v_signature;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM pg_proc AS p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
      WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) INTO v_public_grantee;
    IF v_public_grantee THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_search_functions:public_grantee:' || v_signature;
    END IF;
    IF NOT (has_function_privilege('postgres', v_oid, 'EXECUTE') AND has_function_privilege('service_role', v_oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_search_functions:public_owner_execute:' || v_signature;
    END IF;
  END LOOP;
END
$sec_search_functions_assert$;

NOTIFY pgrst, 'reload schema';
COMMIT;
