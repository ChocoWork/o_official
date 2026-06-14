-- Migration 052: Fix RETURNS TABLE item_id type mismatch.
-- carts.item_id and items.id are bigint in the actual DB,
-- but the function declared item_id as integer, causing type error 42804.
-- Return type change requires DROP first (CREATE OR REPLACE cannot alter it).

DROP FUNCTION IF EXISTS public.update_cart_item_quantity_secure(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.update_cart_item_quantity_secure(
  _cart_id uuid,
  _session_id text,
  _quantity integer
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  session_id text,
  item_id bigint,
  quantity integer,
  color text,
  size text,
  added_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_cart_item public.carts%ROWTYPE;
  item_row RECORD;
  requested_total_quantity integer;
BEGIN
  IF _cart_id IS NULL OR _session_id IS NULL OR btrim(_session_id) = '' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  IF _quantity IS NULL OR _quantity < 1 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  SELECT c.*
  INTO target_cart_item
  FROM public.carts AS c
  WHERE c.id = _cart_id
    AND c.session_id = _session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CART_ITEM_NOT_FOUND';
  END IF;

  SELECT i.id, i.name, i.stock_quantity, i.status
  INTO item_row
  FROM public.items AS i
  WHERE i.id = target_cart_item.item_id
  FOR SHARE;

  IF NOT FOUND OR item_row.status <> 'published' THEN
    RAISE EXCEPTION 'ITEM_NOT_FOUND';
  END IF;

  SELECT COALESCE(SUM(c.quantity), 0) + _quantity
  INTO requested_total_quantity
  FROM public.carts AS c
  WHERE c.session_id = _session_id
    AND c.item_id = target_cart_item.item_id
    AND c.id <> _cart_id;

  IF item_row.stock_quantity IS NOT NULL AND requested_total_quantity > item_row.stock_quantity THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK:%:%:%', item_row.id, requested_total_quantity, item_row.stock_quantity;
  END IF;

  RETURN QUERY
  UPDATE public.carts AS c
  SET quantity = _quantity,
      updated_at = now()
  WHERE c.id = _cart_id
    AND c.session_id = _session_id
  RETURNING
    c.id,
    c.user_id,
    c.session_id,
    c.item_id,
    c.quantity,
    c.color,
    c.size,
    c.added_at,
    c.updated_at;
END;
$$;

REVOKE ALL ON FUNCTION public.update_cart_item_quantity_secure(uuid, text, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.update_cart_item_quantity_secure(uuid, text, integer)
  TO anon, authenticated, service_role;
