-- G-3 shipment-slip writers (Task 4 and later G-3 tasks): the lock helper for every shipment-slip writer, saving a draft
-- (create / replace the selected lines) and discarding a draft (FREQ-531-AC-03, FREQ-532, FREQ-533-AC-01, FREQ-540-AC-10,
-- FREQ-540-AC-11), confirming a slip (Task 5), cancelling a whole slip with a single restore (Task 6: FREQ-533-AC-04,
-- FREQ-534-AC-03), and the writer allowlist (65 G-1/G-2 entries + the writers of this file). Later G-3 tasks extend the body
-- section of this file while it is not applied anywhere. Always applied after 20261025070821_group_g3_shipping_reads.sql.
BEGIN;

-- G3C_BODY_BEGIN

-- 1. Lock helper for every shipment-slip writer. The common advisory (190521,1) is the very first statement; the targets are
--    only discovered by reads after it (the same rule as lock_group_g_inventory and lock_group_g_purchase_orders). Order:
--    advisory -> shop_settings (FOR SHARE, only when the caller touches tracking) -> reads that close the set of orders and
--    variants (the items of _order_item_ids, the draft selection and the lines of the slips, the orders of their shipments)
--    -> lock_group_g_inventory (re-entrant advisory; its result, the locked order ids ascending, is kept and returned) ->
--    the slips (id ascending) -> when tracking is touched, the registrations of the slips' shipments ((fulfillment_id,
--    tracking_version) ascending). A caller must never add targets afterwards and go back to an earlier stage.
--    Internal helper: nobody but the owner can EXECUTE it.
CREATE FUNCTION private.lock_group_g_shipment_slips(_slip_ids uuid[], _order_item_ids uuid[], _with_settings boolean)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_orders uuid[];
  v_variants bigint[];
  v_locked uuid[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  IF _with_settings IS TRUE THEN
    PERFORM s.id FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;
  END IF;
  WITH targets AS (
    SELECT oi.order_id, oi.variant_id FROM public.order_items AS oi WHERE oi.id = ANY(_order_item_ids)
    UNION
    SELECT oi.order_id, oi.variant_id FROM public.shipment_slips AS s
      CROSS JOIN LATERAL pg_catalog.jsonb_to_recordset(s.draft_lines) AS d("orderItemId" uuid)
      JOIN public.order_items AS oi ON oi.id = d."orderItemId"
      WHERE s.id = ANY(_slip_ids)
    UNION
    SELECT oi.order_id, oi.variant_id FROM public.shipment_slip_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id
      WHERE l.slip_id = ANY(_slip_ids)
    UNION
    SELECT sf.order_id, NULL::bigint FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = ANY(_slip_ids)
  )
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT t.order_id ORDER BY t.order_id), ARRAY[]::uuid[]),
         COALESCE(pg_catalog.array_agg(DISTINCT t.variant_id ORDER BY t.variant_id) FILTER (WHERE t.variant_id IS NOT NULL),
                  ARRAY[]::bigint[])
    INTO v_orders, v_variants
  FROM targets AS t;
  v_locked := private.lock_group_g_inventory(v_variants, v_orders, NULL);
  PERFORM s.id FROM public.shipment_slips AS s WHERE s.id = ANY(_slip_ids) ORDER BY s.id FOR UPDATE;
  IF _with_settings IS TRUE THEN
    PERFORM r.fulfillment_id FROM private.fulfillment_tracking_registrations AS r
      WHERE r.fulfillment_id IN (SELECT sf.fulfillment_id FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = ANY(_slip_ids))
      ORDER BY r.fulfillment_id, r.tracking_version FOR UPDATE;
  END IF;
  RETURN v_locked;
END;
$$;
ALTER FUNCTION private.lock_group_g_shipment_slips(uuid[],uuid[],boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_group_g_shipment_slips(uuid[],uuid[],boolean) FROM PUBLIC, anon, authenticated, service_role;

-- 2. Save a shipment-slip draft (FREQ-531-AC-03). _slip_id NULL creates a new draft (_expected_version must be NULL); a
--    non-NULL _slip_id replaces the whole selection of that draft (_expected_version is then required).
--    _lines = [{"orderItemId": <uuid>, "quantity": <int>}], 1 to 100 lines, an item at most once, each element has exactly
--    those two keys, quantity 1 to 99999 as a plain integer. [] is GROUP_G_SLIP_EMPTY, any other shape problem is
--    GROUP_G_ARGUMENT_INVALID (both 22023).
--    Order of work: argument check (22023) -> lock helper (advisory first, nothing else read before it) -> permission check
--    (the four shipping/orders manage + read codes, 42501) -> fingerprint and replay / conflict (23505) -> existence of the
--    slip (P0002) -> stage must be draft (GROUP_G_SLIP_NOT_DRAFT) -> version (GROUP_G_SLIP_VERSION_CONFLICT) -> existence of
--    the items (22023) -> each order is judged in this order and the first violation is returned: (1) status must be paid
--    (GROUP_G_SLIP_ORDER_NOT_SHIPPABLE), (2) the blocked reasons of group_g_shipment_ready by priority payment_review ->
--    GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED, exchange_fee_waiting -> GROUP_G_SLIP_EXCHANGE_ON_HOLD, address_incomplete ->
--    GROUP_G_SLIP_ADDRESS_INCOMPLETE, variant_missing / paid_at_missing -> GROUP_G_SLIP_ORDER_NOT_SHIPPABLE, (3) the bundle
--    verdict customer_mismatch -> GROUP_G_SLIP_CUSTOMER_MISMATCH, address_mismatch -> GROUP_G_SLIP_ADDRESS_MISMATCH,
--    address_incomplete -> GROUP_G_SLIP_ADDRESS_INCOMPLETE, (4) a quantity above the shippable quantity ->
--    GROUP_G_SLIP_QUANTITY_EXCEEDS_READY -> write.
--    A new draft takes the number SL- + the JST date + - + a 4 digit sequence (the largest of the day + 1, taken under the
--    advisory and guarded by the UNIQUE constraint; above 9999 GROUP_G_SLIP_NUMBER_EXHAUSTED / 55000). The customer copy and
--    the seven ship-to fields (trimmed; an empty building is NULL) are taken from the order of the first item (item id
--    ascending). The same copy is taken again on every replacement. expires_at = now() + 7 days on every save. Stock,
--    allocations, the ledger, orders and shipments are never touched; two drafts may select the same item.
--    The result {id, number, version, replayed} is stored in group_g_operations (operation shipment_slip_save, cause_type
--    shipment_slip, cause_id = the slip id); a replay returns it with replayed = true. The fingerprint (actor included, the
--    version excluded) is the SHA-256 of {operation, slip_id, lines by item id, actor_id}.
CREATE FUNCTION private.admin_save_shipment_slip_draft(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_slip public.shipment_slips%ROWTYPE;
  v_first public.orders%ROWTYPE;
  v_item_ids uuid[];
  v_order_ids uuid[];
  v_payment_review boolean;
  v_exchange_fee boolean;
  v_address boolean;
  v_unshippable boolean;
  v_exceeds boolean;
  v_verdict text;
  v_draft_lines jsonb;
  v_kind text;
  v_email text;
  v_prefix text;
  v_sequence integer;
  v_number text;
  v_slip_id uuid;
  v_version integer;
  v_previous_change text;
  v_result jsonb;
BEGIN
  IF _actor_id IS NULL OR _request_key IS NULL OR _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array'
    OR (_slip_id IS NULL) <> (_expected_version IS NULL) OR _expected_version < 1 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_EMPTY' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) > 100 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- every element is an object with exactly orderItemId and quantity, an item id string and a plain positive integer in range
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
    WHERE CASE
      WHEN pg_catalog.jsonb_typeof(e.value) <> 'object' THEN true
      WHEN (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(e.value)) <> 2 THEN true
      WHEN pg_catalog.jsonb_typeof(e.value -> 'orderItemId') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(e.value -> 'quantity') IS DISTINCT FROM 'number' THEN true
      WHEN (e.value ->> 'orderItemId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (e.value ->> 'quantity') !~ '^[1-9][0-9]{0,4}$' THEN true
      ELSE false
    END
  ) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg((e.value ->> 'orderItemId')::uuid ORDER BY (e.value ->> 'orderItemId')::uuid) INTO v_item_ids
  FROM pg_catalog.jsonb_array_elements(_lines) AS e(value);
  IF (SELECT pg_catalog.count(DISTINCT x.id) FROM pg_catalog.unnest(v_item_ids) AS x(id)) <> pg_catalog.cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], v_item_ids, false);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
      ARRAY['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_draft_lines := (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('orderItemId', (e.value ->> 'orderItemId')::uuid,
      'quantity', (e.value ->> 'quantity')::integer) ORDER BY (e.value ->> 'orderItemId')::uuid)
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value));
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_slip_save', 'slip_id', _slip_id, 'lines', v_draft_lines, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_slip_save' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  IF _slip_id IS NOT NULL THEN
    SELECT s.* INTO v_slip FROM public.shipment_slips AS s WHERE s.id = _slip_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_slip.stage <> 'draft' THEN
      RAISE EXCEPTION 'GROUP_G_SLIP_NOT_DRAFT' USING ERRCODE = '55000';
    END IF;
    IF v_slip.version <> _expected_version THEN
      RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT' USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT oi.order_id ORDER BY oi.order_id) INTO v_order_ids
  FROM public.order_items AS oi WHERE oi.id = ANY(v_item_ids);
  IF (SELECT pg_catalog.count(*) FROM public.order_items AS oi WHERE oi.id = ANY(v_item_ids)) <> pg_catalog.cardinality(v_item_ids) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- (1) every order is paid
  IF EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = ANY(v_order_ids) AND o.status <> 'paid') THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;
  -- (2) the blocked reasons and (4) the quantities come from the same single evaluation of group_g_shipment_ready
  WITH ready AS MATERIALIZED (
    SELECT r.order_item_id, r.shippable, r.blocked_reasons
    FROM private.group_g_shipment_ready(v_order_ids) AS r WHERE r.order_item_id = ANY(v_item_ids)
  ), wanted AS (
    SELECT (e.value ->> 'orderItemId')::uuid AS item_id, (e.value ->> 'quantity')::integer AS quantity
    FROM pg_catalog.jsonb_array_elements(_lines) AS e(value)
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
  v_verdict := private.group_g_bundle_verdict(v_order_ids);
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

  SELECT o.* INTO v_first FROM public.orders AS o
    JOIN public.order_items AS oi ON oi.order_id = o.id WHERE oi.id = v_item_ids[1];
  v_kind := CASE WHEN v_first.user_id IS NULL THEN 'guest' ELSE 'member' END;
  v_email := CASE WHEN v_first.user_id IS NULL THEN pg_catalog.lower(pg_catalog.btrim(v_first.shipping_email)) END;

  IF _slip_id IS NULL THEN
    v_prefix := 'SL-' || pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'Asia/Tokyo', 'YYYYMMDD') || '-';
    SELECT COALESCE(pg_catalog.max(pg_catalog.substr(s.number, pg_catalog.length(v_prefix) + 1)::integer), 0) + 1 INTO v_sequence
    FROM public.shipment_slips AS s WHERE pg_catalog.starts_with(s.number, v_prefix);
    IF v_sequence > 9999 THEN
      RAISE EXCEPTION 'GROUP_G_SLIP_NUMBER_EXHAUSTED' USING ERRCODE = '55000';
    END IF;
    v_number := v_prefix || pg_catalog.lpad(v_sequence::text, 4, '0');
    INSERT INTO public.shipment_slips(number, stage, version, customer_kind, customer_user_id, customer_email,
        ship_to_full_name, ship_to_postal_code, ship_to_prefecture, ship_to_city, ship_to_address, ship_to_phone, ship_to_building,
        draft_lines, expires_at, created_by)
      VALUES(v_number, 'draft', 1, v_kind, v_first.user_id, v_email,
        pg_catalog.btrim(v_first.shipping_full_name), pg_catalog.btrim(v_first.shipping_postal_code),
        pg_catalog.btrim(v_first.shipping_prefecture), pg_catalog.btrim(v_first.shipping_city),
        pg_catalog.btrim(v_first.shipping_address), pg_catalog.btrim(v_first.shipping_phone),
        NULLIF(pg_catalog.btrim(v_first.shipping_building), ''),
        v_draft_lines, pg_catalog.now() + interval '7 days', _actor_id)
      RETURNING id INTO v_slip_id;
    v_version := 1;
  ELSE
    v_slip_id := _slip_id;
    v_number := v_slip.number;
    v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
    PERFORM pg_catalog.set_config('app.group_g_slip_change', 'draft', true);
    UPDATE public.shipment_slips
      SET draft_lines = v_draft_lines, customer_kind = v_kind, customer_user_id = v_first.user_id, customer_email = v_email,
          ship_to_full_name = pg_catalog.btrim(v_first.shipping_full_name), ship_to_postal_code = pg_catalog.btrim(v_first.shipping_postal_code),
          ship_to_prefecture = pg_catalog.btrim(v_first.shipping_prefecture), ship_to_city = pg_catalog.btrim(v_first.shipping_city),
          ship_to_address = pg_catalog.btrim(v_first.shipping_address), ship_to_phone = pg_catalog.btrim(v_first.shipping_phone),
          ship_to_building = NULLIF(pg_catalog.btrim(v_first.shipping_building), ''),
          expires_at = pg_catalog.now() + interval '7 days', version = version + 1, updated_at = pg_catalog.now()
      WHERE id = _slip_id
      RETURNING version INTO v_version;
    PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
  END IF;

  v_result := pg_catalog.jsonb_build_object('id', v_slip_id::text, 'number', v_number, 'version', v_version, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'shipment_slip_save', _request_key, v_fingerprint, 'shipment_slip', v_slip_id::text, _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_save_shipment_slip_draft(_slip_id uuid, _expected_version integer, _lines jsonb, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_save_shipment_slip_draft(_slip_id, _expected_version, _lines, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid) TO service_role;

-- 3. Discard a shipment-slip draft. The same order of work as the save (argument check -> lock helper -> permission ->
--    fingerprint, replay / conflict -> existence -> stage must be draft -> version) and then the slip becomes discarded
--    (discarded_at, discarded_by, expires_at NULL, version + 1). An expired draft can be discarded. Operation
--    shipment_slip_discard; the result is {id, number, version, replayed}. The fingerprint is the SHA-256 of
--    {operation, slip_id, actor_id}.
CREATE FUNCTION private.admin_discard_shipment_slip_draft(_slip_id uuid, _expected_version integer, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_slip public.shipment_slips%ROWTYPE;
  v_version integer;
  v_previous_change text;
  v_result jsonb;
BEGIN
  IF _slip_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], false);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
      ARRAY['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_slip_discard', 'slip_id', _slip_id, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_slip_discard' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT s.* INTO v_slip FROM public.shipment_slips AS s WHERE s.id = _slip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_slip.stage <> 'draft' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_DRAFT' USING ERRCODE = '55000';
  END IF;
  IF v_slip.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;

  v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  PERFORM pg_catalog.set_config('app.group_g_slip_change', 'discard', true);
  UPDATE public.shipment_slips
    SET stage = 'discarded', discarded_at = pg_catalog.now(), discarded_by = _actor_id, expires_at = NULL,
        version = version + 1, updated_at = pg_catalog.now()
    WHERE id = _slip_id
    RETURNING version INTO v_version;
  PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);

  v_result := pg_catalog.jsonb_build_object('id', _slip_id::text, 'number', v_slip.number, 'version', v_version, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'shipment_slip_discard', _request_key, v_fingerprint, 'shipment_slip', _slip_id::text, _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_discard_shipment_slip_draft(_slip_id uuid, _expected_version integer, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_discard_shipment_slip_draft(_slip_id, _expected_version, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid) TO service_role;

-- 4. Internal consumption: the caller holds the inventory closure and common advisory.
--    Paid allocations are consumed FIFO; F (free stock) and its ledger never change here.
CREATE FUNCTION private.consume_group_g_allocations(_order_item_id uuid, _quantity integer, _operation_id uuid, _actor_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_allocation record;
  v_take integer;
  v_total integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2 AND l.mode = 'ExclusiveLock' AND l.granted) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  IF _order_item_id IS NULL OR _quantity IS NULL OR _quantity < 1 OR _operation_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_allocation IN
    SELECT a.id, a.remaining_quantity FROM public.order_item_allocations AS a
    WHERE a.order_item_id = _order_item_id AND a.kind = 'paid' AND a.remaining_quantity > 0
    ORDER BY a.created_at, a.id
  LOOP
    EXIT WHEN v_total = _quantity;
    v_take := LEAST(v_allocation.remaining_quantity, _quantity - v_total);
    UPDATE public.order_item_allocations SET remaining_quantity = remaining_quantity - v_take,
      version = version + 1, updated_at = pg_catalog.now() WHERE id = v_allocation.id;
    INSERT INTO public.order_item_allocation_events(allocation_id, event_type, quantity, operation_id, sequence, reason, actor_id)
      VALUES(v_allocation.id, 'consume', v_take, _operation_id, 1, 'shipment_confirm', _actor_id);
    v_total := v_total + v_take;
  END LOOP;
  IF v_total < _quantity THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY' USING ERRCODE = '22023';
  END IF;
  RETURN v_total;
END;
$$;
ALTER FUNCTION private.consume_group_g_allocations(uuid,integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.consume_group_g_allocations(uuid,integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 5. One tracking parent per slip/version. The caller holds the advisory and shop_settings FOR SHARE.
--    Read the leader's shipment: confirm creates the parent before copying tracking to the slip header.
CREATE FUNCTION private.register_group_g_slip_tracking(_slip_id uuid, _tracking_version integer, _actor_id uuid, _operation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_leader public.order_fulfillments%ROWTYPE;
  v_enabled boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2 AND l.mode = 'ExclusiveLock' AND l.granted) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  SELECT f.* INTO v_leader FROM public.shipment_slip_fulfillments AS sf
    JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
    WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL ORDER BY sf.order_id LIMIT 1;
  IF NOT FOUND OR _tracking_version IS NULL OR _tracking_version < 1 OR _actor_id IS NULL OR _operation_id IS NULL
    OR v_leader.shipping_carrier IS NULL OR v_leader.tracking_number IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1;
  INSERT INTO private.shipment_tracking_registrations(slip_id, tracking_version, leader_fulfillment_id, carrier, tracking_number, operation_id)
    VALUES(_slip_id, _tracking_version, v_leader.id, v_leader.shipping_carrier, pg_catalog.upper(v_leader.tracking_number), _operation_id);
  IF v_enabled IS TRUE THEN
    INSERT INTO private.fulfillment_tracking_registrations(fulfillment_id, tracking_version, carrier, tracking_number, expires_at)
      VALUES(v_leader.id, _tracking_version, v_leader.shipping_carrier, pg_catalog.upper(v_leader.tracking_number),
        CASE WHEN _tracking_version = 1 THEN v_leader.shipped_at ELSE pg_catalog.now() END + interval '30 days');
  END IF;
END;
$$;
ALTER FUNCTION private.register_group_g_slip_tracking(uuid,integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.register_group_g_slip_tracking(uuid,integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 6. Confirm every order of a draft atomically. Plain argument expressions precede the lock helper;
--    no application function or table may be consulted until the common advisory is held.
CREATE FUNCTION private.admin_confirm_shipment_slip(_slip_id uuid, _expected_version integer, _carrier text, _tracking_number text,
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
  IF v_slip.expires_at < pg_catalog.now() THEN
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
ALTER FUNCTION private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_confirm_shipment_slip(_slip_id uuid, _expected_version integer, _carrier text, _tracking_number text,
  _shipment_date date, _notify_customer boolean, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_confirm_shipment_slip(_slip_id, _expected_version, _carrier, _tracking_number, _shipment_date, _notify_customer, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid) TO service_role;

-- 7. Internal restore of one confirmed shipment (cancel of a whole slip calls it once per shipment). The caller holds the common
--    advisory and the inventory closure and has already set cancelled_at on the shipment. For each shipment line (order item id
--    ascending) and each consume event of the confirming operation on that item (event id ascending) four statements run in this
--    order, so that the foreign keys of the next one are already satisfied and no check sees a half state it forbids:
--      (1) ledger restock +n WITHOUT allocation_operation_id (untagged: the stock-ledger consistency check only reads tagged rows),
--      (2) a new paid allocation of n (remaining n). The item bound "remaining <= quantity - active shipped" is a deferred check
--          (commit time) and does not look at statements in between; the order is still chosen so that even this intermediate
--          state stays within the bound, because the shipment is already cancelled,
--      (3) ledger -n tagged with the cancelling operation (purchase, or exchange for an exchange item),
--      (4) the restore event (sequence 1, reverses the consume event, points at the ledger row of step 3, reason shipment_cancel).
--    Free stock F is +n and then -n, so it never drops below its start and is unchanged at the end; the original allocation is
--    never touched. Restoring the same consume event twice stops at UNIQUE (reverses_event_id) of the events table.
--    Returns the restored quantity. Internal helper: nobody but the owner can EXECUTE it.
CREATE FUNCTION private.restore_group_g_shipment(_fulfillment_id uuid, _confirm_operation_id uuid, _operation_id uuid, _actor_id uuid, _slip_number text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_consume record;
  v_allocation uuid;
  v_movement bigint;
  v_total integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2 AND l.mode = 'ExclusiveLock' AND l.granted) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  IF _fulfillment_id IS NULL OR _confirm_operation_id IS NULL OR _operation_id IS NULL OR _actor_id IS NULL OR _slip_number IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_consume IN
    SELECT e.id AS event_id, e.quantity, a.variant_id, a.order_item_id, oi.order_id, oi.exchange_return_line_id
    FROM public.order_fulfillment_lines AS fl
    JOIN public.order_items AS oi ON oi.id = fl.order_item_id
    JOIN public.order_item_allocations AS a ON a.order_item_id = fl.order_item_id
    JOIN public.order_item_allocation_events AS e ON e.allocation_id = a.id
    WHERE fl.fulfillment_id = _fulfillment_id AND e.event_type = 'consume' AND e.operation_id = _confirm_operation_id
    ORDER BY fl.order_item_id, e.id
  LOOP
    INSERT INTO public.stock_movements(variant_id, delta, reason, order_id, order_item_id, note, created_by)
      VALUES(v_consume.variant_id, v_consume.quantity, 'restock', v_consume.order_id, v_consume.order_item_id,
        U&'\767A\9001\7968 ' || _slip_number || U&' \306E\767A\9001\53D6\6D88\FF08\623B\3057\FF09', _actor_id);
    INSERT INTO public.order_item_allocations(order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
      VALUES(v_consume.order_item_id, v_consume.variant_id, v_consume.quantity, v_consume.quantity, 'paid', _operation_id)
      RETURNING id INTO v_allocation;
    INSERT INTO public.stock_movements(variant_id, delta, reason, order_id, order_item_id, allocation_operation_id, note, created_by)
      VALUES(v_consume.variant_id, -v_consume.quantity,
        CASE WHEN v_consume.exchange_return_line_id IS NULL THEN 'purchase' ELSE 'exchange' END,
        v_consume.order_id, v_consume.order_item_id, _operation_id,
        U&'\767A\9001\7968 ' || _slip_number || U&' \306E\767A\9001\53D6\6D88\FF08\518D\78BA\4FDD\FF09', _actor_id)
      RETURNING id INTO v_movement;
    INSERT INTO public.order_item_allocation_events(allocation_id, event_type, quantity, operation_id, sequence, reverses_event_id, stock_movement_id, reason, actor_id)
      VALUES(v_allocation, 'restore', v_consume.quantity, _operation_id, 1, v_consume.event_id, v_movement, 'shipment_cancel', _actor_id);
    v_total := v_total + v_consume.quantity;
  END LOOP;
  RETURN v_total;
END;
$$;
ALTER FUNCTION private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;

-- 8. Cancel a whole confirmed slip (FREQ-533-AC-04, FREQ-534-AC-03). One transaction for every order of the slip; the stock goes
--    back exactly once (the restore above), free stock F is unchanged.
--    Order of work: argument check (22023) -> lock helper (advisory first; settings FOR SHARE because tracking is touched) ->
--    permission (the four manage + read codes, 42501) -> fingerprint {operation, slip_id, actor_id} and replay / conflict (23505) ->
--    existence (P0002) -> stage: cancelled is GROUP_G_SLIP_CANCELLED, anything but confirmed GROUP_G_SLIP_NOT_CONFIRMED -> version ->
--    refusals for ALL orders before any write (the first kind found by this priority wins, nothing is written): (1) an order that
--    is not paid / shipped -> GROUP_G_SLIP_CANCEL_NOT_ALLOWED, (2) a return line (status requested / open / closed) that points
--    at one of the shipments -> GROUP_G_SLIP_HAS_RETURN, (3) shipped - this quantity < refunded after shipment (pending refunds
--    count) -> GROUP_G_SLIP_REFUNDED.
--    Writes, per shipment in order id ascending, in this order: cancelled_at / cancelled_by of the shipment (the existing cancel
--    branch, no mark) -> its tracking registrations stopped as cancelled and its open attention closed -> restore (the allocation
--    bounds, the ledger consistency and group_g_shipment_consumption are all deferred checks that see the final state at commit,
--    where cancel and restores are balanced; the shipment is cancelled before the new allocations are inserted so that the
--    intermediate states are meaningful too and stay within the item bound) -> an order that is shipped and has
--    unshipped quantity left goes back to paid (shipped_at, carrier and number NULL) -> the shipped emails not yet sent
--    (pending / retry_wait) are skipped. Then the slip (mark cancel: stage cancelled, cancelled_at / cancelled_by, version + 1),
--    its cancel version row, the item-state differences (reason shipment_slip_cancel) and the operation row (operation
--    shipment_slip_cancel). No email is created for the customer.
--    Result {id, version, restoredQuantity, replayed}.
CREATE FUNCTION private.admin_cancel_shipment_slip(_slip_id uuid, _expected_version integer, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_existing private.group_g_operations%ROWTYPE;
  v_slip public.shipment_slips%ROWTYPE;
  v_fingerprint text;
  v_orders uuid[];
  v_before jsonb;
  v_shipment record;
  v_status public.order_status;
  v_unshipped integer;
  v_restored integer := 0;
  v_version integer;
  v_result jsonb;
  v_previous_operation text;
  v_previous_actor text;
  v_previous_reason text;
  v_previous_change text;
BEGIN
  IF _slip_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
      ARRAY['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_slip_cancel', 'slip_id', _slip_id, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_slip_cancel' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT s.* INTO v_slip FROM public.shipment_slips AS s WHERE s.id = _slip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_slip.stage = 'cancelled' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_CANCELLED' USING ERRCODE = '55000';
  END IF;
  IF v_slip.stage <> 'confirmed' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_CONFIRMED' USING ERRCODE = '55000';
  END IF;
  IF v_slip.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;

  -- refusals for every order of the slip, before any write
  IF EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf JOIN public.orders AS o ON o.id = sf.order_id
    WHERE sf.slip_id = _slip_id AND o.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_CANCEL_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf
    JOIN public.order_return_lines AS rl ON rl.fulfillment_id = sf.fulfillment_id
    JOIN public.order_returns AS r ON r.id = rl.return_id
    WHERE sf.slip_id = _slip_id AND r.status IN ('requested', 'open', 'closed')
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_HAS_RETURN' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf
    JOIN public.order_fulfillment_lines AS fl ON fl.fulfillment_id = sf.fulfillment_id
    CROSS JOIN LATERAL private.order_line_fulfillment(sf.order_id) AS l
    WHERE sf.slip_id = _slip_id AND l.order_item_id = fl.order_item_id AND l.shipped - fl.quantity < l.refunded_after_shipment
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_REFUNDED' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(sf.order_id ORDER BY sf.order_id) INTO v_orders
    FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = _slip_id;
  v_before := private.capture_group_g_item_states(v_orders);
  v_previous_operation := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_previous_actor := pg_catalog.current_setting('app.order_actor_id', true);
  v_previous_reason := pg_catalog.current_setting('app.order_change_reason', true);
  v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  BEGIN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
    FOR v_shipment IN
      SELECT sf.order_id, f.id AS fulfillment_id
      FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
      WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL
      ORDER BY sf.order_id
    LOOP
      UPDATE public.order_fulfillments SET cancelled_at = pg_catalog.now(), cancelled_by = _actor_id
        WHERE id = v_shipment.fulfillment_id;
      PERFORM private.stop_fulfillment_registrations(v_shipment.fulfillment_id, 'cancelled');
      PERFORM private.close_delivery_attention(v_shipment.fulfillment_id);
      v_restored := v_restored + private.restore_group_g_shipment(v_shipment.fulfillment_id, v_slip.confirm_operation_id,
        v_operation, _actor_id, v_slip.number);
      SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = v_shipment.order_id;
      SELECT COALESCE(pg_catalog.sum(l.unshipped), 0)::integer INTO v_unshipped
        FROM private.order_line_fulfillment(v_shipment.order_id) AS l;
      IF v_status = 'shipped'::public.order_status AND v_unshipped > 0 THEN
        PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
        PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_fulfillment', true);
        UPDATE public.orders SET status = 'paid'::public.order_status, shipped_at = NULL, shipping_carrier = NULL, tracking_number = NULL
          WHERE id = v_shipment.order_id;
      END IF;
      UPDATE private.order_email_outbox AS e
        SET status = 'skipped', finished_at = pg_catalog.now(), subject = NULL, body_text = NULL,
            body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
            last_error_code = 'fulfillment_cancelled'
        WHERE e.fulfillment_id = v_shipment.fulfillment_id AND e.status IN ('pending', 'retry_wait');
    END LOOP;
    PERFORM pg_catalog.set_config('app.group_g_slip_change', 'cancel', true);
    UPDATE public.shipment_slips SET stage = 'cancelled', cancelled_at = pg_catalog.now(), cancelled_by = _actor_id,
      version = version + 1, updated_at = pg_catalog.now()
      WHERE id = _slip_id RETURNING version INTO v_version;
    INSERT INTO public.shipment_slip_versions(slip_id, version, kind, shipping_carrier, tracking_number, tracking_version, shipment_date, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'cancel', v_slip.shipping_carrier, v_slip.tracking_number, v_slip.tracking_version, v_slip.shipment_date, _actor_id, v_operation);
    PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'shipment_slip_cancel', _actor_id);
    v_result := pg_catalog.jsonb_build_object('id', _slip_id::text, 'version', v_version, 'restoredQuantity', v_restored, 'replayed', false);
    INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
      VALUES(v_operation, 'shipment_slip_cancel', _request_key, v_fingerprint, 'shipment_slip', _slip_id::text, _actor_id, v_result);
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
ALTER FUNCTION private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_cancel_shipment_slip(_slip_id uuid, _expected_version integer, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_cancel_shipment_slip(_slip_id, _expected_version, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_cancel_shipment_slip(uuid,integer,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_cancel_shipment_slip(uuid,integer,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_cancel_shipment_slip(uuid,integer,uuid,uuid) TO service_role;

-- 9. The closed list of writers. The 65 entries of 20261024180500_group_g2_purchasing_writers.sql stay exactly as they were;
--    this file appends save/discard (66-67), consume/register/confirm (68-70), restore/cancel (71-72). Later G-3 tasks append their writers while this file is not applied anywhere. Owner, ACL
--    and signature of the function are unchanged (CREATE OR REPLACE keeps them). group_g1_writer_inventory scans
--    pg_proc.prosrc against it.
CREATE OR REPLACE FUNCTION private.group_g_writer_allowlist() RETURNS pg_catalog.regprocedure[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT ARRAY[
    'private.apply_group_g_stock_movement(bigint,integer)',
    'private.allocate_group_g_fifo(bigint[],uuid,uuid)',
    'private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)',
    'private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid)',
    'private.ensure_group_g_payment_review_hold(uuid,text,text,text,uuid)',
    'private.release_group_g_payment_review_holds(uuid,uuid)',
    'private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)',
    'private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)',
    'private.mark_order_awaiting_payment(uuid,text,text)',
    'private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)',
    'private.record_cancelled_order_paid_amount(uuid,text,integer)',
    'private.admin_cancel_failed_order(uuid,uuid,text,text)',
    'private.link_guest_orders(uuid,text)',
    'private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)',
    'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)',
    'private.apply_order_refund_state(uuid)',
    'private.apply_return_refund_outcome(uuid,text)',
    'private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)',
    'private.mark_order_refund_error(uuid,text,boolean)',
    'private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)',
    'private.mark_order_reviewed(uuid,uuid)',
    'private.record_payment_exception(text,text,text,text,text,uuid,uuid)',
    'private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)',
    'private.resolve_payment_exception_by_system(uuid,text)',
    'private.customer_order_for_request(uuid,uuid,boolean)',
    'private.customer_request_cancel(uuid,uuid,uuid,jsonb,text)',
    'private.lock_order_cancel_request(uuid)',
    'private.admin_decline_cancel_request(uuid,uuid,text,text)',
    'private.admin_close_cancel_request(uuid,uuid)',
    'private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean)',
    'private.lock_order_return(uuid)',
    'private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
    'private.admin_cancel_return(uuid,uuid)',
    'private.customer_request_return(uuid,uuid,uuid,jsonb)',
    'private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
    'private.admin_decline_return(uuid,uuid,text,text)',
    'private.admin_close_return_missing(uuid,uuid,uuid)',
    'private.admin_reopen_return(uuid,uuid,uuid)',
    'private.admin_inspect_return(uuid,uuid,uuid,jsonb)',
    'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)',
    'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)',
    'private.refresh_order_return_status(uuid)',
    'private.admin_record_return_fee_payment(uuid,uuid,text,boolean)',
    'private.admin_release_return_exchange(uuid,uuid)',
    'private.record_delivery_read_result(uuid,integer,uuid,jsonb)',
    'private.apply_tracking_status(uuid,text,timestamptz,timestamptz)',
    'public.apply_stock_movement()',
    'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
    'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
    'public.admin_update_fulfillment_tracking(uuid,uuid,uuid,uuid,text,text,boolean)',
    'public.admin_mark_fulfillment_delivered(uuid,uuid,uuid,uuid,date,boolean)',
    'public.admin_record_completion(uuid,uuid,uuid,jsonb)',
    'public.admin_cancel_completion(uuid,uuid,uuid)',
    'private.record_group_g_payment_exception_row(text,text,text,text,text,uuid,uuid)',
    'private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)',
    'private.release_group_g_payment_holds(uuid,uuid,text,uuid)',
    'private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)',
    'private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)',
    'private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)',
    'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)',
    'private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)',
    'private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)',
    'private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)',
    'private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)',
    'private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)',
    'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
    'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
    'private.consume_group_g_allocations(uuid,integer,uuid,uuid)',
    'private.register_group_g_slip_tracking(uuid,integer,uuid,uuid)',
    'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
    'private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)',
    'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)'
  ]::pg_catalog.regprocedure[];
$$;

-- G3C_BODY_END

-- G3C_FINAL_ASSERT_BEGIN
-- Expectation through Task 6: the twelve new functions (owner, SECURITY, language, result type, argument names, search_path, and
-- the EXECUTE rights read from the effective ACL where a NULL proacl means the default that includes PUBLIC), the same twelve as
-- a set (no function of these names beyond them; service_role may EXECUTE exactly the four operation writers and their four public
-- entrances, never the lock helper and never the internal consume / register / restore helpers), the order of the lock helper (the
-- common advisory is the first statement, then the inventory closure, then the row locks) and of each writer (the lock helper
-- before any table is read), and the allowlist: exactly the 65 G-1/G-2 entries plus the seven slip writers, every one resolving to
-- a function, compared to the fixed set by OID. The expected sets grow with every Task that adds to this file.
DO $g3c_final_objects$
DECLARE
  v_failed text;
  v_functions text[] := ARRAY[
    'private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)',
    'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
    'public.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
    'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
    'public.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
    'private.consume_group_g_allocations(uuid,integer,uuid,uuid)',
    'private.register_group_g_slip_tracking(uuid,integer,uuid,uuid)',
    'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
    'public.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
    'private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)',
    'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)',
    'public.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)'
  ];
  v_writers text[] := ARRAY[
    'private.apply_group_g_stock_movement(bigint,integer)',
    'private.allocate_group_g_fifo(bigint[],uuid,uuid)',
    'private.admin_record_stock_movement(bigint,bigint,integer,text,text,uuid,uuid,integer)',
    'private.record_group_g_item_state_changes(jsonb,uuid[],uuid,integer,text,uuid)',
    'private.ensure_group_g_payment_review_hold(uuid,text,text,text,uuid)',
    'private.release_group_g_payment_review_holds(uuid,uuid)',
    'private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)',
    'private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)',
    'private.mark_order_awaiting_payment(uuid,text,text)',
    'private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)',
    'private.record_cancelled_order_paid_amount(uuid,text,integer)',
    'private.admin_cancel_failed_order(uuid,uuid,text,text)',
    'private.link_guest_orders(uuid,text)',
    'private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)',
    'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)',
    'private.apply_order_refund_state(uuid)',
    'private.apply_return_refund_outcome(uuid,text)',
    'private.record_order_refund_result(uuid,text,text,text,text,timestamptz,text,text,text)',
    'private.mark_order_refund_error(uuid,text,boolean)',
    'private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)',
    'private.mark_order_reviewed(uuid,uuid)',
    'private.record_payment_exception(text,text,text,text,text,uuid,uuid)',
    'private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)',
    'private.resolve_payment_exception_by_system(uuid,text)',
    'private.customer_order_for_request(uuid,uuid,boolean)',
    'private.customer_request_cancel(uuid,uuid,uuid,jsonb,text)',
    'private.lock_order_cancel_request(uuid)',
    'private.admin_decline_cancel_request(uuid,uuid,text,text)',
    'private.admin_close_cancel_request(uuid,uuid)',
    'private.admin_resolve_cancel_request(uuid,uuid,uuid,boolean)',
    'private.lock_order_return(uuid)',
    'private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
    'private.admin_cancel_return(uuid,uuid)',
    'private.customer_request_return(uuid,uuid,uuid,jsonb)',
    'private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)',
    'private.admin_decline_return(uuid,uuid,text,text)',
    'private.admin_close_return_missing(uuid,uuid,uuid)',
    'private.admin_reopen_return(uuid,uuid,uuid)',
    'private.admin_inspect_return(uuid,uuid,uuid,jsonb)',
    'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)',
    'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)',
    'private.refresh_order_return_status(uuid)',
    'private.admin_record_return_fee_payment(uuid,uuid,text,boolean)',
    'private.admin_release_return_exchange(uuid,uuid)',
    'private.record_delivery_read_result(uuid,integer,uuid,jsonb)',
    'private.apply_tracking_status(uuid,text,timestamptz,timestamptz)',
    'public.apply_stock_movement()',
    'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)',
    'public.admin_cancel_fulfillment(uuid,uuid,uuid)',
    'public.admin_update_fulfillment_tracking(uuid,uuid,uuid,uuid,text,text,boolean)',
    'public.admin_mark_fulfillment_delivered(uuid,uuid,uuid,uuid,date,boolean)',
    'public.admin_record_completion(uuid,uuid,uuid,jsonb)',
    'public.admin_cancel_completion(uuid,uuid,uuid)',
    'private.record_group_g_payment_exception_row(text,text,text,text,text,uuid,uuid)',
    'private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)',
    'private.release_group_g_payment_holds(uuid,uuid,text,uuid)',
    'private.admin_create_purchase_order(text,text,jsonb,uuid,uuid)',
    'private.admin_update_purchase_order_header(uuid,integer,text,text,text,uuid,uuid)',
    'private.admin_confirm_purchase_order_quantities(uuid,integer,jsonb,text,uuid,uuid)',
    'private.admin_short_close_purchase_order(uuid,integer,uuid[],text,uuid,uuid)',
    'private.admin_receive_purchase_order(uuid,integer,date,text,jsonb,uuid,uuid)',
    'private.admin_reverse_purchase_order_receipt(uuid,integer,uuid,jsonb,text,integer,uuid,uuid)',
    'private.admin_reserve_purchase_order_attachment(uuid,text,text,uuid,uuid,uuid)',
    'private.admin_attach_purchase_order_document(uuid,uuid,text,bigint,text,text,date,bigint,text,text,uuid,uuid)',
    'private.admin_revise_purchase_order_document(uuid,uuid,date,bigint,text,text,boolean,text,uuid,uuid)',
    'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
    'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
    'private.consume_group_g_allocations(uuid,integer,uuid,uuid)',
    'private.register_group_g_slip_tracking(uuid,integer,uuid,uuid)',
    'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
    'private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)',
    'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)'
  ];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)', true, false, 'plpgsql', 'uuid[]',
        ARRAY['_slip_ids', '_order_item_ids', '_with_settings']),
      ('private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_lines', '_actor_id', '_request_key']),
      ('public.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_lines', '_actor_id', '_request_key']),
      ('private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_actor_id', '_request_key']),
      ('public.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_actor_id', '_request_key']),
      ('private.consume_group_g_allocations(uuid,integer,uuid,uuid)', true, false, 'plpgsql', 'integer',
        ARRAY['_order_item_id', '_quantity', '_operation_id', '_actor_id']),
      ('private.register_group_g_slip_tracking(uuid,integer,uuid,uuid)', true, false, 'plpgsql', 'void',
        ARRAY['_slip_id', '_tracking_version', '_actor_id', '_operation_id']),
      ('private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_carrier', '_tracking_number', '_shipment_date', '_notify_customer', '_actor_id', '_request_key']),
      ('public.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_carrier', '_tracking_number', '_shipment_date', '_notify_customer', '_actor_id', '_request_key']),
      ('private.restore_group_g_shipment(uuid,uuid,uuid,uuid,text)', true, false, 'plpgsql', 'integer',
        ARRAY['_fulfillment_id', '_confirm_operation_id', '_operation_id', '_actor_id', '_slip_number']),
      ('private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_actor_id', '_request_key']),
      ('public.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_actor_id', '_request_key'])
    ) AS e(sig, definer, service, lang, ret, names)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    WHERE p.oid IS NULL
       OR p.proowner <> 'postgres'::regrole
       OR p.prosecdef <> e.definer
       OR p.provolatile <> 'v'
       OR p.proretset
       OR p.prolang <> (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = e.lang)
       OR p.prorettype <> e.ret::regtype::oid
       OR p.proargnames IS DISTINCT FROM e.names
       OR (NOT e.definer AND pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc),'\s','','g')
         <> 'selectprivate.' || p.proname || '(' || pg_catalog.array_to_string(e.names,',') || ');')
       OR NOT ('search_path=""' = ANY (COALESCE(p.proconfig, ARRAY[]::text[])))
       OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') <> e.service
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x
                  WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  ) THEN
    v_failed := 'shipping_slip_functions';
  ELSIF NOT EXISTS (
    -- the lock helper, read in lower case: the common advisory is its first statement, then the settings row (FOR SHARE), the
    -- inventory closure, the rows of the slips (FOR UPDATE, on public.shipment_slips) and only then the tracking registrations
    -- (FOR UPDATE), so the slips are always locked before their registrations
    SELECT 1 FROM pg_catalog.pg_proc AS p
    CROSS JOIN LATERAL (SELECT pg_catalog.lower(p.prosrc) AS body) AS s
    CROSS JOIN LATERAL (SELECT pg_catalog.strpos(s.body, 'pg_advisory_xact_lock(') AS advisory,
                               pg_catalog.strpos(s.body, 'for share') AS settings,
                               pg_catalog.strpos(s.body, 'private.lock_group_g_inventory(') AS inventory,
                               pg_catalog.strpos(s.body, 'for update') AS slips,
                               pg_catalog.strpos(s.body, 'private.fulfillment_tracking_registrations') AS registrations) AS k
    WHERE p.oid = 'private.lock_group_g_shipment_slips(uuid[],uuid[],boolean)'::regprocedure
      AND s.body ~ 'begin\s+perform\s+pg_catalog\.pg_advisory_xact_lock\(\s*190521\s*,\s*1\s*\)\s*;'
      AND 0 < k.advisory AND k.advisory < k.settings AND k.settings < k.inventory AND k.inventory < k.slips AND k.slips < k.registrations
      AND pg_catalog.substr(s.body, k.inventory, k.slips - k.inventory) LIKE '%public.shipment_slips%'
      AND pg_catalog.strpos(pg_catalog.substr(s.body, k.registrations), 'for update') > 0
  ) OR EXISTS (
    -- the four public-operation writers: the text before the first call of the lock helper must not name a table (after from / join / into /
    -- update / table, with or without ONLY) and must not call a function of public or private (a permission check or any other
    -- helper that reads a table). Compared in lower case, with any spacing and with quoted schema names, so a body written in
    -- another style cannot slip by. A body that never calls the lock helper fails too.
    SELECT 1 FROM pg_catalog.unnest(ARRAY[
      'private.admin_save_shipment_slip_draft(uuid,integer,jsonb,uuid,uuid)',
      'private.admin_discard_shipment_slip_draft(uuid,integer,uuid,uuid)',
      'private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)',
      'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)'
    ]) AS w(sig)
    JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(w.sig)
    WHERE CASE
      WHEN pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'private.lock_group_g_shipment_slips(') = 0 THEN true
      ELSE pg_catalog.substr(pg_catalog.lower(p.prosrc), 1, pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'private.lock_group_g_shipment_slips(') - 1)
        ~ '((from|join|into|update|table)\s+(only\s+)?"?(public|private)"?\s*\.)|("?(public|private)"?\s*\.\s*"?[a-z_][a-z0-9_]*"?\s*\()'
    END
  ) THEN
    v_failed := 'shipping_slip_lock_order';
  ELSIF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_writers) AS w(s) WHERE pg_catalog.to_regprocedure(w.s) IS NULL)
     OR (SELECT pg_catalog.count(DISTINCT pg_catalog.to_regprocedure(w.s)) FROM pg_catalog.unnest(v_writers) AS w(s)) <> 72
     OR pg_catalog.cardinality(private.group_g_writer_allowlist()) <> 72 THEN
    v_failed := 'shipping_slip_allowlist';
  ELSIF (SELECT pg_catalog.array_agg(x::oid ORDER BY x::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS a(x))
     IS DISTINCT FROM (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(w.s)::oid ORDER BY pg_catalog.to_regprocedure(w.s)::oid)
                       FROM pg_catalog.unnest(v_writers) AS w(s)) THEN
    v_failed := 'shipping_slip_allowlist';
  -- the functions of this file as a set: a function of one of these names (in public or private) is one of the twelve listed
  -- above and every listed one exists, so an extra overload or a missing function fails. Together with the per-function EXECUTE
  -- flags checked first, the EXECUTE rights of service_role over these names are exactly the four operation writers and their entrances.
  ELSIF (SELECT pg_catalog.array_agg(p.oid ORDER BY p.oid)
         FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'private')
           AND p.proname IN ('lock_group_g_shipment_slips', 'admin_save_shipment_slip_draft', 'admin_discard_shipment_slip_draft',
             'consume_group_g_allocations', 'register_group_g_slip_tracking', 'admin_confirm_shipment_slip',
             'restore_group_g_shipment', 'admin_cancel_shipment_slip'))
        IS DISTINCT FROM
        (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(f.sig)::oid ORDER BY pg_catalog.to_regprocedure(f.sig)::oid)
         FROM pg_catalog.unnest(v_functions) AS f(sig)) THEN
    v_failed := 'shipping_slip_function_set';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g3c_final_objects$;
-- Semantic table and column ACL checks tolerate unrelated grantees and ACL ordering.
-- PostgreSQL 17 adds MAINTAIN: it is also forbidden to every application role.
DO $g3c_final_table_acl$
DECLARE
  v_maintain text[] := CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
    THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  v_all text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] || v_maintain;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(ARRAY[
      'public.shipment_slips','public.shipment_slip_lines','public.shipment_slip_fulfillments',
      'public.shipment_slip_versions','public.shipment_date_history','private.shipment_tracking_registrations'
    ]) AS e(rel)
    CROSS JOIN LATERAL (SELECT pg_catalog.to_regclass(e.rel) AS r) AS t
    WHERE t.r IS NULL
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_all) AS p(priv)
         WHERE NOT pg_catalog.has_table_privilege('postgres',t.r,p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_all) AS p(priv)
         WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
           (SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = t.r),pg_catalog.acldefault('r','postgres'::regrole))) AS x
           WHERE x.grantee = 'postgres'::regrole AND x.privilege_type = p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
         (SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = t.r),pg_catalog.acldefault('r','postgres'::regrole))) AS x
         WHERE x.grantee = 0)
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) AS g(role)
         CROSS JOIN pg_catalog.unnest(v_all) AS p(priv) WHERE pg_catalog.has_table_privilege(g.role,t.r,p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) AS g(role)
         CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p(priv)
         WHERE pg_catalog.has_any_column_privilege(g.role,t.r,p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
         CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS x
         WHERE a.attrelid = t.r AND a.attnum > 0 AND NOT a.attisdropped AND x.grantee = 0)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'shipping_slip_table_acl';
  END IF;
END
$g3c_final_table_acl$;
-- G3C_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
