-- 商品の非公開・削除（グループ A 設計書 4-6 の①・R-44）。

BEGIN;

-- 商品を含み、まだ受付の済んでいない開いている決済。決済画面の期限は30分30秒
-- （この変更の前に作った Session は24時間）なので、24時間以内の下書きだけを見る。
CREATE OR REPLACE FUNCTION public.find_open_checkout_sessions_for_item(_item_id bigint)
RETURNS TABLE (checkout_session_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT d.checkout_session_id
  FROM public.checkout_drafts AS d
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(d.items_snapshot) AS e(value)
  WHERE d.status = 'created'
    AND d.checkout_session_id IS NOT NULL
    AND d.created_at > pg_catalog.now() - interval '24 hours'
    AND (e.value->>'item_id')::bigint = _item_id
    AND NOT EXISTS (
      SELECT 1 FROM public.orders AS o WHERE o.checkout_session_id = d.checkout_session_id
    );
$$;

-- 削除できない理由。注文の明細・在庫の台帳は外部キーで商品を消せないので、汎用の500にせず理由を返す。
CREATE OR REPLACE FUNCTION public.item_delete_blockers(_item_ids bigint[])
RETURNS TABLE (item_id bigint, has_orders boolean, has_stock_movements boolean, has_open_checkouts boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ids.id,
         EXISTS (SELECT 1 FROM public.order_items AS oi WHERE oi.item_id = ids.id),
         EXISTS (
           SELECT 1
           FROM public.stock_movements AS m
           JOIN public.item_variants AS v ON v.id = m.variant_id
           WHERE v.item_id = ids.id
         ),
         EXISTS (SELECT 1 FROM public.find_open_checkout_sessions_for_item(ids.id))
  FROM pg_catalog.unnest(_item_ids) AS ids(id);
$$;

REVOKE ALL ON FUNCTION public.find_open_checkout_sessions_for_item(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.item_delete_blockers(bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_open_checkout_sessions_for_item(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.item_delete_blockers(bigint[]) TO service_role;

COMMIT;
