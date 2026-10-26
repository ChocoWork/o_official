BEGIN;

-- G4A_BODY_BEGIN
CREATE INDEX shipment_slip_fulfillments_order_idx ON public.shipment_slip_fulfillments (order_id);

CREATE OR REPLACE FUNCTION private.admin_confirm_shipment_slip(_slip_id uuid, _expected_version integer, _carrier text, _tracking_number text,
  _shipment_date date, _notify_customer boolean, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_existing private.group_g_operations%ROWTYPE;
  v_slip public.shipment_slips%ROWTYPE;
  v_fingerprint text;
  v_orders uuid[];
  v_items uuid[];
  v_before jsonb;
  v_order uuid;
  v_line record;
  v_lines jsonb;
  v_fulfillment uuid;
  v_quantity integer;
  v_number integer;
  v_completes boolean;
  v_payment_review boolean;
  v_exchange_fee boolean;
  v_address boolean;
  v_unshippable boolean;
  v_exceeds boolean;
  v_verdict text;
  v_version integer;
  v_fulfillments jsonb := '[]'::jsonb;
  v_result jsonb;
  v_previous_operation text;
  v_previous_actor text;
  v_previous_reason text;
  v_previous_change text;
BEGIN
  _tracking_number := NULLIF(pg_catalog.btrim(_tracking_number), '');
  IF _slip_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL
    OR _shipment_date IS NULL OR _notify_customer IS NULL
    OR (_carrier IS NOT NULL AND _carrier NOT IN ('yamato','sagawa','japanpost'))
    OR (_tracking_number IS NOT NULL AND _tracking_number !~ '^[0-9A-Za-z-]{1,64}$') THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (_carrier IS NULL) <> (_tracking_number IS NULL) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_TRACKING_INCOMPLETE' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
    ARRAY['admin.shipping.manage','admin.shipping.read','admin.orders.manage','admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_slip FROM public.shipment_slips AS s WHERE s.id = _slip_id;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_slip_confirm', 'slip_id', _slip_id, 'carrier', _carrier, 'tracking_number', _tracking_number,
    'shipment_date', _shipment_date, 'notify_customer', _notify_customer, 'lines', v_slip.draft_lines, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_slip_confirm' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;
  IF v_slip.id IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_slip.stage <> 'draft' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_DRAFT' USING ERRCODE = '55000';
  END IF;
  IF v_slip.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF v_slip.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_DRAFT_EXPIRED' USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.jsonb_array_length(v_slip.draft_lines) = 0 THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_EMPTY' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(d."orderItemId" ORDER BY d."orderItemId") INTO v_items
    FROM pg_catalog.jsonb_to_recordset(v_slip.draft_lines) AS d("orderItemId" uuid, quantity integer);
  SELECT pg_catalog.array_agg(DISTINCT oi.order_id ORDER BY oi.order_id) INTO v_orders
    FROM public.order_items AS oi WHERE oi.id = ANY(v_items);
  IF (SELECT pg_catalog.count(*) FROM public.order_items AS oi WHERE oi.id = ANY(v_items)) <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- (1) every order is paid
  IF EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = ANY(v_orders) AND o.status <> 'paid') THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;
  -- (2) the blocked reasons and (4) the quantities come from the same single evaluation of group_g_shipment_ready
  WITH ready AS MATERIALIZED (
    SELECT r.order_item_id, r.shippable, r.blocked_reasons
    FROM private.group_g_shipment_ready(v_orders) AS r WHERE r.order_item_id = ANY(v_items)
  ), wanted AS (
    SELECT (e.value ->> 'orderItemId')::uuid AS item_id, (e.value ->> 'quantity')::integer AS quantity
    FROM pg_catalog.jsonb_array_elements(v_slip.draft_lines) AS e(value)
  )
  SELECT COALESCE((SELECT pg_catalog.bool_or('payment_review' = ANY(r.blocked_reasons)) FROM ready AS r), false),
         COALESCE((SELECT pg_catalog.bool_or('exchange_fee_waiting' = ANY(r.blocked_reasons)) FROM ready AS r), false),
         COALESCE((SELECT pg_catalog.bool_or('address_incomplete' = ANY(r.blocked_reasons)) FROM ready AS r), false),
         COALESCE((SELECT pg_catalog.bool_or('variant_missing' = ANY(r.blocked_reasons) OR 'paid_at_missing' = ANY(r.blocked_reasons))
                   FROM ready AS r), false),
         EXISTS (SELECT 1 FROM wanted AS w LEFT JOIN ready AS r ON r.order_item_id = w.item_id
                 WHERE w.quantity > COALESCE(r.shippable, 0))
    INTO v_payment_review, v_exchange_fee, v_address, v_unshippable, v_exceeds;
  IF v_payment_review THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED' USING ERRCODE = '22023';
  ELSIF v_exchange_fee THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_EXCHANGE_ON_HOLD' USING ERRCODE = '22023';
  ELSIF v_address THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ADDRESS_INCOMPLETE' USING ERRCODE = '22023';
  ELSIF v_unshippable THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;
  -- (3) the bundle verdict
  v_verdict := private.group_g_bundle_verdict(v_orders);
  IF v_verdict = 'customer_mismatch' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_CUSTOMER_MISMATCH' USING ERRCODE = '22023';
  ELSIF v_verdict = 'address_mismatch' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ADDRESS_MISMATCH' USING ERRCODE = '22023';
  ELSIF v_verdict IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ADDRESS_INCOMPLETE' USING ERRCODE = '22023';
  END IF;
  -- (4) the quantities
  IF v_exceeds THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY' USING ERRCODE = '22023';
  END IF;

  -- (5) All included orders' first payment dates bound the same JST calendar date.
  IF _shipment_date > (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date OR EXISTS (
    SELECT 1 FROM public.orders AS o WHERE o.id = ANY(v_orders)
      AND (o.paid_at IS NULL OR (o.paid_at AT TIME ZONE 'Asia/Tokyo')::date > _shipment_date)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SHIPMENT_DATE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  v_previous_operation := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_previous_actor := pg_catalog.current_setting('app.order_actor_id', true);
  v_previous_reason := pg_catalog.current_setting('app.order_change_reason', true);
  v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  BEGIN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
    FOREACH v_order IN ARRAY v_orders LOOP
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id', d."orderItemId", 'quantity', d.quantity)
        ORDER BY d."orderItemId"), pg_catalog.sum(d.quantity) INTO v_lines, v_quantity
      FROM pg_catalog.jsonb_to_recordset(v_slip.draft_lines) AS d("orderItemId" uuid, quantity integer)
      JOIN public.order_items AS oi ON oi.id = d."orderItemId" WHERE oi.order_id = v_order;
      SELECT COALESCE(pg_catalog.sum(f.unshipped), 0) - v_quantity = 0 INTO v_completes
        FROM private.order_line_fulfillment(v_order) AS f;
      SELECT COALESCE(pg_catalog.max(f.number), 0) + 1 INTO v_number FROM public.order_fulfillments AS f WHERE f.order_id = v_order;
      INSERT INTO public.order_fulfillments(order_id, number, request_key, shipping_carrier, tracking_number,
        notify_customer, completes_order, created_by, shipped_at, delivery_status_at, request_fingerprint, shipment_date)
      VALUES(v_order, v_number, pg_catalog.md5('slip_fulfillment:' || _request_key::text || ':' || v_order::text)::uuid,
        _carrier, _tracking_number, _notify_customer, v_completes, _actor_id, pg_catalog.now(), pg_catalog.now(),
        private.fulfillment_create_fingerprint(v_order, _carrier, _tracking_number, _notify_customer, v_lines), _shipment_date)
      RETURNING id INTO v_fulfillment;
      -- G-1 checks shipped + remaining paid allocations immediately after each line INSERT.
      -- Consume first so no statement double-counts the same units; the deferred G-3 guard
      -- checks the final line/consume balance, including any rollback of a later order.
      FOR v_line IN SELECT d.* FROM pg_catalog.jsonb_to_recordset(v_lines) AS d(order_item_id uuid, quantity integer)
        ORDER BY d.order_item_id LOOP
        PERFORM private.consume_group_g_allocations(v_line.order_item_id, v_line.quantity, v_operation, _actor_id);
        INSERT INTO public.order_fulfillment_lines(fulfillment_id, order_item_id, quantity)
          VALUES(v_fulfillment, v_line.order_item_id, v_line.quantity);
      END LOOP;
      INSERT INTO public.order_fulfillment_events(fulfillment_id, tracking_version, status, happened_at, source)
        VALUES(v_fulfillment, 1, 'confirmed', pg_catalog.now(), 'shipment');
      INSERT INTO public.shipment_slip_fulfillments(slip_id, order_id, fulfillment_id) VALUES(_slip_id, v_order, v_fulfillment);
      IF v_completes THEN
        PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
        PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_create_fulfillment', true);
        UPDATE public.orders SET status = 'shipped'::public.order_status, shipped_at = pg_catalog.now(),
          shipping_carrier = _carrier, tracking_number = _tracking_number WHERE id = v_order;
      END IF;
      IF _notify_customer THEN
        PERFORM private.enqueue_order_email(v_order, 'shipped', NULL, v_fulfillment);
      END IF;
      v_fulfillments := v_fulfillments || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'orderId', v_order::text, 'fulfillmentId', v_fulfillment::text, 'number', v_number, 'completesOrder', v_completes));
    END LOOP;
    IF _tracking_number IS NOT NULL THEN
      PERFORM private.register_group_g_slip_tracking(_slip_id, 1, _actor_id, v_operation);
    END IF;
    PERFORM pg_catalog.set_config('app.group_g_slip_change', 'confirm', true);
    UPDATE public.shipment_slips SET stage = 'confirmed', confirmed_at = pg_catalog.now(), confirmed_by = _actor_id,
      confirm_operation_id = v_operation, confirm_request_key = _request_key, shipping_carrier = _carrier,
      tracking_number = _tracking_number, notify_customer = _notify_customer, shipment_date = _shipment_date,
      expires_at = NULL, version = version + 1, updated_at = pg_catalog.now()
      WHERE id = _slip_id RETURNING version INTO v_version;
    INSERT INTO public.shipment_slip_lines(slip_id, order_item_id, quantity)
      SELECT _slip_id, d."orderItemId", d.quantity FROM pg_catalog.jsonb_to_recordset(v_slip.draft_lines) AS d("orderItemId" uuid, quantity integer);
    INSERT INTO public.shipment_slip_versions(slip_id, version, kind, shipping_carrier, tracking_number, tracking_version, shipment_date, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'confirm', _carrier, _tracking_number, 1, _shipment_date, _actor_id, v_operation);
    INSERT INTO public.shipment_date_history(slip_id, version, kind, previous_date, new_date, reason, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'initial', (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date, _shipment_date, NULL, _actor_id, v_operation);
    PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'shipment_slip_confirm', _actor_id);
    v_result := pg_catalog.jsonb_build_object('id', _slip_id::text, 'number', v_slip.number, 'version', v_version,
      'shipmentDate', _shipment_date::text, 'fulfillments', v_fulfillments, 'replayed', false);
    INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
      VALUES(v_operation, 'shipment_slip_confirm', _request_key, v_fingerprint, 'shipment_slip', _slip_id::text, _actor_id, v_result);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
    PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_previous_actor, ''), true);
    PERFORM pg_catalog.set_config('app.order_change_reason', COALESCE(v_previous_reason, ''), true);
    PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_previous_actor, ''), true);
  PERFORM pg_catalog.set_config('app.order_change_reason', COALESCE(v_previous_reason, ''), true);
  PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
  RETURN v_result;
END;
$$;

ALTER TABLE public.order_item_allocation_events DROP CONSTRAINT order_item_allocation_events_reason_check;
ALTER TABLE public.order_item_allocation_events ADD CONSTRAINT order_item_allocation_events_reason_check CHECK (
  reason IS NULL OR reason IN (
    'fifo','checkout','stripe_payment_paid','stock_adjustment','refund_restock','refund_release',
    'stripe_checkout_expired','stripe_voucher_expired','admin_cancel','admin_cancel_failed_order',
    'resolve_payment_exception','status_change','fixture_allocation','fixture_release','fixture_shipment',
    'shipment_confirm','shipment_cancel','allocation_swap'
  )
);
-- G4A_BODY_END

-- G4A_FINAL_ASSERT_BEGIN
-- Catalog meaning only; no environment-dependent ACL serialization or existing-row totals.
DO $g4a_final_objects$
DECLARE
  v_failed text;
  v_body text;
  v_reason_expr text;
BEGIN
  SELECT pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:]]+', ' ', 'g') INTO v_body
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = pg_catalog.to_regprocedure('private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)');
  SELECT pg_catalog.pg_get_expr(c.conbin,c.conrelid) INTO v_reason_expr
    FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.order_item_allocation_events'::regclass
      AND c.conname = 'order_item_allocation_events_reason_check' AND c.contype = 'c' AND c.convalidated;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS i
    JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indexrelid = pg_catalog.to_regclass('public.shipment_slip_fulfillments_order_idx')
      AND i.indrelid = 'public.shipment_slip_fulfillments'::regclass
      AND c.relkind = 'i' AND am.amname = 'btree'
      AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique
      AND i.indnatts = 1 AND i.indnkeyatts = 1 AND a.attname = 'order_id' AND NOT a.attisdropped
      AND i.indexprs IS NULL AND i.indpred IS NULL
  ) THEN
    v_failed := 'orders_foundation_index';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    WHERE p.oid = pg_catalog.to_regprocedure('private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)')
      AND p.proowner = 'postgres'::regrole AND p.prosecdef
      AND p.prolang = (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = 'plpgsql')
      AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset AND p.provolatile = 'v'
      AND COALESCE(p.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=""']
      AND pg_catalog.has_function_privilege('postgres',p.oid,'EXECUTE')
      AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS x
        WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  ) OR v_body IS NULL
    OR pg_catalog.strpos(v_body,'v_slip.expires_at <= pg_catalog.now()') = 0
    OR pg_catalog.strpos(v_body,'v_slip.expires_at < pg_catalog.now()') > 0
    OR pg_catalog.strpos(v_body,'lock_group_g_shipment_slips(') = 0
    OR pg_catalog.split_part(v_body,'lock_group_g_shipment_slips(',1)
      ~ '\m(from|join|update|insert|delete|truncate)\M' THEN
    v_failed := 'orders_foundation_confirm';
  ELSIF v_reason_expr IS NULL
    OR (SELECT pg_catalog.array_agg(m[1] ORDER BY m[1])
      FROM pg_catalog.regexp_matches(v_reason_expr, '''([^'']+)''', 'g') AS x(m))
      IS DISTINCT FROM (SELECT pg_catalog.array_agg(r ORDER BY r) FROM pg_catalog.unnest(ARRAY[
    'fifo','checkout','stripe_payment_paid','stock_adjustment','refund_restock','refund_release',
    'stripe_checkout_expired','stripe_voucher_expired','admin_cancel','admin_cancel_failed_order',
    'resolve_payment_exception','status_change','fixture_allocation','fixture_release','fixture_shipment',
    'shipment_confirm','shipment_cancel','allocation_swap'
      ]) AS e(r))
    OR pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(v_reason_expr, 'ARRAY\[[^]]*\]', 'reasons', 'g'), '[[:space:]()]|::text', '', 'g')
      <> 'reasonISNULLORreason=ANYreasons' THEN
    v_failed := 'orders_foundation_reasons';
  ELSIF EXISTS (SELECT 1 FROM public.order_item_allocation_events WHERE created_at = pg_catalog.transaction_timestamp())
    OR EXISTS (SELECT 1 FROM public.shipment_slips WHERE created_at = pg_catalog.transaction_timestamp()) THEN
    v_failed := 'orders_foundation_rows';
  ELSIF pg_catalog.cardinality(private.group_g_writer_allowlist()) IS DISTINCT FROM 75 THEN
    v_failed := 'orders_foundation_allowlist';
  END IF;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g4a_final_objects$;
-- G4A_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
