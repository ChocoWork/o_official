-- Migration 061: Expose item price from the search RPCs
--
-- Background:
--   The search page ITEM rows previously showed the item category (e.g.
--   OUTERWEAR / BOTTOMS) as their meta line.  The requirement (FREQ-201) is to
--   show the price there instead.  search_items / get_popular_items did not
--   return price, so it is added here.
--
-- Both functions add a new `price int` output column.  Changing a function's
-- RETURNS TABLE shape requires DROP + CREATE (CREATE OR REPLACE cannot change
-- the return type), so each function is dropped and recreated with its original
-- body plus price, and the original grants are re-applied.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. search_items  (add price)
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.search_items(text, int);

CREATE FUNCTION public.search_items(
  search_query text,
  limit_count  int DEFAULT 8
)
RETURNS TABLE (
  id          bigint,
  name        text,
  description text,
  category    text,
  image_url   text,
  price       int
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
    i.image_url::text,
    i.price::int
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

REVOKE ALL ON FUNCTION public.search_items(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_items(text, int) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 2. get_popular_items  (add price)
--    Popular items are ITEM rows rendered the same way, so they show
--    price too.  Purchase-count ranking and access control are unchanged.
-- ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_popular_items(int);

CREATE FUNCTION public.get_popular_items(
  limit_count int DEFAULT 4
)
RETURNS TABLE (
  id             bigint,
  name           text,
  description    text,
  category       text,
  image_url      text,
  price          int,
  purchase_count bigint
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
    i.image_url::text,
    i.price::int,
    COALESCE(paid.purchase_count, 0)::bigint AS purchase_count
  FROM items AS i
  LEFT JOIN (
    SELECT
      oi.item_id,
      SUM(oi.quantity) AS purchase_count
    FROM order_items AS oi
    JOIN orders AS o ON o.id = oi.order_id
    WHERE o.status = 'paid'
    GROUP BY oi.item_id
  ) AS paid ON paid.item_id = i.id
  WHERE i.status = 'published'
  ORDER BY COALESCE(paid.purchase_count, 0) DESC, i.created_at DESC
  LIMIT limit_count;
$$;

REVOKE ALL ON FUNCTION public.get_popular_items(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_popular_items(int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_popular_items(int) TO service_role;

COMMIT;
