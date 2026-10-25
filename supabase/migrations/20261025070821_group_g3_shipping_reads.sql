BEGIN;

-- G3B_BODY_BEGIN
-- FREQ-531 / FREQ-532: reads only. G-1/G-2 definitions and writer membership are unchanged.
-- Task 8 (FREQ-534-AC-04, FREQ-541-AC-03) adds, at the end of this body, the read-only helper private.tracking_registration_owner and
-- replaces three E-4 functions by one changed condition each (delivery_tracking_backfill_targets, get_order_delivery_detail,
-- get_order_status_public_material). Writers and the allowlist are not touched here.

-- Only paid orders with live paid allocations can yield ready ranges. Materialize BEFORE projection:
-- a closed order's historical returns/refunds/shipments are never passed into the G-1 projection here.
CREATE FUNCTION private.group_g_shipment_ready(_order_ids uuid[])
RETURNS TABLE(order_id uuid, order_item_id uuid, ready integer, shippable integer, blocked_reasons text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH candidates AS MATERIALIZED (
    SELECT o.* FROM public.orders AS o
    WHERE o.status = 'paid' AND (_order_ids IS NULL OR o.id = ANY(_order_ids))
      AND EXISTS (SELECT 1 FROM public.order_items AS oi
        JOIN public.order_item_allocations AS a ON a.order_item_id = oi.id
        WHERE oi.order_id = o.id AND a.kind = 'paid' AND a.remaining_quantity > 0)
  ), ranges AS MATERIALIZED (
    SELECT r.* FROM private.group_g_item_state_ranges(
      ARRAY(SELECT c.id FROM candidates AS c ORDER BY c.id)) AS r WHERE r.status = 'ready'
  ), quantities AS (
    SELECT r.order_id, r.order_item_id, pg_catalog.sum(r.unit_to - r.unit_from)::integer AS quantity,
      pg_catalog.bool_or('payment_review' = ANY(r.blocked_reasons)) AS payment_review,
      pg_catalog.bool_or('exchange_fee_waiting' = ANY(r.blocked_reasons)) AS exchange_fee_waiting,
      pg_catalog.bool_or('variant_missing' = ANY(r.blocked_reasons)) AS variant_missing
    FROM ranges AS r GROUP BY r.order_id, r.order_item_id
  ), blocked AS (
    SELECT q.*, pg_catalog.array_remove(ARRAY[
      CASE WHEN q.payment_review THEN 'payment_review' END,
      CASE WHEN q.exchange_fee_waiting THEN 'exchange_fee_waiting' END,
      CASE WHEN q.variant_missing THEN 'variant_missing' END,
      CASE WHEN NOT private.order_has_required_shipping_fields(o) THEN 'address_incomplete' END,
      CASE WHEN o.paid_at IS NULL THEN 'paid_at_missing' END
    ]::text[], NULL) AS reasons
    FROM quantities AS q JOIN candidates AS c ON c.id = q.order_id
    JOIN public.orders AS o ON o.id = c.id WHERE q.quantity > 0
  )
  SELECT b.order_id, b.order_item_id, b.quantity,
    CASE WHEN pg_catalog.cardinality(b.reasons) = 0 THEN b.quantity ELSE 0 END, b.reasons
  FROM blocked AS b;
$$;

-- One normalization and an unambiguous encoding shared by packing and the bundle verdict.
-- Member email is deliberately not identity. Incomplete, NULL and unknown orders have no usable key.
CREATE FUNCTION private.group_g_bundle_key(_order_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN private.order_has_required_shipping_fields(o) THEN
    pg_catalog.md5(pg_catalog.jsonb_build_array(
      CASE WHEN o.user_id IS NULL THEN 'guest' ELSE 'member' END,
      CASE WHEN o.user_id IS NULL THEN pg_catalog.lower(pg_catalog.btrim(o.shipping_email)) ELSE o.user_id::text END,
      pg_catalog.btrim(o.shipping_full_name), pg_catalog.btrim(o.shipping_postal_code),
      pg_catalog.btrim(o.shipping_prefecture), pg_catalog.btrim(o.shipping_city),
      pg_catalog.btrim(o.shipping_address), COALESCE(NULLIF(pg_catalog.btrim(o.shipping_building), ''), ''),
      pg_catalog.btrim(o.shipping_phone))::text)
    ELSE NULL END
  FROM public.orders AS o WHERE o.id = _order_id;
$$;

CREATE FUNCTION private.group_g_bundle_verdict(_order_ids uuid[]) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH selected AS MATERIALIZED (
    SELECT o.id, o.user_id, private.group_g_bundle_key(o.id) AS bundle_key,
      pg_catalog.lower(pg_catalog.btrim(o.shipping_email)) AS email
    FROM public.orders AS o WHERE o.id = ANY(_order_ids)
  )
  SELECT CASE
    WHEN COALESCE(pg_catalog.cardinality(_order_ids), 0) = 0
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(_order_ids) AS wanted(id)
        LEFT JOIN selected AS s ON s.id = wanted.id WHERE s.id IS NULL) THEN 'address_incomplete'
    WHEN EXISTS (SELECT 1 FROM selected AS s WHERE s.bundle_key IS NULL) THEN 'address_incomplete'
    WHEN NOT (COALESCE((SELECT pg_catalog.bool_and(s.user_id IS NOT NULL)
      AND pg_catalog.count(DISTINCT s.user_id) = 1 FROM selected AS s), true)
      OR COALESCE((SELECT pg_catalog.bool_and(s.user_id IS NULL)
        AND pg_catalog.count(DISTINCT s.email) = 1 FROM selected AS s), true)) THEN 'customer_mismatch'
    WHEN (SELECT pg_catalog.count(DISTINCT s.bundle_key) FROM selected AS s) > 1 THEN 'address_mismatch'
    ELSE NULL END;
$$;

CREATE FUNCTION private.list_admin_packing(_slip_id uuid, _limit integer, _offset integer, _actor_id uuid)
RETURNS TABLE(order_id uuid, order_item_id uuid, order_created_at timestamptz, customer_name text,
  customer_email text, item_name text, color text, size text, ready_quantity integer, shippable_quantity integer,
  unit_price integer, is_exchange boolean, blocked_reasons text[], other_slip_numbers text[],
  selected_quantity integer, bundle_ok boolean, bundle_key text, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_stage text;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.shipping.read','admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _limit IS NULL OR _limit NOT BETWEEN 1 AND 100 OR _offset IS NULL OR _offset < 0 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _slip_id IS NOT NULL THEN
    SELECT s.stage INTO v_stage FROM public.shipment_slips AS s WHERE s.id = _slip_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    IF v_stage <> 'draft' THEN RAISE EXCEPTION 'GROUP_G_SLIP_NOT_DRAFT' USING ERRCODE = '55000'; END IF;
  END IF;
  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT d."orderItemId" AS item_id, d.quantity, oi.order_id
    FROM public.shipment_slips AS s
    CROSS JOIN LATERAL pg_catalog.jsonb_to_recordset(s.draft_lines) AS d("orderItemId" uuid, quantity integer)
    JOIN public.order_items AS oi ON oi.id = d."orderItemId"
    WHERE s.id = _slip_id AND s.stage = 'draft'
  ), ready AS MATERIALIZED (
    SELECT r.*, o.created_at, o.shipping_full_name, o.shipping_email,
      oi.item_name, oi.color, oi.size, oi.item_price, oi.line_kind
    FROM private.group_g_shipment_ready(NULL::uuid[]) AS r
    JOIN public.orders AS o ON o.id = r.order_id JOIN public.order_items AS oi ON oi.id = r.order_item_id
  ), page AS MATERIALIZED (
    SELECT r.*, pg_catalog.count(*) OVER () AS total FROM ready AS r
    ORDER BY r.created_at, r.order_id, r.order_item_id LIMIT _limit OFFSET _offset
  )
  SELECT r.order_id, r.order_item_id, r.created_at, r.shipping_full_name, r.shipping_email,
    r.item_name, r.color, r.size, r.ready, r.shippable, r.item_price, r.line_kind = 'exchange', r.blocked_reasons,
    ARRAY(SELECT s.number FROM public.shipment_slips AS s
      WHERE s.id IS DISTINCT FROM _slip_id AND s.stage = 'draft' AND s.expires_at > pg_catalog.now()
        AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(s.draft_lines) AS d("orderItemId" uuid)
          WHERE d."orderItemId" = r.order_item_id) ORDER BY s.number),
    (SELECT s.quantity FROM selected AS s WHERE s.item_id = r.order_item_id),
    CASE WHEN NOT EXISTS (SELECT 1 FROM public.shipment_slips AS s WHERE s.id = _slip_id AND s.stage = 'draft')
      THEN true ELSE private.group_g_bundle_verdict(
        ARRAY(SELECT s.order_id FROM selected AS s UNION SELECT r.order_id)) IS NULL END,
    private.group_g_bundle_key(r.order_id), r.total
  FROM page AS r ORDER BY r.created_at, r.order_id, r.order_item_id;
END;
$$;

CREATE FUNCTION private.list_admin_shipment_slips(_stage text, _limit integer, _offset integer, _actor_id uuid)
RETURNS TABLE(id uuid, number text, stage text, version integer, expired boolean, shipment_date date,
  shipping_carrier text, tracking_number text, order_count integer, item_quantity integer,
  updated_at timestamptz, total_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.shipping.read','admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF (_stage IS NOT NULL AND _stage NOT IN ('draft','confirmed','cancelled','discarded'))
    OR _limit IS NULL OR _limit NOT BETWEEN 1 AND 100 OR _offset IS NULL OR _offset < 0 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH page AS MATERIALIZED (
    SELECT s.*, pg_catalog.count(*) OVER () AS total FROM public.shipment_slips AS s
    WHERE _stage IS NULL OR s.stage = _stage ORDER BY s.updated_at DESC, s.id LIMIT _limit OFFSET _offset
  )
  SELECT s.id, s.number, s.stage, s.version, s.stage = 'draft' AND s.expires_at <= pg_catalog.now(),
    s.shipment_date, s.shipping_carrier, s.tracking_number,
    CASE WHEN s.stage IN ('draft','discarded') THEN (SELECT pg_catalog.count(DISTINCT oi.order_id)::integer
      FROM pg_catalog.jsonb_to_recordset(s.draft_lines) AS d("orderItemId" uuid)
      JOIN public.order_items AS oi ON oi.id = d."orderItemId")
    ELSE (SELECT pg_catalog.count(*)::integer FROM public.shipment_slip_fulfillments AS f WHERE f.slip_id = s.id) END,
    CASE WHEN s.stage IN ('draft','discarded') THEN (SELECT COALESCE(pg_catalog.sum(d.quantity), 0)::integer
      FROM pg_catalog.jsonb_to_recordset(s.draft_lines) AS d(quantity integer))
    ELSE (SELECT COALESCE(pg_catalog.sum(l.quantity), 0)::integer FROM public.shipment_slip_lines AS l WHERE l.slip_id = s.id) END,
    s.updated_at, s.total FROM page AS s ORDER BY s.updated_at DESC, s.id;
END;
$$;

CREATE FUNCTION private.get_admin_shipment_slip(_slip_id uuid, _actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_slip public.shipment_slips%ROWTYPE;
  v_lines jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_cancel_blockers jsonb := '[]'::jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.shipping.read','admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_slip FROM public.shipment_slips AS s WHERE s.id = _slip_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  WITH selection AS MATERIALIZED (
    SELECT d."orderItemId" AS order_item_id, d.quantity
    FROM pg_catalog.jsonb_to_recordset(v_slip.draft_lines) AS d("orderItemId" uuid, quantity integer)
    WHERE v_slip.stage IN ('draft','discarded')
    UNION ALL SELECT l.order_item_id, l.quantity FROM public.shipment_slip_lines AS l
    WHERE l.slip_id = v_slip.id AND v_slip.stage IN ('confirmed','cancelled')
  ), lines AS MATERIALIZED (
    SELECT s.order_item_id, s.quantity, oi.order_id, oi.item_name, oi.color, oi.size, oi.item_price, oi.line_kind,
      o.created_at, o.status, o.paid_at, private.order_has_required_shipping_fields(o) AS address_complete
    FROM selection AS s LEFT JOIN public.order_items AS oi ON oi.id = s.order_item_id
    LEFT JOIN public.orders AS o ON o.id = oi.order_id
  ), ready AS MATERIALIZED (
    -- One evaluation serves both the displayed quantities and quantity-exceeds-ready issues.
    SELECT r.* FROM private.group_g_shipment_ready(ARRAY(
      SELECT DISTINCT l.order_id FROM lines AS l)) AS r
  ), state_ranges AS MATERIALIZED (
    -- Zero-ready draft lines still need their current state reasons; quantities only come from ready above.
    SELECT r.* FROM private.group_g_item_state_ranges(ARRAY(
      SELECT DISTINCT l.order_id FROM lines AS l WHERE v_slip.stage = 'draft' AND l.status = 'paid')) AS r
  ), verdict AS MATERIALIZED (
    SELECT private.group_g_bundle_verdict(ARRAY(SELECT DISTINCT l.order_id FROM lines AS l)) AS code
  ), issues AS (
    SELECT 'expired'::text AS code, NULL::uuid AS item_id, 1 AS priority WHERE v_slip.expires_at <= pg_catalog.now()
    UNION ALL SELECT v.code, NULL::uuid, 2 FROM verdict AS v WHERE v.code IN ('customer_mismatch','address_mismatch')
    UNION ALL SELECT 'order_not_shippable', l.order_item_id, 3 FROM lines AS l WHERE l.status IS DISTINCT FROM 'paid'::public.order_status
    UNION ALL SELECT reason.code, l.order_item_id, reason.priority
    FROM lines AS l
    CROSS JOIN LATERAL (VALUES ('payment_review',4), ('exchange_fee_waiting',5), ('variant_missing',6)) AS reason(code,priority)
    WHERE EXISTS (SELECT 1 FROM state_ranges AS r WHERE r.order_item_id = l.order_item_id AND reason.code = ANY(r.blocked_reasons))
    UNION ALL SELECT 'address_incomplete', l.order_item_id, 7 FROM lines AS l WHERE NOT l.address_complete
    UNION ALL SELECT 'paid_at_missing', l.order_item_id, 8 FROM lines AS l WHERE l.status = 'paid' AND l.paid_at IS NULL
    UNION ALL SELECT 'quantity_exceeds_ready', l.order_item_id, 9 FROM lines AS l LEFT JOIN ready AS r ON r.order_item_id = l.order_item_id
    WHERE l.quantity > COALESCE(r.shippable, 0)
  )
  SELECT (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'orderId', l.order_id, 'orderItemId', l.order_item_id, 'itemName', l.item_name, 'color', l.color, 'size', l.size,
      'quantity', l.quantity, 'readyQuantity', COALESCE(r.shippable, 0), 'unitPrice', l.item_price,
      'isExchange', l.line_kind = 'exchange') ORDER BY l.created_at, l.order_id, l.order_item_id), '[]'::jsonb)
    FROM lines AS l LEFT JOIN ready AS r ON r.order_item_id = l.order_item_id WHERE l.order_id IS NOT NULL),
    CASE WHEN v_slip.stage = 'draft' THEN (SELECT COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('code', i.code, 'orderItemId', i.item_id) ORDER BY i.priority, i.item_id), '[]'::jsonb)
      FROM issues AS i) ELSE '[]'::jsonb END
  INTO v_lines, v_issues;

  IF v_slip.stage = 'confirmed' THEN
    WITH fulfillments AS MATERIALIZED (
      SELECT sf.order_id, sf.fulfillment_id, o.status
      FROM public.shipment_slip_fulfillments AS sf JOIN public.orders AS o ON o.id = sf.order_id
      WHERE sf.slip_id = v_slip.id
    ), blockers AS (
      SELECT f.order_id, 'has_return'::text AS reason, 1 AS priority FROM fulfillments AS f
      WHERE EXISTS (SELECT 1 FROM public.order_return_lines AS l JOIN public.order_returns AS r ON r.id = l.return_id
        WHERE l.fulfillment_id = f.fulfillment_id AND r.status IN ('requested','open','closed'))
      UNION ALL SELECT f.order_id, 'refunded', 2 FROM fulfillments AS f
      WHERE EXISTS (SELECT 1 FROM public.order_fulfillment_lines AS fl
        JOIN private.order_line_fulfillment(f.order_id) AS lf ON lf.order_item_id = fl.order_item_id
        WHERE fl.fulfillment_id = f.fulfillment_id AND lf.shipped - fl.quantity < lf.refunded_after_shipment)
      UNION ALL SELECT f.order_id, 'not_cancellable', 3 FROM fulfillments AS f WHERE f.status NOT IN ('paid','shipped')
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('orderId', b.order_id, 'reason', b.reason)
      ORDER BY b.order_id, b.priority), '[]'::jsonb) INTO v_cancel_blockers FROM blockers AS b;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_slip.id, 'number', v_slip.number, 'stage', v_slip.stage, 'version', v_slip.version,
    'expired', v_slip.stage = 'draft' AND v_slip.expires_at <= pg_catalog.now(), 'customerKind', v_slip.customer_kind,
    'shipTo', pg_catalog.jsonb_build_object('fullName', v_slip.ship_to_full_name, 'postalCode', v_slip.ship_to_postal_code,
      'prefecture', v_slip.ship_to_prefecture, 'city', v_slip.ship_to_city, 'address', v_slip.ship_to_address,
      'building', v_slip.ship_to_building, 'phone', v_slip.ship_to_phone),
    'carrier', v_slip.shipping_carrier, 'trackingNumber', v_slip.tracking_number, 'notifyCustomer', v_slip.notify_customer,
    'shipmentDate', v_slip.shipment_date, 'trackingVersion', v_slip.tracking_version, 'confirmedAt', v_slip.confirmed_at,
    'cancelledAt', v_slip.cancelled_at, 'expiresAt', v_slip.expires_at, 'updatedAt', v_slip.updated_at,
    'lines', v_lines, 'issues', v_issues, 'cancelBlockers', v_cancel_blockers,
    'orders', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('orderId', sf.order_id,
        'fulfillmentId', f.id, 'fulfillmentNumber', f.number, 'deliveryStatus', f.delivery_status,
        'deliveredAt', f.delivered_at, 'cancelledAt', f.cancelled_at) ORDER BY sf.order_id), '[]'::jsonb)
      FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
      WHERE sf.slip_id = v_slip.id),
    'versions', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('version', v.version, 'kind', v.kind,
        'carrier', v.shipping_carrier, 'trackingNumber', v.tracking_number, 'trackingVersion', v.tracking_version,
        'shipmentDate', v.shipment_date, 'reason', v.reason, 'actorEmail', u.email::text, 'createdAt', v.created_at)
        ORDER BY v.version), '[]'::jsonb)
      FROM public.shipment_slip_versions AS v LEFT JOIN auth.users AS u ON u.id = v.actor_id WHERE v.slip_id = v_slip.id),
    'dateHistory', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('version', h.version, 'kind', h.kind,
        'previousDate', h.previous_date, 'newDate', h.new_date, 'reason', h.reason, 'actorEmail', u.email::text,
        'createdAt', h.created_at) ORDER BY h.version), '[]'::jsonb)
      FROM public.shipment_date_history AS h LEFT JOIN auth.users AS u ON u.id = h.actor_id WHERE h.slip_id = v_slip.id),
    'registration', (SELECT pg_catalog.jsonb_build_object('enabled', COALESCE(s.delivery_tracking_enabled, false),
        'state', CASE WHEN s.delivery_tracking_enabled THEN r.state END,
        'everRegistered', CASE WHEN s.delivery_tracking_enabled THEN r.ever_registered END,
        'leaderOrderId', CASE WHEN s.delivery_tracking_enabled THEN f.order_id END)
      FROM (SELECT COALESCE((SELECT ss.delivery_tracking_enabled FROM public.shop_settings AS ss WHERE ss.id = 1), false)
        AS delivery_tracking_enabled) AS s
      LEFT JOIN private.shipment_tracking_registrations AS sr ON sr.slip_id = v_slip.id AND sr.tracking_version = v_slip.tracking_version
      LEFT JOIN private.fulfillment_tracking_registrations AS r ON r.fulfillment_id = sr.leader_fulfillment_id
        AND r.tracking_version = sr.tracking_version
      LEFT JOIN public.order_fulfillments AS f ON f.id = sr.leader_fulfillment_id));
END;
$$;

CREATE FUNCTION private.list_admin_order_shipment_slips(_order_id uuid, _actor_id uuid)
RETURNS TABLE(slip_id uuid, number text, stage text, fulfillment_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.shipping.read','admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT s.id, s.number, s.stage, sf.fulfillment_id
  FROM public.shipment_slip_fulfillments AS sf JOIN public.shipment_slips AS s ON s.id = sf.slip_id
  WHERE sf.order_id = _order_id ORDER BY s.confirmed_at, s.id;
END;
$$;

-- Service-only accounting boundary; no actor and no HTTP handler.
CREATE FUNCTION private.list_shipment_accounting_inputs(_from date, _to date, _limit integer)
RETURNS TABLE(slip_id uuid, fulfillment_id uuid, order_item_id uuid, quantity integer, shipment_date date,
  revision_id uuid, cancelled_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to OR _limit IS NULL OR _limit < 1 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT s.id, f.id, fl.order_item_id, fl.quantity, f.shipment_date, h.id, f.cancelled_at
  FROM public.shipment_slips AS s JOIN public.shipment_slip_fulfillments AS sf ON sf.slip_id = s.id
  JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
  JOIN public.order_fulfillment_lines AS fl ON fl.fulfillment_id = f.id
  LEFT JOIN LATERAL (SELECT dh.id FROM public.shipment_date_history AS dh WHERE dh.slip_id = s.id
    ORDER BY dh.version DESC, dh.id DESC LIMIT 1) AS h ON true
  WHERE s.stage IN ('confirmed','cancelled') AND f.shipment_date BETWEEN _from AND _to
  ORDER BY f.shipment_date, s.id, f.id, fl.order_item_id LIMIT _limit;
END;
$$;

ALTER FUNCTION private.group_g_shipment_ready(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_shipment_ready(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_g_bundle_key(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_bundle_key(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_g_bundle_verdict(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_bundle_verdict(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.list_admin_packing(uuid,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_packing(uuid,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_packing(uuid,integer,integer,uuid) TO service_role;
ALTER FUNCTION private.list_admin_shipment_slips(text,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_shipment_slips(text,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_shipment_slips(text,integer,integer,uuid) TO service_role;
ALTER FUNCTION private.get_admin_shipment_slip(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_admin_shipment_slip(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_admin_shipment_slip(uuid,uuid) TO service_role;
ALTER FUNCTION private.list_admin_order_shipment_slips(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_order_shipment_slips(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_order_shipment_slips(uuid,uuid) TO service_role;
ALTER FUNCTION private.list_shipment_accounting_inputs(date,date,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_shipment_accounting_inputs(date,date,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_shipment_accounting_inputs(date,date,integer) TO service_role;

CREATE FUNCTION public.list_admin_packing(_slip_id uuid, _limit integer, _offset integer, _actor_id uuid)
RETURNS TABLE(order_id uuid, order_item_id uuid, order_created_at timestamptz, customer_name text,
  customer_email text, item_name text, color text, size text, ready_quantity integer, shippable_quantity integer,
  unit_price integer, is_exchange boolean, blocked_reasons text[], other_slip_numbers text[],
  selected_quantity integer, bundle_ok boolean, bundle_key text, total_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_admin_packing(_slip_id, _limit, _offset, _actor_id); $$;
ALTER FUNCTION public.list_admin_packing(uuid,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_packing(uuid,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_packing(uuid,integer,integer,uuid) TO service_role;

CREATE FUNCTION public.list_admin_shipment_slips(_stage text, _limit integer, _offset integer, _actor_id uuid)
RETURNS TABLE(id uuid, number text, stage text, version integer, expired boolean, shipment_date date,
  shipping_carrier text, tracking_number text, order_count integer, item_quantity integer,
  updated_at timestamptz, total_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_admin_shipment_slips(_stage, _limit, _offset, _actor_id); $$;
ALTER FUNCTION public.list_admin_shipment_slips(text,integer,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_shipment_slips(text,integer,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_shipment_slips(text,integer,integer,uuid) TO service_role;

CREATE FUNCTION public.get_admin_shipment_slip(_slip_id uuid, _actor_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_admin_shipment_slip(_slip_id, _actor_id); $$;
ALTER FUNCTION public.get_admin_shipment_slip(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_shipment_slip(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_shipment_slip(uuid,uuid) TO service_role;

CREATE FUNCTION public.list_admin_order_shipment_slips(_order_id uuid, _actor_id uuid)
RETURNS TABLE(slip_id uuid, number text, stage text, fulfillment_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_admin_order_shipment_slips(_order_id, _actor_id); $$;
ALTER FUNCTION public.list_admin_order_shipment_slips(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_order_shipment_slips(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_order_shipment_slips(uuid,uuid) TO service_role;

CREATE FUNCTION public.list_shipment_accounting_inputs(_from date, _to date, _limit integer)
RETURNS TABLE(slip_id uuid, fulfillment_id uuid, order_item_id uuid, quantity integer, shipment_date date,
  revision_id uuid, cancelled_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_shipment_accounting_inputs(_from, _to, _limit); $$;
ALTER FUNCTION public.list_shipment_accounting_inputs(date,date,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_shipment_accounting_inputs(date,date,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_shipment_accounting_inputs(date,date,integer) TO service_role;

-- Task 8 (FREQ-534-AC-04, FREQ-541-AC-03): the tracking parent. A shipment slip is registered with the carrier once per slip and
-- tracking version, by its leader shipment only (private.shipment_tracking_registrations.leader_fulfillment_id, the active shipment
-- with the smallest order id when the parent row is made). The other shipments of the slip (participants) never get a registration
-- row of their own. This helper names the shipment whose registration speaks for a shipment and a tracking version: the leader when
-- the slip of the shipment has a parent row of that version, the shipment itself otherwise (a shipment on no slip, or a version
-- without a parent row). Read-only internal helper: nobody but the owner can EXECUTE it.
CREATE FUNCTION private.tracking_registration_owner(_fulfillment_id uuid, _tracking_version integer)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT sr.leader_fulfillment_id
    FROM public.shipment_slip_fulfillments AS sf
    JOIN private.shipment_tracking_registrations AS sr
      ON sr.slip_id = sf.slip_id AND sr.tracking_version = _tracking_version
    WHERE sf.fulfillment_id = _fulfillment_id
  ), _fulfillment_id)
$$;
ALTER FUNCTION private.tracking_registration_owner(uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.tracking_registration_owner(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;

-- Replacement 1 of 3: turning delivery tracking on later makes registrations only for shipments that speak for themselves, so a
-- participant of a slip never gets one. The only added line is the last condition. Signature, volatility, search_path, owner and
-- ACL are unchanged.
CREATE OR REPLACE FUNCTION private.delivery_tracking_backfill_targets()
RETURNS TABLE (fulfillment_id uuid, tracking_version integer, expires_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT f.id,
         f.tracking_version,
         COALESCE(r.expires_at, s.started_at + interval '30 days')
  FROM public.order_fulfillments AS f
  LEFT JOIN public.order_fulfillment_tracking_changes AS c
    ON c.fulfillment_id = f.id AND c.tracking_version = f.tracking_version
  LEFT JOIN private.fulfillment_tracking_registrations AS r
    ON r.fulfillment_id = f.id AND r.tracking_version = f.tracking_version
  CROSS JOIN LATERAL (
    SELECT CASE WHEN f.tracking_version = 1 THEN f.shipped_at ELSE c.changed_at END AS started_at
  ) AS s
  WHERE f.cancelled_at IS NULL
    AND f.delivered_at IS NULL
    AND f.shipping_carrier IN ('yamato', 'sagawa', 'japanpost')
    AND f.tracking_number IS NOT NULL
    AND (r.fulfillment_id IS NULL OR (r.state = 'stopped' AND r.stop_reason = 'disabled'))
    AND COALESCE(r.expires_at, s.started_at + interval '30 days') > pg_catalog.now()
    AND private.tracking_registration_owner(f.id, f.tracking_version) = f.id
$$;

-- Replacement 2 of 3: the admin view of one order. A participant shows the registration of its leader. The only changed line is the
-- registration lookup (r.fulfillment_id = the owner). A shipment on no slip is its own owner, so its output is identical.
CREATE OR REPLACE FUNCTION public.get_order_delivery_detail(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enabled boolean;
BEGIN
  IF _order_id IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id) THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1;

  RETURN pg_catalog.jsonb_build_object(
    'enabled', COALESCE(v_enabled, false),
    'fulfillments', COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'fulfillment_id', f.id,
          'number', f.number,
          'carrier', f.shipping_carrier,
          'tracking_number', f.tracking_number,
          'notify_customer', f.notify_customer,
          'shipped_at', f.shipped_at,
          'cancelled_at', f.cancelled_at,
          'tracking_version', f.tracking_version,
          'delivery_status', f.delivery_status,
          'delivery_status_at', f.delivery_status_at,
          'delivered_at', f.delivered_at,
          'delivered_source', CASE
            WHEN f.delivered_at IS NULL THEN NULL
            WHEN EXISTS (
              SELECT 1
              FROM public.order_fulfillment_events AS m
              WHERE m.fulfillment_id = f.id
                AND m.tracking_version = f.tracking_version
                AND m.source = 'manual'
                AND m.status = 'delivered'
            ) THEN 'manual'
            ELSE 'tracking'
          END,
          'registration', (
            SELECT pg_catalog.jsonb_build_object(
                     'state', r.state,
                     'failure_kind', r.failure_kind,
                     'stop_reason', r.stop_reason,
                     'expires_at', r.expires_at,
                     'ever_registered', r.ever_registered
                   )
            FROM private.fulfillment_tracking_registrations AS r
            WHERE r.fulfillment_id = private.tracking_registration_owner(f.id, f.tracking_version)
              AND r.tracking_version = f.tracking_version
          ),
          'events', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'id', e.id,
                       'tracking_version', e.tracking_version,
                       'status', e.status,
                       'happened_at', e.happened_at,
                       'recorded_at', e.recorded_at,
                       'source', e.source,
                       'provider_sub_status', e.provider_sub_status,
                       'actor_email', eu.email::text
                     )
                     ORDER BY e.tracking_version DESC, e.happened_at DESC, e.recorded_at DESC, e.id
                   )
            FROM public.order_fulfillment_events AS e
            LEFT JOIN auth.users AS eu ON eu.id = e.created_by
            WHERE e.fulfillment_id = f.id
          ), '[]'::jsonb),
          'tracking_changes', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'id', c.id,
                       'from_carrier', c.from_carrier,
                       'from_tracking_number', c.from_tracking_number,
                       'to_carrier', c.to_carrier,
                       'to_tracking_number', c.to_tracking_number,
                       'tracking_version', c.tracking_version,
                       'notify_customer', c.notify_customer,
                       'changed_at', c.changed_at,
                       'actor_email', cu.email::text,
                       'email_status', (
                         SELECT m.status
                         FROM private.order_email_outbox AS m
                         WHERE m.tracking_change_id = c.id
                           AND m.kind = 'shipping_update'
                           AND m.origin = 'auto'
                         ORDER BY m.seq DESC
                         LIMIT 1
                       )
                     )
                     ORDER BY c.changed_at DESC, c.id
                   )
            FROM public.order_fulfillment_tracking_changes AS c
            LEFT JOIN auth.users AS cu ON cu.id = c.changed_by
            WHERE c.fulfillment_id = f.id
          ), '[]'::jsonb)
        )
        ORDER BY f.number
      )
      FROM public.order_fulfillments AS f
      WHERE f.order_id = _order_id
    ), '[]'::jsonb)
  );
END;
$$;

-- Replacement 3 of 3: the public status material of one order, same single change. The leader registration carries a state and a
-- flag only; no order number or item of another order of the slip appears in the output.
CREATE OR REPLACE FUNCTION public.get_order_status_public_material(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order jsonb;
BEGIN
  IF _order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'id', o.id,
    'created_at', o.created_at,
    'status', o.status,
    'subtotal_amount', o.subtotal_amount,
    'shipping_amount', o.shipping_amount,
    'discount_amount', o.discount_amount,
    'total_amount', o.total_amount,
    'currency', o.currency,
    'order_items', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', oi.id,
        'item_id', oi.item_id,
        'variant_id', oi.variant_id,
        'item_name', oi.item_name,
        'item_image_url', oi.item_image_url,
        'color', oi.color,
        'size', oi.size,
        'quantity', oi.quantity,
        'line_total', oi.line_total,
        'line_kind', oi.line_kind
      ) ORDER BY oi.created_at, oi.id)
      FROM public.order_items AS oi
      WHERE oi.order_id = o.id
    ), '[]'::jsonb)
  ) INTO v_order
  FROM public.orders AS o
  WHERE o.id = _order_id
    AND o.status NOT IN ('payment_in_progress', 'abandoned');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order', v_order,
    'line_rows', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'order_id', _order_id,
        'order_item_id', l.order_item_id,
        'variant_id', l.variant_id,
        'fulfillment_type', l.fulfillment_type,
        'quantity', l.quantity,
        'shipped', l.shipped,
        'completed', l.completed,
        'refunded_before_shipment', l.refunded_before_shipment,
        'refunded_after_shipment', l.refunded_after_shipment,
        'in_production', l.in_production,
        'ready_unshipped', l.ready_unshipped,
        'unshipped', l.unshipped
      ) ORDER BY l.order_item_id)
      FROM private.order_line_fulfillment(_order_id) AS l
    ), '[]'::jsonb),
    'fulfillments', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'fulfillment_id', f.id,
        'number', f.number,
        'shipping_carrier', f.shipping_carrier,
        'shipped_at', f.shipped_at,
        'cancelled_at', f.cancelled_at,
        'lines', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'order_item_id', fl.order_item_id, 'quantity', fl.quantity
          ) ORDER BY fl.order_item_id)
          FROM public.order_fulfillment_lines AS fl
          WHERE fl.fulfillment_id = f.id
        ), '[]'::jsonb)
      ) ORDER BY f.number)
      FROM public.order_fulfillments AS f
      WHERE f.order_id = _order_id
    ), '[]'::jsonb),
    'delivery_detail', pg_catalog.jsonb_build_object(
      'enabled', COALESCE((
        SELECT s.delivery_tracking_enabled FROM public.shop_settings AS s WHERE s.id = 1
      ), false),
      'fulfillments', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'fulfillment_id', f.id,
          'cancelled_at', f.cancelled_at,
          'tracking_version', f.tracking_version,
          'delivery_status', f.delivery_status,
          'delivery_status_at', f.delivery_status_at,
          'delivered_at', f.delivered_at,
          'registration', (
            SELECT pg_catalog.jsonb_build_object('state', r.state, 'ever_registered', r.ever_registered)
            FROM private.fulfillment_tracking_registrations AS r
            WHERE r.fulfillment_id = private.tracking_registration_owner(f.id, f.tracking_version)
              AND r.tracking_version = f.tracking_version
          ),
          'events', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'tracking_version', e.tracking_version,
              'status', e.status,
              'happened_at', e.happened_at,
              'recorded_at', e.recorded_at
            ) ORDER BY e.happened_at DESC, e.recorded_at DESC, e.id)
            FROM public.order_fulfillment_events AS e
            WHERE e.fulfillment_id = f.id
              AND e.tracking_version = f.tracking_version
          ), '[]'::jsonb)
        ) ORDER BY f.number)
        FROM public.order_fulfillments AS f
        WHERE f.order_id = _order_id
      ), '[]'::jsonb)
    ),
    'delivery_summary', (
      SELECT pg_catalog.jsonb_build_object(
        'active_count', (pg_catalog.count(*) FILTER (WHERE f.cancelled_at IS NULL))::integer,
        'delivered_count', (pg_catalog.count(*) FILTER (WHERE f.cancelled_at IS NULL AND f.delivered_at IS NOT NULL))::integer
      )
      FROM public.order_fulfillments AS f
      WHERE f.order_id = _order_id
    ),
    'refund_rows', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'refund_id', r.id, 'created_at', r.created_at, 'amount', r.amount, 'status', r.status
      ) ORDER BY r.created_at DESC, r.id DESC)
      FROM public.order_refunds AS r
      WHERE r.order_id = _order_id
    ), '[]'::jsonb)
  );
END;
$$;
-- G3B_BODY_END

-- G3B_FINAL_ASSERT_BEGIN
DO $g3b_final_objects$
DECLARE
  v record;
  v_proc record;
  v_oid oid;
  v_detail text;
  v_names text[] := ARRAY['group_g_shipment_ready','group_g_bundle_verdict','group_g_bundle_key',
    'list_admin_packing','list_admin_shipment_slips','get_admin_shipment_slip',
    'list_admin_order_shipment_slips','list_shipment_accounting_inputs'];
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.proname = ANY(v_names[4:8])) <> 10 THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'shipping_read_functions';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.proname = ANY(v_names[1:3] || ARRAY['tracking_registration_owner'])) <> 4
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY(v_names[1:3] || ARRAY['tracking_registration_owner'])) THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'shipping_internal_functions';
  END IF;
  FOR v IN SELECT * FROM (VALUES
    ('private.tracking_registration_owner(uuid,integer)', true, false, ARRAY['_fulfillment_id','_tracking_version']::text[], ARRAY[]::text[], ARRAY[]::text[], 'uuid', ''),
    ('private.group_g_shipment_ready(uuid[])', true, false, ARRAY['_order_ids']::text[], ARRAY['order_id','order_item_id','ready','shippable','blocked_reasons']::text[], ARRAY['uuid','uuid','integer','integer','text[]']::text[], 'record', ''),
    ('private.group_g_bundle_key(uuid)', true, false, ARRAY['_order_id']::text[], ARRAY[]::text[], ARRAY[]::text[], 'text', ''),
    ('private.group_g_bundle_verdict(uuid[])', true, false, ARRAY['_order_ids']::text[], ARRAY[]::text[], ARRAY[]::text[], 'text', ''),
    ('private.list_admin_packing(uuid,integer,integer,uuid)', true, true, ARRAY['_slip_id','_limit','_offset','_actor_id']::text[], ARRAY['order_id','order_item_id','order_created_at','customer_name','customer_email','item_name','color','size','ready_quantity','shippable_quantity','unit_price','is_exchange','blocked_reasons','other_slip_numbers','selected_quantity','bundle_ok','bundle_key','total_count']::text[], ARRAY['uuid','uuid','timestamptz','text','text','text','text','text','integer','integer','integer','boolean','text[]','text[]','integer','boolean','text','bigint']::text[], 'record', ''),
    ('public.list_admin_packing(uuid,integer,integer,uuid)', false, true, ARRAY['_slip_id','_limit','_offset','_actor_id']::text[], ARRAY['order_id','order_item_id','order_created_at','customer_name','customer_email','item_name','color','size','ready_quantity','shippable_quantity','unit_price','is_exchange','blocked_reasons','other_slip_numbers','selected_quantity','bundle_ok','bundle_key','total_count']::text[], ARRAY['uuid','uuid','timestamptz','text','text','text','text','text','integer','integer','integer','boolean','text[]','text[]','integer','boolean','text','bigint']::text[], 'record', 'select*fromprivate.list_admin_packing(_slip_id,_limit,_offset,_actor_id);'),
    ('private.list_admin_shipment_slips(text,integer,integer,uuid)', true, true, ARRAY['_stage','_limit','_offset','_actor_id']::text[], ARRAY['id','number','stage','version','expired','shipment_date','shipping_carrier','tracking_number','order_count','item_quantity','updated_at','total_count']::text[], ARRAY['uuid','text','text','integer','boolean','date','text','text','integer','integer','timestamptz','bigint']::text[], 'record', ''),
    ('public.list_admin_shipment_slips(text,integer,integer,uuid)', false, true, ARRAY['_stage','_limit','_offset','_actor_id']::text[], ARRAY['id','number','stage','version','expired','shipment_date','shipping_carrier','tracking_number','order_count','item_quantity','updated_at','total_count']::text[], ARRAY['uuid','text','text','integer','boolean','date','text','text','integer','integer','timestamptz','bigint']::text[], 'record', 'select*fromprivate.list_admin_shipment_slips(_stage,_limit,_offset,_actor_id);'),
    ('private.get_admin_shipment_slip(uuid,uuid)', true, true, ARRAY['_slip_id','_actor_id']::text[], ARRAY[]::text[], ARRAY[]::text[], 'jsonb', ''),
    ('public.get_admin_shipment_slip(uuid,uuid)', false, true, ARRAY['_slip_id','_actor_id']::text[], ARRAY[]::text[], ARRAY[]::text[], 'jsonb', 'selectprivate.get_admin_shipment_slip(_slip_id,_actor_id);'),
    ('private.list_admin_order_shipment_slips(uuid,uuid)', true, true, ARRAY['_order_id','_actor_id']::text[], ARRAY['slip_id','number','stage','fulfillment_id']::text[], ARRAY['uuid','text','text','uuid']::text[], 'record', ''),
    ('public.list_admin_order_shipment_slips(uuid,uuid)', false, true, ARRAY['_order_id','_actor_id']::text[], ARRAY['slip_id','number','stage','fulfillment_id']::text[], ARRAY['uuid','text','text','uuid']::text[], 'record', 'select*fromprivate.list_admin_order_shipment_slips(_order_id,_actor_id);'),
    ('private.list_shipment_accounting_inputs(date,date,integer)', true, true, ARRAY['_from','_to','_limit']::text[], ARRAY['slip_id','fulfillment_id','order_item_id','quantity','shipment_date','revision_id','cancelled_at']::text[], ARRAY['uuid','uuid','uuid','integer','date','uuid','timestamptz']::text[], 'record', ''),
    ('public.list_shipment_accounting_inputs(date,date,integer)', false, true, ARRAY['_from','_to','_limit']::text[], ARRAY['slip_id','fulfillment_id','order_item_id','quantity','shipment_date','revision_id','cancelled_at']::text[], ARRAY['uuid','uuid','uuid','integer','date','uuid','timestamptz']::text[], 'record', 'select*fromprivate.list_shipment_accounting_inputs(_from,_to,_limit);')
  ) AS expected(signature, definer, executable, input_names, output_names, output_types, result_type, delegate)
  LOOP
    v_detail := CASE WHEN v.executable THEN 'shipping_read_functions' ELSE 'shipping_internal_functions' END;
    v_oid := pg_catalog.to_regprocedure(v.signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_detail;
    END IF;
    SELECT f.*, l.lanname INTO v_proc FROM pg_catalog.pg_proc AS f
      JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang WHERE f.oid = v_oid;
    IF v_proc.proowner <> 'postgres'::regrole OR v_proc.prosecdef IS DISTINCT FROM v.definer
      OR v_proc.provolatile <> 's' OR v_proc.prokind <> 'f' OR v_proc.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR v_proc.prorettype <> v.result_type::regtype OR v_proc.proretset IS DISTINCT FROM (pg_catalog.cardinality(v.output_names) > 0)
      OR v_proc.proargnames IS DISTINCT FROM (v.input_names || v.output_names)
      OR (pg_catalog.cardinality(v.output_names) > 0 AND (
        v_proc.proallargtypes[v_proc.pronargs+1:pg_catalog.cardinality(v_proc.proallargtypes)] IS DISTINCT FROM
          ARRAY(SELECT t::regtype::oid FROM pg_catalog.unnest(v.output_types) AS t)
        OR v_proc.proargmodes IS DISTINCT FROM
          (pg_catalog.array_fill('i'::"char",ARRAY[v_proc.pronargs::integer]) ||
           pg_catalog.array_fill('t'::"char",ARRAY[pg_catalog.cardinality(v.output_names)]))))
      OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') IS DISTINCT FROM v.executable
      OR NOT pg_catalog.has_function_privilege('postgres', v_oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(v_proc.proacl,pg_catalog.acldefault('f',v_proc.proowner))) AS a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
      OR (NOT v.definer AND (v_proc.lanname <> 'sql' OR
        pg_catalog.regexp_replace(pg_catalog.lower(v_proc.prosrc),'\s','','g') <> v.delegate)) THEN
      RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_detail;
    END IF;
  END LOOP;
END;
$g3b_final_objects$;

-- Task 8: the tracking parent helper and the three replaced readers keep owner, SECURITY, volatility, search_path and ACL, and every
-- reader resolves the registration through the helper (the single changed line is still in place). DETAIL names the group only.
DO $g3b_tracking_parent$
DECLARE
  v_failed text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('private.delivery_tracking_backfill_targets()', false, 'sql', false),
      ('public.get_order_delivery_detail(uuid)', true, 'plpgsql', true),
      ('public.get_order_status_public_material(uuid)', true, 'plpgsql', true)
    ) AS e(sig, definer, lang, service)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    WHERE p.oid IS NULL
       OR p.proowner <> 'postgres'::regrole
       OR p.prosecdef <> e.definer
       OR p.provolatile <> 's'
       OR p.prolang <> (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = e.lang)
       OR p.prorettype <> CASE WHEN e.sig = 'private.delivery_tracking_backfill_targets()' THEN 'record'::regtype ELSE 'jsonb'::regtype END
       OR p.proretset <> (e.sig = 'private.delivery_tracking_backfill_targets()')
       OR p.proargnames IS DISTINCT FROM CASE WHEN e.sig = 'private.delivery_tracking_backfill_targets()'
         THEN ARRAY['fulfillment_id','tracking_version','expires_at'] ELSE ARRAY['_order_id'] END
       OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
       OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') <> e.service
       OR NOT pg_catalog.has_function_privilege('postgres', p.oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  ) THEN
    v_failed := 'shipping_replaced_readers';
  ELSIF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY['public.get_order_delivery_detail(uuid)', 'public.get_order_status_public_material(uuid)']) AS w(sig)
    JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(w.sig)
    WHERE pg_catalog.strpos(p.prosrc, 'r.fulfillment_id = private.tracking_registration_owner(f.id, f.tracking_version)') = 0
       OR p.prosrc ~ '\mr\.fulfillment_id\s*=\s*f\.id'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    WHERE p.oid = pg_catalog.to_regprocedure('private.delivery_tracking_backfill_targets()')
      AND pg_catalog.strpos(p.prosrc, 'AND private.tracking_registration_owner(f.id, f.tracking_version) = f.id') > 0
  ) THEN
    v_failed := 'shipping_replaced_readers';
  END IF;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g3b_tracking_parent$;

-- G3B_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
