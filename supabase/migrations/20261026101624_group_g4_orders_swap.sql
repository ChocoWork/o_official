BEGIN;

-- G4C_BODY_BEGIN
-- FREQ-523-AC-02/03/04, FREQ-540-AC-13/14. Targets are discovered only after the common advisory.
CREATE FUNCTION private.lock_group_g_allocation_swap(_order_id uuid, _taker_order_item_id uuid, _donor_order_item_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_orders uuid[];
  v_variants bigint[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  SELECT pg_catalog.array_agg(DISTINCT t.order_id ORDER BY t.order_id),
    COALESCE(pg_catalog.array_agg(DISTINCT t.variant_id ORDER BY t.variant_id) FILTER (WHERE t.variant_id IS NOT NULL), ARRAY[]::bigint[])
    INTO v_orders, v_variants
  FROM (
    SELECT _order_id AS order_id, NULL::bigint AS variant_id
    UNION
    SELECT oi.order_id, oi.variant_id FROM public.order_items AS oi
      WHERE oi.id = ANY(ARRAY[_taker_order_item_id, _donor_order_item_id])
  ) AS t;
  RETURN private.lock_group_g_inventory(v_variants, v_orders, NULL);
END;
$$;
ALTER FUNCTION private.lock_group_g_allocation_swap(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_group_g_allocation_swap(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Arguments -> lock -> permissions -> replay -> existence -> ordered refusals -> transfer pairs -> state history -> result.
-- No FIFO call, ledger write or stock mutation. The G-1 deferred bounds check both sides of every transfer.
CREATE FUNCTION private.admin_swap_order_allocations(_order_id uuid, _taker_order_item_id uuid, _donor_order_item_id uuid,
  _quantity integer, _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_reason text := pg_catalog.btrim(_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  v_existing private.group_g_operations%ROWTYPE;
  v_fingerprint text;
  v_taker public.order_items%ROWTYPE;
  v_donor public.order_items%ROWTYPE;
  v_orders uuid[];
  v_before jsonb;
  v_t integer;
  v_d integer;
  v_has_production boolean;
  v_has_ready boolean;
  v_pending_request boolean;
  v_allocation record;
  v_new uuid;
  v_take integer;
  v_needed integer := _quantity;
  v_sequence integer := 1;
  v_result jsonb;
BEGIN
  IF _order_id IS NULL OR _taker_order_item_id IS NULL OR _donor_order_item_id IS NULL
    OR _actor_id IS NULL OR _request_key IS NULL OR _quantity IS NULL OR _quantity NOT BETWEEN 1 AND 99999
    OR _reason IS NULL OR pg_catalog.char_length(v_reason) > 200 OR _taker_order_item_id = _donor_order_item_id THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_allocation_swap(_order_id, _taker_order_item_id, _donor_order_item_id);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.allocate','admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'allocation_swap', 'order_id', _order_id, 'taker_order_item_id', _taker_order_item_id,
    'donor_order_item_id', _donor_order_item_id, 'quantity', _quantity, 'reason', v_reason, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'allocation_swap' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT oi.* INTO v_taker FROM public.order_items AS oi WHERE oi.id = _taker_order_item_id AND oi.order_id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_ITEM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT oi.* INTO v_donor FROM public.order_items AS oi WHERE oi.id = _donor_order_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_ITEM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_taker.order_id = v_donor.order_id THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_SAME_ORDER' USING ERRCODE = '22023';
  END IF;
  IF v_taker.variant_id IS NULL OR v_donor.variant_id IS NULL OR v_taker.variant_id <> v_donor.variant_id THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_VARIANT_MISMATCH' USING ERRCODE = '22023';
  END IF;
  v_orders := ARRAY[v_taker.order_id, v_donor.order_id];
  IF EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = ANY(v_orders) AND o.status NOT IN ('paid','shipped')) THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_ORDER_NOT_PAID' USING ERRCODE = '22023';
  END IF;

  WITH ranges AS MATERIALIZED (SELECT r.* FROM private.group_g_item_state_ranges(v_orders) AS r)
  SELECT COALESCE(pg_catalog.sum(r.unit_to - r.unit_from) FILTER (WHERE r.order_item_id = _taker_order_item_id
           AND r.status = 'in_production' AND r.blocked_reasons = ARRAY['stock_shortage']::text[]), 0)::integer,
         COALESCE(pg_catalog.sum(r.unit_to - r.unit_from) FILTER (WHERE r.order_item_id = _donor_order_item_id
           AND r.status = 'ready' AND pg_catalog.cardinality(r.blocked_reasons) = 0), 0)::integer,
         COALESCE(pg_catalog.bool_or(r.order_item_id = _taker_order_item_id AND r.status = 'in_production'), false),
         COALESCE(pg_catalog.bool_or(r.order_item_id = _donor_order_item_id AND r.status = 'ready'), false),
         COALESCE(pg_catalog.bool_or(r.order_item_id = _donor_order_item_id
           AND (r.status = 'cancel_requested' OR 'refund_processing' = ANY(r.blocked_reasons))), false)
    INTO v_t, v_d, v_has_production, v_has_ready, v_pending_request FROM ranges AS r;
  IF v_has_production AND v_t = 0 THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_TAKER_ON_HOLD' USING ERRCODE = '22023';
  ELSIF v_pending_request THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_DONOR_PENDING_REQUEST' USING ERRCODE = '22023';
  ELSIF v_has_ready AND v_d = 0 THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_DONOR_ON_HOLD' USING ERRCODE = '22023';
  ELSIF _quantity > v_t THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER' USING ERRCODE = '22023';
  ELSIF _quantity > v_d THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  FOR v_allocation IN SELECT a.* FROM public.order_item_allocations AS a
    WHERE a.order_item_id = _donor_order_item_id AND a.kind = 'paid' AND a.remaining_quantity > 0
    ORDER BY a.created_at, a.id
  LOOP
    EXIT WHEN v_needed = 0;
    v_take := LEAST(v_allocation.remaining_quantity, v_needed);
    UPDATE public.order_item_allocations SET remaining_quantity = remaining_quantity - v_take,
      version = version + 1, updated_at = pg_catalog.now() WHERE id = v_allocation.id;
    INSERT INTO public.order_item_allocations(order_item_id, variant_id, kind, quantity, remaining_quantity, operation_id)
      VALUES(_taker_order_item_id, v_taker.variant_id, 'paid', v_take, v_take, v_operation) RETURNING id INTO v_new;
    INSERT INTO public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, counterpart_allocation_id, stock_movement_id, reason, actor_id)
      VALUES(v_allocation.id, 'transfer', v_take, v_operation, v_sequence, v_new, NULL, 'allocation_swap', _actor_id),
            (v_new, 'transfer', v_take, v_operation, v_sequence + 1, v_allocation.id, NULL, 'allocation_swap', _actor_id);
    v_sequence := v_sequence + 2;
    v_needed := v_needed - v_take;
  END LOOP;
  -- A defensive check without relaxing G-1 bounds; all prior writes roll back on this exception.
  IF v_needed <> 0 THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR' USING ERRCODE = '22023';
  END IF;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'allocation_swap', _actor_id);
  v_result := pg_catalog.jsonb_build_object('id', v_taker.order_id::text, 'operationId', v_operation::text,
    'takerOrderId', v_taker.order_id::text, 'takerOrderItemId', _taker_order_item_id::text,
    'donorOrderId', v_donor.order_id::text, 'donorOrderItemId', _donor_order_item_id::text,
    'quantity', _quantity, 'reason', v_reason, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'allocation_swap', _request_key, v_fingerprint, 'order_item', _taker_order_item_id::text, _actor_id, v_result);
  RETURN v_result;
END;
$$;
ALTER FUNCTION private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid) TO service_role;

CREATE FUNCTION public.admin_swap_order_allocations(_order_id uuid, _taker_order_item_id uuid, _donor_order_item_id uuid,
  _quantity integer, _reason text, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_swap_order_allocations(_order_id, _taker_order_item_id, _donor_order_item_id, _quantity, _reason, _actor_id, _request_key) $$;
ALTER FUNCTION public.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid) TO service_role;

-- Same T/D and pending-request predicates as the writer, one snapshot, no advisory or row locks.
CREATE FUNCTION private.list_admin_allocation_swap_candidates(_order_id uuid, _taker_order_item_id uuid, _actor_id uuid)
RETURNS TABLE(donor_order_id uuid, donor_order_item_id uuid, order_created_at timestamptz, swappable_quantity integer, taker_quantity integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_variant bigint;
  v_t integer;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.allocate','admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT oi.variant_id INTO v_variant FROM public.order_items AS oi WHERE oi.id = _taker_order_item_id AND oi.order_id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_ITEM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id AND o.status IN ('paid','shipped')) THEN
    RAISE EXCEPTION 'GROUP_G_SWAP_ORDER_NOT_PAID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.sum(r.unit_to - r.unit_from), 0)::integer INTO v_t
    FROM private.group_g_item_state_ranges(ARRAY[_order_id]) AS r
    WHERE r.order_item_id = _taker_order_item_id AND r.status = 'in_production'
      AND r.blocked_reasons = ARRAY['stock_shortage']::text[];
  IF v_t = 0 THEN RETURN; END IF;
  RETURN QUERY
  WITH targets AS MATERIALIZED (
    SELECT oi.order_id, oi.id AS order_item_id, o.created_at FROM public.order_items AS oi
      JOIN public.orders AS o ON o.id = oi.order_id
      WHERE oi.variant_id = v_variant AND oi.order_id <> _order_id AND o.status IN ('paid','shipped')
        AND EXISTS (SELECT 1 FROM public.order_item_allocations AS a
          WHERE a.order_item_id = oi.id AND a.variant_id = v_variant AND a.kind = 'paid' AND a.remaining_quantity > 0)
  ), ranges AS MATERIALIZED (
    SELECT r.* FROM private.group_g_item_state_ranges(ARRAY(SELECT DISTINCT t.order_id FROM targets AS t)) AS r
  ), quantities AS (
    SELECT r.order_item_id,
      COALESCE(pg_catalog.sum(r.unit_to - r.unit_from) FILTER (WHERE r.status = 'ready'
        AND pg_catalog.cardinality(r.blocked_reasons) = 0), 0)::integer AS available,
      pg_catalog.bool_or(r.status = 'cancel_requested' OR 'refund_processing' = ANY(r.blocked_reasons)) AS pending_request
    FROM ranges AS r GROUP BY r.order_item_id
  )
  SELECT t.order_id, t.order_item_id, t.created_at, q.available, v_t
    FROM targets AS t JOIN quantities AS q ON q.order_item_id = t.order_item_id
    WHERE q.available > 0 AND NOT q.pending_request
    ORDER BY t.created_at DESC, t.order_id, t.order_item_id LIMIT 50;
END;
$$;
ALTER FUNCTION private.list_admin_allocation_swap_candidates(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_allocation_swap_candidates(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_allocation_swap_candidates(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.list_admin_allocation_swap_candidates(_order_id uuid, _taker_order_item_id uuid, _actor_id uuid)
RETURNS TABLE(donor_order_id uuid, donor_order_item_id uuid, order_created_at timestamptz, swappable_quantity integer, taker_quantity integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_admin_allocation_swap_candidates(_order_id, _taker_order_item_id, _actor_id) $$;
ALTER FUNCTION public.list_admin_allocation_swap_candidates(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_allocation_swap_candidates(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_allocation_swap_candidates(uuid,uuid,uuid) TO service_role;

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
    'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)',
    'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)'
  ]::pg_catalog.regprocedure[];
$$;

-- G4C_BODY_END
-- G4C_FINAL_ASSERT_BEGIN
DO $g4c_final_objects$
DECLARE
  v_failed text;
  v_functions text[] := ARRAY[
    'private.lock_group_g_allocation_swap(uuid,uuid,uuid)',
    'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)',
    'public.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)',
    'private.list_admin_allocation_swap_candidates(uuid,uuid,uuid)',
    'public.list_admin_allocation_swap_candidates(uuid,uuid,uuid)'
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
    'private.admin_correct_shipment_date(uuid,integer,date,text,uuid,uuid)',
    'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)'
  ];
  v_body text;
  v_helper text;
  v_lock integer;
  v_table text[];
BEGIN
  -- Exact input/output names and types, owner, volatility, language, SECURITY, empty search_path, effective ACL.
  IF EXISTS (
    SELECT 1 FROM (VALUES
      (v_functions[1], true, 'v', 'plpgsql', 'uuid[]', false, false,
        ARRAY['_order_id','_taker_order_item_id','_donor_order_item_id']::text[]),
      (v_functions[2], true, 'v', 'plpgsql', 'jsonb', false, true,
        ARRAY['_order_id','_taker_order_item_id','_donor_order_item_id','_quantity','_reason','_actor_id','_request_key']),
      (v_functions[3], false, 'v', 'sql', 'jsonb', false, true,
        ARRAY['_order_id','_taker_order_item_id','_donor_order_item_id','_quantity','_reason','_actor_id','_request_key']),
      (v_functions[4], true, 's', 'plpgsql', 'record', true, true,
        ARRAY['_order_id','_taker_order_item_id','_actor_id','donor_order_id','donor_order_item_id','order_created_at','swappable_quantity','taker_quantity']),
      (v_functions[5], false, 's', 'sql', 'record', true, true,
        ARRAY['_order_id','_taker_order_item_id','_actor_id','donor_order_id','donor_order_item_id','order_created_at','swappable_quantity','taker_quantity'])
    ) AS e(sig, definer, volatility, lang, ret, retset, service_execute, names)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    LEFT JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
    WHERE p.oid IS NULL OR p.proowner <> 'postgres'::regrole OR p.prosecdef <> e.definer
      OR p.provolatile::text <> e.volatility OR l.lanname <> e.lang
      OR p.prorettype <> pg_catalog.to_regtype(e.ret) OR p.proretset <> e.retset OR p.proargnames IS DISTINCT FROM e.names
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') <> e.service_execute
      OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x
        WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
      OR (e.retset AND (p.proallargtypes IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','uuid','timestamptz','integer','integer']::regtype[]::oid[]
        OR p.proargmodes IS DISTINCT FROM ARRAY['i','i','i','t','t','t','t','t']::"char"[]))
  ) THEN
    v_failed := 'orders_swap_functions';
  ELSIF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
    CROSS JOIN LATERAL (SELECT pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '\s+', '', 'g') AS body) AS s
    WHERE (p.oid = pg_catalog.to_regprocedure(v_functions[3])
      AND pg_catalog.rtrim(s.body, ';') <> 'selectprivate.admin_swap_order_allocations(_order_id,_taker_order_item_id,_donor_order_item_id,_quantity,_reason,_actor_id,_request_key)')
      OR (p.oid = pg_catalog.to_regprocedure(v_functions[5])
      AND pg_catalog.rtrim(s.body, ';') <> 'select*fromprivate.list_admin_allocation_swap_candidates(_order_id,_taker_order_item_id,_actor_id)')
  ) THEN
    v_failed := 'orders_swap_functions';
  END IF;
  IF v_failed IS NULL THEN
    SELECT pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.regexp_replace(p.prosrc, '--[^\n]*|/\*.*?\*/', ' ', 'gs')), '\s+', ' ', 'g')
      INTO v_body FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure(v_functions[2]);
    SELECT pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.regexp_replace(p.prosrc, '--[^\n]*|/\*.*?\*/', ' ', 'gs')), '\s+', ' ', 'g')
      INTO v_helper FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure(v_functions[1]);
    v_lock := pg_catalog.strpos(v_body, 'private.lock_group_g_allocation_swap(');
    -- Match SQL table references, not rowtype declarations or the words within function call names.
    -- The helper comparison strips through its first BEGIN; a later nested block cannot satisfy advisory-first.
    v_table := pg_catalog.regexp_match(v_body, '\m(?:from|join|into|update)\s+(?:public\.)?(?:order_item_allocations|order_item_allocation_events|stock_movements|item_variants|orders|order_items)\M');
    IF v_lock = 0 OR v_table IS NULL
      OR pg_catalog.substr(v_body, 1, v_lock - 1) ~ '\m(?:from|join|into|update)\s+(?:public\.)?(?:order_item_allocations|order_item_allocation_events|stock_movements|item_variants|orders|order_items)\M'
      OR pg_catalog.regexp_replace(v_helper, '^.*?\mbegin\s+', '', 's') !~ '^perform pg_catalog\.pg_advisory_xact_lock\(190521,1\);'
      OR pg_catalog.strpos(v_helper, 'private.lock_group_g_inventory(') = 0 THEN
      v_failed := 'orders_swap_lock_order';
    END IF;
  END IF;
  IF v_failed IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.unnest(v_writers) AS w(s) WHERE pg_catalog.to_regprocedure(w.s) IS NULL)
      OR (SELECT pg_catalog.count(DISTINCT pg_catalog.to_regprocedure(w.s)) FROM pg_catalog.unnest(v_writers) AS w(s)) <> 76
      OR pg_catalog.cardinality(private.group_g_writer_allowlist()) <> 76
      OR (SELECT pg_catalog.array_agg(x::oid ORDER BY x::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS a(x))
        IS DISTINCT FROM (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(w.s)::oid ORDER BY pg_catalog.to_regprocedure(w.s)::oid)
          FROM pg_catalog.unnest(v_writers) AS w(s)) THEN
      v_failed := 'orders_swap_allowlist';
    ELSIF (SELECT pg_catalog.array_agg(p.oid ORDER BY p.oid)
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.proname IN
        ('lock_group_g_allocation_swap','admin_swap_order_allocations','list_admin_allocation_swap_candidates'))
      IS DISTINCT FROM (SELECT pg_catalog.array_agg(pg_catalog.to_regprocedure(f.sig)::oid ORDER BY pg_catalog.to_regprocedure(f.sig)::oid)
        FROM pg_catalog.unnest(v_functions) AS f(sig)) THEN
      v_failed := 'orders_swap_function_set';
    END IF;
  END IF;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g4c_final_objects$;

-- Only the existing G-1 targets are written. Preserve their established SELECT exceptions and forbid application writes,
-- including column grants and PG17 MAINTAIN. Unrelated grantees and caller search_path do not affect these semantic checks.
DO $g4c_final_table_acl$
DECLARE
  v_maintain text[] := CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
    THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  v_all text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] || v_maintain;
  v_service_forbidden text[] := ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] || v_maintain;
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES ('private.group_g_operations', false), ('public.order_item_allocations', true),
      ('public.order_item_allocation_events', true), ('public.order_item_state_events', true)) AS e(rel, service_select)
    CROSS JOIN LATERAL (SELECT pg_catalog.to_regclass(e.rel) AS r) AS t
    WHERE t.r IS NULL
      OR (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = t.r) <> 'postgres'::regrole
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_all) AS p(priv) WHERE NOT pg_catalog.has_table_privilege('postgres', t.r, p.priv))
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_all) AS p(priv)
        WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
          (SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = t.r), pg_catalog.acldefault('r', 'postgres'::regrole))) AS x
          WHERE x.grantee = 'postgres'::regrole AND x.privilege_type = p.priv))
      OR pg_catalog.has_table_privilege('service_role', t.r, 'SELECT') <> e.service_select
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
        (SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = t.r), pg_catalog.acldefault('r', 'postgres'::regrole))) AS x WHERE x.grantee = 0)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated']) AS g(role)
        CROSS JOIN pg_catalog.unnest(v_all) AS p(priv) WHERE pg_catalog.has_table_privilege(g.role, t.r, p.priv))
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated']) AS g(role)
        CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p(priv)
        WHERE pg_catalog.has_any_column_privilege(g.role, t.r, p.priv))
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_service_forbidden) AS p(priv) WHERE pg_catalog.has_table_privilege('service_role', t.r, p.priv))
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['INSERT','UPDATE','REFERENCES']) AS p(priv)
        WHERE pg_catalog.has_any_column_privilege('service_role', t.r, p.priv))
      OR (NOT e.service_select AND pg_catalog.has_any_column_privilege('service_role', t.r, 'SELECT'))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS x
        WHERE a.attrelid = t.r AND a.attnum > 0 AND NOT a.attisdropped AND x.grantee = 0)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'orders_swap_table_acl';
  END IF;
END
$g4c_final_table_acl$;
-- G4C_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
