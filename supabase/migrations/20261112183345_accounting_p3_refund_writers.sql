BEGIN;
-- Accounting plan 3 S17 (FREQ-576 AC-01/AC-02/AC-05, FREQ-577 AC-03/AC-04/AC-06/AC-08/AC-10, FREQ-579 AC-03/AC-07,
-- FREQ-580 AC-01/AC-03, FREQ-563 AC-02): the refund writers keep the accounting facts of a refund.
--
-- Rebuilt (CREATE OR REPLACE; the latest definition copied as it is, new text between ACC_P3_BEGIN and ACC_P3_END, replaced
-- text between ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END; arguments, result, attributes, owner and
-- ACL unchanged; the group G writer list is not touched):
--   private.begin_order_refund_core (X4)    dispute hold stop; requested state, facts, allocations
--   private.record_group_g_refund_result (C) accepted / succeeded / failed / canceled states
--   private.mark_order_refund_error (H)     error state
--   private.record_external_order_refund (H) requested state, facts, allocations; pre-shipment units claimed by index (P3-C7)
--   private.accounting_check_unit_allocation_sum (S6)  0 <= allocations <= paid + price adjusts; also on the adjust table
--   private.accounting_g_fact_seq_at (S6)   also the two adjust tables
--   private.accounting_shipped_units (S6)   ruling P3-6 / P3-C1: held units last, never by amount
--   private.accounting_unit_values (S6)     value = paid + price adjusts - allocations
--   private.accounting_shipment_plan (S8)   unit amount adds the price adjusts before the confirm number
--   private.order_unit_shipped_slots (A)    calls accounting_shipped_units (M7)
-- New tools (private, SECURITY DEFINER, no EXECUTE for anyone; the writers need the group G lock):
--   accounting_record_refund_event, accounting_split_refund, accounting_record_refund_facts,
--   accounting_record_event_allocations, accounting_write_refund_allocations, accounting_release_allocations.
-- New writer for service_role (private body + public entry): admin_decide_refund_cancellation.
-- New constraint trigger accounting_unit_price_adjusts_sum on public.accounting_unit_price_adjusts.
--
-- ROLLBACK (only while the S15 tables hold no row written by these functions):
--   DROP TRIGGER accounting_unit_price_adjusts_sum ON public.accounting_unit_price_adjusts;
--   DROP FUNCTION public.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid) and the private functions of this file;
--   re-run CREATE OR REPLACE of the ten rebuilt functions from their latest definitions (X4 20261112064013 for the core,
--   C 20261110120611 for record_group_g_refund_result, H 20261029130400 for record_external_order_refund and
--   mark_order_refund_error, S6 20261108150000 for the four tools, S8 20261108170000 for accounting_shipment_plan, A
--   20261110090325 for order_unit_shipped_slots).

-- ACC_S17_BODY_BEGIN

CREATE TEMP TABLE accounting_s17_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s17_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist_md5', (SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(w.proc::oid::text, ',' ORDER BY w.proc::oid), ''))
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', (SELECT pg_catalog.jsonb_build_object(
    'allocations', (SELECT pg_catalog.count(*) FROM public.accounting_unit_refund_allocations),
    'price_adjusts', (SELECT pg_catalog.count(*) FROM public.accounting_unit_price_adjusts),
    'transfer_adjusts', (SELECT pg_catalog.count(*) FROM public.accounting_refund_transfer_adjusts),
    'refund_events', (SELECT pg_catalog.count(*) FROM public.accounting_refund_events),
    'refund_facts', (SELECT pg_catalog.count(*) FROM public.accounting_refund_facts),
    'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events))),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(f.oid::regprocedure::text, pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::regtype::text, pg_catalog.pg_get_function_arguments(f.oid), pg_catalog.pg_get_function_result(f.oid),
      f.prolang, f.provolatile, f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))
    FROM pg_catalog.pg_proc AS f
    WHERE f.oid IN (
      'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)'::regprocedure,
      'private.record_group_g_refund_result(uuid,text,text,text,text,timestamp with time zone,text,text,text,text,uuid[],jsonb)'::regprocedure,
      'private.mark_order_refund_error(uuid,text,boolean)'::regprocedure,
      'private.record_external_order_refund(uuid,text,integer,text,text,text,timestamp with time zone,text,text,text,text,timestamp with time zone)'::regprocedure,
      'private.accounting_check_unit_allocation_sum()'::regprocedure,
      'private.accounting_g_fact_seq_at(timestamp with time zone)'::regprocedure,
      'private.accounting_shipped_units(uuid,bigint)'::regprocedure,
      'private.accounting_unit_values(uuid,bigint)'::regprocedure,
      'private.accounting_shipment_plan(uuid,bigint)'::regprocedure,
      'private.order_unit_shipped_slots(uuid)'::regprocedure)));

CREATE OR REPLACE FUNCTION private.accounting_check_unit_allocation_sum() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_paid integer;
  v_total bigint;
-- ACC_P3_BEGIN
  v_adjust bigint;
-- ACC_P3_END
BEGIN
  SELECT u.paid_amount INTO v_paid FROM public.order_line_unit_amounts AS u
  WHERE u.order_item_id = NEW.order_item_id AND u.unit_index = NEW.unit_index;
  SELECT COALESCE(pg_catalog.sum(a.amount), 0) INTO v_total FROM public.accounting_unit_refund_allocations AS a
  WHERE a.order_item_id = NEW.order_item_id AND a.unit_index = NEW.unit_index;
-- ACC_P3_BEGIN
  SELECT COALESCE(pg_catalog.sum(p.amount), 0) INTO v_adjust FROM public.accounting_unit_price_adjusts AS p
  WHERE p.order_item_id = NEW.order_item_id AND p.unit_index = NEW.unit_index;
-- ACC_P3_END
-- ACC_P3_REPLACE_BEGIN 64894eb91bae4b340a81007fd046adc8
  IF v_paid IS NULL OR v_total < 0 OR v_total > v_paid + v_adjust THEN
-- ACC_P3_REPLACE_END
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023', DETAIL = 'unit_allocation_sum';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.accounting_g_fact_seq_at(_at timestamptz) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.max(m.fact_seq), 0) FROM (
    SELECT f.fact_seq FROM public.accounting_g_slip_facts AS f WHERE f.locked_at <= _at
    UNION ALL
    SELECT a.fact_seq FROM public.accounting_unit_refund_allocations AS a WHERE a.locked_at <= _at
-- ACC_P3_BEGIN
    UNION ALL
    SELECT t.fact_seq FROM public.accounting_refund_transfer_adjusts AS t WHERE t.locked_at <= _at
    UNION ALL
    SELECT p.fact_seq FROM public.accounting_unit_price_adjusts AS p WHERE p.locked_at <= _at
-- ACC_P3_END
  ) AS m
$$;

CREATE OR REPLACE FUNCTION private.accounting_shipped_units(_order_item_id uuid, _as_of_seq bigint)
RETURNS TABLE(unit_index integer, slip_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_slip record;
-- ACC_P3_REPLACE_BEGIN 41cae524b90d89ab01bf10f3b609fb26
  v_order integer[];
  v_pos integer := 0;
-- ACC_P3_REPLACE_END
  v_taken integer[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_items AS oi WHERE oi.id = _order_item_id AND oi.line_kind = 'order') THEN
    RETURN;
  END IF;
-- ACC_P3_BEGIN
  -- Ruling P3-6 / P3-C1: units not held by a pre-shipment refund first, lowest unit_index first; then the held units.
  -- Never decided by amounts. The alive slips (confirm order) take the units in this order, quantity by quantity.
  v_order := ARRAY(
    SELECT u.unit_index FROM public.order_line_unit_amounts AS u
    WHERE u.order_item_id = _order_item_id
    ORDER BY
      (EXISTS (SELECT 1 FROM public.order_refunds AS r WHERE r.id = u.refund_id AND u.refund_before_shipment AND r.status <> 'failed')
        OR EXISTS (SELECT 1 FROM public.order_unit_slots AS s
          CROSS JOIN LATERAL (SELECT ev.kind, el.shipped FROM public.order_unit_event_lines AS el JOIN public.order_unit_events AS ev ON ev.id = el.event_id
            WHERE el.order_item_id = s.order_item_id AND el.unit_index = s.unit_index AND el.line_kind = 'returned' AND el.state_after = s.state
              AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = ev.id)
            ORDER BY ev.seq DESC LIMIT 1) AS last
          WHERE s.order_item_id = u.order_item_id AND s.unit_index = u.unit_index
            AND last.kind = 'pre_shipment_cancel' AND NOT last.shipped)),
      u.unit_index);
-- ACC_P3_END
  FOR v_slip IN
    SELECT f.slip_id AS slip_id, f.fact_seq AS confirm_seq, x.fact_seq AS cancel_seq, l.quantity AS quantity
    FROM public.accounting_g_slip_facts AS f
    JOIN public.shipment_slip_lines AS l ON l.slip_id = f.slip_id AND l.order_item_id = _order_item_id
    LEFT JOIN public.accounting_g_slip_facts AS x ON x.slip_id = f.slip_id AND x.kind = 'cancel'
    WHERE f.kind = 'confirm' AND (_as_of_seq IS NULL OR f.fact_seq <= _as_of_seq)
    ORDER BY f.fact_seq
  LOOP
-- ACC_P3_REPLACE_BEGIN 01a5909508da309ef0a08ec17b27d04f
    IF v_slip.cancel_seq IS NULL OR (_as_of_seq IS NOT NULL AND v_slip.cancel_seq > _as_of_seq) THEN
      v_taken := COALESCE(v_order[v_pos + 1 : v_pos + v_slip.quantity], ARRAY[]::integer[]);
      v_pos := v_pos + v_slip.quantity;
-- ACC_P3_REPLACE_END
      RETURN QUERY SELECT t.unit, v_slip.slip_id FROM pg_catalog.unnest(v_taken) AS t(unit);
    END IF;
  END LOOP;
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION private.accounting_unit_values(_order_id uuid, _as_of_seq bigint)
RETURNS TABLE(order_item_id uuid, unit_index integer, shipped boolean, value integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT u.order_item_id, u.unit_index, (u.unit_index = ANY (s.units)) AS shipped,
-- ACC_P3_REPLACE_BEGIN 9fe7573e0b35dbdf940aeee14e99563e
    (u.paid_amount
      + COALESCE((SELECT pg_catalog.sum(p.amount) FROM public.accounting_unit_price_adjusts AS p
        WHERE p.order_item_id = u.order_item_id AND p.unit_index = u.unit_index
          AND (_as_of_seq IS NULL OR p.fact_seq <= _as_of_seq)), 0)
      - COALESCE((SELECT pg_catalog.sum(a.amount) FROM public.accounting_unit_refund_allocations AS a
-- ACC_P3_REPLACE_END
      WHERE a.order_item_id = u.order_item_id AND a.unit_index = u.unit_index
        AND (_as_of_seq IS NULL OR a.fact_seq <= _as_of_seq)), 0))::integer AS value
  FROM public.order_items AS oi
  CROSS JOIN LATERAL (
    SELECT COALESCE(pg_catalog.array_agg(su.unit_index), ARRAY[]::integer[]) AS units
    FROM private.accounting_shipped_units(oi.id, _as_of_seq) AS su
  ) AS s
  JOIN public.order_line_unit_amounts AS u ON u.order_item_id = oi.id
  WHERE oi.order_id = _order_id AND oi.line_kind = 'order'
  ORDER BY u.order_item_id, u.unit_index
$$;

CREATE OR REPLACE FUNCTION private.accounting_shipment_plan(_slip_id uuid, _confirm_seq bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_orders uuid[];
  v_order_count integer;
  v_item record;
  v_unit record;
  v_order record;
  v_taken integer[];
  v_item_amount bigint;
  v_balance bigint;
  v_shortage bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_units jsonb := '[]'::jsonb;
  v_lines jsonb;
BEGIN
  IF _slip_id IS NULL OR _confirm_seq IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT sf.order_id ORDER BY sf.order_id) INTO v_orders
  FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = _slip_id;
  v_orders := COALESCE(v_orders, ARRAY[]::uuid[]);
  v_order_count := 0;

  -- Every order of the slip needs a payment entry that is not reversed. The state and the payment time of the order
  -- are not looked at: the books decide.
  -- order_count is the number of orders of the slip that have none.
  SELECT pg_catalog.count(*) INTO v_order_count FROM pg_catalog.unnest(v_orders) AS o(id) WHERE NOT EXISTS (
    SELECT 1 FROM public.accounting_journal_lines AS l
    JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
    WHERE l.order_id = o.id AND l.account_code = '2150' AND e.event_kind = 'payment_confirmed'
      AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id));
  IF v_order_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'payment_journal_missing',
      'detail', pg_catalog.jsonb_build_object('order_count', v_order_count), 'order_ids', pg_catalog.to_jsonb(v_orders));
  END IF;

  -- The slip's own lines are the truth; the lines of the (not cancelled) shipments must say the same per item.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT l.order_item_id, pg_catalog.sum(l.quantity)::bigint AS quantity FROM public.shipment_slip_lines AS l
      WHERE l.slip_id = _slip_id GROUP BY l.order_item_id) AS a
    FULL JOIN (
      SELECT fl.order_item_id, pg_catalog.sum(fl.quantity)::bigint AS quantity
      FROM public.shipment_slip_fulfillments AS sf
      JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id AND f.cancelled_at IS NULL
      JOIN public.order_fulfillment_lines AS fl ON fl.fulfillment_id = f.id
      WHERE sf.slip_id = _slip_id GROUP BY fl.order_item_id) AS b ON b.order_item_id = a.order_item_id
    WHERE a.quantity IS DISTINCT FROM b.quantity) THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'shipment_lines_mismatch', 'detail', '{}'::jsonb,
      'order_ids', pg_catalog.to_jsonb(v_orders));
  END IF;

  FOR v_item IN
    SELECT l.order_item_id, l.quantity, oi.order_id, oi.item_name, oi.line_kind
    FROM public.shipment_slip_lines AS l JOIN public.order_items AS oi ON oi.id = l.order_item_id
    WHERE l.slip_id = _slip_id ORDER BY oi.order_id, l.order_item_id
  LOOP
    CONTINUE WHEN v_item.line_kind <> 'order';
    v_taken := ARRAY(SELECT su.unit_index FROM private.accounting_shipped_units(v_item.order_item_id, _confirm_seq) AS su
      WHERE su.slip_id = _slip_id ORDER BY su.unit_index);
    IF COALESCE(pg_catalog.cardinality(v_taken), 0) <> v_item.quantity THEN
      RETURN pg_catalog.jsonb_build_object('reason', 'units_insufficient', 'detail', '{}'::jsonb,
        'order_ids', pg_catalog.to_jsonb(v_orders));
    END IF;
    v_item_amount := 0;
    FOR v_unit IN
      SELECT u.unit_index, u.paid_amount,
        COALESCE((SELECT pg_catalog.sum(a.amount) FROM public.accounting_unit_refund_allocations AS a
          WHERE a.order_item_id = u.order_item_id AND a.unit_index = u.unit_index AND a.fact_seq < _confirm_seq), 0)::integer AS refunded
-- ACC_P3_BEGIN
        , COALESCE((SELECT pg_catalog.sum(p.amount) FROM public.accounting_unit_price_adjusts AS p
          WHERE p.order_item_id = u.order_item_id AND p.unit_index = u.unit_index AND p.fact_seq < _confirm_seq), 0)::integer AS adjusted
-- ACC_P3_END
      FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id = v_item.order_item_id AND u.unit_index = ANY (v_taken) ORDER BY u.unit_index
    LOOP
      v_units := v_units || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('order_item_id', v_item.order_item_id,
        'unit_index', v_unit.unit_index, 'paid_amount', v_unit.paid_amount, 'refunded_amount', v_unit.refunded));
      v_item_amount := v_item_amount + v_unit.paid_amount - v_unit.refunded;
-- ACC_P3_BEGIN
      v_item_amount := v_item_amount + v_unit.adjusted;
-- ACC_P3_END
    END LOOP;
    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('idx', pg_catalog.jsonb_array_length(v_rows),
      'order_id', v_item.order_id, 'name', v_item.item_name, 'quantity', v_item.quantity, 'amount', v_item_amount));
  END LOOP;

  -- The deferred revenue of every order must cover what is sent (all entries of the order, reversals included).
  FOR v_order IN
    SELECT r.order_id, pg_catalog.sum(r.amount) AS amount
    FROM pg_catalog.jsonb_to_recordset(v_rows) AS r(order_id uuid, amount bigint)
    GROUP BY r.order_id HAVING pg_catalog.sum(r.amount) > 0 ORDER BY r.order_id
  LOOP
    SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0) INTO v_balance FROM public.accounting_journal_lines AS l
    WHERE l.order_id = v_order.order_id AND l.account_code = '2150';
    IF v_order.amount > v_balance THEN
      v_shortage := v_shortage + (v_order.amount - v_balance);
    END IF;
  END LOOP;
  IF v_shortage > 0 THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'deferred_revenue_short',
      'detail', pg_catalog.jsonb_build_object('shortage', v_shortage), 'order_ids', pg_catalog.to_jsonb(v_orders));
  END IF;

  -- One pair of lines per item (debit 2150, credit 4010); an item worth nothing makes no line.
  SELECT COALESCE(pg_catalog.jsonb_agg(x.line ORDER BY x.idx, x.side), '[]'::jsonb) INTO v_lines FROM (
    SELECT r.idx, s.side,
      CASE s.side
        WHEN 1 THEN pg_catalog.jsonb_build_object('account_code', '2150', 'debit', r.amount, 'credit', 0,
          'order_id', r.order_id::text, 'memo', r.name || U&' \00D7 ' || r.quantity::text)
        ELSE pg_catalog.jsonb_build_object('account_code', '4010', 'debit', 0, 'credit', r.amount, 'order_id', r.order_id::text)
      END AS line
    FROM pg_catalog.jsonb_to_recordset(v_rows) AS r(idx integer, order_id uuid, name text, quantity integer, amount bigint)
    CROSS JOIN (VALUES (1), (2)) AS s(side)
    WHERE r.amount > 0) AS x;
  IF pg_catalog.jsonb_array_length(v_lines) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'no_revenue', 'detail', '{}'::jsonb, 'order_ids', pg_catalog.to_jsonb(v_orders));
  END IF;
  RETURN pg_catalog.jsonb_build_object('reason', NULL, 'lines', v_lines, 'units', v_units, 'order_ids', pg_catalog.to_jsonb(v_orders));
END;
$$;

CREATE OR REPLACE FUNCTION private.order_unit_shipped_slots(_order_item_id uuid) RETURNS TABLE(unit_index integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
-- ACC_P3_REPLACE_BEGIN c12b6619cea873b7a602feab106de6a7
  SELECT a.unit_index FROM private.accounting_shipped_units(_order_item_id, NULL) AS a ORDER BY a.unit_index
-- ACC_P3_REPLACE_END
$$;

CREATE OR REPLACE FUNCTION private.begin_order_refund_core(
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
  v_parts text[];
  v_groups jsonb;
  v_i integer;
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

-- ACC_P3_BEGIN
  -- FREQ-580-AC-01: a dispute waiting for the shop's answer stops a new refund the shop starts (not the automatic one,
  -- not a refund already started: the replay above returns first).
  IF _source IN ('admin', 'order_cancel', 'return') THEN
    PERFORM private.accounting_assert_no_dispute_hold(ARRAY[_order_id]);
  END IF;
-- ACC_P3_END
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
      -- The refund of a return made after the receive covers the (event, part) of order_unit_return_refund_parts: the consult part of
      -- every event no live consult refund covers, and the now part of every event whose now refund failed (FREQ-642-AC-37).
      SELECT COALESCE(pg_catalog.array_agg(c.event_id ORDER BY c.seq, c.part), ARRAY[]::uuid[]),
          COALESCE(pg_catalog.array_agg(c.part ORDER BY c.seq, c.part), ARRAY[]::text[])
        INTO v_event_ids, v_parts
      FROM private.order_unit_return_refund_parts(_return_id) AS c
      JOIN public.order_unit_events AS e ON e.id = c.event_id AND e.order_id = _order_id;
      IF pg_catalog.cardinality(v_event_ids) = 0 THEN
        RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_refund_event';
      END IF;
    ELSE
      v_event_ids := ARRAY[_unit_event_id];
      v_parts := ARRAY[v_part];
    END IF;
    IF NOT v_is_release THEN
      SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id', g.item, 'before_shipment', g.before_shipment,
          'quantity', g.n, 'amount', g.amount) ORDER BY g.item), '[]'::jsonb)
      INTO v_groups
      FROM (SELECT l.holder_order_item_id AS item, (v_event.kind = 'pre_shipment_cancel') AS before_shipment,
          pg_catalog.count(*)::integer AS n, pg_catalog.sum(l.allocation)::integer AS amount
        FROM public.order_unit_event_lines AS l
        JOIN ROWS FROM (pg_catalog.unnest(v_event_ids), pg_catalog.unnest(v_parts)) AS c(event_id, part) ON c.event_id = l.event_id AND c.part = COALESCE(l.part, 'now')
        WHERE l.line_kind = 'returned'
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
    FOR v_i IN 1 .. pg_catalog.cardinality(v_event_ids) LOOP
      PERFORM private.order_unit_link_refund(v_event_ids[v_i], v_refund_id, v_parts[v_i]);
    END LOOP;
  END IF;

  IF _source <> 'return' THEN
    -- Existing business rule (unchanged).
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id=_order_id AND rt.status='open' ORDER BY rt.id;
  END IF;
-- ACC_P3_BEGIN
  -- FREQ-576 / FREQ-577: the requested state, the facts (P, Q, shipping, the event), then the allocations.
  PERFORM private.accounting_record_refund_event(v_refund_id, 'requested');
  PERFORM private.accounting_record_refund_facts(v_refund_id);
  IF _unit_event_id IS NULL THEN
    PERFORM private.accounting_write_refund_allocations(v_refund_id);
  ELSIF v_event.kind = 'pre_shipment_cancel' THEN
    PERFORM private.accounting_record_event_allocations(_unit_event_id);
  END IF;
-- ACC_P3_END
  RETURN QUERY SELECT v_refund_id, v_amount, 'awaiting_response'::text, false;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_group_g_refund_result(
  _refund_id uuid,
  _stripe_refund_id text,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text,
  _operation text,
  _orders uuid[],
  _before jsonb
)
RETURNS TABLE (
  refund_id uuid,
  order_id uuid,
  status text,
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_current public.order_refunds%ROWTYPE;
  v_next text;
  v_request_key uuid;
  v_operation uuid;
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_error_exception uuid;
  v_applied record;
  v_return_email boolean := false;
  v_h_line record;v_h_return record;v_h_left integer;v_h_take integer;v_h_amount integer;
  v_h_count integer;v_h_mismatch boolean:=false;v_h_exception uuid;v_h_resolved boolean;
  v_linked boolean:=false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  SELECT r.* INTO v_current FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Existing business rule (unchanged).
  IF (v_current.stripe_refund_id IS NOT NULL AND v_current.stripe_refund_id <> _stripe_refund_id)
     OR (v_current.stripe_refund_id IS NULL AND EXISTS (
       SELECT 1
       FROM public.order_refunds AS x
       WHERE x.stripe_refund_id = _stripe_refund_id
         AND x.id <> _refund_id
     )) THEN
    RAISE EXCEPTION 'REFUND_STRIPE_ID_MISMATCH' USING ERRCODE = '22023';
  END IF;

  v_next := CASE
    WHEN _stripe_status IN ('pending', 'requires_action') THEN 'pending'
    WHEN _stripe_status = 'succeeded' THEN 'succeeded'
    ELSE 'failed'
  END;

  -- Existing business rule (unchanged).
  IF v_next <> v_current.status AND NOT (
       (v_current.status = 'awaiting_response' AND v_next IN ('pending', 'succeeded', 'failed'))
    OR (v_current.status = 'error' AND v_next IN ('pending', 'succeeded', 'failed'))
    OR (v_current.status = 'pending' AND v_next IN ('succeeded', 'failed'))
    OR (v_current.status = 'succeeded' AND v_next = 'failed')
  ) THEN
    RETURN QUERY
    SELECT v_current.id,
           v_current.order_id,
           v_current.status,
           false,
           false,
           o.status,
           o.refunded_amount,
           COALESCE((
             SELECT pg_catalog.sum(rl.rereserve_shortage)
             FROM public.order_refund_lines AS rl
             WHERE rl.refund_id = v_current.id
           ), 0)::integer,
           false,
           NULL::uuid
    FROM public.orders AS o
    WHERE o.id = v_current.order_id;
    RETURN;
  END IF;

  v_request_key := pg_catalog.md5(_operation || ':' || _refund_id::text || ':' || v_current.status || ':' || v_next)::uuid;
  IF v_next = v_current.status THEN
    -- A report that keeps the state (succeeded -> succeeded, a pending detail update) is a replay: it reuses the
    -- refund's latest operation (preferring the one that reached this state) and adds no operation row.
    SELECT op.id INTO v_operation
    FROM private.group_g_operations AS op
    WHERE op.cause_type = 'order_refund' AND op.cause_id = _refund_id::text
    ORDER BY (op.result ->> 'to_status' IS NOT DISTINCT FROM v_current.status) DESC, op.created_at DESC, op.id DESC
    LIMIT 1;
  ELSE
    SELECT op.id INTO v_operation
    FROM private.group_g_operations AS op
    WHERE op.operation = _operation AND op.request_key = v_request_key;
  END IF;
  IF v_operation IS NULL THEN
    v_operation := pg_catalog.gen_random_uuid();
    INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES (
      v_operation,
      _operation,
      v_request_key,
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'operation', _operation, 'refund_id', _refund_id, 'from_status', v_current.status,
        'to_status', v_next)::text, 'UTF8')), 'hex'),
      'order_refund',
      _refund_id::text,
      v_current.actor_id,
      pg_catalog.jsonb_build_object('refund_id', _refund_id, 'order_id', v_current.order_id,
        'from_status', v_current.status, 'to_status', v_next)
    );
  END IF;
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  -- Existing business rule (unchanged).
  UPDATE public.order_refunds AS r
  SET status = v_next,
      stripe_refund_id = COALESCE(r.stripe_refund_id, _stripe_refund_id),
      stripe_status = _stripe_status,
      stripe_pending_reason = _stripe_pending_reason,
      stripe_failure_reason = _stripe_failure_reason,
      customer_action_expires_at = COALESCE(_customer_action_expires_at, r.customer_action_expires_at),
      payment_method_type = COALESCE(r.payment_method_type, _payment_method_type),
      reference_number = COALESCE(NULLIF(pg_catalog.btrim(_reference_number), ''), r.reference_number),
      reference_type = COALESCE(_reference_type, r.reference_type),
      accepted_at = CASE
        WHEN v_next IN ('pending', 'succeeded') THEN COALESCE(r.accepted_at, pg_catalog.now())
        ELSE r.accepted_at
      END,
      succeeded_at = CASE WHEN v_next = 'succeeded' THEN COALESCE(r.succeeded_at, pg_catalog.now()) ELSE r.succeeded_at END,
      failed_at = CASE WHEN v_next = 'failed' THEN COALESCE(r.failed_at, pg_catalog.now()) ELSE r.failed_at END
  WHERE r.id = _refund_id;

  -- H5: record late provider facts even when released units were used by another refund.
  IF v_next='failed' THEN
    PERFORM private.group_h_release_refund_units(_refund_id);
  ELSIF v_current.errored_at IS NOT NULL AND v_next IN ('pending','succeeded') THEN
    -- Unit binding: a refund tied to an event takes back exactly the units the event returned for its part (never by position).
    -- Units still held by another refund that is in error or failed are released first. A unit that cannot be taken is a mismatch.
    v_linked:=EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er WHERE er.refund_id=_refund_id AND er.part IN ('now','consult'));
    IF v_linked THEN
      BEGIN
        FOR v_h_return IN SELECT er.event_id,er.part FROM public.order_unit_event_refunds AS er
          WHERE er.refund_id=_refund_id AND er.part IN ('now','consult') ORDER BY er.event_id,er.part LOOP
          PERFORM private.group_h_release_refund_units(o.id) FROM (
            SELECT DISTINCT u.refund_id AS id FROM public.order_unit_event_lines AS el
              JOIN public.order_line_unit_amounts AS u ON u.order_item_id=el.order_item_id AND u.unit_index=el.unit_index
              JOIN public.order_refunds AS rf ON rf.id=u.refund_id
              WHERE el.event_id=v_h_return.event_id AND el.line_kind='returned' AND COALESCE(el.part,'now')=v_h_return.part
                AND u.refund_id<>_refund_id AND rf.status IN ('error','failed')) AS o;
          PERFORM private.order_unit_link_refund(v_h_return.event_id,_refund_id,v_h_return.part);
        END LOOP;
      EXCEPTION WHEN SQLSTATE '23514' THEN
        v_h_mismatch:=true;
      END;
    END IF;
    -- A refund of a shipped line without a return, on an order with a discount snapshot, claims no unit at all (FREQ-642-AC-28), so it has nothing to take back.
    FOR v_h_line IN SELECT l.* FROM public.order_refund_lines AS l WHERE l.refund_id=_refund_id AND NOT v_linked
      AND NOT (v_current.return_id IS NULL AND NOT l.before_shipment
        AND EXISTS (SELECT 1 FROM public.order_discount_snapshots AS ds WHERE ds.order_id=v_current.order_id))
      ORDER BY l.order_item_id,l.before_shipment DESC LOOP
      IF EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=v_h_line.order_item_id) THEN
        IF v_current.return_id IS NULL THEN
          SELECT LEAST(v_h_line.quantity,pg_catalog.count(*)::integer) INTO v_h_take
            FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=v_h_line.order_item_id
              AND ((u.refund_id=_refund_id AND u.refund_before_shipment=v_h_line.before_shipment)
                OR (u.refund_id IS NULL AND u.return_line_id IS NULL));
          v_h_amount:=private.group_h_claim_refund_units(_refund_id,v_h_line.order_item_id,v_h_take,v_h_line.before_shipment,NULL);
          v_h_count:=v_h_take;
        ELSE
          v_h_amount:=0;v_h_left:=v_h_line.quantity;v_h_count:=0;
          -- RR: take back the same units through this refund's slices; fall back to the H5 walk.
          BEGIN
            FOR v_h_return IN SELECT s.return_line_id AS id,s.quantity FROM private.group_h_return_refund_slices(
              v_current.return_id,v_h_line.order_item_id,v_h_line.quantity,v_current.request_key) AS s LOOP
              v_h_amount:=v_h_amount+private.group_h_claim_refund_units(_refund_id,v_h_line.order_item_id,v_h_return.quantity,false,v_h_return.id);
              v_h_count:=v_h_count+v_h_return.quantity;v_h_left:=v_h_left-v_h_return.quantity;
            END LOOP;
          EXCEPTION WHEN SQLSTATE '23514' THEN
            v_h_amount:=0;v_h_left:=v_h_line.quantity;v_h_count:=0;
          END;
          IF v_h_left>0 THEN
            -- The fallback claim keeps the line capacity; when it cannot bind the units, record the late
            -- provider fact and leave the unit mismatch to the exception below instead of failing the result.
            BEGIN
              FOR v_h_return IN SELECT l.id FROM public.order_return_lines AS l
                WHERE l.return_id=v_current.return_id AND l.order_item_id=v_h_line.order_item_id ORDER BY l.created_at,l.id LOOP
                SELECT LEAST(v_h_left,pg_catalog.count(*)::integer) INTO v_h_take
                  FROM public.order_line_unit_amounts AS u
                  LEFT JOIN LATERAL private.group_h_return_unit_rows(v_h_return.id) AS b ON b.unit_index=u.unit_index
                  WHERE u.order_item_id=v_h_line.order_item_id AND
                    ((u.refund_id=_refund_id AND u.return_line_id=v_h_return.id)
                    OR (u.refund_id IS NULL AND (u.return_line_id IS NULL
                      OR (u.return_line_id=v_h_return.id AND b.remaining_index IS NOT NULL))));
                v_h_amount:=v_h_amount+private.group_h_claim_refund_units(_refund_id,v_h_line.order_item_id,v_h_take,false,v_h_return.id);
                v_h_count:=v_h_count+v_h_take;v_h_left:=v_h_left-v_h_take;EXIT WHEN v_h_left=0;
              END LOOP;
            EXCEPTION WHEN SQLSTATE '23514' THEN
              v_h_amount:=0;v_h_count:=0;v_h_mismatch:=true;
            END;
          END IF;
        END IF;
        v_h_mismatch:=v_h_mismatch OR v_h_count<>v_h_line.quantity OR v_h_amount IS DISTINCT FROM v_h_line.amount;
      END IF;
    END LOOP;
    IF v_h_mismatch THEN
      SELECT x.exception_id,x.is_resolved INTO v_h_exception,v_h_resolved FROM private.record_group_g_payment_exception_row(
        _refund_id::text,'refund_failed','group_h_refund_unit_mismatch',NULL,
        (SELECT o.payment_intent_id FROM public.orders AS o WHERE o.id=v_current.order_id),NULL,v_current.order_id) AS x;
      IF v_h_resolved THEN
        -- A reviewed transport error does not cover a newly observed provider refund.
        SELECT x.exception_id INTO v_h_exception FROM private.record_group_g_payment_exception_row(
          _stripe_refund_id,'refund_failed','group_h_refund_unit_mismatch',NULL,
          (SELECT o.payment_intent_id FROM public.orders AS o WHERE o.id=v_current.order_id),NULL,v_current.order_id) AS x;
      END IF;
    END IF;
  END IF;

  -- Resolve G-1's transport error only after H recovery agrees with the stored quantity and amount.
  IF v_current.status = 'error' AND NOT v_h_mismatch
     AND v_next IN ('pending', 'succeeded')
     AND NOT EXISTS (
       SELECT 1
       FROM public.order_refund_lines AS rl
       JOIN private.order_line_fulfillment(v_current.order_id) AS l ON l.order_item_id = rl.order_item_id
       WHERE rl.refund_id = _refund_id
         AND rl.before_shipment
         AND l.shipped + l.refunded_before_shipment > l.quantity
     ) THEN
    SELECT e.id INTO v_error_exception
    FROM public.payment_exceptions AS e
    WHERE e.payment_ref = _refund_id::text
      AND e.reason = 'refund_failed'
      AND e.resolved_at IS NULL;
    IF FOUND THEN
      PERFORM private.resolve_group_g_payment_exception_row(v_error_exception, U&'Stripe \3067\8fd4\91d1\304c\898b\3064\304b\3063\305f\305f\3081\81ea\52d5\3067\89e3\6c7a');
    END IF;
  END IF;

  SELECT a.* INTO v_applied FROM private.apply_order_refund_state(_refund_id) AS a;
  IF v_current.return_id IS NOT NULL THEN
    v_return_email := private.apply_return_refund_outcome(_refund_id, v_current.status);
  ELSE
    -- Existing business rule (unchanged).
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id = v_current.order_id AND rt.status = 'open' ORDER BY rt.id;
  END IF;
  -- G-1 can cover a reopened return with a normal refund; keep only the quantities it still reserves.
  PERFORM private.group_h_release_return_units(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id=v_current.order_id AND rt.status IN ('open','closed') ORDER BY rt.id;

  PERFORM private.record_group_g_item_state_changes(_before, _orders, v_operation, 1, _operation, v_current.actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

-- ACC_P3_BEGIN
  -- FREQ-576-AC-01: one history row per state; the second report of a state adds nothing. Allocations never move here.
  IF v_applied.newly_accepted THEN
    PERFORM private.accounting_record_refund_event(_refund_id, 'accepted', _stripe_status);
  END IF;
  IF v_next = 'succeeded' THEN
    PERFORM private.accounting_record_refund_event(_refund_id, 'succeeded', _stripe_status);
  ELSIF v_next = 'failed' THEN
    PERFORM private.accounting_record_refund_event(_refund_id,
      CASE WHEN _stripe_status = 'canceled' THEN 'canceled' ELSE 'failed' END, _stripe_status);
  END IF;
-- ACC_P3_END
  RETURN QUERY
  SELECT _refund_id,
         v_current.order_id,
         v_next,
         v_applied.newly_accepted,
         v_applied.newly_failed,
         v_applied.order_status,
         v_applied.refunded_amount,
         v_applied.rereserve_shortage,
         v_applied.email_enqueued OR v_return_email,
         COALESCE(v_h_exception,v_applied.exception_id);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_external_order_refund(
  _order_id uuid,
  _stripe_refund_id text,
  _amount integer,
  _stripe_status text,
  _stripe_pending_reason text,
  _stripe_failure_reason text,
  _customer_action_expires_at timestamptz,
  _payment_method_type text,
  _reference_number text,
  _reference_type text,
  _stripe_reason text,
  _stripe_created_at timestamptz
)
RETURNS TABLE (
  refund_id uuid,
  created boolean,
  source text,
  status text,
  newly_accepted boolean,
  newly_failed boolean,
  order_status public.order_status,
  refunded_amount integer,
  rereserve_shortage integer,
  email_enqueued boolean,
  exception_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
-- ACC_P3_BEGIN
  v_h_units integer[];
-- ACC_P3_END
  v_orders uuid[];
  v_before jsonb;
  v_order public.orders%ROWTYPE;
  v_existing public.order_refunds%ROWTYPE;
  v_refund_id uuid;
  v_created boolean := false;
  v_source text;
  v_started timestamptz;
  v_open integer := 0;
  v_open_shipping integer := 0;
  v_lines jsonb := '[]'::jsonb;
  v_lines_amount integer := 0;
  v_shipping integer := 0;
  v_applied record;
  v_h_line record;v_h_amount integer;
BEGIN
  IF _order_id IS NULL
     OR _amount IS NULL
     OR _amount < 1
     OR _stripe_created_at IS NULL
     OR NOT private.refund_stripe_fields_valid(
       _stripe_refund_id, _stripe_status, _stripe_pending_reason, _stripe_failure_reason,
       _payment_method_type, _reference_number, _reference_type
     ) THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_before := private.capture_group_g_item_states(v_orders);

  SELECT r.* INTO v_existing FROM public.order_refunds AS r WHERE r.stripe_refund_id = _stripe_refund_id;
  IF FOUND THEN
    -- Existing business rule (unchanged).
    IF v_existing.order_id <> _order_id THEN
      RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_refund_id := v_existing.id;
    v_source := v_existing.source;
  ELSE
    SELECT s.started_at INTO v_started FROM private.refund_ledger_state AS s WHERE s.id = 1;
    v_source := CASE WHEN _stripe_created_at < v_started THEN 'legacy' ELSE 'stripe_dashboard' END;

    -- Existing business rule (unchanged).
    IF v_source = 'stripe_dashboard'
       AND _stripe_status IN ('pending', 'requires_action', 'succeeded')
       AND v_order.status IN ('paid', 'shipped') THEN
      SELECT COALESCE(pg_catalog.sum(r.amount), 0)::integer, COALESCE(pg_catalog.sum(r.shipping_amount), 0)::integer
      INTO v_open, v_open_shipping
      FROM public.order_refunds AS r
      WHERE r.order_id = _order_id
        AND r.status IN ('awaiting_response', 'pending', 'succeeded');

      IF v_open + _amount >= COALESCE(NULLIF(v_order.paid_amount, 0), v_order.total_amount) THEN
        SELECT COALESCE(pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'order_item_id', x.order_item_id,
                   'quantity', x.unshipped,
                   'restock_type', x.restock_type,
                   'amount', x.line_amount
-- ACC_P3_BEGIN
                   , 'units', pg_catalog.to_jsonb(x.units)
-- ACC_P3_END
                 ) ORDER BY x.created_at, x.order_item_id
               ), '[]'::jsonb)
        INTO v_lines
        FROM (
          SELECT l.order_item_id,
                 l.unshipped,
                 CASE WHEN l.fulfillment_type = 'stock' THEN 'cancel' ELSE 'no_restock' END AS restock_type,
                 CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=oi.id)
-- ACC_P3_REPLACE_BEGIN c01e15507250e34b6d2a1bfdbcd174ce
                   THEN (SELECT COALESCE(pg_catalog.sum(hu.paid_amount), 0)::integer FROM public.order_line_unit_amounts AS hu
                     WHERE hu.order_item_id = oi.id AND hu.unit_index = ANY (pu.units))
-- ACC_P3_REPLACE_END
                   ELSE oi.item_price * l.unshipped
                   - (private.refund_units_discount(
                        COALESCE(d.line_discount, 0), oi.quantity,
                        l.refunded_before_shipment + l.refunded_after_shipment + l.unshipped
                      )
                      - private.refund_units_discount(
                        COALESCE(d.line_discount, 0), oi.quantity,
                        l.refunded_before_shipment + l.refunded_after_shipment
                      )) END AS line_amount,
                 oi.created_at
-- ACC_P3_BEGIN
                 , pu.units
-- ACC_P3_END
          FROM private.order_line_fulfillment(_order_id) AS l
          JOIN public.order_items AS oi ON oi.id = l.order_item_id
          LEFT JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = l.order_item_id
-- ACC_P3_BEGIN
          -- P3-C7: the free units (no refund, no return line) not shipped by accounting_shipped_units first, then the free
          -- shipped-named ones; cheapest first, then unit_index. Chosen once; the same array gives the amount and the claim.
          CROSS JOIN LATERAL (SELECT ARRAY(
            SELECT hu.unit_index FROM public.order_line_unit_amounts AS hu
            WHERE hu.order_item_id = oi.id AND hu.refund_id IS NULL AND hu.return_line_id IS NULL
            ORDER BY EXISTS (SELECT 1 FROM private.accounting_shipped_units(oi.id, NULL) AS su WHERE su.unit_index = hu.unit_index),
              hu.paid_amount, hu.unit_index
            LIMIT l.unshipped) AS units) AS pu
-- ACC_P3_END
          WHERE l.unshipped > 0
        ) AS x;

        v_shipping := LEAST(GREATEST(v_order.shipping_amount - v_open_shipping, 0), _amount);
      END IF;
    END IF;

    SELECT COALESCE(pg_catalog.sum((e.value ->> 'amount')::integer), 0)::integer
    INTO v_lines_amount
    FROM pg_catalog.jsonb_array_elements(v_lines) AS e(value);

    INSERT INTO public.order_refunds AS r
      (order_id, source, stripe_refund_id, status, amount, shipping_amount, adjustment_amount,
       stripe_reason, notify_customer, created_at)
    VALUES
      (_order_id, v_source, _stripe_refund_id, 'awaiting_response', _amount, v_shipping,
       _amount - v_lines_amount - v_shipping,
       CASE WHEN _stripe_reason IN ('requested_by_customer', 'duplicate', 'fraudulent') THEN _stripe_reason END,
       v_source <> 'legacy', _stripe_created_at)
    RETURNING r.id INTO v_refund_id;

    -- H5: external quantity-bearing refunds use the same persistent claims.
    FOR v_h_line IN SELECT x.* FROM pg_catalog.jsonb_to_recordset(v_lines)
      AS x(order_item_id uuid,quantity integer,amount integer) ORDER BY x.order_item_id LOOP
      IF EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=v_h_line.order_item_id) THEN
-- ACC_P3_REPLACE_BEGIN 98f00c81d0589400b154c8e82ad06e31
        v_h_units := ARRAY(SELECT u.value::integer FROM pg_catalog.jsonb_array_elements(v_lines) AS e(value)
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(e.value -> 'units') AS u(value)
          WHERE (e.value ->> 'order_item_id')::uuid = v_h_line.order_item_id);
        IF COALESCE(pg_catalog.cardinality(v_h_units), 0) < v_h_line.quantity THEN
          RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
        v_h_amount:=private.group_h_claim_refund_units(v_refund_id,v_h_line.order_item_id,v_h_units,true,NULL);
-- ACC_P3_REPLACE_END
        IF v_h_amount IS DISTINCT FROM v_h_line.amount THEN
          RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      END IF;
    END LOOP;
    INSERT INTO public.order_refund_lines (refund_id, order_item_id, quantity, before_shipment, restock_type, amount)
    SELECT v_refund_id,
           (e.value ->> 'order_item_id')::uuid,
           (e.value ->> 'quantity')::integer,
           true,
           e.value ->> 'restock_type',
           (e.value ->> 'amount')::integer
    FROM pg_catalog.jsonb_array_elements(v_lines) AS e(value);

-- ACC_P3_BEGIN
    PERFORM private.accounting_record_refund_event(v_refund_id, 'requested');
    PERFORM private.accounting_record_refund_facts(v_refund_id);
    PERFORM private.accounting_write_refund_allocations(v_refund_id);
-- ACC_P3_END
    v_created := true;
  END IF;

  SELECT x.* INTO v_applied
  FROM private.record_group_g_refund_result(
    v_refund_id, _stripe_refund_id, _stripe_status, _stripe_pending_reason, _stripe_failure_reason,
    _customer_action_expires_at, _payment_method_type, _reference_number, _reference_type,
    'record_external_order_refund', v_orders, v_before
  ) AS x;

  RETURN QUERY
  SELECT v_refund_id,
         v_created,
         v_source,
         v_applied.status,
         v_applied.newly_accepted,
         v_applied.newly_failed,
         v_applied.order_status,
         v_applied.refunded_amount,
         v_applied.rereserve_shortage,
         v_applied.email_enqueued,
         v_applied.exception_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.mark_order_refund_error(_refund_id uuid, _reason text, _raise_exception boolean)
RETURNS TABLE (outcome text, order_id uuid, exception_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_order_id uuid;
  v_orders uuid[];
  v_before jsonb;
  v_order public.orders%ROWTYPE;
  v_refund public.order_refunds%ROWTYPE;
  v_exception uuid;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _refund_id IS NULL
     OR _raise_exception IS NULL
     OR _reason IS NULL
     OR _reason !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT r.order_id INTO v_order_id FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[v_order_id], NULL);
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = v_order_id;
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;

  IF v_refund.status <> 'awaiting_response' THEN
    RETURN QUERY SELECT 'not_awaiting'::text, v_order_id, NULL::uuid;
    RETURN;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  UPDATE public.order_refunds AS r
  SET status = 'error',
      stripe_failure_reason = _reason,
      errored_at = pg_catalog.now()
  WHERE r.id = _refund_id;

  PERFORM private.group_h_release_refund_units(_refund_id);
-- ACC_P3_BEGIN
  PERFORM private.accounting_record_refund_event(_refund_id, 'error');
-- ACC_P3_END

  IF _raise_exception THEN
    SELECT x.exception_id INTO v_exception
    FROM private.record_group_g_payment_exception_row(
      _refund_id::text,
      'refund_failed',
      _reason,
      NULL::text,
      v_order.payment_intent_id,
      NULL::uuid,
      v_order_id
    ) AS x;
  END IF;

  -- The operation row comes before FIFO so an allocation it makes keeps this refund as its origin.
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'mark_order_refund_error',
    pg_catalog.md5('mark_order_refund_error:' || _refund_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'mark_order_refund_error', 'refund_id', _refund_id, 'reason', _reason,
      'raise_exception', _raise_exception)::text, 'UTF8')), 'hex'),
    'order_refund',
    _refund_id::text,
    v_refund.actor_id,
    pg_catalog.jsonb_build_object('refund_id', _refund_id, 'order_id', v_order_id, 'exception_id', v_exception)
  );

  -- Existing business rule (unchanged).
  PERFORM 1 FROM private.apply_order_refund_state(_refund_id);

  IF v_refund.return_id IS NOT NULL THEN
    PERFORM private.apply_return_refund_outcome(_refund_id, 'awaiting_response');
  ELSE
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id = v_order_id AND rt.status = 'open' ORDER BY rt.id;
  END IF;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'mark_order_refund_error',
    v_refund.actor_id);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT 'errored'::text, v_order_id, v_exception;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE CONSTRAINT TRIGGER accounting_unit_price_adjusts_sum AFTER INSERT ON public.accounting_unit_price_adjusts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.accounting_check_unit_allocation_sum();

-- One state row of a refund. The number is taken under the group G lock; the same (refund, state) twice returns the
-- first row and takes no number. A decided state (abandoned / owed) carries the hash of the request.
CREATE FUNCTION private.accounting_record_refund_event(_refund_id uuid, _state text, _stripe_status text DEFAULT NULL,
  _actor_id uuid DEFAULT NULL, _reason text DEFAULT NULL, _request_key uuid DEFAULT NULL,
  _release_shortfall integer DEFAULT NULL, _carried_adjust integer DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_order uuid;
  v_seq bigint;
  v_at timestamptz;
  v_next integer;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  SELECT e.id INTO v_id FROM public.accounting_refund_events AS e WHERE e.refund_id = _refund_id AND e.state = _state;
  IF FOUND THEN
    RETURN v_id;
  END IF;
  SELECT r.order_id INTO v_order FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF v_order IS NULL OR _state IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT t.fact_seq, t.locked_at INTO v_seq, v_at FROM private.accounting_take_g_fact_seq() AS t;
  SELECT COALESCE(pg_catalog.max(e.seq), 0) + 1 INTO v_next FROM public.accounting_refund_events AS e
  WHERE e.refund_id = _refund_id;
  INSERT INTO public.accounting_refund_events AS e (refund_id, order_id, seq, state, stripe_status, actor_id, reason,
    request_key, request_hash, release_shortfall, carried_adjust, fact_seq)
  VALUES (_refund_id, v_order, v_next, _state, pg_catalog.left(_stripe_status, 64), _actor_id, _reason, _request_key,
    CASE WHEN _request_key IS NOT NULL THEN private.accounting_request_hash(pg_catalog.jsonb_build_object(
      'op', 'decide_refund_cancellation', 'refund_id', _refund_id, 'kind', _state, 'reason', _reason, 'actor_id', _actor_id)) END,
    _release_shortfall, _carried_adjust, v_seq)
  RETURNING e.id INTO v_id;
  RETURN v_id;
END;
$$;

-- P (pre-shipment), Q (post-shipment) and shipping of a refund (plan 3 "P and Q"). Never raises; P and Q are never negative.
--   1. A refund tied to a unit event: a return refund and the refunds of other events are all Q. A pre-shipment cancel
--      splits the amount without shipping by the returned lines' allocations [not shipped, shipped] and caps the first part
--      at V_P (the values of the returned units not shipped, read before this event's allocations are written).
--   2. Any other refund: P0 / Q0 are the line amounts by before_shipment, A = amount - shipping - P0 - Q0. A > 0 is split by
--      the unit values [not shipped, shipped] (all Q when both are 0); A < 0 is taken by the ratio [P0, Q0]. Units held by a
--      pre-shipment H claim of a refund not failed are already returned (their P0 is the line) and weigh nothing on the
--      not-shipped side, and accounting_write_refund_allocations skips them too.
--   3. A negative part is taken from the other one. A source='return' refund has P = 0.
CREATE FUNCTION private.accounting_split_refund(_refund_id uuid)
RETURNS TABLE(pre_amount integer, post_amount integer, shipping_amount integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund public.order_refunds%ROWTYPE;
  v_event public.order_unit_events%ROWTYPE;
  v_ship bigint;
  v_total bigint;
  v_p bigint := 0;
  v_q bigint := 0;
  v_pre bigint;
  v_post bigint;
  v_vp bigint;
  v_a bigint;
  v_split bigint[];
BEGIN
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_ship := LEAST(GREATEST(COALESCE(v_refund.shipping_amount, 0), 0), GREATEST(COALESCE(v_refund.amount, 0), 0));
  v_total := GREATEST(COALESCE(v_refund.amount, 0), 0) - v_ship;
  SELECT e.* INTO v_event FROM public.order_unit_event_refunds AS er JOIN public.order_unit_events AS e ON e.id = er.event_id
  WHERE er.refund_id = _refund_id ORDER BY e.seq LIMIT 1;
  IF v_refund.source = 'return' THEN
    v_p := 0;
    v_q := v_total;
  ELSIF v_event.id IS NOT NULL THEN
    IF v_event.kind = 'pre_shipment_cancel' THEN
      SELECT COALESCE(pg_catalog.sum(GREATEST(l.allocation, 0)) FILTER (WHERE NOT l.shipped), 0),
        COALESCE(pg_catalog.sum(GREATEST(l.allocation, 0)) FILTER (WHERE l.shipped), 0)
      INTO v_pre, v_post FROM public.order_unit_event_lines AS l WHERE l.event_id = v_event.id AND l.line_kind = 'returned';
      IF v_pre = 0 THEN
        v_p := 0;
      ELSIF v_post = 0 THEN
        v_p := v_total;
      ELSE
        v_split := private.accounting_allocate_amount(v_total, ARRAY[v_pre, v_post]);
        v_p := v_split[1];
      END IF;
      SELECT COALESCE(pg_catalog.sum(GREATEST(v.value, 0)), 0) INTO v_vp
      FROM private.accounting_unit_values(v_refund.order_id, NULL) AS v
      JOIN public.order_unit_event_lines AS l ON l.order_item_id = v.order_item_id AND l.unit_index = v.unit_index
      WHERE l.event_id = v_event.id AND l.line_kind = 'returned' AND NOT l.shipped;
      v_p := LEAST(v_p, v_vp);
      v_q := v_total - v_p;
    ELSE
      v_p := 0;
      v_q := v_total;
    END IF;
  ELSE
    SELECT COALESCE(pg_catalog.sum(l.amount) FILTER (WHERE l.before_shipment), 0),
      COALESCE(pg_catalog.sum(l.amount) FILTER (WHERE NOT l.before_shipment), 0)
    INTO v_p, v_q FROM public.order_refund_lines AS l WHERE l.refund_id = _refund_id;
    v_a := v_total - v_p - v_q;
    IF v_a > 0 THEN
      SELECT COALESCE(pg_catalog.sum(GREATEST(v.value, 0)) FILTER (WHERE NOT v.shipped AND NOT h.held), 0),
        COALESCE(pg_catalog.sum(GREATEST(v.value, 0)) FILTER (WHERE v.shipped), 0)
      INTO v_pre, v_post FROM private.accounting_unit_values(v_refund.order_id, NULL) AS v
      CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu JOIN public.order_refunds AS hr ON hr.id = hu.refund_id
        WHERE hu.order_item_id = v.order_item_id AND hu.unit_index = v.unit_index AND hu.refund_before_shipment AND hr.status <> 'failed') AS held) AS h;
      IF v_pre + v_post = 0 THEN
        v_q := v_q + v_a;
      ELSE
        v_split := private.accounting_allocate_amount(v_a, ARRAY[v_pre, v_post]);
        v_p := v_p + v_split[1];
        v_q := v_q + v_split[2];
      END IF;
    ELSIF v_a < 0 THEN
      IF GREATEST(v_p, 0) + GREATEST(v_q, 0) = 0 THEN
        v_q := v_q + v_a;
      ELSE
        v_split := private.accounting_allocate_amount(-v_a, ARRAY[GREATEST(v_p, 0), GREATEST(v_q, 0)]);
        v_p := v_p - v_split[1];
        v_q := v_q - v_split[2];
      END IF;
    END IF;
    IF v_p < 0 THEN
      v_q := v_q + v_p;
      v_p := 0;
    END IF;
    IF v_q < 0 THEN
      v_p := GREATEST(v_p + v_q, 0);
      v_q := 0;
    END IF;
  END IF;
  RETURN QUERY SELECT v_p::integer, v_q::integer, v_ship::integer;
END;
$$;

-- The facts of a refund, once (INSERT only; no lock of its own). A legacy refund has none. When P + Q + shipping is not
-- the refund amount, the refund is parked (amount_mismatch, mismatch='split').
CREATE FUNCTION private.accounting_record_refund_facts(_refund_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund public.order_refunds%ROWTYPE;
  v_event public.order_unit_events%ROWTYPE;
  v_split record;
  v_kind text;
BEGIN
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND OR v_refund.source = 'legacy'
    OR EXISTS (SELECT 1 FROM public.accounting_refund_facts AS f WHERE f.refund_id = _refund_id) THEN
    RETURN;
  END IF;
  SELECT s.pre_amount, s.post_amount, s.shipping_amount INTO v_split FROM private.accounting_split_refund(_refund_id) AS s;
  SELECT e.* INTO v_event FROM public.order_unit_event_refunds AS er JOIN public.order_unit_events AS e ON e.id = er.event_id
  WHERE er.refund_id = _refund_id ORDER BY e.seq LIMIT 1;
  v_kind := CASE v_event.kind WHEN 'pre_shipment_cancel' THEN 'pre_shipment_cancel' WHEN 'return_receive' THEN 'return_receipt'
    WHEN 'hold_release' THEN 'holdback_release' ELSE 'none' END;
  INSERT INTO public.accounting_refund_facts (refund_id, order_id, source, return_id, event_id, event_kind,
    pre_shipment_amount, post_shipment_amount, shipping_amount, fee_amount, started_at)
  VALUES (_refund_id, v_refund.order_id, v_refund.source, v_refund.return_id, CASE WHEN v_kind <> 'none' THEN v_event.id END,
    v_kind, v_split.pre_amount, v_split.post_amount, v_split.shipping_amount,
    CASE WHEN v_kind = 'holdback_release' THEN v_event.fee_amount ELSE 0 END, v_refund.created_at)
  ON CONFLICT DO NOTHING;
  IF v_split.pre_amount + v_split.post_amount + v_split.shipping_amount IS DISTINCT FROM v_refund.amount THEN
    PERFORM private.accounting_park_event(CASE WHEN v_refund.source = 'return' THEN 'return_refund' ELSE 'pre_shipment_refund' END,
      'accounting_refund_facts', _refund_id::text, v_refund.order_id, 'amount_mismatch',
      pg_catalog.jsonb_build_object('mismatch', 'split'));
  END IF;
END;
$$;

-- Rules 2 and 3 for one pre-shipment cancel event (key = the event id). Writes nothing when a row with the key exists.
-- Returned units not shipped at the event: the allocation and the price adjust that makes the value 0. Remaining units:
-- the recorded correction c (an unshipped unit not below value 0), then r = (V_P - P) - sum(applied c) by the values.
-- Unshipped units go to accounting_unit_price_adjusts, shipped ones to accounting_refund_transfer_adjusts. What cannot be
-- written is parked (allocation:<event id>: allocation_overflow / unit_value_left). Never raises (except without the lock).
CREATE FUNCTION private.accounting_record_event_allocations(_event_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event public.order_unit_events%ROWTYPE;
  v_key text;
  v_p bigint;
  v_vp bigint := 0;
  v_line record;
  v_applied bigint := 0;
  v_r bigint;
  v_items uuid[] := ARRAY[]::uuid[];
  v_units integer[] := ARRAY[]::integer[];
  v_shipped boolean[] := ARRAY[]::boolean[];
  v_amounts bigint[] := ARRAY[]::bigint[];
  v_weights bigint[] := ARRAY[]::bigint[];
  v_split bigint[];
  v_overflow boolean := false;
  v_left boolean := false;
  v_i integer;
  v_seq bigint;
  v_at timestamptz;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  SELECT e.* INTO v_event FROM public.order_unit_events AS e WHERE e.id = _event_id;
  IF NOT FOUND OR v_event.kind <> 'pre_shipment_cancel' THEN
    RETURN;
  END IF;
  v_key := _event_id::text;
  IF EXISTS (SELECT 1 FROM public.accounting_unit_refund_allocations AS a WHERE a.refund_key = v_key)
    OR EXISTS (SELECT 1 FROM public.accounting_unit_price_adjusts AS p WHERE p.adjust_key = v_key)
    OR EXISTS (SELECT 1 FROM public.accounting_refund_transfer_adjusts AS t WHERE t.event_id = _event_id AND t.adjust_key = v_key)
    OR NOT EXISTS (SELECT 1 FROM public.order_unit_event_lines AS l
      WHERE l.event_id = _event_id AND l.line_kind = 'returned' AND NOT l.shipped) THEN
    RETURN;
  END IF;
  BEGIN
    SELECT COALESCE(pg_catalog.sum(f.pre_shipment_amount), 0) INTO v_p FROM public.accounting_refund_facts AS f
    WHERE f.event_id = _event_id;
    SELECT COALESCE(pg_catalog.sum(GREATEST(v.value, 0)), 0) INTO v_vp FROM private.accounting_unit_values(v_event.order_id, NULL) AS v
    JOIN public.order_unit_event_lines AS l ON l.order_item_id = v.order_item_id AND l.unit_index = v.unit_index
    WHERE l.event_id = _event_id AND l.line_kind = 'returned' AND NOT l.shipped;

    -- (a) the returned units on the pre-shipment side.
    FOR v_line IN
      SELECT l.order_item_id, l.unit_index, l.allocation, v.shipped, v.value
      FROM public.order_unit_event_lines AS l
      LEFT JOIN private.accounting_unit_values(v_event.order_id, NULL) AS v
        ON v.order_item_id = l.order_item_id AND v.unit_index = l.unit_index
      WHERE l.event_id = _event_id AND l.line_kind = 'returned' AND NOT l.shipped
      ORDER BY l.order_item_id, l.unit_index
    LOOP
      IF v_line.value IS NULL OR v_line.shipped OR v_line.allocation < 0 THEN
        v_overflow := true;
        CONTINUE;
      END IF;
      IF v_line.allocation > 0 THEN
        PERFORM private.accounting_record_unit_refund(v_key, v_line.order_item_id, v_line.unit_index, v_line.allocation);
      END IF;
      IF v_line.allocation - v_line.value <> 0 THEN
        SELECT t.fact_seq, t.locked_at INTO v_seq, v_at FROM private.accounting_take_g_fact_seq() AS t;
        INSERT INTO public.accounting_unit_price_adjusts (order_item_id, unit_index, adjust_key, event_id, amount, fact_seq, locked_at)
        VALUES (v_line.order_item_id, v_line.unit_index, v_key, _event_id, v_line.allocation - v_line.value, v_seq, v_at);
      END IF;
    END LOOP;

    -- (b) the remaining units: the recorded correction, not below value 0 for a unit not shipped.
    FOR v_line IN
      SELECT l.order_item_id, l.unit_index, l.correction, v.shipped, v.value
      FROM public.order_unit_event_lines AS l
      JOIN private.accounting_unit_values(v_event.order_id, NULL) AS v
        ON v.order_item_id = l.order_item_id AND v.unit_index = l.unit_index
      WHERE l.event_id = _event_id AND l.line_kind = 'kept'
      ORDER BY l.order_item_id, l.unit_index
    LOOP
      v_items := v_items || v_line.order_item_id;
      v_units := v_units || v_line.unit_index;
      v_shipped := v_shipped || v_line.shipped;
      IF v_line.shipped OR v_line.value + v_line.correction >= 0 THEN
        v_amounts := v_amounts || v_line.correction::bigint;
      ELSIF v_line.value >= 0 THEN
        v_amounts := v_amounts || (-v_line.value)::bigint;
      ELSE
        v_amounts := v_amounts || 0::bigint;
      END IF;
      v_applied := v_applied + v_amounts[pg_catalog.cardinality(v_amounts)];
      v_weights := v_weights || GREATEST(v_line.value::bigint
        + CASE WHEN v_line.shipped THEN 0 ELSE v_amounts[pg_catalog.cardinality(v_amounts)] END, 0);
    END LOOP;

    -- (c) the rest r by the weights, inside the rules of accounting_allocate_amount.
    v_r := (v_vp - v_p) - v_applied;
    IF v_r <> 0 THEN
      IF COALESCE((SELECT pg_catalog.sum(w) FROM pg_catalog.unnest(v_weights) AS t(w)), 0) = 0 THEN
        v_left := true;
      ELSE
        v_split := private.accounting_allocate_amount(pg_catalog.abs(v_r), v_weights);
        IF v_r < 0 THEN
          FOR v_i IN 1 .. pg_catalog.cardinality(v_split) LOOP
            IF NOT v_shipped[v_i] AND v_split[v_i] > v_weights[v_i] THEN
              v_left := true;
            END IF;
          END LOOP;
        END IF;
        IF NOT v_left THEN
          FOR v_i IN 1 .. pg_catalog.cardinality(v_split) LOOP
            v_amounts[v_i] := v_amounts[v_i] + pg_catalog.sign(v_r)::bigint * v_split[v_i];
          END LOOP;
        END IF;
      END IF;
    END IF;
    FOR v_i IN 1 .. COALESCE(pg_catalog.cardinality(v_amounts), 0) LOOP
      CONTINUE WHEN v_amounts[v_i] = 0;
      SELECT t.fact_seq, t.locked_at INTO v_seq, v_at FROM private.accounting_take_g_fact_seq() AS t;
      IF v_shipped[v_i] THEN
        INSERT INTO public.accounting_refund_transfer_adjusts (event_id, adjust_key, order_item_id, unit_index, amount, fact_seq, locked_at)
        VALUES (_event_id, v_key, v_items[v_i], v_units[v_i], v_amounts[v_i], v_seq, v_at);
      ELSE
        INSERT INTO public.accounting_unit_price_adjusts (order_item_id, unit_index, adjust_key, event_id, amount, fact_seq, locked_at)
        VALUES (v_items[v_i], v_units[v_i], v_key, _event_id, v_amounts[v_i], v_seq, v_at);
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '55000' AND SQLERRM = 'GROUP_H_LOCK_REQUIRED' THEN
      RAISE;
    END IF;
    v_overflow := true;
  END;
  IF v_overflow THEN
    PERFORM private.accounting_park_event('pre_shipment_refund', 'accounting_unit_refund_allocations', 'allocation:' || v_key,
      v_event.order_id, 'amount_mismatch', pg_catalog.jsonb_build_object('mismatch', 'allocation_overflow'));
  ELSIF v_left THEN
    PERFORM private.accounting_park_event('pre_shipment_refund', 'accounting_unit_refund_allocations', 'allocation:' || v_key,
      v_event.order_id, 'amount_mismatch', pg_catalog.jsonb_build_object('mismatch', 'unit_value_left'));
  END IF;
END;
$$;

-- P_adj (the facts' P minus the before_shipment lines) of a refund not tied to an event, on the units not shipped with a
-- value above 0, by their values (remainder from the lowest unit). Key = the refund id. Writes nothing when a row with the
-- key exists. When P_adj is more than the values can take, nothing is written and the refund is parked. Never raises.
CREATE FUNCTION private.accounting_write_refund_allocations(_refund_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund public.order_refunds%ROWTYPE;
  v_key text;
  v_p bigint;
  v_p0 bigint;
  v_adj bigint;
  v_items uuid[];
  v_units integer[];
  v_values bigint[];
  v_split bigint[];
  v_i integer;
  v_overflow boolean := false;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  v_key := _refund_id::text;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er WHERE er.refund_id = _refund_id)
    OR EXISTS (SELECT 1 FROM public.accounting_unit_refund_allocations AS a WHERE a.refund_key = v_key) THEN
    RETURN;
  END IF;
  SELECT f.pre_shipment_amount INTO v_p FROM public.accounting_refund_facts AS f WHERE f.refund_id = _refund_id;
  SELECT COALESCE(pg_catalog.sum(l.amount) FILTER (WHERE l.before_shipment), 0) INTO v_p0
  FROM public.order_refund_lines AS l WHERE l.refund_id = _refund_id;
  v_adj := COALESCE(v_p, 0) - v_p0;
  IF v_adj <= 0 THEN
    RETURN;
  END IF;
  BEGIN
    SELECT COALESCE(pg_catalog.array_agg(v.order_item_id ORDER BY v.order_item_id, v.unit_index), ARRAY[]::uuid[]),
      COALESCE(pg_catalog.array_agg(v.unit_index ORDER BY v.order_item_id, v.unit_index), ARRAY[]::integer[]),
      COALESCE(pg_catalog.array_agg(v.value::bigint ORDER BY v.order_item_id, v.unit_index), ARRAY[]::bigint[])
    INTO v_items, v_units, v_values
    FROM private.accounting_unit_values(v_refund.order_id, NULL) AS v
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu JOIN public.order_refunds AS hr ON hr.id = hu.refund_id
        WHERE hu.order_item_id = v.order_item_id AND hu.unit_index = v.unit_index AND hu.refund_before_shipment AND hr.status <> 'failed') AS held) AS h
    WHERE NOT v.shipped AND v.value > 0 AND NOT h.held;
    IF COALESCE((SELECT pg_catalog.sum(x) FROM pg_catalog.unnest(v_values) AS t(x)), 0) < v_adj THEN
      v_overflow := true;
    ELSE
      v_split := private.accounting_allocate_amount(v_adj, v_values);
      FOR v_i IN 1 .. pg_catalog.cardinality(v_split) LOOP
        IF v_split[v_i] > v_values[v_i] THEN
          v_overflow := true;
        END IF;
      END LOOP;
      IF NOT v_overflow THEN
        FOR v_i IN 1 .. pg_catalog.cardinality(v_split) LOOP
          CONTINUE WHEN v_split[v_i] = 0;
          PERFORM private.accounting_record_unit_refund(v_key, v_items[v_i], v_units[v_i], v_split[v_i]::integer);
        END LOOP;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '55000' AND SQLERRM = 'GROUP_H_LOCK_REQUIRED' THEN
      RAISE;
    END IF;
    v_overflow := true;
  END;
  IF v_overflow THEN
    PERFORM private.accounting_park_event('pre_shipment_refund', 'accounting_unit_refund_allocations', 'allocation:' || v_key,
      v_refund.order_id, 'amount_mismatch', pg_catalog.jsonb_build_object('mismatch', 'allocation_overflow'));
  END IF;
END;
$$;

-- Rule 4: give back what is left of the rows of one key (an event id or a refund id) with negative rows keyed
-- release:<key>:<n>. A unit shipped now keeps its allocation and its price adjust; the result is s = the allocations kept
-- minus the price adjusts kept. The transfer adjusts (shipped units at the event) are always given back.
CREATE FUNCTION private.accounting_release_allocations(_key text, _n integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_release text;
  v_prefix text;
  v_row record;
  v_kept_alloc bigint := 0;
  v_kept_adjust bigint := 0;
  v_seq bigint;
  v_at timestamptz;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  IF _key IS NULL OR _key !~ '^[A-Za-z0-9_.-]{1,100}$' OR _n IS NULL OR _n < 1 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_prefix := 'release:' || _key || ':';
  v_release := v_prefix || _n::text;
  FOR v_row IN
    SELECT a.order_item_id, a.unit_index, pg_catalog.sum(a.amount) AS left_amount
    FROM public.accounting_unit_refund_allocations AS a
    WHERE a.refund_key = _key OR pg_catalog.starts_with(a.refund_key, v_prefix)
    GROUP BY a.order_item_id, a.unit_index ORDER BY a.order_item_id, a.unit_index
  LOOP
    CONTINUE WHEN v_row.left_amount <= 0;
    IF EXISTS (SELECT 1 FROM private.accounting_shipped_units(v_row.order_item_id, NULL) AS s WHERE s.unit_index = v_row.unit_index) THEN
      v_kept_alloc := v_kept_alloc + v_row.left_amount;
    ELSE
      PERFORM private.accounting_record_unit_refund(v_release, v_row.order_item_id, v_row.unit_index, -v_row.left_amount::integer);
    END IF;
  END LOOP;
  FOR v_row IN
    SELECT p.order_item_id, p.unit_index, pg_catalog.min(p.event_id::text)::uuid AS event_id, pg_catalog.sum(p.amount) AS left_amount
    FROM public.accounting_unit_price_adjusts AS p
    WHERE p.adjust_key = _key OR pg_catalog.starts_with(p.adjust_key, v_prefix)
    GROUP BY p.order_item_id, p.unit_index ORDER BY p.order_item_id, p.unit_index
  LOOP
    CONTINUE WHEN v_row.left_amount = 0;
    IF EXISTS (SELECT 1 FROM private.accounting_shipped_units(v_row.order_item_id, NULL) AS s WHERE s.unit_index = v_row.unit_index) THEN
      v_kept_adjust := v_kept_adjust + v_row.left_amount;
    ELSE
      SELECT t.fact_seq, t.locked_at INTO v_seq, v_at FROM private.accounting_take_g_fact_seq() AS t;
      INSERT INTO public.accounting_unit_price_adjusts (order_item_id, unit_index, adjust_key, event_id, amount, fact_seq, locked_at)
      VALUES (v_row.order_item_id, v_row.unit_index, v_release, v_row.event_id, -v_row.left_amount::integer, v_seq, v_at);
    END IF;
  END LOOP;
  FOR v_row IN
    SELECT t.event_id, t.order_item_id, t.unit_index, pg_catalog.sum(t.amount) AS left_amount
    FROM public.accounting_refund_transfer_adjusts AS t
    WHERE t.adjust_key = _key OR pg_catalog.starts_with(t.adjust_key, v_prefix)
    GROUP BY t.event_id, t.order_item_id, t.unit_index ORDER BY t.event_id, t.order_item_id, t.unit_index
  LOOP
    CONTINUE WHEN v_row.left_amount = 0;
    SELECT t.fact_seq, t.locked_at INTO v_seq, v_at FROM private.accounting_take_g_fact_seq() AS t;
    INSERT INTO public.accounting_refund_transfer_adjusts (event_id, adjust_key, order_item_id, unit_index, amount, fact_seq, locked_at)
    VALUES (v_row.event_id, v_release, v_row.order_item_id, v_row.unit_index, -v_row.left_amount::integer, v_seq, v_at);
  END LOOP;
  RETURN (v_kept_alloc - v_kept_adjust)::integer;
END;
$$;

-- The shop's choice for a refund Stripe cancelled (FREQ-579-AC-03 / AC-07): abandoned (the shop gave the refund up) or owed
-- (the shop still owes it). An error refund that never reached Stripe can only be abandoned. Lock order: group G, then
-- accounting (plan 1). Abandoning the only live refund of a pre-shipment cancel event reverts the event (the units can be
-- sent again) and gives the allocations back; s (what could not be given back) stays on the state row.
CREATE FUNCTION private.admin_decide_refund_cancellation(_actor_id uuid, _refund_id uuid, _kind text, _reason text,
  _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_refund public.order_refunds%ROWTYPE;
  v_hash text;
  v_row public.accounting_refund_events%ROWTYPE;
  v_event uuid;
  v_revert uuid;
  v_key text;
  v_n integer;
  v_s integer;
  v_d integer;
BEGIN
  IF NOT COALESCE(private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.entries.correct']), false) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _refund_id IS NULL OR _request_key IS NULL OR _kind IS NULL OR _kind NOT IN ('abandoned', 'owed') OR _reason IS NULL
    OR pg_catalog.btrim(_reason) = '' OR pg_catalog.char_length(_reason) > 500 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[v_refund.order_id], NULL);
  PERFORM private.accounting_lock_all(NULL);
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'decide_refund_cancellation',
    'refund_id', _refund_id, 'kind', _kind, 'reason', _reason, 'actor_id', _actor_id));
  SELECT e.* INTO v_row FROM public.accounting_refund_events AS e WHERE e.request_key = _request_key;
  IF FOUND THEN
    IF v_row.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object('refund_id', _refund_id, 'state', v_row.state,
      'event_id', (SELECT e.id FROM public.order_unit_events AS e
        WHERE v_row.state = 'abandoned' AND e.request_key = pg_catalog.md5('ub_revert:' || _refund_id::text)::uuid
          AND e.kind = 'cancel_reverted'),
      'replayed', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_refund_events AS e WHERE e.refund_id = _refund_id AND e.state IN ('abandoned', 'owed')) THEN
    RAISE EXCEPTION 'ACCOUNTING_REFUND_CANCEL_DECIDED' USING ERRCODE = '55000';
  END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.accounting_refund_events AS e WHERE e.refund_id = _refund_id AND e.state = 'canceled')
    OR (v_refund.status = 'error' AND v_refund.stripe_refund_id IS NULL AND _kind = 'abandoned')) THEN
    RAISE EXCEPTION 'ACCOUNTING_REFUND_NOT_CANCELED' USING ERRCODE = '55000';
  END IF;
  IF _kind = 'owed' THEN
    PERFORM private.accounting_record_refund_event(_refund_id, 'owed', NULL, _actor_id, _reason, _request_key);
    RETURN pg_catalog.jsonb_build_object('refund_id', _refund_id, 'state', 'owed', 'event_id', NULL, 'replayed', false);
  END IF;
  SELECT er.event_id INTO v_event FROM public.order_unit_event_refunds AS er
  JOIN public.order_unit_events AS e ON e.id = er.event_id
  WHERE er.refund_id = _refund_id AND e.kind = 'pre_shipment_cancel' ORDER BY e.seq LIMIT 1;
  IF v_event IS NOT NULL THEN
    IF v_refund.status = 'error' THEN
      -- Refused by the unit binding (ubrr_status): the only way on is to retry the refund at Stripe.
      PERFORM private.order_unit_revert_cancel(_refund_id, _actor_id);
    END IF;
    IF EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er JOIN public.order_refunds AS rf ON rf.id = er.refund_id
        WHERE er.event_id = v_event AND er.refund_id <> _refund_id
          AND (rf.status = 'succeeded'
            OR (rf.status = 'failed' AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
              WHERE x.refund_id = rf.id AND x.state = 'abandoned'))
            OR EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = rf.id AND x.state IN ('owed', 'settled')))) THEN
      -- Another refund of the event moved money or is owed: only this refund is given up (s = 0). The first refund of
      -- the event carries d (the transfer adjusts of the event so far).
      v_d := 0;
      IF NOT EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er
          JOIN public.accounting_refund_events AS x ON x.refund_id = er.refund_id AND x.state = 'requested'
          WHERE er.event_id = v_event AND er.refund_id <> _refund_id
            AND x.fact_seq < COALESCE((SELECT y.fact_seq FROM public.accounting_refund_events AS y
              WHERE y.refund_id = _refund_id AND y.state = 'requested'), 0)) THEN
        SELECT COALESCE(pg_catalog.sum(t.amount), 0)::integer INTO v_d FROM public.accounting_refund_transfer_adjusts AS t
        WHERE t.event_id = v_event;
      END IF;
      PERFORM private.accounting_record_refund_event(_refund_id, 'abandoned', NULL, _actor_id, _reason, _request_key, 0, v_d);
      RETURN pg_catalog.jsonb_build_object('refund_id', _refund_id, 'state', 'abandoned', 'event_id', NULL, 'replayed', false);
    END IF;
    v_revert := private.order_unit_revert_cancel(_refund_id, _actor_id);
    v_key := v_event::text;
  ELSE
    v_key := _refund_id::text;
  END IF;
  SELECT COALESCE(pg_catalog.max(pg_catalog.substring(k.key, ':([0-9]+)$')::integer), 0) + 1 INTO v_n FROM (
    SELECT a.refund_key AS key FROM public.accounting_unit_refund_allocations AS a
    WHERE pg_catalog.starts_with(a.refund_key, 'release:' || v_key || ':')
    UNION ALL
    SELECT p.adjust_key FROM public.accounting_unit_price_adjusts AS p WHERE pg_catalog.starts_with(p.adjust_key, 'release:' || v_key || ':')
    UNION ALL
    SELECT t.adjust_key FROM public.accounting_refund_transfer_adjusts AS t WHERE pg_catalog.starts_with(t.adjust_key, 'release:' || v_key || ':')
  ) AS k;
  v_s := private.accounting_release_allocations(v_key, v_n);
  PERFORM private.accounting_record_refund_event(_refund_id, 'abandoned', NULL, _actor_id, _reason, _request_key, v_s, NULL);
  RETURN pg_catalog.jsonb_build_object('refund_id', _refund_id, 'state', 'abandoned', 'event_id', v_revert, 'replayed', false);
END;
$$;

CREATE FUNCTION public.admin_decide_refund_cancellation(_actor_id uuid, _refund_id uuid, _kind text, _reason text,
  _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_decide_refund_cancellation(_actor_id, _refund_id, _kind, _reason, _request_key) $$;

ALTER FUNCTION private.accounting_record_refund_event(uuid,text,text,uuid,text,uuid,integer,integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_split_refund(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_record_refund_facts(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_record_event_allocations(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_write_refund_allocations(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_release_allocations(text,integer) OWNER TO postgres;
ALTER FUNCTION private.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_record_refund_event(uuid,text,text,uuid,text,uuid,integer,integer), private.accounting_split_refund(uuid),
  private.accounting_record_refund_facts(uuid), private.accounting_record_event_allocations(uuid),
  private.accounting_write_refund_allocations(uuid), private.accounting_release_allocations(text,integer),
  private.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid), public.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid),
  public.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid) TO service_role;
-- ACC_S17_BODY_END


-- ACC_S17_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. A rebuilt body is compared after its replaced parts are restored
-- from the list below (by the md5 on the marker) and every ACC_P<n> block and all white space are removed.
DO $acc_s17_final$
DECLARE
  v_failed text;
  v_stage text;
  v_search_path text;
  v_baseline jsonb;
  v_expected CONSTANT text[][] := ARRAY[
    ARRAY['private.accounting_check_unit_allocation_sum()', 'cd8c242e1aaa65d8fdf842598510d2c7'],
    ARRAY['private.accounting_g_fact_seq_at(timestamp with time zone)', '4bb1e080e0d1c752753210e38a9ab1ca'],
    ARRAY['private.accounting_shipped_units(uuid,bigint)', '2ae1415a059030f33b0e0389661b5dc0'],
    ARRAY['private.accounting_unit_values(uuid,bigint)', '113b693aea0a1e005f9b2ca0ed8a7579'],
    ARRAY['private.accounting_shipment_plan(uuid,bigint)', '8d1e641a2b3f359840900ebe509d1759'],
    ARRAY['private.order_unit_shipped_slots(uuid)', '145fd6dbc93f4442a16ec299a68148b0'],
    ARRAY['private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)', '51f45a207c52a3a31bf8621290683de4'],
    ARRAY['private.record_group_g_refund_result(uuid,text,text,text,text,timestamp with time zone,text,text,text,text,uuid[],jsonb)', '0ded740cce917e0f62f7d54a4114c96b'],
    ARRAY['private.record_external_order_refund(uuid,text,integer,text,text,text,timestamp with time zone,text,text,text,text,timestamp with time zone)', '09c6c5c41269d6d817a874be58ea2235'],
    ARRAY['private.mark_order_refund_error(uuid,text,boolean)', 'ece1034432381dfdb44bc5ac13aedca6']
  ];
  v_new CONSTANT text[] := ARRAY[
    'private.accounting_record_refund_event(uuid,text,text,uuid,text,uuid,integer,integer)',
    'private.accounting_split_refund(uuid)', 'private.accounting_record_refund_facts(uuid)',
    'private.accounting_record_event_allocations(uuid)', 'private.accounting_write_refund_allocations(uuid)',
    'private.accounting_release_allocations(text,integer)', 'private.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid)'];
  v_i integer;
  v_src text;
  v_match text[];
  v_original text;
  v_oid oid;
  v_role text;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s17_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s17_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s17_baseline) <> 1 THEN
    v_failed := 'acc_s17_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s17_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist_md5')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s17_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s17_functions';
  -- acc_s17_functions: the new tools are private, SECURITY DEFINER with search_path '', owned by postgres; nobody may run
  -- the tools; only service_role runs the cancel decision (private body and public entry). The constraint trigger on the
  -- price adjust table is deferred and calls the sum check.
  IF v_failed IS NULL THEN
    FOREACH v_src IN ARRAY v_new LOOP
      v_oid := pg_catalog.to_regprocedure(v_src);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid AND f.prosecdef
          AND f.proowner = 'postgres'::regrole AND f.proconfig = ARRAY['search_path=""']) THEN
        v_failed := 'acc_s17_functions';
      END IF;
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF v_failed IS NULL AND pg_catalog.has_function_privilege(v_role, v_oid, 'EXECUTE')
            <> (v_role = 'service_role' AND v_src LIKE 'private.admin_decide_refund_cancellation(%') THEN
          v_failed := 'acc_s17_functions';
        END IF;
      END LOOP;
      IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee = 0) THEN
        v_failed := 'acc_s17_functions';
      END IF;
    END LOOP;
    v_oid := pg_catalog.to_regprocedure('public.admin_decide_refund_cancellation(uuid,uuid,text,text,uuid)');
    IF v_failed IS NULL AND (v_oid IS NULL
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid AND NOT f.prosecdef
        AND f.proowner = 'postgres'::regrole AND f.proconfig = ARRAY['search_path=""'])
      OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
      OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
        CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
        WHERE f.oid = v_oid AND a.grantee = 0)) THEN
      v_failed := 'acc_s17_functions';
    END IF;
    IF v_failed IS NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
        WHERE t.tgrelid = 'public.accounting_unit_price_adjusts'::regclass AND t.tgname = 'accounting_unit_price_adjusts_sum'
          AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O'
          AND t.tgfoid = 'private.accounting_check_unit_allocation_sum()'::regprocedure) THEN
      v_failed := 'acc_s17_functions';
    END IF;
  END IF;

  v_stage := 'acc_s17_function_attrs';
  -- acc_s17_function_attrs: the ten rebuilt functions keep their arguments, result, language, volatility, security,
  -- owner, search_path and ACL (the baseline read at the start). order_unit_shipped_slots also stays a SQL, STABLE,
  -- SECURITY DEFINER function owned by postgres that nobody may run (migration A). Type names are printed under the
  -- search_path the baseline was read with.
  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'attrs')) <> 10
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'attrs') AS b(sig, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(b.sig)
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::regtype::text, pg_catalog.pg_get_function_arguments(f.oid), pg_catalog.pg_get_function_result(f.oid),
        f.prolang, f.provolatile, f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.order_unit_shipped_slots(uuid)')
        AND f.prolang = (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = 'sql') AND f.provolatile = 's'
        AND f.prosecdef AND f.proowner = 'postgres'::regrole AND f.proconfig = ARRAY['search_path=""']
        AND pg_catalog.pg_get_function_result(f.oid) = 'TABLE(unit_index integer)')
    OR pg_catalog.has_function_privilege('anon', 'private.order_unit_shipped_slots(uuid)'::regprocedure, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', 'private.order_unit_shipped_slots(uuid)'::regprocedure, 'EXECUTE')
    OR pg_catalog.has_function_privilege('service_role', 'private.order_unit_shipped_slots(uuid)'::regprocedure, 'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
      WHERE f.oid = 'private.order_unit_shipped_slots(uuid)'::regprocedure AND a.grantee = 0)) THEN
    v_failed := 'acc_s17_function_attrs';
  END IF;
  PERFORM pg_catalog.set_config('search_path', '', true);

  v_stage := 'acc_s17_body_unchanged';
  -- acc_s17_body_unchanged: each rebuilt body, with its replaced parts restored and every ACC_P<n> block and the white
  -- space removed, is the latest definition (the md5 of that text). The REPLACE pattern starts with a lazy quantifier, so
  -- the whole expression is lazy.
  IF v_failed IS NULL THEN
    FOR v_i IN 1 .. pg_catalog.array_length(v_expected, 1) LOOP
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(v_expected[v_i][1]);
      IF v_src IS NULL THEN
        v_failed := 'acc_s17_body_unchanged';
        EXIT;
      END IF;
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('64894eb91bae4b340a81007fd046adc8', $acc_s17_orig$  IF v_paid IS NULL OR v_total < 0 OR v_total > v_paid THEN
$acc_s17_orig$),
    ('41cae524b90d89ab01bf10f3b609fb26', $acc_s17_orig$  v_history jsonb := '[]'::jsonb;
  v_excluded integer[];
$acc_s17_orig$),
    ('01a5909508da309ef0a08ec17b27d04f', $acc_s17_orig$    v_excluded := ARRAY(
      SELECT DISTINCT e.unit::integer
      FROM pg_catalog.jsonb_array_elements(v_history) AS h(entry)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(h.entry -> 'units') AS e(unit)
      WHERE h.entry -> 'cancel_seq' = 'null'::jsonb OR (h.entry ->> 'cancel_seq')::bigint > v_slip.confirm_seq
      UNION
      SELECT u.unit_index
      FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id = _order_item_id AND u.paid_amount > 0
        AND COALESCE((SELECT pg_catalog.sum(a.amount) FROM public.accounting_unit_refund_allocations AS a
          WHERE a.order_item_id = u.order_item_id AND a.unit_index = u.unit_index
            AND a.fact_seq < v_slip.confirm_seq), 0) = u.paid_amount);
    v_taken := ARRAY(
      SELECT u.unit_index FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id = _order_item_id AND NOT (u.unit_index = ANY (v_excluded))
      ORDER BY u.unit_index LIMIT v_slip.quantity);
    v_history := v_history || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'confirm_seq', v_slip.confirm_seq, 'cancel_seq', v_slip.cancel_seq, 'units', pg_catalog.to_jsonb(v_taken)));
    IF v_slip.cancel_seq IS NULL OR (_as_of_seq IS NOT NULL AND v_slip.cancel_seq > _as_of_seq) THEN
$acc_s17_orig$),
    ('9fe7573e0b35dbdf940aeee14e99563e', $acc_s17_orig$    (u.paid_amount - COALESCE((SELECT pg_catalog.sum(a.amount) FROM public.accounting_unit_refund_allocations AS a
$acc_s17_orig$),
    ('c12b6619cea873b7a602feab106de6a7', $acc_s17_orig$  SELECT u.unit_index FROM public.order_line_unit_amounts AS u
  WHERE u.order_item_id = _order_item_id
  ORDER BY EXISTS (SELECT 1 FROM public.order_refunds AS r WHERE r.id = u.refund_id AND u.refund_before_shipment AND r.status <> 'failed'),
    u.unit_index
  LIMIT (SELECT pg_catalog.count(*) FROM private.accounting_shipped_units(_order_item_id, NULL))
$acc_s17_orig$),
    ('c01e15507250e34b6d2a1bfdbcd174ce', $acc_s17_orig$                   THEN private.return_units_amount(oi.id,l.unshipped)
$acc_s17_orig$),
    ('98f00c81d0589400b154c8e82ad06e31', $acc_s17_orig$        v_h_amount:=private.group_h_claim_refund_units(v_refund_id,v_h_line.order_item_id,v_h_line.quantity,true,NULL);
$acc_s17_orig$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s17_body_unchanged';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
      END LOOP;
      EXIT WHEN v_failed IS NOT NULL;
      IF pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM v_expected[v_i][2] THEN
        v_failed := 'acc_s17_body_unchanged';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s17_g_allowlist_unchanged';
  -- acc_s17_g_allowlist_unchanged: the group G writer list is what it was at the start of this migration.
  IF v_failed IS NULL AND (SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(w.proc::oid::text, ',' ORDER BY w.proc::oid), ''))
      FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)) IS DISTINCT FROM (v_baseline ->> 'allowlist_md5') THEN
    v_failed := 'acc_s17_g_allowlist_unchanged';
  END IF;

  v_stage := 'acc_s17_existing_dml_allowlist';
  -- acc_s17_existing_dml_allowlist: this migration writes no row.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_unit_refund_allocations) IS DISTINCT FROM (v_baseline #>> '{counts,allocations}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_unit_price_adjusts) IS DISTINCT FROM (v_baseline #>> '{counts,price_adjusts}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_transfer_adjusts) IS DISTINCT FROM (v_baseline #>> '{counts,transfer_adjusts}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_events) IS DISTINCT FROM (v_baseline #>> '{counts,refund_events}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_facts) IS DISTINCT FROM (v_baseline #>> '{counts,refund_facts}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline #>> '{counts,pending_events}')::bigint) THEN
    v_failed := 'acc_s17_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s17_functions'), HINT = SQLSTATE;
END;
$acc_s17_final$;
-- ACC_S17_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
