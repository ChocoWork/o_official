-- 注文 ID で引いて、確保した分だけ在庫を戻す（グループ A 設計書 4-1・4-5・4-7）。
--
-- 支払い手続き中の注文は PaymentIntent を持たないので、注文 ID で引く。
-- 旧定義 release_stock_for_unpaid_order(text, order_status) は、呼び出し元を切り替えた後の
-- Task 22 で消す（20260927100800_retire_legacy_order_rpcs.sql）。

BEGIN;

-- 明細ごとの「確保中の数」。台帳の確保（purchase）と戻し（cancel）を足して符号を反転する。
-- 種類の欄（stock / backorder）の既定値は信用しない（R-41: 古い明細は確保の記録が無いまま stock）。
CREATE OR REPLACE FUNCTION private.order_line_reservations(_order_id uuid)
RETURNS TABLE (order_item_id uuid, variant_id bigint, quantity integer, reserved integer)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT oi.id,
         oi.variant_id,
         oi.quantity,
         GREATEST(0, -COALESCE((
           SELECT pg_catalog.sum(m.delta)
           FROM public.stock_movements AS m
           WHERE m.order_item_id = oi.id
             AND m.reason IN ('purchase', 'cancel')
         ), 0))::integer
  FROM public.order_items AS oi
  WHERE oi.order_id = _order_id;
$$;

REVOKE ALL ON FUNCTION private.order_line_reservations(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.release_stock_for_unpaid_order(
  _order_id uuid,
  _expected_status public.order_status,
  _next_status public.order_status,
  _change_reason text,
  _actor_id uuid DEFAULT NULL,
  _source_event_id text DEFAULT NULL,
  _cancel_reason text DEFAULT NULL,
  _cancel_note text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (released boolean, order_id uuid, status public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  updated_id uuid;
BEGIN
  IF _order_id IS NULL OR _change_reason IS NULL OR pg_catalog.btrim(_change_reason) = '' THEN
    RAISE EXCEPTION 'RELEASE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _expected_status IS NULL
     OR _expected_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_STATUS:%', _expected_status USING ERRCODE = '22023';
  END IF;

  IF _next_status IS NULL
     OR _next_status NOT IN (
       'failed'::public.order_status, 'abandoned'::public.order_status, 'cancelled'::public.order_status
     ) THEN
    RAISE EXCEPTION 'INVALID_NEXT_STATUS:%', _next_status USING ERRCODE = '22023';
  END IF;

  -- 放棄は「決済画面が一度も完了しなかった」注文だけ。払込票を発行した入金待ちは放棄にしない。
  IF _next_status = 'abandoned'::public.order_status
     AND _expected_status <> 'payment_in_progress'::public.order_status THEN
    RAISE EXCEPTION 'ABANDON_REQUIRES_PAYMENT_IN_PROGRESS' USING ERRCODE = '22023';
  END IF;

  -- 取消は人の判断なので、実行者と理由を必ず残す（R-18）。「その他」はメモも要る（設計書 5-2）。
  IF _next_status = 'cancelled'::public.order_status
     AND (_actor_id IS NULL
          OR _cancel_reason IS NULL
          OR _cancel_reason NOT IN ('stock_unavailable', 'customer_request', 'suspected_fraud', 'other')) THEN
    RAISE EXCEPTION 'CANCEL_REQUIRES_ACTOR_AND_REASON' USING ERRCODE = '22023';
  END IF;

  IF _next_status = 'cancelled'::public.order_status
     AND _cancel_reason = 'other'
     AND NULLIF(pg_catalog.btrim(_cancel_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(_actor_id::text, ''), true);
  PERFORM pg_catalog.set_config('app.order_change_reason', _change_reason, true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = _next_status,
      cancel_reason = CASE
        WHEN _next_status = 'cancelled'::public.order_status THEN _cancel_reason ELSE o.cancel_reason
      END,
      cancel_note = CASE
        WHEN _next_status = 'cancelled'::public.order_status
          THEN NULLIF(pg_catalog.btrim(_cancel_note), '')
        ELSE o.cancel_note
      END,
      cancel_notify_customer = CASE
        WHEN _next_status = 'cancelled'::public.order_status THEN _notify_customer ELSE o.cancel_notify_customer
      END
  WHERE o.id = _order_id
    AND o.status = _expected_status
  RETURNING o.id INTO updated_id;

  IF updated_id IS NULL THEN
    RETURN QUERY SELECT false, _order_id, o.status FROM public.orders AS o WHERE o.id = _order_id;
    RETURN;
  END IF;

  -- バリアントを id 昇順でロックする（受付・入金済みにする処理と同じ順）。
  PERFORM 1
  FROM public.item_variants AS v
  WHERE v.id IN (
    SELECT r.variant_id
    FROM private.order_line_reservations(updated_id) AS r
    WHERE r.variant_id IS NOT NULL AND r.reserved > 0
  )
  ORDER BY v.id
  FOR UPDATE;

  -- 確保した分だけを戻す（R-41）。状態を条件に更新しているので、同じ注文で二度は走らない。
  INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, note, created_by)
  SELECT r.variant_id, r.reserved, 'cancel', updated_id, r.order_item_id, _change_reason, _actor_id
  FROM private.order_line_reservations(updated_id) AS r
  WHERE r.variant_id IS NOT NULL AND r.reserved > 0
  ORDER BY r.variant_id, r.order_item_id;

  RETURN QUERY SELECT true, updated_id, _next_status;
END;
$$;

REVOKE ALL ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) TO service_role;

COMMIT;
