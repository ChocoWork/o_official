-- 043: Harden finalize_order_from_checkout_draft with published-item guard
-- Blocks private/unpublished items at DB finalization layer (defense in depth).

BEGIN;

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
  WHERE (_checkout_session_id IS NOT NULL AND o.checkout_session_id = _checkout_session_id)
     OR o.payment_intent_id = _payment_intent_id
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

  IF draft_row.stripe_checkout_session_id IS NOT NULL
    AND _checkout_session_id IS NOT NULL
    AND draft_row.stripe_checkout_session_id <> _checkout_session_id THEN
    RAISE EXCEPTION 'PAYMENT_REFERENCE_MISMATCH';
  END IF;

  IF draft_row.stripe_payment_intent_id IS NOT NULL
    AND draft_row.stripe_payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_REFERENCE_MISMATCH';
  END IF;

  UPDATE public.checkout_drafts
  SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, _checkout_session_id),
      stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, _payment_intent_id)
  WHERE id = _draft_id;

  FOR locked_item IN
    SELECT
      i.id,
      i.status,
      i.stock_quantity,
      SUM(di.quantity)::integer AS requested_quantity
    FROM public.items i
    INNER JOIN public.checkout_draft_items di
      ON di.item_id = i.id
    WHERE di.draft_id = _draft_id
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
      draft_row.session_id,
      COALESCE(_checkout_session_id, draft_row.stripe_checkout_session_id),
      _payment_intent_id,
      _order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      draft_row.total_amount,
      draft_row.currency,
      draft_row.shipping_email,
      draft_row.shipping_full_name,
      draft_row.shipping_postal_code,
      draft_row.shipping_prefecture,
      draft_row.shipping_city,
      draft_row.shipping_address,
      draft_row.shipping_building,
      draft_row.shipping_phone
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
    di.item_id,
    di.item_name,
    di.item_price,
    di.item_image_url,
    di.color,
    di.size,
    di.quantity,
    di.line_total
  FROM public.checkout_draft_items di
  WHERE di.draft_id = _draft_id;

  UPDATE public.items i
  SET stock_quantity = i.stock_quantity - requested.requested_quantity
  FROM (
    SELECT di.item_id, SUM(di.quantity)::integer AS requested_quantity
    FROM public.checkout_draft_items di
    WHERE di.draft_id = _draft_id
    GROUP BY di.item_id
  ) AS requested
  WHERE i.id = requested.item_id
    AND i.stock_quantity IS NOT NULL;

  UPDATE public.carts c
  SET quantity = c.quantity - di.quantity,
      updated_at = now()
  FROM public.checkout_draft_items di
  WHERE di.draft_id = _draft_id
    AND di.source_cart_id IS NOT NULL
    AND c.id = di.source_cart_id
    AND c.session_id = draft_row.session_id
    AND c.quantity > di.quantity;

  DELETE FROM public.carts c
  USING public.checkout_draft_items di
  WHERE di.draft_id = _draft_id
    AND di.source_cart_id IS NOT NULL
    AND c.id = di.source_cart_id
    AND c.session_id = draft_row.session_id
    AND c.quantity <= di.quantity;

  UPDATE public.checkout_drafts
  SET completed_at = COALESCE(completed_at, now()),
      stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, _checkout_session_id),
      stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, _payment_intent_id)
  WHERE id = _draft_id;

  RETURN QUERY SELECT order_id, order_status;
END;
$$;

COMMIT;
