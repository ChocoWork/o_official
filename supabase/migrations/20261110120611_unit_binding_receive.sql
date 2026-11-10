BEGIN;

-- Unit binding, migration C (FREQ-642), 2026-11-10: the receive prices its refund from the plan, ties the exchange units to
-- the slots, writes the discount treatments, and a refund result retried after an error takes back the event's units.
-- @impl FREQ-642-AC-02 FREQ-642-AC-04 FREQ-642-AC-05 FREQ-642-AC-06 FREQ-642-AC-17 FREQ-642-AC-20 FREQ-642-AC-25 FREQ-642-AC-31
-- @design docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md docs/04_DetailDesign/pages/16_admin.md DD-ADMIN-017
-- 1. private.admin_receive_return and its public entry take a 15th argument _pricing jsonb (DEFAULT NULL) and return release_refund_ids uuid[]
--    (always empty until the hold-release refunds of the next migration). The 14 argument functions are dropped and the G writer
--    allowlist names the new signature (still 77 entries).
--    - An order with a discount snapshot needs a plan (UNIT_PRICING_REQUIRED / 22023); an order without one refuses a plan
--      (UNIT_PRICING_INVALID, detail ub_legacy) and keeps the body of 20261108063711 as it was (restocking rate on the goods, H cheapest-first).
--    - A replay by request key is answered before any plan or version check.
--    - The plan is applied by private.order_unit_apply_plan. The goods amount is the plan's nowRefund (the restocking rate is inside E; only the
--      return shipping fee and the exchange fees remain as fees). The refund row, its lines (allocations of the now units) and the claims on the
--      returned units are written here and tied to the event with private.order_unit_link_refund. The core's H claim is not used for such an order.
--    - Exchange units: one order_unit_exchange_links row per unit; the slot's holder becomes the exchange unit; exchange_paid_amount is the sum of the
--      linked slots' prices after the event (display only).
--    - Discount treatments of the plan are written to order_return_line_treatments (receipt and actor).
--    - The member's related orders are locked together with the order, after the advisory lock.
-- 2. private.record_group_g_refund_result: a refund tied to an event, retried after an error (error -> pending / succeeded), takes back the units
--    of the event's returned lines for its part (units held by another refund in error or failed are released first); never by position.
--    failed releases the claims and never changes a slot state. A refund not tied to an event is handled as before.
-- Applied migrations are never edited.

-- UBR_BASELINE_BEGIN
CREATE TEMP TABLE ubr_writer_baseline ON COMMIT DROP AS
SELECT x::oid AS oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x);
-- UBR_BASELINE_END

-- UBR_FUNCTIONS_BEGIN
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
  v_unshipped integer;
  v_constraint text;
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
      COALESCE((SELECT pg_catalog.array_agg(er.refund_id ORDER BY er.refund_id) FROM public.order_unit_event_refunds AS er
        JOIN public.order_unit_events AS ev ON ev.id=er.event_id WHERE ev.receipt_id=v_old.id AND er.part='release'),ARRAY[]::uuid[])
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
      -- and unit_index order. A slot the plan returns is not taken. The exchange
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
  IF v_refund IS NOT NULL AND v_slot THEN
    -- The refund of the now units is made here from the plan (the H cheapest-first claim of the core does not apply): the event's
    -- returned units get the refund claim through order_unit_link_refund, the lines carry the allocations of those units.
    IF EXISTS (SELECT 1 FROM public.order_refunds AS rf WHERE rf.order_id=v_order AND rf.status='awaiting_response') THEN
      RAISE EXCEPTION 'AWAITING_REFUND_EXISTS' USING ERRCODE='22023'; END IF;
    IF v_amount<1 OR _refund_shipping_amount>v_amount THEN RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    SELECT COALESCE(pg_catalog.sum(l.unshipped),0)::integer INTO v_unshipped FROM private.order_line_fulfillment(v_order) AS l;
    IF v_amount=v_refundable AND v_unshipped>0 THEN RAISE EXCEPTION 'REFUND_MUST_INCLUDE_UNSHIPPED' USING ERRCODE='22023'; END IF;
    BEGIN
      INSERT INTO public.order_refunds(id,return_id,order_id,source,request_key,request_fingerprint,status,amount,shipping_amount,
        adjustment_amount,note,stripe_reason,cancel_reason,notify_customer,actor_id,return_fee_deduction)
      SELECT v_refund,_return_id,v_order,'return',_request_key,v_fp,'awaiting_response',v_amount,_refund_shipping_amount,
        v_amount-(COALESCE(pg_catalog.sum(l.allocation),0)::integer+_refund_shipping_amount),_note,'requested_by_customer',NULL,
        _notify_customer,_actor_id,LEAST(v_fees,v_goods)
      FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,part text,allocation integer)
      WHERE l."lineKind"='returned' AND l.part='now';
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'order_refunds_request_key_key' THEN RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
      RAISE;
    END;
    INSERT INTO public.order_refund_lines(refund_id,order_item_id,quantity,before_shipment,restock_type,amount)
    SELECT v_refund,c.item,c.n,false,'return',c.amount
    FROM (SELECT rl.order_item_id AS item,pg_catalog.count(*)::integer AS n,pg_catalog.sum(l.allocation)::integer AS amount
      FROM pg_catalog.jsonb_to_recordset(v_pricing->'lines') AS l("lineKind" text,part text,"returnLineId" uuid,allocation integer)
      JOIN public.order_return_lines AS rl ON rl.id=l."returnLineId"
      WHERE l."lineKind"='returned' AND l.part='now' GROUP BY rl.order_item_id) AS c;
    PERFORM private.order_unit_link_refund(v_event,v_refund,'now');
    v_status:='awaiting_response';
    PERFORM private.group_h_release_return_units(_return_id);
  ELSIF v_refund IS NOT NULL THEN
    SELECT r.refund_id,r.amount,r.status INTO v_refund,v_amount,v_status
    FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,_refund_shipping_amount,v_amount,
      _note,'requested_by_customer',NULL,_notify_customer,_actor_id,_refund_amount,_return_id,LEAST(v_fees,v_goods)) AS r;
    -- The claim may change which units stay bound; settle the release in the same lock.
    PERFORM private.group_h_release_return_units(_return_id);
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

CREATE OR REPLACE FUNCTION public.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text, _pricing jsonb DEFAULT NULL
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean,
  release_refund_ids uuid[])
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  SELECT * FROM private.admin_receive_return(_return_id, _actor_id, _actor_can_refund, _request_key, _units, _exchange_overrides, _refund_choice, _refund_amount, _refund_shipping_amount, _note, _notify_customer, _sent_back_message, _sent_back_carrier, _sent_back_tracking_number, _pricing);
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
    FOR v_h_line IN SELECT l.* FROM public.order_refund_lines AS l WHERE l.refund_id=_refund_id AND NOT v_linked
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
    'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)',
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
    'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)',
    'private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text)'
  ]::pg_catalog.regprocedure[];
$$;

DROP FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text);
DROP FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text);
-- UBR_FUNCTIONS_END

-- UBR_ACL_BEGIN
ALTER FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb) TO service_role;
ALTER FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb) TO service_role;
ALTER FUNCTION private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_g_writer_allowlist() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_writer_allowlist() FROM PUBLIC, anon, authenticated, service_role;
-- UBR_ACL_END

-- UBR_FINAL_ASSERT_BEGIN
DO $ubr_final$
DECLARE
  e record; p record; v_oid oid; v_detail text; v_old oid; v_new oid;
BEGIN
  -- ubr_functions: owner, security, settings, volatility, language and the exact body; the 14 argument functions are gone and each
  -- name has one definition in its schema.
  FOR e IN SELECT * FROM (VALUES
    ('private', 'admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)', 'v', true, 'plpgsql', '2a532f2b98a59718ba74409828ccac1b'),
    ('public', 'admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)', 'v', false, 'sql', 'dd060b0e28ac9450ca5f2fc218658b03'),
    ('private', 'record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)', 'v', true, 'plpgsql', '4b6d2ce680d8db576cd1a9aadd4c4b22'),
    ('private', 'group_g_writer_allowlist()', 's', true, 'sql', '0c8a984982e81ef0342e3af887c93689')
  ) AS expected(schema_name, signature, volatility, definer, lang, body_md5) LOOP
    v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
    SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
    IF NOT FOUND OR p.proowner <> 'postgres'::regrole OR p.prosecdef <> e.definer OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
      OR p.provolatile <> e.volatility::"char" OR p.prokind <> 'f' OR p.prolang <> (SELECT l.oid FROM pg_catalog.pg_language AS l WHERE l.lanname = e.lang)
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r', '')) <> e.body_md5
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
        WHERE n.nspname = e.schema_name AND f.proname = pg_catalog.split_part(e.signature, '(', 1)) <> 1 THEN
      v_detail := 'ubr_functions'; EXIT;
    END IF;
  END LOOP;
  IF v_detail IS NULL AND (pg_catalog.to_regprocedure('private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)') IS NOT NULL) THEN
    v_detail := 'ubr_functions';
  END IF;
  -- ubr_acl: service_role runs the receive entry and its body only.
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)', true),
      ('public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)', true),
      ('private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)', false),
      ('private.group_g_writer_allowlist()', false)
    ) AS expected(signature, service) LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') <> e.service
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
        v_detail := 'ubr_acl'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- ubr_allowlist: the writer list keeps its 77 entries; only the receive entry is the new signature.
  IF v_detail IS NULL THEN
    v_new := pg_catalog.to_regprocedure('private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text,jsonb)')::oid;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.unnest(private.group_g_writer_allowlist())) <> 77
      OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x)) <> 77
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x) WHERE x::oid = v_new)
      OR (SELECT pg_catalog.count(*) FROM ubr_writer_baseline) <> 77
      OR EXISTS (SELECT 1 FROM ubr_writer_baseline AS b
        WHERE b.oid <> ALL (SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))
          AND b.oid IN (SELECT f.oid FROM pg_catalog.pg_proc AS f WHERE f.oid = b.oid)) THEN
      v_detail := 'ubr_allowlist';
    END IF;
  END IF;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'UNIT_BINDING_RECEIVE_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL = v_detail;
  END IF;
END;
$ubr_final$;
-- UBR_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
