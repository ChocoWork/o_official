-- 038: Finalize order from cart with atomic stock decrement

BEGIN;

DROP FUNCTION IF EXISTS public.finalize_order_from_cart(
  text,
  text,
  text,
  public.order_status,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
);

CREATE OR REPLACE FUNCTION public.finalize_order_from_cart(
  _session_id text,
  _payment_intent_id text,
  _checkout_session_id text,
  _order_status public.order_status,
  _expected_total_amount integer,
  _currency text,
  _shipping_email text,
  _shipping_full_name text,
  _shipping_postal_code text,
  _shipping_prefecture text,
  _shipping_city text,
  _shipping_address text,
  _shipping_building text,
  _shipping_phone text
) RETURNS TABLE (
  order_id uuid,
  order_status public.order_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  locked_item record;
  subtotal_amount integer := 0;
  shipping_amount integer := 0;
  total_amount integer := 0;
BEGIN
  IF _session_id IS NULL OR btrim(_session_id) = '' THEN
    RAISE EXCEPTION 'INVALID_SESSION';
  END IF;

  IF _payment_intent_id IS NULL OR btrim(_payment_intent_id) = '' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_REFERENCE';
  END IF;

  SELECT o.id, o.status
  INTO order_id, order_status
  FROM public.orders o
  WHERE (_checkout_session_id IS NOT NULL AND o.checkout_session_id = _checkout_session_id)
     OR o.payment_intent_id = _payment_intent_id
  LIMIT 1;

  IF order_id IS NOT NULL THEN
    RETURN QUERY SELECT order_id, order_status;
    RETURN;
  END IF;

  PERFORM 1
  FROM public.carts c
  WHERE c.session_id = _session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EMPTY_CART';
  END IF;

  FOR locked_item IN
    SELECT
      i.id,
      i.name,
      i.status,
      i.stock_quantity,
      SUM(c.quantity)::integer AS requested_quantity
    FROM public.items i
    INNER JOIN public.carts c
      ON c.item_id = i.id
    WHERE c.session_id = _session_id
    GROUP BY i.id, i.name, i.status, i.stock_quantity
    FOR UPDATE OF i
  LOOP
    IF locked_item.status <> 'published' THEN
      RAISE EXCEPTION 'CART_ITEM_UNAVAILABLE:%', locked_item.id;
    END IF;

    IF locked_item.stock_quantity IS NOT NULL
      AND locked_item.requested_quantity > locked_item.stock_quantity THEN
      RAISE EXCEPTION
        'INSUFFICIENT_STOCK:%:%:%',
        locked_item.id,
        locked_item.requested_quantity,
        locked_item.stock_quantity;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(i.price * c.quantity), 0)::integer
  INTO subtotal_amount
  FROM public.carts c
  INNER JOIN public.items i
    ON i.id = c.item_id
  WHERE c.session_id = _session_id;

  IF subtotal_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_CART_TOTAL';
  END IF;

  shipping_amount := CASE WHEN subtotal_amount = 0 THEN 0 ELSE 500 END;
  total_amount := subtotal_amount + shipping_amount;

  IF _expected_total_amount IS NOT NULL AND total_amount <> _expected_total_amount THEN
    RAISE EXCEPTION 'CHECKOUT_TOTAL_MISMATCH:%:%', total_amount, _expected_total_amount;
  END IF;

  BEGIN
    INSERT INTO public.orders (
      session_id,
      checkout_session_id,
      payment_intent_id,
      status,
      subtotal_amount,
      shipping_amount,
      total_amount,
      currency,
      shipping_email,
      shipping_full_name,
      shipping_postal_code,
      shipping_prefecture,
      shipping_city,
      shipping_address,
      shipping_building,
      shipping_phone
    ) VALUES (
      _session_id,
      _checkout_session_id,
      _payment_intent_id,
      _order_status,
      subtotal_amount,
      shipping_amount,
      total_amount,
      COALESCE(NULLIF(_currency, ''), 'jpy'),
      _shipping_email,
      _shipping_full_name,
      _shipping_postal_code,
      _shipping_prefecture,
      _shipping_city,
      _shipping_address,
      _shipping_building,
      _shipping_phone
    )
    RETURNING id, status
    INTO order_id, order_status;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status
      INTO order_id, order_status
      FROM public.orders o
      WHERE (_checkout_session_id IS NOT NULL AND o.checkout_session_id = _checkout_session_id)
         OR o.payment_intent_id = _payment_intent_id
      LIMIT 1;

      IF order_id IS NOT NULL THEN
        RETURN QUERY SELECT order_id, order_status;
        RETURN;
      END IF;

      RAISE;
  END;

  INSERT INTO public.order_items (
    order_id,
    item_id,
    item_name,
    item_price,
    item_image_url,
    color,
    size,
    quantity,
    line_total
  )
  SELECT
    order_id,
    i.id,
    i.name,
    i.price,
    i.image_url,
    c.color,
    c.size,
    c.quantity,
    i.price * c.quantity
  FROM public.carts c
  INNER JOIN public.items i
    ON i.id = c.item_id
  WHERE c.session_id = _session_id;

  UPDATE public.items i
  SET stock_quantity = i.stock_quantity - requested.requested_quantity
  FROM (
    SELECT c.item_id, SUM(c.quantity)::integer AS requested_quantity
    FROM public.carts c
    WHERE c.session_id = _session_id
    GROUP BY c.item_id
  ) AS requested
  WHERE i.id = requested.item_id
    AND i.stock_quantity IS NOT NULL;

  DELETE FROM public.carts
  WHERE session_id = _session_id;

  RETURN QUERY SELECT order_id, order_status;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_order_from_cart(
  text,
  text,
  text,
  public.order_status,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.finalize_order_from_cart(
  text,
  text,
  text,
  public.order_status,
  integer,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) TO service_role;

COMMIT;