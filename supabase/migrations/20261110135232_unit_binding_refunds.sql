BEGIN;

-- Unit binding, migration D (FREQ-642), 2026-11-10: refunds after a consultation, refunds of an order, pre-shipment cancels, money held on an
-- earlier order given back, and the revert of a cancel the shop stopped. Every refund decided per unit event goes through the one core.
-- @impl FREQ-642-AC-05 FREQ-642-AC-10 FREQ-642-AC-15 FREQ-642-AC-19 FREQ-642-AC-23 FREQ-642-AC-27 FREQ-642-AC-28
-- @design docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md docs/04_DetailDesign/states/order-payment.md
-- 1. order_refunds_source_check also allows 'unit_hold_release' (a refund on an earlier order that gives back money held for a later order;
--    return_id stays NULL).
-- 2. private.begin_order_refund_core takes a 16th argument _unit_event_id (the 15 argument function is dropped). With an event the core
--    takes the line amounts from the event's allocations (per holder item), claims no unit by position, and ties the refund to the event
--    with order_unit_link_refund (part now; consult for a consult refund of a return, which covers every uncovered consult event of that
--    return; release for 'unit_hold_release'). A refund of a shipped line without a return on an order with a discount snapshot claims no
--    unit (FREQ-642-AC-28). Orders without a snapshot and the automatic sources keep the H cheapest-first claim.
-- 3. private.begin_order_refund and its public entry take a 14th argument _pricing jsonb (the 13 argument functions are dropped) and return
--    release_refund_ids. An order with a snapshot needs a pre_shipment_cancel plan for a pre-shipment line or an order_cancel
--    (UNIT_PRICING_REQUIRED); a refund of shipped lines or without lines takes none. A replay by request key is answered before any check.
-- 4. private.admin_refund_return and its public entry take an 8th argument _pricing jsonb (the 7 argument functions are dropped) and return
--    release_refund_ids. The standard amount of a consult refund is the consult part of the events no consult refund covers yet (R34, as the screen counts it).
-- 5. private.admin_receive_return (15 arguments, unchanged signature) no longer inserts the refund row itself: it calls the core with the
--    event, and it applies the releases of the plan (money held on earlier orders given back), each as a hold_release event with its own
--    refund on the held order, in the same transaction. private.order_unit_apply_releases checks and applies the release plans;
--    private.order_unit_release_refund_ids reads them back for a replay.
-- 6. private.order_unit_revert_cancel and its public entry (service_role): a pre-shipment cancel whose refund the shop stopped (failed) is
--    undone by a cancel_reverted event (slots back to kept at their price before, allocations and corrections negated) when no later event
--    exists on the order and the cancel carries no fee and no hold. Called by accounting plan 3; this work builds no route for it.
-- 7. private.group_g_writer_allowlist names the new signatures (still 77 entries).
-- Applied migrations are never edited.

-- UBF_BASELINE_BEGIN
CREATE TEMP TABLE ubf_writer_baseline ON COMMIT DROP AS
SELECT x::oid AS oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x);
-- UBF_BASELINE_END

-- UBF_SCHEMA_BEGIN
ALTER TABLE public.order_refunds DROP CONSTRAINT order_refunds_source_check;
ALTER TABLE public.order_refunds ADD CONSTRAINT order_refunds_source_check CHECK (source IN (
  'admin', 'order_cancel', 'stripe_dashboard', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'legacy', 'return', 'unit_hold_release'));
-- UBF_SCHEMA_END

-- UBF_FUNCTIONS_BEGIN
-- The refunds that gave back held money for one request: the release refund of every related order of the member carries a request key
-- derived from the request key and the held order (see order_unit_apply_releases).
CREATE FUNCTION private.order_unit_release_refund_ids(_request_key uuid, _order_id uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.array_agg(rf.id ORDER BY rf.id), ARRAY[]::uuid[])
  FROM public.order_refunds AS rf
  WHERE _request_key IS NOT NULL AND rf.source = 'unit_hold_release'
    AND rf.request_key IN (SELECT pg_catalog.md5('ub_release:' || _request_key::text || ':' || t.x::text)::uuid
      FROM pg_catalog.unnest(ARRAY[_order_id] || private.order_unit_related_orders(_order_id)) AS t(x))
$$;

-- Check and apply the release plans of a plan (money held on earlier orders that the event gives back). The caller holds the G lock and
-- every related order (lock_group_g_inventory) and passes the order version it read before it applied anything: the plan and each release
-- must carry that version, else UNIT_PRICING_STALE / 40001. A release is applied as a hold_release event of the held order against the
-- held order's own version (re-read here; the main event of the caller moved the version of every related order), after its previous E
-- and largest E are compared with the database's. Returns one row per release: the event, the held order, the request key to use for the
-- refund and the amount to refund (the event's refund, capped by what the held order can still refund). The caller creates the refunds
-- through the core, so every refund passes through it.
CREATE FUNCTION private.order_unit_apply_releases(_plan jsonb, _version text, _order_id uuid, _request_key uuid, _actor_id uuid)
RETURNS TABLE(event_id uuid, held_order_id uuid, request_key uuid, refund_amount integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_rel jsonb; v_held uuid; v_key uuid; v_tot record; v_event uuid; v_std integer; v_refundable integer; v_related uuid[];
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  IF _plan IS NULL OR pg_catalog.jsonb_typeof(_plan -> 'releases') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(_plan -> 'releases') = 0 THEN
    RETURN;
  END IF;
  IF _plan ->> 'version' IS DISTINCT FROM _version THEN
    RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE = '40001';
  END IF;
  v_related := private.order_unit_related_orders(_order_id);
  FOR v_rel IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_plan -> 'releases') AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_rel) IS DISTINCT FROM 'object' OR (v_rel ->> 'kind') IS DISTINCT FROM 'hold_release'
      OR pg_catalog.jsonb_typeof(v_rel -> 'orderId') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_rel -> 'version') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_rel -> 'entitlementPrevious') IS DISTINCT FROM 'number' OR (v_rel ->> 'entitlementPrevious') !~ '^-?[0-9]{1,9}$'
      OR pg_catalog.jsonb_typeof(v_rel -> 'entitlementMaxBefore') IS DISTINCT FROM 'number' OR (v_rel ->> 'entitlementMaxBefore') !~ '^-?[0-9]{1,9}$'
      OR (v_rel ->> 'orderId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_release_plan';
    END IF;
    v_held := (v_rel ->> 'orderId')::uuid;
    IF v_held = _order_id OR NOT (v_held = ANY (v_related))
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(_plan -> 'releases') AS y(value) WHERE (y.value ->> 'orderId') = v_held::text) <> 1 THEN
      RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_release_order';
    END IF;
    -- The release was made from the same materials as the main plan; the held order must still be in the state those materials showed.
    SELECT * INTO v_tot FROM private.order_unit_totals(v_held);
    IF (v_rel ->> 'version') IS DISTINCT FROM _version OR (v_rel ->> 'entitlementPrevious')::integer <> v_tot.entitlement_previous
      OR (v_rel ->> 'entitlementMaxBefore')::integer <> v_tot.entitlement_max THEN
      RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE = '40001';
    END IF;
    v_key := pg_catalog.md5('ub_release:' || _request_key::text || ':' || v_held::text)::uuid;
    v_event := private.order_unit_apply_plan(pg_catalog.jsonb_set(v_rel, '{version}', pg_catalog.to_jsonb(private.order_unit_version(v_held))),
      v_key, NULL, NULL, _actor_id);
    SELECT e.now_refund INTO v_std FROM public.order_unit_events AS e WHERE e.id = v_event;
    SELECT a.refundable_amount INTO v_refundable FROM private.order_refund_amounts(v_held) AS a;
    event_id := v_event; held_order_id := v_held; request_key := v_key;
    refund_amount := LEAST(v_std, GREATEST(COALESCE(v_refundable, 0), 0));
    RETURN NEXT;
  END LOOP;
END;
$$;

DROP FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer);
DROP FUNCTION private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer);
DROP FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean);
DROP FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean);
DROP FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer);

CREATE FUNCTION private.begin_order_refund_core(
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
  _return_fee_deduction integer,
  _unit_event_id uuid
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
  v_h_line record;v_h_return record;v_h_left integer;v_h_take integer;v_h_amount integer;
  v_is_release boolean;
  v_snapshot boolean;
  v_event public.order_unit_events%ROWTYPE;
  v_part text;
  v_event_ids uuid[];
  v_groups jsonb;
  v_eid uuid;
BEGIN
  -- Existing business rule (unchanged).
  IF _order_id IS NULL
     OR _source IS NULL
     OR _source NOT IN ('admin', 'order_cancel', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'return', 'unit_hold_release')
     OR ((_source = 'return') IS DISTINCT FROM (_return_id IS NOT NULL))
     OR (_source = 'return' AND (_return_fee_deduction IS NULL OR _return_fee_deduction < 0))
     OR (_source <> 'return' AND _return_fee_deduction IS NOT NULL)
     OR (_source = 'unit_hold_release' AND (_unit_event_id IS NULL OR _request_key IS NULL OR _actor_id IS NULL OR _amount IS NULL OR _amount < 1))
     OR _lines IS NULL
     OR _restock IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_is_admin := _source IN ('admin', 'return');
  v_is_release := _source = 'unit_hold_release';
  v_is_auto := _source IN ('auto_cancelled_order_payment', 'auto_amount_mismatch');
  v_is_cancel := _source IN ('order_cancel', 'auto_amount_mismatch');

  -- Existing business rule (unchanged).
  IF (NOT v_is_admin AND pg_catalog.jsonb_array_length(_lines) > 0)
     OR (NOT v_is_auto AND (_request_key IS NULL OR _actor_id IS NULL))
     OR (_note IS NOT NULL AND pg_catalog.char_length(_note) > 500)
     OR (_stripe_reason IS NOT NULL AND _stripe_reason NOT IN ('requested_by_customer', 'duplicate', 'fraudulent')) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  IF (v_is_admin OR v_is_release) AND (
       _shipping_amount IS NULL OR _shipping_amount < 0
       OR _amount IS NULL OR _amount < 1
       OR _shipping_amount > _amount
       OR _cancel_reason IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  IF _source = 'order_cancel' AND (
       _cancel_reason IS NULL
       OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other')
       OR (_cancel_reason = 'other' AND NULLIF(pg_catalog.btrim(_note), '') IS NULL)
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  v_restock := CASE WHEN _source = 'auto_amount_mismatch' THEN true ELSE _restock END;
  v_notify := CASE WHEN v_is_auto THEN true ELSE _notify_customer END;
  v_note := CASE _source
    WHEN 'auto_amount_mismatch' THEN U&'\652f\6255\984d\306e\9055\3044\306e\81ea\52d5\306e\53d6\6d88'
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

  -- Existing business rule (unchanged).
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

  -- Task 10: every core caller owns the advisory and the full ordered row closure.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _source = 'return' THEN
    PERFORM 1 FROM public.order_returns AS r WHERE r.id=_return_id AND r.order_id=_order_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    SELECT rr.request_fingerprint INTO v_fingerprint FROM public.order_return_receipts AS rr
    WHERE rr.request_key=_request_key AND rr.return_id=_return_id AND rr.kind='receive';
    IF NOT FOUND THEN
      v_fingerprint:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'amount',_received_amount,
        'shipping_amount',_shipping_amount,'note',_note,'notify_customer',_notify_customer)::text);
    END IF;
  END IF;

  -- Existing business rule (unchanged).
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

  -- Existing business rule (unchanged).
  IF _source = 'auto_cancelled_order_payment' THEN
    IF v_order.status <> 'cancelled'::public.order_status THEN
      RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE = '22023';
    END IF;
    IF v_order.paid_amount IS NULL THEN
      IF _received_amount IS NULL OR _received_amount < 1 THEN
        RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
      PERFORM pg_catalog.set_config('app.order_change_reason', 'record_cancelled_order_payment', true);
      PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);
      UPDATE public.orders AS o SET paid_amount = _received_amount WHERE o.id = _order_id;
      v_order.paid_amount := _received_amount;
    END IF;
  END IF;

  -- Existing business rule (unchanged).
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status, 'cancelled'::public.order_status)
     OR v_order.paid_amount IS NULL
     OR v_order.paid_amount < 1 THEN
    RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
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

  -- Existing business rule (unchanged).
  IF v_is_cancel AND (v_order.status <> 'paid'::public.order_status OR v_shipped_total > 0) THEN
    RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  SELECT a.refundable_amount, a.refundable_shipping INTO v_refundable, v_refundable_shipping
  FROM private.order_refund_amounts(_order_id) AS a;
  IF v_refundable IS NULL OR v_refundable < 1 THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_REFUNDABLE' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
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

  -- Existing business rule (unchanged).
  IF _source='return' AND EXISTS (
    SELECT 1 FROM private.parse_refund_lines(v_resolved) AS p
    WHERE p.before_shipment OR p.quantity > COALESCE((
      SELECT pg_catalog.sum(g.refund_waiting)::integer
      FROM private.order_return_line_progress(_return_id) AS g
      JOIN public.order_return_lines AS rl ON rl.id=g.return_line_id
      WHERE rl.order_item_id=p.order_item_id
    ),0)
  ) THEN RAISE EXCEPTION 'RETURN_RECEIPT_EXCEEDS' USING ERRCODE='22023'; END IF;

  -- Existing business rule (unchanged).
  IF v_is_admin OR v_is_release THEN
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

  -- Existing business rule (unchanged).
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

  v_snapshot := EXISTS (SELECT 1 FROM public.order_discount_snapshots AS ds WHERE ds.order_id = _order_id);

  -- Existing business rule (unchanged).
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
               'amount', CASE WHEN _unit_event_id IS NOT NULL AND (_source='return' OR q.before_shipment) THEN 0
                 WHEN _source='return' AND EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=q.order_item_id)
                 THEN private.group_h_return_refund_amount(_return_id,q.order_item_id,q.quantity,_request_key)
                 -- A shipped line without a return on an order with a snapshot claims no unit: its amount is the cheapest free units after the ones earlier refunds of this kind already took (they claim none).
                 WHEN v_snapshot AND _source='admin' AND NOT q.before_shipment
                 THEN private.return_units_amount(q.order_item_id,q.quantity,LEAST(
                   q.earlier_in_refund+GREATEST(q.refunded_after-(SELECT pg_catalog.count(*)::integer FROM public.order_line_unit_amounts AS cu
                     WHERE cu.order_item_id=q.order_item_id AND cu.refund_id IS NOT NULL AND NOT cu.refund_before_shipment),0),
                   GREATEST(COALESCE(pg_catalog.cardinality(private.group_h_available_unit_amounts(q.order_item_id,NULL)),0)-q.quantity,0)))
                 ELSE private.return_units_amount(q.order_item_id,q.quantity,q.earlier_in_refund) END
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
           l.refunded_after_shipment AS refunded_after,
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

  -- Unit binding (FREQ-642): a refund tied to an event takes its line amounts from the event's allocations and never claims units by
  -- position; the units the event returned get the refund claim through order_unit_link_refund after the lines exist. A refund of a
  -- shipped line without a return on an order with a discount snapshot claims no unit at all (FREQ-642-AC-28).
  IF _unit_event_id IS NOT NULL THEN
    SELECT e.* INTO v_event FROM public.order_unit_events AS e WHERE e.id = _unit_event_id;
    IF NOT FOUND OR v_event.order_id <> _order_id OR NOT v_snapshot
      OR NOT ((_source = 'return' AND v_event.kind = 'return_receive' AND v_event.return_id IS NOT DISTINCT FROM _return_id)
        OR (_source = 'unit_hold_release' AND v_event.kind = 'hold_release')
        OR (_source IN ('admin', 'order_cancel') AND v_event.kind = 'pre_shipment_cancel')) THEN
      RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_refund_event';
    END IF;
    v_part := CASE
      WHEN v_is_release THEN 'release'
      WHEN _source = 'return' AND NOT EXISTS (SELECT 1 FROM public.order_return_receipts AS rr
        WHERE rr.request_key = _request_key AND rr.return_id = _return_id AND rr.kind = 'receive') THEN 'consult'
      ELSE 'now' END;
    IF v_part = 'consult' THEN
      -- The consult refund of a return covers the consult units of every event of that return that no refund covers yet.
      v_event_ids := ARRAY(SELECT e.id FROM public.order_unit_events AS e
        WHERE e.order_id = _order_id AND e.return_id = _return_id AND e.kind = 'return_receive'
          AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = e.id)
          AND EXISTS (SELECT 1 FROM public.order_unit_event_lines AS l WHERE l.event_id = e.id AND l.line_kind = 'returned' AND l.part = 'consult')
          AND NOT EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er JOIN public.order_refunds AS rf ON rf.id = er.refund_id
            WHERE er.event_id = e.id AND er.part = 'consult' AND rf.status <> 'failed')
        ORDER BY e.seq);
      IF pg_catalog.cardinality(v_event_ids) = 0 THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_refund_event';
      END IF;
    ELSE
      v_event_ids := ARRAY[_unit_event_id];
    END IF;
    IF NOT v_is_release THEN
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id', g.item, 'before_shipment', g.before_shipment,
          'quantity', g.n, 'amount', g.amount) ORDER BY g.item), '[]'::jsonb)
      INTO v_groups
      FROM (SELECT l.holder_order_item_id AS item, (v_event.kind = 'pre_shipment_cancel') AS before_shipment,
          pg_catalog.count(*)::integer AS n, pg_catalog.sum(l.allocation)::integer AS amount
        FROM public.order_unit_event_lines AS l
        WHERE l.event_id = ANY (v_event_ids) AND l.line_kind = 'returned'
          AND CASE WHEN v_part = 'consult' THEN l.part = 'consult' ELSE COALESCE(l.part, 'now') = 'now' END
        GROUP BY l.holder_order_item_id) AS g;
      -- The requested lines and the event's returned units agree per item: every line of a return and every pre-shipment line has its units.
      IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_groups) AS g(order_item_id uuid, before_shipment boolean, quantity integer, amount integer)
        FULL JOIN pg_catalog.jsonb_to_recordset(v_priced) AS p(order_item_id uuid, before_shipment boolean, quantity integer, amount integer)
          ON p.order_item_id = g.order_item_id AND p.before_shipment = g.before_shipment
        WHERE p.order_item_id IS NULL OR (g.order_item_id IS NULL AND (_source = 'return' OR p.before_shipment)) OR g.quantity <> p.quantity
      ) THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_refund_lines';
      END IF;
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_set(p.value, '{amount}',
          pg_catalog.to_jsonb(COALESCE(g.amount, (p.value ->> 'amount')::integer))) ORDER BY p.ord), '[]'::jsonb)
      INTO v_priced
      FROM pg_catalog.jsonb_array_elements(v_priced) WITH ORDINALITY AS p(value, ord)
      LEFT JOIN pg_catalog.jsonb_to_recordset(v_groups) AS g(order_item_id uuid, before_shipment boolean, quantity integer, amount integer)
        ON g.order_item_id = (p.value ->> 'order_item_id')::uuid AND g.before_shipment = (p.value ->> 'before_shipment')::boolean;
    END IF;
  END IF;

  SELECT COALESCE(pg_catalog.sum(x.amount), 0)::integer INTO v_lines_amount
  FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid, before_shipment boolean, quantity integer, restock_type text, amount integer);

  -- Existing business rule (unchanged).
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
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_refunds_request_key_key' THEN
      RAISE EXCEPTION USING MESSAGE=CASE WHEN _source='return' THEN 'RETURN_REQUEST_MISMATCH' ELSE 'REFUND_REQUEST_MISMATCH' END, ERRCODE='22023';
    END IF;
    RAISE;
  END;

  -- H5: bind exact units after the refund parent exists; roll back on any price mismatch.
  FOR v_h_line IN SELECT x.* FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid,before_shipment boolean,quantity integer,amount integer)
    ORDER BY x.order_item_id,x.before_shipment DESC LOOP
    CONTINUE WHEN _unit_event_id IS NOT NULL OR (v_snapshot AND _source='admin' AND NOT v_h_line.before_shipment);
    IF EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=v_h_line.order_item_id) THEN
      IF _source='return' THEN
        v_h_left:=v_h_line.quantity;v_h_amount:=0;
        FOR v_h_return IN SELECT s.* FROM private.group_h_return_refund_slices(_return_id,v_h_line.order_item_id,v_h_line.quantity,_request_key) AS s LOOP
          v_h_take:=v_h_return.quantity;
          v_h_amount:=v_h_amount+private.group_h_claim_refund_units(v_refund_id,v_h_line.order_item_id,v_h_take,false,v_h_return.return_line_id);
          v_h_left:=v_h_left-v_h_take;EXIT WHEN v_h_left=0;
        END LOOP;
        IF v_h_left<>0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      ELSE
        v_h_amount:=private.group_h_claim_refund_units(v_refund_id,v_h_line.order_item_id,v_h_line.quantity,v_h_line.before_shipment,NULL);
      END IF;
      IF v_h_amount IS DISTINCT FROM v_h_line.amount THEN
        RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;

  INSERT INTO public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
  SELECT v_refund_id, x.order_item_id, x.quantity, x.before_shipment, x.restock_type, x.amount
  FROM pg_catalog.jsonb_to_recordset(v_priced)
    AS x(order_item_id uuid, before_shipment boolean, quantity integer, restock_type text, amount integer);

  IF _unit_event_id IS NOT NULL THEN
    FOREACH v_eid IN ARRAY v_event_ids LOOP
      PERFORM private.order_unit_link_refund(v_eid, v_refund_id, v_part);
    END LOOP;
  END IF;

  IF _source <> 'return' THEN
    -- Existing business rule (unchanged).
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id=_order_id AND rt.status='open' ORDER BY rt.id;
  END IF;
  RETURN QUERY SELECT v_refund_id, v_amount, 'awaiting_response'::text, false;
END;
$$;

CREATE FUNCTION private.begin_order_refund(
  _order_id uuid, _source text, _request_key uuid, _lines jsonb, _restock boolean,
  _shipping_amount integer, _amount integer, _note text, _stripe_reason text, _cancel_reason text,
  _notify_customer boolean, _actor_id uuid, _received_amount integer DEFAULT NULL, _pricing jsonb DEFAULT NULL
) RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean, release_refund_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_orders uuid[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_result record;
  v_pricing jsonb := CASE WHEN pg_catalog.jsonb_typeof(_pricing) = 'null' THEN NULL ELSE _pricing END;
  v_slot boolean := false;
  v_related uuid[];
  v_replay boolean := false;
  v_needs boolean := false;
  v_event uuid;
  v_version text;
  v_released uuid[] := ARRAY[]::uuid[];
  v_rel record;
  v_rid uuid;
BEGIN
  -- Unit binding (FREQ-642): an order with a discount snapshot also locks the member's related orders (a plan may touch their holds),
  -- in the same lock order and with the one call below. A change seen after the lock is a stale plan (UNIT_PRICING_STALE).
  IF _order_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = _order_id) THEN
    v_slot := true;
    v_related := private.order_unit_related_orders(_order_id);
  END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[],
    CASE WHEN _order_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[_order_id] || COALESCE(v_related, ARRAY[]::uuid[]) END, NULL);
  -- A replay by request key is answered before any plan or version check.
  v_replay := _request_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.order_refunds AS r WHERE r.request_key = _request_key);
  IF NOT v_replay THEN
    IF v_pricing IS NOT NULL AND pg_catalog.jsonb_typeof(v_pricing) <> 'object' THEN
      RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_1';
    END IF;
    IF NOT v_slot THEN
      IF v_pricing IS NOT NULL THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_legacy';
      END IF;
    ELSE
      IF v_related IS DISTINCT FROM private.order_unit_related_orders(_order_id) THEN
        RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE = '40001';
      END IF;
      -- Only a pre-shipment line or a cancel changes the units; a refund of a shipped line without a return, and a refund without lines, do not.
      v_needs := _source = 'order_cancel' OR (_source = 'admin' AND pg_catalog.jsonb_typeof(_lines) = 'array'
        AND EXISTS (SELECT 1 FROM private.parse_refund_lines(_lines) AS p WHERE p.before_shipment));
      IF v_needs AND v_pricing IS NULL THEN
        RAISE EXCEPTION 'UNIT_PRICING_REQUIRED' USING ERRCODE = '22023';
      END IF;
      IF NOT v_needs AND v_pricing IS NOT NULL THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_refund_plan';
      END IF;
      IF v_needs THEN
        BEGIN
          IF pg_catalog.jsonb_typeof(v_pricing -> 'orderId') IS DISTINCT FROM 'string' OR (v_pricing ->> 'orderId') IS DISTINCT FROM _order_id::text
            OR (v_pricing ->> 'kind') IS DISTINCT FROM 'pre_shipment_cancel'
            OR pg_catalog.jsonb_typeof(v_pricing -> 'lines') IS DISTINCT FROM 'array'
            OR pg_catalog.jsonb_typeof(v_pricing -> 'holds') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_cancel_lines';
          END IF;
          -- The returned lines of the plan are exactly the pre-shipment units asked for, per order item (for a cancel: every unshipped unit).
          IF EXISTS (
            SELECT 1 FROM (
              SELECT l.order_item_id AS item, l.unshipped AS n FROM private.order_line_fulfillment(_order_id) AS l
                WHERE _source = 'order_cancel' AND l.unshipped > 0
              UNION ALL
              SELECT p.order_item_id, p.quantity FROM private.parse_refund_lines(CASE WHEN _source = 'admin' THEN _lines ELSE '[]'::jsonb END) AS p
                WHERE p.before_shipment
            ) AS r FULL JOIN (
              SELECT l.holder_order_item_id AS item, pg_catalog.count(*)::integer AS n FROM private.order_unit_plan_lines(v_pricing) AS l
                WHERE l.line_kind = 'returned' GROUP BY l.holder_order_item_id
            ) AS p ON p.item = r.item
            WHERE r.item IS NULL OR p.item IS NULL OR r.n <> p.n
          ) THEN
            RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_cancel_lines';
          END IF;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datatype_mismatch OR invalid_parameter_value THEN
          IF SQLSTATE = '22023' AND SQLERRM = 'UNIT_PRICING_INVALID' THEN RAISE; END IF;
          RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_1';
        END;
        v_version := private.order_unit_version(_order_id);
        v_event := private.order_unit_apply_plan(v_pricing, _request_key, NULL, NULL, _actor_id);
      END IF;
    END IF;
  END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  SELECT c.refund_id AS id, c.amount AS refund_amount, c.status AS refund_status, c.replayed AS was_replayed
  INTO v_result
  FROM private.begin_order_refund_core(_order_id, _source, _request_key, _lines, _restock, _shipping_amount,
    _amount, _note, _stripe_reason, _cancel_reason, _notify_customer, _actor_id, _received_amount,
    NULL::uuid, NULL::integer, v_event) AS c;

  IF v_result.was_replayed THEN
    v_released := private.order_unit_release_refund_ids(_request_key, _order_id);
  ELSE
    -- Money held back on earlier orders that this event gives back (a cancel plan normally has none): each release is its own event
    -- and its own refund on the held order, in this transaction.
    IF v_event IS NOT NULL THEN
      FOR v_rel IN SELECT * FROM private.order_unit_apply_releases(v_pricing, v_version, _order_id, _request_key, _actor_id) LOOP
        IF v_rel.refund_amount > 0 THEN
          SELECT c.refund_id INTO v_rid FROM private.begin_order_refund_core(v_rel.held_order_id, 'unit_hold_release', v_rel.request_key,
            '[]'::jsonb, false, 0, v_rel.refund_amount, NULL, 'requested_by_customer', NULL, false, _actor_id, NULL,
            NULL::uuid, NULL::integer, v_rel.event_id) AS c;
          v_released := v_released || v_rid;
        END IF;
      END LOOP;
    END IF;
    PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'begin_order_refund', _actor_id);
    INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES (
      v_operation,
      'begin_order_refund',
      COALESCE(_request_key, pg_catalog.md5('begin_order_refund:' || v_result.id::text)::uuid),
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'operation', 'begin_order_refund', 'order_id', _order_id, 'source', _source, 'request_key', _request_key,
        'lines', _lines, 'restock', _restock, 'shipping_amount', _shipping_amount, 'amount', _amount, 'note', _note,
        'stripe_reason', _stripe_reason, 'cancel_reason', _cancel_reason, 'notify_customer', _notify_customer,
        'actor_id', _actor_id, 'received_amount', _received_amount, 'refund_id', v_result.id)::text, 'UTF8')), 'hex'),
      'order_refund',
      v_result.id::text,
      _actor_id,
      pg_catalog.jsonb_build_object('refund_id', v_result.id, 'order_id', _order_id, 'amount', v_result.refund_amount,
        'status', v_result.refund_status)
    );
  END IF;
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_result.id, v_result.refund_amount, v_result.refund_status, v_result.was_replayed, v_released;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE FUNCTION private.admin_refund_return(
  _return_id uuid,_actor_id uuid,_request_key uuid,_amount integer,
  _shipping_amount integer,_note text,_notify_customer boolean,_pricing jsonb DEFAULT NULL
) RETURNS TABLE(refund_id uuid,amount integer,status text,replayed boolean,release_refund_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns%ROWTYPE;v_order uuid;v_fp text;v_old public.order_refunds%ROWTYPE;
  v_lines jsonb;v_goods integer;v_cap integer;v_amount integer;v_result record;v_receipt public.order_return_receipts%ROWTYPE;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_pricing jsonb := CASE WHEN pg_catalog.jsonb_typeof(_pricing) = 'null' THEN NULL ELSE _pricing END;
  v_slot boolean := false;
  v_related uuid[];
  v_event uuid;
  v_version text;
  v_released uuid[] := ARRAY[]::uuid[];
  v_rel record;
  v_rid uuid;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL OR _notify_customer IS NULL
    OR _shipping_amount IS NULL OR _shipping_amount<0 OR (_amount IS NOT NULL AND _amount<0)
    OR pg_catalog.char_length(_note)>500
    OR (_pricing IS NOT NULL AND pg_catalog.jsonb_typeof(_pricing) NOT IN ('object', 'null')) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_fp:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'amount',_amount,
    'shipping_amount',_shipping_amount,'note',_note,'notify_customer',_notify_customer)::text);
  -- The outer body takes the advisory and complete row closure before the return helper.
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  -- Unit binding: an order with a discount snapshot also locks the member's related orders (a release may touch their holds), with the one call below.
  IF EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = v_order_id) THEN
    v_related := private.order_unit_related_orders(v_order_id);
  END IF;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id] || COALESCE(v_related, ARRAY[]::uuid[]), NULL);
  -- Approval may have changed the exchange target while this entry waited on the advisory.
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_return := private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT r.* INTO v_old FROM public.order_refunds AS r WHERE r.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id IS DISTINCT FROM _return_id OR v_old.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT v_old.id,v_old.amount,v_old.status,true,private.order_unit_release_refund_ids(_request_key,v_old.order_id);RETURN;
  END IF;
  SELECT rr.* INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_receipt.return_id IS DISTINCT FROM _return_id OR v_receipt.kind<>'waive_refund'
      OR v_receipt.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT NULL::uuid,0,'waived'::text,true,private.order_unit_release_refund_ids(_request_key,v_order_id);RETURN;
  END IF;
  -- Existing business rule (unchanged).
  IF v_return.status NOT IN ('open','closed') THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  -- Unit binding: the pricing is looked at only after the replays above. A consult refund changes no slot state, so the pricing carries
  -- only the releases of money held on earlier orders (and the version it was made from); an older order carries none.
  v_slot:=EXISTS(SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id=v_order);
  IF NOT v_slot AND v_pricing IS NOT NULL THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_legacy'; END IF;
  IF v_slot THEN
    IF v_related IS DISTINCT FROM private.order_unit_related_orders(v_order) THEN
      RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE='40001'; END IF;
    IF v_pricing IS NOT NULL THEN
      IF pg_catalog.jsonb_typeof(v_pricing->'orderId') IS DISTINCT FROM 'string' OR (v_pricing->>'orderId') IS DISTINCT FROM v_order::text
        OR pg_catalog.jsonb_typeof(v_pricing->'version') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(v_pricing->'releases') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_plan_1'; END IF;
      v_version:=private.order_unit_version(v_order);
      IF v_pricing->>'version' IS DISTINCT FROM v_version THEN RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE='40001'; END IF;
    END IF;
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,
      'before_shipment',false,'quantity',t.quantity) ORDER BY t.order_item_id),'[]'::jsonb),
    COALESCE(pg_catalog.sum(CASE WHEN v_slot THEN 0
      WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=t.order_item_id)
      THEN private.group_h_return_refund_amount(_return_id,t.order_item_id,t.quantity)
      ELSE private.return_units_amount(t.order_item_id,t.quantity) END),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,pg_catalog.sum(g.refund_waiting)::integer AS quantity
      FROM private.order_return_line_progress(_return_id) AS g JOIN public.order_return_lines AS l ON l.id=g.return_line_id
      WHERE g.refund_waiting>0 GROUP BY l.order_item_id
    ) AS t;
  IF pg_catalog.jsonb_array_length(v_lines)=0 THEN RAISE EXCEPTION 'RETURN_NOTHING_TO_REFUND' USING ERRCODE='22023'; END IF;
  IF v_slot THEN
    -- The standard amount of a consult refund is the consult part of the events no consult refund covers yet (R34): the same events the core
    -- links to the refund and the screen (loadConsultOutstanding) counts. A manager's change of an earlier refund is not carried.
    v_goods:=COALESCE((SELECT pg_catalog.sum(e.consult_refund) FROM public.order_unit_events AS e
      WHERE e.order_id=v_order AND e.return_id=_return_id AND e.kind='return_receive'
        AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id=e.id)
        AND EXISTS (SELECT 1 FROM public.order_unit_event_lines AS l WHERE l.event_id=e.id AND l.line_kind='returned' AND l.part='consult')
        AND NOT EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er JOIN public.order_refunds AS rf ON rf.id=er.refund_id
          WHERE er.event_id=e.id AND er.part='consult' AND rf.status<>'failed')),0)::integer;
    SELECT e.id INTO v_event FROM public.order_unit_events AS e
    WHERE e.order_id=v_order AND e.return_id=_return_id AND e.kind='return_receive'
      AND EXISTS (SELECT 1 FROM public.order_unit_event_lines AS l WHERE l.event_id=e.id AND l.line_kind='returned' AND l.part='consult')
    ORDER BY e.seq DESC LIMIT 1;
    IF v_event IS NULL THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_refund_event'; END IF;
  END IF;
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  v_cap:=GREATEST(v_goods-v_return.fee_pending_deduction,0)+_shipping_amount;
  v_amount:=COALESCE(_amount,v_cap);
  IF v_amount<_shipping_amount
    OR (_amount IS NOT NULL AND _amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a)) THEN
    RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  IF v_amount=0 THEN
    -- Existing business rule (unchanged).
    BEGIN
      INSERT INTO public.order_return_receipts(return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
        notify_customer,note,actor_id,actor_can_refund)
      VALUES(_return_id,_request_key,v_fp,'waive_refund',NULL,NULL,_notify_customer,_note,_actor_id,true)
      RETURNING * INTO v_receipt;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt.id,g.return_line_id,'refund_waived',g.refund_waiting,NULL,NULL
    FROM private.order_return_line_progress(_return_id) AS g WHERE g.refund_waiting>0;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0 AND pg_catalog.left(o.payment_intent_id,3)='pi_'
      AND pg_catalog.char_length(o.payment_intent_id)>3) THEN
      RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  SELECT r.* INTO v_result FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,
    _shipping_amount,v_amount,_note,'requested_by_customer',NULL,_notify_customer,_actor_id,_amount,_return_id,
    LEAST(v_return.fee_pending_deduction,v_goods),CASE WHEN v_slot THEN v_event END) AS r;
  END IF;
  -- Unit binding: money held back on earlier orders that the pricing gives back is refunded here, each as its own event and refund.
  IF v_slot AND v_pricing IS NOT NULL THEN
    FOR v_rel IN SELECT * FROM private.order_unit_apply_releases(v_pricing,v_version,v_order,_request_key,_actor_id) LOOP
      IF v_rel.refund_amount>0 THEN
        SELECT c.refund_id INTO v_rid FROM private.begin_order_refund_core(v_rel.held_order_id,'unit_hold_release',v_rel.request_key,
          '[]'::jsonb,false,0,v_rel.refund_amount,NULL,'requested_by_customer',NULL,false,_actor_id,NULL,
          NULL::uuid,NULL::integer,v_rel.event_id) AS c;
        v_released:=v_released||v_rid;
      END IF;
    END LOOP;
  END IF;
  -- Existing business rule (unchanged).
  UPDATE public.order_returns AS rt SET fee_pending_deduction=0,
    fee_due_amount=rt.fee_due_amount+GREATEST(v_return.fee_pending_deduction-v_goods,0),
    fee_waived=CASE WHEN v_return.fee_pending_deduction>v_goods THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_return.fee_pending_deduction>v_goods THEN NULL ELSE rt.fee_received_note END
  WHERE rt.id=_return_id;
  PERFORM private.refresh_order_return_status(_return_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_refund_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_refund_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_refund_return', 'return_id', _return_id, 'request_fingerprint', v_fp)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  v_middle := private.capture_group_g_item_states(v_orders);
  PERFORM private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  IF v_amount=0 THEN RETURN QUERY SELECT NULL::uuid,0,'waived'::text,false,v_released;
  ELSE RETURN QUERY SELECT v_result.refund_id,v_result.amount,v_result.status,v_result.replayed,v_released; END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE FUNCTION public.begin_order_refund(
  _order_id uuid, _source text, _request_key uuid, _lines jsonb, _restock boolean,
  _shipping_amount integer, _amount integer, _note text, _stripe_reason text, _cancel_reason text,
  _notify_customer boolean, _actor_id uuid, _received_amount integer DEFAULT NULL, _pricing jsonb DEFAULT NULL
) RETURNS TABLE (refund_id uuid, amount integer, status text, replayed boolean, release_refund_ids uuid[])
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT * FROM private.begin_order_refund(_order_id, _source, _request_key, _lines, _restock, _shipping_amount,
    _amount, _note, _stripe_reason, _cancel_reason, _notify_customer, _actor_id, _received_amount, _pricing);
$$;

CREATE FUNCTION public.admin_refund_return(
  _return_id uuid,_actor_id uuid,_request_key uuid,_amount integer,
  _shipping_amount integer,_note text,_notify_customer boolean,_pricing jsonb DEFAULT NULL
) RETURNS TABLE(refund_id uuid,amount integer,status text,replayed boolean,release_refund_ids uuid[])
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM private.admin_refund_return(_return_id, _actor_id, _request_key, _amount, _shipping_amount, _note, _notify_customer, _pricing);
$$;

CREATE OR REPLACE FUNCTION private.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text, _pricing jsonb DEFAULT NULL
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean,
  release_refund_ids uuid[])
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
  v_free_by_variant jsonb;
  v_exchange_used jsonb:='{}'::jsonb; v_h_offset integer; v_h_used integer; v_h_take integer;
  v_h_own integer[]; v_h_free integer[]; v_h_part integer[];
  v_qty jsonb; v_now_effective jsonb; v_now_elements jsonb; v_consult_elements jsonb; v_goods_consult integer:=0;
  v_fee_consult integer:=0; v_fixed integer:=0; v_has_now boolean; v_has_consult boolean; v_unresolved boolean;
  v_derived text; v_now_total integer:=0; v_consult_total integer:=0; v_total integer:=0; v_now_picked integer:=0;
  v_refundable integer; v_refundable_shipping integer;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_pricing jsonb := CASE WHEN pg_catalog.jsonb_typeof(_pricing) = 'null' THEN NULL ELSE _pricing END;
  v_slot boolean := false;
  v_related uuid[];
  v_event uuid;
  v_taken text[] := ARRAY[]::text[];
  v_links jsonb := '[]'::jsonb;
  v_pick record;
  v_k integer;
  v_price_sum integer;
  v_version text;
  v_rel record;
  v_rid uuid;
  v_released uuid[] := ARRAY[]::uuid[];
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _actor_can_refund IS NULL OR _request_key IS NULL
    OR _notify_customer IS NULL OR _refund_choice IS NULL OR _refund_choice NOT IN ('now','consult','mixed','none')
    OR _refund_shipping_amount IS NULL OR _refund_shipping_amount<0
    OR (_refund_amount IS NOT NULL AND _refund_amount<0) OR pg_catalog.char_length(_note)>500
    OR pg_catalog.char_length(_sent_back_message)>1000
    OR (_sent_back_carrier IS NOT NULL AND _sent_back_carrier NOT IN ('yamato','sagawa','japanpost','other'))
    OR (_sent_back_tracking_number IS NOT NULL AND _sent_back_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
    OR pg_catalog.jsonb_typeof(_units) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(_exchange_overrides) IS DISTINCT FROM 'array'
    OR (_pricing IS NOT NULL AND pg_catalog.jsonb_typeof(_pricing) NOT IN ('object', 'null')) THEN
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
  IF _refund_choice NOT IN ('now','mixed') AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_units) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_j->'quantity') IS DISTINCT FROM 'number'
      OR (v_j->>'quantity') !~ '^[1-9][0-9]{0,2}$'
      OR COALESCE(v_j->>'disposition','') NOT IN ('restocked','not_restocked','pending_inspection','sent_back')
      OR (COALESCE(pg_catalog.jsonb_typeof(v_j->'refund_choice'),'null')<>'null'
        AND (pg_catalog.jsonb_typeof(v_j->'refund_choice')<>'string' OR (v_j->>'refund_choice') NOT IN ('now','consult'))) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF (v_id::text||':'||(v_j->>'disposition')||':'||COALESCE(v_j->>'refund_choice',''))=ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||(v_id::text||':'||(v_j->>'disposition')||':'||COALESCE(v_j->>'refund_choice',''));
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
  -- A body without any line choice keeps the H5 fingerprint; otherwise each line carries its choice.
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(_units) AS x(refund_choice text) WHERE x.refund_choice IS NOT NULL) THEN
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'disposition',x.disposition,
        'quantity',x.quantity,'refund_choice',x.refund_choice)
      ORDER BY x.return_line_id,x.disposition,x.refund_choice NULLS FIRST) INTO v_units
    FROM pg_catalog.jsonb_to_recordset(_units) AS x(return_line_id uuid,disposition text,quantity integer,refund_choice text);
  ELSE
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'disposition',x.disposition,'quantity',x.quantity)
      ORDER BY x.return_line_id,x.disposition) INTO v_units
    FROM pg_catalog.jsonb_to_recordset(_units) AS x(return_line_id uuid,disposition text,quantity integer);
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'action',x.action)
    ORDER BY x.return_line_id),'[]'::jsonb) INTO v_overrides
  FROM pg_catalog.jsonb_to_recordset(_exchange_overrides) AS x(return_line_id uuid,action text);
  v_fp:=pg_catalog.md5(pg_catalog.jsonb_build_object('return_id',_return_id,'units',v_units,'exchange_overrides',v_overrides,
    'refund_choice',_refund_choice,'refund_amount',_refund_amount,'refund_shipping_amount',_refund_shipping_amount,
    'note',_note,'notify_customer',_notify_customer,'sent_back_message',_sent_back_message,
    'sent_back_carrier',_sent_back_carrier,'sent_back_tracking_number',_sent_back_tracking_number,
    'actor_can_refund',_actor_can_refund)::text);
  -- The outer body takes the advisory and complete row closure before the return helper.
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  -- Unit binding: an order with a discount snapshot also locks the member's related orders (the plan may touch their holds), in the same
  -- lock order and after the (190521,1) advisory lock, with the one call below. The related orders are read first; a change seen after the
  -- lock (a related order that appeared or went away) is a stale plan: UNIT_PRICING_STALE.
  IF EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = v_order_id) THEN
    v_related := private.order_unit_related_orders(v_order_id);
  END IF;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id] || COALESCE(v_related, ARRAY[]::uuid[]), NULL);
  IF v_related IS NOT NULL AND v_related IS DISTINCT FROM private.order_unit_related_orders(v_order_id) THEN
    RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE='40001';
  END IF;
  -- Approval may have changed the exchange target while this entry waited on the advisory.
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM (
    SELECT oi.variant_id AS id FROM public.order_return_lines AS l
      JOIN public.order_items AS oi ON oi.id = l.order_item_id WHERE l.return_id = _return_id
    UNION SELECT l.exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
    UNION SELECT l.requested_exchange_variant_id FROM public.order_return_lines AS l WHERE l.return_id = _return_id
  ) AS x WHERE x.id IS NOT NULL;
  v_return := private.lock_order_return(_return_id);
  v_order:=v_return.order_id;
  SELECT rr.* INTO v_old FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id<>_return_id OR v_old.kind<>'receive' OR v_old.request_fingerprint<>v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    -- Existing business rule (unchanged).
    RETURN QUERY SELECT v_old.id,v_return.status,r.id,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 0 ELSE r.amount END,
      CASE WHEN EXISTS(SELECT 1 FROM public.order_return_receipt_lines AS w WHERE w.receipt_id=v_old.id AND w.disposition='refund_waived') THEN 'waived' ELSE r.status END,
      COALESCE((SELECT pg_catalog.array_agg(DISTINCT oi.id ORDER BY oi.id) FROM public.order_return_receipt_lines AS u
        JOIN public.order_items AS oi ON oi.id=private.return_exchange_item_id(v_old.id,u.return_line_id,u.exchange_method)
        WHERE u.receipt_id=v_old.id),ARRAY[]::uuid[]),v_return.fee_due_amount,
      EXISTS(SELECT 1 FROM private.order_email_outbox AS e WHERE e.return_receipt_id=v_old.id AND e.kind='return_refund_pending_shop'),true,
      private.order_unit_release_refund_ids(_request_key,v_order_id)
    FROM (SELECT 1) AS singleton LEFT JOIN public.order_refunds AS r ON r.id=v_old.refund_id;
    RETURN;
  END IF;
  IF NOT _actor_can_refund AND (_refund_choice IN ('now','mixed') OR EXISTS (SELECT 1
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(refund_choice text) WHERE x.refund_choice='now'))
    AND NOT (v_return.source='customer_request' AND v_return.return_method<>'not_required') THEN RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023'; END IF;
  IF v_return.status<>'open' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  -- Unit binding: an order with a discount snapshot is priced by a plan; an older order is not. Looked at only after the replay above.
  v_slot:=EXISTS(SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id=v_order);
  IF v_slot AND v_pricing IS NULL THEN RAISE EXCEPTION 'UNIT_PRICING_REQUIRED' USING ERRCODE='22023'; END IF;
  IF NOT v_slot AND v_pricing IS NOT NULL THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_legacy'; END IF;
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
  -- Existing business rule (unchanged).
  IF v_sent>0 AND NOT _notify_customer THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;

  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(disposition text) WHERE x.disposition='pending_inspection')
    AND NOT (SELECT s.inspection_enabled FROM public.shop_return_settings AS s WHERE s.id=1) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- Existing business rule (unchanged).
  IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text)
    LEFT JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason=l.reason
    WHERE l.return_id IS DISTINCT FROM _return_id OR l.resolution IS DISTINCT FROM 'exchange'
      OR l.exchange_method IS DISTINCT FROM 'stock' OR rs.out_of_stock_exchange IS NULL
      OR (rs.out_of_stock_exchange='make' AND x.action<>'refund')
      OR NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
        WHERE u.return_line_id=l.id AND u.disposition<>'sent_back')) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- Effective rows: a refund row takes its own choice or the parent now/consult; other rows keep NULL.
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',e.return_line_id,
      'disposition',e.disposition,'quantity',e.quantity,'resolution',e.resolution,
      'exchange_method',e.exchange_method,'refund_choice',e.refund_choice)
      ORDER BY e.return_line_id,e.disposition,e.refund_choice NULLS FIRST)
    INTO v_effective
  FROM (
    SELECT y.return_line_id,y.disposition,y.resolution,y.exchange_method,
      CASE WHEN y.resolution='refund' THEN COALESCE(y.unit_choice,
        CASE WHEN _refund_choice IN ('now','consult') THEN _refund_choice END) END AS refund_choice,
      pg_catalog.sum(y.quantity)::integer AS quantity
    FROM (
      SELECT u.return_line_id,u.disposition,u.quantity,u.refund_choice AS unit_choice,
        CASE WHEN u.disposition='sent_back' THEN NULL WHEN x.action='refund' THEN 'refund' ELSE l.resolution END AS resolution,
        CASE WHEN u.disposition='sent_back' OR l.resolution='refund' OR x.action='refund' THEN NULL
          WHEN x.action='make' THEN 'make' ELSE l.exchange_method END AS exchange_method
      FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer,refund_choice text)
      JOIN public.order_return_lines AS l ON l.id=u.return_line_id
      LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text) ON x.return_line_id=l.id
    ) AS y
    GROUP BY 1,2,3,4,5
  ) AS e;
  SELECT COALESCE(pg_catalog.bool_or(x.refund_choice='now'),false),COALESCE(pg_catalog.bool_or(x.refund_choice='consult'),false),
    COALESCE(pg_catalog.bool_or(x.resolution='refund' AND x.refund_choice IS NULL),false)
    INTO v_has_now,v_has_consult,v_unresolved
  FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(resolution text,refund_choice text);
  v_derived:=CASE WHEN v_has_now AND v_has_consult THEN 'mixed' WHEN v_has_now THEN 'now' WHEN v_has_consult THEN 'consult' END;
  IF (v_unresolved AND _refund_choice<>'none')
    OR (_refund_choice='none' AND v_derived IS NOT NULL)
    OR (v_derived IS NOT NULL AND v_derived<>_refund_choice)
    OR (_refund_choice='mixed' AND v_derived IS NULL)
    OR ((_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) AND NOT v_has_now) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF v_slot THEN
    BEGIN
      IF pg_catalog.jsonb_typeof(v_pricing->'orderId') IS DISTINCT FROM 'string' OR (v_pricing->>'orderId') IS DISTINCT FROM v_order::text
        OR (v_pricing->>'kind') IS DISTINCT FROM 'return_receive'
        OR pg_catalog.jsonb_typeof(v_pricing->'lines') IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_typeof(COALESCE(v_pricing->'treatments','[]'::jsonb)) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_receive_lines';
      END IF;
      IF pg_catalog.jsonb_typeof(v_pricing->'nowRefund') IS DISTINCT FROM 'number' OR (v_pricing->>'nowRefund') !~ '^[0-9]{1,9}$'
        OR pg_catalog.jsonb_typeof(v_pricing->'consultRefund') IS DISTINCT FROM 'number' OR (v_pricing->>'consultRefund') !~ '^[0-9]{1,9}$' THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_plan_1';
      END IF;
      -- The returned lines of the plan are exactly the refund units of this receipt, per return line and per part (now / consult).
      IF EXISTS (
        SELECT 1 FROM (
          SELECT x.return_line_id,x.refund_choice AS part,pg_catalog.sum(x.quantity)::integer AS n
          FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,refund_choice text)
          WHERE x.resolution='refund' AND x.refund_choice IN ('now','consult') AND x.disposition IN ('restocked','not_restocked','pending_inspection')
          GROUP BY 1,2
        ) AS w FULL JOIN (
          SELECT l."returnLineId" AS return_line_id,l.part,pg_catalog.count(*)::integer AS n
          FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid,part text)
          WHERE l."lineKind"='returned' GROUP BY 1,2
        ) AS h ON h.return_line_id=w.return_line_id AND h.part=w.part
        WHERE w.n IS DISTINCT FROM h.n
      ) THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_receive_lines'; END IF;
      -- Every returned plan line is held by the item of its return line (for an exchange item return, the exchange item).
      IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid,"holderOrderItemId" uuid)
        LEFT JOIN public.order_return_lines AS rl ON rl.id=l."returnLineId"
        WHERE l."lineKind"='returned' AND l."holderOrderItemId" IS DISTINCT FROM rl.order_item_id
      ) THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_receive_lines'; END IF;
      -- A discount treatment names a returned line and agrees with the side the plan gave that line.
      IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_to_recordset(COALESCE(v_pricing->'treatments','[]'::jsonb)) AS t("returnLineId" uuid,treatment text)
        WHERE t."returnLineId" IS NULL OR t.treatment IS NULL OR t.treatment NOT IN ('shop','customer')
          OR NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid)
            WHERE l."lineKind"='returned' AND l."returnLineId"=t."returnLineId")
          OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid,"stateAfter" text)
            WHERE l."lineKind"='returned' AND l."returnLineId"=t."returnLineId"
              AND l."stateAfter" IS DISTINCT FROM CASE t.treatment WHEN 'shop' THEN 'returned_shop' ELSE 'returned_customer' END)
      ) THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_treatment'; END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datatype_mismatch OR invalid_parameter_value THEN
      IF SQLSTATE='22023' AND SQLERRM='UNIT_PRICING_INVALID' THEN RAISE; END IF;
      RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_plan_1';
    END;
  END IF;
  -- Select methods from pre-receipt F in the existing line order, without reserving stock.
  -- Fees and receipt rows are final before ordinary FIFO can allocate any exchange line.
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  SELECT COALESCE(pg_catalog.jsonb_object_agg(v.id::text, v.stock_quantity), '{}'::jsonb)
    INTO v_free_by_variant FROM public.item_variants AS v WHERE v.id = ANY(v_variants);
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
      v_available := COALESCE((v_free_by_variant->>v_line.exchange_variant_id::text)::integer, 0);
      IF v_available>=v_line.picked THEN
        -- Existing business rule (unchanged).
        IF v_line.override_action IS NOT NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
        v_action:='stock';
        v_free_by_variant := pg_catalog.jsonb_set(v_free_by_variant, ARRAY[v_line.exchange_variant_id::text],
          pg_catalog.to_jsonb(v_available-v_line.picked));
      ELSIF v_line.override_action IS NOT NULL THEN
        v_action:=v_line.override_action;
      ELSIF (SELECT rs.out_of_stock_exchange FROM public.shop_return_reason_settings AS rs WHERE rs.reason=v_line.reason)='make' THEN
        v_action:='make';
      ELSE
        RAISE EXCEPTION 'RETURN_EXCHANGE_OUT_OF_STOCK' USING ERRCODE='22023';
      END IF;
    END IF;
    -- Existing business rule (unchanged).
    CONTINUE WHEN v_action='refund';
    SELECT COALESCE(pg_catalog.sum(e.quantity),0)::integer INTO v_offset FROM public.order_items AS e
    JOIN public.order_return_lines AS old ON old.id=e.exchange_return_line_id WHERE old.order_item_id=v_line.order_item_id;
    IF v_slot THEN
      -- Unit binding: the exchange units take kept slots held by the returned line's item: the slots bound to this return line
      -- (FREQ-641 return_line_id) first, then the cheapest slot (the H cheapest-first order the design allows, 4-1), then the order item
      -- and unit_index order. A slot the plan returns, or a slot another refund holds (refund_id), is not taken. The exchange
      -- price (display only) is the sum of the slots' prices after this event.
      v_item:=private.return_exchange_item_id(v_receipt,v_line.id,v_action);
      v_price_sum:=0;v_k:=0;
      FOR v_pick IN SELECT s.order_item_id AS slot_item,s.unit_index AS slot_index,COALESCE(pk."priceAfter",s.current_price) AS price,
          s.holder_order_item_id AS holder_item,s.holder_unit_index AS holder_index
        FROM public.order_unit_slots AS s
        JOIN public.order_line_unit_amounts AS u ON u.order_item_id=s.order_item_id AND u.unit_index=s.unit_index
        LEFT JOIN pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS pk("lineKind" text,"orderItemId" uuid,"unitIndex" integer,"priceAfter" integer)
          ON pk."lineKind" IN ('returned','kept') AND pk."orderItemId"=s.order_item_id AND pk."unitIndex"=s.unit_index
        WHERE s.order_id=v_order AND s.state='kept' AND s.holder_order_item_id=v_line.order_item_id AND u.refund_id IS NULL
          AND (pk."lineKind" IS NULL OR pk."lineKind"<>'returned')
          AND NOT ((s.order_item_id::text||':'||s.unit_index::text)=ANY(v_taken))
        ORDER BY (u.return_line_id IS NOT DISTINCT FROM v_line.id) DESC,s.current_price,s.order_item_id,s.unit_index
        LIMIT v_line.picked LOOP
        v_taken:=v_taken||(v_pick.slot_item::text||':'||v_pick.slot_index::text);
        v_links:=v_links||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('exchange',v_item,'index',v_k,
          'slot_item',v_pick.slot_item,'slot_index',v_pick.slot_index,
          'prev_item',CASE WHEN v_pick.holder_item<>v_pick.slot_item OR v_pick.holder_index<>v_pick.slot_index THEN v_pick.holder_item END,
          'prev_index',CASE WHEN v_pick.holder_item<>v_pick.slot_item OR v_pick.holder_index<>v_pick.slot_index THEN v_pick.holder_index END));
        v_price_sum:=v_price_sum+v_pick.price;v_k:=v_k+1;
      END LOOP;
      IF v_k<>v_line.picked THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_exchange_slots'; END IF;
      v_paid:=v_price_sum;
    ELSIF EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=v_line.order_item_id) THEN
      -- I-1: own units after the waiting ones, then free units from one queue per item, so two exchange lines
      -- of the same item never price the same free unit (the old per-line call restarted the free units each time).
      SELECT p.refund_waiting INTO v_h_offset FROM private.order_return_line_progress(_return_id) AS p WHERE p.return_line_id=v_line.id;
      SELECT COALESCE(pg_catalog.array_agg(b.paid_amount ORDER BY b.remaining_index),ARRAY[]::integer[]) INTO v_h_own
        FROM private.group_h_return_unit_rows(v_line.id) AS b WHERE b.remaining_index IS NOT NULL;
      SELECT COALESCE(pg_catalog.array_agg(u.paid_amount ORDER BY u.paid_amount,u.unit_index),ARRAY[]::integer[]) INTO v_h_free
        FROM public.order_line_unit_amounts AS u
        WHERE u.order_item_id=v_line.order_item_id AND u.return_line_id IS NULL AND u.refund_id IS NULL;
      IF v_h_offset IS NULL OR v_h_offset<0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      v_h_used:=COALESCE((v_exchange_used->>v_line.order_item_id::text)::integer,0)
        +GREATEST(v_h_offset-pg_catalog.cardinality(v_h_own),0);
      v_h_take:=LEAST(v_line.picked,GREATEST(pg_catalog.cardinality(v_h_own)-v_h_offset,0));
      v_h_part:=v_h_own[(v_h_offset+1):(v_h_offset+v_h_take)]
        ||COALESCE(v_h_free[(v_h_used+1):(v_h_used+v_line.picked-v_h_take)],ARRAY[]::integer[]);
      IF pg_catalog.cardinality(v_h_part)<>v_line.picked THEN
        RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      v_paid:=COALESCE((SELECT pg_catalog.sum(x.amount) FROM pg_catalog.unnest(v_h_part) AS x(amount)),0)::integer;
      v_exchange_used:=pg_catalog.jsonb_set(v_exchange_used,ARRAY[v_line.order_item_id::text],
        pg_catalog.to_jsonb(v_h_used+v_line.picked-v_h_take));
    ELSE
      v_paid:=private.return_units_amount(v_line.order_item_id,v_line.picked,v_offset);
    END IF;
    -- Existing business rule (unchanged).
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,'disposition',u.disposition,
        'quantity',u.quantity,'resolution',u.resolution,'exchange_method',CASE WHEN u.return_line_id=v_line.id
          AND u.resolution='exchange' THEN v_action ELSE u.exchange_method END,'refund_choice',u.refund_choice)
        ORDER BY u.return_line_id,u.disposition,u.refund_choice NULLS FIRST)
      INTO v_effective
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS u(return_line_id uuid,disposition text,quantity integer,
      resolution text,exchange_method text,refund_choice text);
    v_item:=private.return_exchange_item_id(v_receipt,v_line.id,v_action);
    INSERT INTO public.order_items(id,order_id,item_id,variant_id,item_name,item_price,color,size,quantity,line_total,
      fulfillment_type,line_kind,exchange_return_line_id,exchange_paid_amount)
    SELECT v_item,v_order,v.item_id,v.id,i.name,0,c.name,z.label,v_line.picked,0,
      CASE WHEN v_action='stock' THEN 'stock' ELSE 'backorder' END,'exchange',v_line.id,v_paid
    FROM public.item_variants AS v JOIN public.items AS i ON i.id=v.item_id
    LEFT JOIN public.item_colors AS c ON c.id=v.color_id LEFT JOIN public.item_sizes AS z ON z.id=v.size_id
    WHERE v.id=v_line.exchange_variant_id;
    v_exchange_ids:=v_exchange_ids||v_item;v_exchange:=v_exchange+v_line.picked;
  END LOOP;
  -- Preserve the original restock rejection before any refund validation or fee decision.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN public.order_items AS oi ON oi.id=l.order_item_id
    WHERE x.disposition='restocked' AND oi.variant_id IS NULL
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_slot THEN
    -- Unit binding: the units, the amounts and the item lines come from the plan, not from the position counting below.
    SELECT COALESCE(pg_catalog.sum(x.quantity),0)::integer,
      COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.refund_choice='now'),0)::integer,
      COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.refund_choice='consult'),0)::integer
      INTO v_total,v_now_total,v_consult_total
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(quantity integer,disposition text,resolution text,refund_choice text)
    WHERE x.resolution='refund' AND x.refund_choice IN ('now','consult') AND x.disposition IN ('restocked','not_restocked','pending_inspection');
    v_now_picked:=v_now_total;
    v_goods:=(v_pricing->>'nowRefund')::integer;
    v_goods_consult:=(v_pricing->>'consultRefund')::integer;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',c.item,'before_shipment',false,'quantity',c.n) ORDER BY c.item),'[]'::jsonb)
      INTO v_lines
    FROM (SELECT rl.order_item_id AS item,pg_catalog.count(*)::integer AS n
      FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,"returnLineId" uuid,part text)
      JOIN public.order_return_lines AS rl ON rl.id=l."returnLineId"
      WHERE l."lineKind"='returned' AND l.part='now' GROUP BY rl.order_item_id) AS c;
  ELSE
  -- Per item: T from all effective rows, now from the rows without consult, consult from the rest of T.
  v_now_effective:=COALESCE((SELECT pg_catalog.jsonb_agg(e.value) FROM pg_catalog.jsonb_array_elements(v_effective) AS e(value)
    WHERE (e.value->>'refund_choice') IS DISTINCT FROM 'consult'),'[]'::jsonb);
  WITH before_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states(v_order) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), after_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states_core(v_order,v_effective) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), after_now AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states_core(v_order,v_now_effective) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), picked AS (
    SELECT l.order_item_id,pg_catalog.sum(x.quantity)::integer AS total,
      COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.refund_choice='now'),0)::integer AS now_n,
      COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.refund_choice='consult'),0)::integer AS consult_n
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,quantity integer,resolution text,refund_choice text)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    WHERE x.resolution='refund' GROUP BY l.order_item_id
  ), counted AS (
    SELECT p.order_item_id,p.now_n,p.consult_n,LEAST(p.total,GREATEST(a.waiting-b.waiting,0)) AS total_q,
      LEAST(p.now_n,p.total,GREATEST(COALESCE(n.waiting,b.waiting)-b.waiting,0)) AS now_q
    FROM picked AS p JOIN before_receive AS b ON b.order_item_id=p.order_item_id
    JOIN after_receive AS a ON a.order_item_id=p.order_item_id
    LEFT JOIN after_now AS n ON n.order_item_id=p.order_item_id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',c.order_item_id,'total',c.total_q,
      'now',LEAST(c.now_q,c.total_q),'consult',LEAST(c.consult_n,GREATEST(c.total_q-LEAST(c.now_q,c.total_q),0)),
      'now_picked',c.now_n) ORDER BY c.order_item_id),'[]'::jsonb)
    INTO v_qty FROM counted AS c;
  SELECT COALESCE(pg_catalog.sum(q.total),0)::integer,COALESCE(pg_catalog.sum(q.now),0)::integer,
    COALESCE(pg_catalog.sum(q.consult),0)::integer,COALESCE(pg_catalog.sum(q.now_picked),0)::integer
    INTO v_total,v_now_total,v_consult_total,v_now_picked
  FROM pg_catalog.jsonb_to_recordset(v_qty) AS q(total integer,now integer,consult integer,now_picked integer);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',q.order_item_id,'before_shipment',false,'quantity',q.now)
      ORDER BY q.order_item_id) FILTER (WHERE q.now>0),'[]'::jsonb)
    INTO v_lines FROM pg_catalog.jsonb_to_recordset(v_qty) AS q(order_item_id uuid,now integer);
  -- H rows: now skips W0=max(own-unprocessed,0); consult also skips the now units of the same line.
  WITH choice_rows AS (
    SELECT x.return_line_id,x.refund_choice,pg_catalog.sum(x.quantity)::integer AS quantity
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,quantity integer,resolution text,refund_choice text)
    WHERE x.resolution='refund' AND x.refund_choice IS NOT NULL GROUP BY x.return_line_id,x.refund_choice
  ), placed AS (
    SELECT r.*,GREATEST((SELECT pg_catalog.count(*)::integer FROM private.group_h_return_unit_rows(r.return_line_id) AS b
        WHERE b.remaining_index IS NOT NULL)-p.unprocessed,0)
      +CASE WHEN r.refund_choice='consult' THEN COALESCE((SELECT o.quantity FROM choice_rows AS o
        WHERE o.return_line_id=r.return_line_id AND o.refund_choice='now'),0) ELSE 0 END AS unit_offset
    FROM choice_rows AS r JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=r.return_line_id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'resolution','refund',
      'quantity',x.quantity,'unit_offset',x.unit_offset,'refund_choice','now')) FILTER (WHERE x.refund_choice='now'),'[]'::jsonb),
    COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'resolution','refund',
      'quantity',x.quantity,'unit_offset',x.unit_offset,'refund_choice','consult')) FILTER (WHERE x.refund_choice='consult'),'[]'::jsonb)
    INTO v_now_elements,v_consult_elements FROM placed AS x;
  -- I-1: cap the now rows of each item at the counted now units in line order (the order the cap and the
  -- slices take them), so the consult pass below starts after exactly the free units the now pass used.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_set(e.value,ARRAY['quantity'],pg_catalog.to_jsonb(e.capped))
      ORDER BY e.line_id) FILTER (WHERE e.capped>0),'[]'::jsonb) INTO v_now_elements
  FROM (
    SELECT x.value,l.id AS line_id,LEAST((x.value->>'quantity')::integer,GREATEST(q.now-COALESCE(pg_catalog.sum((x.value->>'quantity')::integer)
      OVER (PARTITION BY l.order_item_id ORDER BY l.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0),0)) AS capped
    FROM pg_catalog.jsonb_array_elements(v_now_elements) AS x(value)
    JOIN public.order_return_lines AS l ON l.id=(x.value->>'return_line_id')::uuid
    JOIN pg_catalog.jsonb_to_recordset(v_qty) AS q(order_item_id uuid,now integer) ON q.order_item_id=l.order_item_id
  ) AS e;
  SELECT COALESCE(pg_catalog.sum(CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=q.order_item_id)
      THEN private.group_h_receiving_amount(_return_id,q.order_item_id,q.now,v_now_elements)
      ELSE private.return_units_amount(q.order_item_id,q.now,0) END),0)::integer,
    COALESCE(pg_catalog.sum(CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=q.order_item_id)
      -- I-1: the consult units come after the now units of the same item; the now pass's free units are not reused.
      THEN private.group_h_receiving_amount(_return_id,q.order_item_id,q.now+q.consult,v_now_elements||v_consult_elements)
        -private.group_h_receiving_amount(_return_id,q.order_item_id,q.now,v_now_elements)
      ELSE private.return_units_amount(q.order_item_id,q.now+q.consult,0)-private.return_units_amount(q.order_item_id,q.now,0) END),0)::integer
    INTO v_goods,v_goods_consult
  FROM pg_catalog.jsonb_to_recordset(v_qty) AS q(order_item_id uuid,now integer,consult integer);
  END IF;
  IF (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) AND v_now_total<v_now_picked THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023';
  END IF;
  IF _refund_choice='none' AND v_total>0 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_choice:=CASE WHEN v_now_total>0 AND v_consult_total>0 THEN 'mixed' WHEN v_now_total>0 THEN 'now'
    WHEN v_consult_total>0 THEN 'consult' ELSE 'none' END;
  v_first_goods:=NOT EXISTS(SELECT 1 FROM public.order_return_receipts AS rr
    JOIN public.order_return_receipt_lines AS u ON u.receipt_id=rr.id
    WHERE rr.return_id=_return_id AND rr.kind='receive' AND u.resolution IN ('refund','exchange'));
  v_first_exchange:=NOT EXISTS(SELECT 1 FROM public.order_items AS e
    JOIN public.order_return_lines AS l ON l.id=e.exchange_return_line_id
    WHERE l.return_id=_return_id AND NOT (e.id=ANY(v_exchange_ids)));
  v_fixed:=CASE WHEN v_first_goods AND (v_total>0 OR v_exchange>0) AND v_return.return_method='shop_label'
      THEN v_return.return_shipping_fee ELSE 0 END
    +CASE WHEN v_first_exchange AND v_exchange>0 THEN v_return.exchange_fee+v_return.exchange_shipping_fee ELSE 0 END;
  IF v_slot THEN
    -- The restocking rate is inside E: the plan's nowRefund and consultRefund are already net of it. Only the fixed fees remain.
    v_fees:=v_fixed;v_fee_consult:=0;
  ELSE
    v_fees:=(v_goods::bigint*v_return.restocking_fee_percent/100)::integer+v_fixed;
    v_fee_consult:=(v_goods_consult::bigint*v_return.restocking_fee_percent/100)::integer;
  END IF;
  IF v_now_total>0 THEN
    v_amount:=GREATEST(v_goods-v_fees,0)+_refund_shipping_amount;
    SELECT a.refundable_amount,a.refundable_shipping INTO v_refundable,v_refundable_shipping
      FROM private.order_refund_amounts(v_order) AS a;
    IF _refund_amount IS NOT NULL AND _refund_amount<_refund_shipping_amount THEN
      RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
    IF _refund_shipping_amount>COALESCE(v_refundable_shipping,0) THEN
      RAISE EXCEPTION 'REFUND_SHIPPING_EXCEEDS' USING ERRCODE='22023'; END IF;
    IF _refund_amount IS NOT NULL THEN
      IF _refund_amount>LEAST(COALESCE(v_refundable,0),v_goods+_refund_shipping_amount) THEN
        RAISE EXCEPTION 'RETURN_RECEIVE_REFUND_CAP_EXCEEDED' USING ERRCODE='22023'; END IF;
      v_amount:=_refund_amount;
    END IF;
    IF v_slot THEN v_amount:=LEAST(v_amount,COALESCE(v_refundable,0)); END IF;
    IF v_consult_total>0 THEN
      v_pending:=GREATEST(v_fees-v_goods,0)+v_fee_consult;
    ELSE
      v_due:=GREATEST(v_fees-v_goods,0);
    END IF;
    IF v_amount=0 THEN v_waived:=true;v_status:='waived';
    ELSE v_refund:=pg_catalog.gen_random_uuid(); END IF;
  ELSIF v_consult_total>0 THEN v_pending:=v_fee_consult+v_fixed;
  ELSE v_due:=v_fees;
  END IF;
  -- Existing business rule (unchanged).
  IF v_refund IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.orders AS o WHERE o.id=v_order AND o.status IN ('paid','shipped','cancelled')
      AND o.paid_amount IS NOT NULL AND o.paid_amount>0
      AND pg_catalog.left(o.payment_intent_id,3)='pi_' AND pg_catalog.char_length(o.payment_intent_id)>3
  ) THEN RAISE EXCEPTION 'ORDER_NOT_REFUNDABLE' USING ERRCODE='22023'; END IF;
  BEGIN
    -- N-1: keep the consult units this receipt made waiting (after the cover cap); not part of the fingerprint.
    INSERT INTO public.order_return_receipts(id,return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
      notify_customer,sent_back_message,sent_back_carrier,sent_back_tracking_number,note,actor_id,actor_can_refund,consult_quantity)
    VALUES(v_receipt,_return_id,_request_key,v_fp,'receive',v_choice,v_refund,_notify_customer,
      _sent_back_message,_sent_back_carrier,_sent_back_tracking_number,_note,_actor_id,_actor_can_refund,v_consult_total);
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END;
  IF v_slot THEN
    -- The discount treatment of each returned line (who set it and when stays on the receipt), then the plan: the version and the
    -- formula are checked there and nothing is written when they do not hold.
    INSERT INTO public.order_return_line_treatments(return_line_id,treatment,receipt_id,actor_id)
    SELECT DISTINCT ON (t."returnLineId") t."returnLineId",t.treatment,v_receipt,_actor_id
    FROM pg_catalog.jsonb_to_recordset(COALESCE(v_pricing->'treatments','[]'::jsonb)) AS t("returnLineId" uuid,treatment text)
    ORDER BY t."returnLineId";
    -- An exchange-only receipt changes no slot state, price or hold: the plan has no line, and no event is written for it.
    v_version:=private.order_unit_version(v_order);
    IF pg_catalog.jsonb_array_length(v_pricing->'lines')>0 OR pg_catalog.jsonb_array_length(COALESCE(v_pricing->'holds','[]'::jsonb))>0 THEN
      v_event:=private.order_unit_apply_plan(v_pricing,_request_key,_return_id,v_receipt,_actor_id);
    END IF;
  END IF;
  INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method,refund_choice)
  SELECT v_receipt,x.return_line_id,x.disposition,x.quantity,x.resolution,x.exchange_method,x.refund_choice
  FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,
    resolution text,exchange_method text,refund_choice text);
  IF v_waived THEN
    -- Only the now units end here; consultation units stay waiting.
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt,w.return_line_id,'refund_waived',w.waived,NULL,NULL FROM (
      SELECT u.return_line_id,LEAST(u.quantity,GREATEST(c.quantity-COALESCE(pg_catalog.sum(u.quantity) OVER(
          PARTITION BY u.order_item_id ORDER BY u.return_line_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::integer,0)) AS waived
      FROM (
        SELECT x.return_line_id,l.order_item_id,pg_catalog.sum(x.quantity)::integer AS quantity
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,resolution text,quantity integer,refund_choice text)
        JOIN public.order_return_lines AS l ON l.id=x.return_line_id
        WHERE x.resolution='refund' AND x.refund_choice='now' GROUP BY x.return_line_id,l.order_item_id
      ) AS u JOIN pg_catalog.jsonb_to_recordset(v_lines) AS c(order_item_id uuid,quantity integer) ON c.order_item_id=u.order_item_id
    ) AS w WHERE w.waived>0;
  END IF;
  IF v_slot THEN
    -- Exchange links: one row per exchange unit; the slot's holder becomes the exchange unit (price and state are unchanged).
    INSERT INTO public.order_unit_exchange_links(exchange_order_item_id,exchange_unit_index,slot_order_item_id,slot_unit_index,
      previous_order_item_id,previous_unit_index,receipt_id)
    SELECT (x.value->>'exchange')::uuid,(x.value->>'index')::integer,(x.value->>'slot_item')::uuid,(x.value->>'slot_index')::integer,
      (x.value->>'prev_item')::uuid,(x.value->>'prev_index')::integer,v_receipt
    FROM pg_catalog.jsonb_array_elements(v_links) AS x(value);
    UPDATE public.order_unit_slots AS s SET holder_order_item_id=(x.value->>'exchange')::uuid,holder_unit_index=(x.value->>'index')::integer
    FROM pg_catalog.jsonb_array_elements(v_links) AS x(value)
    WHERE s.order_item_id=(x.value->>'slot_item')::uuid AND s.unit_index=(x.value->>'slot_index')::integer;
  END IF;
  IF v_refund IS NOT NULL THEN
    -- Every refund of a receive passes through the core. For an order with a discount snapshot the core takes the line amounts from the
    -- event's allocations, claims no unit by position and ties the refund to the event (order_unit_link_refund, part now).
    SELECT r.refund_id,r.amount,r.status INTO v_refund,v_amount,v_status
    FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,_refund_shipping_amount,v_amount,
      _note,'requested_by_customer',NULL,_notify_customer,_actor_id,_refund_amount,_return_id,LEAST(v_fees,v_goods),
      CASE WHEN v_slot THEN v_event END) AS r;
    -- The claim may change which units stay bound; settle the release in the same lock.
    PERFORM private.group_h_release_return_units(_return_id);
  END IF;
  -- Unit binding: money held back on earlier orders that this receive gives back is refunded here, each as its own event and refund.
  IF v_slot AND pg_catalog.jsonb_array_length(COALESCE(v_pricing->'releases','[]'::jsonb))>0 THEN
    FOR v_rel IN SELECT * FROM private.order_unit_apply_releases(v_pricing,v_version,v_order,_request_key,_actor_id) LOOP
      IF v_rel.refund_amount>0 THEN
        SELECT c.refund_id INTO v_rid FROM private.begin_order_refund_core(v_rel.held_order_id,'unit_hold_release',v_rel.request_key,
          '[]'::jsonb,false,0,v_rel.refund_amount,NULL,'requested_by_customer',NULL,false,_actor_id,NULL,
          NULL::uuid,NULL::integer,v_rel.event_id) AS c;
        v_released:=v_released||v_rid;
      END IF;
    END LOOP;
  END IF;
  -- Existing business rule (unchanged).
  UPDATE public.order_returns AS rt SET fee_due_amount=rt.fee_due_amount+v_due,
    fee_pending_deduction=rt.fee_pending_deduction+v_pending,
    fee_waived=CASE WHEN v_due>0 THEN false ELSE rt.fee_waived END,
    fee_received_at=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_at END,
    fee_received_by=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_by END,
    fee_received_note=CASE WHEN v_due>0 THEN NULL ELSE rt.fee_received_note END WHERE rt.id=_return_id;
  -- Restock after method selection; receipt rows and fees precede ordinary FIFO.
  FOR v_line IN SELECT l.order_item_id,oi.variant_id,pg_catalog.sum(x.quantity)::integer AS quantity
    FROM pg_catalog.jsonb_to_recordset(v_units) AS x(return_line_id uuid,disposition text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
    WHERE x.disposition='restocked' GROUP BY l.order_item_id,oi.variant_id ORDER BY oi.variant_id,l.order_item_id
  LOOP
    IF v_line.variant_id IS NULL THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    INSERT INTO public.stock_movements(variant_id,delta,reason,order_id,order_item_id,created_by,return_id)
    VALUES(v_line.variant_id,v_line.quantity,'return',v_order,v_line.order_item_id,_actor_id,_return_id);
  END LOOP;
  IF v_exchange>0 THEN
    PERFORM pg_catalog.set_config('app.order_actor_id',_actor_id::text,true);
    PERFORM pg_catalog.set_config('app.order_change_reason','return_exchange_added',true);
    PERFORM pg_catalog.set_config('app.order_source_event_id','',true);
    UPDATE public.orders AS o SET status='paid',shipped_at=NULL,shipping_carrier=NULL,tracking_number=NULL
    WHERE o.id=v_order AND o.status='shipped';
  END IF;
  IF NOT _actor_can_refund AND v_choice IN ('consult','mixed') THEN
    v_shop:=private.enqueue_return_email(v_order,'return_refund_pending_shop',_return_id,v_receipt);
  END IF;
  IF _notify_customer AND v_refund IS NULL THEN
    PERFORM private.enqueue_return_email(v_order,CASE WHEN v_sent=(SELECT pg_catalog.sum(x.quantity)
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(quantity integer)) THEN 'return_sent_back' ELSE 'return_received' END,_return_id,v_receipt);
  END IF;
  return_status:=private.refresh_order_return_status(_return_id);
  SELECT rt.fee_due_amount INTO fee_due_amount FROM public.order_returns AS rt WHERE rt.id=_return_id;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_receive_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_receive_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_receive_return', 'return_id', _return_id, 'request_fingerprint', v_fp)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  v_middle := private.capture_group_g_item_states(v_orders);
  PERFORM private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_receipt,return_status,v_refund,v_amount,v_status,
    ARRAY(SELECT x FROM pg_catalog.unnest(v_exchange_ids) AS x ORDER BY x),fee_due_amount,v_shop,false,v_released;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

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
    'private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)',
    'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)',
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
    'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)',
    'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)',
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
    'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)',
    'private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text)'
  ]::pg_catalog.regprocedure[];
$$;

-- The shop stopped the refund of a pre-shipment cancel (the refund failed): undo the cancel. Allowed only when the refund is failed, the
-- cancel event it is tied to has no later event on the order, no fee and no hold, and every slot it changed still shows that event. Writes
-- a cancel_reverted event whose lines negate the cancel's allocations and corrections and whose slots go back to kept at their price
-- before; an event reverted already answers with the same cancel_reverted event. Called by accounting plan 3 ("the shop stopped the refund").
CREATE FUNCTION private.order_unit_revert_cancel(_refund_id uuid, _actor_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order uuid; v_refund public.order_refunds%ROWTYPE; v_x public.order_unit_events%ROWTYPE; v_existing uuid; v_tot record;
  v_paid integer; v_kept_after bigint; v_ent integer; v_gross integer; v_shop integer; v_revert uuid;
BEGIN
  SELECT r.order_id INTO v_order FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF v_order IS NULL THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_refund';
  END IF;
  PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[v_order], NULL);
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  SELECT e.* INTO v_x FROM public.order_unit_events AS e
    JOIN public.order_unit_event_refunds AS er ON er.event_id = e.id AND er.refund_id = _refund_id AND er.part = 'now'
    WHERE e.kind = 'pre_shipment_cancel' AND e.order_id = v_order;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_event';
  END IF;
  SELECT r.id INTO v_existing FROM public.order_unit_events AS r WHERE r.reverts_event_id = v_x.id;
  IF FOUND THEN RETURN v_existing; END IF;
  IF v_refund.status <> 'failed' THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_status';
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_unit_events AS e WHERE e.order_id = v_order AND e.seq > v_x.seq) THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_later';
  END IF;
  -- A cancel never carries a fee or a hold (a shop-side event); the reverse below could not undo either, so refuse rather than guess.
  IF v_x.fee_amount <> 0 THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_fee';
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_unit_holds AS h WHERE h.event_id = v_x.id) THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_holds';
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er JOIN public.order_refunds AS rf ON rf.id = er.refund_id
    WHERE er.event_id = v_x.id AND er.refund_id <> _refund_id AND rf.status <> 'failed') THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_refund';
  END IF;
  -- Every slot the cancel changed still shows that event and the state and price it wrote.
  IF EXISTS (SELECT 1 FROM public.order_unit_event_lines AS l
      LEFT JOIN public.order_unit_slots AS s ON s.order_item_id = l.order_item_id AND s.unit_index = l.unit_index
      WHERE l.event_id = v_x.id AND l.line_kind IN ('returned', 'kept')
        AND (s.order_item_id IS NULL OR s.last_event_id IS DISTINCT FROM v_x.id OR s.state IS DISTINCT FROM l.state_after OR s.current_price IS DISTINCT FROM l.price_after)) THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_slot';
  END IF;
  -- The reverse restores the state before the cancel, so E is again the cancel's previous E; the identity of 4-1 must hold for it.
  SELECT * INTO v_tot FROM private.order_unit_totals(v_order);
  SELECT COALESCE(pg_catalog.sum(u.paid_amount), 0)::integer INTO v_paid FROM public.order_line_unit_amounts AS u WHERE u.order_id = v_order;
  SELECT COALESCE(pg_catalog.sum(CASE WHEN l.order_item_id IS NOT NULL THEN l.price_before WHEN s.state = 'kept' THEN s.current_price ELSE 0 END), 0)
    INTO v_kept_after
  FROM public.order_unit_slots AS s
  LEFT JOIN public.order_unit_event_lines AS l ON l.event_id = v_x.id AND l.line_kind IN ('returned', 'kept')
    AND l.order_item_id = s.order_item_id AND l.unit_index = s.unit_index
  WHERE s.order_id = v_order;
  v_gross := v_paid - v_kept_after - v_tot.held_total;
  v_ent := v_gross - v_tot.fee_total;
  IF v_ent <> v_x.entitlement_previous THEN
    RAISE EXCEPTION 'UNIT_CANCEL_REVERT_REFUSED' USING ERRCODE = '22023', DETAIL = 'ubrr_identity';
  END IF;
  SELECT COALESCE((SELECT e.entitlement_shop_only FROM public.order_unit_events AS e WHERE e.order_id = v_order AND e.seq < v_x.seq
    AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = e.id) ORDER BY e.seq DESC LIMIT 1), 0) INTO v_shop;
  INSERT INTO public.order_unit_events(order_id, kind, request_key, reverts_event_id, entitlement_previous, entitlement_max_before,
    entitlement_gross, entitlement_shop_only, fee_amount, hold_total, entitlement, standard_refund, now_refund, consult_refund, actor_id)
  VALUES (v_order, 'cancel_reverted', pg_catalog.md5('ub_revert:' || _refund_id::text)::uuid, v_x.id, v_tot.entitlement_previous,
    v_tot.entitlement_max, v_gross, v_shop, 0, v_tot.held_total, v_ent, 0, 0, 0, _actor_id)
  RETURNING id INTO v_revert;
  INSERT INTO public.order_unit_event_lines(event_id, line_kind, order_item_id, unit_index, slot_order_id, holder_order_item_id,
    holder_unit_index, state_before, state_after, price_before, price_after, allocation, correction, part, return_line_id, shipped)
  SELECT v_revert, l.line_kind, l.order_item_id, l.unit_index, l.slot_order_id, l.holder_order_item_id, l.holder_unit_index,
    l.state_after, l.state_before, l.price_after, l.price_before, -l.allocation, -l.correction, l.part, l.return_line_id, l.shipped
  FROM public.order_unit_event_lines AS l
  WHERE l.event_id = v_x.id AND l.line_kind IN ('returned', 'kept');
  -- The one way back: returned_shop -> kept for a slot whose last event is a pre_shipment_cancel, with the transaction-local flag and the G lock.
  PERFORM pg_catalog.set_config('app.unit_slot_revert', pg_catalog.txid_current()::text, true);
  UPDATE public.order_unit_slots AS s SET state = l.state_before, current_price = l.price_before, last_event_id = v_revert
  FROM public.order_unit_event_lines AS l
  WHERE l.event_id = v_x.id AND l.line_kind IN ('returned', 'kept') AND s.order_item_id = l.order_item_id AND s.unit_index = l.unit_index;
  PERFORM pg_catalog.set_config('app.unit_slot_revert', '', true);
  RETURN v_revert;
END;
$$;

CREATE FUNCTION public.order_unit_revert_cancel(_refund_id uuid, _actor_id uuid) RETURNS uuid
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$
  SELECT private.order_unit_revert_cancel(_refund_id, _actor_id)
$$;

-- UBF_FUNCTIONS_END

-- UBF_ACL_BEGIN
ALTER FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb) TO service_role;
ALTER FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb) TO service_role;
ALTER FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) TO service_role;
ALTER FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) TO service_role;
ALTER FUNCTION private.order_unit_apply_releases(jsonb,text,uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_unit_apply_releases(jsonb,text,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.order_unit_release_refund_ids(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_unit_release_refund_ids(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.order_unit_revert_cancel(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_unit_revert_cancel(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.order_unit_revert_cancel(uuid,uuid) TO service_role;
ALTER FUNCTION public.order_unit_revert_cancel(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_unit_revert_cancel(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.order_unit_revert_cancel(uuid,uuid) TO service_role;
ALTER FUNCTION private.group_g_writer_allowlist() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_writer_allowlist() FROM PUBLIC, anon, authenticated, service_role;
-- UBF_ACL_END

-- UBF_FINAL_ASSERT_BEGIN
DO $ubf_final$
DECLARE
  e record; p record; v_oid oid; v_detail text;
BEGIN
  -- ubf_schema: the source check also allows unit_hold_release and still allows every earlier source.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = 'public.order_refunds'::regclass AND c.conname = 'order_refunds_source_check'
      AND c.convalidated AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%unit_hold_release%'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%stripe_dashboard%' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%auto_amount_mismatch%'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%legacy%') THEN
    v_detail := 'ubf_schema';
  END IF;
  -- ubf_functions: owner, security, settings, volatility, language and the exact body of every function of this file; each name has one
  -- definition in its schema; the functions this file replaced are gone.
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private', 'begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)', 'v', false, 'plpgsql', '8f3524cfe91aa584b9b4f920836415a8'),
      ('private', 'begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)', 'v', true, 'plpgsql', '1e5958fcc5de211c18eb5c652efb7435'),
      ('public', 'begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)', 'v', false, 'sql', 'a010341cb930728e76bb6b6eb5372162'),
      ('private', 'admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', 'v', true, 'plpgsql', '20e46a103d331e8f90d4d57ee6d9641b'),
      ('public', 'admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', 'v', false, 'sql', '4b6151504b2b4559ec419212f48868e8'),
      ('private', 'admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)', 'v', true, 'plpgsql', 'daea7cc9a531f61cb5a93a1afca5f95b'),
      ('private', 'order_unit_apply_releases(jsonb,text,uuid,uuid,uuid)', 'v', true, 'plpgsql', '129bc85f9df23d382dffbcd9dc6eb175'),
      ('private', 'order_unit_release_refund_ids(uuid,uuid)', 's', true, 'sql', '9ca21a59ca78ea0aa891a26fa1e15227'),
      ('private', 'order_unit_revert_cancel(uuid,uuid)', 'v', true, 'plpgsql', 'ac5f2ce3b417a309b78dcbe446939198'),
      ('public', 'order_unit_revert_cancel(uuid,uuid)', 'v', false, 'sql', 'af5ef73d94942eae6bef817c3fdecdb9'),
      ('private', 'group_g_writer_allowlist()', 's', true, 'sql', 'c69a0caaee1e7f0335a6c1f8536d9d53')
    ) AS expected(schema_name, signature, volatility, definer, lang, body_md5) LOOP
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF NOT FOUND OR p.proowner <> 'postgres'::regrole OR p.prosecdef <> e.definer OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
        OR p.provolatile <> e.volatility::"char" OR p.prokind <> 'f' OR p.prolang <> (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = e.lang)
        OR pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r', '')) <> e.body_md5
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
          WHERE n.nspname = e.schema_name AND f.proname = pg_catalog.split_part(e.signature, '(', 1)) <> 1 THEN
        v_detail := 'ubf_functions'; EXIT;
      END IF;
    END LOOP;
  END IF;
  IF v_detail IS NULL AND (
    pg_catalog.to_regprocedure('private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)') IS NOT NULL
    OR pg_catalog.to_regprocedure('private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer)') IS NOT NULL
    OR pg_catalog.to_regprocedure('private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)') IS NOT NULL) THEN
    v_detail := 'ubf_functions';
  END IF;
  -- ubf_acl: service_role runs the entries and their private bodies only; the core and the helpers are for the bodies.
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)', false),
      ('private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)', true),
      ('public.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)', true),
      ('private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', true),
      ('public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', true),
      ('private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)', true),
      ('private.order_unit_apply_releases(jsonb,text,uuid,uuid,uuid)', false),
      ('private.order_unit_release_refund_ids(uuid,uuid)', false),
      ('private.order_unit_revert_cancel(uuid,uuid)', true),
      ('public.order_unit_revert_cancel(uuid,uuid)', true),
      ('private.group_g_writer_allowlist()', false)
    ) AS expected(signature, service) LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') <> e.service
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
        v_detail := 'ubf_acl'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- ubf_allowlist: the writer list keeps its 77 entries; exactly the three replaced signatures changed, to the new ones.
  IF v_detail IS NULL THEN
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.unnest(private.group_g_writer_allowlist())) <> 77
      OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x)) <> 77
      OR (SELECT pg_catalog.count(*) FROM ubf_writer_baseline) <> 77
      OR (SELECT pg_catalog.count(*) FROM ubf_writer_baseline AS b
        WHERE b.oid <> ALL (SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))) <> 3
      OR EXISTS (SELECT 1 FROM ubf_writer_baseline AS b
        WHERE b.oid <> ALL (SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))
          AND b.oid IN (SELECT f.oid FROM pg_catalog.pg_proc AS f WHERE f.oid = b.oid))
      OR NOT (pg_catalog.to_regprocedure('private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)')::oid
        IN (SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x)))
      OR NOT (pg_catalog.to_regprocedure('private.begin_order_refund(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,jsonb)')::oid
        IN (SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x)))
      OR NOT (pg_catalog.to_regprocedure('private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)')::oid
        IN (SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))) THEN
      v_detail := 'ubf_allowlist';
    END IF;
  END IF;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'UNIT_BINDING_REFUNDS_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = v_detail;
  END IF;
END;
$ubf_final$;
-- UBF_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
