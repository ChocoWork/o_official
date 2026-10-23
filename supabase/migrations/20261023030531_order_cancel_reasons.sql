-- J-06: Six cancellation reasons. Preserve existing codes and saved history.

BEGIN;

ALTER TABLE public.orders DROP CONSTRAINT orders_cancel_reason_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_cancel_reason_check CHECK (cancel_reason IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other'));

ALTER TABLE public.order_refunds DROP CONSTRAINT order_refunds_cancel_reason_value_check;
ALTER TABLE public.order_refunds ADD CONSTRAINT order_refunds_cancel_reason_value_check CHECK (cancel_reason IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other'));

-- Latest definition: 20260927100500_payment_exceptions.sql
CREATE OR REPLACE FUNCTION public.admin_cancel_failed_order(
  _order_id uuid,
  _actor_id uuid,
  _cancel_reason text,
  _note text DEFAULT NULL
)
RETURNS TABLE (id uuid, status public.order_status)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF _actor_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _cancel_reason IS NULL
     OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other') THEN
    RAISE EXCEPTION 'CANCEL_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _cancel_reason = 'other' AND NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'CANCEL_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_failed_order', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  RETURN QUERY
  UPDATE public.orders AS o
  SET status = 'cancelled'::public.order_status,
      cancel_reason = _cancel_reason,
      cancel_note = NULLIF(pg_catalog.btrim(_note), ''),
      cancel_notify_customer = false
  WHERE o.id = _order_id
    AND o.status = 'failed'::public.order_status
  RETURNING o.id, o.status;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_cancel_failed_order(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_cancel_failed_order(uuid, uuid, text, text) TO service_role;

-- Latest definition: 20261009095736_order_email_enqueue.sql
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
          OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other')) THEN
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

REVOKE ALL ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.release_stock_for_unpaid_order(
  uuid, public.order_status, public.order_status, text, uuid, text, text, text, boolean
) TO service_role;

-- Latest definition: 20261013001143_order_return_receipts.sql
CREATE OR REPLACE FUNCTION private.begin_order_refund_core(
  _order_id uuid,
  _source text,
  _request_key uuid,
  _lines jsonb,
  _restock boolean,
  _shipping_amount integer,
  _amount integer,
  _note text,
  _stripe_reason text,
  _cancel_reason text,
  _notify_customer boolean,
  _actor_id uuid,
  _received_amount integer,
  _return_id uuid,
  _return_fee_deduction integer
)
RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_is_admin boolean;
  v_is_auto boolean;
  v_is_cancel boolean;
  v_restock boolean;
  v_notify boolean;
  v_note text;
  v_stripe_reason text;
  v_cancel_reason text;
  v_actor uuid;
  v_fingerprint text;
  v_order public.orders;
  v_existing public.order_refunds;
  v_refundable integer;
  v_refundable_shipping integer;
  v_shipped_total integer;
  v_unshipped_total integer;
  v_resolved jsonb;
  v_included integer;
  v_shipping integer;
  v_amount integer;
  v_priced jsonb;
  v_lines_amount integer;
  v_refund_id uuid;
  v_constraint text;
BEGIN
  -- 1. 引数
  IF _order_id IS NULL
     OR _source IS NULL
     OR _source NOT IN ('admin', 'order_cancel', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'return')
     OR ((_source = 'return') IS DISTINCT FROM (_return_id IS NOT NULL))
     OR (_source = 'return' AND (_return_fee_deduction IS NULL OR _return_fee_deduction < 0))
     OR (_source <> 'return' AND _return_fee_deduction IS NOT NULL)
     OR _lines IS NULL
     OR _restock IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_is_admin := _source IN ('admin', 'return');
  v_is_auto := _source IN ('auto_cancelled_order_payment', 'auto_amount_mismatch');
  v_is_cancel := _source IN ('order_cancel', 'auto_amount_mismatch');

  -- 商品の行を渡してよいのはアだけ（イ・オは DB が残りの未発送を全部入れ、エは行なし）。ア・イには二重防止の番号と実行した人が要る
  IF (NOT v_is_admin AND pg_catalog.jsonb_array_length(_lines) > 0)
     OR (NOT v_is_auto AND (_request_key IS NULL OR _actor_id IS NULL))
     OR (_note IS NOT NULL AND pg_catalog.char_length(_note) > 500)
     OR (_stripe_reason IS NOT NULL AND _stripe_reason NOT IN ('requested_by_customer', 'duplicate', 'fraudulent')) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- アの送料と額は呼ぶ側が決める。「うち送料」が額を超える返金は作らない
  IF v_is_admin AND (
       _shipping_amount IS NULL OR _shipping_amount < 0
       OR _amount IS NULL OR _amount < 1
       OR _shipping_amount > _amount
       OR _cancel_reason IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- イの取消の理由は6つ。「その他」はメモも要る（未入金の取消の CANCEL_NOTE_REQUIRED と同じ決まり）
  IF _source = 'order_cancel' AND (
       _cancel_reason IS NULL
       OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other')
       OR (_cancel_reason = 'other' AND NULLIF(pg_catalog.btrim(_note), '') IS NULL)
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- 自動の返金（エ・オ）は、呼ぶ側の値を使わず DB が決める。知らせる・Stripe に理由を伝えない。
  -- オは在庫に戻し、取消の理由は other、メモは決まった文。実行した人は空
  v_restock := CASE WHEN _source = 'auto_amount_mismatch' THEN true ELSE _restock END;
  v_notify := CASE WHEN v_is_auto THEN true ELSE _notify_customer END;
  v_note := CASE _source
    WHEN 'auto_amount_mismatch' THEN '支払額の違いの自動の取消'
    WHEN 'auto_cancelled_order_payment' THEN NULL
    ELSE _note
  END;
  v_stripe_reason := CASE WHEN v_is_auto THEN NULL ELSE _stripe_reason END;
  v_cancel_reason := CASE _source
    WHEN 'order_cancel' THEN _cancel_reason
    WHEN 'auto_amount_mismatch' THEN 'other'
    ELSE NULL
  END;
  v_actor := CASE WHEN v_is_auto THEN NULL ELSE _actor_id END;

  -- 二重防止の指紋（本計画 P2）: 呼ぶ側が渡した入力を、渡されたままの値で決まった順に並べた JSON の md5。
  -- 行は商品の番号・発送前かの順に並べ替えるので、並びだけが違う送り直しは同じ中身。
  -- DB が決める値（イ・オの行、DB が使わない送料と額）は入れない。イ・オの行は渡された '[]' のまま
  IF _request_key IS NOT NULL THEN
    v_fingerprint := pg_catalog.md5(
      pg_catalog.jsonb_build_object(
        'order_id', _order_id,
        'source', _source,
        'lines', COALESCE((
          SELECT pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_object(
                     'order_item_id', p.order_item_id,
                     'before_shipment', p.before_shipment,
                     'quantity', p.quantity
                   )
                   ORDER BY p.order_item_id, p.before_shipment
                 )
          FROM private.parse_refund_lines(_lines) AS p
        ), '[]'::jsonb),
        'restock', _restock,
        'shipping_amount', _shipping_amount,
        'amount', _amount,
        'note', _note,
        'stripe_reason', _stripe_reason,
        'cancel_reason', _cancel_reason,
        'notify_customer', _notify_customer,
        'received_amount', _received_amount
      )::text
    );
  END IF;

  -- 2. 注文の行の鍵。返金・発送・仕上がり・発送の取消は、この鍵で1つずつ進む
  --    （同時に押されても、後の方は前の操作の後の数で確かめる。設計書 11-2）
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 返品の入力の指紋は、受け取りは追記済みの受け取り、単独の返金は入力そのものを使う。
  -- _received_amount は return の内部呼出しだけ、計算前の任意の額（NULLも含む）を保持する。
  IF _source = 'return' THEN
    PERFORM 1 FROM public.order_returns AS r WHERE r.id=_return_id AND r.order_id=_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    SELECT rr.request_fingerprint INTO v_fingerprint FROM public.order_return_receipts AS rr
    WHERE rr.request_key=_request_key AND rr.return_id=_return_id AND rr.kind='receive';
    IF NOT FOUND THEN
      v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'amount',_received_amount,
        'shipping_amount',_shipping_amount,'note',_note,'notify_customer',_notify_customer)::text);
    END IF;
  ELSE
    -- 普通の返金も返品のrwを覆うため、返金の行を書く前に、注文の次に受付中の返品をID順でロックする。
    PERFORM 1 FROM public.order_returns AS rt
    WHERE rt.order_id=_order_id AND rt.status='open' ORDER BY rt.id FOR UPDATE;
  END IF;

  -- 3. 同じ二重防止の番号の送り直し（通信が切れた後の「もう一度確かめる」）。同じ中身なら前の記録を返し、
  --    注文の状態や数が変わっていても確かめ直さない。中身が違えば断る
  IF _request_key IS NOT NULL THEN
    SELECT r.* INTO v_existing FROM public.order_refunds AS r WHERE r.request_key = _request_key;
    IF FOUND THEN
      IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION USING MESSAGE=CASE WHEN _source='return' THEN 'RETURN_REQUEST_MISMATCH' ELSE 'REFUND_REQUEST_MISMATCH' END, ERRCODE='22023';
      END IF;
      RETURN QUERY SELECT v_existing.id, v_existing.amount, v_existing.status, true;
      RETURN;
    END IF;
  END IF;

  -- 4. エは取り消した注文だけ。受け取った額が空なら、入金を見つけた額を注文に書く（空の時だけ。書いた額が全額になる）
  IF _source = 'auto_cancelled_order_payment' THEN
    IF v_order.status <> 'cancelled'::public.order_status THEN
      RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE = '22023';
    END IF;
    IF v_order.paid_amount IS NULL THEN
      IF _received_amount IS NULL OR _received_amount < 1 THEN
        RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      -- 前の取引の値が残らないように、操作した人と元の知らせの番号は空にする
      PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
      PERFORM pg_catalog.set_config('app.order_change_reason', 'record_cancelled_order_payment', true);
      PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);
      UPDATE public.orders AS o SET paid_amount = _received_amount WHERE o.id = _order_id;
      v_order.paid_amount := _received_amount;
    END IF;
  END IF;

  -- 5. 返金できる状態: 支払い済み・発送済み・取り消した注文で、受け取った額がある
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status, 'cancelled'::public.order_status)
     OR v_order.paid_amount IS NULL
     OR v_order.paid_amount < 1 THEN
    RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 6. 返事待ちの返金がある注文には、新しい返金を作れない（確かめ直しだけ。毎時の見回りが片付ける）
  IF EXISTS (
    SELECT 1
    FROM public.order_refunds AS r
    WHERE r.order_id = _order_id
      AND r.status = 'awaiting_response'
  ) THEN
    RAISE EXCEPTION 'AWAITING_REFUND_EXISTS' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.sum(l.shipped), 0)::integer, COALESCE(pg_catalog.sum(l.unshipped), 0)::integer
  INTO v_shipped_total, v_unshipped_total
  FROM private.order_line_fulfillment(_order_id) AS l;

  -- 7. キャンセルは、支払い済みで1つも発送していない注文だけ（Shopify も一部を発送した後はできない）
  IF v_is_cancel AND (v_order.status <> 'paid'::public.order_status OR v_shipped_total > 0) THEN
    RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
  END IF;

  -- 8. 返せる額 = 受け取った額 − 返事待ち・保留・成功の返金。0なら何も返せない
  SELECT a.refundable_amount, a.refundable_shipping INTO v_refundable, v_refundable_shipping
  FROM private.order_refund_amounts(_order_id) AS a;
  IF v_refundable IS NULL OR v_refundable < 1 THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 9. 商品の行。イ・オは残りの未発送を全部、発送前の行に入れる。エは行なし
  IF v_is_admin THEN
    v_resolved := _lines;
  ELSIF v_is_cancel THEN
    SELECT COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('order_item_id', l.order_item_id, 'before_shipment', true, 'quantity', l.unshipped)
               ORDER BY l.order_item_id
             ),
             '[]'::jsonb
           )
    INTO v_resolved
    FROM private.order_line_fulfillment(_order_id) AS l
    WHERE l.unshipped > 0;
  ELSE
    v_resolved := '[]'::jsonb;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.order_items AS oi WHERE oi.id = p.order_item_id AND oi.order_id = _order_id
    )
  ) THEN
    RAISE EXCEPTION 'REFUND_LINE_NOT_IN_ORDER' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = p.order_item_id
    WHERE p.before_shipment
      AND p.quantity > l.unshipped
  ) THEN
    RAISE EXCEPTION 'REFUND_QUANTITY_EXCEEDS_UNSHIPPED' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN private.order_line_return_counts(_order_id) AS l ON l.order_item_id = p.order_item_id
    WHERE NOT p.before_shipment AND _source <> 'return'
      AND p.quantity > l.refundable_after_shipment
  ) THEN
    RAISE EXCEPTION 'REFUND_QUANTITY_EXCEEDS_SHIPPED' USING ERRCODE = '22023';
  END IF;

  -- 返品の返金は、受け取った返金の品で覆われていない数まで。発送前には使わせない。
  IF _source='return' AND EXISTS (
    SELECT 1 FROM private.parse_refund_lines(v_resolved) AS p
    WHERE p.before_shipment OR p.quantity > COALESCE((
      SELECT pg_catalog.sum(g.refund_waiting)::integer
      FROM private.order_return_line_progress(_return_id) AS g
      JOIN public.order_return_lines AS rl ON rl.id=g.return_line_id
      WHERE rl.order_item_id=p.order_item_id
    ),0)
  ) THEN RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE='22023'; END IF;

  -- 10. 送料と額。アは呼ぶ側の値。イ・エ・オは返せる額の全部で、送料はイ・オだけ返せる送料の全部
  --     （手で額を減らした返金が前にあっても、「うち送料」が額を超えないようにする）
  IF v_is_admin THEN
    v_shipping := _shipping_amount;
    v_amount := _amount;
  ELSE
    v_amount := v_refundable;
    v_shipping := CASE
      WHEN _source = 'auto_cancelled_order_payment' THEN 0
      ELSE LEAST(v_refundable_shipping, v_refundable)
    END;
  END IF;
  IF v_shipping > v_refundable_shipping THEN
    RAISE EXCEPTION 'REFUND_SHIPPING_EXCEEDS' USING ERRCODE = '22023';
  END IF;
  IF v_amount > v_refundable THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- 11. 全額の時の決まり（アだけ。イ・オは上で残りを全部入れ、エは取り消した注文で確保が戻し済み）。
  --     全額になるのに未発送が残ると、取り消した注文に確保が残り続ける（R-16）ので断る。
  --     1つも発送していない注文で残りを全部返すのに、送料か額が全部でなければ、全額に届かずキャンセルにならない注文が残るので断る。
  --     全部の送料は min(返せる送料, 返せる額): 前の返金で額を手で増やして、返せる額が返せる送料より小さい注文でも、
  --     「送料 ≤ 額」を守ったまま残りを返せる（イ・オと同じ）。取り消した注文（取消の後の入金）でも同じ決まり（本計画 P28）
  IF v_is_admin THEN
    SELECT COALESCE(pg_catalog.sum(p.quantity) FILTER (WHERE p.before_shipment), 0)::integer INTO v_included
    FROM private.parse_refund_lines(v_resolved) AS p;

    IF v_amount = v_refundable AND v_unshipped_total - v_included > 0 THEN
      RAISE EXCEPTION 'REFUND_MUST_INCLUDE_UNSHIPPED' USING ERRCODE = '22023';
    END IF;
    IF v_shipped_total = 0
       AND v_included > 0
       AND v_unshipped_total - v_included = 0
       AND (v_shipping <> LEAST(v_refundable_shipping, v_refundable) OR v_amount <> v_refundable) THEN
      RAISE EXCEPTION 'REFUND_MUST_BE_FULL' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 12. 商品ごとの額（設計書 4-5）。今回の k 個の額 = 単価 × k − (disc(b + k) − disc(b))。b は前に返した数
  --     （その商品の発送前と発送後を合わせた、返事待ち・保留・成功の数）。同じ返金に同じ商品の発送前と発送後の行がある時は、
  --     発送前の行を先に数える: 発送前の行の b = 前に返した数、発送後の行の b = 前に返した数 + 発送前の行の数
  --     （窓関数の PARTITION BY 商品 ORDER BY before_shipment DESC。入力の並びには依らない）。商品どうしの割り振りは独立。
  --     在庫に戻すのは、発送前・在庫の品・チェックありの行だけ
  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'order_item_id', q.order_item_id,
               'before_shipment', q.before_shipment,
               'quantity', q.quantity,
               'restock_type', CASE
                 WHEN _source='return' THEN 'return'::text
                 WHEN q.before_shipment AND q.fulfillment_type = 'stock' AND v_restock THEN 'cancel'::text
                 ELSE 'no_restock'::text
               END,
               'amount', private.return_units_amount(q.order_item_id,q.quantity,q.earlier_in_refund)
             )
             ORDER BY q.order_item_id, q.before_shipment DESC
           ),
           '[]'::jsonb
         )
  INTO v_priced
  FROM (
    SELECT p.order_item_id,
           p.before_shipment,
           p.quantity,
           l.fulfillment_type,
           oi.item_price,
           oi.quantity AS ordered,
           d.line_discount,
           l.refunded_before_shipment + l.refunded_after_shipment AS already_refunded,
           COALESCE(pg_catalog.sum(p.quantity) OVER (
             PARTITION BY p.order_item_id
             ORDER BY p.before_shipment DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0)::integer AS earlier_in_refund
    FROM private.parse_refund_lines(v_resolved) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    JOIN private.order_line_fulfillment(_order_id) AS l ON l.order_item_id = p.order_item_id
    JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = p.order_item_id
  ) AS q;

  SELECT COALESCE(pg_catalog.sum(x.amount), 0)::integer INTO v_lines_amount
  FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid, before_shipment boolean, quantity integer, restock_type text, amount integer);

  -- 13. 記録。計算との差 = 返金額 − （行の額の合計 + 送料）。行の無い返金では返金額そのもの
  BEGIN
    INSERT INTO public.order_refunds AS r
      (id, return_id, order_id, source, request_key, request_fingerprint, status, amount, shipping_amount, adjustment_amount,
       note, stripe_reason, cancel_reason, notify_customer, actor_id, return_fee_deduction)
    VALUES
      (COALESCE((SELECT rr.refund_id FROM public.order_return_receipts AS rr WHERE rr.return_id=_return_id AND rr.request_key=_request_key),pg_catalog.gen_random_uuid()),
       _return_id, _order_id, _source, _request_key, v_fingerprint, 'awaiting_response', v_amount, v_shipping,
       v_amount - (v_lines_amount + v_shipping), v_note, v_stripe_reason, v_cancel_reason, v_notify, v_actor, COALESCE(_return_fee_deduction, 0))
    RETURNING r.id INTO v_refund_id;
  EXCEPTION WHEN unique_violation THEN
    -- 同じ番号をほかの注文の返金が同時に使った（同じ注文の送り直しは、鍵の後の確かめで前の記録を返している）
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_refunds_request_key_key' THEN
      RAISE EXCEPTION USING MESSAGE=CASE WHEN _source='return' THEN 'RETURN_REQUEST_MISMATCH' ELSE 'REFUND_REQUEST_MISMATCH' END, ERRCODE='22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
  SELECT v_refund_id, x.order_item_id, x.quantity, x.before_shipment, x.restock_type, x.amount
  FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid, before_shipment boolean, quantity integer, restock_type text, amount integer);

  IF _source <> 'return' THEN
    -- 返金の行が覆った後の数で完了を確かめ、返品が操作できない受付中のまま残るのを防ぐ。
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id=_order_id AND rt.status='open' ORDER BY rt.id;
  END IF;
  RETURN QUERY SELECT v_refund_id, v_amount, 'awaiting_response'::text, false;
END;
$$;

REVOKE ALL ON FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

COMMIT;
