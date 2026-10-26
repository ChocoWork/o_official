BEGIN;
-- G4B_BODY_BEGIN

-- Attention is order-scoped; resolved records never contribute.
CREATE FUNCTION private.group_g_order_attention_ids(_order_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.array_agg(o.id ORDER BY o.id), ARRAY[]::uuid[])
  FROM public.orders AS o
  WHERE o.id = ANY(_order_ids) AND (
    (o.review_reason IS NOT NULL AND o.reviewed_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.payment_exceptions AS e WHERE e.order_id = o.id AND e.resolved_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.order_fulfillments AS f
      JOIN public.order_fulfillment_attention AS a ON a.fulfillment_id = f.id AND a.resolved_at IS NULL
      WHERE f.order_id = o.id))
$$;

CREATE FUNCTION private.group_g_order_candidates(_filters jsonb, _cap integer)
RETURNS TABLE(order_ids uuid[], matched_orders bigint, capped boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_key text;
  v_value jsonb;
  v_text text;
  v_from date;
  v_to date;
  v_number text;
  v_payment boolean := false;
BEGIN
  IF _cap IS NULL OR _cap < 1 OR _filters IS NULL OR pg_catalog.jsonb_typeof(_filters) <> 'object' THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_key, v_value IN SELECT * FROM pg_catalog.jsonb_each(_filters) LOOP
    IF v_key IN ('dateFrom','dateTo','orderNumber','customer','email','product','color','size') THEN
      IF pg_catalog.jsonb_typeof(v_value) <> 'string' THEN
        RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_text := pg_catalog.btrim(_filters->>v_key);
      IF pg_catalog.char_length(v_text) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      IF v_key IN ('dateFrom','dateTo') THEN
        IF v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
          RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
        END IF;
        BEGIN
          IF v_key = 'dateFrom' THEN v_from := v_text::date; ELSE v_to := v_text::date; END IF;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
        END;
      ELSIF v_key = 'orderNumber' THEN
        v_payment := v_text ~* '^pi_[A-Za-z0-9_]{1,197}$';
        IF v_payment THEN v_number := v_text;
        ELSE
          v_number := pg_catalog.regexp_replace(pg_catalog.lower(v_text), '^ord-', '');
          IF v_number !~ '^[0-9a-f-]+$' THEN
            RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
          END IF;
        END IF;
      END IF;
    ELSIF v_key = 'attention' THEN
      IF pg_catalog.jsonb_typeof(v_value) <> 'boolean' THEN
        RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
    ELSIF v_key = 'statuses' THEN
      IF pg_catalog.jsonb_typeof(v_value) <> 'array' THEN
        RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      IF pg_catalog.jsonb_array_length(v_value) > 12 OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_value) AS x(s)
        WHERE pg_catalog.jsonb_typeof(s) <> 'string' OR NOT (s #>> '{}') = ANY(ARRAY[
          'unpaid','payment_expired','in_production','ready','shipped','delivered','cancel_requested',
          'cancelled','return_requested','return_in_progress','refund_waiting','returned'])) THEN
        RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
    ELSE
      RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF v_from > v_to THEN RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH order_matches AS MATERIALIZED (
    SELECT o.id, o.created_at FROM public.orders AS o
    WHERE o.status NOT IN ('payment_in_progress','abandoned')
      AND (v_from IS NULL OR (o.created_at AT TIME ZONE 'Asia/Tokyo')::date >= v_from)
      AND (v_to IS NULL OR (o.created_at AT TIME ZONE 'Asia/Tokyo')::date <= v_to)
      AND (v_number IS NULL OR CASE WHEN v_payment THEN o.payment_intent_id ILIKE
        pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(v_number, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        ELSE o.id::text LIKE v_number || '%' END)
      AND (NOT _filters ? 'customer' OR o.shipping_full_name ILIKE '%' ||
        pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'customer'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (NOT _filters ? 'email' OR o.shipping_email ILIKE '%' ||
        pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'email'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (NOT (_filters ?| ARRAY['product','color','size']) OR EXISTS (
        SELECT 1 FROM public.order_items AS oi WHERE oi.order_id = o.id
          AND (NOT _filters ? 'product' OR oi.item_name ILIKE '%' ||
            pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'product'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
          AND (NOT _filters ? 'color' OR oi.color ILIKE '%' ||
            pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'color'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
          AND (NOT _filters ? 'size' OR oi.size ILIKE '%' ||
            pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'size'), '\', '\\'), '%', '\%'), '_', '\_') || '%')))
  ), attention AS MATERIALIZED (
    SELECT CASE WHEN _filters->>'attention' = 'true' THEN
      private.group_g_order_attention_ids(ARRAY(SELECT o.id FROM order_matches AS o)) ELSE ARRAY[]::uuid[] END AS ids
  ), matched AS MATERIALIZED (
    SELECT o.* FROM order_matches AS o CROSS JOIN attention AS a
    -- Only true enables this filter; false and an absent key both leave all candidates eligible.
    WHERE _filters->>'attention' IS DISTINCT FROM 'true' OR o.id = ANY(a.ids)
  ), limited AS MATERIALIZED (
    SELECT m.* FROM matched AS m ORDER BY m.created_at DESC, m.id LIMIT _cap
  )
  SELECT ARRAY(SELECT l.id FROM limited AS l ORDER BY l.created_at DESC, l.id),
    (SELECT pg_catalog.count(*) FROM matched), (SELECT pg_catalog.count(*) > _cap FROM matched);
END;
$$;

-- No unit expansion: sales and refunds use differences of cumulative bigint quotients.
CREATE FUNCTION private.group_g_order_item_rows(_order_ids uuid[])
RETURNS TABLE(order_id uuid, order_item_id uuid, status text, status_rank integer, quantity integer,
  blocked_reasons text[], is_exchange boolean, unit_price integer, line_amount integer, refund_amount integer, first_unit integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH orders AS MATERIALIZED (
    SELECT o.id FROM public.orders AS o WHERE o.id = ANY(_order_ids)
      AND o.status NOT IN ('payment_in_progress','abandoned')
  ), discounts AS MATERIALIZED (
    SELECT d.* FROM orders AS o CROSS JOIN LATERAL private.order_line_discounts(o.id) AS d
  ), ranges AS MATERIALIZED (
    SELECT r.*, pg_catalog.array_position(ARRAY['unpaid','payment_expired','in_production','ready','shipped',
      'delivered','cancel_requested','cancelled','return_requested','return_in_progress','refund_waiting','returned'], r.status) AS rank,
      oi.quantity AS q, oi.line_kind = 'exchange' AS exchange,
      CASE WHEN oi.line_kind = 'exchange' THEN 0 ELSE oi.item_price END AS price,
      CASE WHEN oi.line_kind = 'exchange' THEN 0::bigint ELSE oi.line_total::bigint - d.line_discount END AS net
    FROM private.group_g_item_state_ranges(ARRAY(SELECT o.id FROM orders AS o)) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    JOIN discounts AS d ON d.order_item_id = oi.id
  ), refunds AS MATERIALIZED (
    SELECT l.order_item_id,
      CASE WHEN l.before_shipment THEN 'before' WHEN f.return_id IS NOT NULL THEN 'return' ELSE 'after' END AS kind,
      pg_catalog.sum(l.amount)::bigint AS amount, pg_catalog.sum(l.quantity)::bigint AS n
    FROM orders AS o JOIN public.order_refunds AS f ON f.order_id = o.id AND f.status = 'succeeded'
    JOIN public.order_refund_lines AS l ON l.refund_id = f.id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id AND oi.order_id = o.id
    GROUP BY l.order_item_id, CASE WHEN l.before_shipment THEN 'before' WHEN f.return_id IS NOT NULL THEN 'return' ELSE 'after' END
  ), targets AS (
    SELECT r.*, f.kind, f.amount, f.n,
      (f.kind = 'before' AND r.status = 'cancelled' OR f.kind = 'return' AND r.status = 'returned'
        OR f.kind = 'after' AND r.status IN ('delivered','shipped')) AS target,
      COALESCE(pg_catalog.sum(r.unit_to - r.unit_from) FILTER (WHERE
        f.kind = 'before' AND r.status = 'cancelled' OR f.kind = 'return' AND r.status = 'returned'
        OR f.kind = 'after' AND r.status IN ('delivered','shipped'))
        OVER (PARTITION BY r.order_item_id, f.kind), 0)::bigint AS t
    FROM ranges AS r JOIN refunds AS f ON f.order_item_id = r.order_item_id
  ), positioned AS (
    SELECT t.*, LEAST(t.n, CASE WHEN t.t = 0 THEN t.q ELSE t.t END)::bigint AS m,
      COALESCE(pg_catalog.sum(t.unit_to - t.unit_from) OVER (PARTITION BY t.order_item_id, t.kind
        ORDER BY CASE WHEN t.t = 0 THEN t.rank WHEN t.status = 'delivered' THEN 0 ELSE 1 END, t.unit_from
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::bigint AS s
    FROM targets AS t WHERE t.target OR t.t = 0
  ), refund_parts AS (
    SELECT p.order_item_id, p.unit_from,
      pg_catalog.sum(p.amount * LEAST(p.s + p.unit_to - p.unit_from, p.m) / p.m
        - p.amount * LEAST(p.s, p.m) / p.m)::bigint AS amount
    FROM positioned AS p GROUP BY p.order_item_id, p.unit_from
  ), amounts AS MATERIALIZED (
    SELECT r.*, r.net * r.unit_to / r.q - r.net * r.unit_from / r.q AS sales,
      COALESCE(f.amount, 0::bigint) AS refund
    FROM ranges AS r LEFT JOIN refund_parts AS f ON f.order_item_id = r.order_item_id AND f.unit_from = r.unit_from
  ), grouped AS (
    SELECT a.order_id, a.order_item_id, a.status, a.rank, pg_catalog.sum(a.unit_to - a.unit_from)::integer AS quantity,
      a.exchange, a.price, pg_catalog.sum(a.sales)::integer AS sales, pg_catalog.sum(a.refund)::integer AS refund,
      pg_catalog.min(a.unit_from) AS first_unit
    FROM amounts AS a GROUP BY a.order_id, a.order_item_id, a.status, a.rank, a.exchange, a.price
  ), reasons AS (
    SELECT a.order_item_id, a.status, pg_catalog.array_agg(DISTINCT b.reason ORDER BY b.reason) AS reasons
    FROM amounts AS a CROSS JOIN LATERAL pg_catalog.unnest(a.blocked_reasons) AS b(reason)
    GROUP BY a.order_item_id, a.status
  )
  SELECT g.order_id, g.order_item_id, g.status, g.rank, g.quantity,
    COALESCE(x.reasons, ARRAY[]::text[]),
    g.exchange, g.price, g.sales, g.refund, g.first_unit
  FROM grouped AS g LEFT JOIN reasons AS x ON x.order_item_id = g.order_item_id AND x.status = g.status
  ORDER BY g.order_id, g.order_item_id, g.rank, g.first_unit
$$;

CREATE FUNCTION private.list_admin_order_item_rows(_filters jsonb, _limit integer, _offset integer, _actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cap integer := 5000;
  v_candidates record;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _limit IS NULL OR _limit NOT BETWEEN 1 AND 100 OR _offset IS NULL OR _offset < 0 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_cap := LEAST(5000, COALESCE(NULLIF(pg_catalog.current_setting('app.group_g_list_cap_orders', true), '')::integer, 5000));
    IF v_cap < 1 THEN v_cap := 5000; END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN v_cap := 5000;
  END;
  SELECT * INTO v_candidates FROM private.group_g_order_candidates(_filters, v_cap);
  WITH rows AS MATERIALIZED (
    SELECT r.*, o.created_at, pg_catalog.jsonb_build_object(
      'orderId',r.order_id,'orderCreatedAt',o.created_at,'customerName',pg_catalog.btrim(o.shipping_full_name),
      'customerEmail',pg_catalog.btrim(o.shipping_email),'orderItemId',r.order_item_id,'itemName',oi.item_name,
      'color',oi.color,'size',oi.size,'isExchange',r.is_exchange,'status',r.status,'quantity',r.quantity,
      'unitPrice',r.unit_price,'lineAmount',r.line_amount,'refundAmount',r.refund_amount,
      'blockedReasons',r.blocked_reasons,'needsAttention',r.order_id = ANY(a.ids)) AS payload
    FROM private.group_g_order_item_rows(v_candidates.order_ids) AS r
    JOIN public.orders AS o ON o.id = r.order_id JOIN public.order_items AS oi ON oi.id = r.order_item_id
    CROSS JOIN (SELECT private.group_g_order_attention_ids(v_candidates.order_ids) AS ids) AS a
    WHERE (NOT _filters ? 'product' OR oi.item_name ILIKE '%' ||
      pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'product'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (NOT _filters ? 'color' OR oi.color ILIKE '%' ||
        pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'color'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (NOT _filters ? 'size' OR oi.size ILIKE '%' ||
        pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'size'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (NOT _filters ? 'statuses' OR pg_catalog.jsonb_array_length(_filters->'statuses') = 0
        OR r.status IN (SELECT pg_catalog.jsonb_array_elements_text(_filters->'statuses')))
  ), page AS (
    SELECT r.* FROM rows AS r ORDER BY r.created_at DESC,r.order_id,r.order_item_id,r.status_rank,r.first_unit LIMIT _limit OFFSET _offset
  )
  SELECT pg_catalog.jsonb_build_object('ordersCapped',v_candidates.capped,'ordersCap',v_cap,
    'totalRows',(SELECT pg_catalog.count(*) FROM rows),'totalOrders',(SELECT pg_catalog.count(DISTINCT r.order_id) FROM rows AS r),
    'rows',COALESCE((SELECT pg_catalog.jsonb_agg(p.payload ORDER BY p.created_at DESC,p.order_id,p.order_item_id,p.status_rank,p.first_unit)
      FROM page AS p),'[]'::jsonb)) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.export_admin_order_item_rows(_filters jsonb, _actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cap integer := 20000;
  v_candidates record;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_cap := LEAST(20000, COALESCE(NULLIF(pg_catalog.current_setting('app.group_g_export_cap_rows', true), '')::integer, 20000));
    IF v_cap < 1 THEN v_cap := 20000; END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN v_cap := 20000;
  END;
  SELECT * INTO v_candidates FROM private.group_g_order_candidates(_filters, v_cap);
  IF v_candidates.capped THEN
    RAISE EXCEPTION 'GROUP_G_EXPORT_TOO_LARGE' USING ERRCODE = '22023';
  END IF;
  WITH rows AS MATERIALIZED (
    SELECT r.*, o.created_at, pg_catalog.jsonb_build_object(
      'orderId',r.order_id,'orderCreatedAt',o.created_at,'customerName',pg_catalog.btrim(o.shipping_full_name),
      'customerEmail',pg_catalog.btrim(o.shipping_email),'orderItemId',r.order_item_id,'itemName',oi.item_name,
      'color',oi.color,'size',oi.size,'isExchange',r.is_exchange,'status',r.status,'quantity',r.quantity,
      'unitPrice',r.unit_price,'lineAmount',r.line_amount,'refundAmount',r.refund_amount) AS payload
    FROM private.group_g_order_item_rows(v_candidates.order_ids) AS r
    JOIN public.orders AS o ON o.id = r.order_id JOIN public.order_items AS oi ON oi.id = r.order_item_id
    WHERE (NOT _filters ? 'product' OR oi.item_name ILIKE '%' ||
      pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'product'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (NOT _filters ? 'color' OR oi.color ILIKE '%' ||
        pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'color'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (NOT _filters ? 'size' OR oi.size ILIKE '%' ||
        pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.btrim(_filters->>'size'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      AND (NOT _filters ? 'statuses' OR pg_catalog.jsonb_array_length(_filters->'statuses') = 0
        OR r.status IN (SELECT pg_catalog.jsonb_array_elements_text(_filters->'statuses')))
  )
  SELECT pg_catalog.jsonb_build_object('rowCount',pg_catalog.count(*),'orderCount',pg_catalog.count(DISTINCT r.order_id),
    'rows',COALESCE(pg_catalog.jsonb_agg(r.payload ORDER BY r.created_at DESC,r.order_id,r.order_item_id,r.status_rank,r.first_unit),'[]'::jsonb))
    INTO v_result FROM rows AS r;
  IF (v_result->>'rowCount')::bigint > v_cap THEN
    RAISE EXCEPTION 'GROUP_G_EXPORT_TOO_LARGE' USING ERRCODE = '22023';
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.get_admin_order_detail(_order_id uuid, _actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_G_ORDER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  WITH rows AS MATERIALIZED (SELECT * FROM private.group_g_order_item_rows(ARRAY[_order_id])),
  refunds AS MATERIALIZED (SELECT f.* FROM public.order_refunds AS f WHERE f.order_id = _order_id)
  SELECT pg_catalog.jsonb_build_object(
    'order',pg_catalog.jsonb_build_object('id',v_order.id,'status',v_order.status,'createdAt',v_order.created_at,
      'paidAt',v_order.paid_at,'customerKind',CASE WHEN v_order.user_id IS NULL THEN 'guest' ELSE 'member' END,
      'customerName',pg_catalog.btrim(v_order.shipping_full_name),'customerEmail',pg_catalog.btrim(v_order.shipping_email),
      'shipTo',pg_catalog.jsonb_build_object('fullName',v_order.shipping_full_name,'postalCode',v_order.shipping_postal_code,
        'prefecture',v_order.shipping_prefecture,'city',v_order.shipping_city,'address',v_order.shipping_address,
        'building',v_order.shipping_building,'phone',v_order.shipping_phone),'currency',v_order.currency),
    'amounts',pg_catalog.jsonb_build_object(
      'productNet',(SELECT COALESCE(pg_catalog.sum(oi.line_total::bigint - d.line_discount),0) FROM public.order_items AS oi
        JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = oi.id
        WHERE oi.order_id = _order_id AND oi.line_kind = 'order'),
      'discount',v_order.discount_amount,'shipping',v_order.shipping_amount,'total',v_order.total_amount,
      'paidAmount',v_order.paid_amount,'refundedAmount',v_order.refunded_amount,
      'refundAttachedToRows',(SELECT COALESCE(pg_catalog.sum(r.refund_amount),0) FROM rows AS r),
      'refundNotAttached',(SELECT COALESCE(pg_catalog.sum(f.shipping_amount::bigint + f.adjustment_amount),0) FROM refunds AS f WHERE f.status = 'succeeded'),
      'refundProcessingAmount',(SELECT COALESCE(pg_catalog.sum(f.amount),0) FROM refunds AS f WHERE f.status IN ('awaiting_response','pending'))),
    'rows',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'orderItemId',r.order_item_id,'itemName',oi.item_name,'color',oi.color,'size',oi.size,'isExchange',r.is_exchange,
      'status',r.status,'statusRank',r.status_rank,'quantity',r.quantity,'unitPrice',r.unit_price,
      'lineAmount',r.line_amount,'refundAmount',r.refund_amount,'blockedReasons',r.blocked_reasons)
      ORDER BY r.order_id,r.order_item_id,r.status_rank,r.first_unit)
      FROM rows AS r JOIN public.order_items AS oi ON oi.id = r.order_item_id),'[]'::jsonb),
    'attention',pg_catalog.jsonb_build_object(
      'paymentExceptions',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',e.id,'reason',e.reason,
        'detectionCount',e.detection_count,'firstDetectedAt',e.first_detected_at) ORDER BY e.first_detected_at,e.id)
        FROM public.payment_exceptions AS e WHERE e.order_id = _order_id AND e.resolved_at IS NULL),'[]'::jsonb),
      'review',CASE WHEN v_order.review_reason IS NOT NULL AND v_order.reviewed_at IS NULL THEN
        pg_catalog.jsonb_build_object('reason',v_order.review_reason,'markedAt',v_order.review_marked_at) ELSE NULL END,
      'deliveries',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('fulfillmentId',a.fulfillment_id,
        'kind',a.kind,'openedAt',a.opened_at) ORDER BY a.opened_at,a.id)
        FROM public.order_fulfillment_attention AS a JOIN public.order_fulfillments AS f ON f.id = a.fulfillment_id
        WHERE f.order_id = _order_id AND a.resolved_at IS NULL),'[]'::jsonb)),
    'permissions',pg_catalog.jsonb_build_object('read',true,
      'manage',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.orders.manage']),
      'refund',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.orders.refund']),
      'return',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.orders.return']),
      'allocate',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.orders.allocate','admin.orders.read']),
      'shippingRead',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.shipping.read','admin.orders.read']))) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.list_admin_order_item_state_history(_order_id uuid, _actor_id uuid)
RETURNS TABLE(id uuid, created_at timestamptz, order_item_id uuid, item_name text, color text, size text,
  is_exchange boolean, quantity integer, from_status text, to_status text, reason text, actor_id uuid,
  operation text, ref_kind text, ref_id uuid, ref_label text, note text, counterpart_order_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id) THEN
    RAISE EXCEPTION 'GROUP_G_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  SELECT e.id,e.created_at,e.order_item_id,oi.item_name,oi.color,oi.size,oi.line_kind = 'exchange',e.quantity,
    e.from_status,e.to_status,e.reason,e.actor_id,g.operation,
    CASE WHEN g.cause_type IN ('shipment_slip','purchase_order') THEN g.cause_type END,
    CASE WHEN g.cause_type = 'shipment_slip' THEN s.id WHEN g.cause_type = 'purchase_order' THEN p.id END,
    CASE WHEN g.cause_type = 'shipment_slip' THEN s.number WHEN g.cause_type = 'purchase_order' THEN p.number END,
    CASE WHEN g.operation = 'allocation_swap' THEN g.result->>'reason' END,
    CASE WHEN g.operation = 'allocation_swap' THEN
      CASE WHEN g.result->>'takerOrderId' = _order_id::text THEN (g.result->>'donorOrderId')::uuid
        ELSE (g.result->>'takerOrderId')::uuid END END
  FROM public.order_item_state_events AS e JOIN public.order_items AS oi ON oi.id = e.order_item_id
  JOIN private.group_g_operations AS g ON g.id = e.operation_id
  LEFT JOIN public.shipment_slips AS s ON g.cause_type = 'shipment_slip' AND s.id::text = g.cause_id
  LEFT JOIN public.purchase_orders AS p ON g.cause_type = 'purchase_order' AND p.id::text = g.cause_id
  WHERE oi.order_id = _order_id ORDER BY e.created_at DESC,e.id LIMIT 301;
END;
$$;

CREATE FUNCTION public.list_admin_order_item_rows(_filters jsonb, _limit integer, _offset integer, _actor_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_admin_order_item_rows(_filters,_limit,_offset,_actor_id); $$;
CREATE FUNCTION public.export_admin_order_item_rows(_filters jsonb, _actor_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.export_admin_order_item_rows(_filters,_actor_id); $$;
CREATE FUNCTION public.get_admin_order_detail(_order_id uuid, _actor_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_admin_order_detail(_order_id,_actor_id); $$;
CREATE FUNCTION public.list_admin_order_item_state_history(_order_id uuid, _actor_id uuid)
RETURNS TABLE(id uuid, created_at timestamptz, order_item_id uuid, item_name text, color text, size text,
  is_exchange boolean, quantity integer, from_status text, to_status text, reason text, actor_id uuid,
  operation text, ref_kind text, ref_id uuid, ref_label text, note text, counterpart_order_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_admin_order_item_state_history(_order_id,_actor_id); $$;

ALTER FUNCTION private.group_g_order_candidates(jsonb,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_order_candidates(jsonb,integer) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_g_order_attention_ids(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_order_attention_ids(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_g_order_item_rows(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_order_item_rows(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.list_admin_order_item_rows(jsonb,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_order_item_rows(jsonb,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_order_item_rows(jsonb,integer,integer,uuid) TO service_role;
ALTER FUNCTION public.list_admin_order_item_rows(jsonb,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_order_item_rows(jsonb,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_order_item_rows(jsonb,integer,integer,uuid) TO service_role;
ALTER FUNCTION private.export_admin_order_item_rows(jsonb,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.export_admin_order_item_rows(jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.export_admin_order_item_rows(jsonb,uuid) TO service_role;
ALTER FUNCTION public.export_admin_order_item_rows(jsonb,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.export_admin_order_item_rows(jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.export_admin_order_item_rows(jsonb,uuid) TO service_role;
ALTER FUNCTION private.get_admin_order_detail(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_admin_order_detail(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_admin_order_detail(uuid,uuid) TO service_role;
ALTER FUNCTION public.get_admin_order_detail(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_order_detail(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_order_detail(uuid,uuid) TO service_role;
ALTER FUNCTION private.list_admin_order_item_state_history(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_order_item_state_history(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_order_item_state_history(uuid,uuid) TO service_role;
ALTER FUNCTION public.list_admin_order_item_state_history(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_order_item_state_history(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_order_item_state_history(uuid,uuid) TO service_role;

-- G4B_BODY_END
-- G4B_FINAL_ASSERT_BEGIN
DO $g4b_final_objects$
DECLARE
  v record;
  v_proc record;
  v_oid oid;
  v_detail text;
  v_names text[] := ARRAY['group_g_order_candidates','group_g_order_attention_ids','group_g_order_item_rows',
    'list_admin_order_item_rows','export_admin_order_item_rows','get_admin_order_detail','list_admin_order_item_state_history'];
  v_history_names text[] := ARRAY['id','created_at','order_item_id','item_name','color','size','is_exchange','quantity',
    'from_status','to_status','reason','actor_id','operation','ref_kind','ref_id','ref_label','note','counterpart_order_id'];
  v_history_types text[] := ARRAY['uuid','timestamptz','uuid','text','text','text','boolean','integer',
    'text','text','text','uuid','text','text','uuid','text','text','uuid'];
  v_scanned integer := 0;
BEGIN
  -- Count each group separately, rejecting extra overloads and misplaced public helpers.
  FOR v IN SELECT * FROM (VALUES
    ('private',v_names[1:3],3,'orders_reads_internal'),('public',v_names[1:3],0,'orders_reads_internal'),
    ('private',v_names[4:7],4,'orders_reads_functions'),('public',v_names[4:7],4,'orders_reads_public')
  ) AS e(schema_name,names,expected,detail) LOOP
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = v.schema_name AND p.proname = ANY(v.names)) <> v.expected THEN
      RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v.detail;
    END IF;
  END LOOP;
  FOR v IN SELECT * FROM (VALUES
    ('private.group_g_order_candidates(jsonb,integer)',true,false,ARRAY['_filters','_cap'],ARRAY['order_ids','matched_orders','capped'],ARRAY['uuid[]','bigint','boolean'],'record',''),
    ('private.group_g_order_attention_ids(uuid[])',true,false,ARRAY['_order_ids'],ARRAY[]::text[],ARRAY[]::text[],'uuid[]',''),
    ('private.group_g_order_item_rows(uuid[])',true,false,ARRAY['_order_ids'],
      ARRAY['order_id','order_item_id','status','status_rank','quantity','blocked_reasons','is_exchange','unit_price','line_amount','refund_amount','first_unit'],
      ARRAY['uuid','uuid','text','integer','integer','text[]','boolean','integer','integer','integer','integer'],'record',''),
    ('private.list_admin_order_item_rows(jsonb,integer,integer,uuid)',true,true,ARRAY['_filters','_limit','_offset','_actor_id'],ARRAY[]::text[],ARRAY[]::text[],'jsonb',''),
    ('public.list_admin_order_item_rows(jsonb,integer,integer,uuid)',false,true,ARRAY['_filters','_limit','_offset','_actor_id'],ARRAY[]::text[],ARRAY[]::text[],'jsonb','selectprivate.list_admin_order_item_rows(_filters,_limit,_offset,_actor_id);'),
    ('private.export_admin_order_item_rows(jsonb,uuid)',true,true,ARRAY['_filters','_actor_id'],ARRAY[]::text[],ARRAY[]::text[],'jsonb',''),
    ('public.export_admin_order_item_rows(jsonb,uuid)',false,true,ARRAY['_filters','_actor_id'],ARRAY[]::text[],ARRAY[]::text[],'jsonb','selectprivate.export_admin_order_item_rows(_filters,_actor_id);'),
    ('private.get_admin_order_detail(uuid,uuid)',true,true,ARRAY['_order_id','_actor_id'],ARRAY[]::text[],ARRAY[]::text[],'jsonb',''),
    ('public.get_admin_order_detail(uuid,uuid)',false,true,ARRAY['_order_id','_actor_id'],ARRAY[]::text[],ARRAY[]::text[],'jsonb','selectprivate.get_admin_order_detail(_order_id,_actor_id);'),
    ('private.list_admin_order_item_state_history(uuid,uuid)',true,true,ARRAY['_order_id','_actor_id'],v_history_names,v_history_types,'record',''),
    ('public.list_admin_order_item_state_history(uuid,uuid)',false,true,ARRAY['_order_id','_actor_id'],v_history_names,v_history_types,'record','select*fromprivate.list_admin_order_item_state_history(_order_id,_actor_id);')
  ) AS e(signature,definer,executable,input_names,output_names,output_types,result_type,delegate) LOOP
    v_detail := CASE WHEN NOT v.definer THEN 'orders_reads_public'
      WHEN v.executable THEN 'orders_reads_functions' ELSE 'orders_reads_internal' END;
    v_oid := pg_catalog.to_regprocedure(v.signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_detail;
    END IF;
    SELECT p.*,l.lanname INTO v_proc FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang WHERE p.oid = v_oid;
    IF v_proc.proowner <> 'postgres'::regrole OR v_proc.prosecdef IS DISTINCT FROM v.definer
      OR v_proc.provolatile <> 's' OR v_proc.prokind <> 'f' OR v_proc.pronargdefaults <> 0 OR v_proc.provariadic <> 0
      OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR v_proc.prorettype <> v.result_type::regtype
      OR v_proc.proretset IS DISTINCT FROM (pg_catalog.cardinality(v.output_names) > 0)
      OR v_proc.proargnames IS DISTINCT FROM (v.input_names || v.output_names)
      OR (pg_catalog.cardinality(v.output_names) > 0 AND (
        v_proc.proallargtypes[v_proc.pronargs+1:pg_catalog.cardinality(v_proc.proallargtypes)] IS DISTINCT FROM
          ARRAY(SELECT t::regtype::oid FROM pg_catalog.unnest(v.output_types) AS t)
        OR v_proc.proargmodes IS DISTINCT FROM (pg_catalog.array_fill('i'::"char",ARRAY[v_proc.pronargs::integer]) ||
          pg_catalog.array_fill('t'::"char",ARRAY[pg_catalog.cardinality(v.output_names)]))))
      OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE') IS DISTINCT FROM v.executable
      OR NOT pg_catalog.has_function_privilege('postgres',v_oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(v_proc.proacl,pg_catalog.acldefault('f',v_proc.proowner))) AS a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
      OR (NOT v.definer AND (v_proc.lanname <> 'sql' OR
        pg_catalog.regexp_replace(pg_catalog.lower(v_proc.prosrc),'\s','','g') <> v.delegate)) THEN
      RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_detail;
    END IF;
  END LOOP;
  FOR v IN SELECT p.prosrc FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('private','public') AND p.proname = ANY(v_names) LOOP
    v_scanned := v_scanned + 1;
    IF pg_catalog.regexp_replace(pg_catalog.lower(v.prosrc),'\s+',' ','g') ~
      '\m(insert into|delete from|truncate|merge into)\M|\mupdate [a-z_][a-z_0-9]*\.' THEN
      RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'orders_reads_no_write';
    END IF;
  END LOOP;
  IF v_scanned <> 11 THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'orders_reads_no_write';
  END IF;
END;
$g4b_final_objects$;
-- G4B_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
