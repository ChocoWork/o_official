-- Migration 060: Rank POPULAR ITEMS by actual purchase quantity
--
-- Background:
--   The search page previously fell back to "newest published items" for
--   POPULAR ITEMS.  FREQ-186 requires ranking by how many units were actually
--   purchased.
--
-- Purchase count definition:
--   Sum of order_items.quantity for orders whose status = 'paid'.
--   pending / failed / cancelled orders are not completed purchases and are
--   excluded.  Items with no purchases are still returned (ordered last, then
--   by created_at DESC) so the list never renders short.
--
-- Access control:
--   SECURITY INVOKER - relies on the caller's privileges.  orders/order_items
--   are protected by RLS (own orders + admins only), so this is callable only
--   by the service role, which the server-side search service uses.  EXECUTE is
--   granted to service_role alone; anon/authenticated must not read aggregate
--   sales figures directly.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_popular_items(
  limit_count int DEFAULT 4
)
RETURNS TABLE (
  id             bigint,
  name           text,
  description    text,
  category       text,
  image_url      text,
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

-- Supabase grants EXECUTE on new public-schema functions to anon/authenticated
-- by default, so revoking from PUBLIC alone is not enough - revoke them by name.
REVOKE ALL ON FUNCTION public.get_popular_items(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_popular_items(int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_popular_items(int) TO service_role;

COMMIT;
