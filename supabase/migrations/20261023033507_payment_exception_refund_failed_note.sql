-- 返金の失敗を人が解決するときだけ、確かめた内容のメモを必須にする（波1 Task 2 / J-04）。

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_payment_exception(
  _exception_id uuid,
  _actor_id uuid,
  _note text DEFAULT NULL,
  _cancel_order boolean DEFAULT false,
  _cancel_reason text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (resolved boolean, order_id uuid, cancelled_from public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.payment_exceptions%ROWTYPE;
  current_status public.order_status;
  was_released boolean;
BEGIN
  IF _exception_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RESOLVE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  SELECT e.* INTO target FROM public.payment_exceptions AS e WHERE e.id = _exception_id FOR UPDATE;

  IF target.id IS NULL OR target.resolved_at IS NOT NULL THEN
    RETURN QUERY SELECT false, target.order_id, NULL::public.order_status;
    RETURN;
  END IF;

  IF target.reason = 'refund_failed' AND (_note IS NULL OR _note ~ '^[[:space:]]*$') THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(_cancel_order, false) THEN
    IF NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
      RAISE EXCEPTION 'RESOLUTION_NOTE_REQUIRED' USING ERRCODE = '22023';
    END IF;

    SELECT o.status INTO current_status FROM public.orders AS o WHERE o.id = target.order_id;

    IF current_status IS NULL
       OR current_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
      RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
    END IF;

    SELECT r.released INTO was_released
    FROM public.release_stock_for_unpaid_order(
      target.order_id,
      current_status,
      'cancelled'::public.order_status,
      'resolve_payment_exception',
      _actor_id,
      NULL,
      _cancel_reason,
      _note,
      _notify_customer
    ) AS r;

    IF NOT COALESCE(was_released, false) THEN
      RETURN QUERY SELECT false, target.order_id, NULL::public.order_status;
      RETURN;
    END IF;
  END IF;

  UPDATE public.payment_exceptions AS e
  SET resolved_at = pg_catalog.now(),
      resolved_by = _actor_id,
      resolution_note = NULLIF(pg_catalog.btrim(_note), '')
  WHERE e.id = _exception_id;

  RETURN QUERY SELECT
    true,
    target.order_id,
    CASE WHEN COALESCE(_cancel_order, false) THEN current_status ELSE NULL::public.order_status END;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_payment_exception(uuid, uuid, text, boolean, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_payment_exception(uuid, uuid, text, boolean, text, boolean)
  TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
