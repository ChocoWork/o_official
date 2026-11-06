BEGIN;

-- RR: per-item refund choice on a single return receipt (now / consult), the receive refund cap,
-- and the group H unit counting for split lines.
-- @impl FREQ-641-AC-07 FREQ-641-AC-08 FREQ-641-AC-09 FREQ-641-AC-10
-- @design docs/04_DetailDesign/pages/16_admin.md DD-ADMIN-017 DD-ADMIN-018
-- Applied migrations, the public entry points, the state core and the G writer allowlist are not changed here.
-- Existing receipt rows are append-only and keep a NULL line choice; readers fill it from the parent choice.
-- RR_BASELINE_BEGIN
CREATE TEMP TABLE rr_writer_baseline ON COMMIT DROP AS
SELECT x::oid AS oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x);
-- RR_BASELINE_END

-- RR_SCHEMA_BEGIN
ALTER TABLE public.order_return_receipt_lines ADD COLUMN refund_choice text;
ALTER TABLE public.order_return_receipt_lines ADD CONSTRAINT order_return_receipt_lines_refund_choice_check CHECK (
  refund_choice IS NULL OR (refund_choice IN ('now','consult') AND resolution='refund'
    AND disposition IN ('restocked','not_restocked','pending_inspection')));
ALTER TABLE public.order_return_receipt_lines DROP CONSTRAINT order_return_receipt_lines_line_key;
ALTER TABLE public.order_return_receipt_lines ADD CONSTRAINT order_return_receipt_lines_line_key
  UNIQUE NULLS NOT DISTINCT (receipt_id,return_line_id,disposition,resolution,exchange_method,refund_choice);
ALTER TABLE public.order_return_receipts DROP CONSTRAINT order_return_receipts_refund_choice_check;
ALTER TABLE public.order_return_receipts ADD CONSTRAINT order_return_receipts_refund_choice_check CHECK (
  refund_choice IN ('now','consult','mixed','none'));
-- RR_SCHEMA_END

-- A refund_waived row written by a receive belongs to the now rows of that same receipt and line; those
-- positions keep their price order. Other waived rows, sent back and missing units keep the H5 rule (released last).
-- Receipts written in one transaction share created_at; the append-only row position breaks that tie in insert order.
CREATE OR REPLACE FUNCTION private.group_h_return_unit_dispositions(_return_line_id uuid)
RETURNS TABLE(unit_index integer,paid_amount integer,exchange_unit boolean,released_unit boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH bound AS MATERIALIZED (
    SELECT u.*,pg_catalog.row_number() OVER (ORDER BY u.paid_amount,u.unit_index) AS n
    FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=_return_line_id
  ), meta AS (
    SELECT l.quantity,l.quantity-(SELECT pg_catalog.count(*) FROM bound) AS released,
      (SELECT pg_catalog.count(*) FROM bound WHERE refund_id IS NOT NULL) AS claimed,
      COALESCE((SELECT pg_catalog.sum(x.quantity) FROM public.order_return_receipt_lines AS x
        WHERE x.return_line_id=l.id AND x.disposition='refund_waived'),0) AS waived,
      COALESCE((SELECT pg_catalog.sum(x.quantity) FROM public.order_return_receipt_lines AS x
        WHERE x.return_line_id=l.id AND x.disposition='missing_reopened'),0) AS reopened
    FROM public.order_return_lines AS l WHERE l.id=_return_line_id
  ), lines_with_choice AS (
    SELECT x.*,rc.created_at,rc.ctid AS receipt_ctid,rc.id AS receipt_order,
      CASE WHEN x.resolution='refund' AND x.disposition IN ('restocked','not_restocked','pending_inspection')
        AND COALESCE(x.refund_choice,rc.refund_choice)='now' THEN 0 ELSE 1 END AS now_order,
      CASE WHEN rc.kind='receive' THEN COALESCE((SELECT pg_catalog.sum(w.quantity) FROM public.order_return_receipt_lines AS w
        WHERE w.receipt_id=x.receipt_id AND w.return_line_id=x.return_line_id AND w.disposition='refund_waived'),0) ELSE 0 END AS receipt_waived
    FROM public.order_return_receipt_lines AS x JOIN public.order_return_receipts AS rc ON rc.id=x.receipt_id
    WHERE x.return_line_id=_return_line_id
      AND x.disposition IN ('restocked','not_restocked','pending_inspection','sent_back','missing')
  ), waives AS (
    SELECT COALESCE(pg_catalog.sum(b.bound_waived),0) AS bound_waived FROM (
      SELECT LEAST(pg_catalog.max(x.receipt_waived),COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.now_order=0),0)) AS bound_waived
      FROM lines_with_choice AS x GROUP BY x.receipt_order
    ) AS b
  ), raw_receipts AS (
    SELECT x.*,COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition='missing') OVER (
      ORDER BY x.created_at,x.receipt_ctid,x.receipt_order,x.now_order,x.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS previous_missing,
      COALESCE(pg_catalog.sum(x.quantity) OVER (PARTITION BY x.receipt_order,x.now_order
        ORDER BY x.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS previous_same
    FROM lines_with_choice AS x
  ), effective_receipts AS (
    SELECT x.resolution,x.disposition,x.created_at,x.receipt_ctid,x.receipt_order,x.now_order,x.id,x.receipt_waived,x.previous_same,
      CASE WHEN x.disposition='missing' THEN GREATEST(x.quantity-GREATEST(m.reopened-x.previous_missing,0),0)
        ELSE x.quantity END AS quantity FROM raw_receipts AS x CROSS JOIN meta AS m
  ), receipts AS (
    SELECT x.*,COALESCE(pg_catalog.sum(x.quantity) OVER (
      ORDER BY x.created_at,x.receipt_ctid,x.receipt_order,x.now_order,x.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS previous
    FROM effective_receipts AS x
  ), placed AS (
    SELECT g.n,r.resolution,r.disposition,
      COALESCE(r.now_order=0 AND g.n-r.previous+r.previous_same<=r.receipt_waived,false) AS bound_waive
    FROM meta CROSS JOIN LATERAL pg_catalog.generate_series(1,meta.quantity) AS g(n)
    LEFT JOIN receipts AS r ON g.n>r.previous AND g.n<=r.previous+r.quantity
  ), positions AS (
    SELECT p.*,pg_catalog.count(*) FILTER (WHERE p.resolution='refund' AND p.disposition NOT IN ('sent_back','missing')
        AND NOT p.bound_waive) OVER (ORDER BY p.n) AS refund_n
    FROM placed AS p
  ), marked AS (
    SELECT p.*,COALESCE(p.disposition IN ('sent_back','missing') OR p.bound_waive OR
      (p.resolution='refund' AND p.refund_n>m.claimed AND p.refund_n<=m.claimed+GREATEST(m.waived-w.bound_waived,0)),false) AS releasable
    FROM positions AS p CROSS JOIN meta AS m CROSS JOIN waives AS w
  ), ordered AS (
    SELECT p.*,pg_catalog.row_number() OVER (ORDER BY COALESCE(p.releasable AND NOT p.bound_waive,false),p.n) AS retained_n FROM marked AS p
  ), removed AS (
    SELECT p.*,pg_catalog.count(*) FILTER (WHERE p.releasable) OVER (ORDER BY p.retained_n DESC) AS released_n FROM ordered AS p
  ), remaining AS (
    SELECT p.*,pg_catalog.row_number() OVER (ORDER BY p.retained_n) AS bound_n FROM removed AS p CROSS JOIN meta AS m
    WHERE NOT (p.releasable AND p.released_n<=m.released)
  ) SELECT b.unit_index,b.paid_amount,
      COALESCE(p.resolution='exchange' AND p.disposition NOT IN ('sent_back','missing'),false),p.releasable
    FROM bound AS b JOIN remaining AS p ON p.bound_n=b.n
$$;

CREATE OR REPLACE FUNCTION private.group_h_release_return_units(_return_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  WITH units AS MATERIALIZED (
    SELECT u.order_item_id,u.unit_index,u.paid_amount,l.id AS line_id,r.status,d.exchange_unit,d.released_unit,
      p.unprocessed,p.refund_waiting,p.exchanged,
      pg_catalog.count(*) FILTER (WHERE d.exchange_unit) OVER (PARTITION BY l.id) AS protected
    FROM public.order_return_lines AS l
    CROSS JOIN LATERAL private.group_h_return_unit_dispositions(l.id) AS d
    JOIN public.order_line_unit_amounts AS u ON u.return_line_id=l.id AND u.unit_index=d.unit_index
    JOIN public.order_returns AS r ON r.id=l.return_id
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id AND u.refund_id IS NULL
  ), ranked AS (
    SELECT x.*,pg_catalog.row_number() OVER (PARTITION BY x.line_id ORDER BY x.released_unit DESC,x.paid_amount DESC,x.unit_index DESC) AS n,
      GREATEST(pg_catalog.count(*) OVER (PARTITION BY x.line_id)-(CASE WHEN x.status IN ('cancelled','declined') THEN 0
        ELSE GREATEST(x.unprocessed+x.refund_waiting+x.exchanged-x.protected,0) END),0) AS release_quantity
    FROM units AS x WHERE NOT x.exchange_unit
  ) UPDATE public.order_line_unit_amounts AS u SET return_line_id=NULL FROM ranked AS r
    WHERE u.order_item_id=r.order_item_id AND u.unit_index=r.unit_index AND r.n<=r.release_quantity;
END;
$$;

-- A receipt on any line of the return may free units of another item's line; the reopened claim stays per item.
CREATE OR REPLACE FUNCTION private.group_h_release_completed_return_claims() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_line public.order_return_lines;v_needed integer;v_bound integer;
BEGIN
  SELECT l.* INTO v_line FROM public.order_return_lines AS l WHERE l.id=NEW.return_line_id;
  IF NOT EXISTS (SELECT 1 FROM public.order_return_lines AS l JOIN public.order_line_unit_amounts AS u
    ON u.order_item_id=l.order_item_id WHERE l.return_id=v_line.return_id) THEN RETURN NEW; END IF;
  PERFORM private.group_h_release_return_units(v_line.return_id);
  IF NEW.disposition='missing_reopened'
    AND EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=v_line.order_item_id) THEN
    SELECT p.unprocessed+p.refund_waiting+p.exchanged+(SELECT pg_catalog.count(*)::integer
      FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=v_line.id AND u.refund_id IS NOT NULL)
      INTO v_needed FROM private.order_return_line_progress(v_line.return_id) AS p WHERE p.return_line_id=v_line.id;
    SELECT pg_catalog.count(*)::integer INTO v_bound FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=v_line.id;
    -- G-1 may already cover reopened units with a normal refund. Never take another refund's claim.
    SELECT LEAST(v_needed,v_bound+pg_catalog.count(*)::integer) INTO v_needed
      FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=v_line.order_item_id AND u.refund_id IS NULL AND u.return_line_id IS NULL;
    IF v_needed>v_bound THEN
      PERFORM private.group_h_claim_return_units(v_line.id,v_line.order_item_id,LEAST(v_line.quantity,v_needed));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A receipt-less return refund binds its own returnable units first, then free units only to lines whose
-- bound total is still below the line quantity. Receipt refunds skip the earlier waiting units (W0=B-N-C).
CREATE OR REPLACE FUNCTION private.group_h_claim_refund_units(_refund_id uuid,_order_item_id uuid,_quantity integer,
  _before_shipment boolean,_return_line_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_refund public.order_refunds; v_line public.order_return_lines; v_n integer; v_amount bigint; v_picked integer;
  v_check integer[]; v_skip integer:=0; v_own integer; v_own_cap integer; v_free_cap integer:=0; v_now integer:=0;
  v_consult integer:=0; v_unprocessed integer:=0; v_marked integer:=0; v_receipt uuid; v_choice text;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  SELECT r.* INTO v_refund FROM public.order_refunds AS r JOIN public.order_items AS oi ON oi.order_id=r.order_id
    WHERE r.id=_refund_id AND oi.id=_order_item_id;
  IF NOT FOUND OR _quantity IS NULL OR _quantity<0 OR _before_shipment IS NULL
    OR v_refund.status NOT IN ('awaiting_response','pending','succeeded')
    OR (_return_line_id IS NOT NULL AND (_before_shipment OR NOT EXISTS (
      SELECT 1 FROM public.order_return_lines AS l WHERE l.id=_return_line_id AND l.return_id=v_refund.return_id AND l.order_item_id=_order_item_id))) THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  v_check:=private.group_h_available_unit_amounts(_order_item_id,v_refund.return_id);
  IF v_check IS NULL THEN RETURN private.return_units_amount(_order_item_id,_quantity); END IF;
  SELECT pg_catalog.count(*)::integer,COALESCE(pg_catalog.sum(u.paid_amount),0) INTO v_n,v_amount
  FROM public.order_line_unit_amounts AS u WHERE u.refund_id=_refund_id AND u.order_item_id=_order_item_id
    AND u.refund_before_shipment=_before_shipment AND u.return_line_id IS NOT DISTINCT FROM _return_line_id;
  IF v_n=_quantity THEN
    RETURN v_amount::integer;
  END IF;
  IF v_n>_quantity THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  IF _return_line_id IS NULL THEN
    WITH chosen AS (
      SELECT u.order_item_id,u.unit_index FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id=_order_item_id AND u.refund_id IS NULL AND u.return_line_id IS NULL
      ORDER BY u.paid_amount,u.unit_index LIMIT (_quantity-v_n)
    ), changed AS (
      UPDATE public.order_line_unit_amounts AS u SET refund_id=_refund_id,refund_before_shipment=_before_shipment,
        return_line_id=NULL FROM chosen AS c
      WHERE u.order_item_id=c.order_item_id AND u.unit_index=c.unit_index RETURNING u.paid_amount
    ) SELECT pg_catalog.count(*)::integer,COALESCE(pg_catalog.sum(c.paid_amount),0)+v_amount INTO v_picked,v_amount FROM changed AS c;
  ELSE
    SELECT l.* INTO v_line FROM public.order_return_lines AS l WHERE l.id=_return_line_id;
    SELECT p.unprocessed,p.refund_covered+p.refund_waiting INTO v_unprocessed,v_marked
      FROM private.order_return_line_progress(v_refund.return_id) AS p WHERE p.return_line_id=_return_line_id;
    SELECT rc.id,rc.refund_choice INTO v_receipt,v_choice FROM public.order_return_receipts AS rc
      WHERE rc.return_id=v_refund.return_id AND rc.request_key=v_refund.request_key AND rc.kind='receive';
    IF v_receipt IS NOT NULL THEN
      SELECT COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE COALESCE(x.refund_choice,v_choice)='now'),0)::integer,
        COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE COALESCE(x.refund_choice,v_choice)='consult'),0)::integer
        INTO v_now,v_consult FROM public.order_return_receipt_lines AS x
        WHERE x.receipt_id=v_receipt AND x.return_line_id=_return_line_id AND x.resolution='refund'
          AND x.disposition IN ('restocked','not_restocked','pending_inspection');
    END IF;
    SELECT pg_catalog.count(*)::integer INTO v_own FROM private.group_h_return_unit_rows(_return_line_id) AS b
      WHERE b.remaining_index IS NOT NULL;
    IF v_now+v_consult>0 THEN
      v_skip:=GREATEST(v_own+v_n-COALESCE(v_unprocessed,0)-v_now-v_consult,0);v_own_cap:=NULL;
    ELSE
      v_own_cap:=GREATEST(v_own-COALESCE(v_unprocessed,0),0);
    END IF;
    IF COALESCE(v_marked,0)>0 THEN
      SELECT GREATEST(v_line.quantity-pg_catalog.count(*)::integer,0) INTO v_free_cap
        FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=_return_line_id;
    END IF;
    WITH own AS (
      SELECT u.order_item_id,u.unit_index,u.paid_amount,0 AS priority,b.remaining_index AS n
      FROM private.group_h_return_unit_rows(_return_line_id) AS b
      JOIN public.order_line_unit_amounts AS u ON u.order_item_id=_order_item_id AND u.unit_index=b.unit_index
        AND u.return_line_id=_return_line_id AND u.refund_id IS NULL
      WHERE b.remaining_index IS NOT NULL AND b.remaining_index>v_skip AND (v_own_cap IS NULL OR b.remaining_index<=v_own_cap)
    ), free AS (
      SELECT u.order_item_id,u.unit_index,u.paid_amount,1 AS priority,
        pg_catalog.row_number() OVER (ORDER BY u.paid_amount,u.unit_index) AS n
      FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id=_order_item_id AND u.refund_id IS NULL AND u.return_line_id IS NULL
    ), chosen AS (
      SELECT p.order_item_id,p.unit_index FROM (
        SELECT o.* FROM own AS o UNION ALL SELECT f.* FROM free AS f WHERE f.n<=v_free_cap
      ) AS p ORDER BY p.priority,p.n LIMIT (_quantity-v_n)
    ), changed AS (
      UPDATE public.order_line_unit_amounts AS u SET refund_id=_refund_id,refund_before_shipment=_before_shipment,
        return_line_id=_return_line_id FROM chosen AS c
      WHERE u.order_item_id=c.order_item_id AND u.unit_index=c.unit_index RETURNING u.paid_amount
    ) SELECT pg_catalog.count(*)::integer,COALESCE(pg_catalog.sum(c.paid_amount),0)+v_amount INTO v_picked,v_amount FROM changed AS c;
  END IF;
  IF v_picked+v_n<>_quantity THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_amount::integer;
END;
$$;

-- With a receive receipt: only that receipt's effective now units, after W0=max(B-N-C,0).
-- Without one: lines whose state core mark is reversed first, then created order; own returnable units, then
-- free units up to each line quantity. Marks never pick the line on their own.
CREATE OR REPLACE FUNCTION private.group_h_return_refund_slices(_return_id uuid,_order_item_id uuid,_quantity integer,_request_key uuid DEFAULT NULL)
RETURNS TABLE(return_line_id uuid,quantity integer,unit_offset integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_left integer:=_quantity;v_line record;v_receipt uuid;v_choice text;v_free integer;v_own integer;v_take integer;
BEGIN
  IF _quantity IS NULL OR _quantity<0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT rc.id,rc.refund_choice INTO v_receipt,v_choice FROM public.order_return_receipts AS rc
    WHERE rc.return_id=_return_id AND rc.request_key=_request_key AND rc.kind='receive';
  IF v_receipt IS NOT NULL THEN
    FOR v_line IN SELECT l.id,
        COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE COALESCE(x.refund_choice,v_choice)='now'),0)::integer AS now_n,
        COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE COALESCE(x.refund_choice,v_choice)='consult'),0)::integer AS consult_n,
        (SELECT pg_catalog.count(*)::integer FROM private.group_h_return_unit_rows(l.id) AS b
          WHERE b.remaining_index IS NOT NULL)-p.unprocessed AS bound_n
      FROM public.order_return_lines AS l
      JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
      JOIN public.order_return_receipt_lines AS x ON x.return_line_id=l.id AND x.receipt_id=v_receipt
        AND x.resolution='refund' AND x.disposition IN ('restocked','not_restocked','pending_inspection')
      WHERE l.return_id=_return_id AND l.order_item_id=_order_item_id
      GROUP BY l.id,p.unprocessed ORDER BY l.id LOOP
      EXIT WHEN v_left=0;
      quantity:=LEAST(v_left,v_line.now_n);return_line_id:=v_line.id;
      unit_offset:=GREATEST(v_line.bound_n-v_line.now_n-v_line.consult_n,0);
      IF quantity>0 THEN RETURN NEXT;v_left:=v_left-quantity;END IF;
    END LOOP;
  ELSE
    SELECT pg_catalog.count(*)::integer INTO v_free FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id=_order_item_id AND u.refund_id IS NULL AND u.return_line_id IS NULL;
    FOR v_line IN SELECT l.id,p.unprocessed,
        (SELECT pg_catalog.count(*)::integer FROM private.group_h_return_unit_rows(l.id) AS b WHERE b.remaining_index IS NOT NULL) AS own,
        CASE WHEN p.refund_covered+p.refund_waiting>0 THEN GREATEST(l.quantity-(SELECT pg_catalog.count(*)::integer
          FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=l.id),0) ELSE 0 END AS free_cap
      FROM public.order_return_lines AS l JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
      WHERE l.return_id=_return_id AND l.order_item_id=_order_item_id
      ORDER BY (p.refund_covered>(SELECT pg_catalog.count(*) FROM public.order_line_unit_amounts AS u
        WHERE u.return_line_id=l.id AND u.refund_id IS NOT NULL)) DESC,l.created_at,l.id LOOP
      EXIT WHEN v_left=0;
      v_own:=LEAST(v_left,GREATEST(v_line.own-v_line.unprocessed,0));
      v_take:=LEAST(v_left-v_own,v_line.free_cap,v_free);
      quantity:=v_own+v_take;return_line_id:=v_line.id;unit_offset:=0;
      IF quantity>0 THEN RETURN NEXT;v_left:=v_left-quantity;v_free:=v_free-v_take;END IF;
    END LOOP;
  END IF;
  IF v_left<>0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
END;
$$;

-- Elements may carry unit_offset (now: W0, consult: W0+N); old elements fall back to the line mark.
CREATE OR REPLACE FUNCTION private.group_h_receiving_amount(_return_id uuid,_order_item_id uuid,_quantity integer,_effective jsonb)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_left integer:=_quantity;v_amount bigint:=0;v_line record;v_take integer;
BEGIN
  FOR v_line IN SELECT l.id,pg_catalog.sum(x.quantity)::integer AS picked,pg_catalog.max(x.unit_offset) AS unit_offset,p.refund_waiting
    FROM pg_catalog.jsonb_to_recordset(_effective) AS x(return_line_id uuid,resolution text,quantity integer,unit_offset integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id AND l.order_item_id=_order_item_id AND x.resolution='refund'
    GROUP BY l.id,p.refund_waiting ORDER BY l.id LOOP
    EXIT WHEN v_left=0;
    v_take:=LEAST(v_left,v_line.picked);
    v_amount:=v_amount+private.group_h_return_line_amount(v_line.id,v_take,COALESCE(v_line.unit_offset,v_line.refund_waiting));
    v_left:=v_left-v_take;
  END LOOP;
  IF v_left IS NULL OR v_left<>0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_amount::integer;
END;
$$;

-- Receipt-less amounts follow the slices: own units by remaining index, free units from one shared queue.
CREATE OR REPLACE FUNCTION private.group_h_return_refund_amount(_return_id uuid,_order_item_id uuid,_quantity integer,_request_key uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_left integer:=_quantity; v_amount bigint:=0; v_line record; v_take integer; v_own integer; v_free integer[];
  v_used integer:=0; v_part integer[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=_order_item_id) THEN
    RETURN private.return_units_amount(_order_item_id,_quantity); END IF;
  IF _quantity IS NULL OR _quantity<0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM public.order_return_receipts AS rc WHERE rc.return_id=_return_id AND rc.request_key=_request_key
    AND rc.kind='receive') THEN
    FOR v_line IN SELECT s.* FROM private.group_h_return_refund_slices(_return_id,_order_item_id,_quantity,_request_key) AS s LOOP
      v_take:=v_line.quantity;
      v_amount:=v_amount+private.group_h_return_line_amount(v_line.return_line_id,v_take,v_line.unit_offset);
      v_left:=v_left-v_take;
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

-- Waiting amounts use the receipt-less slice allocation (read only); the unprocessed cumulative array keeps its meaning.
CREATE OR REPLACE FUNCTION private.group_h_return_amounts(_return_id uuid)
RETURNS TABLE(return_line_id uuid,refund_amounts_by_count integer[],refund_waiting_amount integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item record;v_line record;v_pool integer[];v_own integer[];v_result integer[];v_free integer[];
  v_used integer;v_left integer;v_ret integer;v_take_own integer;v_take_free integer;v_need integer;v_by_line jsonb;
BEGIN
  FOR v_item IN SELECT l.order_item_id,pg_catalog.sum(p.refund_waiting)::integer AS waiting
    FROM public.order_return_lines AS l JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id GROUP BY l.order_item_id LOOP
    v_free:=private.group_h_available_unit_amounts(v_item.order_item_id,NULL);
    CONTINUE WHEN v_free IS NULL;
    v_pool:=ARRAY[]::integer[];v_used:=0;v_left:=v_item.waiting;v_need:=0;v_by_line:='{}'::jsonb;
    FOR v_line IN SELECT l.id,p.unprocessed,
        CASE WHEN p.refund_covered+p.refund_waiting>0 THEN GREATEST(l.quantity-(SELECT pg_catalog.count(*)::integer
          FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=l.id),0) ELSE 0 END AS free_cap
      FROM public.order_return_lines AS l JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
      WHERE l.return_id=_return_id AND l.order_item_id=v_item.order_item_id
      ORDER BY (p.refund_covered>(SELECT pg_catalog.count(*) FROM public.order_line_unit_amounts AS u
        WHERE u.return_line_id=l.id AND u.refund_id IS NOT NULL)) DESC,l.created_at,l.id LOOP
      SELECT COALESCE(pg_catalog.array_agg(b.paid_amount ORDER BY b.remaining_index),ARRAY[]::integer[]) INTO v_own
        FROM private.group_h_return_unit_rows(v_line.id) AS b WHERE b.remaining_index IS NOT NULL;
      v_ret:=GREATEST(pg_catalog.cardinality(v_own)-v_line.unprocessed,0);
      v_take_own:=LEAST(v_left,v_ret);
      v_take_free:=GREATEST(LEAST(v_left-v_take_own,v_line.free_cap,pg_catalog.cardinality(v_free)-v_used),0);
      v_by_line:=pg_catalog.jsonb_set(v_by_line,ARRAY[v_line.id::text],pg_catalog.to_jsonb(
        COALESCE((SELECT pg_catalog.sum(x.amount) FROM pg_catalog.unnest(v_own[1:v_take_own]) AS x(amount)),0)
        +COALESCE((SELECT pg_catalog.sum(x.amount) FROM pg_catalog.unnest(v_free[(v_used+1):(v_used+v_take_free)]) AS x(amount)),0)));
      v_used:=v_used+v_take_free;v_left:=v_left-v_take_own-v_take_free;
      v_pool:=v_pool||COALESCE(v_own[(v_ret+1):pg_catalog.cardinality(v_own)],ARRAY[]::integer[]);
      v_need:=v_need+GREATEST(v_line.unprocessed-(pg_catalog.cardinality(v_own)-v_ret),0);
    END LOOP;
    IF v_need>0 THEN
      v_pool:=v_pool||COALESCE(v_free[(v_used+1):(v_used+v_need)],ARRAY[]::integer[]);
    END IF;
    SELECT COALESCE(pg_catalog.array_agg(x.amount ORDER BY x.amount,x.n),ARRAY[]::integer[]) INTO v_pool
      FROM pg_catalog.unnest(v_pool) WITH ORDINALITY AS x(amount,n);
    SELECT COALESCE(pg_catalog.array_agg(x.amount::integer ORDER BY x.n),ARRAY[]::integer[]) INTO v_result
      FROM (SELECT pg_catalog.sum(x.amount) OVER (ORDER BY x.n) AS amount,x.n
        FROM pg_catalog.unnest(v_pool) WITH ORDINALITY AS x(amount,n)) AS x;
    FOR v_line IN SELECT l.id FROM public.order_return_lines AS l
      WHERE l.return_id=_return_id AND l.order_item_id=v_item.order_item_id ORDER BY l.id LOOP
      return_line_id:=v_line.id;refund_amounts_by_count:=v_result;
      refund_waiting_amount:=COALESCE((v_by_line->>(v_line.id::text))::integer,0);
      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$$;

-- Read only: per line, the cumulative amounts of the units the next receipt of that line would take.
-- NULL (no row) for orders without H unit amounts; the caller then uses the shared per-item array.
CREATE OR REPLACE FUNCTION private.return_receive_amounts(_return_id uuid)
RETURNS TABLE(return_line_id uuid,receive_refund_amounts_by_count integer[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_line record;v_own integer[];v_free integer[];v_ret integer;v_pick integer[];v_status text;
BEGIN
  SELECT r.status INTO v_status FROM public.order_returns AS r WHERE r.id=_return_id;
  FOR v_line IN SELECT l.id,l.order_item_id,p.unprocessed FROM public.order_return_lines AS l
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id ORDER BY l.created_at,l.id LOOP
    v_free:=private.group_h_available_unit_amounts(v_line.order_item_id,NULL);
    CONTINUE WHEN v_free IS NULL;
    SELECT COALESCE(pg_catalog.array_agg(b.paid_amount ORDER BY b.remaining_index),ARRAY[]::integer[]) INTO v_own
      FROM private.group_h_return_unit_rows(v_line.id) AS b WHERE b.remaining_index IS NOT NULL;
    v_ret:=GREATEST(pg_catalog.cardinality(v_own)-v_line.unprocessed,0);
    v_pick:=COALESCE(v_own[(v_ret+1):pg_catalog.cardinality(v_own)],ARRAY[]::integer[])
      ||COALESCE(v_free[1:GREATEST(v_line.unprocessed-(pg_catalog.cardinality(v_own)-v_ret),0)],ARRAY[]::integer[]);
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
    FOR v_h_line IN SELECT l.* FROM public.order_refund_lines AS l WHERE l.refund_id=_refund_id
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

-- One receipt may refund some units now and leave others for consultation. Receipt, stock and exchange stay whole;
-- only the refund core receives the now units. The receive refund cap is LEAST(refundable, now goods + shipping).
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
      v_paid:=private.group_h_return_line_amount(v_line.id,v_line.picked,
        (SELECT p.refund_waiting FROM private.order_return_line_progress(_return_id) AS p WHERE p.return_line_id=v_line.id));
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
      'quantity',x.quantity,'unit_offset',x.unit_offset)) FILTER (WHERE x.refund_choice='now'),'[]'::jsonb),
    COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'resolution','refund',
      'quantity',x.quantity,'unit_offset',x.unit_offset)) FILTER (WHERE x.refund_choice='consult'),'[]'::jsonb)
    INTO v_now_elements,v_consult_elements FROM placed AS x;
  SELECT COALESCE(pg_catalog.sum(CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=q.order_item_id)
      THEN private.group_h_receiving_amount(_return_id,q.order_item_id,q.now,v_now_elements)
      ELSE private.return_units_amount(q.order_item_id,q.now,0) END),0)::integer,
    COALESCE(pg_catalog.sum(CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=q.order_item_id)
      THEN private.group_h_receiving_amount(_return_id,q.order_item_id,q.consult,v_consult_elements)
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
    INSERT INTO public.order_return_receipts(id,return_id,request_key,request_fingerprint,kind,refund_choice,refund_id,
      notify_customer,sent_back_message,sent_back_carrier,sent_back_tracking_number,note,actor_id,actor_can_refund)
    VALUES(v_receipt,_return_id,_request_key,v_fp,'receive',v_choice,v_refund,_notify_customer,
      _sent_back_message,_sent_back_carrier,_sent_back_tracking_number,_note,_actor_id,_actor_can_refund);
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

CREATE OR REPLACE FUNCTION private.return_detail_json(_return_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_display_status text;
  v_marks text[];
  v_created_by_email text;
  v_lines jsonb;
  v_refunds jsonb;
  v_receipts jsonb;
  v_exchange_items jsonb;
  v_first_receipt boolean;
  v_first_exchange boolean;
BEGIN
  SELECT r.* INTO v_return FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT s.display_status, s.marks INTO v_display_status, v_marks
  FROM private.return_display_state(_return_id) AS s;

  SELECT u.email::text INTO v_created_by_email FROM auth.users AS u WHERE u.id = v_return.created_by;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', y.id,
               'fulfillment_id', y.fulfillment_id,
               'fulfillment_number', y.fulfillment_number,
               'order_item_id', y.order_item_id,
               'item_name', y.item_name,
               'color', y.color,
               'size', y.size,
               'quantity', y.quantity,
               'reason', y.reason,
               'reason_note', y.reason_note,
               'customer_note', (SELECT l.customer_note FROM public.order_return_lines AS l WHERE l.id = y.id),
               'requested_resolution', (SELECT l.requested_resolution FROM public.order_return_lines AS l WHERE l.id = y.id),
               'requested_exchange', (
                 SELECT pg_catalog.jsonb_build_object('variant_id', v.id, 'color', c.name, 'size', s.label)
                 FROM public.order_return_lines AS l
                 JOIN public.item_variants AS v ON v.id = l.requested_exchange_variant_id
                 LEFT JOIN public.item_colors AS c ON c.id = v.color_id
                 LEFT JOIN public.item_sizes AS s ON s.id = v.size_id
                 WHERE l.id = y.id
               ),
               'photos', COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.id, 'purged', p.purged_at IS NOT NULL)
                   ORDER BY p.created_at, p.id)
                 FROM public.order_return_photos AS p WHERE p.return_line_id = y.id
               ), '[]'::jsonb),
               'return_ineligible', COALESCE((
                 SELECT i.return_ineligible FROM public.order_return_lines AS l
                 JOIN public.order_items AS oi ON oi.id = l.order_item_id
                 LEFT JOIN public.items AS i ON i.id = oi.item_id WHERE l.id = y.id
               ), false),
               'resolution', y.resolution,
               'exchange', CASE
                 WHEN y.resolution = 'exchange' THEN pg_catalog.jsonb_build_object(
                   'variant_id', y.exchange_variant_id,
                   'color', y.exchange_color,
                   'size', y.exchange_size,
                   'method', y.exchange_method,
                   'stock_quantity', y.exchange_stock,
                   'made_to_order_lead_days', y.exchange_lead_days,
                   'out_of_stock_exchange', y.out_of_stock_exchange
                 )
               END,
               'progress', pg_catalog.jsonb_build_object(
                 'restocked', y.restocked,
                 'not_restocked', y.not_restocked,
                 'pending_inspection', y.pending_inspection,
                 'sent_back', y.sent_back,
                 'missing', y.missing,
                 'processed', y.processed,
                 'unprocessed', y.unprocessed,
                 'exchanged', y.exchanged,
                 'refund_covered', y.refund_covered,
                 'refund_waived', y.refund_waived,
                 'refund_waiting', y.refund_waiting
               ),
               'receive_refund_amounts_by_count', rr.receive_refund_amounts_by_count,
               'refund_amounts_by_count', CASE WHEN h.return_line_id IS NOT NULL THEN
                 CASE WHEN v_return.status='open' THEN h.refund_amounts_by_count ELSE ARRAY[]::integer[] END
                 ELSE CASE
                 WHEN v_return.status = 'open' THEN ARRAY(
                   SELECT private.return_refund_amount(
                            y.line_kind, y.item_price, y.ordered, y.line_discount, y.exchange_paid_amount,
                            y.already_refunded, g.k
                          )
                   FROM pg_catalog.generate_series(1, y.item_unprocessed) AS g(k)
                   ORDER BY g.k
                 )
                 ELSE ARRAY[]::integer[]
               END END,
               'refund_waiting_amount', CASE WHEN h.return_line_id IS NOT NULL THEN h.refund_waiting_amount ELSE private.return_refund_amount(
                 y.line_kind, y.item_price, y.ordered, y.line_discount, y.exchange_paid_amount,
                 y.already_refunded + y.earlier_waiting, y.refund_waiting
               ) END
             )
             ORDER BY y.fulfillment_number, y.item_created_at, y.order_item_id, y.resolution, y.id
           ),
           '[]'::jsonb
         )
  INTO v_lines
  FROM (
    SELECT l.id,
           l.fulfillment_id,
           l.order_item_id,
           l.quantity,
           l.reason,
           l.reason_note,
           l.resolution,
           l.exchange_variant_id,
           l.exchange_method,
           f.number AS fulfillment_number,
           oi.item_name,
           oi.color,
           oi.size,
           oi.line_kind,
           oi.item_price,
           oi.exchange_paid_amount,
           oi.quantity AS ordered,
           oi.created_at AS item_created_at,
           COALESCE(d.line_discount, 0) AS line_discount,
           COALESCE(lf.refunded_before_shipment, 0) + COALESCE(lf.refunded_after_shipment, 0) AS already_refunded,
           p.restocked,
           p.not_restocked,
           p.pending_inspection,
           p.sent_back,
           p.missing,
           p.processed,
           p.unprocessed,
           p.exchanged,
           p.refund_covered,
           p.refund_waived,
           p.refund_waiting,
           COALESCE(
             pg_catalog.sum(p.refund_waiting) OVER (
               PARTITION BY l.order_item_id
               ORDER BY l.id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
             ),
             0
           )::integer AS earlier_waiting,
           -- Existing business rule (unchanged).
           (pg_catalog.sum(p.unprocessed) OVER (PARTITION BY l.order_item_id))::integer AS item_unprocessed,
           ec.name AS exchange_color,
           es.label AS exchange_size,
           ev.stock_quantity AS exchange_stock,
           ei.made_to_order_lead_days AS exchange_lead_days,
           rs.out_of_stock_exchange
    FROM public.order_return_lines AS l
    JOIN public.order_fulfillments AS f ON f.id = l.fulfillment_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id = l.id
    LEFT JOIN private.order_line_discounts(v_return.order_id) AS d ON d.order_item_id = l.order_item_id
    LEFT JOIN private.order_line_fulfillment(v_return.order_id) AS lf ON lf.order_item_id = l.order_item_id
    LEFT JOIN public.item_variants AS ev ON ev.id = l.exchange_variant_id
    LEFT JOIN public.item_colors AS ec ON ec.id = ev.color_id
    LEFT JOIN public.item_sizes AS es ON es.id = ev.size_id
    LEFT JOIN public.items AS ei ON ei.id = ev.item_id
    LEFT JOIN public.shop_return_reason_settings AS rs ON rs.reason = l.reason
    WHERE l.return_id = _return_id
  ) AS y LEFT JOIN private.group_h_return_amounts(_return_id) AS h ON h.return_line_id=y.id
    LEFT JOIN private.return_receive_amounts(_return_id) AS rr ON rr.return_line_id=y.id;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', rf.id,
               'amount', rf.amount,
               'status', rf.status,
               'created_at', rf.created_at
             )
             ORDER BY rf.created_at DESC, rf.id DESC
           ),
           '[]'::jsonb
         )
  INTO v_refunds
  FROM public.order_refunds AS rf
  WHERE rf.return_id = _return_id;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'id', c.id,
               'kind', c.kind,
               'refund_choice', c.refund_choice,
               'created_at', c.created_at,
               'actor_email', u.email::text
             )
             ORDER BY c.created_at DESC, c.id DESC
           ),
           '[]'::jsonb
         )
  INTO v_receipts
  FROM public.order_return_receipts AS c
  LEFT JOIN auth.users AS u ON u.id = c.actor_id
  WHERE c.return_id = _return_id;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'order_item_id', oi.id,
               'item_name', oi.item_name,
               'color', oi.color,
               'size', oi.size,
               'quantity', oi.quantity,
               'fulfillment_type', oi.fulfillment_type,
               'shipped', lf.shipped
             )
             ORDER BY oi.created_at, oi.id
           ),
           '[]'::jsonb
         )
  INTO v_exchange_items
  FROM public.order_items AS oi
  JOIN public.order_return_lines AS l ON l.id = oi.exchange_return_line_id AND l.return_id = _return_id
  JOIN private.order_line_fulfillment(v_return.order_id) AS lf ON lf.order_item_id = oi.id;

  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  SELECT EXISTS (
           SELECT 1
           FROM public.order_return_receipts AS c
           JOIN public.order_return_receipt_lines AS rl ON rl.receipt_id = c.id
           WHERE c.return_id = _return_id
             AND c.kind = 'receive'
             AND rl.disposition IN ('restocked', 'not_restocked', 'pending_inspection')
         ),
         EXISTS (
           SELECT 1
           FROM public.order_return_receipts AS c
           JOIN public.order_return_receipt_lines AS rl ON rl.receipt_id = c.id
           WHERE c.return_id = _return_id
             AND c.kind = 'receive'
             AND rl.disposition IN ('restocked', 'not_restocked', 'pending_inspection')
             AND rl.resolution = 'exchange'
         )
  INTO v_first_receipt, v_first_exchange;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_return.id,
    'number', v_return.number,
    'status', v_return.status,
    'source', v_return.source,
    'requested_at', v_return.requested_at,
    'approved_at', v_return.approved_at,
    'approved_by_email', (SELECT u.email::text FROM auth.users AS u WHERE u.id = v_return.approved_by),
    'declined_at', v_return.declined_at,
    'decline_reason', v_return.decline_reason,
    'decline_message', v_return.decline_message,
    'display_status', v_display_status,
    'marks', pg_catalog.to_jsonb(COALESCE(v_marks, ARRAY[]::text[])),
    'return_method', v_return.return_method,
    'return_shipping_payer', v_return.return_shipping_payer,
    'return_carrier', v_return.return_carrier,
    'return_tracking_number', v_return.return_tracking_number,
    'fees', pg_catalog.jsonb_build_object(
      'return_shipping_fee', v_return.return_shipping_fee,
      'restocking_fee_percent', v_return.restocking_fee_percent,
      'exchange_fee', v_return.exchange_fee,
      'exchange_shipping_fee', v_return.exchange_shipping_fee,
      'fee_due_amount', v_return.fee_due_amount,
      'fee_pending_deduction', v_return.fee_pending_deduction,
      'fee_received_at', v_return.fee_received_at,
      'exchange_released_at', v_return.exchange_released_at
    ),
    'first_receipt_done', v_first_receipt,
    'first_exchange_receipt_done', v_first_exchange,
    'shop_note', v_return.shop_note,
    'notify_customer', v_return.notify_customer,
    'created_at', v_return.created_at,
    'created_by_email', v_created_by_email,
    'closed_at', v_return.closed_at,
    'cancelled_at', v_return.cancelled_at,
    'lines', v_lines,
    'refunds', v_refunds,
    'receipts', v_receipts,
    'exchange_items', v_exchange_items
  );
END;
$$;

-- RR_ACL_BEGIN
ALTER FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
-- The public entry is SECURITY INVOKER; service_role keeps the H5 grant on this private body only.
GRANT EXECUTE ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) TO service_role;
ALTER FUNCTION private.return_detail_json(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.return_detail_json(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.return_receive_amounts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.return_receive_amounts(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_unit_dispositions(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_unit_dispositions(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_release_return_units(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_release_return_units(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_release_completed_return_claims() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_release_completed_return_claims() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_refund_slices(uuid,uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_refund_slices(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_receiving_amount(uuid,uuid,integer,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_receiving_amount(uuid,uuid,integer,jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_amounts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_amounts(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_claim_refund_units(uuid,uuid,integer,boolean,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_claim_refund_units(uuid,uuid,integer,boolean,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_refund_amount(uuid,uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_refund_amount(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
-- RR_ACL_END

-- RR_FINAL_ASSERT_BEGIN
DO $rr_final$
DECLARE
  e record; p record; v_oid oid; v_detail text;
BEGIN
  v_detail:='rr_schema';
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema='public'
      AND c.table_name='order_return_receipt_lines' AND c.column_name='refund_choice' AND c.data_type='text' AND c.is_nullable='YES')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_return_receipt_lines'::regclass
      AND c.conname='order_return_receipt_lines_refund_choice_check' AND c.contype='c'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%refund_choice%now%consult%')
    OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid='public.order_return_receipt_lines'::regclass AND c.conname='order_return_receipt_lines_line_key')
      IS DISTINCT FROM 'UNIQUE NULLS NOT DISTINCT (receipt_id, return_line_id, disposition, resolution, exchange_method, refund_choice)'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_return_receipts'::regclass
      AND c.conname='order_return_receipts_refund_choice_check' AND c.contype='c'
      AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%mixed%') THEN
    RAISE EXCEPTION 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
  END IF;
  v_detail:='rr_receive';
  FOR e IN SELECT * FROM (VALUES
    ('admin_receive_return','admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)','14475081e8a00d482f770575db0b443b','v'),
    ('return_detail_json','return_detail_json(uuid)','0d6d4e47caacb0f97a32479c2b511c1b','s'),
    ('return_receive_amounts','return_receive_amounts(uuid)','190ca31ac80b36841077b1e18b49e045','s')
  ) AS expected(name,signature,body_md5,volatility) LOOP
    v_oid:=pg_catalog.to_regprocedure('private.'||e.signature);
    SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid=v_oid;
    IF v_oid IS NULL OR NOT FOUND OR p.proowner<>'postgres'::regrole OR p.prosecdef<>(e.name<>'return_detail_json')
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[] OR p.provolatile<>e.volatility
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f
        WHERE f.pronamespace='private'::regnamespace AND f.proname=e.name)<>1 THEN
      RAISE EXCEPTION 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
    END IF;
  END LOOP;
  -- The public entry point keeps its G-1 body.
  IF (SELECT pg_catalog.md5(pg_catalog.replace(f.prosrc,E'\r','')) FROM pg_catalog.pg_proc AS f
      WHERE f.oid=pg_catalog.to_regprocedure('public.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)'))
    IS DISTINCT FROM '2dedc2b2503ceb8516dedeaeb970609c' THEN
    RAISE EXCEPTION 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
  END IF;
  v_detail:='rr_amounts';
  FOR e IN SELECT * FROM (VALUES
    ('group_h_return_unit_dispositions','group_h_return_unit_dispositions(uuid)','3782fbc1a158aafda27288c7317f23a1','s'),
    ('group_h_release_return_units','group_h_release_return_units(uuid)','dcc3e69b7ac9cd4a7b1c47fff2282cfa','v'),
    ('group_h_release_completed_return_claims','group_h_release_completed_return_claims()','3437edf0c5c28c814b8f4d32410744ef','v'),
    ('group_h_return_refund_slices','group_h_return_refund_slices(uuid,uuid,integer,uuid)','5c9b69a23b7d78a19cbadc4c2e5d518d','s'),
    ('group_h_receiving_amount','group_h_receiving_amount(uuid,uuid,integer,jsonb)','c17563d22e12533506e4c15de1baa704','s'),
    ('group_h_return_amounts','group_h_return_amounts(uuid)','2410ec6490657d648b9717fd96af4e89','s'),
    ('group_h_claim_refund_units','group_h_claim_refund_units(uuid,uuid,integer,boolean,uuid)','320e045af0945b13526aa474bf2f07b3','v'),
    ('record_group_g_refund_result','record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)','e8b6a3cbd56e77480cd044275e0ea755','v'),
    ('group_h_return_refund_amount','group_h_return_refund_amount(uuid,uuid,integer,uuid)','5188ce60c4d441d046643a2620f18bb2','s')
  ) AS expected(name,signature,body_md5,volatility) LOOP
    v_oid:=pg_catalog.to_regprocedure('private.'||e.signature);
    SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid=v_oid;
    IF v_oid IS NULL OR NOT FOUND OR p.proowner<>'postgres'::regrole OR p.prosecdef<>(e.name<>'return_detail_json')
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[] OR p.provolatile<>e.volatility
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f
        WHERE f.pronamespace='private'::regnamespace AND f.proname=e.name)<>1 THEN
      RAISE EXCEPTION 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
    END IF;
  END LOOP;
  v_detail:='rr_acl';
  FOR e IN SELECT * FROM (VALUES
    ('admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)','{postgres=X/postgres,service_role=X/postgres}'),
    ('return_detail_json(uuid)','{postgres=X/postgres}'),
    ('return_receive_amounts(uuid)','{postgres=X/postgres}'),
    ('group_h_return_unit_dispositions(uuid)','{postgres=X/postgres}'),
    ('group_h_release_return_units(uuid)','{postgres=X/postgres}'),
    ('group_h_release_completed_return_claims()','{postgres=X/postgres}'),
    ('group_h_return_refund_slices(uuid,uuid,integer,uuid)','{postgres=X/postgres}'),
    ('group_h_receiving_amount(uuid,uuid,integer,jsonb)','{postgres=X/postgres}'),
    ('group_h_return_amounts(uuid)','{postgres=X/postgres}'),
    ('group_h_claim_refund_units(uuid,uuid,integer,boolean,uuid)','{postgres=X/postgres}'),
    ('record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)','{postgres=X/postgres}'),
    ('group_h_return_refund_amount(uuid,uuid,integer,uuid)','{postgres=X/postgres}')
  ) AS expected(signature,acl) LOOP
    IF (SELECT f.proacl::text FROM pg_catalog.pg_proc AS f WHERE f.oid=pg_catalog.to_regprocedure('private.'||e.signature))
      IS DISTINCT FROM e.acl THEN
      RAISE EXCEPTION 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
    END IF;
  END LOOP;
  v_detail:='rr_writers';
  IF (SELECT pg_catalog.count(*) FROM pg_temp.rr_writer_baseline)<>77
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))<>77
    OR (SELECT pg_catalog.array_agg(x::oid ORDER BY x::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))
      IS DISTINCT FROM (SELECT pg_catalog.array_agg(b.oid ORDER BY b.oid) FROM pg_temp.rr_writer_baseline AS b)
    OR pg_catalog.to_regprocedure('private.return_receive_amounts(uuid)')::oid=ANY(
      SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))
    OR (SELECT pg_catalog.md5(pg_catalog.replace(f.prosrc,E'\r','')) FROM pg_catalog.pg_proc AS f
      WHERE f.oid='private.group_g_writer_allowlist()'::regprocedure)<>'1a9bd697484b32bb5f44793ced4b70df' THEN
    RAISE EXCEPTION 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' AND SQLSTATE='P0001' THEN RAISE; END IF;
  RAISE EXCEPTION 'RETURN_RECEIVE_PER_ITEM_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=COALESCE(v_detail,'rr_schema'),
    HINT='sqlstate='||SQLSTATE;
END;
$rr_final$;
-- RR_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
