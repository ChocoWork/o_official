BEGIN;

-- 承認では商品の数とご希望を変えず、解決の3列だけを親が requested の間に直す。
CREATE OR REPLACE FUNCTION public.admin_approve_return(
  _return_id uuid, _actor_id uuid, _lines jsonb, _return_method text,
  _return_shipping_payer text, _return_carrier text, _return_tracking_number text,
  _return_shipping_fee integer, _restocking_fee_percent integer, _exchange_fee integer,
  _exchange_shipping_fee integer, _shop_note text, _notify_customer boolean
) RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_j jsonb; v_id uuid; v_variant bigint; v_seen uuid[] := ARRAY[]::uuid[];
  v_lines jsonb := '[]'::jsonb;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _notify_customer IS NULL
    OR _return_method IS NULL OR _return_method NOT IN ('customer_ships', 'shop_label', 'not_required')
    OR _return_shipping_payer IS NULL OR _return_shipping_payer NOT IN ('shop', 'customer')
    OR (_return_carrier IS NOT NULL AND _return_carrier NOT IN ('yamato', 'sagawa', 'japanpost', 'other'))
    OR (_return_tracking_number IS NOT NULL AND _return_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
    OR (_return_method = 'not_required' AND (_return_carrier IS NOT NULL OR _return_tracking_number IS NOT NULL))
    OR pg_catalog.char_length(_shop_note) > 500 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- 設定からの補完はしない。承認で決めた額が必ず送られていることを DB でも守る。
  IF _return_shipping_fee IS NULL OR _return_shipping_fee NOT BETWEEN 0 AND 1000000
    OR _restocking_fee_percent IS NULL OR _restocking_fee_percent NOT BETWEEN 0 AND 100
    OR _exchange_fee IS NULL OR _exchange_fee NOT BETWEEN 0 AND 1000000
    OR _exchange_shipping_fee IS NULL OR _exchange_shipping_fee NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'RETURN_FEE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_lines) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_j->>'resolution', '') NOT IN ('refund', 'exchange')
      OR NOT (v_j ?& ARRAY['return_line_id','resolution','exchange_variant_id','exchange_method']) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_id := (v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    IF v_id = ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_id;
    v_variant := NULL;
    IF v_j->>'resolution' = 'refund' THEN
      IF v_j->>'exchange_variant_id' IS NOT NULL OR v_j->>'exchange_method' IS NOT NULL THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
    ELSE
      IF pg_catalog.jsonb_typeof(v_j->'exchange_variant_id') IS DISTINCT FROM 'number'
        OR (v_j->>'exchange_variant_id') !~ '^-?[0-9]{1,18}$'
        OR COALESCE(v_j->>'exchange_method','') NOT IN ('stock','make') THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_variant := (v_j->>'exchange_variant_id')::bigint;
    END IF;
    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'return_line_id',v_id,'resolution',v_j->>'resolution',
      'exchange_variant_id',v_variant,'exchange_method',v_j->>'exchange_method'));
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.id = _return_id) AND (
    pg_catalog.cardinality(v_seen) <> (SELECT pg_catalog.count(*) FROM public.order_return_lines AS l WHERE l.return_id = _return_id)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_seen) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.order_return_lines AS l WHERE l.return_id = _return_id AND l.id = x.id))
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023'; END IF;
  v_return := private.lock_order_return(_return_id);
  IF v_return.status <> 'requested' THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF NOT private.shop_return_address_set() THEN
    RAISE EXCEPTION 'RETURN_ADDRESS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF _return_method = 'not_required' AND NOT (
    SELECT s.no_return_needed_enabled FROM public.shop_return_settings AS s WHERE s.id = 1
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023'; END IF;
  -- 注文の鍵を取った後にも全行を確かめ、並行した追記を一部承認にしない。
  IF pg_catalog.cardinality(v_seen) <> (SELECT pg_catalog.count(*) FROM public.order_return_lines AS l WHERE l.return_id = _return_id)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_seen) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.order_return_lines AS l WHERE l.return_id = _return_id AND l.id = x.id)) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(return_line_id uuid,resolution text,exchange_variant_id bigint)
    JOIN public.order_return_lines AS l ON l.id = x.return_line_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    WHERE x.resolution = 'exchange' AND NOT EXISTS (
      SELECT 1 FROM public.item_variants AS v WHERE v.id = x.exchange_variant_id AND v.item_id = oi.item_id AND v.is_active
    )
  ) THEN RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023'; END IF;
  UPDATE public.order_return_lines AS l
  SET resolution = x.resolution, exchange_variant_id = x.exchange_variant_id, exchange_method = x.exchange_method
  FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(return_line_id uuid,resolution text,exchange_variant_id bigint,exchange_method text)
  WHERE l.id = x.return_line_id AND l.return_id = _return_id;
  UPDATE public.order_returns AS r
  SET status = 'open', approved_at = pg_catalog.now(), approved_by = _actor_id,
      return_method = _return_method, return_shipping_payer = _return_shipping_payer,
      return_carrier = _return_carrier, return_tracking_number = _return_tracking_number,
      return_shipping_fee = CASE WHEN _return_method = 'shop_label' AND _return_shipping_payer = 'customer'
        THEN _return_shipping_fee ELSE 0 END,
      restocking_fee_percent = _restocking_fee_percent, exchange_fee = _exchange_fee,
      exchange_shipping_fee = _exchange_shipping_fee, shop_note = NULLIF(pg_catalog.btrim(_shop_note), ''),
      notify_customer = _notify_customer
  WHERE r.id = _return_id;
  IF _notify_customer THEN
    PERFORM private.enqueue_return_email(v_return.order_id, 'return_accepted', _return_id, NULL);
  END IF;
  RETURN QUERY SELECT _return_id, 'open'::text;
END;
$$;

-- お断りのメッセージは必ずお客様に届くため、受付の通知の設定は参照しない。
CREATE OR REPLACE FUNCTION public.admin_decline_return(
  _return_id uuid, _actor_id uuid, _decline_reason text, _decline_message text
) RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_return public.order_returns; v_message text := NULLIF(pg_catalog.btrim(_decline_message), '');
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _decline_reason IS NULL
    OR _decline_reason NOT IN ('window_passed','final_sale','other') THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_message IS NULL OR pg_catalog.char_length(v_message) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'RETURN_DECLINE_MESSAGE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  v_return := private.lock_order_return(_return_id);
  IF v_return.status <> 'requested' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023'; END IF;
  UPDATE public.order_returns AS r SET status='declined',declined_at=pg_catalog.now(),declined_by=_actor_id,
    decline_reason=_decline_reason,decline_message=v_message WHERE r.id=_return_id;
  PERFORM private.enqueue_return_email(v_return.order_id,'return_declined',_return_id,NULL);
  RETURN QUERY SELECT _return_id,'declined'::text;
END;
$$;

-- 既存の金額・進み具合の計算を変えないため、管理画面の中身は段2のキーだけを追加する。
CREATE OR REPLACE FUNCTION private.return_detail_json(_return_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_display_status text;
  v_marks text[];
  v_created_by_email text;
  v_lines jsonb;
  v_refunds jsonb;
  v_receipts jsonb;
  v_exchange_items jsonb;
  v_first_receipt boolean;
  v_first_exchange boolean;
BEGIN
  SELECT r.* INTO v_return FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT s.display_status, s.marks INTO v_display_status, v_marks
  FROM private.return_display_state(_return_id) AS s;

  SELECT u.email::text INTO v_created_by_email FROM auth.users AS u WHERE u.id = v_return.created_by;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', y.id,
               'fulfillment_id', y.fulfillment_id,
               'fulfillment_number', y.fulfillment_number,
               'order_item_id', y.order_item_id,
               'item_name', y.item_name,
               'color', y.color,
               'size', y.size,
               'quantity', y.quantity,
               'reason', y.reason,
               'reason_note', y.reason_note,
               'customer_note', (SELECT l.customer_note FROM public.order_return_lines AS l WHERE l.id = y.id),
               'requested_resolution', (SELECT l.requested_resolution FROM public.order_return_lines AS l WHERE l.id = y.id),
               'requested_exchange', (
                 SELECT pg_catalog.jsonb_build_object('variant_id', v.id, 'color', c.name, 'size', s.label)
                 FROM public.order_return_lines AS l
                 JOIN public.item_variants AS v ON v.id = l.requested_exchange_variant_id
                 LEFT JOIN public.item_colors AS c ON c.id = v.color_id
                 LEFT JOIN public.item_sizes AS s ON s.id = v.size_id
                 WHERE l.id = y.id
               ),
               'photos', COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.id, 'purged', p.purged_at IS NOT NULL)
                   ORDER BY p.created_at, p.id)
                 FROM public.order_return_photos AS p WHERE p.return_line_id = y.id
               ), '[]'::jsonb),
               'return_ineligible', COALESCE((
                 SELECT i.return_ineligible FROM public.order_return_lines AS l
                 JOIN public.order_items AS oi ON oi.id = l.order_item_id
                 LEFT JOIN public.items AS i ON i.id = oi.item_id WHERE l.id = y.id
               ), false),
               'resolution', y.resolution,
               'exchange', CASE
                 WHEN y.resolution = 'exchange' THEN pg_catalog.jsonb_build_object(
                   'variant_id', y.exchange_variant_id,
                   'color', y.exchange_color,
                   'size', y.exchange_size,
                   'method', y.exchange_method,
                   'stock_quantity', y.exchange_stock,
                   'made_to_order_lead_days', y.exchange_lead_days,
                   'out_of_stock_exchange', y.out_of_stock_exchange
                 )
               END,
               'progress', pg_catalog.jsonb_build_object(
                 'restocked', y.restocked,
                 'not_restocked', y.not_restocked,
                 'pending_inspection', y.pending_inspection,
                 'sent_back', y.sent_back,
                 'missing', y.missing,
                 'processed', y.processed,
                 'unprocessed', y.unprocessed,
                 'exchanged', y.exchanged,
                 'refund_covered', y.refund_covered,
                 'refund_waived', y.refund_waived,
                 'refund_waiting', y.refund_waiting
               ),
               'refund_amounts_by_count', CASE
                 WHEN v_return.status = 'open' THEN ARRAY(
                   SELECT private.return_refund_amount(
                            y.line_kind, y.item_price, y.ordered, y.line_discount, y.exchange_paid_amount,
                            y.already_refunded, g.k
                          )
                   FROM pg_catalog.generate_series(1, y.item_unprocessed) AS g(k)
                   ORDER BY g.k
                 )
                 ELSE ARRAY[]::integer[]
               END,
               'refund_waiting_amount', private.return_refund_amount(
                 y.line_kind, y.item_price, y.ordered, y.line_discount, y.exchange_paid_amount,
                 y.already_refunded + y.earlier_waiting, y.refund_waiting
               )
             )
             ORDER BY y.fulfillment_number, y.item_created_at, y.order_item_id, y.resolution, y.id
           ),
           '[]'::jsonb
         )
  INTO v_lines
  FROM (
    SELECT l.id,
           l.fulfillment_id,
           l.order_item_id,
           l.quantity,
           l.reason,
           l.reason_note,
           l.resolution,
           l.exchange_variant_id,
           l.exchange_method,
           f.number AS fulfillment_number,
           oi.item_name,
           oi.color,
           oi.size,
           oi.line_kind,
           oi.item_price,
           oi.exchange_paid_amount,
           oi.quantity AS ordered,
           oi.created_at AS item_created_at,
           COALESCE(d.line_discount, 0) AS line_discount,
           COALESCE(lf.refunded_before_shipment, 0) + COALESCE(lf.refunded_after_shipment, 0) AS already_refunded,
           p.restocked,
           p.not_restocked,
           p.pending_inspection,
           p.sent_back,
           p.missing,
           p.processed,
           p.unprocessed,
           p.exchanged,
           p.refund_covered,
           p.refund_waived,
           p.refund_waiting,
           COALESCE(
             pg_catalog.sum(p.refund_waiting) OVER (
               PARTITION BY l.order_item_id
               ORDER BY l.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ),
             0
           )::integer AS earlier_waiting,
           -- この返品で同じ注文の商品を指す行の未処理の合計（refund_amounts_by_count の長さ。同じ商品の行は同じ列。共通の約束 C-2）
           (pg_catalog.sum(p.unprocessed) OVER (PARTITION BY l.order_item_id))::integer AS item_unprocessed,
           ec.name AS exchange_color,
           es.label AS exchange_size,
           ev.stock_quantity AS exchange_stock,
           ei.made_to_order_lead_days AS exchange_lead_days,
           rs.out_of_stock_exchange
    FROM public.order_return_lines AS l
    JOIN public.order_fulfillments AS f ON f.id = l.fulfillment_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id = l.id
    LEFT JOIN private.order_line_discounts(v_return.order_id) AS d ON d.order_item_id = l.order_item_id
    LEFT JOIN private.order_line_fulfillment(v_return.order_id) AS lf ON lf.order_item_id = l.order_item_id
    LEFT JOIN public.item_variants AS ev ON ev.id = l.exchange_variant_id
    LEFT JOIN public.item_colors AS ec ON ec.id = ev.color_id
    LEFT JOIN public.item_sizes AS es ON es.id = ev.size_id
    LEFT JOIN public.items AS ei ON ei.id = ev.item_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason = l.reason
    WHERE l.return_id = _return_id
  ) AS y;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', rf.id,
               'amount', rf.amount,
               'status', rf.status,
               'created_at', rf.created_at
             )
             ORDER BY rf.created_at DESC, rf.id DESC
           ),
           '[]'::jsonb
         )
  INTO v_refunds
  FROM public.order_refunds AS rf
  WHERE rf.return_id = _return_id;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', c.id,
               'kind', c.kind,
               'refund_choice', c.refund_choice,
               'created_at', c.created_at,
               'actor_email', u.email::text
             )
             ORDER BY c.created_at DESC, c.id DESC
           ),
           '[]'::jsonb
         )
  INTO v_receipts
  FROM public.order_return_receipts AS c
  LEFT JOIN auth.users AS u ON u.id = c.actor_id
  WHERE c.return_id = _return_id;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'order_item_id', oi.id,
               'item_name', oi.item_name,
               'color', oi.color,
               'size', oi.size,
               'quantity', oi.quantity,
               'fulfillment_type', oi.fulfillment_type,
               'shipped', lf.shipped
             )
             ORDER BY oi.created_at, oi.id
           ),
           '[]'::jsonb
         )
  INTO v_exchange_items
  FROM public.order_items AS oi
  JOIN public.order_return_lines AS l ON l.id = oi.exchange_return_line_id AND l.return_id = _return_id
  JOIN private.order_line_fulfillment(v_return.order_id) AS lf ON lf.order_item_id = oi.id;

  -- 返送料は「返金の品か交換の品を受け取った最初の受け取り」で1回、交換の手数料と送料は「交換の品を受け取った最初の受け取り」で1回付く。
  -- 受け取り（receive）で検品待ち・戻した・戻さないにした品が1点でもあれば、その最初の受け取りは済んでいる（お返しだけの受け取りは数えない）。
  -- 交換かどうかは、返品の行の予定ではなく、受け取りの行に残した実際の解決（resolution）で見る（返品の行は作った後に変えない）
  SELECT EXISTS (
           SELECT 1
           FROM public.order_return_receipts AS c
           JOIN public.order_return_receipt_lines AS rl ON rl.receipt_id = c.id
           WHERE c.return_id = _return_id
             AND c.kind = 'receive'
             AND rl.disposition IN ('restocked', 'not_restocked', 'pending_inspection')
         ),
         EXISTS (
           SELECT 1
           FROM public.order_return_receipts AS c
           JOIN public.order_return_receipt_lines AS rl ON rl.receipt_id = c.id
           WHERE c.return_id = _return_id
             AND c.kind = 'receive'
             AND rl.disposition IN ('restocked', 'not_restocked', 'pending_inspection')
             AND rl.resolution = 'exchange'
         )
  INTO v_first_receipt, v_first_exchange;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_return.id,
    'number', v_return.number,
    'status', v_return.status,
    'source', v_return.source,
    'requested_at', v_return.requested_at,
    'approved_at', v_return.approved_at,
    'approved_by_email', (SELECT u.email::text FROM auth.users AS u WHERE u.id = v_return.approved_by),
    'declined_at', v_return.declined_at,
    'decline_reason', v_return.decline_reason,
    'decline_message', v_return.decline_message,
    'display_status', v_display_status,
    'marks', pg_catalog.to_jsonb(COALESCE(v_marks, ARRAY[]::text[])),
    'return_method', v_return.return_method,
    'return_shipping_payer', v_return.return_shipping_payer,
    'return_carrier', v_return.return_carrier,
    'return_tracking_number', v_return.return_tracking_number,
    'fees', pg_catalog.jsonb_build_object(
      'return_shipping_fee', v_return.return_shipping_fee,
      'restocking_fee_percent', v_return.restocking_fee_percent,
      'exchange_fee', v_return.exchange_fee,
      'exchange_shipping_fee', v_return.exchange_shipping_fee,
      'fee_due_amount', v_return.fee_due_amount,
      'fee_pending_deduction', v_return.fee_pending_deduction,
      'fee_received_at', v_return.fee_received_at,
      'exchange_released_at', v_return.exchange_released_at
    ),
    'first_receipt_done', v_first_receipt,
    'first_exchange_receipt_done', v_first_exchange,
    'shop_note', v_return.shop_note,
    'notify_customer', v_return.notify_customer,
    'created_at', v_return.created_at,
    'created_by_email', v_created_by_email,
    'closed_at', v_return.closed_at,
    'cancelled_at', v_return.cancelled_at,
    'lines', v_lines,
    'refunds', v_refunds,
    'receipts', v_receipts,
    'exchange_items', v_exchange_items
  );
END;
$$;

-- 材料の既存の対象と順序は保持し、返品不可の警告だけを加える。
CREATE OR REPLACE FUNCTION public.get_order_return_materials(_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH shipped AS (
    SELECT fr.fulfillment_id,
           fr.fulfillment_number,
           fr.shipped_at,
           fr.deadline_date,
           fr.order_item_id,
           fr.quantity,
           LEAST(fr.returnable, COALESCE(c.returnable, 0)) AS returnable,
           oi.item_id,
           oi.variant_id,
           oi.item_name,
           oi.color,
           oi.size,
           oi.line_kind,
           oi.created_at AS item_created_at
    FROM private.fulfillment_line_returnable(_order_id) AS fr
    JOIN public.order_fulfillments AS f ON f.id = fr.fulfillment_id AND f.cancelled_at IS NULL
    JOIN public.order_items AS oi ON oi.id = fr.order_item_id
    LEFT JOIN private.order_line_return_counts(_order_id) AS c ON c.order_item_id = fr.order_item_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'order', pg_catalog.jsonb_build_object(
      'id', o.id,
      'status', o.status,
      'has_awaiting_refund', EXISTS (
        SELECT 1
        FROM public.order_refunds AS rf
        WHERE rf.order_id = o.id
          AND rf.status = 'awaiting_response'
      )
    ),
    'shipments', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'fulfillment_id', g.fulfillment_id,
                 'number', g.fulfillment_number,
                 'shipped_at', g.shipped_at,
                 'deadline_date', g.deadline_date,
                 'past_deadline', g.deadline_date IS NOT NULL
                   AND g.deadline_date < (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date,
                 'lines', (
                   SELECT pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'order_item_id', s.order_item_id,
                              'item_id', s.item_id,
                              'variant_id', s.variant_id,
                              'item_name', s.item_name,
                              'color', s.color,
                              'size', s.size,
                              'line_kind', s.line_kind,
                              'quantity', s.quantity,
                              'returnable', s.returnable,
                              'return_ineligible', COALESCE((SELECT i.return_ineligible FROM public.items AS i WHERE i.id = s.item_id), false)
                            )
                            ORDER BY s.item_created_at, s.order_item_id
                          )
                   FROM shipped AS s
                   WHERE s.fulfillment_id = g.fulfillment_id
                 )
               )
               ORDER BY g.fulfillment_number
             )
      FROM (
        SELECT s.fulfillment_id,
               s.fulfillment_number,
               s.shipped_at,
               pg_catalog.max(s.deadline_date) AS deadline_date
        FROM shipped AS s
        GROUP BY s.fulfillment_id, s.fulfillment_number, s.shipped_at
      ) AS g
    ), '[]'::jsonb),
    'exchange_options', COALESCE((
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'item_id', i.item_id,
                 'variants', (
                   SELECT COALESCE(
                            pg_catalog.jsonb_agg(
                              pg_catalog.jsonb_build_object(
                                'variant_id', v.id,
                                'color', col.name,
                                'size', sz.label,
                                'is_active', v.is_active,
                                'stock_quantity', v.stock_quantity,
                                'made_to_order_lead_days', it.made_to_order_lead_days
                              )
                              ORDER BY col.position NULLS FIRST, sz.position NULLS FIRST, v.id
                            ),
                            '[]'::jsonb
                          )
                   FROM public.item_variants AS v
                   JOIN public.items AS it ON it.id = v.item_id
                   LEFT JOIN public.item_colors AS col ON col.id = v.color_id
                   LEFT JOIN public.item_sizes AS sz ON sz.id = v.size_id
                   WHERE v.item_id = i.item_id
                 )
               )
               ORDER BY i.item_id
             )
      FROM (SELECT DISTINCT s.item_id FROM shipped AS s) AS i
    ), '[]'::jsonb),
    'settings', (
      SELECT pg_catalog.jsonb_build_object(
               'return_address_set', private.shop_return_address_set(),
               'no_return_needed_enabled', st.no_return_needed_enabled,
               'customer_paid_method', st.customer_paid_method,
               'shop_label_fee', st.shop_label_fee,
               'restocking_fee_enabled', st.restocking_fee_enabled,
               'restocking_fee_percent', st.restocking_fee_percent,
               'exchange_fees_enabled', st.exchange_fees_enabled,
               'exchange_fee', st.exchange_fee,
               'exchange_shipping_fee', st.exchange_shipping_fee,
               'reason_shipping_payers', (
                 SELECT pg_catalog.jsonb_object_agg(rs.reason, rs.shipping_payer)
                 FROM public.shop_return_reason_settings AS rs
               ),
               'reason_out_of_stock_exchange', (
                 SELECT pg_catalog.jsonb_object_agg(rs.reason, rs.out_of_stock_exchange)
                 FROM public.shop_return_reason_settings AS rs
               )
             )
      FROM public.shop_return_settings AS st
      WHERE st.id = 1
    )
  )
  FROM public.orders AS o
  WHERE o.id = _order_id
$$;

-- 写真が消えた後も一覧に残し、画面が期限による削除を区別できるようにする。
CREATE OR REPLACE FUNCTION public.list_return_photos(_return_id uuid)
RETURNS TABLE (photo_id uuid, return_line_id uuid, storage_path text, purged boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.id, l.id, p.storage_path, p.purged_at IS NOT NULL
  FROM public.order_return_lines AS l
  JOIN public.order_return_photos AS p ON p.return_line_id = l.id
  WHERE l.return_id = _return_id
  ORDER BY l.created_at, l.id, p.created_at, p.id
$$;

-- P9 の3か所以外は段1の本文を保持する。返金の本体で失敗すれば受け取りと在庫も同じ取引で戻る。
CREATE OR REPLACE FUNCTION public.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_order uuid; v_return public.order_returns%ROWTYPE; v_old public.order_return_receipts%ROWTYPE;
  v_units jsonb; v_effective jsonb; v_overrides jsonb; v_fp text; v_j jsonb; v_id uuid; v_n integer; v_seen text[]:=ARRAY[]::text[];
  v_receipt uuid:=pg_catalog.gen_random_uuid(); v_refund uuid; v_amount integer; v_status text; v_choice text;
  v_lines jsonb:='[]'::jsonb; v_goods integer:=0; v_exchange integer:=0; v_sent integer:=0;
  v_fees integer:=0; v_due integer:=0; v_pending integer:=0; v_shop boolean:=false;
  v_first_goods boolean; v_first_exchange boolean; v_line record; v_action text; v_available integer;
  v_exchange_ids uuid[]:=ARRAY[]::uuid[]; v_item uuid; v_offset integer; v_paid integer; v_waived boolean:=false;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _actor_can_refund IS NULL OR _request_key IS NULL
    OR _notify_customer IS NULL OR _refund_choice IS NULL OR _refund_choice NOT IN ('now','consult','none')
    OR _refund_shipping_amount IS NULL OR _refund_shipping_amount<0
    OR (_refund_amount IS NOT NULL AND _refund_amount<0) OR pg_catalog.char_length(_note)>500
    OR pg_catalog.char_length(_sent_back_message)>1000
    OR (_sent_back_carrier IS NOT NULL AND _sent_back_carrier NOT IN ('yamato','sagawa','japanpost','other'))
    OR (_sent_back_tracking_number IS NOT NULL AND _sent_back_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
    OR pg_catalog.jsonb_typeof(_units) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(_exchange_overrides) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_units) NOT BETWEEN 1 AND 100
    OR pg_catalog.jsonb_array_length(_exchange_overrides)>100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF NOT _actor_can_refund AND (_refund_amount IS NOT NULL
      OR _refund_shipping_amount<>0 OR pg_catalog.jsonb_array_length(_exchange_overrides)>0) THEN
    RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023';
  END IF;
  IF _refund_choice<>'now' AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_units) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_j->'quantity') IS DISTINCT FROM 'number'
      OR (v_j->>'quantity') !~ '^[1-9][0-9]{0,2}$'
      OR COALESCE(v_j->>'disposition','') NOT IN ('restocked','not_restocked','pending_inspection','sent_back') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF (v_id::text||':'||(v_j->>'disposition'))=ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||(v_id::text||':'||(v_j->>'disposition'));
  END LOOP;
  v_seen:=ARRAY[]::text[];
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_exchange_overrides) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_j->>'action','') NOT IN ('make','refund') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF v_id::text=ANY(v_seen) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||v_id::text;
  END LOOP;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'disposition',x.disposition,'quantity',x.quantity)
    ORDER BY x.return_line_id,x.disposition) INTO v_units
  FROM pg_catalog.jsonb_to_recordset(_units) AS x(return_line_id uuid,disposition text,quantity integer);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'action',x.action)
    ORDER BY x.return_line_id),'[]'::jsonb) INTO v_overrides
  FROM pg_catalog.jsonb_to_recordset(_exchange_overrides) AS x(return_line_id uuid,action text);
  v_fp:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'units',v_units,'exchange_overrides',v_overrides,
    'refund_choice',_refund_choice,'refund_amount',_refund_amount,'refund_shipping_amount',_refund_shipping_amount,
    'note',_note,'notify_customer',_notify_customer,'sent_back_message',_sent_back_message,
    'sent_back_carrier',_sent_back_carrier,'sent_back_tracking_number',_sent_back_tracking_number,
    'actor_can_refund',_actor_can_refund)::text);
  -- 鍵は注文 → 返品（Task 2 の部品。返品が無ければ RETURN_NOT_FOUND）
  v_return:=private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT rr.* INTO v_old FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id<>_return_id OR v_old.kind<>'receive' OR v_old.request_fingerprint<>v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    -- 交換の行の番号は受け取りと返品の行から決まるので、再送で新しい行を作る必要がない。
    RETURN QUERY SELECT v_old.id,v_return.status,r.id,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 0 ELSE r.amount END,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 'waived' ELSE r.status END,
      COALESCE((SELECT pg_catalog.array_agg(DISTINCT oi.id ORDER BY oi.id) FROM public.order_return_receipt_lines AS u
        JOIN public.order_items AS oi ON oi.id=private.return_exchange_item_id(v_old.id,u.return_line_id,u.exchange_method)
        WHERE u.receipt_id=v_old.id),ARRAY[]::uuid[]),v_return.fee_due_amount,
      EXISTS(SELECT 1 FROM private.order_email_outbox AS e WHERE e.return_receipt_id=v_old.id AND e.kind='return_refund_pending_shop'),true
    FROM (SELECT 1) AS singleton LEFT JOIN public.order_refunds AS r ON r.id=v_old.refund_id;
    RETURN;
  END IF;
  IF NOT _actor_can_refund AND _refund_choice='now' AND NOT (v_return.source='customer_request' AND v_return.return_method<>'not_required') THEN RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023'; END IF;
  IF v_return.status<>'open' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,quantity integer)
    WHERE NOT EXISTS(SELECT 1 FROM public.order_return_lines AS l WHERE l.id=x.return_line_id AND l.return_id=_return_id)) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,quantity integer)
    JOIN private.order_return_line_progress(_return_id) AS g ON g.return_line_id=x.return_line_id
    GROUP BY x.return_line_id,g.unprocessed HAVING pg_catalog.sum(x.quantity)>g.unprocessed) THEN
    RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(pg_catalog.sum(x.quantity),0)::integer INTO v_sent
  FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text,quantity integer) WHERE x.disposition='sent_back';
  IF v_sent>0 AND NULLIF(pg_catalog.btrim(_sent_back_message),'') IS NULL THEN
    RAISE EXCEPTION 'RETURN_SENT_BACK_MESSAGE_REQUIRED' USING ERRCODE='22023'; END IF;
  -- お返しのメッセージは必ず届ける（仕様書 6-1・9-1）
  IF v_sent>0 AND NOT _notify_customer THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;

  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text) WHERE x.disposition='pending_inspection')
    AND NOT (SELECT s.inspection_enabled FROM public.shop_return_settings AS s WHERE s.id=1) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- 既存の返金の鍵を先に取り、在庫の鍵を取ってから返金の鍵を待つ逆順を作らない。
  PERFORM 1 FROM public.order_refunds AS r WHERE r.order_id=v_order ORDER BY r.id FOR UPDATE;
  PERFORM 1 FROM public.item_variants AS v WHERE v.id IN (
    SELECT oi.variant_id FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
    UNION SELECT l.exchange_variant_id FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
  ) ORDER BY v.id FOR UPDATE;
  -- 上書きの形（C-1）: この返品の、交換（在庫から）の予定の行で、今回受け取る点（お返しでない）がある行だけ。
  -- 理由の設定が decline の行は make・refund、make の行は refund だけ（何も送らなければ自動で作って送る。仕様書 6-5）。
  -- 在庫不足の行かどうかは、下の割り当ての中で確かめる（在庫が足りる行への上書きは RETURN_ARGUMENT_INVALID）
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text)
    LEFT JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason=l.reason
    WHERE l.return_id IS DISTINCT FROM _return_id OR l.resolution IS DISTINCT FROM 'exchange'
      OR l.exchange_method IS DISTINCT FROM 'stock' OR rs.out_of_stock_exchange IS NULL
      OR (rs.out_of_stock_exchange='make' AND x.action<>'refund')
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
        WHERE u.return_line_id=l.id AND u.disposition<>'sent_back')) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- 返品行の予定は不変。上書きは今回受け取る数だけの実際の解決方法として保持する。
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,
      'disposition',u.disposition,'quantity',u.quantity,
      'resolution',CASE WHEN u.disposition='sent_back' THEN NULL WHEN x.action='refund' THEN 'refund' ELSE l.resolution END,
      'exchange_method',CASE WHEN u.disposition='sent_back' OR l.resolution='refund' OR x.action='refund' THEN NULL
        WHEN x.action='make' THEN 'make' ELSE l.exchange_method END) ORDER BY u.return_line_id,u.disposition)
    INTO v_effective
  FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
  JOIN public.order_return_lines AS l ON l.id=u.return_line_id
  LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text) ON x.return_line_id=l.id;
  -- 交換の品の割り当て（Global Constraints の交換の品の行）。返品の行の並び（list_order_returns の lines と同じ: 発送の番号 →
  -- 注文の商品の登録順 → 注文の商品の番号 → 返品の行の番号）で、この受け取りで在庫に戻す前の在庫を前から割り当て、
  -- 足りなくなった行を在庫不足として扱う（画面も、開いた時の在庫を同じ並びで数える）。前の行の −n は台帳のトリガーがすぐ
  -- 在庫に足すので、行ごとに読み直す在庫が残りの在庫になる。在庫に戻す品はこの後に書く（足りる行は戻す前の在庫の内なので、
  -- 負の在庫を経由しない）
  FOR v_line IN SELECT l.*,pg_catalog.sum(x.quantity)::integer AS picked,ov.action AS override_action
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN public.order_fulfillments AS f ON f.id=l.fulfillment_id
    JOIN public.order_items AS oi ON oi.id=l.order_item_id
    LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS ov(return_line_id uuid,action text) ON ov.return_line_id=l.id
    WHERE l.resolution='exchange' AND x.disposition<>'sent_back'
    GROUP BY l.id,f.number,oi.created_at,ov.action
    ORDER BY f.number,oi.created_at,l.order_item_id,l.id
  LOOP
    IF v_line.exchange_method='make' THEN
      v_action:='make';
    ELSE
      SELECT v.stock_quantity INTO v_available FROM public.item_variants AS v WHERE v.id=v_line.exchange_variant_id;
      IF v_available>=v_line.picked THEN
        -- 在庫が足りる行は在庫から。上書きは在庫不足の行だけ（C-1）
        IF v_line.override_action IS NOT NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
        v_action:='stock';
      ELSIF v_line.override_action IS NOT NULL THEN
        v_action:=v_line.override_action;
      ELSIF (SELECT rs.out_of_stock_exchange FROM public.shop_return_reason_settings AS rs WHERE rs.reason=v_line.reason)='make' THEN
        v_action:='make';
      ELSE
        RAISE EXCEPTION 'RETURN_EXCHANGE_OUT_OF_STOCK' USING ERRCODE='22023';
      END IF;
    END IF;
    -- 返金に変えた行は交換の品を作らない（上の v_effective で返金の品になっていて、下の返金の数に入る）
    CONTINUE WHEN v_action='refund';
    SELECT COALESCE(pg_catalog.sum(e.quantity),0)::integer INTO v_offset FROM public.order_items AS e
    JOIN public.order_return_lines AS old ON old.id=e.exchange_return_line_id WHERE old.order_item_id=v_line.order_item_id;
    v_paid:=private.return_units_amount(v_line.order_item_id,v_line.picked,v_offset);
    -- 自動の make と店長の選択を含む実際の送り方だけを、受け取り明細へ保存する。
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,'disposition',u.disposition,
        'quantity',u.quantity,'resolution',u.resolution,'exchange_method',CASE WHEN u.return_line_id=v_line.id
          AND u.resolution='exchange' THEN v_action ELSE u.exchange_method END) ORDER BY u.return_line_id,u.disposition)
      INTO v_effective
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS u(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text);
    v_item:=private.return_exchange_item_id(v_receipt,v_line.id,v_action);
    INSERT INTO public.order_items(id,order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,
      fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
    SELECT v_item,v_order,v.item_id,v.id,i.name,0,c.name,z.label,v_line.picked,0,
      CASE WHEN v_action='stock' THEN 'stock' ELSE 'backorder' END,'exchange',v_line.id,v_paid
    FROM public.item_variants AS v JOIN public.items AS i ON i.id=v.item_id
    LEFT JOIN public.item_colors AS c ON c.id=v.color_id LEFT JOIN public.item_sizes AS z ON z.id=v.size_id
    WHERE v.id=v_line.exchange_variant_id;
    IF v_action='stock' THEN
      INSERT INTO public.stock_movements(variant_id,delta,reason,order_id,order_item_id,created_by,return_id)
      VALUES(v_line.exchange_variant_id,-v_line.picked,'exchange',v_order,v_item,_actor_id,_return_id);
    END IF;
    v_exchange_ids:=v_exchange_ids||v_item;v_exchange:=v_exchange+v_line.picked;
  END LOOP;
  -- 戻る品を在庫へ足す（交換の割り当ての後。在庫不足の判定には入れない）
  FOR v_line IN SELECT l.order_item_id,oi.variant_id,pg_catalog.sum(x.quantity)::integer AS quantity
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
    WHERE x.disposition='restocked' GROUP BY l.order_item_id,oi.variant_id ORDER BY oi.variant_id,l.order_item_id
  LOOP
    IF v_line.variant_id IS NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    INSERT INTO public.stock_movements(variant_id,delta,reason,order_id,order_item_id,created_by,return_id)
    VALUES(v_line.variant_id,v_line.quantity,'return',v_order,v_line.order_item_id,_actor_id,_return_id);
  END LOOP;
  -- 受け取り後にこの返品のrwが増える数だけを返金する。rfと開き直した品への優先の覆いも、移行Aの本体で数える。
  -- 未保存の明細を本体に渡すため、追記専用の受け取りは返金IDをINSERT時に確定したまま書ける。
  WITH before_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states(v_order) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), after_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states_core(v_order,v_effective) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,'before_shipment',false,'quantity',t.quantity)
      ORDER BY t.order_item_id) FILTER(WHERE t.quantity>0),'[]'::jsonb),
    COALESCE(pg_catalog.sum(private.return_units_amount(t.order_item_id,t.quantity)) FILTER(WHERE t.quantity>0),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,LEAST(pg_catalog.sum(x.quantity)::integer,
        GREATEST(a.waiting-b.waiting,0)) AS quantity
      FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text)
      JOIN public.order_return_lines AS l ON l.id=x.return_line_id
      JOIN before_receive AS b ON b.order_item_id=l.order_item_id
      JOIN after_receive AS a ON a.order_item_id=l.order_item_id
      WHERE x.resolution='refund'
      GROUP BY l.order_item_id,a.waiting,b.waiting
    ) AS t;
  -- 先にふつうの返金で返した品（覆い）があると、画面の見込みより返金する品が少なくなる。
  -- 店長が見込みから直した額や送料をそのまま付けると多く返りうるため、計算どおりか相談で受け取り直してもらう。
  -- 全部が覆われて返金する品が0点の時も、入れた額や送料を黙って捨てずに同じ断りにする。
  IF _refund_choice='now' AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0)
    AND (SELECT COALESCE(pg_catalog.sum(x.quantity),0)
      FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(quantity integer))
      < (SELECT COALESCE(pg_catalog.sum(x.quantity),0)
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(resolution text,quantity integer)
        WHERE x.resolution='refund') THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023';
  END IF;
  IF _refund_choice='none' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- この受け取りで返金する品が無い時（覆われた品だけ・交換だけ・お返しだけ）は、相談・今返金を選んでも返金は起きない。
  -- 記録・履歴・メールを実際と合わせるため none で残す。指紋は入力から作るので、同じ入力の送り直しは前の結果を返す。
  v_choice:=CASE WHEN pg_catalog.jsonb_array_length(v_lines)=0 THEN 'none' ELSE _refund_choice END;
  v_first_goods:=NOT EXISTS(SELECT 1 FROM public.order_return_receipts AS rr
    JOIN public.order_return_receipt_lines AS u ON u.receipt_id=rr.id
    WHERE rr.return_id=_return_id AND rr.kind='receive' AND u.resolution IN ('refund','exchange'));
  v_first_exchange:=NOT EXISTS(SELECT 1 FROM public.order_items AS e
    JOIN public.order_return_lines AS l ON l.id=e.exchange_return_line_id
    WHERE l.return_id=_return_id AND NOT (e.id=ANY(v_exchange_ids)));
  v_fees:=(v_goods::bigint*v_return.restocking_fee_percent/100)::integer
    +CASE WHEN v_first_goods AND (pg_catalog.jsonb_array_length(v_lines)>0 OR v_exchange>0) AND v_return.return_method='shop_label'
      THEN v_return.return_shipping_fee ELSE 0 END
    +CASE WHEN v_first_exchange AND v_exchange>0 THEN v_return.exchange_fee+v_return.exchange_shipping_fee ELSE 0 END;
  IF _refund_choice='consult' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN v_pending:=v_fees;
  ELSIF _refund_choice='now' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    v_amount:=GREATEST(v_goods-v_fees,0)+_refund_shipping_amount;
    -- 店長が直した額の上限は返せる額（E-2 の値。仕様書 6-3・P8）。計算との差は core が adjustment_amount に残す
    IF _refund_amount IS NOT NULL THEN
      IF _refund_amount<_refund_shipping_amount
        OR _refund_amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a) THEN
        RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
      v_amount:=_refund_amount;
    END IF;
    v_due:=GREATEST(v_fees-v_goods,0);
    IF v_amount=0 THEN v_waived:=true;v_status:='waived';
    ELSE v_refund:=pg_catalog.gen_random_uuid(); END IF;
  ELSE v_due:=v_fees;
  END IF;
  -- 非0円の返金を頼めない注文には受け取りを残さない。0円と受け取りだけの道は Stripe を必要としない。
  IF v_refund IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0
      AND pg_catalog.left(o.payment_intent_id,3)='pi_' AND pg_catalog.char_length(o.payment_intent_id)>3
  ) THEN RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  BEGIN
    INSERT INTO public.order_return_receipts(id,return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
      notify_customer,sent_back_message,sent_back_carrier,sent_back_tracking_number,note,actor_id,actor_can_refund)
    VALUES(v_receipt,_return_id,_request_key,v_fp,'receive',v_choice,v_refund,_notify_customer,
      _sent_back_message,_sent_back_carrier,_sent_back_tracking_number,_note,_actor_id,_actor_can_refund);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
  INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
  SELECT v_receipt,x.return_line_id,x.disposition,x.quantity,x.resolution,x.exchange_method
  FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text);
  IF v_waived THEN
    -- 0円で終える数は、今回の実際の返金の数だけ。普通の返金で既に覆われた数は再び覆わない。
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt,w.return_line_id,'refund_waived',w.waived,NULL,NULL FROM (
      SELECT u.return_line_id,LEAST(u.quantity,GREATEST(c.quantity-COALESCE(pg_catalog.sum(u.quantity) OVER(
          PARTITION BY u.order_item_id ORDER BY u.return_line_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::integer,0)) AS waived
      FROM (
        SELECT x.return_line_id,l.order_item_id,pg_catalog.sum(x.quantity)::integer AS quantity
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,resolution text,quantity integer)
        JOIN public.order_return_lines AS l ON l.id=x.return_line_id
        WHERE x.resolution='refund' GROUP BY x.return_line_id,l.order_item_id
      ) AS u JOIN pg_catalog.jsonb_to_recordset(v_lines) AS c(order_item_id uuid,quantity integer) ON c.order_item_id=u.order_item_id
    ) AS w WHERE w.waived>0;
  END IF;
  IF v_refund IS NOT NULL THEN
    SELECT r.refund_id,r.amount,r.status INTO v_refund,v_amount,v_status
    FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,_refund_shipping_amount,v_amount,
      _note,'requested_by_customer',NULL,_notify_customer,_actor_id,_refund_amount,_return_id,LEAST(v_fees,v_goods)) AS r;
  END IF;
  -- 新たに付く未収手数料は前の免除に含まれないため、受領を戻す時は免除の印も外す。
  UPDATE public.order_returns AS rt SET fee_due_amount=rt.fee_due_amount+v_due,
    fee_pending_deduction=rt.fee_pending_deduction+v_pending,
    fee_waived=CASE WHEN v_due>0 THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_note END WHERE rt.id=_return_id;
  IF v_exchange>0 THEN
    PERFORM pg_catalog.set_config('app.order_actor_id',_actor_id::text,true);
    PERFORM pg_catalog.set_config('app.order_change_reason','return_exchange_added',true);
    PERFORM pg_catalog.set_config('app.order_source_event_id','',true);
    UPDATE public.orders AS o SET status='paid',shipped_at=NULL,shipping_carrier=NULL,tracking_number=NULL
    WHERE o.id=v_order AND o.status='shipped';
  END IF;
  IF NOT _actor_can_refund AND v_choice='consult' THEN
    v_shop:=private.enqueue_return_email(v_order,'return_refund_pending_shop',_return_id,v_receipt);
  END IF;
  IF _notify_customer AND v_refund IS NULL THEN
    PERFORM private.enqueue_return_email(v_order,CASE WHEN v_sent=(SELECT pg_catalog.sum(x.quantity)
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(quantity integer)) THEN 'return_sent_back' ELSE 'return_received' END,_return_id,v_receipt);
  END IF;
  return_status:=private.refresh_order_return_status(_return_id);
  SELECT rt.fee_due_amount INTO fee_due_amount FROM public.order_returns AS rt WHERE rt.id=_return_id;
  RETURN QUERY SELECT v_receipt,return_status,v_refund,v_amount,v_status,
    ARRAY(SELECT x FROM pg_catalog.unnest(v_exchange_ids) AS x ORDER BY x),fee_due_amount,v_shop,false;
END;
$$;

-- 申し込みの鍵を先に取ると、注文を先に取る返金と逆順になる。共通の包みで順番を固定する。
-- private の補助なので SECURITY DEFINER は付けない（呼ぶ下の公開関数3つが持ち主の権限で動く）。
CREATE OR REPLACE FUNCTION private.lock_order_cancel_request(_cancel_request_id uuid)
RETURNS public.order_cancel_requests
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_order_id uuid; v_request public.order_cancel_requests;
BEGIN
  SELECT r.order_id INTO v_order_id FROM public.order_cancel_requests AS r WHERE r.id = _cancel_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCEL_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
  SELECT r.* INTO v_request FROM public.order_cancel_requests AS r WHERE r.id = _cancel_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CANCEL_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  RETURN v_request;
END;
$$;
REVOKE ALL ON FUNCTION private.lock_order_cancel_request(uuid) FROM PUBLIC;

-- 未発送の数は申し込み時の写しでなく、返金・発送を反映した現在の数を出す。
CREATE OR REPLACE FUNCTION public.list_order_cancel_requests(_order_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id',r.id,'status',r.status,'requested_at',r.requested_at,'customer_note',r.customer_note,
      'lines',COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'order_item_id',l.order_item_id,'item_name',oi.item_name,'color',oi.color,'size',oi.size,
          'quantity',l.quantity,'unshipped',COALESCE(f.unshipped,0)) ORDER BY oi.created_at,oi.id,l.id)
        FROM public.order_cancel_request_lines AS l
        JOIN public.order_items AS oi ON oi.id=l.order_item_id
        LEFT JOIN private.order_line_fulfillment(_order_id) AS f ON f.order_item_id=oi.id
        WHERE l.cancel_request_id=r.id
      ),'[]'::jsonb),
      'decline_reason',r.decline_reason,'decline_message',r.decline_message,'declined_at',r.declined_at,
      'declined_by_email',d.email::text,'resolved_at',r.resolved_at,'resolved_by_email',v.email::text,
      'resolved_refund_id',r.resolved_refund_id,'resolved_by_cancel_at',r.resolved_by_cancel_at,
      'closed_at',r.closed_at,'closed_by_email',c.email::text
    ) ORDER BY r.requested_at DESC,r.id DESC
  ),'[]'::jsonb)
  FROM public.order_cancel_requests AS r
  LEFT JOIN auth.users AS d ON d.id=r.declined_by
  LEFT JOIN auth.users AS v ON v.id=r.resolved_by
  LEFT JOIN auth.users AS c ON c.id=r.closed_by
  WHERE r.order_id=_order_id
$$;

CREATE OR REPLACE FUNCTION public.admin_decline_cancel_request(
  _cancel_request_id uuid, _actor_id uuid, _decline_reason text, _decline_message text
) RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_request public.order_cancel_requests; v_message text := NULLIF(pg_catalog.btrim(_decline_message),'');
BEGIN
  IF _cancel_request_id IS NULL OR _actor_id IS NULL OR _decline_reason IS NULL
    OR _decline_reason NOT IN ('window_passed','final_sale','other') THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_message IS NULL OR pg_catalog.char_length(v_message) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'RETURN_DECLINE_MESSAGE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  v_request := private.lock_order_cancel_request(_cancel_request_id);
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  UPDATE public.order_cancel_requests AS r SET status='declined',declined_at=pg_catalog.now(),declined_by=_actor_id,
    decline_reason=_decline_reason,decline_message=v_message WHERE r.id=_cancel_request_id;
  -- お断りは注文を変えずにメッセージを届ける。返金のメールとは別の事実なので必ず予定を書く。
  PERFORM private.enqueue_cancel_request_email(v_request.order_id,'cancel_request_declined',_cancel_request_id);
  RETURN QUERY SELECT _cancel_request_id,'declined'::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_close_cancel_request(_cancel_request_id uuid, _actor_id uuid)
RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_request public.order_cancel_requests;
BEGIN
  IF _cancel_request_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_request := private.lock_order_cancel_request(_cancel_request_id);
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  -- 解決済みにする操作は注文を変えない。メールも出さず、閉じた記録だけを保持する。
  UPDATE public.order_cancel_requests AS r SET status='closed',closed_at=pg_catalog.now(),closed_by=_actor_id
  WHERE r.id=_cancel_request_id;
  RETURN QUERY SELECT _cancel_request_id,'closed'::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_resolve_cancel_request(
  _cancel_request_id uuid, _actor_id uuid, _refund_id uuid, _order_cancelled boolean
) RETURNS TABLE (cancel_request_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_request public.order_cancel_requests;
BEGIN
  IF _cancel_request_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- 根拠は1つだけ。返金の番号と取消を両方送る入力を成功扱いにしない。
  IF _order_cancelled IS NULL OR NOT ((_refund_id IS NOT NULL) <> _order_cancelled) THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_RESOLUTION_INVALID' USING ERRCODE = '22023';
  END IF;
  v_request := private.lock_order_cancel_request(_cancel_request_id);
  IF v_request.status <> 'requested' THEN
    RAISE EXCEPTION 'CANCEL_REQUEST_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF _refund_id IS NOT NULL THEN
    -- 同じ注文の後続の返金だけを根拠にする。申し込みより前の返金と失敗した返金は根拠にしない。
    PERFORM 1 FROM public.order_refunds AS rf
    WHERE rf.id=_refund_id AND rf.order_id=v_request.order_id AND rf.created_at>=v_request.requested_at
      AND rf.status IN ('awaiting_response','pending','succeeded') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CANCEL_REQUEST_RESOLUTION_INVALID' USING ERRCODE = '22023'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id=v_request.order_id AND o.status='cancelled') THEN
      RAISE EXCEPTION 'CANCEL_REQUEST_RESOLUTION_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE public.order_cancel_requests AS r SET status='resolved',resolved_at=pg_catalog.now(),resolved_by=_actor_id,
    resolved_refund_id=_refund_id,resolved_by_cancel_at=CASE WHEN _order_cancelled THEN pg_catalog.now() ELSE NULL END
  WHERE r.id=_cancel_request_id;
  -- 返金・取消のメールは元の操作が作っているため、解決で二度送らない。
  RETURN QUERY SELECT _cancel_request_id,'resolved'::text;
END;
$$;

-- 写真の作成時刻ではなく、現在の終了状態の時刻で90日を数える。開き直した返品は対象から外れる。
CREATE OR REPLACE FUNCTION public.list_return_photo_purge_targets(_limit integer)
RETURNS TABLE (target_kind text, target_id uuid, storage_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT t.target_kind,t.target_id,t.storage_path
  FROM (
    SELECT 'upload'::text AS target_kind,u.id AS target_id,u.storage_path,u.created_at AS due_from
    FROM public.order_return_photo_uploads AS u
    WHERE u.attached_at IS NULL AND u.purged_at IS NULL AND u.created_at < pg_catalog.now()-interval '1 day'
    UNION ALL
    SELECT 'photo'::text,p.id,p.storage_path,
      CASE r.status WHEN 'closed' THEN r.closed_at WHEN 'cancelled' THEN r.cancelled_at WHEN 'declined' THEN r.declined_at END
    FROM public.order_return_photos AS p
    JOIN public.order_return_lines AS l ON l.id=p.return_line_id
    JOIN public.order_returns AS r ON r.id=l.return_id
    WHERE p.purged_at IS NULL AND r.status IN ('closed','cancelled','declined')
      AND CASE r.status WHEN 'closed' THEN r.closed_at WHEN 'cancelled' THEN r.cancelled_at WHEN 'declined' THEN r.declined_at END
        < pg_catalog.now()-interval '90 days'
  ) AS t
  ORDER BY t.due_from,t.target_kind,t.target_id
  LIMIT LEAST(GREATEST(COALESCE(_limit, 500), 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.mark_return_photo_targets_purged(_target_kind text, _ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  IF _target_kind IS NULL OR _target_kind NOT IN ('upload','photo') THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- 物を消した後にだけ呼ぶ。再実行で時刻を上書きせず、空から値への1回の更新に留める。
  IF _target_kind='upload' THEN
    UPDATE public.order_return_photo_uploads AS u SET purged_at=pg_catalog.now()
    WHERE u.id=ANY(_ids) AND u.purged_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    UPDATE public.order_return_photos AS p SET purged_at=pg_catalog.now()
    WHERE p.id=ANY(_ids) AND p.purged_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    -- 写真の印の更新だけが済んだ再実行でも送り先の印を揃える。返す数は写真の新しい印の数。
    UPDATE public.order_return_photo_uploads AS u SET purged_at=pg_catalog.now()
    WHERE u.purged_at IS NULL AND EXISTS (
      SELECT 1 FROM public.order_return_photos AS p WHERE p.id=ANY(_ids) AND p.upload_id=u.id
    );
  END IF;
  RETURN v_count;
END;
$$;

-- 入口はサーバーだけに限定する。管理者の権限は窓口で確かめ、DB は状態と入力をもう一度守る。
REVOKE ALL ON FUNCTION public.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.admin_decline_return(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decline_return(uuid,uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION private.return_detail_json(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_order_return_materials(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_return_materials(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.list_return_photos(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_return_photos(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.list_order_cancel_requests(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_order_cancel_requests(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_decline_cancel_request(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decline_cancel_request(uuid,uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_close_cancel_request(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_close_cancel_request(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.admin_resolve_cancel_request(uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_cancel_request(uuid,uuid,uuid,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.list_return_photo_purge_targets(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_return_photo_purge_targets(integer) TO service_role;
REVOKE ALL ON FUNCTION public.mark_return_photo_targets_purged(text,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_return_photo_targets_purged(text,uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
