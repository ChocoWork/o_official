-- Migration 054: Support promotion-code discounts.
-- Adds discount_amount to checkout_drafts and orders, and updates
-- finalize_order_from_checkout_draft to carry the discount through to orders.
-- (Re-creates the function from migration 050 with the discount_amount column added.)

BEGIN;

ALTER TABLE public.checkout_drafts
  ADD COLUMN IF NOT EXISTS discount_amount integer NOT NULL DEFAULT 0
  CHECK (discount_amount >= 0);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS discount_amount integer NOT NULL DEFAULT 0
  CHECK (discount_amount >= 0);

CREATE OR REPLACE FUNCTION public.finalize_order_from_checkout_draft(
  _draft_id uuid,
  _payment_intent_id text,
  _checkout_session_id text,
  _order_status public.order_status,
  _expected_total_amount integer,
  _currency text
) RETURNS TABLE (
  order_id uuid,
  order_status public.order_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  locked_item record;
BEGIN
  IF _draft_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT';
  END IF;

  IF _payment_intent_id IS NULL OR btrim(_payment_intent_id) = '' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_REFERENCE';
  END IF;

  SELECT o.id, o.status
  INTO order_id, order_status
  FROM public.orders o
  WHERE o.payment_intent_id = _payment_intent_id
  LIMIT 1;

  IF order_id IS NOT NULL THEN
    RETURN QUERY SELECT order_id, order_status;
    RETURN;
  END IF;

  SELECT *
  INTO draft_row
  FROM public.checkout_drafts d
  WHERE d.id = _draft_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_CHECKOUT_DRAFT';
  END IF;

  IF _expected_total_amount IS NOT NULL AND draft_row.total_amount <> _expected_total_amount THEN
    RAISE EXCEPTION 'CHECKOUT_TOTAL_MISMATCH:%:%', draft_row.total_amount, _expected_total_amount;
  END IF;

  IF _currency IS NOT NULL AND lower(draft_row.currency) <> lower(_currency) THEN
    RAISE EXCEPTION 'CHECKOUT_CURRENCY_MISMATCH:%:%', draft_row.currency, _currency;
  END IF;

  IF draft_row.checkout_session_id IS NOT NULL
    AND _checkout_session_id IS NOT NULL
    AND draft_row.checkout_session_id <> _checkout_session_id THEN
    RAISE EXCEPTION 'PAYMENT_REFERENCE_MISMATCH';
  END IF;

  IF draft_row.payment_intent_id IS NOT NULL
    AND draft_row.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_REFERENCE_MISMATCH';
  END IF;

  UPDATE public.checkout_drafts
  SET checkout_session_id = COALESCE(checkout_session_id, _checkout_session_id),
      payment_intent_id = COALESCE(payment_intent_id, _payment_intent_id)
  WHERE id = _draft_id;

  FOR locked_item IN
    WITH draft_items AS (
      SELECT *
      FROM jsonb_to_recordset(COALESCE(draft_row.items_snapshot, '[]'::jsonb)) AS draft_item(
        source_cart_id text,
        item_id integer,
        item_name text,
        item_price integer,
        item_image_url text,
        color text,
        size text,
        quantity integer,
        line_total integer
      )
    )
    SELECT
      i.id,
      i.status,
      i.stock_quantity,
      SUM(draft_items.quantity)::integer AS requested_quantity
    FROM public.items i
    INNER JOIN draft_items
      ON draft_items.item_id = i.id
    GROUP BY i.id, i.status, i.stock_quantity
    FOR UPDATE OF i
  LOOP
    IF locked_item.status <> 'published' THEN
      RAISE EXCEPTION 'ITEM_NOT_PUBLISHED:%', locked_item.id;
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

  BEGIN
    INSERT INTO public.orders (
      session_id,
      payment_intent_id,
      status,
      subtotal_amount,
      shipping_amount,
      discount_amount,
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
      draft_row.session_id,
      _payment_intent_id,
      _order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      COALESCE(draft_row.discount_amount, 0),
      draft_row.total_amount,
      draft_row.currency,
      draft_row.shipping_snapshot ->> 'email',
      draft_row.shipping_snapshot ->> 'fullName',
      draft_row.shipping_snapshot ->> 'postalCode',
      draft_row.shipping_snapshot ->> 'prefecture',
      draft_row.shipping_snapshot ->> 'city',
      draft_row.shipping_snapshot ->> 'address',
      draft_row.shipping_snapshot ->> 'building',
      draft_row.shipping_snapshot ->> 'phone'
    )
    RETURNING id, status
    INTO order_id, order_status;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status
      INTO order_id, order_status
      FROM public.orders o
      WHERE o.payment_intent_id = _payment_intent_id
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
    draft_items.item_id,
    draft_items.item_name,
    draft_items.item_price,
    draft_items.item_image_url,
    draft_items.color,
    draft_items.size,
    draft_items.quantity,
    draft_items.line_total
  FROM jsonb_to_recordset(COALESCE(draft_row.items_snapshot, '[]'::jsonb)) AS draft_items(
    source_cart_id text,
    item_id integer,
    item_name text,
    item_price integer,
    item_image_url text,
    color text,
    size text,
    quantity integer,
    line_total integer
  );

  UPDATE public.items i
  SET stock_quantity = i.stock_quantity - requested.requested_quantity
  FROM (
    SELECT draft_items.item_id, SUM(draft_items.quantity)::integer AS requested_quantity
    FROM jsonb_to_recordset(COALESCE(draft_row.items_snapshot, '[]'::jsonb)) AS draft_items(
      source_cart_id text,
      item_id integer,
      item_name text,
      item_price integer,
      item_image_url text,
      color text,
      size text,
      quantity integer,
      line_total integer
    )
    GROUP BY draft_items.item_id
  ) AS requested
  WHERE i.id = requested.item_id
    AND i.stock_quantity IS NOT NULL;

  UPDATE public.carts c
  SET quantity = c.quantity - draft_items.quantity,
      updated_at = now()
  FROM jsonb_to_recordset(COALESCE(draft_row.items_snapshot, '[]'::jsonb)) AS draft_items(
    source_cart_id text,
    item_id integer,
    item_name text,
    item_price integer,
    item_image_url text,
    color text,
    size text,
    quantity integer,
    line_total integer
  )
  WHERE draft_items.source_cart_id IS NOT NULL
    AND c.id = draft_items.source_cart_id
    AND c.session_id = draft_row.session_id
    AND c.quantity > draft_items.quantity;

  DELETE FROM public.carts c
  USING jsonb_to_recordset(COALESCE(draft_row.items_snapshot, '[]'::jsonb)) AS draft_items(
    source_cart_id text,
    item_id integer,
    item_name text,
    item_price integer,
    item_image_url text,
    color text,
    size text,
    quantity integer,
    line_total integer
  )
  WHERE draft_items.source_cart_id IS NOT NULL
    AND c.id = draft_items.source_cart_id
    AND c.session_id = draft_row.session_id
    AND c.quantity <= draft_items.quantity;

  UPDATE public.checkout_drafts
  SET status = 'completed',
      checkout_session_id = COALESCE(checkout_session_id, _checkout_session_id),
      payment_intent_id = COALESCE(payment_intent_id, _payment_intent_id)
  WHERE id = _draft_id;

  RETURN QUERY SELECT order_id, order_status;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_order_from_checkout_draft(
  uuid,
  text,
  text,
  public.order_status,
  integer,
  text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.finalize_order_from_checkout_draft(
  uuid,
  text,
  text,
  public.order_status,
  integer,
  text
) TO service_role;

COMMIT;
