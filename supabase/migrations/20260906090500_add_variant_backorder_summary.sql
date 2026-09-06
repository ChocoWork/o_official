-- 受注数の真実は注文明細。実体列を持たず、ここから集計する。

BEGIN;

CREATE VIEW public.variant_backorder_summary
WITH (security_invoker = true) AS
SELECT oi.variant_id,
       sum(oi.quantity)::integer AS backorder_quantity
FROM public.order_items oi
WHERE oi.fulfillment_type = 'backorder'
  AND oi.variant_id IS NOT NULL
GROUP BY oi.variant_id;

REVOKE ALL ON public.variant_backorder_summary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.variant_backorder_summary TO service_role;

COMMIT;
