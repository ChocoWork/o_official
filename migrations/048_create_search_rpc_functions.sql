-- Migration 048: Create RPC functions for full-text search
--
-- Security rationale (OWASP A03: Injection):
-- The previous implementation concatenated user input directly into PostgREST
-- .or() filter strings, which could allow filter-string injection.
-- These RPC functions accept search_query as a bind parameter; user input is
-- never interpolated into the SQL template.  ILIKE special characters (% and _)
-- are escaped inside the function before use.
--
-- Access control:
--   SECURITY INVOKER - runs with the caller's privileges so RLS on the base
--   tables (items, looks, news_articles) continues to apply automatically.
--   EXECUTE is granted only to the anon and authenticated roles.

-- ─────────────────────────────────────────────────────────────────
-- 1. search_items
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_items(
  search_query text,
  limit_count  int DEFAULT 8
)
RETURNS TABLE (
  id          bigint,
  name        text,
  description text,
  category    text,
  image_url   text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    i.id::bigint,
    i.name::text,
    i.description::text,
    i.category::text,
    i.image_url::text
  FROM items AS i
  WHERE i.status = 'published'
    AND (
      i.name        ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR i.description ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR i.category   ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    )
  ORDER BY i.created_at DESC
  LIMIT limit_count;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 2. search_looks
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_looks(
  search_query text,
  limit_count  int DEFAULT 8
)
RETURNS TABLE (
  id                bigint,
  season_year       int,
  season_type       text,
  theme             text,
  theme_description text,
  image_urls        text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    l.id::bigint,
    l.season_year::int,
    l.season_type::text,
    l.theme::text,
    l.theme_description::text,
    l.image_urls::text[]
  FROM looks AS l
  WHERE l.status = 'published'
    AND (
      l.theme           ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR l.theme_description ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    )
  ORDER BY l.created_at DESC
  LIMIT limit_count;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 3. search_news
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.search_news(
  search_query   text,
  limit_count    int DEFAULT 8
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
SECURITY INVOKER
AS $$
  SELECT
    a.id::bigint,
    a.title::text,
    a.category::text,
    a.image_url::text,
    a.content::text,
    a.published_date::text
  FROM news_articles AS a
  WHERE a.status = 'published'
    AND (
      a.title    ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR a.content  ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
      OR a.category ILIKE '%' || replace(replace(search_query, '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    )
  ORDER BY a.published_date DESC
  LIMIT limit_count;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 4. Grant execute to API roles only
-- ─────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.search_items(text, int)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_looks(text, int)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_news(text, int)   FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.search_items(text, int)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_looks(text, int)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_news(text, int)   TO anon, authenticated;
