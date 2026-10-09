-- 注文の状態を変える DB の関数が、同じ取引で「注文のメール」の行を書く（グループ D 設計書 3-1・7-3・7-4）。
-- 状態の変更を取り消せば行も残らない（transactional outbox）。アプリはメールを直接送らない。
-- 古い送信権（private.order_emails と claim_order_email・release_order_email）を消す。
-- 本番の古い送信権の行（移行前の未入金の注文の「送らない」印）は、取りやめ（legacy_suppressed）の行として移す（本計画 P9）。
-- 何度当てても同じ結果になるように書く。
BEGIN;

-- 1. 入金済みにする（グループ A 設計書 4-1。中身は今までと同じ）。
--    金額が合い、アプリが「お客様に送る」（全額返金済みでない）を渡した時だけ、注文確認の行を書く
DROP FUNCTION IF EXISTS public.mark_order_paid(uuid, public.order_status, text, integer, text, text);

CREATE OR REPLACE FUNCTION public.mark_order_paid(
  _order_id uuid,
  _expected_status public.order_status,
  _payment_intent_id text,
  _paid_amount integer,
  _paid_currency text,
  _notify_customer boolean,
  _paid_email_variant text,
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
     OR NULLIF(pg_catalog.btrim(_paid_currency), '') IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'MARK_PAID_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _paid_email_variant IS NULL
     OR _paid_email_variant NOT IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry') THEN
    RAISE EXCEPTION 'INVALID_PAID_EMAIL_VARIANT' USING ERRCODE = '22023';
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

  -- 金額が違う支払いは要対応にし、店が確かめてから連絡する（注文確認は送らない）
  IF matches AND _notify_customer THEN
    PERFORM private.enqueue_order_email(_order_id, 'paid', _paid_email_variant);
  END IF;

  RETURN QUERY SELECT true, matches, missing_reservation;
END;
$$;

-- 2. 入金待ちにする（中身は今までと同じ）。状態を変えたら入金待ちの行を書く
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

  PERFORM private.enqueue_order_email(_order_id, 'awaiting_payment', NULL);

  RETURN QUERY SELECT true;
END;
$$;

-- 3. 確保した分だけ在庫を戻す（グループ A 設計書 4-1・4-5・4-7。中身は今までと同じ）。
--    失敗にしたら期限切れの行、取消で「お客様に知らせる」なら取消の行（書き分けは取り消す前の状態）を書く。
--    要対応の「注文を取り消して解決」（resolve_payment_exception）もこの関数を通る
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

  IF _next_status = 'failed'::public.order_status THEN
    PERFORM private.enqueue_order_email(updated_id, 'payment_expired', NULL);
  ELSIF _next_status = 'cancelled'::public.order_status AND COALESCE(_notify_customer, false) THEN
    PERFORM private.enqueue_order_email(updated_id, 'canceled', _expected_status::text);
  END IF;

  RETURN QUERY SELECT true, updated_id, _next_status;
END;
$$;

-- 4. 発送（グループ A 設計書 5-2。中身は今までと同じ）。「お客様に発送のメールを送る」なら発送の行を書く（設計書 5-4）。
--    メールは worker が送るので、メールアドレスと氏名は返さない
DROP FUNCTION IF EXISTS public.admin_ship_paid_order(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.admin_ship_paid_order(
  _order_id uuid,
  _actor_id uuid,
  _shipping_carrier text,
  _tracking_number text,
  _notify_customer boolean
)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _notify_customer IS NULL THEN
    RAISE EXCEPTION 'NOTIFY_CUSTOMER_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _shipping_carrier IS NULL
     OR NOT (_shipping_carrier = ANY (ARRAY['yamato', 'sagawa', 'japanpost'])) THEN
    RAISE EXCEPTION 'INVALID_SHIPPING_CARRIER' USING ERRCODE = '22023';
  END IF;

  IF _tracking_number IS NULL
     OR _tracking_number !~ '^[0-9A-Za-z-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_TRACKING_NUMBER' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_ship_paid_order', true);

  UPDATE public.orders AS o
  SET status = 'shipped'::public.order_status,
      shipped_at = pg_catalog.now(),
      shipping_carrier = _shipping_carrier,
      tracking_number = _tracking_number
  WHERE o.id = _order_id
    AND o.status = 'paid'::public.order_status
    AND o.shipped_at IS NULL
    AND private.order_has_required_shipping_fields(o)
    AND NOT EXISTS (
      SELECT 1
      FROM public.payment_exceptions AS e
      WHERE e.order_id = o.id
        AND e.reason = 'paid_amount_mismatch'
        AND e.resolved_at IS NULL
    )
  RETURNING o.id INTO v_order_id;

  IF v_order_id IS NULL THEN
    RETURN;
  END IF;

  IF _notify_customer THEN
    PERFORM private.enqueue_order_email(v_order_id, 'shipped', NULL);
  END IF;

  RETURN QUERY SELECT v_order_id;
END;
$$;

-- 5. 古い送信権の行を、取りやめの行として移す（本計画 P9）。移した注文・種類には、自動の行がもう書かれない
DO $$
BEGIN
  IF pg_catalog.to_regclass('private.order_emails') IS NOT NULL THEN
    INSERT INTO private.order_email_outbox (order_id, kind, variant, origin, status, last_error_code, finished_at)
    SELECT c.order_id,
           c.kind,
           CASE c.kind WHEN 'paid' THEN 'order_confirmed' WHEN 'canceled' THEN 'pending' END,
           'auto',
           'skipped',
           'legacy_suppressed',
           pg_catalog.now()
    FROM private.order_emails AS c
    ON CONFLICT (order_id, kind) WHERE origin = 'auto' DO NOTHING;
  END IF;
END
$$;

-- 6. 古い送信権を消す（設計書 7-4）
DROP FUNCTION IF EXISTS public.claim_order_email(uuid, text);
DROP FUNCTION IF EXISTS public.release_order_email(uuid, text);
DROP FUNCTION IF EXISTS private.suppress_legacy_unpaid_order_emails();
DROP TABLE IF EXISTS private.order_emails;

-- 7. 権限
REVOKE ALL ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_order_awaiting_payment(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid, public.order_status, text, integer, text, boolean, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_awaiting_payment(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_ship_paid_order(uuid, uuid, text, text, boolean) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
