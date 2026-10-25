-- G-3 shipment-slip actions (Task 7): entering or correcting the tracking number of a whole confirmed slip and marking a whole
-- confirmed slip as delivered by hand (FREQ-534-AC-01, FREQ-534-AC-02, FREQ-534-AC-04, FREQ-534-AC-05, FREQ-535-AC-04,
-- FREQ-540-AC-10, FREQ-540-AC-11), and the writer allowlist (72 entries of 20261025100130_group_g3_shipping_slips.sql + the three
-- writers of this file = 75). Task 8 (FREQ-534-AC-04, FREQ-541-AC-03) replaces private.record_delivery_read_result so that the
-- read result of the leader of a slip reaches every shipment of the slip (section 2b); it is already one of the 75 writers.
-- Later G-3 tasks extend the body section of this file while it is not applied anywhere.
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

-- 2b. The delivery read result reaches every shipment of a slip (FREQ-534-AC-04, FREQ-541-AC-03). The body is that of
--     private.record_delivery_read_result in 20261023211425_group_g1_allocation.sql (its Japanese comments are translated, nothing
--     else of it is rewritten) with these differences and no others:
--     (1) When the shipment is the leader of a slip (a parent row of this tracking version names it), every table of the lock
--         sequence is locked for ALL orders of the slip before the next table is started (the sequence of tables is the one of the
--         G-1 body and of the shared inventory lock helper; no table is returned to). A shipment that leads no slip locks its
--         own order exactly as before. The shared inventory lock helper is not used: this worker keeps the narrow range of G-1.
--     (2) v_targets is the leader first and then the other active shipments of the slip on the same tracking version (order id
--         ascending), or only the shipment itself. The event row, the status update, the out_for_delivery and delivered emails and
--         the delivered reflection (operation row and item states, each under its own key) are written for every target with the
--         same content.
--     (3) The registration row, the attention rows and the returned row stay with the leader and are written once.
--     Owner, ACL, signature and attributes are those of the G-1 function (CREATE OR REPLACE keeps them).
CREATE OR REPLACE FUNCTION private.record_delivery_read_result(
  _fulfillment_id uuid,
  _tracking_version integer,
  _lease_token uuid,
  _result jsonb
)
RETURNS TABLE (applied boolean, changed boolean, stopped boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_enabled boolean;
  v_order_id uuid;
  v_f public.order_fulfillments;
  v_r private.fulfillment_tracking_registrations;
  v_outcome text;
  v_status text;
  v_provider_status text;
  v_provider_sub text;
  v_error text;
  v_happened timestamptz;
  v_delivered timestamptz;
  v_read_at timestamptz;
  v_event_at timestamptz;
  v_newest timestamptz;
  v_delivered_at timestamptz;
  v_attempts integer;
  v_advanced boolean;
  v_next timestamptz;
  v_old boolean := false;
  v_changed boolean := false;
  v_stop boolean := false;
  v_request_key uuid;
  v_record boolean := false;
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_slip_id uuid;
  v_orders uuid[];
  v_targets uuid[];
  v_target uuid;
  v_t public.order_fulfillments;
BEGIN
  IF _fulfillment_id IS NULL OR _tracking_version IS NULL OR _tracking_version < 1 OR _lease_token IS NULL
     OR _result IS NULL OR pg_catalog.jsonb_typeof(_result) <> 'object' THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_outcome := _result ->> 'outcome';
  IF v_outcome IS NULL OR v_outcome NOT IN ('ok', 'not_found', 'not_registered', 'invalid_number', 'transient', 'account') THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_status := NULLIF(_result ->> 'status', '');
  IF v_status IS NOT NULL
     AND v_status NOT IN ('confirmed', 'in_transit', 'out_for_delivery', 'attempted_delivery', 'ready_for_pickup', 'delivered', 'delayed', 'failure') THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_outcome <> 'ok' THEN
    v_status := NULL;
  END IF;

  BEGIN
    v_read_at := (_result ->> 'read_at')::timestamptz;
    v_happened := (_result ->> 'happened_at')::timestamptz;
    v_delivered := (_result ->> 'delivered_at')::timestamptz;
  EXCEPTION WHEN SQLSTATE '22007' OR SQLSTATE '22008' THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END;
  IF v_read_at IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- The provider times are never later than the read time (a misread time zone must not create a future event that makes every later
  -- read look old). A time that is absent (NULL) stays NULL (LEAST skips NULL, so it would otherwise turn into the read time).
  IF v_happened IS NOT NULL THEN
    v_happened := LEAST(v_happened, v_read_at);
  END IF;
  IF v_delivered IS NOT NULL THEN
    v_delivered := LEAST(v_delivered, v_read_at);
  END IF;
  v_event_at := COALESCE(v_happened, v_read_at);
  v_provider_status := NULLIF(pg_catalog.left(_result ->> 'provider_status', 100), '');
  v_provider_sub := NULLIF(pg_catalog.left(_result ->> 'provider_sub_status', 100), '');
  -- A malformed error_code is emptied instead of refusing the result, unlike the registration and stop results.
  -- error_code is a diagnostic symbol; a quirk of 17TRACK must not stop the status from being recorded.
  v_error := _result ->> 'error_code';
  IF v_error IS NOT NULL AND v_error !~ '^[a-z0-9_-]{1,64}$' THEN
    v_error := NULL;
  END IF;

  -- Reads only until the common advisory is held (the fulfillment's order never changes).
  SELECT f.order_id INTO v_order_id FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);

  -- Row 1: setting off, version mismatch, cancelled, token mismatch and lease expiry write nothing (an unknown shipment too)
  SELECT s.delivery_tracking_enabled INTO v_enabled FROM public.shop_settings AS s WHERE s.id = 1 FOR SHARE;
  IF NOT COALESCE(v_enabled, false) THEN
    RETURN QUERY SELECT false, false, false;
    RETURN;
  END IF;
  IF v_order_id IS NULL THEN
    RETURN QUERY SELECT false, false, false;
    RETURN;
  END IF;

  -- The slip this shipment leads for this tracking version, if any. Both tables are append-only, so a read under the common
  -- advisory is stable.
  SELECT sr.slip_id INTO v_slip_id
  FROM private.shipment_tracking_registrations AS sr
  WHERE sr.leader_fulfillment_id = _fulfillment_id
    AND sr.tracking_version = _tracking_version;

  IF v_slip_id IS NULL THEN
    -- Not the leader of a slip: its own order only, exactly as in G-1.
    PERFORM o.id FROM public.orders AS o WHERE o.id = v_order_id FOR UPDATE;
    PERFORM oi.id FROM public.order_items AS oi WHERE oi.order_id = v_order_id ORDER BY oi.id FOR UPDATE;
    PERFORM a.id FROM public.order_item_allocations AS a
      WHERE a.order_item_id IN (SELECT oi.id FROM public.order_items AS oi WHERE oi.order_id = v_order_id)
      ORDER BY a.id FOR UPDATE;
    PERFORM r.id FROM public.order_returns AS r WHERE r.order_id = v_order_id ORDER BY r.id FOR UPDATE;
    PERFORM l.id FROM public.order_return_lines AS l
      WHERE l.return_id IN (SELECT r.id FROM public.order_returns AS r WHERE r.order_id = v_order_id)
      ORDER BY l.id FOR UPDATE;
    PERFORM r.id FROM public.order_return_receipts AS r
      WHERE r.return_id IN (SELECT x.id FROM public.order_returns AS x WHERE x.order_id = v_order_id)
      ORDER BY r.id FOR UPDATE;
    PERFORM l.id FROM public.order_return_receipt_lines AS l
      WHERE l.receipt_id IN (SELECT r.id FROM public.order_return_receipts AS r
        JOIN public.order_returns AS x ON x.id = r.return_id WHERE x.order_id = v_order_id)
      ORDER BY l.id FOR UPDATE;
    PERFORM r.id FROM public.order_refunds AS r WHERE r.order_id = v_order_id ORDER BY r.id FOR UPDATE;
    PERFORM l.id FROM public.order_refund_lines AS l
      WHERE l.refund_id IN (SELECT r.id FROM public.order_refunds AS r WHERE r.order_id = v_order_id)
      ORDER BY l.id FOR UPDATE;
    PERFORM r.id FROM public.order_cancel_requests AS r WHERE r.order_id = v_order_id ORDER BY r.id FOR UPDATE;
    PERFORM l.id FROM public.order_cancel_request_lines AS l
      WHERE l.cancel_request_id IN (SELECT r.id FROM public.order_cancel_requests AS r WHERE r.order_id = v_order_id)
      ORDER BY l.id FOR UPDATE;
    PERFORM f.id FROM public.order_fulfillments AS f WHERE f.order_id = v_order_id ORDER BY f.id FOR UPDATE;
  ELSE
    -- The leader of a slip: the same tables in the same sequence, each locked for all orders of the slip (order id ascending)
    -- before the next table is started. No table is returned to.
    SELECT pg_catalog.array_agg(DISTINCT sf.order_id ORDER BY sf.order_id) INTO v_orders
    FROM public.shipment_slip_fulfillments AS sf
    WHERE sf.slip_id = v_slip_id;
    PERFORM o.id FROM public.orders AS o WHERE o.id = ANY(v_orders) ORDER BY o.id FOR UPDATE;
    PERFORM oi.id FROM public.order_items AS oi WHERE oi.order_id = ANY(v_orders) ORDER BY oi.id FOR UPDATE;
    PERFORM a.id FROM public.order_item_allocations AS a
      WHERE a.order_item_id IN (SELECT oi.id FROM public.order_items AS oi WHERE oi.order_id = ANY(v_orders))
      ORDER BY a.id FOR UPDATE;
    PERFORM r.id FROM public.order_returns AS r WHERE r.order_id = ANY(v_orders) ORDER BY r.id FOR UPDATE;
    PERFORM l.id FROM public.order_return_lines AS l
      WHERE l.return_id IN (SELECT r.id FROM public.order_returns AS r WHERE r.order_id = ANY(v_orders))
      ORDER BY l.id FOR UPDATE;
    PERFORM r.id FROM public.order_return_receipts AS r
      WHERE r.return_id IN (SELECT x.id FROM public.order_returns AS x WHERE x.order_id = ANY(v_orders))
      ORDER BY r.id FOR UPDATE;
    PERFORM l.id FROM public.order_return_receipt_lines AS l
      WHERE l.receipt_id IN (SELECT r.id FROM public.order_return_receipts AS r
        JOIN public.order_returns AS x ON x.id = r.return_id WHERE x.order_id = ANY(v_orders))
      ORDER BY l.id FOR UPDATE;
    PERFORM r.id FROM public.order_refunds AS r WHERE r.order_id = ANY(v_orders) ORDER BY r.id FOR UPDATE;
    PERFORM l.id FROM public.order_refund_lines AS l
      WHERE l.refund_id IN (SELECT r.id FROM public.order_refunds AS r WHERE r.order_id = ANY(v_orders))
      ORDER BY l.id FOR UPDATE;
    PERFORM r.id FROM public.order_cancel_requests AS r WHERE r.order_id = ANY(v_orders) ORDER BY r.id FOR UPDATE;
    PERFORM l.id FROM public.order_cancel_request_lines AS l
      WHERE l.cancel_request_id IN (SELECT r.id FROM public.order_cancel_requests AS r WHERE r.order_id = ANY(v_orders))
      ORDER BY l.id FOR UPDATE;
    PERFORM f.id FROM public.order_fulfillments AS f WHERE f.order_id = ANY(v_orders) ORDER BY f.id FOR UPDATE;
  END IF;
  SELECT f.* INTO v_f FROM public.order_fulfillments AS f WHERE f.id = _fulfillment_id;

  SELECT r.* INTO v_r
  FROM private.fulfillment_tracking_registrations AS r
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = _tracking_version
  FOR UPDATE;
  IF NOT FOUND
     OR v_r.lease_token IS DISTINCT FROM _lease_token
     OR v_r.lease_expires_at IS NULL
     OR v_r.lease_expires_at <= pg_catalog.now()
     OR v_r.state <> 'registered'
     OR v_f.cancelled_at IS NOT NULL
     OR v_f.tracking_version <> _tracking_version THEN
    RETURN QUERY SELECT false, false, false;
    RETURN;
  END IF;

  -- The shipments that receive this result: this one (the leader of its slip, or a shipment on no slip) first, then the other
  -- active shipments of the slip on the same tracking version that are not delivered yet, by order id. All of them are locked above.
  -- (No current path delivers a participant while its leader is not: slip delivery is all-or-nothing. The filter keeps a later
  -- non-delivered read from clearing the delivered time of such a shipment if one ever appears.)
  v_targets := ARRAY[_fulfillment_id];
  IF v_slip_id IS NOT NULL THEN
    v_targets := v_targets || COALESCE((
      SELECT pg_catalog.array_agg(f.id ORDER BY sf.order_id)
      FROM public.shipment_slip_fulfillments AS sf
      JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
      WHERE sf.slip_id = v_slip_id
        AND f.id <> _fulfillment_id
        AND f.cancelled_at IS NULL
        AND f.delivered_at IS NULL
        AND f.tracking_version = _tracking_version
    ), ARRAY[]::uuid[]);
  END IF;

  -- Row 2: already delivered. The status is not moved; only the registration is stopped as delivered
  IF v_f.delivered_at IS NOT NULL THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'stopped',
        stop_reason = 'delivered',
        stopped_at = pg_catalog.now(),
        failure_kind = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        stop_signaled = false,
        provider_stop_pending = false
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    PERFORM private.close_delivery_attention(_fulfillment_id);
    RETURN QUERY SELECT true, false, true;
    RETURN;
  END IF;

  -- Row 3: 17TRACK does not hold the registration yet. Back to waiting for registration, and register again right now
  -- (ever_registered and registered_at are kept)
  IF v_outcome = 'not_registered' THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'pending',
        last_read_at = v_read_at,
        last_error_code = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_run_at = pg_catalog.now()
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    RETURN QUERY SELECT true, false, false;
    RETURN;
  END IF;

  -- Row 3a: the number is not valid. Classified as at registration time; tracking_not_found is opened at once
  IF v_outcome = 'invalid_number' THEN
    UPDATE private.fulfillment_tracking_registrations AS r
    SET state = 'failed',
        failure_kind = 'invalid_number',
        retry_allowed = false,
        last_read_at = v_read_at,
        last_error_code = v_error,
        lease_token = NULL,
        lease_expires_at = NULL
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', true);
    RETURN QUERY SELECT true, false, false;
    RETURN;
  END IF;

  -- Row 4: a transient or an account failure. The previous status is kept. read_attempts counts transient failures only
  -- (5 minutes / 15 minutes / 1 hour / 6 hours); an account failure waits 6 hours
  IF v_outcome IN ('transient', 'account') THEN
    v_attempts := CASE WHEN v_outcome = 'transient' THEN v_r.read_attempts + 1 ELSE v_r.read_attempts END;
    UPDATE private.fulfillment_tracking_registrations AS r
    SET read_attempts = v_attempts,
        last_error_code = v_error,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_run_at = pg_catalog.now() + CASE
          WHEN v_outcome = 'account' THEN interval '6 hours'
          WHEN v_attempts <= 1 THEN interval '5 minutes'
          WHEN v_attempts = 2 THEN interval '15 minutes'
          WHEN v_attempts = 3 THEN interval '1 hour'
          ELSE interval '6 hours'
        END
    WHERE r.fulfillment_id = _fulfillment_id
      AND r.tracking_version = _tracking_version;
    RETURN QUERY SELECT true, false, false;
    RETURN;
  END IF;

  -- From here a successful read (ok, not_found). If a signal advanced while it was leased the next read is now, else in 6 hours
  v_advanced := v_r.signal_revision > COALESCE(v_r.claimed_signal_revision, 0);
  v_next := pg_catalog.now() + CASE WHEN v_advanced THEN interval '0 seconds' ELSE interval '6 hours' END;

  IF v_outcome = 'ok' THEN
    -- Row 7: before the newest tracking event of the same version, neither the status nor the events change (shipment and
    -- correction times are not compared). An ok without a status (row 6) is compared the same way, so an old read's symbol does
    -- not overwrite a newer one
    SELECT pg_catalog.max(e.happened_at) INTO v_newest
    FROM public.order_fulfillment_events AS e
    WHERE e.fulfillment_id = _fulfillment_id
      AND e.tracking_version = _tracking_version
      AND e.source = 'tracking';
    v_old := v_newest IS NOT NULL AND v_event_at < v_newest;

    IF v_status IS NULL THEN
      -- Row 6: an unknown status. 17TRACK holds information, so the package-not-found attention is closed.
      -- Status, events and emails do not change; only the provider symbols and the read time are written below
      PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', false);
    ELSIF NOT v_old THEN
      IF v_status = v_f.delivery_status THEN
        -- Row 8: the same status. No event is added; only the package-not-found attention is closed because information exists
        PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', false);
      ELSE
        -- Rows 9/10: a different status. One event row for every target (the same version, status and time never repeat, by the
        -- unique key). The status takes the result in the order of the leases
        INSERT INTO public.order_fulfillment_events (fulfillment_id, tracking_version, status, happened_at, source, provider_sub_status)
        SELECT t.id, _tracking_version, v_status, v_event_at, 'tracking', v_provider_sub
        FROM pg_catalog.unnest(v_targets) AS t(id)
        ON CONFLICT ON CONSTRAINT order_fulfillment_events_once_key DO NOTHING;
        PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', false);

        IF v_status = 'delivered' THEN
          -- Row 10: the delivered time is never before the shipping time of the shipment it is written for. The registration is
          -- stopped as delivered, every attention is closed, and with notification on one delivered email. Each target also
          -- moves its item states in the same transaction (G-1), under its own operation row and key.
          FOREACH v_target IN ARRAY v_targets LOOP
            SELECT f.* INTO v_t FROM public.order_fulfillments AS f WHERE f.id = v_target;
            v_delivered_at := GREATEST(COALESCE(v_delivered, v_event_at), v_t.shipped_at);
            v_operation := pg_catalog.gen_random_uuid();
            -- Both branches are the same expression (the leader's key is the G-1 text, a participant's has its own shipment id).
            -- The CASE exists only to keep the G-1 text verbatim for the source-text pin in group_g1_delivery; do not "simplify" it
            -- to one expression with v_target without changing that suite.
            v_request_key := CASE WHEN v_target = _fulfillment_id
              THEN pg_catalog.md5('delivery:' || _fulfillment_id::text || ':' || _tracking_version::text || ':' || 'delivered')::uuid
              ELSE pg_catalog.md5('delivery:' || v_target::text || ':' || _tracking_version::text || ':' || 'delivered')::uuid
            END;
            -- A recorded reflection of the same version and event adds nothing.
            v_record := NOT EXISTS (SELECT 1 FROM private.group_g_operations AS g
              WHERE g.operation = 'delivery_reflect' AND g.request_key = v_request_key);
            IF v_record THEN
              v_before := private.capture_group_g_item_states(ARRAY[v_t.order_id]);
              PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
            END IF;
            PERFORM private.apply_tracking_status(v_target, 'delivered', v_delivered_at, v_delivered_at);
            IF v_target = _fulfillment_id THEN
              UPDATE private.fulfillment_tracking_registrations AS r
              SET state = 'stopped',
                  stop_reason = 'delivered',
                  stopped_at = pg_catalog.now(),
                  failure_kind = NULL,
                  provider_status = v_provider_status,
                  provider_sub_status = v_provider_sub,
                  last_read_at = v_read_at,
                  read_attempts = 0,
                  last_error_code = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  stop_signaled = false,
                  provider_stop_pending = false
              WHERE r.fulfillment_id = _fulfillment_id
                AND r.tracking_version = _tracking_version;
              PERFORM private.close_delivery_attention(_fulfillment_id);
            END IF;
            PERFORM private.enqueue_delivery_email(v_target, _tracking_version, 'delivered');
            IF v_record THEN
              PERFORM private.record_group_g_item_state_changes(v_before, ARRAY[v_t.order_id], v_operation, 1,
                'delivery_reflect', NULL);
              INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
              VALUES (v_operation, 'delivery_reflect', v_request_key,
                pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
                  'operation', 'delivery_reflect', 'fulfillment_id', v_target, 'tracking_version', _tracking_version,
                  'event', 'delivered', 'delivered_at', v_delivered_at)::text, 'UTF8')), 'hex'),
                'fulfillment', v_target::text, NULL,
                pg_catalog.jsonb_build_object('fulfillment_id', v_target, 'order_id', v_t.order_id,
                  'tracking_version', _tracking_version, 'event', 'delivered', 'delivered_at', v_delivered_at));
              PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
            END IF;
          END LOOP;
          RETURN QUERY SELECT true, true, true;
          RETURN;
        END IF;

        FOREACH v_target IN ARRAY v_targets LOOP
          PERFORM private.apply_tracking_status(v_target, v_status, v_event_at, NULL);
        END LOOP;
        v_changed := true;

        -- P19: only when the status changed, open the attention of that status and close the attention of the other statuses
        IF v_status = 'failure' THEN
          PERFORM private.set_delivery_attention(_fulfillment_id, 'delivery_failure', true);
        ELSE
          PERFORM private.set_delivery_attention(_fulfillment_id, 'delivery_failure', false);
        END IF;
        IF v_status = 'attempted_delivery' THEN
          PERFORM private.set_delivery_attention(_fulfillment_id, 'attempted_delivery', true);
        ELSE
          PERFORM private.set_delivery_attention(_fulfillment_id, 'attempted_delivery', false);
        END IF;

        -- Row 11: out for delivery is one email per target, only with notification on and not yet delivered (the helper checks)
        IF v_status = 'out_for_delivery' THEN
          FOREACH v_target IN ARRAY v_targets LOOP
            PERFORM private.enqueue_delivery_email(v_target, _tracking_version, 'out_for_delivery');
          END LOOP;
        END IF;
      END IF;
    END IF;
  ELSIF v_outcome = 'not_found' THEN
    -- Row 5: the previous status is kept. If no information exists 72 hours after registration, an attention is opened (the
    -- time before registration is not counted). It is opened only for a "new condition" (P19), in either of these cases:
    --   - an earlier read had information (provider_status remains): information went from present to absent
    --   - in this registration period there is no package-not-found attention left open or closed by hand: 72 hours passed for the first time
    -- Reading the same not_found every 6 hours does not reopen what the shop closed by hand
    IF v_r.registered_at IS NOT NULL AND pg_catalog.now() >= v_r.registered_at + interval '72 hours' THEN
      IF v_r.provider_status IS NOT NULL
         OR NOT EXISTS (
           SELECT 1
           FROM public.order_fulfillment_attention AS a
           WHERE a.fulfillment_id = _fulfillment_id
             AND a.kind = 'tracking_not_found'
             AND a.opened_at >= v_r.registered_at
             AND (a.resolved_at IS NULL OR a.resolution = 'manual')
         ) THEN
        PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_not_found', true);
      END IF;
    END IF;
  END IF;

  -- Row 12: after a successful read that carries a STOPPED signal and is not delivered, stop as provider_stopped and open
  -- tracking_stalled. The signal is consumed only up to the revision seen when the read was leased (a newer signal that arrived
  -- meanwhile stops the next read)
  IF NOT v_old AND v_r.stop_signaled AND NOT v_advanced THEN
    v_stop := true;
  END IF;

  UPDATE private.fulfillment_tracking_registrations AS r
  -- The provider symbols are also a mark of "17TRACK has information". An ok (when not old) writes them; a not_found empties them
  SET provider_status = CASE
        WHEN v_outcome = 'ok' AND NOT v_old THEN v_provider_status
        WHEN v_outcome = 'not_found' THEN NULL
        ELSE r.provider_status
      END,
      provider_sub_status = CASE
        WHEN v_outcome = 'ok' AND NOT v_old THEN v_provider_sub
        WHEN v_outcome = 'not_found' THEN NULL
        ELSE r.provider_sub_status
      END,
      last_read_at = v_read_at,
      read_attempts = 0,
      last_error_code = NULL,
      next_run_at = CASE WHEN v_stop THEN r.next_run_at ELSE v_next END,
      lease_token = NULL,
      lease_expires_at = NULL,
      state = CASE WHEN v_stop THEN 'stopped' ELSE r.state END,
      stop_reason = CASE WHEN v_stop THEN 'provider_stopped' ELSE r.stop_reason END,
      stopped_at = CASE WHEN v_stop THEN pg_catalog.now() ELSE r.stopped_at END,
      stop_signaled = CASE WHEN v_stop THEN false ELSE r.stop_signaled END,
      provider_stop_pending = CASE WHEN v_stop THEN false ELSE r.provider_stop_pending END
  WHERE r.fulfillment_id = _fulfillment_id
    AND r.tracking_version = _tracking_version;

  IF v_stop THEN
    PERFORM private.set_delivery_attention(_fulfillment_id, 'tracking_stalled', true);
  END IF;

  RETURN QUERY SELECT true, v_changed, v_stop;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

-- 3. Correct only the shipping calendar date; append the reason and revision, preserve every operational timestamp.
--    Order of work: arguments (trim reason, reject other invalid arguments before an empty reason) -> lock(false) -> permissions
--    -> fingerprint and replay/conflict -> existence -> cancelled/confirmed -> version -> unchanged -> paid/today JST bounds
--    -> delivered JST bound -> slip date/version -> active fulfillment dates (restore mark immediately) -> correction history
--    -> date_correction version -> operation result last. Every failure rolls back all writes; all marks are restored.
CREATE FUNCTION private.admin_correct_shipment_date(_slip_id uuid, _expected_version integer, _shipment_date date,
  _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_existing private.group_g_operations%ROWTYPE;
  v_slip public.shipment_slips%ROWTYPE;
  v_reason text := pg_catalog.btrim(_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  v_fingerprint text;
  v_version integer;
  v_result jsonb;
  v_previous_operation text;
  v_previous_change text;
  v_previous_fulfillment text;
BEGIN
  IF _slip_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _shipment_date IS NULL
    OR _actor_id IS NULL OR _request_key IS NULL OR pg_catalog.char_length(v_reason) > 200 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR v_reason = '' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], false);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
      ARRAY['admin.shipping.correct_date', 'admin.shipping.read', 'admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_date_correct', 'slip_id', _slip_id, 'shipment_date', _shipment_date,
    'reason', v_reason, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_date_correct' AND op.request_key = _request_key;
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
  IF v_slip.shipment_date = _shipment_date THEN
    RAISE EXCEPTION 'GROUP_G_SHIPMENT_DATE_UNCHANGED' USING ERRCODE = '22023';
  END IF;
  IF _shipment_date > (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date OR EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf JOIN public.orders AS o ON o.id = sf.order_id
    WHERE sf.slip_id = _slip_id AND (o.paid_at IS NULL OR (o.paid_at AT TIME ZONE 'Asia/Tokyo')::date > _shipment_date)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SHIPMENT_DATE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
    WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL AND f.delivered_at IS NOT NULL
      AND _shipment_date > (f.delivered_at AT TIME ZONE 'Asia/Tokyo')::date
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY' USING ERRCODE = '22023';
  END IF;

  v_previous_operation := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  v_previous_fulfillment := pg_catalog.current_setting('app.fulfillment_change', true);
  BEGIN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
    PERFORM pg_catalog.set_config('app.group_g_slip_change', 'date', true);
    UPDATE public.shipment_slips SET shipment_date = _shipment_date, version = version + 1, updated_at = pg_catalog.now()
      WHERE id = _slip_id RETURNING version INTO v_version;
    PERFORM pg_catalog.set_config('app.fulfillment_change', 'shipment_date', true);
    UPDATE public.order_fulfillments AS f SET shipment_date = _shipment_date
      FROM public.shipment_slip_fulfillments AS sf
      WHERE sf.slip_id = _slip_id AND f.id = sf.fulfillment_id AND f.cancelled_at IS NULL;
    PERFORM pg_catalog.set_config('app.fulfillment_change', COALESCE(v_previous_fulfillment, ''), true);
    INSERT INTO public.shipment_date_history(slip_id, version, kind, previous_date, new_date, reason, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'correction', v_slip.shipment_date, _shipment_date, v_reason, _actor_id, v_operation);
    INSERT INTO public.shipment_slip_versions(slip_id, version, kind, shipping_carrier, tracking_number, tracking_version, shipment_date, reason, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'date_correction', v_slip.shipping_carrier, v_slip.tracking_number, v_slip.tracking_version, _shipment_date, v_reason, _actor_id, v_operation);
    v_result := pg_catalog.jsonb_build_object('id', _slip_id::text, 'version', v_version, 'shipmentDate', _shipment_date::text, 'replayed', false);
    INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
      VALUES(v_operation, 'shipment_date_correct', _request_key, v_fingerprint, 'shipment_slip', _slip_id::text, _actor_id, v_result);
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
ALTER FUNCTION private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_correct_shipment_date(_slip_id uuid, _expected_version integer, _shipment_date date,
  _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_correct_shipment_date(_slip_id, _expected_version, _shipment_date, _reason, _actor_id, _request_key); $$;
ALTER FUNCTION public.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid) TO service_role;

-- 4. The closed list of writers. The 72 entries of 20261025100130_group_g3_shipping_slips.sql stay exactly as they were; this file
--    appends tracking update, manual delivery and date correction (73-75). Later tasks append their writers while this file is not
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
    'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)',
    'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)'
  ]::pg_catalog.regprocedure[];
$$;

-- G3D_BODY_END

-- G3D_FINAL_ASSERT_BEGIN
-- Expectation through Task 9: the six new functions (owner, SECURITY, language, result type, argument names, search_path, and the
-- EXECUTE rights read from the effective ACL where a NULL proacl means the default that includes PUBLIC), the same six as a set (no
-- function of these names beyond them; service_role may EXECUTE exactly the three operation writers and their three public entrances),
-- the order of each writer (the lock helper before any table is read), the replaced delivery read result (owner, SECURITY, language,
-- argument and output names, search_path and EXECUTE rights unchanged; exactly one common advisory call, before the first row lock;
-- no lock helper), and the allowlist: exactly the 72 entries of the previous file plus the three writers of this file (75), every one
-- resolving to a function, compared to the fixed set by OID. The expected sets grow with every Task that adds to this file.
DO $g3d_final_objects$
DECLARE
  v_failed text;
  v_functions text[] := ARRAY[
    'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
    'public.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
    'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)',
    'public.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)',
    'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)',
    'public.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)'
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
    'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)',
    'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)'
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
        ARRAY['_slip_id', '_expected_version', '_delivered_on', '_notify_customer', '_actor_id', '_request_key']),
      ('private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)', true, true, 'plpgsql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_shipment_date', '_reason', '_actor_id', '_request_key']),
      ('public.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)', false, true, 'sql', 'jsonb',
        ARRAY['_slip_id', '_expected_version', '_shipment_date', '_reason', '_actor_id', '_request_key'])
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
    v_failed := 'shipping_action_functions';
  ELSIF EXISTS (
    -- the replaced delivery read result and its public entrance keep every attribute of the G-1 functions
    SELECT 1
    FROM (VALUES
      ('private.record_delivery_read_result(uuid,integer,uuid,jsonb)', true, 'plpgsql'),
      ('public.record_delivery_read_result(uuid,integer,uuid,jsonb)', false, 'sql')
    ) AS e(sig, definer, lang)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    WHERE p.oid IS NULL
       OR p.proowner <> 'postgres'::regrole
       OR p.prosecdef <> e.definer
       OR p.provolatile <> 'v'
       OR NOT p.proretset
       OR p.prolang <> (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = e.lang)
       OR p.prorettype <> 'record'::regtype::oid
       OR p.proargnames IS DISTINCT FROM ARRAY['_fulfillment_id', '_tracking_version', '_lease_token', '_result', 'applied', 'changed', 'stopped']
       OR p.proallargtypes IS DISTINCT FROM ARRAY['uuid'::regtype::oid,'integer'::regtype::oid,'uuid'::regtype::oid,'jsonb'::regtype::oid,
         'boolean'::regtype::oid,'boolean'::regtype::oid,'boolean'::regtype::oid]
       OR p.proargmodes IS DISTINCT FROM ARRAY['i','i','i','i','t','t','t']::"char"[]
       OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
       OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x
                  WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  ) THEN
    v_failed := 'shipping_action_replaced';
  ELSIF EXISTS (
    -- the replaced body (read in lower case) takes the common advisory exactly once and before its first row lock, never the shared
    -- inventory lock helper, and fans the result out through the targets. Its FOR UPDATE and FOR SHARE clauses must exist, and the first
    -- of each must come after the advisory: a body without them fails here, it is never skipped.
    SELECT 1 FROM pg_catalog.pg_proc AS p
    CROSS JOIN LATERAL (SELECT pg_catalog.lower(p.prosrc) AS body) AS s
    WHERE p.oid = pg_catalog.to_regprocedure('private.record_delivery_read_result(uuid,integer,uuid,jsonb)')
      AND (pg_catalog.length(s.body) - pg_catalog.length(pg_catalog.replace(s.body, 'pg_advisory_xact_lock', ''))
             <> pg_catalog.length('pg_advisory_xact_lock')
        OR pg_catalog.strpos(s.body, 'pg_advisory_xact_lock') = 0
        OR pg_catalog.strpos(s.body, 'for update') = 0
        OR pg_catalog.strpos(s.body, 'for update') < pg_catalog.strpos(s.body, 'pg_advisory_xact_lock')
        OR pg_catalog.strpos(s.body, 'for share') = 0
        OR pg_catalog.strpos(s.body, 'for share') < pg_catalog.strpos(s.body, 'pg_advisory_xact_lock')
        OR pg_catalog.strpos(s.body, 'lock_group_g_inventory') > 0
        OR pg_catalog.strpos(s.body, 'v_targets') = 0)
  ) THEN
    v_failed := 'shipping_action_replaced';
  ELSIF EXISTS (
    -- the three writers: the text before the first call of the lock helper must not name a table (after from / join / into /
    -- update / table, with or without ONLY) and must not call a function of public or private (a permission check or any other
    -- helper that reads a table). Compared in lower case, with any spacing and with quoted schema names, so a body written in
    -- another style cannot slip by. A body that never calls the lock helper fails too.
    SELECT 1 FROM pg_catalog.unnest(ARRAY[
      'private.admin_update_shipment_slip_tracking(uuid,integer,text,text,boolean,uuid,uuid)',
      'private.admin_mark_shipment_slip_delivered(uuid,integer,date,boolean,uuid,uuid)',
      'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)'
    ]) AS w(sig)
    JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(w.sig)
    WHERE CASE
      WHEN pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'private.lock_group_g_shipment_slips(') = 0 THEN true
      ELSE pg_catalog.substr(pg_catalog.lower(p.prosrc), 1, pg_catalog.strpos(pg_catalog.lower(p.prosrc), 'private.lock_group_g_shipment_slips(') - 1)
        ~ '((from|join|into|update|table)\s+(only\s+)?"?(public|private)"?\s*\.)|("?(public|private)"?\s*\.\s*"?[a-z_][a-z0-9_]*"?\s*\()'
    END
  ) THEN
    v_failed := 'shipping_action_functions';
  ELSIF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_writers) AS w(s) WHERE pg_catalog.to_regprocedure(w.s) IS NULL)
     OR (SELECT pg_catalog.count(DISTINCT pg_catalog.to_regprocedure(w.s)) FROM pg_catalog.unnest(v_writers) AS w(s)) <> 75
     OR pg_catalog.cardinality(private.group_g_writer_allowlist()) <> 75 THEN
    v_failed := 'shipping_action_allowlist';
  ELSIF (SELECT pg_catalog.array_agg(x::oid ORDER BY x::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS a(x))
     IS DISTINCT FROM (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(w.s)::oid ORDER BY pg_catalog.to_regprocedure(w.s)::oid)
                       FROM pg_catalog.unnest(v_writers) AS w(s)) THEN
    v_failed := 'shipping_action_allowlist';
  -- the functions of this file as a set: a function of one of these names (in public or private) is one of the six listed above
  -- and every listed one exists, so an extra overload or a missing function fails.
  ELSIF (SELECT pg_catalog.array_agg(p.oid ORDER BY p.oid)
         FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'private')
           AND p.proname IN ('admin_update_shipment_slip_tracking', 'admin_mark_shipment_slip_delivered', 'admin_correct_shipment_date'))
        IS DISTINCT FROM
        (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(f.sig)::oid ORDER BY pg_catalog.to_regprocedure(f.sig)::oid)
         FROM pg_catalog.unnest(v_functions) AS f(sig)) THEN
    v_failed := 'shipping_action_function_set';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g3d_final_objects$;
-- Semantic table and column ACL checks tolerate unrelated grantees and ACL ordering.
-- PostgreSQL 17 adds MAINTAIN: it is also forbidden to every application role.
DO $g3d_final_table_acl$
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
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'shipping_action_table_acl';
  END IF;
END
$g3d_final_table_acl$;
-- G3D_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
