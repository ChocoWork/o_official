-- 入金済み・入金待ちにする RPC（グループ A 設計書 4-1・4-5）。

BEGIN;

-- 注文の下書きに書かれたカートの行を消す。支払いが済んだ（入金済み・払込票の発行）時点で呼ぶ。
-- Session ID を持たない古い注文は下書きを引けないので何もしない（当時の確定 RPC が消している）。
CREATE OR REPLACE FUNCTION private.clear_cart_for_order(_order_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  DELETE FROM public.carts AS c
  USING public.orders AS o,
        public.checkout_drafts AS d,
        pg_catalog.jsonb_array_elements(d.items_snapshot) AS s(value)
  WHERE o.id = _order_id
    AND d.checkout_session_id = o.checkout_session_id
    AND (s.value->>'source_cart_id') IS NOT NULL
    AND c.id = (s.value->>'source_cart_id')::uuid
    AND c.session_id = d.session_id;
$$;

REVOKE ALL ON FUNCTION private.clear_cart_for_order(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.mark_order_paid(
  _order_id uuid,
  _expected_status public.order_status,
  _payment_intent_id text,
  _paid_amount integer,
  _paid_currency text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean, amount_matches boolean, needs_review boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
  matches boolean;
  missing_reservation boolean;
BEGIN
  IF _order_id IS NULL
     OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL
     OR _paid_amount IS NULL
     OR NULLIF(pg_catalog.btrim(_paid_currency), '') IS NULL THEN
    RAISE EXCEPTION 'MARK_PAID_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _expected_status IS NULL
     OR _expected_status NOT IN (
       'payment_in_progress'::public.order_status,
       'pending'::public.order_status,
       'failed'::public.order_status
     ) THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_STATUS:%', _expected_status USING ERRCODE = '22023';
  END IF;

  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;

  IF target.id IS NULL OR target.status IS DISTINCT FROM _expected_status THEN
    RETURN QUERY SELECT false, NULL::boolean, NULL::boolean;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  matches := target.total_amount = _paid_amount
    AND pg_catalog.lower(target.currency) = pg_catalog.lower(_paid_currency);

  -- 在庫扱いで確保中が0の明細（⑤の失敗の後の入金と、確保の記録が無い古い明細）を確保し直す。
  -- バリアントは id の昇順でロックする（受付・在庫を戻す処理と同じ順）。
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
      AND r.variant_id IS NOT NULL
  )
  ORDER BY v.id
  FOR UPDATE;

  -- 足りるバリアントの明細だけ確保する。同じバリアントの明細は合算して判定する（受付と同じ）。
  WITH lines AS (
    SELECT r.order_item_id, r.variant_id, r.quantity
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
      AND r.variant_id IS NOT NULL
  ),
  needed AS (
    SELECT l.variant_id, pg_catalog.sum(l.quantity)::integer AS quantity
    FROM lines AS l
    GROUP BY l.variant_id
  ),
  covered AS (
    SELECT n.variant_id
    FROM needed AS n
    JOIN public.item_variants AS v ON v.id = n.variant_id
    WHERE v.is_active
      AND v.stock_quantity >= n.quantity
  )
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, note)
  SELECT l.variant_id, -l.quantity, 'purchase', _order_id, l.order_item_id, 'reserve_on_paid'
  FROM lines AS l
  WHERE l.variant_id IN (SELECT c.variant_id FROM covered AS c)
  ORDER BY l.variant_id, l.order_item_id;

  SELECT EXISTS (
    SELECT 1
    FROM private.order_line_reservations(_order_id) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE oi.fulfillment_type = 'stock'
      AND r.reserved = 0
  ) INTO missing_reservation;

  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_paid', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = 'paid'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id),
      review_reason = CASE WHEN missing_reservation THEN 'stock_not_reserved' ELSE o.review_reason END,
      review_marked_at = CASE WHEN missing_reservation THEN pg_catalog.now() ELSE o.review_marked_at END
  WHERE o.id = _order_id;

  UPDATE public.checkout_drafts AS d
  SET payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE target.checkout_session_id IS NOT NULL
    AND d.checkout_session_id = target.checkout_session_id;

  PERFORM private.clear_cart_for_order(_order_id);

  RETURN QUERY SELECT true, matches, missing_reservation;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_order_awaiting_payment(
  _order_id uuid,
  _payment_intent_id text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
BEGIN
  IF _order_id IS NULL OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL THEN
    RAISE EXCEPTION 'MARK_AWAITING_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;

  IF target.id IS NULL OR target.status IS DISTINCT FROM 'payment_in_progress'::public.order_status THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_awaiting', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = 'pending'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id)
  WHERE o.id = _order_id;

  UPDATE public.checkout_drafts AS d
  SET payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE target.checkout_session_id IS NOT NULL
    AND d.checkout_session_id = target.checkout_session_id;

  PERFORM private.clear_cart_for_order(_order_id);

  RETURN QUERY SELECT true;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_awaiting_payment(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_awaiting_payment(uuid, text, text)
  TO service_role;

COMMIT;
