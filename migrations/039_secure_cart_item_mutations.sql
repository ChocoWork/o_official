-- Secure cart mutations for guest session carts without service role
-- This allows API routes to use anon/authenticated clients while enforcing session ownership in DB.

CREATE OR REPLACE FUNCTION public.update_cart_item_quantity_secure(
  _cart_id uuid,
  _session_id text,
  _quantity integer
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  session_id text,
  item_id integer,
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

  SELECT *
  INTO target_cart_item
  FROM public.carts
  WHERE id = _cart_id
    AND session_id = _session_id
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
  UPDATE public.carts
  SET quantity = _quantity,
      updated_at = now()
  WHERE public.carts.id = _cart_id
    AND public.carts.session_id = _session_id
  RETURNING
    public.carts.id,
    public.carts.user_id,
    public.carts.session_id,
    public.carts.item_id,
    public.carts.quantity,
    public.carts.color,
    public.carts.size,
    public.carts.added_at,
    public.carts.updated_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_cart_item_secure(
  _cart_id uuid,
  _session_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF _cart_id IS NULL OR _session_id IS NULL OR btrim(_session_id) = '' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  DELETE FROM public.carts
  WHERE id = _cart_id
    AND session_id = _session_id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  IF deleted_count = 0 THEN
    RAISE EXCEPTION 'CART_ITEM_NOT_FOUND';
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.update_cart_item_quantity_secure(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_cart_item_secure(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.update_cart_item_quantity_secure(uuid, text, integer)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_cart_item_secure(uuid, text)
  TO anon, authenticated, service_role;
