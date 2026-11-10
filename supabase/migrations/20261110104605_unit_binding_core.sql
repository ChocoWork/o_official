BEGIN;

-- Unit binding, migration B (FREQ-642), 2026-11-10: the DB core that serves the pricing materials, checks a TypeScript pricing plan
-- and records one event per receive or cancel, plus the unit-list overloads of the refund claim and the refund link.
-- @impl FREQ-642-AC-17 FREQ-642-AC-18 FREQ-642-AC-04
-- @design docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md
-- 1. order_unit_events: the ten amount columns lose their DEFAULT 0 (NOT NULL stays), so a missing value fails loudly.
-- 2. order_unit_slots: a BEFORE UPDATE guard. The key columns (order_item_id, unit_index, order_id, item_id) never change; the state moves
--    only kept -> returned_customer / returned_shop. A returned slot keeps its price and holder. returned_shop -> kept is allowed only
--    for a slot whose last_event_id is a pre_shipment_cancel event, while app.unit_slot_revert equals the current top-level
--    transaction id (the revert path runs: select set_config('app.unit_slot_revert', txid_current()::text, true) right before its
--    UPDATE; a non-local or older setting never equals the new transaction id) and the G lock is held. A CHECK still answers for
--    an unknown state value.
-- 3. private.order_unit_pricing_materials (+ public entry for service_role): the UnitPricingMaterials JSON of the TypeScript planner.
--    version = the largest event seq that touched the target or a related order ('0' when none). related = every other paid order of the
--    same member that has a snapshot. A hold row appears only in the materials of the order that is held_order_id.
-- 4. private.order_unit_apply_plan: checks the plan (G lock, version, slot facts, transitions, allocations, the identity
--    sum(allocation) - sum(correction) - fee = E - previous E, refund rule, bounds, holds) and records event, lines, holds and slot state.
--    Detail codes ub_plan_1 .. ub_plan_9 (UNIT_PRICING_INVALID / 22023); a stale version is UNIT_PRICING_STALE / 40001.
-- 5. private.group_h_claim_refund_units (units list) and private.group_h_release_return_units (units list): overloads of the H5 functions
--    (same names, so the H guard of order_line_unit_amounts accepts them). private.order_unit_link_refund, private.order_unit_outstanding.
-- Applied migrations are never edited. The G writer allowlist is not changed here.

-- UBC_SCHEMA_BEGIN
ALTER TABLE public.order_unit_events
  ALTER COLUMN entitlement_previous DROP DEFAULT,
  ALTER COLUMN entitlement_max_before DROP DEFAULT,
  ALTER COLUMN entitlement_gross DROP DEFAULT,
  ALTER COLUMN entitlement_shop_only DROP DEFAULT,
  ALTER COLUMN fee_amount DROP DEFAULT,
  ALTER COLUMN hold_total DROP DEFAULT,
  ALTER COLUMN entitlement DROP DEFAULT,
  ALTER COLUMN standard_refund DROP DEFAULT,
  ALTER COLUMN now_refund DROP DEFAULT,
  ALTER COLUMN consult_refund DROP DEFAULT;

CREATE FUNCTION private.order_unit_slot_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF OLD.order_item_id IS DISTINCT FROM NEW.order_item_id OR OLD.unit_index IS DISTINCT FROM NEW.unit_index
    OR OLD.order_id IS DISTINCT FROM NEW.order_id OR OLD.item_id IS DISTINCT FROM NEW.item_id THEN
    RAISE EXCEPTION 'UNIT_SLOT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'key';
  END IF;
  -- A returned slot keeps its price, holder and last event, except in the revert path below.
  IF OLD.state IN ('returned_customer', 'returned_shop') AND NOT (OLD.state = 'returned_shop' AND NEW.state = 'kept')
    AND (NEW.current_price IS DISTINCT FROM OLD.current_price OR NEW.holder_order_item_id IS DISTINCT FROM OLD.holder_order_item_id
      OR NEW.holder_unit_index IS DISTINCT FROM OLD.holder_unit_index OR NEW.last_event_id IS DISTINCT FROM OLD.last_event_id) THEN
    RAISE EXCEPTION 'UNIT_SLOT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'frozen';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state IN ('kept', 'returned_customer', 'returned_shop')
    AND NEW.state IN ('kept', 'returned_customer', 'returned_shop') THEN
    IF OLD.state = 'kept' THEN
      NULL;
    ELSIF OLD.state = 'returned_shop' AND NEW.state = 'kept'
      AND pg_catalog.current_setting('app.unit_slot_revert', true) IS NOT DISTINCT FROM pg_catalog.txid_current()::text
      AND EXISTS (SELECT 1 FROM public.order_unit_events AS e WHERE e.id = OLD.last_event_id AND e.kind = 'pre_shipment_cancel') THEN
      PERFORM private.group_h_assert_unit_lock();
    ELSE
      RAISE EXCEPTION 'UNIT_SLOT_IMMUTABLE' USING ERRCODE = '55000', DETAIL = 'state';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ub_order_unit_slots_guard BEFORE UPDATE ON public.order_unit_slots
  FOR EACH ROW EXECUTE FUNCTION private.order_unit_slot_guard();
ALTER TABLE public.order_unit_slots ENABLE ALWAYS TRIGGER ub_order_unit_slots_guard;
-- UBC_SCHEMA_END

-- UBC_FUNCTIONS_BEGIN
-- The other paid, snapshot-bearing orders of the target's member (earlier and later), oldest first.
CREATE FUNCTION private.order_unit_related_orders(_order_id uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.array_agg(o.id ORDER BY o.created_at, o.id), ARRAY[]::uuid[])
  FROM public.orders AS t JOIN public.orders AS o ON o.user_id = t.user_id AND o.id <> t.id
  WHERE t.id = _order_id AND t.user_id IS NOT NULL
    AND (o.status IN ('paid', 'shipped') OR o.paid_amount > 0)
    AND EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = o.id)
$$;

-- Opaque version: '<largest seq of the events that touched the target or a related order (as event order or as a slot order of
-- a line)>:<md5 of the sorted related order ids>'. A related order that appears or disappears without an event changes it too.
CREATE FUNCTION private.order_unit_version(_order_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT (SELECT COALESCE(pg_catalog.max(e.seq), 0)
    FROM public.order_unit_events AS e
    WHERE e.order_id = ANY (ARRAY[_order_id] || private.order_unit_related_orders(_order_id))
      OR EXISTS (SELECT 1 FROM public.order_unit_event_lines AS l WHERE l.event_id = e.id
        AND l.slot_order_id = ANY (ARRAY[_order_id] || private.order_unit_related_orders(_order_id))))::text
    || ':' || pg_catalog.md5(COALESCE((SELECT pg_catalog.string_agg(t.x::text, ',' ORDER BY t.x)
      FROM pg_catalog.unnest(private.order_unit_related_orders(_order_id)) AS t(x)), ''))
$$;

-- previous E = the entitlement of the newest event, max = the largest entitlement without the events a cancel_reverted event undid,
-- fee total = the fees of the events not undone, held total = every hold row held on this order.
CREATE FUNCTION private.order_unit_totals(_order_id uuid)
RETURNS TABLE(entitlement_previous integer, entitlement_max integer, fee_total integer, held_total integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT
    COALESCE((SELECT e.entitlement FROM public.order_unit_events AS e WHERE e.order_id = _order_id
      AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = e.id)
      ORDER BY e.seq DESC LIMIT 1), 0),
    GREATEST(COALESCE((SELECT pg_catalog.max(e.entitlement) FROM public.order_unit_events AS e WHERE e.order_id = _order_id
      AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = e.id)), 0), 0),
    COALESCE((SELECT pg_catalog.sum(e.fee_amount) FROM public.order_unit_events AS e WHERE e.order_id = _order_id
      AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = e.id)), 0)::integer,
    COALESCE((SELECT pg_catalog.sum(h.amount) FROM public.order_unit_holds AS h WHERE h.held_order_id = _order_id), 0)::integer
$$;

-- One OrderPricingState of the TypeScript planner. NULL when the order has no snapshot.
CREATE FUNCTION private.order_unit_order_state(_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE; v_snap public.order_discount_snapshots%ROWTYPE; v_tot record; v_slots jsonb; v_holds jsonb;
BEGIN
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  SELECT s.* INTO v_snap FROM public.order_discount_snapshots AS s WHERE s.order_id = _order_id;
  IF v_order.id IS NULL OR v_snap.order_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_tot FROM private.order_unit_totals(_order_id);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'orderItemId', s.order_item_id, 'unitIndex', s.unit_index, 'itemId', s.item_id, 'paidAmount', u.paid_amount,
      'allocatedAmount', COALESCE(al.total, 0)::integer, 'currentPrice', s.current_price, 'state', s.state,
      'holderOrderItemId', s.holder_order_item_id, 'holderUnitIndex', s.holder_unit_index,
      'shipped', sh.unit_index IS NOT NULL,
      'returnedCustomerAt', CASE WHEN s.state = 'returned_customer'
        THEN pg_catalog.to_char(ret.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'returnedFeePercent', CASE WHEN s.state = 'returned_customer' THEN ret.fee_percent END,
      'returnedEventSeq', CASE WHEN s.state = 'returned_customer' THEN ret.seq END,
      'returnedReturnLineId', CASE WHEN s.state = 'returned_customer' THEN ret.return_line_id END,
      -- The claim of a slot held by an exchange unit is the exchange claim (spent): it is not reported, so a later return of the exchange item can pick the slot.
      'claimedReturnLineId', CASE WHEN s.holder_order_item_id = s.order_item_id AND s.holder_unit_index = s.unit_index THEN u.return_line_id END,
      -- The refund that holds the unit (refund_id); the planner does not pick such a slot.
      'claimedRefundId', u.refund_id) ORDER BY s.order_item_id, s.unit_index), '[]'::jsonb)
  INTO v_slots
  FROM public.order_unit_slots AS s
  JOIN public.order_line_unit_amounts AS u ON u.order_item_id = s.order_item_id AND u.unit_index = s.unit_index
  LEFT JOIN LATERAL (
    SELECT pg_catalog.sum(el.allocation) AS total
    FROM public.order_unit_event_lines AS el JOIN public.order_unit_events AS ev ON ev.id = el.event_id
    WHERE el.order_item_id = s.order_item_id AND el.unit_index = s.unit_index AND ev.kind <> 'cancel_reverted'
      AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = ev.id)
  ) AS al ON true
  LEFT JOIN LATERAL (
    SELECT ev.seq, ev.created_at, rr.restocking_fee_percent AS fee_percent, el.return_line_id
    FROM public.order_unit_event_lines AS el JOIN public.order_unit_events AS ev ON ev.id = el.event_id
    LEFT JOIN public.order_returns AS rr ON rr.id = ev.return_id
    WHERE el.order_item_id = s.order_item_id AND el.unit_index = s.unit_index AND el.line_kind = 'returned' AND el.state_after = s.state
      AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = ev.id)
    ORDER BY ev.seq DESC LIMIT 1
  ) AS ret ON true
  LEFT JOIN LATERAL (
    SELECT x.unit_index FROM private.accounting_shipped_units(s.order_item_id, NULL) AS x WHERE x.unit_index = s.unit_index
  ) AS sh ON true
  WHERE s.order_id = _order_id;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'heldOrderId', h.held_order_id, 'laterOrderId', h.later_order_id, 'itemId', h.item_id, 'amount', h.amount, 'seq', ev.seq)
      ORDER BY ev.seq, h.id), '[]'::jsonb)
  INTO v_holds
  FROM public.order_unit_holds AS h JOIN public.order_unit_events AS ev ON ev.id = h.event_id
  WHERE h.held_order_id = _order_id;
  RETURN pg_catalog.jsonb_build_object(
    'orderId', _order_id,
    'placedAt', pg_catalog.to_char(v_order.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'paidTotal', (SELECT COALESCE(pg_catalog.sum(u.paid_amount), 0)::integer FROM public.order_line_unit_amounts AS u WHERE u.order_id = _order_id),
    'snapshot', pg_catalog.jsonb_build_object('engineVersion', v_snap.engine_version, 'definitions', v_snap.definitions,
      'codes', pg_catalog.to_jsonb(v_snap.codes), 'facts', v_snap.facts, 'lines', v_snap.lines),
    'slots', v_slots,
    'entitlementPrevious', v_tot.entitlement_previous, 'entitlementMax', v_tot.entitlement_max, 'feeTotal', v_tot.fee_total,
    'holds', v_holds);
END;
$$;

CREATE FUNCTION private.order_unit_pricing_materials(_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_target jsonb; v_related jsonb;
BEGIN
  v_target := private.order_unit_order_state(_order_id);
  IF v_target IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(private.order_unit_order_state(r.id) ORDER BY r.ordinality), '[]'::jsonb) INTO v_related
  FROM pg_catalog.unnest(private.order_unit_related_orders(_order_id)) WITH ORDINALITY AS r(id, ordinality);
  RETURN pg_catalog.jsonb_build_object('version', private.order_unit_version(_order_id), 'target', v_target, 'related', v_related);
END;
$$;

CREATE FUNCTION public.order_unit_pricing_materials(_order_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT private.order_unit_pricing_materials(_order_id)
$$;

-- The plan JSON as rows (camelCase keys of UnitPlanLine / UnitHold).
CREATE FUNCTION private.order_unit_plan_lines(_plan jsonb)
RETURNS TABLE(line_kind text, order_item_id uuid, unit_index integer, slot_order_id uuid, holder_order_item_id uuid, holder_unit_index integer,
  state_before text, state_after text, price_before integer, price_after integer, allocation integer, correction integer,
  part text, return_line_id uuid, shipped boolean)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT l."lineKind", l."orderItemId", l."unitIndex", l."slotOrderId", l."holderOrderItemId", l."holderUnitIndex",
    l."stateBefore", l."stateAfter", l."priceBefore", l."priceAfter", l.allocation, l.correction, l.part, l."returnLineId", l.shipped
  FROM pg_catalog.jsonb_to_recordset(_plan -> 'lines') AS l("lineKind" text, "orderItemId" uuid, "unitIndex" integer, "slotOrderId" uuid,
    "holderOrderItemId" uuid, "holderUnitIndex" integer, "stateBefore" text, "stateAfter" text, "priceBefore" integer, "priceAfter" integer,
    allocation integer, correction integer, part text, "returnLineId" uuid, shipped boolean)
$$;

CREATE FUNCTION private.order_unit_plan_holds(_plan jsonb)
RETURNS TABLE(held_order_id uuid, later_order_id uuid, item_id bigint, amount integer)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT h."heldOrderId", h."laterOrderId", h."itemId", h.amount
  FROM pg_catalog.jsonb_to_recordset(_plan -> 'holds') AS h("heldOrderId" uuid, "laterOrderId" uuid, "itemId" bigint, amount integer)
$$;

-- Each plan line with what the database knows about its slot (state, price, holder, paid amount, allocated so far, shipped).
CREATE FUNCTION private.order_unit_plan_line_facts(_plan jsonb)
RETURNS TABLE(line_kind text, order_item_id uuid, unit_index integer, slot_order_id uuid, holder_order_item_id uuid, holder_unit_index integer,
  state_before text, state_after text, price_before integer, price_after integer, allocation integer, correction integer,
  part text, return_line_id uuid, shipped boolean,
  s_order_id uuid, s_item_id bigint, s_state text, s_price integer, s_holder_item uuid, s_holder_index integer,
  s_paid integer, s_allocated integer, s_shipped boolean)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT f.line_kind, f.order_item_id, f.unit_index, f.slot_order_id, f.holder_order_item_id, f.holder_unit_index,
    f.state_before, f.state_after, f.price_before, f.price_after, f.allocation, f.correction, f.part, f.return_line_id, f.shipped,
    s.order_id, s.item_id, s.state, s.current_price, s.holder_order_item_id, s.holder_unit_index, u.paid_amount,
    COALESCE((SELECT pg_catalog.sum(el.allocation) FROM public.order_unit_event_lines AS el
      JOIN public.order_unit_events AS ev ON ev.id = el.event_id
      WHERE el.order_item_id = f.order_item_id AND el.unit_index = f.unit_index AND ev.kind <> 'cancel_reverted'
        AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = ev.id)), 0)::integer,
    EXISTS (SELECT 1 FROM private.accounting_shipped_units(f.order_item_id, NULL) AS x WHERE x.unit_index = f.unit_index)
  FROM private.order_unit_plan_lines(_plan) AS f
  LEFT JOIN public.order_unit_slots AS s ON s.order_item_id = f.order_item_id AND s.unit_index = f.unit_index
  LEFT JOIN public.order_line_unit_amounts AS u ON u.order_item_id = f.order_item_id AND u.unit_index = f.unit_index
$$;

-- Check the plan against the database and record it. The caller holds the G lock (and every related order, through
-- lock_group_g_inventory). Writes the event, its lines, its holds and the slot states and prices; never writes plan.releases.
CREATE FUNCTION private.order_unit_apply_plan(_plan jsonb, _request_key uuid, _return_id uuid, _receipt_id uuid, _actor_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_key text; v_order_id uuid; v_kind text; v_prev integer; v_max_before integer; v_gross integer; v_shop integer; v_fee integer;
  v_hold_total integer; v_ent integer; v_std integer; v_now integer; v_consult integer;
  v_tot record; v_paid integer; v_sum_alloc bigint; v_sum_corr bigint; v_kept_after bigint; v_plan_holds bigint;
  v_related uuid[]; v_event_id uuid; v_n integer;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  -- (1) the shape of the plan
  BEGIN
    IF _plan IS NULL OR pg_catalog.jsonb_typeof(_plan) <> 'object' OR pg_catalog.jsonb_typeof(_plan -> 'lines') IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_typeof(_plan -> 'holds') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_typeof(_plan -> 'version') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(_plan -> 'orderId') IS DISTINCT FROM 'string'
      OR _plan ->> 'kind' IS NULL OR _plan ->> 'kind' NOT IN ('return_receive', 'pre_shipment_cancel', 'hold_release') THEN
      RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_1';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['entitlementPrevious', 'entitlementMaxBefore', 'entitlementGross', 'entitlementShopOnly', 'feeAmount',
      'holdTotal', 'entitlement', 'standardRefund', 'nowRefund', 'consultRefund'] LOOP
      IF pg_catalog.jsonb_typeof(_plan -> v_key) IS DISTINCT FROM 'number' OR (_plan ->> v_key) !~ '^-?[0-9]{1,9}$' THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_1';
      END IF;
    END LOOP;
    v_order_id := (_plan ->> 'orderId')::uuid;
    v_kind := _plan ->> 'kind';
    v_prev := (_plan ->> 'entitlementPrevious')::integer; v_max_before := (_plan ->> 'entitlementMaxBefore')::integer;
    v_gross := (_plan ->> 'entitlementGross')::integer; v_shop := (_plan ->> 'entitlementShopOnly')::integer;
    v_fee := (_plan ->> 'feeAmount')::integer; v_hold_total := (_plan ->> 'holdTotal')::integer; v_ent := (_plan ->> 'entitlement')::integer;
    v_std := (_plan ->> 'standardRefund')::integer; v_now := (_plan ->> 'nowRefund')::integer; v_consult := (_plan ->> 'consultRefund')::integer;
    SELECT pg_catalog.count(*) INTO v_n FROM private.order_unit_plan_lines(_plan);
    IF EXISTS (SELECT 1 FROM private.order_unit_plan_lines(_plan) AS l WHERE l.line_kind IS NULL OR l.line_kind NOT IN ('returned', 'kept', 'hold')
      OR l.order_item_id IS NULL OR l.unit_index IS NULL OR l.slot_order_id IS NULL OR l.holder_order_item_id IS NULL OR l.holder_unit_index IS NULL
      OR l.state_before IS NULL OR l.state_after IS NULL OR l.price_before IS NULL OR l.price_after IS NULL OR l.allocation IS NULL
      OR l.correction IS NULL OR l.shipped IS NULL OR l.part NOT IN ('now', 'consult'))
      OR EXISTS (SELECT 1 FROM private.order_unit_plan_holds(_plan) AS h
        WHERE h.held_order_id IS NULL OR h.later_order_id IS NULL OR h.item_id IS NULL OR h.amount IS NULL) THEN
      RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_1';
    END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datatype_mismatch OR invalid_parameter_value THEN
    IF SQLSTATE = '22023' AND SQLERRM = 'UNIT_PRICING_INVALID' THEN RAISE; END IF;
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_1';
  END;
  IF NOT EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = v_order_id) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_1';
  END IF;
  -- (2) the plan was made from the state the database has now
  IF _plan ->> 'version' IS DISTINCT FROM private.order_unit_version(v_order_id) THEN
    RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE = '40001';
  END IF;
  v_related := private.order_unit_related_orders(v_order_id);
  -- (3) every line names a slot. A returned or kept line is on this order's slot with the state, price, holder and shipped mark the plan was
  -- made from. A hold line is on the slot of a related order and only records that slot (a plan applied one event earlier, such as
  -- the return that released the hold, may have moved the later order's slot since the plan was made).
  -- A slot whose holder moved since the plan was made (an exchange-only receipt writes no event, so the version does not move) is a stale plan.
  IF EXISTS (SELECT 1 FROM private.order_unit_plan_line_facts(_plan) AS f
      WHERE f.line_kind <> 'hold' AND f.s_order_id = f.slot_order_id AND f.slot_order_id = v_order_id
        AND (f.holder_order_item_id <> f.s_holder_item OR f.holder_unit_index <> f.s_holder_index)) THEN
    RAISE EXCEPTION 'UNIT_PRICING_STALE' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (SELECT 1 FROM private.order_unit_plan_line_facts(_plan) AS f
      WHERE f.s_order_id IS NULL OR f.s_order_id <> f.slot_order_id
        OR (f.line_kind <> 'hold' AND (f.slot_order_id <> v_order_id OR f.state_before <> f.s_state OR f.price_before <> f.s_price
          OR f.holder_order_item_id <> f.s_holder_item OR f.holder_unit_index <> f.s_holder_index OR f.shipped <> f.s_shipped))
        OR (f.line_kind = 'hold' AND NOT (f.slot_order_id = ANY (v_related))))
    OR EXISTS (SELECT 1 FROM private.order_unit_plan_lines(_plan) AS l WHERE l.line_kind <> 'hold'
      GROUP BY l.order_item_id, l.unit_index HAVING pg_catalog.count(*) > 1) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_3';
  END IF;
  -- (4) a state moves kept -> returned_*; a kept line and a hold line keep the state (a hold line also the price)
  IF EXISTS (SELECT 1 FROM private.order_unit_plan_lines(_plan) AS f WHERE CASE f.line_kind
      WHEN 'returned' THEN NOT (f.state_before = 'kept' AND f.state_after IN ('returned_customer', 'returned_shop')) OR v_kind = 'hold_release'
        OR (v_kind = 'pre_shipment_cancel' AND (f.state_after <> 'returned_shop' OR (f.shipped AND f.holder_order_item_id = f.order_item_id)))
        OR (v_kind = 'return_receive' AND NOT f.shipped)
      WHEN 'kept' THEN NOT (f.state_before = 'kept' AND f.state_after = 'kept') OR v_kind = 'hold_release'
      ELSE NOT (f.state_before = f.state_after AND f.price_before = f.price_after) END) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_4';
  END IF;
  -- (5) allocations: not negative, none on kept and hold lines, the sum per slot within what was paid
  IF EXISTS (SELECT 1 FROM private.order_unit_plan_line_facts(_plan) AS f
      WHERE f.allocation < 0 OR (f.line_kind <> 'returned' AND f.allocation <> 0) OR f.price_after < 0
        OR (f.line_kind = 'returned' AND (f.s_allocated + f.allocation > f.s_paid
          OR f.allocation <> GREATEST(0, LEAST(f.price_before, f.s_paid - f.s_allocated)) OR f.price_after <> f.allocation))) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_5';
  END IF;
  -- (6) the identity: sum(allocation) - sum(correction) - fee = E - previous E; a returned or kept line corrects its slot price by the difference
  SELECT COALESCE(pg_catalog.sum(l.allocation), 0), COALESCE(pg_catalog.sum(l.correction), 0) INTO v_sum_alloc, v_sum_corr
    FROM private.order_unit_plan_lines(_plan) AS l;
  IF v_sum_alloc - v_sum_corr - v_fee <> v_ent - v_prev
    OR EXISTS (SELECT 1 FROM private.order_unit_plan_lines(_plan) AS l WHERE l.line_kind <> 'hold' AND l.correction <> l.price_after - l.price_before) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_6';
  END IF;
  -- (7) previous E and the largest E before are the database's; the refund is the rise over the largest E (not below 0)
  SELECT * INTO v_tot FROM private.order_unit_totals(v_order_id);
  IF v_prev <> v_tot.entitlement_previous OR v_max_before <> v_tot.entitlement_max OR v_std <> GREATEST(v_ent - v_max_before, 0)
    OR v_now < 0 OR v_now > v_std OR v_consult <> v_std - v_now THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_7';
  END IF;
  -- (8) E within what was paid; no negative hold total or fee
  SELECT COALESCE(pg_catalog.sum(u.paid_amount), 0)::integer INTO v_paid FROM public.order_line_unit_amounts AS u WHERE u.order_id = v_order_id;
  IF v_ent > v_paid OR v_hold_total < 0 OR v_fee < 0 THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_8';
  END IF;
  -- (9) holds: every row is held on this order, a release does not exceed what is held, the total and the hold lines agree
  SELECT COALESCE(pg_catalog.sum(h.amount), 0) INTO v_plan_holds FROM private.order_unit_plan_holds(_plan) AS h;
  IF EXISTS (SELECT 1 FROM private.order_unit_plan_holds(_plan) AS h
      WHERE h.held_order_id <> v_order_id OR h.amount = 0 OR h.later_order_id = v_order_id OR NOT (h.later_order_id = ANY (v_related)))
    OR EXISTS (SELECT 1 FROM (SELECT h.later_order_id, h.item_id, pg_catalog.sum(h.amount) FILTER (WHERE h.amount < 0) AS released
        FROM private.order_unit_plan_holds(_plan) AS h GROUP BY h.later_order_id, h.item_id) AS p
      WHERE p.released < 0 AND p.released + COALESCE((SELECT pg_catalog.sum(x.amount) FROM public.order_unit_holds AS x
        WHERE x.held_order_id = v_order_id AND x.later_order_id = p.later_order_id AND x.item_id = p.item_id), 0) < 0)
    OR v_hold_total <> v_tot.held_total + v_plan_holds
    OR EXISTS (SELECT 1 FROM (
        SELECT f.slot_order_id AS later_order_id, f.s_item_id AS item_id, pg_catalog.sum(f.correction) AS amount
        FROM private.order_unit_plan_line_facts(_plan) AS f WHERE f.line_kind = 'hold' GROUP BY f.slot_order_id, f.s_item_id) AS a
      FULL JOIN (SELECT h.later_order_id, h.item_id, pg_catalog.sum(h.amount) AS amount
        FROM private.order_unit_plan_holds(_plan) AS h GROUP BY h.later_order_id, h.item_id) AS b
        ON b.later_order_id = a.later_order_id AND b.item_id = a.item_id
      WHERE COALESCE(a.amount, 0) <> COALESCE(b.amount, 0)) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_9';
  END IF;
  -- (6, continued) E = paid - the slots kept after the event - holds - fees. The database's own values close the identity.
  SELECT COALESCE(pg_catalog.sum(CASE WHEN COALESCE(f.state_after, s.state) = 'kept' THEN COALESCE(f.price_after, s.current_price) ELSE 0 END), 0)
    INTO v_kept_after
  FROM public.order_unit_slots AS s
  LEFT JOIN private.order_unit_plan_lines(_plan) AS f ON f.line_kind <> 'hold' AND f.order_item_id = s.order_item_id AND f.unit_index = s.unit_index
  WHERE s.order_id = v_order_id;
  IF v_ent <> v_paid - v_kept_after - v_hold_total - v_tot.fee_total - v_fee OR v_gross <> v_paid - v_kept_after - v_hold_total THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_plan_6';
  END IF;
  -- record
  INSERT INTO public.order_unit_events(order_id, kind, request_key, return_id, receipt_id, entitlement_previous, entitlement_max_before,
    entitlement_gross, entitlement_shop_only, fee_amount, hold_total, entitlement, standard_refund, now_refund, consult_refund, actor_id)
  VALUES (v_order_id, v_kind, _request_key, _return_id, _receipt_id, v_prev, v_max_before, v_gross, v_shop, v_fee, v_hold_total, v_ent,
    v_std, v_now, v_consult, _actor_id)
  RETURNING id INTO v_event_id;
  INSERT INTO public.order_unit_event_lines(event_id, line_kind, order_item_id, unit_index, slot_order_id, holder_order_item_id,
    holder_unit_index, state_before, state_after, price_before, price_after, allocation, correction, part, return_line_id, shipped)
  SELECT v_event_id, f.line_kind, f.order_item_id, f.unit_index, f.slot_order_id, f.holder_order_item_id, f.holder_unit_index,
    f.state_before, f.state_after, f.price_before, f.price_after, f.allocation, f.correction, f.part, f.return_line_id, f.s_shipped
  FROM private.order_unit_plan_line_facts(_plan) AS f;
  INSERT INTO public.order_unit_holds(event_id, held_order_id, later_order_id, item_id, amount)
  SELECT v_event_id, h.held_order_id, h.later_order_id, h.item_id, h.amount FROM private.order_unit_plan_holds(_plan) AS h;
  UPDATE public.order_unit_slots AS s SET state = f.state_after, current_price = f.price_after, last_event_id = v_event_id
  FROM private.order_unit_plan_lines(_plan) AS f
  WHERE f.line_kind <> 'hold' AND s.order_item_id = f.order_item_id AND s.unit_index = f.unit_index;
  RETURN v_event_id;
END;
$$;

-- Overload of the H5 function: the units are named by their unit_index, and the claim sets refund_id, refund_before_shipment and
-- return_line_id at once. A unit that this refund already holds is left as it is. Returns the sum of the paid amounts of the named units.
CREATE FUNCTION private.group_h_claim_refund_units(_refund_id uuid, _order_item_id uuid, _unit_indexes integer[],
  _before_shipment boolean, _return_line_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund public.order_refunds; v_n integer; v_amount bigint; v_bad integer;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  SELECT r.* INTO v_refund FROM public.order_refunds AS r JOIN public.order_items AS oi ON oi.order_id = r.order_id
    WHERE r.id = _refund_id AND oi.id = _order_item_id;
  IF NOT FOUND OR _unit_indexes IS NULL OR pg_catalog.cardinality(_unit_indexes) = 0 OR pg_catalog.array_position(_unit_indexes, NULL) IS NOT NULL
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(_unit_indexes) AS t(x)) <> pg_catalog.cardinality(_unit_indexes)
    OR _before_shipment IS NULL OR v_refund.status NOT IN ('awaiting_response', 'pending', 'succeeded')
    OR (_return_line_id IS NOT NULL AND (_before_shipment OR NOT EXISTS (
      SELECT 1 FROM public.order_return_lines AS l WHERE l.id = _return_line_id AND l.return_id = v_refund.return_id AND l.order_item_id = _order_item_id))) THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  SELECT pg_catalog.count(*)::integer, COALESCE(pg_catalog.sum(c.paid_amount), 0),
    pg_catalog.count(*) FILTER (WHERE c.refund_id IS NOT NULL AND (c.refund_id <> _refund_id OR c.refund_before_shipment <> _before_shipment))::integer
  INTO v_n, v_amount, v_bad
  FROM (SELECT u.paid_amount, u.refund_id, u.refund_before_shipment FROM public.order_line_unit_amounts AS u
    WHERE u.order_item_id = _order_item_id AND u.unit_index = ANY (_unit_indexes) FOR UPDATE) AS c;
  IF v_n <> pg_catalog.cardinality(_unit_indexes) OR v_bad > 0 THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  UPDATE public.order_line_unit_amounts AS u SET refund_id = _refund_id, refund_before_shipment = _before_shipment, return_line_id = _return_line_id
  WHERE u.order_item_id = _order_item_id AND u.unit_index = ANY (_unit_indexes) AND u.refund_id IS NULL;
  RETURN v_amount::integer;
END;
$$;

-- Overload of the H5 function: only the return line claim of the named units is cleared (a refund claim stays).
CREATE FUNCTION private.group_h_release_return_units(_order_item_id uuid, _unit_indexes integer[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  IF _unit_indexes IS NULL OR pg_catalog.array_position(_unit_indexes, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  UPDATE public.order_line_unit_amounts AS u SET return_line_id = NULL
  WHERE u.order_item_id = _order_item_id AND u.unit_index = ANY (_unit_indexes) AND u.return_line_id IS NOT NULL;
END;
$$;

-- Tie a refund to an event and put the refund claim on the units the event returned for this part ('now' or 'consult'; a line without
-- a part, as a pre-shipment cancel writes, belongs to 'now'; 'release' has no units). A return line claim stays only when the refund is
-- a refund of the same return for the same item (a return of an exchange item, or a refund of another return, drops the claim of the
-- original unit first: guard rules e and f of order_line_unit_amounts).
CREATE FUNCTION private.order_unit_link_refund(_event_id uuid, _refund_id uuid, _part text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event public.order_unit_events; v_refund public.order_refunds; v_existing text; v_found boolean; v_g record;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  SELECT e.* INTO v_event FROM public.order_unit_events AS e WHERE e.id = _event_id;
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF v_event.id IS NULL OR v_refund.id IS NULL OR v_refund.order_id <> v_event.order_id OR _part IS NULL OR _part NOT IN ('now', 'consult', 'release') THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_link_1';
  END IF;
  SELECT er.part INTO v_existing FROM public.order_unit_event_refunds AS er WHERE er.event_id = _event_id AND er.refund_id = _refund_id;
  v_found := FOUND;
  IF v_found AND v_existing <> _part THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_link_2';
  END IF;
  IF NOT v_found THEN
    INSERT INTO public.order_unit_event_refunds(event_id, refund_id, part) VALUES (_event_id, _refund_id, _part);
  END IF;
  IF _part = 'release' THEN RETURN; END IF;
  FOR v_g IN
    SELECT l.order_item_id, NOT l.shipped AS before_shipment,
      CASE WHEN l.return_line_id IS NOT NULL AND l.shipped AND EXISTS (SELECT 1 FROM public.order_return_lines AS rl
        WHERE rl.id = l.return_line_id AND rl.order_item_id = l.order_item_id AND rl.return_id = v_refund.return_id) THEN l.return_line_id END AS rl_id,
      pg_catalog.array_agg(l.unit_index ORDER BY l.unit_index) AS idx
    FROM public.order_unit_event_lines AS l
    WHERE l.event_id = _event_id AND l.line_kind = 'returned' AND COALESCE(l.part, 'now') = _part
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  LOOP
    IF v_g.rl_id IS NULL THEN PERFORM private.group_h_release_return_units(v_g.order_item_id, v_g.idx); END IF;
    PERFORM private.group_h_claim_refund_units(_refund_id, v_g.order_item_id, v_g.idx, v_g.before_shipment, v_g.rl_id);
  END LOOP;
END;
$$;

-- What the consult part of a return's events owes in goods and what the consult refunds tied to them already cover (awaiting_response,
-- pending, succeeded, error). The now part is settled by the receive (a manager may lower it; that never comes back as an outstanding
-- amount, 2-1). The shipping part of a refund is not E, so it is not counted. Not below 0.
CREATE FUNCTION private.order_unit_outstanding(_return_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT GREATEST(
    COALESCE((SELECT pg_catalog.sum(e.consult_refund) FROM public.order_unit_events AS e WHERE e.return_id = _return_id
      AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = e.id)), 0)
    - COALESCE((SELECT pg_catalog.sum(rf.amount - rf.shipping_amount) FROM public.order_refunds AS rf
      WHERE rf.status IN ('awaiting_response', 'pending', 'succeeded', 'error')
        AND rf.id IN (SELECT er.refund_id FROM public.order_unit_event_refunds AS er
          JOIN public.order_unit_events AS e ON e.id = er.event_id WHERE e.return_id = _return_id AND er.part = 'consult')), 0),
    0)::integer
$$;
-- UBC_FUNCTIONS_END

-- UBC_ACL_BEGIN
ALTER FUNCTION private.order_unit_slot_guard() OWNER TO postgres;
ALTER FUNCTION private.order_unit_related_orders(uuid) OWNER TO postgres;
ALTER FUNCTION private.order_unit_version(uuid) OWNER TO postgres;
ALTER FUNCTION private.order_unit_totals(uuid) OWNER TO postgres;
ALTER FUNCTION private.order_unit_order_state(uuid) OWNER TO postgres;
ALTER FUNCTION private.order_unit_pricing_materials(uuid) OWNER TO postgres;
ALTER FUNCTION public.order_unit_pricing_materials(uuid) OWNER TO postgres;
ALTER FUNCTION private.order_unit_plan_lines(jsonb) OWNER TO postgres;
ALTER FUNCTION private.order_unit_plan_holds(jsonb) OWNER TO postgres;
ALTER FUNCTION private.order_unit_plan_line_facts(jsonb) OWNER TO postgres;
ALTER FUNCTION private.order_unit_apply_plan(jsonb, uuid, uuid, uuid, uuid) OWNER TO postgres;
ALTER FUNCTION private.group_h_claim_refund_units(uuid, uuid, integer[], boolean, uuid) OWNER TO postgres;
ALTER FUNCTION private.group_h_release_return_units(uuid, integer[]) OWNER TO postgres;
ALTER FUNCTION private.order_unit_link_refund(uuid, uuid, text) OWNER TO postgres;
ALTER FUNCTION private.order_unit_outstanding(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION private.order_unit_slot_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_related_orders(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_version(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_totals(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_order_state(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_pricing_materials(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.order_unit_pricing_materials(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_plan_lines(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_plan_holds(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_plan_line_facts(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_apply_plan(jsonb, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.group_h_claim_refund_units(uuid, uuid, integer[], boolean, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.group_h_release_return_units(uuid, integer[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_link_refund(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.order_unit_outstanding(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.order_unit_pricing_materials(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_unit_pricing_materials(uuid) TO service_role;
-- UBC_ACL_END

-- UBC_FINAL_ASSERT_BEGIN
DO $ubc_final$
DECLARE
  e record; p record; v_oid oid; v_detail text;
BEGIN
  -- ubc_schema: no amount default, the slot guard is the one BEFORE UPDATE trigger of the slot table (this replaces the "no UPDATE
  -- trigger" expectation of migration A), both append-only triggers of the slot table stay.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attrdef AS d JOIN pg_catalog.pg_attribute AS a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = 'public.order_unit_events'::regclass AND a.attname = ANY (ARRAY['entitlement_previous', 'entitlement_max_before',
        'entitlement_gross', 'entitlement_shop_only', 'fee_amount', 'hold_total', 'entitlement', 'standard_refund', 'now_refund', 'consult_refund'])) <> 0
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = 'public.order_unit_events'::regclass AND a.attnotnull
      AND a.attname = ANY (ARRAY['entitlement_previous', 'entitlement_max_before', 'entitlement_gross', 'entitlement_shop_only', 'fee_amount',
        'hold_total', 'entitlement', 'standard_refund', 'now_refund', 'consult_refund'])) <> 10
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid = 'public.order_unit_slots'::regclass AND NOT g.tgisinternal) <> 3
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid = 'public.order_unit_slots'::regclass AND NOT g.tgisinternal
      AND g.tgfoid = 'private.group_h_immutable()'::regprocedure AND g.tgenabled = 'A' AND (g.tgtype & 16) = 0) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid = 'public.order_unit_slots'::regclass AND NOT g.tgisinternal
      AND g.tgname = 'ub_order_unit_slots_guard' AND g.tgfoid = 'private.order_unit_slot_guard()'::regprocedure AND g.tgenabled = 'A'
      AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 16) = 16 AND (g.tgtype & (4 | 8 | 32)) = 0) <> 1 THEN
    v_detail := 'ubc_schema';
  END IF;
  -- ubc_functions: owner, security, settings, volatility, result type and the exact body of every function of this file.
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private', 'order_unit_slot_guard()', 'trigger', 'v', true, '963c55ccbcb5af08f8a974acd4f082fe'),
      ('private', 'order_unit_related_orders(uuid)', 'uuid[]', 's', true, '4008d3582ba5b9a27d834f2dced4a581'),
      ('private', 'order_unit_version(uuid)', 'text', 's', true, 'a3cc30f7ba6329a8dfb6a772d5b662c1'),
      ('private', 'order_unit_totals(uuid)', 'record', 's', true, '4aaecb3c271c62f983ef1d03480f1a4a'),
      ('private', 'order_unit_order_state(uuid)', 'jsonb', 's', true, 'a626d03293f51dec76627275ab4f77f7'),
      ('private', 'order_unit_pricing_materials(uuid)', 'jsonb', 's', true, 'f878db0be13a6dcf17cab5e381458f65'),
      ('public', 'order_unit_pricing_materials(uuid)', 'jsonb', 's', false, 'ce0476c87fa38d6e984c9cbe4a045034'),
      ('private', 'order_unit_plan_lines(jsonb)', 'record', 's', false, 'dc5b50fea718dcbe9b6a66a9dec003e2'),
      ('private', 'order_unit_plan_holds(jsonb)', 'record', 's', false, '3e441b7352524983a7097a25df2e06b3'),
      ('private', 'order_unit_plan_line_facts(jsonb)', 'record', 's', false, '604261a576d579c2f6ae4b3dbd25b866'),
      ('private', 'order_unit_apply_plan(jsonb,uuid,uuid,uuid,uuid)', 'uuid', 'v', true, '8735f95cadb6c7c60e9f9f305ba64d3e'),
      ('private', 'group_h_claim_refund_units(uuid,uuid,integer[],boolean,uuid)', 'integer', 'v', true, '122b4819f9926b5e249861bb34f7ef90'),
      ('private', 'group_h_release_return_units(uuid,integer[])', 'void', 'v', true, '2321e7f708f89c92e8a19a32fe847836'),
      ('private', 'order_unit_link_refund(uuid,uuid,text)', 'void', 'v', true, '8b66fac61cc6a28bf9a4b2d634efb213'),
      ('private', 'order_unit_outstanding(uuid)', 'integer', 's', true, 'e88a1ca4dad572c67701331c1e9a1378')
    ) AS expected(schema_name, signature, result_type, volatility, definer, body_md5) LOOP
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF NOT FOUND OR p.proowner <> 'postgres'::regrole OR p.prosecdef <> e.definer OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
        OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.provolatile <> e.volatility::"char" OR p.prokind <> 'f'
        OR pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r', '')) <> e.body_md5
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
          WHERE n.nspname = e.schema_name AND f.proname = pg_catalog.split_part(pg_catalog.split_part(e.signature, '(', 1), '.', 1))
          <> (CASE WHEN e.signature LIKE 'group_h_claim_refund_units%' OR e.signature LIKE 'group_h_release_return_units%' THEN 2 ELSE 1 END) THEN
        v_detail := 'ubc_functions'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- ubc_acl: nobody but postgres runs a body; service_role runs the materials entry and its body only.
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.order_unit_slot_guard()', false), ('private.order_unit_related_orders(uuid)', false), ('private.order_unit_version(uuid)', false),
      ('private.order_unit_totals(uuid)', false), ('private.order_unit_order_state(uuid)', false),
      ('private.order_unit_pricing_materials(uuid)', true), ('public.order_unit_pricing_materials(uuid)', true),
      ('private.order_unit_plan_lines(jsonb)', false), ('private.order_unit_plan_holds(jsonb)', false),
      ('private.order_unit_plan_line_facts(jsonb)', false), ('private.order_unit_apply_plan(jsonb,uuid,uuid,uuid,uuid)', false),
      ('private.group_h_claim_refund_units(uuid,uuid,integer[],boolean,uuid)', false),
      ('private.group_h_release_return_units(uuid,integer[])', false), ('private.order_unit_link_refund(uuid,uuid,text)', false),
      ('private.order_unit_outstanding(uuid)', false)
    ) AS expected(signature, service) LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') <> e.service
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
        v_detail := 'ubc_acl'; EXIT;
      END IF;
    END LOOP;
  END IF;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'UNIT_BINDING_CORE_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = v_detail;
  END IF;
END;
$ubc_final$;
-- UBC_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
