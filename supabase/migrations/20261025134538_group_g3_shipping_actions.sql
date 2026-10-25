-- G-3 shipment-slip actions (Task 7): entering or correcting the tracking number of a whole confirmed slip and marking a whole
-- confirmed slip as delivered by hand (FREQ-534-AC-01, FREQ-534-AC-02, FREQ-534-AC-04, FREQ-534-AC-05, FREQ-535-AC-04,
-- FREQ-540-AC-10, FREQ-540-AC-11), and the writer allowlist (72 entries of 20261025100130_group_g3_shipping_slips.sql + the two
-- writers of this file = 74). Later G-3 tasks extend the body section of this file while it is not applied anywhere.
-- Always applied after 20261025100130_group_g3_shipping_slips.sql. The three migrations before it are not edited here.
BEGIN;

-- G3D_BODY_BEGIN

-- 1. Enter or correct the tracking number of a confirmed slip (FREQ-534-AC-01). Both the carrier and the number are required: a
--    correction that would empty them is GROUP_G_SLIP_TRACKING_INCOMPLETE (22023). A slip confirmed without a number gets its first
--    carrier and number here (tracking version 1 -> 2, the change row has from_* NULL).
--    Order of work: argument check (22023) -> lock helper (advisory first; settings FOR SHARE because tracking is touched) ->
--    permission (the four manage + read codes, 42501) -> fingerprint {operation, slip_id, carrier, tracking_number, notify_customer,
--    actor_id} and replay / conflict (23505) -> existence (P0002) -> cancelled is GROUP_G_SLIP_CANCELLED, anything but confirmed
--    GROUP_G_SLIP_NOT_CONFIRMED -> version -> the same carrier with the same number (case ignored) is GROUP_G_SLIP_TRACKING_UNCHANGED
--    (a slip without a number always changes).
--    Writes, with the new tracking version v = the slip tracking_version + 1 and for each active shipment in order id ascending:
--    (1) a change row (from_* = the values now, to_*, tracking_version v, notify_customer, a request key derived from the common key,
--    the E-4 fingerprint including the fulfillment id, changed_by), (2) the shipment under the mark tracking_edit (carrier, number,
--    notify_customer, delivery_status confirmed, delivery_status_at now, delivered_at NULL, tracking_version v, and the creation
--    fingerprint when it is still NULL), (3) the event confirmed / tracking_edit, (4) when the shipment completes its order and the
--    order is shipped, the order carrier and number are written again (reason admin_update_fulfillment_tracking). Then the leader
--    (the first active shipment by order id): its registrations are stopped as replaced, its open attention is closed, the
--    registration helper creates the parent row of version v and, when tracking is on, the leader registration of version v; then,
--    for notify_customer, one shipping_update email per shipment. Then the slip (mark tracking: carrier, number, tracking_version,
--    version + 1), its tracking_update version row, the item-state differences (a delivered slip becomes shipped again, reason
--    shipment_slip_tracking_update) and the operation row (operation shipment_slip_tracking_update).
--    A read result delivered with a lease of an older tracking version never reaches the new state: the old registration is stopped
--    and the shipment tracking_version differs, so record_delivery_read_result returns applied = false.
--    Result {id, version, trackingVersion, replayed}.
CREATE FUNCTION private.admin_update_shipment_slip_tracking(_slip_id uuid, _expected_version integer, _carrier text, _tracking_number text,
  _notify_customer boolean, _actor_id uuid, _request_key uuid)
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
  v_new_version integer;
  v_change_id uuid;
  v_fulfillment_ids uuid[] := ARRAY[]::uuid[];
  v_change_ids uuid[] := ARRAY[]::uuid[];
  v_index integer;
  v_version integer;
  v_result jsonb;
  v_previous_operation text;
  v_previous_actor text;
  v_previous_reason text;
  v_previous_change text;
  v_previous_fulfillment text;
BEGIN
  _tracking_number := NULLIF(pg_catalog.btrim(_tracking_number), '');
  IF _slip_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL
    OR _notify_customer IS NULL
    OR (_carrier IS NOT NULL AND _carrier NOT IN ('yamato','sagawa','japanpost'))
    OR (_tracking_number IS NOT NULL AND _tracking_number !~ '^[0-9A-Za-z-]{1,64}$') THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _carrier IS NULL OR _tracking_number IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_TRACKING_INCOMPLETE' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
      ARRAY['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_slip_tracking_update', 'slip_id', _slip_id, 'carrier', _carrier, 'tracking_number', _tracking_number,
    'notify_customer', _notify_customer, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_slip_tracking_update' AND op.request_key = _request_key;
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
  IF v_slip.shipping_carrier IS NOT DISTINCT FROM _carrier
    AND pg_catalog.upper(v_slip.tracking_number) IS NOT DISTINCT FROM pg_catalog.upper(_tracking_number) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_TRACKING_UNCHANGED' USING ERRCODE = '22023';
  END IF;

  v_new_version := v_slip.tracking_version + 1;
  SELECT pg_catalog.array_agg(sf.order_id ORDER BY sf.order_id) INTO v_orders
    FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = _slip_id;
  v_before := private.capture_group_g_item_states(v_orders);
  v_previous_operation := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_previous_actor := pg_catalog.current_setting('app.order_actor_id', true);
  v_previous_reason := pg_catalog.current_setting('app.order_change_reason', true);
  v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  v_previous_fulfillment := pg_catalog.current_setting('app.fulfillment_change', true);
  BEGIN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
    FOR v_shipment IN
      SELECT sf.order_id, f.id AS fulfillment_id, f.shipping_carrier AS old_carrier, f.tracking_number AS old_number, f.completes_order
      FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
      WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL
      ORDER BY sf.order_id
    LOOP
      INSERT INTO public.order_fulfillment_tracking_changes(fulfillment_id, from_carrier, to_carrier, from_tracking_number,
        to_tracking_number, tracking_version, notify_customer, request_key, request_fingerprint, changed_by)
      VALUES(v_shipment.fulfillment_id, v_shipment.old_carrier, _carrier, v_shipment.old_number, _tracking_number, v_new_version,
        _notify_customer,
        pg_catalog.md5('slip_tracking:' || _request_key::text || ':' || v_shipment.fulfillment_id::text)::uuid,
        pg_catalog.md5(pg_catalog.jsonb_build_object('order_id', v_shipment.order_id, 'fulfillment_id', v_shipment.fulfillment_id,
          'shipping_carrier', _carrier, 'tracking_number', _tracking_number, 'notify_customer', _notify_customer)::text),
        _actor_id)
      RETURNING id INTO v_change_id;
      PERFORM pg_catalog.set_config('app.fulfillment_change', 'tracking_edit', true);
      UPDATE public.order_fulfillments AS f SET shipping_carrier = _carrier, tracking_number = _tracking_number,
        notify_customer = _notify_customer, delivery_status = 'confirmed', delivery_status_at = pg_catalog.now(), delivered_at = NULL,
        tracking_version = v_new_version,
        request_fingerprint = COALESCE(f.request_fingerprint, private.fulfillment_create_fingerprint(f.order_id, f.shipping_carrier,
          f.tracking_number, f.notify_customer, private.fulfillment_lines_json(f.id)))
        WHERE f.id = v_shipment.fulfillment_id;
      PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous_fulfillment, ''), true);
      INSERT INTO public.order_fulfillment_events(fulfillment_id, tracking_version, status, happened_at, source)
        VALUES(v_shipment.fulfillment_id, v_new_version, 'confirmed', pg_catalog.now(), 'tracking_edit');
      IF v_shipment.completes_order THEN
        PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
        PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_update_fulfillment_tracking', true);
        UPDATE public.orders SET shipping_carrier = _carrier, tracking_number = _tracking_number
          WHERE id = v_shipment.order_id AND status = 'shipped'::public.order_status;
      END IF;
      v_fulfillment_ids := v_fulfillment_ids || v_shipment.fulfillment_id;
      v_change_ids := v_change_ids || v_change_id;
    END LOOP;
    -- the leader is the first active shipment by order id (the registration helper picks the same one)
    PERFORM private.stop_fulfillment_registrations(v_fulfillment_ids[1], 'replaced');
    PERFORM private.close_delivery_attention(v_fulfillment_ids[1]);
    PERFORM private.register_group_g_slip_tracking(_slip_id, v_new_version, _actor_id, v_operation);
    IF _notify_customer THEN
      FOR v_index IN 1..pg_catalog.cardinality(v_fulfillment_ids) LOOP
        PERFORM private.enqueue_delivery_email(v_fulfillment_ids[v_index], v_new_version, 'shipping_update', v_change_ids[v_index]);
      END LOOP;
    END IF;
    PERFORM pg_catalog.set_config('app.group_g_slip_change', 'tracking', true);
    UPDATE public.shipment_slips SET shipping_carrier = _carrier, tracking_number = _tracking_number,
      tracking_version = v_new_version, version = version + 1, updated_at = pg_catalog.now()
      WHERE id = _slip_id RETURNING version INTO v_version;
    INSERT INTO public.shipment_slip_versions(slip_id, version, kind, shipping_carrier, tracking_number, tracking_version, shipment_date, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'tracking_update', _carrier, _tracking_number, v_new_version, v_slip.shipment_date, _actor_id, v_operation);
    PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'shipment_slip_tracking_update', _actor_id);
    v_result := pg_catalog.jsonb_build_object('id', _slip_id::text, 'version', v_version, 'trackingVersion', v_new_version, 'replayed', false);
    INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
      VALUES(v_operation, 'shipment_slip_tracking_update', _request_key, v_fingerprint, 'shipment_slip', _slip_id::text, _actor_id, v_result);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
    PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_previous_actor, ''), true);
    PERFORM pg_catalog.set_config('app.order_change_reason', COALESCE(v_previous_reason, ''), true);
    PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
    PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous_fulfillment, ''), true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_previous_actor, ''), true);
  PERFORM pg_catalog.set_config('app.order_change_reason', COALESCE(v_previous_reason, ''), true);
  PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
  PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous_fulfillment, ''), true);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_update_shipment_slip_tracking(_slip_id uuid, _expected_version integer, _carrier text, _tracking_number text,
  _notify_customer boolean, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_update_shipment_slip_tracking(_slip_id, _expected_version, _carrier, _tracking_number, _notify_customer, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid) TO service_role;

-- 2. Mark a whole confirmed slip as delivered by hand (FREQ-534-AC-02, FREQ-535-AC-04). The returns deadline reads the delivered time
--    through the existing function fulfillment_line_returnable, which is not changed.
--    Order of work: argument check (22023) -> lock helper (advisory first; settings FOR SHARE) -> permission (42501) -> fingerprint
--    {operation, slip_id, delivered_on, notify_customer, actor_id} and replay / conflict (23505) -> existence (P0002) -> cancelled is
--    GROUP_G_SLIP_CANCELLED, anything but confirmed GROUP_G_SLIP_NOT_CONFIRMED -> version -> any active shipment already delivered is
--    GROUP_G_SLIP_ALREADY_DELIVERED (55000) -> a delivered_on before the JST date of the shipping time or after the JST today is
--    GROUP_G_SLIP_DELIVERY_DATE_INVALID (22023).
--    Writes, for each active shipment in order id ascending: the shipment under the mark manual (delivery_status delivered,
--    delivery_status_at = delivered_at = GREATEST(shipped_at, LEAST(delivered_on 12:00 JST, now()))), the event delivered / manual
--    (created_by, a request key derived from the common key, the E-4 fingerprint); for the leader the registration is stopped as
--    delivered (the E-4 update) and its open attention is closed; the email delivered only when both the shipment notify_customer and
--    the input are on. Then the slip (mark deliver: version + 1 only), its delivered version row, the item-state differences
--    (shipped -> delivered, reason shipment_slip_deliver) and the operation row (operation shipment_slip_deliver).
--    Result {id, version, deliveredAt, replayed}; deliveredAt is the UTC time of the leader shipment as YYYY-MM-DDTHH:MI:SS.MSZ.
CREATE FUNCTION private.admin_mark_shipment_slip_delivered(_slip_id uuid, _expected_version integer, _delivered_on date,
  _notify_customer boolean, _actor_id uuid, _request_key uuid)
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
  v_leader uuid;
  v_delivered_at timestamptz;
  v_first_delivered_at timestamptz;
  v_version integer;
  v_result jsonb;
  v_previous_operation text;
  v_previous_change text;
  v_previous_fulfillment text;
BEGIN
  IF _slip_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _delivered_on IS NULL OR _notify_customer IS NULL
    OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
      ARRAY['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_slip_deliver', 'slip_id', _slip_id, 'delivered_on', _delivered_on,
    'notify_customer', _notify_customer, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_slip_deliver' AND op.request_key = _request_key;
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
  IF EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
    WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL AND f.delivered_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ALREADY_DELIVERED' USING ERRCODE = '55000';
  END IF;
  IF _delivered_on > (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date OR EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
    WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL AND (f.shipped_at AT TIME ZONE 'Asia/Tokyo')::date > _delivered_on
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_DELIVERY_DATE_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(sf.order_id ORDER BY sf.order_id) INTO v_orders
    FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = _slip_id;
  SELECT f.id INTO v_leader FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
    WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL ORDER BY sf.order_id LIMIT 1;
  v_before := private.capture_group_g_item_states(v_orders);
  v_previous_operation := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  v_previous_fulfillment := pg_catalog.current_setting('app.fulfillment_change', true);
  BEGIN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
    FOR v_shipment IN
      SELECT sf.order_id, f.id AS fulfillment_id, f.shipped_at, f.tracking_version, f.notify_customer
      FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
      WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL
      ORDER BY sf.order_id
    LOOP
      v_delivered_at := GREATEST(v_shipment.shipped_at,
        LEAST((_delivered_on + TIME '12:00') AT TIME ZONE 'Asia/Tokyo', pg_catalog.now()));
      IF v_first_delivered_at IS NULL THEN
        v_first_delivered_at := v_delivered_at;
      END IF;
      PERFORM pg_catalog.set_config('app.fulfillment_change', 'manual', true);
      UPDATE public.order_fulfillments SET delivery_status = 'delivered', delivery_status_at = v_delivered_at, delivered_at = v_delivered_at
        WHERE id = v_shipment.fulfillment_id;
      PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous_fulfillment, ''), true);
      INSERT INTO public.order_fulfillment_events(fulfillment_id, tracking_version, status, happened_at, source, created_by, request_key, request_fingerprint)
        VALUES(v_shipment.fulfillment_id, v_shipment.tracking_version, 'delivered', v_delivered_at, 'manual', _actor_id,
          pg_catalog.md5('slip_delivered:' || _request_key::text || ':' || v_shipment.fulfillment_id::text)::uuid,
          pg_catalog.md5(pg_catalog.jsonb_build_object('order_id', v_shipment.order_id, 'fulfillment_id', v_shipment.fulfillment_id,
            'delivered_on', _delivered_on, 'notify_customer', _notify_customer)::text));
      IF v_shipment.fulfillment_id = v_leader THEN
        UPDATE private.fulfillment_tracking_registrations AS r
          SET state = 'stopped', stop_reason = 'delivered', stopped_at = pg_catalog.now(), failure_kind = NULL,
              lease_token = NULL, lease_expires_at = NULL
          WHERE r.fulfillment_id = v_shipment.fulfillment_id AND r.tracking_version = v_shipment.tracking_version AND r.state <> 'stopped';
        PERFORM private.close_delivery_attention(v_shipment.fulfillment_id);
      END IF;
      IF v_shipment.notify_customer AND _notify_customer THEN
        PERFORM private.enqueue_delivery_email(v_shipment.fulfillment_id, v_shipment.tracking_version, 'delivered');
      END IF;
    END LOOP;
    PERFORM pg_catalog.set_config('app.group_g_slip_change', 'deliver', true);
    UPDATE public.shipment_slips SET version = version + 1, updated_at = pg_catalog.now()
      WHERE id = _slip_id RETURNING version INTO v_version;
    INSERT INTO public.shipment_slip_versions(slip_id, version, kind, shipping_carrier, tracking_number, tracking_version, shipment_date, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'delivered', v_slip.shipping_carrier, v_slip.tracking_number, v_slip.tracking_version, v_slip.shipment_date, _actor_id, v_operation);
    PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'shipment_slip_deliver', _actor_id);
    v_result := pg_catalog.jsonb_build_object('id', _slip_id::text, 'version', v_version,
      'deliveredAt', pg_catalog.to_char(v_first_delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'replayed', false);
    INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
      VALUES(v_operation, 'shipment_slip_deliver', _request_key, v_fingerprint, 'shipment_slip', _slip_id::text, _actor_id, v_result);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
    PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
    PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous_fulfillment, ''), true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
  PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous_fulfillment, ''), true);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_mark_shipment_slip_delivered(_slip_id uuid, _expected_version integer, _delivered_on date,
  _notify_customer boolean, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_mark_shipment_slip_delivered(_slip_id, _expected_version, _delivered_on, _notify_customer, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid) TO service_role;

-- 3. The closed list of writers. The 72 entries of 20261025100130_group_g3_shipping_slips.sql stay exactly as they were; this file
--    appends the tracking update and the manual delivery (73-74). Later G-3 tasks append their writers while this file is not
--    applied anywhere. Owner, ACL and signature of the function are unchanged (CREATE OR REPLACE keeps them).
--    group_g1_writer_inventory scans pg_proc.prosrc against it.
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
    'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)',
    'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
    'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)'
  ]::pg_catalog.regprocedure[];
$$;

-- G3D_BODY_END

-- G3D_FINAL_ASSERT_BEGIN
-- Expectation through Task 7: the four new functions (owner, SECURITY, language, result type, argument names, search_path, and the
-- EXECUTE rights read from the effective ACL where a NULL proacl means the default that includes PUBLIC), the same four as a set (no
-- function of these names beyond them; service_role may EXECUTE exactly the two operation writers and their two public entrances),
-- the order of each writer (the lock helper before any table is read), and the allowlist: exactly the 72 entries of the previous
-- file plus the two writers of this file, every one resolving to a function, compared to the fixed set by OID. The expected sets
-- grow with every Task that adds to this file.
DO $g3d_final_objects$
DECLARE
  v_failed text;
  v_functions text[] := ARRAY[
    'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
    'public.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
    'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)',
    'public.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)'
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
    'private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)',
    'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
    'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)'
  ];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_carrier', '_tracking_number', '_notify_customer', '_actor_id', '_request_key']),
      ('public.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_carrier', '_tracking_number', '_notify_customer', '_actor_id', '_request_key']),
      ('private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_delivered_on', '_notify_customer', '_actor_id', '_request_key']),
      ('public.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_delivered_on', '_notify_customer', '_actor_id', '_request_key'])
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
       OR NOT ('search_path=""' = ANY (COALESCE(p.proconfig, ARRAY[]::text[])))
       OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') <> e.service
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x
                  WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  ) THEN
    v_failed := 'shipment_slip_action_functions';
  ELSIF EXISTS (
    -- the two writers: the text before the first call of the lock helper must not name a table (after from / join / into /
    -- update / table, with or without ONLY) and must not call a function of public or private (a permission check or any other
    -- helper that reads a table). Compared in lower case, with any spacing and with quoted schema names, so a body written in
    -- another style cannot slip by. A body that never calls the lock helper fails too.
    SELECT 1 FROM pg_catalog.unnest(ARRAY[
      'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
      'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)'
    ]) AS w(sig)
    JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(w.sig)
    WHERE CASE
      WHEN pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'private.lock_group_g_shipment_slips(') = 0 THEN true
      ELSE pg_catalog.substr(pg_catalog.lower(p.prosrc), 1, pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'private.lock_group_g_shipment_slips(') - 1)
        ~ '((from|join|into|update|table)\s+(only\s+)?"?(public|private)"?\s*\.)|("?(public|private)"?\s*\.\s*"?[a-z_][a-z0-9_]*"?\s*\()'
    END
  ) THEN
    v_failed := 'shipment_slip_action_lock_order';
  ELSIF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_writers) AS w(s) WHERE pg_catalog.to_regprocedure(w.s) IS NULL)
     OR (SELECT pg_catalog.count(DISTINCT pg_catalog.to_regprocedure(w.s)) FROM pg_catalog.unnest(v_writers) AS w(s)) <> 74
     OR pg_catalog.cardinality(private.group_g_writer_allowlist()) <> 74 THEN
    v_failed := 'shipment_slip_action_writer_allowlist_missing';
  ELSIF (SELECT pg_catalog.array_agg(x::oid ORDER BY x::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS a(x))
     IS DISTINCT FROM (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(w.s)::oid ORDER BY pg_catalog.to_regprocedure(w.s)::oid)
                       FROM pg_catalog.unnest(v_writers) AS w(s)) THEN
    v_failed := 'shipment_slip_action_writer_allowlist';
  -- the functions of this file as a set: a function of one of these names (in public or private) is one of the four listed above
  -- and every listed one exists, so an extra overload or a missing function fails.
  ELSIF (SELECT pg_catalog.array_agg(p.oid ORDER BY p.oid)
         FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'private')
           AND p.proname IN ('admin_update_shipment_slip_tracking', 'admin_mark_shipment_slip_delivered'))
        IS DISTINCT FROM
        (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(f.sig)::oid ORDER BY pg_catalog.to_regprocedure(f.sig)::oid)
         FROM pg_catalog.unnest(v_functions) AS f(sig)) THEN
    v_failed := 'shipment_slip_action_function_set';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g3d_final_objects$;
-- G3D_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
