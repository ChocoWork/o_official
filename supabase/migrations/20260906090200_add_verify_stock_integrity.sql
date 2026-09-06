-- 台帳の合計とキャッシュ（item_variants.stock_quantity）の突き合わせ。
-- 食い違うバリアントだけを返す。整合していれば 0 行。

BEGIN;

CREATE OR REPLACE FUNCTION public.verify_stock_integrity()
RETURNS TABLE (variant_id bigint, cached integer, ledger integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT v.id,
         v.stock_quantity,
         coalesce(sum(m.delta)::integer, 0)
  FROM public.item_variants v
  LEFT JOIN public.stock_movements m ON m.variant_id = v.id
  GROUP BY v.id, v.stock_quantity
  HAVING v.stock_quantity <> coalesce(sum(m.delta)::integer, 0);
$$;

REVOKE ALL ON FUNCTION public.verify_stock_integrity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_stock_integrity() TO service_role;

COMMIT;
