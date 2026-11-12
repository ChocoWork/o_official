BEGIN;

-- Unit binding, owner fix X4 (FREQ-642-AC-37), 2026-11-12: after the receive-time ("now") refund of a return failed, the shop refunds again
-- through the one refund action of the return (admin_refund_return). Migrations A-D are applied and never edited; this file replaces
-- three function bodies with the same signatures and widens one primary key.
-- @impl FREQ-642-AC-37
-- @design docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md docs/04_DetailDesign/pages/16_admin.md
-- Rule. For a return on the slot path, the refund made by admin_refund_return covers, for each return_receive event of that return that
-- is not reverted:
--   - its part 'now' returned lines, when the event has now lines, a refund linked with part 'now' whose status is 'failed', and no
--     refund linked with part 'now' whose status is not 'failed' (a now part that was never refunded, because the receive ended it at
--     0 yen, is not covered: its units are not waiting);
--   - its part 'consult' returned lines, when the event has consult lines and no refund linked with part 'consult' whose status is not
--     'failed';
--   - in both cases only when the part was not closed by "refund nothing" (admin_refund_return with amount 0 records the (event, part)
--     it closed in public.order_unit_event_waives; those units are refund_waived and never waiting again).
--   The standard amount is the sum over the covered (event, part) of the event's stored now_refund or consult_refund (allocations are
--   never recomputed). order_unit_event_refunds gets one row per covered (event, part); the units of the covered lines get the refund
--   claim with the same amounts (order_unit_link_refund). A refund that is pending, awaiting_response or error is live and is not covered
--   again. Legacy orders (no snapshot) and replays by request key are unchanged.
-- 1. public.order_unit_event_refunds: the primary key becomes (event_id, refund_id, part), so one refund may cover both parts of the same
--    event. The append-only triggers, the index on refund_id, RLS and the ACL are unchanged.
-- 2. private.order_unit_return_refund_parts(uuid) (new, STABLE reader): the (event, part, amount) the rule above covers for a return.
--    admin_refund_return and the core both read it, so the standard amount and the linked parts cannot drift apart.
-- 3. private.order_unit_link_refund(uuid,uuid,text): a second part of the same (event, refund) is added instead of refused; a 'release'
--    row still cannot share an (event, refund) with another part (ub_link_2).
-- 4. private.begin_order_refund_core (16 arguments): the refund of a return made after the receive (the former consult refund) covers
--    the (event, part) of order_unit_return_refund_parts; its lines are the returned lines of those parts, and each part is linked.
-- 5. private.admin_refund_return (8 arguments): the standard amount and the event passed to the core come from the same reader.
-- 6. public.order_unit_event_waives (new, append-only): the (event, part) a refund of nothing (amount 0, waive_refund receipt) closed.
--    admin_refund_return writes it from the same reader, and the reader skips those parts; it refuses the refund of nothing with
--    ub_refund_lines when the units of those parts are not exactly the waiting units (a now refund in error). The migration stops (ubx_waive_backfill)
--    when a return with receive events already has a waive_refund receipt, because which parts it closed cannot be told afterwards.
-- private.group_g_writer_allowlist is unchanged (no signature changes).
-- Applied migrations are never edited.

-- UBX_BASELINE_BEGIN
CREATE TEMP TABLE ubx_writer_baseline ON COMMIT DROP AS
SELECT x::oid AS oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x);
-- UBX_BASELINE_END

-- UBX_WAIVE_GUARD_BEGIN
DO $ubx_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_return_receipts AS rr
      WHERE rr.kind = 'waive_refund'
        AND EXISTS (SELECT 1 FROM public.order_unit_events AS e WHERE e.return_id = rr.return_id AND e.kind = 'return_receive')) THEN
    RAISE EXCEPTION 'UNIT_BINDING_REFUND_RETRY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = 'ubx_waive_backfill';
  END IF;
END;
$ubx_guard$;
-- UBX_WAIVE_GUARD_END

-- UBX_SCHEMA_BEGIN
ALTER TABLE public.order_unit_event_refunds DROP CONSTRAINT order_unit_event_refunds_pkey;
ALTER TABLE public.order_unit_event_refunds ADD CONSTRAINT order_unit_event_refunds_pkey PRIMARY KEY (event_id, refund_id, part);

CREATE TABLE public.order_unit_event_waives (
  event_id uuid NOT NULL REFERENCES public.order_unit_events(id) ON DELETE RESTRICT,
  part text NOT NULL CHECK (part IN ('now', 'consult')),
  receipt_id uuid NOT NULL REFERENCES public.order_return_receipts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_unit_event_waives_pkey PRIMARY KEY (event_id, part)
);
CREATE INDEX order_unit_event_waives_receipt_idx ON public.order_unit_event_waives(receipt_id);
CREATE TRIGGER ub_order_unit_event_waives_immutable BEFORE UPDATE OR DELETE ON public.order_unit_event_waives
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_event_waives_truncate BEFORE TRUNCATE ON public.order_unit_event_waives
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
ALTER TABLE public.order_unit_event_waives ENABLE ALWAYS TRIGGER ub_order_unit_event_waives_immutable;
ALTER TABLE public.order_unit_event_waives ENABLE ALWAYS TRIGGER ub_order_unit_event_waives_truncate;
ALTER TABLE public.order_unit_event_waives OWNER TO postgres;
ALTER TABLE public.order_unit_event_waives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deny direct client access" ON public.order_unit_event_waives;
CREATE POLICY "deny direct client access" ON public.order_unit_event_waives
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.order_unit_event_waives FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.order_unit_event_waives TO service_role;
-- UBX_SCHEMA_END

-- UBX_FUNCTIONS_BEGIN
-- The (event, part) the refund of a return made after the receive covers, with the event's stored amount for that part (FREQ-642-AC-37):
-- per return_receive event of the return that is not reverted, the consult part when no live consult refund covers it, and the now part
-- when its now refund failed and no live now refund covers it; a part a refund of nothing closed (order_unit_event_waives) never again.
-- Ordered by the event's seq, then the part.
CREATE FUNCTION private.order_unit_return_refund_parts(_return_id uuid)
RETURNS TABLE(event_id uuid, part text, amount integer, seq bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.id, p.part, CASE p.part WHEN 'now' THEN e.now_refund ELSE e.consult_refund END, e.seq
  FROM public.order_unit_events AS e
  CROSS JOIN (VALUES ('consult'::text), ('now'::text)) AS p(part)
  WHERE _return_id IS NOT NULL AND e.return_id = _return_id AND e.kind = 'return_receive'
    AND NOT EXISTS (SELECT 1 FROM public.order_unit_events AS r WHERE r.reverts_event_id = e.id)
    AND EXISTS (SELECT 1 FROM public.order_unit_event_lines AS l
      WHERE l.event_id = e.id AND l.line_kind = 'returned' AND COALESCE(l.part, 'now') = p.part)
    AND NOT EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er JOIN public.order_refunds AS rf ON rf.id = er.refund_id
      WHERE er.event_id = e.id AND er.part = p.part AND rf.status <> 'failed')
    AND (p.part = 'consult' OR EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er JOIN public.order_refunds AS rf ON rf.id = er.refund_id
      WHERE er.event_id = e.id AND er.part = 'now' AND rf.status = 'failed'))
    AND NOT EXISTS (SELECT 1 FROM public.order_unit_event_waives AS w WHERE w.event_id = e.id AND w.part = p.part)
  ORDER BY e.seq, p.part
$$;

CREATE OR REPLACE FUNCTION private.order_unit_link_refund(_event_id uuid, _refund_id uuid, _part text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event public.order_unit_events; v_refund public.order_refunds; v_g record;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  SELECT e.* INTO v_event FROM public.order_unit_events AS e WHERE e.id = _event_id;
  SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
  IF v_event.id IS NULL OR v_refund.id IS NULL OR v_refund.order_id <> v_event.order_id OR _part IS NULL OR _part NOT IN ('now', 'consult', 'release') THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_link_1';
  END IF;
  -- X4: one refund may cover the now and the consult part of the same event (FREQ-642-AC-37); a release never shares an (event, refund).
  IF EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er WHERE er.event_id = _event_id AND er.refund_id = _refund_id
      AND er.part <> _part AND 'release' IN (er.part, _part)) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE = '22023', DETAIL = 'ub_link_2';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er
      WHERE er.event_id = _event_id AND er.refund_id = _refund_id AND er.part = _part) THEN
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
  RETURN QUERY SELECT v_refund_id, v_amount, 'awaiting_response'::text, false;
END;
$$;

CREATE OR REPLACE FUNCTION private.admin_refund_return(
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
    -- The standard amount is the stored amount of every (event, part) the refund covers (R34, FREQ-642-AC-37): the consult part no live
    -- consult refund covers and the now part whose now refund failed. The core links the same (event, part) and the screen
    -- (loadConsultOutstanding) counts the same. A manager's change of an earlier refund is not carried.
    SELECT COALESCE(pg_catalog.sum(c.amount),0)::integer INTO v_goods
    FROM private.order_unit_return_refund_parts(_return_id) AS c
    JOIN public.order_unit_events AS e ON e.id=c.event_id AND e.order_id=v_order;
    SELECT c.event_id INTO v_event FROM private.order_unit_return_refund_parts(_return_id) AS c
    JOIN public.order_unit_events AS e ON e.id=c.event_id AND e.order_id=v_order
    ORDER BY c.seq DESC LIMIT 1;
    IF v_event IS NULL THEN RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_refund_event'; END IF;
  END IF;
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  v_cap:=GREATEST(v_goods-v_return.fee_pending_deduction,0)+_shipping_amount;
  v_amount:=COALESCE(_amount,v_cap);
  IF v_amount<_shipping_amount
    OR (_amount IS NOT NULL AND _amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a)) THEN
    RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  -- A refund of nothing closes every waiting unit, so on the slot path it is refused, as the core refuses a refund, unless the units of
  -- the parts it records are exactly the waiting units (a now refund in error keeps its units waiting but its part live) (FREQ-642-AC-37).
  IF v_slot AND v_amount=0 AND EXISTS (
    SELECT 1 FROM (SELECT l.holder_order_item_id AS item,pg_catalog.count(*)::integer AS n
        FROM public.order_unit_event_lines AS l
        JOIN private.order_unit_return_refund_parts(_return_id) AS c ON c.event_id=l.event_id AND c.part=COALESCE(l.part,'now')
        WHERE l.line_kind='returned' GROUP BY l.holder_order_item_id) AS g
    FULL JOIN pg_catalog.jsonb_to_recordset(v_lines) AS p(order_item_id uuid,quantity integer) ON p.order_item_id=g.item
    WHERE g.item IS NULL OR p.order_item_id IS NULL OR g.n<>p.quantity) THEN
    RAISE EXCEPTION 'UNIT_PRICING_INVALID' USING ERRCODE='22023',DETAIL='ub_refund_lines'; END IF;
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
    -- The (event, part) this refund of nothing closes are never covered again (FREQ-642-AC-37); read before the receipt lines.
    IF v_slot THEN
      INSERT INTO public.order_unit_event_waives(event_id,part,receipt_id)
      SELECT c.event_id,c.part,v_receipt.id FROM private.order_unit_return_refund_parts(_return_id) AS c
      JOIN public.order_unit_events AS e ON e.id=c.event_id AND e.order_id=v_order;
    END IF;
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
-- UBX_FUNCTIONS_END

-- UBX_ACL_BEGIN
ALTER FUNCTION private.order_unit_return_refund_parts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_unit_return_refund_parts(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.order_unit_link_refund(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_unit_link_refund(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb) TO service_role;
-- UBX_ACL_END

-- UBX_FINAL_ASSERT_BEGIN
DO $ubx_final$
DECLARE
  e record; p record; v_oid oid; v_detail text;
BEGIN
  -- ubx_schema: the primary key is (event_id, refund_id, part); the append-only triggers and the refund index are still there.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = 'public.order_unit_event_refunds'::regclass
        AND c.contype = 'p' AND c.conname = 'order_unit_event_refunds_pkey'
        AND pg_catalog.pg_get_constraintdef(c.oid) = 'PRIMARY KEY (event_id, refund_id, part)') <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid = 'public.order_unit_event_refunds'::regclass
        AND NOT g.tgisinternal AND g.tgfoid = 'private.group_h_immutable()'::regprocedure AND g.tgenabled = 'A'
        AND g.tgname IN ('ub_order_unit_event_refunds_immutable', 'ub_order_unit_event_refunds_truncate')) <> 2
    OR pg_catalog.to_regclass('public.order_unit_event_refunds_refund_idx') IS NULL
    -- the waive table: its primary key, the append-only triggers, row level security with the deny policy, and the receipt index.
    OR pg_catalog.to_regclass('public.order_unit_event_waives') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = 'public.order_unit_event_waives'::regclass
        AND c.contype = 'p' AND c.conname = 'order_unit_event_waives_pkey'
        AND pg_catalog.pg_get_constraintdef(c.oid) = 'PRIMARY KEY (event_id, part)') <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid = 'public.order_unit_event_waives'::regclass
        AND NOT g.tgisinternal AND g.tgfoid = 'private.group_h_immutable()'::regprocedure AND g.tgenabled = 'A'
        AND g.tgname IN ('ub_order_unit_event_waives_immutable', 'ub_order_unit_event_waives_truncate')) <> 2
    OR NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.order_unit_event_waives'::regclass)
    OR (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.order_unit_event_waives'::regclass) <> 'postgres'::regrole
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pl WHERE pl.polrelid = 'public.order_unit_event_waives'::regclass
        AND pl.polname = 'deny direct client access' AND NOT pl.polpermissive)
    OR pg_catalog.to_regclass('public.order_unit_event_waives_receipt_idx') IS NULL THEN
    v_detail := 'ubx_schema';
  END IF;
  -- ubx_functions: owner, security, settings, volatility, language and the exact body of every function of this file; one definition per name.
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private', 'order_unit_return_refund_parts(uuid)', 's', true, 'sql', 'f06102e781df4a51a2ad72ed7737e6f1'),
      ('private', 'order_unit_link_refund(uuid,uuid,text)', 'v', true, 'plpgsql', '770d04fd130a4d6f060ae70d9c3df437'),
      ('private', 'begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)', 'v', false, 'plpgsql', 'e91248b97111c303e7d9b5f301395a41'),
      ('private', 'admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', 'v', true, 'plpgsql', '77c3f0a6220cf171d07c7dc28a5b05b1')
    ) AS expected(schema_name, signature, volatility, definer, lang, body_md5) LOOP
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF NOT FOUND OR p.proowner <> 'postgres'::regrole OR p.prosecdef <> e.definer OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
        OR p.provolatile <> e.volatility::"char" OR p.prokind <> 'f' OR p.prolang <> (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = e.lang)
        OR pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r', '')) <> e.body_md5
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
          WHERE n.nspname = e.schema_name AND f.proname = pg_catalog.split_part(e.signature, '(', 1)) <> 1 THEN
        v_detail := 'ubx_functions'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- ubx_acl: service_role runs the return refund entry and its private body only; the reader, the link and the core are for the bodies.
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.order_unit_return_refund_parts(uuid)', false),
      ('private.order_unit_link_refund(uuid,uuid,text)', false),
      ('private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer,uuid)', false),
      ('private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', true),
      ('public.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean,jsonb)', true)
    ) AS expected(signature, service) LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF NOT FOUND OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') <> e.service
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
        v_detail := 'ubx_acl'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- ubx_acl: the waive table is read by service_role only and written by admin_refund_return only.
  IF v_detail IS NULL AND (
    pg_catalog.has_table_privilege('anon', 'public.order_unit_event_waives', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_table_privilege('authenticated', 'public.order_unit_event_waives', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR NOT pg_catalog.has_table_privilege('service_role', 'public.order_unit_event_waives', 'SELECT')
    OR pg_catalog.has_table_privilege('service_role', 'public.order_unit_event_waives', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
    v_detail := 'ubx_acl';
  END IF;
  -- ubx_allowlist: the writer list is exactly the one before this file (77 entries; no signature changed).
  IF v_detail IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.unnest(private.group_g_writer_allowlist())) <> 77
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x)) <> 77
    OR (SELECT pg_catalog.count(*) FROM ubx_writer_baseline) <> 77
    OR EXISTS (SELECT b.oid FROM ubx_writer_baseline AS b
      EXCEPT SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))) THEN
    v_detail := 'ubx_allowlist';
  END IF;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'UNIT_BINDING_REFUND_RETRY_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = v_detail;
  END IF;
END;
$ubx_final$;
-- UBX_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
