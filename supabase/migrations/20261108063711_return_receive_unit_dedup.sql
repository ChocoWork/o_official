BEGIN;

-- Return receive unit counting (I-1) and the consult count on a receive receipt (N-1), 2026-11-08.
-- @impl FREQ-641-AC-01 FREQ-641-AC-07
-- @design docs/04_DetailDesign/pages/16_admin.md DD-ADMIN-017 DD-ADMIN-018 DD-ADMIN-020
-- I-1: the receive cap, the receipt refund price, the exchange price and the screen preview took free units
-- line by line with private.group_h_return_line_amount, so two lines of one item could count the same free unit
-- while the claim (group_h_return_refund_slices -> group_h_claim_refund_units) takes each unit once. They now use one
-- free queue per item in the claim's order: line id order, own units then free units, cheapest first, now before consult.
-- N-1: order_return_receipts.consult_quantity keeps the consult units the receive made waiting. NULL is a receipt
-- written before this migration. The fingerprint and the replay check do not include it.
-- Applied migrations, signatures, grants and the G writer allowlist are not changed here.

-- RD_SCHEMA_BEGIN
ALTER TABLE public.order_return_receipts ADD COLUMN consult_quantity integer;
ALTER TABLE public.order_return_receipts ADD CONSTRAINT order_return_receipts_consult_quantity_check CHECK (
  consult_quantity IS NULL OR consult_quantity>=0);
-- RD_SCHEMA_END

-- Elements may carry unit_offset (own units to skip) and refund_choice; a consult element comes after every now
-- (or untagged) element of the item. Free units are one queue per item, so no two lines price the same free unit.
CREATE OR REPLACE FUNCTION private.group_h_receiving_amount(_return_id uuid,_order_item_id uuid,_quantity integer,_effective jsonb)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_left integer:=_quantity;v_amount bigint:=0;v_line record;v_take integer;v_offset integer;v_own integer[];
  v_free integer[];v_used integer:=0;v_own_take integer;v_part integer[];
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=_order_item_id) THEN
    SELECT COALESCE(pg_catalog.array_agg(u.paid_amount ORDER BY u.paid_amount,u.unit_index),ARRAY[]::integer[]) INTO v_free
      FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id=_order_item_id AND u.return_line_id IS NULL AND u.refund_id IS NULL;
  END IF;
  FOR v_line IN SELECT l.id,pg_catalog.sum(x.quantity)::integer AS picked,pg_catalog.max(x.unit_offset) AS unit_offset,p.refund_waiting
    FROM pg_catalog.jsonb_to_recordset(_effective) AS x(return_line_id uuid,resolution text,quantity integer,unit_offset integer,refund_choice text)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id AND l.order_item_id=_order_item_id AND x.resolution='refund'
    GROUP BY l.id,p.refund_waiting,x.refund_choice ORDER BY (x.refund_choice IS NOT DISTINCT FROM 'consult'),l.id LOOP
    EXIT WHEN v_left=0;
    v_take:=LEAST(v_left,v_line.picked);
    v_offset:=COALESCE(v_line.unit_offset,v_line.refund_waiting);
    IF v_free IS NULL THEN
      v_amount:=v_amount+private.group_h_return_line_amount(v_line.id,v_take,v_offset);
    ELSE
      IF v_take IS NULL OR v_offset IS NULL OR v_take<0 OR v_offset<0 THEN
        RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      SELECT COALESCE(pg_catalog.array_agg(b.paid_amount ORDER BY b.remaining_index),ARRAY[]::integer[]) INTO v_own
        FROM private.group_h_return_unit_rows(v_line.id) AS b WHERE b.remaining_index IS NOT NULL;
      v_own_take:=LEAST(v_take,GREATEST(pg_catalog.cardinality(v_own)-v_offset,0));
      v_part:=v_own[(v_offset+1):(v_offset+v_own_take)]
        ||COALESCE(v_free[(v_used+1):(v_used+v_take-v_own_take)],ARRAY[]::integer[]);
      IF pg_catalog.cardinality(v_part)<>v_take THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      v_amount:=v_amount+COALESCE((SELECT pg_catalog.sum(x.amount) FROM pg_catalog.unnest(v_part) AS x(amount)),0);
      v_used:=v_used+v_take-v_own_take;
    END IF;
    v_left:=v_left-v_take;
  END LOOP;
  IF v_left IS NULL OR v_left<>0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_amount::integer;
END;
$$;

-- Receipt amounts follow the slices: own units after the slice offset, then free units from one shared queue
-- (the order group_h_claim_refund_units takes them). Receipt-less amounts are unchanged.
CREATE OR REPLACE FUNCTION private.group_h_return_refund_amount(_return_id uuid,_order_item_id uuid,_quantity integer,_request_key uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_left integer:=_quantity; v_amount bigint:=0; v_line record; v_take integer; v_own integer; v_free integer[];
  v_used integer:=0; v_part integer[]; v_units integer[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=_order_item_id) THEN
    RETURN private.return_units_amount(_order_item_id,_quantity); END IF;
  IF _quantity IS NULL OR _quantity<0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.order_return_receipts AS rc WHERE rc.return_id=_return_id AND rc.request_key=_request_key
    AND rc.kind='receive') THEN
    SELECT COALESCE(pg_catalog.array_agg(u.paid_amount ORDER BY u.paid_amount,u.unit_index),ARRAY[]::integer[]) INTO v_free
      FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id=_order_item_id AND u.return_line_id IS NULL AND u.refund_id IS NULL;
    FOR v_line IN SELECT s.* FROM private.group_h_return_refund_slices(_return_id,_order_item_id,_quantity,_request_key) AS s LOOP
      v_take:=v_line.quantity;
      SELECT COALESCE(pg_catalog.array_agg(b.paid_amount ORDER BY b.remaining_index),ARRAY[]::integer[]) INTO v_units
        FROM private.group_h_return_unit_rows(v_line.return_line_id) AS b WHERE b.remaining_index IS NOT NULL;
      v_own:=LEAST(v_take,GREATEST(pg_catalog.cardinality(v_units)-v_line.unit_offset,0));
      v_part:=v_units[(v_line.unit_offset+1):(v_line.unit_offset+v_own)]
        ||COALESCE(v_free[(v_used+1):(v_used+v_take-v_own)],ARRAY[]::integer[]);
      IF pg_catalog.cardinality(v_part)<>v_take THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      v_amount:=v_amount+COALESCE((SELECT pg_catalog.sum(x.amount) FROM pg_catalog.unnest(v_part) AS x(amount)),0);
      v_used:=v_used+v_take-v_own;v_left:=v_left-v_take;
      EXIT WHEN v_left=0;
    END LOOP;
  ELSE
    v_free:=private.group_h_available_unit_amounts(_order_item_id,NULL);
    FOR v_line IN SELECT s.return_line_id,s.quantity,GREATEST((SELECT pg_catalog.count(*)::integer
        FROM private.group_h_return_unit_rows(s.return_line_id) AS b WHERE b.remaining_index IS NOT NULL)-p.unprocessed,0) AS own
      FROM private.group_h_return_refund_slices(_return_id,_order_item_id,_quantity,NULL) AS s
      JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=s.return_line_id LOOP
      v_own:=LEAST(v_line.quantity,v_line.own);v_take:=v_line.quantity-v_own;
      v_amount:=v_amount+COALESCE((SELECT pg_catalog.sum(b.paid_amount) FROM private.group_h_return_unit_rows(v_line.return_line_id) AS b
        WHERE b.remaining_index IS NOT NULL AND b.remaining_index<=v_own),0);
      v_part:=COALESCE(v_free[(v_used+1):(v_used+v_take)],ARRAY[]::integer[]);
      IF pg_catalog.cardinality(v_part)<>v_take THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      v_amount:=v_amount+COALESCE((SELECT pg_catalog.sum(x.amount) FROM pg_catalog.unnest(v_part) AS x(amount)),0);
      v_used:=v_used+v_take;v_left:=v_left-v_line.quantity;
    END LOOP;
  END IF;
  IF v_left<>0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_amount::integer;
END;
$$;

-- Read only: per line, the cumulative amounts of the units the next receipt of that line would take.
-- NULL (no row) for orders without H unit amounts; the caller then uses the shared per-item array.
-- Lines go in id order (the receive order); a later line of the same item starts after the free units an earlier line showed.
CREATE OR REPLACE FUNCTION private.return_receive_amounts(_return_id uuid)
RETURNS TABLE(return_line_id uuid,receive_refund_amounts_by_count integer[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_line record;v_own integer[];v_free integer[];v_ret integer;v_pick integer[];v_status text;
  v_used jsonb:='{}'::jsonb;v_start integer;v_need integer;
BEGIN
  SELECT r.status INTO v_status FROM public.order_returns AS r WHERE r.id=_return_id;
  FOR v_line IN SELECT l.id,l.order_item_id,p.unprocessed FROM public.order_return_lines AS l
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id ORDER BY l.id LOOP
    v_free:=private.group_h_available_unit_amounts(v_line.order_item_id,NULL);
    CONTINUE WHEN v_free IS NULL;
    SELECT COALESCE(pg_catalog.array_agg(b.paid_amount ORDER BY b.remaining_index),ARRAY[]::integer[]) INTO v_own
      FROM private.group_h_return_unit_rows(v_line.id) AS b WHERE b.remaining_index IS NOT NULL;
    v_ret:=GREATEST(pg_catalog.cardinality(v_own)-v_line.unprocessed,0);
    v_need:=GREATEST(v_line.unprocessed-(pg_catalog.cardinality(v_own)-v_ret),0);
    v_start:=COALESCE((v_used->>v_line.order_item_id::text)::integer,0);
    v_pick:=COALESCE(v_own[(v_ret+1):pg_catalog.cardinality(v_own)],ARRAY[]::integer[])
      ||COALESCE(v_free[(v_start+1):(v_start+v_need)],ARRAY[]::integer[]);
    v_used:=pg_catalog.jsonb_set(v_used,ARRAY[v_line.order_item_id::text],pg_catalog.to_jsonb(v_start+v_need));
    return_line_id:=v_line.id;
    IF v_status='open' THEN
      SELECT COALESCE(pg_catalog.array_agg(x.amount::integer ORDER BY x.n),ARRAY[]::integer[]) INTO receive_refund_amounts_by_count
        FROM (SELECT pg_catalog.sum(y.amount) OVER (ORDER BY y.amount,y.n) AS amount,
          pg_catalog.row_number() OVER (ORDER BY y.amount,y.n) AS n
          FROM pg_catalog.unnest(v_pick) WITH ORDINALITY AS y(amount,n)) AS x;
    ELSE
      receive_refund_amounts_by_count:=ARRAY[]::integer[];
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.admin_receive_return(
  _return_id uuid, _actor_id uuid, _actor_can_refund boolean, _request_key uuid,
  _units jsonb, _exchange_overrides jsonb, _refund_choice text, _refund_amount integer,
  _refund_shipping_amount integer, _note text, _notify_customer boolean,
  _sent_back_message text, _sent_back_carrier text, _sent_back_tracking_number text
) RETURNS TABLE(receipt_id uuid,return_status text,refund_id uuid,refund_amount integer,
  refund_status text,exchange_order_item_ids uuid[],fee_due_amount integer,shop_notice_enqueued boolean,replayed boolean)
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
    OR pg_catalog.jsonb_typeof(_exchange_overrides) IS DISTINCT FROM 'array' THEN
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
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
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
      EXISTS(SELECT 1 FROM private.order_email_outbox AS e WHERE e.return_receipt_id=v_old.id AND e.kind='return_refund_pending_shop'),true
    FROM (SELECT 1) AS singleton LEFT JOIN public.order_refunds AS r ON r.id=v_old.refund_id;
    RETURN;
  END IF;
  IF NOT _actor_can_refund AND (_refund_choice IN ('now','mixed') OR EXISTS (SELECT 1
      FROM pg_catalog.jsonb_to_recordset(v_units) AS x(refund_choice text) WHERE x.refund_choice='now'))
    AND NOT (v_return.source='customer_request' AND v_return.return_method<>'not_required') THEN RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023'; END IF;
  IF v_return.status<>'open' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
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
    IF EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=v_line.order_item_id) THEN
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
  v_fees:=(v_goods::bigint*v_return.restocking_fee_percent/100)::integer+v_fixed;
  v_fee_consult:=(v_goods_consult::bigint*v_return.restocking_fee_percent/100)::integer;
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
  IF v_refund IS NOT NULL THEN
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
    ARRAY(SELECT x FROM pg_catalog.unnest(v_exchange_ids) AS x ORDER BY x),fee_due_amount,v_shop,false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

-- RD_ACL_BEGIN
ALTER FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
-- The public entry is SECURITY INVOKER; service_role keeps the H5 grant on this private body only.
GRANT EXECUTE ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) TO service_role;
ALTER FUNCTION private.group_h_receiving_amount(uuid,uuid,integer,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_receiving_amount(uuid,uuid,integer,jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_refund_amount(uuid,uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_refund_amount(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.return_receive_amounts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.return_receive_amounts(uuid) FROM PUBLIC, anon, authenticated, service_role;
-- RD_ACL_END

-- RD_FINAL_ASSERT_BEGIN
DO $rd_final$
DECLARE
  e record; p record; v_oid oid; v_detail text;
BEGIN
  v_detail:='rd_schema';
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema='public'
      AND c.table_name='order_return_receipts' AND c.column_name='consult_quantity' AND c.data_type='integer'
      AND c.is_nullable='YES' AND c.column_default IS NULL)
    OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid='public.order_return_receipts'::regclass AND c.conname='order_return_receipts_consult_quantity_check'
        AND c.contype='c') IS DISTINCT FROM 'CHECK (((consult_quantity IS NULL) OR (consult_quantity >= 0)))'
    OR pg_catalog.has_column_privilege('anon','public.order_return_receipts','consult_quantity','SELECT')
    OR pg_catalog.has_column_privilege('authenticated','public.order_return_receipts','consult_quantity','SELECT')
    OR pg_catalog.has_column_privilege('service_role','public.order_return_receipts','consult_quantity','INSERT,UPDATE')
    OR NOT pg_catalog.has_column_privilege('service_role','public.order_return_receipts','consult_quantity','SELECT') THEN
    RAISE EXCEPTION 'RETURN_RECEIVE_UNIT_DEDUP_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
  END IF;
  v_detail:='rd_bodies';
  FOR e IN SELECT * FROM (VALUES
    ('admin_receive_return','admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)','4fc48eb2d6d2e3909b7635a598062cfc','v','{postgres=X/postgres,service_role=X/postgres}'),
    ('group_h_receiving_amount','group_h_receiving_amount(uuid,uuid,integer,jsonb)','523ba3a9ae5238933002598b38071cb5','s','{postgres=X/postgres}'),
    ('group_h_return_refund_amount','group_h_return_refund_amount(uuid,uuid,integer,uuid)','3ddd20e9348efac6c0bd6e5ac95e849a','s','{postgres=X/postgres}'),
    ('return_receive_amounts','return_receive_amounts(uuid)','9fea9f9a2d71e5bc6de2fe59d32730f6','s','{postgres=X/postgres}')
  ) AS expected(name,signature,body_md5,volatility,acl) LOOP
    v_oid:=pg_catalog.to_regprocedure('private.'||e.signature);
    SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid=v_oid;
    IF v_oid IS NULL OR NOT FOUND OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[] OR p.provolatile<>e.volatility
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5
      OR p.proacl::text IS DISTINCT FROM e.acl
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f
        WHERE f.pronamespace='private'::regnamespace AND f.proname=e.name)<>1 THEN
      RAISE EXCEPTION 'RETURN_RECEIVE_UNIT_DEDUP_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
    END IF;
  END LOOP;
  -- The public entry point keeps its G-1 body.
  IF (SELECT pg_catalog.md5(pg_catalog.replace(f.prosrc,E'\r','')) FROM pg_catalog.pg_proc AS f
      WHERE f.oid=pg_catalog.to_regprocedure('public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)'))
    IS DISTINCT FROM '2dedc2b2503ceb8516dedeaeb970609c' THEN
    RAISE EXCEPTION 'RETURN_RECEIVE_UNIT_DEDUP_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='RETURN_RECEIVE_UNIT_DEDUP_MIGRATION_ASSERTION_FAILED' AND SQLSTATE='P0001' THEN RAISE; END IF;
  RAISE EXCEPTION 'RETURN_RECEIVE_UNIT_DEDUP_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=COALESCE(v_detail,'rd_schema'),
    HINT='sqlstate='||SQLSTATE;
END;
$rd_final$;
-- RD_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
