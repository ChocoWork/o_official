BEGIN;
-- H5: only unit claim columns are mutable; redemption usage is never restored.
CREATE TEMP TABLE h5_function_baseline ON COMMIT DROP AS
SELECT p.oid,p.prorettype,p.proretset,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proargnames,p.proargtypes,p.pronargdefaults,
  pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') AS service
FROM pg_catalog.pg_proc AS p WHERE p.oid=ANY(ARRAY[
  'private.return_units_amount(uuid,integer,integer)'::regprocedure,
  'public.load_order_refund_materials(uuid)'::regprocedure,
  'private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)'::regprocedure,
  'private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)'::regprocedure,
  'private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)'::regprocedure,
  'private.mark_order_refund_error(uuid,text,boolean)'::regprocedure,
  'private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)'::regprocedure,
  'private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)'::regprocedure,
  'private.admin_cancel_return(uuid,uuid)'::regprocedure,
  'private.admin_decline_return(uuid,uuid,text,text)'::regprocedure,
  'private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)'::regprocedure,
  'private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)'::regprocedure,
  'private.return_detail_json(uuid)'::regprocedure,
  'private.group_g_order_item_rows(uuid[])'::regprocedure]::oid[]);

ALTER TABLE public.order_line_unit_amounts
  ADD COLUMN refund_id uuid REFERENCES public.order_refunds(id) ON DELETE RESTRICT,
  ADD COLUMN refund_before_shipment boolean,
  ADD COLUMN return_line_id uuid REFERENCES public.order_return_lines(id) ON DELETE RESTRICT,
  ADD CONSTRAINT h5_refund_claim_pair CHECK ((refund_id IS NULL) = (refund_before_shipment IS NULL));
CREATE INDEX h5_units_refund_idx ON public.order_line_unit_amounts(refund_id);
CREATE INDEX h5_units_return_idx ON public.order_line_unit_amounts(return_line_id);

CREATE FUNCTION private.group_h_assert_unit_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_locks AS l WHERE l.pid=pg_catalog.pg_backend_pid()
    AND l.locktype='advisory' AND l.classid=190521 AND l.objid=1 AND l.objsubid=2
    AND l.mode='ExclusiveLock' AND l.granted) THEN
    RAISE EXCEPTION 'GROUP_H_LOCK_REQUIRED' USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE FUNCTION private.group_h_guard_unit_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_context text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.refund_id IS NOT NULL OR NEW.refund_before_shipment IS NOT NULL OR NEW.return_line_id IS NOT NULL THEN
      RAISE EXCEPTION 'GROUP_H_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' OR
    (pg_catalog.to_jsonb(OLD)-ARRAY['refund_id','refund_before_shipment','return_line_id']) IS DISTINCT FROM
    (pg_catalog.to_jsonb(NEW)-ARRAY['refund_id','refund_before_shipment','return_line_id']) THEN
    RAISE EXCEPTION 'GROUP_H_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  PERFORM private.group_h_assert_unit_lock();
  GET DIAGNOSTICS v_context = PG_CONTEXT;
  IF v_context !~ 'function (private\.)?group_h_(claim_refund_units|release_refund_units|claim_return_units|release_return_units)\(' THEN
    RAISE EXCEPTION 'GROUP_H_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF NEW.refund_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.order_refunds AS r
    WHERE r.id=NEW.refund_id AND r.order_id=NEW.order_id AND r.status IN ('awaiting_response','pending','succeeded')) THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF NEW.return_line_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.order_return_lines AS l
    JOIN public.order_returns AS r ON r.id=l.return_id WHERE l.id=NEW.return_line_id
    AND l.order_item_id=NEW.order_item_id AND r.order_id=NEW.order_id) THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF NEW.refund_id IS NOT NULL AND NEW.return_line_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.order_refunds AS r JOIN public.order_return_lines AS l ON l.return_id=r.return_id
    WHERE r.id=NEW.refund_id AND l.id=NEW.return_line_id AND NOT NEW.refund_before_shipment) THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER h1_units_immutable ON public.order_line_unit_amounts;
CREATE TRIGGER h5_units_empty_claim BEFORE INSERT ON public.order_line_unit_amounts
  FOR EACH ROW EXECUTE FUNCTION private.group_h_guard_unit_claim();
CREATE TRIGGER h1_units_immutable BEFORE UPDATE OR DELETE ON public.order_line_unit_amounts
  FOR EACH ROW EXECUTE FUNCTION private.group_h_guard_unit_claim();

-- Refunds and exchanges occupy the cheap end of the return claim.
-- Completed outcomes without a refund leave from the expensive end, regardless of receipt order.
CREATE FUNCTION private.group_h_return_unit_dispositions(_return_line_id uuid)
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
  ), raw_receipts AS (
    SELECT x.*,rc.created_at,rc.id AS receipt_order,COALESCE(pg_catalog.sum(x.quantity) FILTER (WHERE x.disposition='missing') OVER (
      ORDER BY rc.created_at,rc.id,x.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS previous_missing
    FROM public.order_return_receipt_lines AS x JOIN public.order_return_receipts AS rc ON rc.id=x.receipt_id
    WHERE x.return_line_id=_return_line_id
      AND x.disposition IN ('restocked','not_restocked','pending_inspection','sent_back','missing')
  ), effective_receipts AS (
    SELECT x.resolution,x.disposition,x.created_at,x.receipt_order,x.id,
      CASE WHEN x.disposition='missing' THEN GREATEST(x.quantity-GREATEST(m.reopened-x.previous_missing,0),0)
        ELSE x.quantity END AS quantity FROM raw_receipts AS x CROSS JOIN meta AS m
  ), receipts AS (
    SELECT x.resolution,x.disposition,x.quantity,COALESCE(pg_catalog.sum(x.quantity) OVER (
      ORDER BY x.created_at,x.receipt_order,x.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS previous
    FROM effective_receipts AS x
  ), positions AS (
    SELECT g.n,r.resolution,r.disposition,
      pg_catalog.count(*) FILTER (WHERE r.resolution='refund' AND r.disposition NOT IN ('sent_back','missing'))
        OVER (ORDER BY g.n) AS refund_n
    FROM meta CROSS JOIN LATERAL pg_catalog.generate_series(1,meta.quantity) AS g(n)
    LEFT JOIN receipts AS r ON g.n>r.previous AND g.n<=r.previous+r.quantity
  ), marked AS (
    SELECT p.*,COALESCE(p.disposition IN ('sent_back','missing') OR
      (p.resolution='refund' AND p.refund_n>m.claimed AND p.refund_n<=m.claimed+m.waived),false) AS releasable
    FROM positions AS p CROSS JOIN meta AS m
  ), ordered AS (
    SELECT p.*,pg_catalog.row_number() OVER (ORDER BY p.releasable,p.n) AS retained_n FROM marked AS p
  ), removed AS (
    SELECT p.*,pg_catalog.count(*) FILTER (WHERE p.releasable) OVER (ORDER BY p.retained_n DESC) AS released_n FROM ordered AS p
  ), remaining AS (
    SELECT p.*,pg_catalog.row_number() OVER (ORDER BY p.retained_n) AS bound_n FROM removed AS p CROSS JOIN meta AS m
    WHERE NOT (p.releasable AND p.released_n<=m.released)
  ) SELECT b.unit_index,b.paid_amount,
      COALESCE(p.resolution='exchange' AND p.disposition NOT IN ('sent_back','missing'),false),p.releasable
    FROM bound AS b JOIN remaining AS p ON p.bound_n=b.n
$$;

CREATE FUNCTION private.group_h_return_unit_rows(_return_line_id uuid)
RETURNS TABLE(unit_index integer,paid_amount integer,exchange_unit boolean,remaining_index bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.unit_index,d.paid_amount,d.exchange_unit,
    CASE WHEN u.refund_id IS NULL AND NOT d.exchange_unit AND NOT d.released_unit THEN
      pg_catalog.count(*) FILTER (WHERE u.refund_id IS NULL AND NOT d.exchange_unit AND NOT d.released_unit)
        OVER (ORDER BY d.paid_amount,d.unit_index) END
  FROM private.group_h_return_unit_dispositions(_return_line_id) AS d
  JOIN public.order_line_unit_amounts AS u ON u.return_line_id=_return_line_id AND u.unit_index=d.unit_index
$$;

CREATE FUNCTION private.group_h_available_unit_amounts(_order_item_id uuid,_return_id uuid DEFAULT NULL)
RETURNS integer[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item public.order_items; v_n integer; v_sum bigint; v_discount integer; v_result integer[];
BEGIN
  SELECT oi.* INTO v_item FROM public.order_items AS oi WHERE oi.id=_order_item_id;
  IF NOT FOUND OR v_item.line_kind='exchange' OR NOT EXISTS (
    SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=_order_item_id) THEN RETURN NULL; END IF;
  SELECT pg_catalog.count(*)::integer,pg_catalog.sum(u.paid_amount) INTO v_n,v_sum
    FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=_order_item_id;
  SELECT d.line_discount INTO v_discount FROM private.order_line_discounts(v_item.order_id) AS d WHERE d.order_item_id=_order_item_id;
  IF v_n<>v_item.quantity OR v_sum IS DISTINCT FROM v_item.line_total::bigint-v_discount THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF _return_id IS NULL THEN
    SELECT COALESCE(pg_catalog.array_agg(u.paid_amount ORDER BY u.paid_amount,u.unit_index),ARRAY[]::integer[]) INTO v_result
      FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=_order_item_id
        AND u.refund_id IS NULL AND u.return_line_id IS NULL;
    RETURN v_result;
  END IF;
  WITH available AS (
    SELECT u.*,l.return_id,b.remaining_index AS n,b.exchange_unit
    FROM public.order_line_unit_amounts AS u LEFT JOIN public.order_return_lines AS l ON l.id=u.return_line_id
    LEFT JOIN LATERAL private.group_h_return_unit_rows(u.return_line_id) AS b ON b.unit_index=u.unit_index
    WHERE u.order_item_id=_order_item_id AND u.refund_id IS NULL
  ) SELECT COALESCE(pg_catalog.array_agg(a.paid_amount ORDER BY a.paid_amount,a.unit_index),ARRAY[]::integer[]) INTO v_result
    FROM available AS a WHERE (a.return_line_id IS NULL OR (a.return_id=_return_id AND NOT a.exchange_unit AND a.n IS NOT NULL))
      ;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.group_h_claim_return_units(_return_line_id uuid,_order_item_id uuid,_quantity integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_line public.order_return_lines; v_count integer; v_result bigint; v_selected integer; v_check integer[];
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  SELECT l.* INTO v_line FROM public.order_return_lines AS l WHERE l.id=_return_line_id AND l.order_item_id=_order_item_id;
  IF NOT FOUND OR _quantity IS NULL OR _quantity<0 OR _quantity>v_line.quantity THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  v_check:=private.group_h_available_unit_amounts(_order_item_id,NULL);
  IF v_check IS NULL THEN RETURN private.return_units_amount(_order_item_id,_quantity); END IF;
  SELECT pg_catalog.count(*)::integer INTO v_count FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=_return_line_id;
  IF v_count>_quantity THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  WITH chosen AS (SELECT u.order_item_id,u.unit_index FROM public.order_line_unit_amounts AS u
    WHERE u.order_item_id=_order_item_id AND u.refund_id IS NULL AND u.return_line_id IS NULL
    ORDER BY u.paid_amount,u.unit_index LIMIT (_quantity-v_count) FOR UPDATE), changed AS (
    UPDATE public.order_line_unit_amounts AS u SET return_line_id=_return_line_id FROM chosen AS c
    WHERE u.order_item_id=c.order_item_id AND u.unit_index=c.unit_index RETURNING u.paid_amount)
  SELECT pg_catalog.count(*)::integer INTO v_selected FROM changed;
  IF v_selected<>_quantity-v_count THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(pg_catalog.sum(u.paid_amount),0) INTO v_result FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=_return_line_id;
  RETURN v_result::integer;
END;
$$;

CREATE FUNCTION private.group_h_claim_refund_units(_refund_id uuid,_order_item_id uuid,_quantity integer,
  _before_shipment boolean,_return_line_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_refund public.order_refunds; v_n integer; v_amount bigint; v_picked integer; v_check integer[]; v_skip integer:=0;v_received integer;
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
  IF _return_line_id IS NOT NULL THEN
    SELECT COALESCE(pg_catalog.sum(x.quantity),0)::integer INTO v_received FROM public.order_return_receipts AS rc
      JOIN public.order_return_receipt_lines AS x ON x.receipt_id=rc.id
      WHERE rc.return_id=v_refund.return_id AND rc.request_key=v_refund.request_key AND rc.kind='receive'
        AND x.return_line_id=_return_line_id AND x.resolution='refund' AND x.disposition<>'sent_back';
    IF v_received>0 THEN
      SELECT GREATEST(p.refund_waiting-v_received,0) INTO v_skip
        FROM private.order_return_line_progress(v_refund.return_id) AS p WHERE p.return_line_id=_return_line_id;
      IF EXISTS (SELECT 1 FROM public.order_refund_lines AS l WHERE l.refund_id=_refund_id) THEN
        SELECT p.refund_waiting INTO v_skip FROM private.order_return_line_progress(v_refund.return_id) AS p WHERE p.return_line_id=_return_line_id;
      END IF;
    END IF;
  END IF;
  WITH pool AS (
    SELECT u.*,CASE WHEN _return_line_id IS NULL THEN pg_catalog.row_number() OVER (ORDER BY u.paid_amount,u.unit_index)
      ELSE b.remaining_index END AS n
    FROM public.order_line_unit_amounts AS u
    LEFT JOIN LATERAL private.group_h_return_unit_rows(_return_line_id) AS b ON b.unit_index=u.unit_index AND NOT b.exchange_unit
    WHERE u.order_item_id=_order_item_id AND u.refund_id IS NULL
      AND (u.return_line_id IS NOT DISTINCT FROM _return_line_id OR
        (_return_line_id IS NOT NULL AND u.return_line_id IS NULL))
  ), chosen AS (
    SELECT p.order_item_id,p.unit_index FROM pool AS p WHERE p.n>v_skip OR (_return_line_id IS NOT NULL AND p.return_line_id IS NULL)
    ORDER BY (p.return_line_id IS NOT NULL) DESC,p.paid_amount,p.unit_index LIMIT (_quantity-v_n)
  ), changed AS (
    UPDATE public.order_line_unit_amounts AS u SET refund_id=_refund_id,refund_before_shipment=_before_shipment,
      return_line_id=_return_line_id FROM chosen AS c
    WHERE u.order_item_id=c.order_item_id AND u.unit_index=c.unit_index RETURNING u.paid_amount
  ) SELECT pg_catalog.count(*)::integer,COALESCE(pg_catalog.sum(c.paid_amount),0)+v_amount INTO v_picked,v_amount FROM changed AS c;
  IF v_picked+v_n<>_quantity THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_amount::integer;
END;
$$;

CREATE FUNCTION private.group_h_release_refund_units(_refund_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  IF NOT EXISTS (SELECT 1 FROM public.order_refunds AS r WHERE r.id=_refund_id AND r.status IN ('error','failed')) THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  UPDATE public.order_line_unit_amounts AS u SET refund_id=NULL,refund_before_shipment=NULL WHERE u.refund_id=_refund_id;
END;
$$;

CREATE FUNCTION private.group_h_release_return_units(_return_id uuid) RETURNS void
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

-- Receipt writers already own G's common lock; release the completed claim in that same transaction.
CREATE FUNCTION private.group_h_release_completed_return_claims() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_line public.order_return_lines;v_needed integer;v_bound integer;
BEGIN
  SELECT l.* INTO v_line FROM public.order_return_lines AS l WHERE l.id=NEW.return_line_id;
  IF NOT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=v_line.order_item_id) THEN RETURN NEW; END IF;
  PERFORM private.group_h_release_return_units(v_line.return_id);
  IF NEW.disposition='missing_reopened' THEN
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
CREATE TRIGGER h5_return_completed_claims AFTER INSERT ON public.order_return_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION private.group_h_release_completed_return_claims();

CREATE FUNCTION private.group_h_return_line_amount(_return_line_id uuid,_quantity integer,_offset integer DEFAULT 0)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item uuid; v_count integer; v_amount bigint;
BEGIN
  SELECT l.order_item_id INTO v_item FROM public.order_return_lines AS l WHERE l.id=_return_line_id;
  IF NOT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=v_item) THEN
    RETURN private.return_units_amount(v_item,_quantity,_offset); END IF;
  IF _quantity IS NULL OR _offset IS NULL OR _quantity<0 OR _offset<0 THEN
    RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT pg_catalog.count(*)::integer,COALESCE(pg_catalog.sum(x.paid_amount),0) INTO v_count,v_amount FROM (
    SELECT pool.paid_amount FROM (
      SELECT u.paid_amount,u.unit_index,0 AS priority FROM private.group_h_return_unit_rows(_return_line_id) AS u
      WHERE NOT u.exchange_unit AND u.remaining_index IS NOT NULL
      UNION ALL
      SELECT u.paid_amount,u.unit_index,1 FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id=v_item AND u.return_line_id IS NULL AND u.refund_id IS NULL
    ) AS pool ORDER BY pool.priority,pool.paid_amount,pool.unit_index OFFSET _offset LIMIT _quantity
  ) AS x;
  IF v_count<>_quantity THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_amount::integer;
END;
$$;

CREATE FUNCTION private.group_h_return_refund_slices(_return_id uuid,_order_item_id uuid,_quantity integer,_request_key uuid DEFAULT NULL)
RETURNS TABLE(return_line_id uuid,quantity integer,unit_offset integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_left integer:=_quantity;v_line record;v_receipt uuid;v_received integer;v_capacity integer;
BEGIN
  IF _quantity IS NULL OR _quantity<0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT rc.id INTO v_receipt FROM public.order_return_receipts AS rc WHERE rc.return_id=_return_id AND rc.request_key=_request_key AND rc.kind='receive';
  FOR v_line IN SELECT l.id,p.refund_waiting FROM public.order_return_lines AS l
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id AND l.order_item_id=_order_item_id ORDER BY l.id LOOP
    IF v_receipt IS NULL THEN v_capacity:=v_line.refund_waiting;unit_offset:=0;
    ELSE
      SELECT COALESCE(pg_catalog.sum(x.quantity),0)::integer INTO v_received FROM public.order_return_receipt_lines AS x
        WHERE x.receipt_id=v_receipt AND x.return_line_id=v_line.id AND x.resolution='refund' AND x.disposition<>'sent_back';
      v_capacity:=LEAST(v_received,v_line.refund_waiting);unit_offset:=GREATEST(v_line.refund_waiting-v_received,0);
    END IF;
    quantity:=LEAST(v_left,v_capacity);return_line_id:=v_line.id;
    IF quantity>0 THEN RETURN NEXT;v_left:=v_left-quantity;END IF;
    EXIT WHEN v_left=0;
  END LOOP;
  IF v_left<>0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
END;
$$;

CREATE FUNCTION private.group_h_receiving_amount(_return_id uuid,_order_item_id uuid,_quantity integer,_effective jsonb)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_left integer:=_quantity;v_amount bigint:=0;v_line record;v_take integer;
BEGIN
  FOR v_line IN SELECT l.id,pg_catalog.sum(x.quantity)::integer AS picked,p.refund_waiting
    FROM pg_catalog.jsonb_to_recordset(_effective) AS x(return_line_id uuid,resolution text,quantity integer)
    JOIN public.order_return_lines AS l ON l.id=x.return_line_id
    JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id AND l.order_item_id=_order_item_id AND x.resolution='refund'
    GROUP BY l.id,p.refund_waiting ORDER BY l.id LOOP
    v_take:=LEAST(v_left,v_line.picked);
    v_amount:=v_amount+private.group_h_return_line_amount(v_line.id,v_take,v_line.refund_waiting);
    v_left:=v_left-v_take;EXIT WHEN v_left=0;
  END LOOP;
  IF v_left IS NULL OR v_left<>0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_amount::integer;
END;
$$;

CREATE FUNCTION private.group_h_return_refund_amount(_return_id uuid,_order_item_id uuid,_quantity integer,_request_key uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_left integer:=_quantity; v_amount bigint:=0; v_line record; v_take integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=_order_item_id) THEN
    RETURN private.return_units_amount(_order_item_id,_quantity); END IF;
  IF _quantity IS NULL OR _quantity<0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  FOR v_line IN SELECT s.* FROM private.group_h_return_refund_slices(_return_id,_order_item_id,_quantity,_request_key) AS s LOOP
    v_take:=v_line.quantity;
    v_amount:=v_amount+private.group_h_return_line_amount(v_line.return_line_id,v_take,v_line.unit_offset);
    v_left:=v_left-v_take;
    EXIT WHEN v_left=0;
  END LOOP;
  IF v_left<>0 THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN v_amount::integer;
END;
$$;

CREATE FUNCTION private.group_h_return_amounts(_return_id uuid)
RETURNS TABLE(return_line_id uuid,refund_amounts_by_count integer[],refund_waiting_amount integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item record;v_line record;v_pool integer[];v_own integer[];v_result integer[];v_free integer[];
  v_free_offset integer;v_need integer;v_by_line jsonb;
BEGIN
  FOR v_item IN SELECT l.order_item_id,pg_catalog.sum(p.unprocessed)::integer AS unprocessed
    FROM public.order_return_lines AS l JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
    WHERE l.return_id=_return_id GROUP BY l.order_item_id LOOP
    v_free:=private.group_h_available_unit_amounts(v_item.order_item_id,NULL);
    CONTINUE WHEN v_free IS NULL;
    v_pool:=ARRAY[]::integer[];v_free_offset:=0;v_by_line:='{}'::jsonb;
    FOR v_line IN SELECT l.id,p.refund_waiting,p.unprocessed FROM public.order_return_lines AS l
      JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
      WHERE l.return_id=_return_id AND l.order_item_id=v_item.order_item_id ORDER BY l.id LOOP
      SELECT COALESCE(pg_catalog.array_agg(x.paid_amount ORDER BY x.remaining_index),ARRAY[]::integer[]) INTO v_own
        FROM (SELECT b.paid_amount,b.remaining_index FROM private.group_h_return_unit_rows(v_line.id) AS b
          WHERE b.remaining_index IS NOT NULL ORDER BY b.remaining_index LIMIT (v_line.refund_waiting+v_line.unprocessed)) AS x;
      v_need:=v_line.refund_waiting+v_line.unprocessed-pg_catalog.cardinality(v_own);
      IF v_need>0 THEN
        v_own:=v_own||COALESCE(v_free[(v_free_offset+1):(v_free_offset+v_need)],ARRAY[]::integer[]);
        v_free_offset:=v_free_offset+v_need;
      END IF;
      -- When G-1 has recorded overlapping provider facts, expose only available estimates, without a read-side crash.
      v_by_line:=pg_catalog.jsonb_set(v_by_line,ARRAY[v_line.id::text],pg_catalog.to_jsonb(v_own));
      v_pool:=v_pool||v_own[(v_line.refund_waiting+1):pg_catalog.cardinality(v_own)];
    END LOOP;
    SELECT COALESCE(pg_catalog.array_agg(x.amount ORDER BY x.amount,x.n),ARRAY[]::integer[]) INTO v_pool
      FROM pg_catalog.unnest(v_pool) WITH ORDINALITY AS x(amount,n);
    SELECT COALESCE(pg_catalog.array_agg(x.amount::integer ORDER BY x.n),ARRAY[]::integer[]) INTO v_result
      FROM (SELECT pg_catalog.sum(x.amount) OVER (ORDER BY x.n) AS amount,x.n
        FROM pg_catalog.unnest(v_pool) WITH ORDINALITY AS x(amount,n)) AS x;
    FOR v_line IN SELECT l.id,p.refund_waiting FROM public.order_return_lines AS l
      JOIN private.order_return_line_progress(_return_id) AS p ON p.return_line_id=l.id
      WHERE l.return_id=_return_id AND l.order_item_id=v_item.order_item_id ORDER BY l.id LOOP
      return_line_id:=v_line.id;refund_amounts_by_count:=v_result;
      SELECT COALESCE(pg_catalog.sum(x.amount::integer),0)::integer INTO refund_waiting_amount
        FROM pg_catalog.jsonb_array_elements_text(v_by_line->v_line.id::text) WITH ORDINALITY AS x(amount,n)
        WHERE x.n<=v_line.refund_waiting;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$$;

CREATE FUNCTION private.group_h_order_unit_status_amounts(_order_id uuid)
RETURNS TABLE(order_item_id uuid,status text,line_amount integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_item record; v_unit record; v_slots text[]; v_used boolean[]; v_values bigint[]; v_slot integer;
  v_ranges jsonb;v_progress jsonb;v_bound jsonb;
  v_preferred text; v_priority text[]:=ARRAY['unpaid','payment_expired','in_production','ready','shipped','delivered',
    'cancel_requested','cancelled','return_requested','return_in_progress','refund_waiting','returned'];
BEGIN
  -- G-1 is authoritative. Read the order's ranges and return progress once, outside both unit loops.
  IF NOT EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_id=_order_id) THEN RETURN; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)),'[]'::jsonb) INTO v_ranges
    FROM private.group_g_item_state_ranges(ARRAY[_order_id]) AS r;
  IF v_ranges='[]'::jsonb THEN RETURN; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p)),'[]'::jsonb) INTO v_progress
    FROM private.order_return_line_states(_order_id) AS p;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b)||pg_catalog.jsonb_build_object('return_line_id',l.id)),'[]'::jsonb)
    INTO v_bound FROM public.order_return_lines AS l JOIN public.order_returns AS rt ON rt.id=l.return_id
    CROSS JOIN LATERAL private.group_h_return_unit_rows(l.id) AS b WHERE rt.order_id=_order_id;
  FOR v_item IN SELECT oi.id,oi.quantity FROM public.order_items AS oi WHERE oi.order_id=_order_id AND oi.line_kind<>'exchange'
    AND EXISTS(SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=oi.id) ORDER BY oi.id LOOP
    PERFORM private.group_h_available_unit_amounts(v_item.id,NULL);
    SELECT pg_catalog.array_agg(r.status ORDER BY pg_catalog.array_position(v_priority,r.status),r.unit_from,g.n) INTO v_slots
    FROM pg_catalog.jsonb_to_recordset(v_ranges) AS r(order_item_id uuid,status text,unit_from integer,unit_to integer)
    CROSS JOIN LATERAL pg_catalog.generate_series(r.unit_from,r.unit_to-1) AS g(n) WHERE r.order_item_id=v_item.id;
    IF COALESCE(pg_catalog.cardinality(v_slots),0)<>v_item.quantity THEN
      RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
    v_used:=pg_catalog.array_fill(false,ARRAY[v_item.quantity]);v_values:=pg_catalog.array_fill(0::bigint,ARRAY[v_item.quantity]);
    FOR v_unit IN SELECT u.*,r.status AS refund_status,r.return_id,l.resolution,rt.status AS return_status,
      b.remaining_index AS return_n,b.exchange_unit,
      p.refund_waiting,p.refund_covered,p.refund_waived,p.unprocessed,p.exchanged,p.pending_inspection
      FROM public.order_line_unit_amounts AS u LEFT JOIN public.order_refunds AS r ON r.id=u.refund_id
      LEFT JOIN public.order_return_lines AS l ON l.id=u.return_line_id LEFT JOIN public.order_returns AS rt ON rt.id=l.return_id
      LEFT JOIN pg_catalog.jsonb_to_recordset(v_bound) AS b(return_line_id uuid,unit_index integer,remaining_index bigint,exchange_unit boolean)
        ON b.return_line_id=u.return_line_id AND b.unit_index=u.unit_index
      LEFT JOIN pg_catalog.jsonb_to_recordset(v_progress) AS p(return_line_id uuid,refund_waiting integer,refund_covered integer,
        refund_waived integer,unprocessed integer,exchanged integer,pending_inspection integer) ON p.return_line_id=l.id
      WHERE u.order_item_id=v_item.id
      ORDER BY (u.refund_id IS NOT NULL OR u.return_line_id IS NOT NULL) DESC,
        (r.status='succeeded') DESC NULLS LAST,(r.status IN ('pending','awaiting_response')) DESC NULLS LAST,u.paid_amount DESC,u.unit_index LOOP
      v_preferred:=NULL;
      IF v_unit.refund_status IN ('succeeded','pending','awaiting_response') THEN
        IF v_unit.refund_before_shipment THEN v_preferred:='cancelled';
        ELSIF v_unit.return_id IS NOT NULL THEN v_preferred:=CASE WHEN v_unit.refund_status='succeeded' THEN 'returned' ELSE 'return_in_progress' END;
        ELSE v_preferred:=CASE WHEN 'delivered'=ANY(v_slots) THEN 'delivered' ELSE 'shipped' END; END IF;
      ELSIF v_unit.return_line_id IS NOT NULL THEN
        IF v_unit.exchange_unit THEN v_preferred:='returned';
        ELSIF v_unit.return_n<=COALESCE(v_unit.refund_waiting,0) THEN v_preferred:='refund_waiting';
        ELSIF v_unit.return_status='requested' THEN v_preferred:='return_requested';
        ELSIF v_unit.return_status IN ('open','closed') THEN
          v_preferred:=CASE WHEN COALESCE(v_unit.unprocessed,0)+COALESCE(v_unit.pending_inspection,0)>0
            THEN 'return_in_progress' ELSE 'returned' END;
        END IF;
      END IF;
      SELECT g.n INTO v_slot FROM pg_catalog.generate_subscripts(v_slots,1) AS g(n)
        WHERE NOT v_used[g.n] AND (v_preferred IS NULL OR v_slots[g.n]=v_preferred) ORDER BY g.n LIMIT 1;
      -- Inspection and fixed failed-refund quantities share G's in-progress bucket.
      IF v_slot IS NULL AND v_preferred='refund_waiting' THEN
        SELECT g.n INTO v_slot FROM pg_catalog.generate_subscripts(v_slots,1) AS g(n)
          WHERE NOT v_used[g.n] AND v_slots[g.n]='return_in_progress' ORDER BY g.n LIMIT 1;
      END IF;
      IF v_slot IS NULL THEN
        -- Split delivery and every G-1 return outcome remain readable when a preferred bucket is full.
        SELECT g.n INTO v_slot FROM pg_catalog.generate_subscripts(v_slots,1) AS g(n)
          WHERE NOT v_used[g.n] ORDER BY
            (v_slots[g.n] IN ('shipped','delivered') AND v_preferred IN ('shipped','delivered')) DESC,g.n LIMIT 1;
      END IF;
      IF v_slot IS NULL THEN RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
      v_used[v_slot]:=true;v_values[v_slot]:=v_unit.paid_amount;
    END LOOP;
    RETURN QUERY SELECT v_item.id,s.value,pg_catalog.sum(v_values[s.n])::integer
      FROM pg_catalog.unnest(v_slots) WITH ORDINALITY AS s(value,n) GROUP BY s.value;
  END LOOP;
END;
$$;


CREATE OR REPLACE FUNCTION private.return_units_amount(_order_item_id uuid,_quantity integer,_offset integer DEFAULT 0)
RETURNS integer LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_units integer[];
BEGIN
  v_units:=private.group_h_available_unit_amounts(_order_item_id,NULL);
  IF v_units IS NOT NULL THEN
    IF _quantity IS NULL OR _offset IS NULL OR _quantity<0 OR _offset<0
      THEN
      RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
    IF _quantity=0 THEN RETURN 0; END IF;
    IF _quantity::bigint+_offset>pg_catalog.cardinality(v_units) THEN
      RAISE EXCEPTION 'GROUP_H_REFUND_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
    RETURN (SELECT COALESCE(pg_catalog.sum(x.amount),0)::integer
      FROM pg_catalog.unnest(v_units[(_offset+1):(_offset+_quantity)]) AS x(amount));
  END IF;
  RETURN (SELECT private.return_refund_amount(oi.line_kind, oi.item_price, oi.quantity, d.line_discount, oi.exchange_paid_amount,
           f.refunded_before_shipment + f.refunded_after_shipment + _offset, _quantity)
  FROM public.order_items AS oi
  JOIN private.order_line_fulfillment(oi.order_id) AS f ON f.order_item_id=oi.id
  JOIN private.order_line_discounts(oi.order_id) AS d ON d.order_item_id=oi.id
  WHERE oi.id=_order_item_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.load_order_refund_materials(_order_id uuid)
RETURNS TABLE (
  order_id uuid,
  order_status public.order_status,
  total_amount integer,
  shipping_amount integer,
  discount_amount integer,
  paid_amount integer,
  succeeded_amount integer,
  open_amount integer,
  refundable_amount integer,
  refunded_shipping integer,
  refundable_shipping integer,
  shipped_total integer,
  unshipped_total integer,
  awaiting_refund_id uuid,
  awaiting_refund_amount integer,
  awaiting_refund_created_at timestamptz,
  lines jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.id,
         o.status,
         o.total_amount,
         o.shipping_amount,
         o.discount_amount,
         a.paid_amount,
         a.succeeded_amount,
         a.open_amount,
         a.refundable_amount,
         a.refunded_shipping,
         a.refundable_shipping,
         c.shipped_total,
         c.unshipped_total,
         w.id,
         w.amount,
         w.created_at,
         c.lines
  FROM public.orders AS o
  CROSS JOIN LATERAL private.order_refund_amounts(o.id) AS a
  CROSS JOIN LATERAL (
    SELECT COALESCE(pg_catalog.sum(f.shipped), 0)::integer AS shipped_total,
           COALESCE(pg_catalog.sum(f.unshipped), 0)::integer AS unshipped_total,
           COALESCE(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'order_item_id', f.order_item_id,
                 'fulfillment_type', f.fulfillment_type,
                 'item_price', oi.item_price,
                 'quantity', f.quantity,
                 'line_total', oi.line_total,
                 'exchange_paid_amount', oi.exchange_paid_amount,
                 'available_unit_amounts', private.group_h_available_unit_amounts(oi.id,NULL),
                 'shipped', f.shipped,
                 'unshipped', f.unshipped,
                 'refunded_before_shipment', f.refunded_before_shipment,
                 'refunded_after_shipment', f.refunded_after_shipment,
                 'shipped_refundable', rc.refundable_after_shipment,
                 -- Existing business rule (unchanged).
                 'restockable', CASE
                   WHEN f.fulfillment_type = 'stock' THEN LEAST(f.unshipped, r.reserved)
                   ELSE 0
                 END,
                 'line_discount', d.line_discount,
                 'refunded_units', f.refunded_before_shipment + f.refunded_after_shipment
               )
               ORDER BY oi.created_at, oi.id
             ),
             '[]'::jsonb
           ) AS lines
    FROM private.order_line_fulfillment(o.id) AS f
    JOIN private.order_line_return_counts(o.id) AS rc ON rc.order_item_id=f.order_item_id
    JOIN public.order_items AS oi ON oi.id = f.order_item_id
    JOIN private.order_line_reservations(o.id) AS r ON r.order_item_id = f.order_item_id
    JOIN private.order_line_discounts(o.id) AS d ON d.order_item_id = f.order_item_id
  ) AS c
  LEFT JOIN LATERAL (
    SELECT ar.id, ar.amount, ar.created_at
    FROM public.order_refunds AS ar
    WHERE ar.order_id = o.id
      AND ar.status = 'awaiting_response'
    ORDER BY ar.created_at DESC, ar.id DESC
    LIMIT 1
  ) AS w ON true
  WHERE o.id = _order_id
$$;
ALTER FUNCTION public.load_order_refund_materials(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.load_order_refund_materials(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_order_refund_materials(uuid) TO service_role;

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
  _return_fee_deduction integer
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
BEGIN
  -- Existing business rule (unchanged).
  IF _order_id IS NULL
     OR _source IS NULL
     OR _source NOT IN ('admin', 'order_cancel', 'auto_cancelled_order_payment', 'auto_amount_mismatch', 'return')
     OR ((_source = 'return') IS DISTINCT FROM (_return_id IS NOT NULL))
     OR (_source = 'return' AND (_return_fee_deduction IS NULL OR _return_fee_deduction < 0))
     OR (_source <> 'return' AND _return_fee_deduction IS NOT NULL)
     OR _lines IS NULL
     OR _restock IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_is_admin := _source IN ('admin', 'return');
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
  IF v_is_admin AND (
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
  IF v_is_admin THEN
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
               'amount', CASE WHEN _source='return' AND EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=q.order_item_id)
                 THEN private.group_h_return_refund_amount(_return_id,q.order_item_id,q.quantity,_request_key)
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

  IF _source <> 'return' THEN
    -- Existing business rule (unchanged).
    PERFORM private.refresh_order_return_status(rt.id) FROM public.order_returns AS rt
    WHERE rt.order_id=_order_id AND rt.status='open' ORDER BY rt.id;
  END IF;
  RETURN QUERY SELECT v_refund_id, v_amount, 'awaiting_response'::text, false;
END;
$$;
ALTER FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)
  FROM PUBLIC, anon, authenticated, service_role;

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
                 ) ORDER BY x.created_at, x.order_item_id
               ), '[]'::jsonb)
        INTO v_lines
        FROM (
          SELECT l.order_item_id,
                 l.unshipped,
                 CASE WHEN l.fulfillment_type = 'stock' THEN 'cancel' ELSE 'no_restock' END AS restock_type,
                 CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=oi.id)
                   THEN private.return_units_amount(oi.id,l.unshipped)
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
          FROM private.order_line_fulfillment(_order_id) AS l
          JOIN public.order_items AS oi ON oi.id = l.order_item_id
          LEFT JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = l.order_item_id
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
        v_h_amount:=private.group_h_claim_refund_units(v_refund_id,v_h_line.order_item_id,v_h_line.quantity,true,NULL);
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
ALTER FUNCTION private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)
  TO service_role;

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
ALTER FUNCTION private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

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
ALTER FUNCTION private.mark_order_refund_error(uuid,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.mark_order_refund_error(uuid,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.mark_order_refund_error(uuid,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION private.admin_create_return(
  _order_id uuid,
  _actor_id uuid,
  _request_key uuid,
  _lines jsonb,
  _return_method text,
  _return_shipping_payer text,
  _return_carrier text,
  _return_tracking_number text,
  _return_shipping_fee integer,
  _restocking_fee_percent integer,
  _exchange_fee integer,
  _exchange_shipping_fee integer,
  _shop_note text,
  _notify_customer boolean
)
RETURNS TABLE (return_id uuid, number integer, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_fingerprint text;
  v_note text;
  v_order public.orders;
  v_existing public.order_returns;
  v_settings public.shop_return_settings;
  v_shipping_fee integer;
  v_restocking_percent integer;
  v_exchange_fee integer;
  v_exchange_shipping_fee integer;
  v_number integer;
  v_return_id uuid;
  v_constraint text;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  -- Existing business rule (unchanged).
  IF _order_id IS NULL
     OR _actor_id IS NULL
     OR _request_key IS NULL
     OR _notify_customer IS NULL
     OR _return_method IS NULL
     OR _return_method NOT IN ('customer_ships', 'shop_label', 'not_required')
     OR _return_shipping_payer IS NULL
     OR _return_shipping_payer NOT IN ('shop', 'customer')
     OR (_return_carrier IS NOT NULL AND _return_carrier NOT IN ('yamato', 'sagawa', 'japanpost', 'other'))
     OR (_return_tracking_number IS NOT NULL AND _return_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
     OR (_return_method = 'not_required' AND (_return_carrier IS NOT NULL OR _return_tracking_number IS NOT NULL))
     OR (_shop_note IS NOT NULL AND pg_catalog.char_length(_shop_note) > 500) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  IF (_return_shipping_fee IS NOT NULL AND (_return_shipping_fee < 0 OR _return_shipping_fee > 1000000))
     OR (_exchange_fee IS NOT NULL AND (_exchange_fee < 0 OR _exchange_fee > 1000000))
     OR (_exchange_shipping_fee IS NOT NULL AND (_exchange_shipping_fee < 0 OR _exchange_shipping_fee > 1000000))
     OR (_restocking_fee_percent IS NOT NULL AND (_restocking_fee_percent < 0 OR _restocking_fee_percent > 100)) THEN
    RAISE EXCEPTION 'RETURN_FEE_INVALID' USING ERRCODE = '22023';
  END IF;

  v_note := NULLIF(pg_catalog.btrim(_shop_note), '');

  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  v_fingerprint := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'order_id', _order_id,
      'lines', COALESCE((
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'fulfillment_id', p.fulfillment_id,
                   'order_item_id', p.order_item_id,
                   'quantity', p.quantity,
                   'reason', p.reason,
                   'reason_note', p.reason_note,
                   'resolution', p.resolution,
                   'exchange_variant_id', p.exchange_variant_id,
                   'exchange_method', p.exchange_method
                 )
                 ORDER BY p.fulfillment_id, p.order_item_id, p.resolution, p.reason,
                          p.exchange_variant_id NULLS FIRST, p.exchange_method NULLS FIRST, p.quantity,
                          p.reason_note NULLS FIRST
               )
        FROM private.parse_return_lines(_lines) AS p
      ), '[]'::jsonb),
      'return_method', _return_method,
      'return_shipping_payer', _return_shipping_payer,
      'return_carrier', _return_carrier,
      'return_tracking_number', _return_tracking_number,
      'return_shipping_fee', _return_shipping_fee,
      'restocking_fee_percent', _restocking_fee_percent,
      'exchange_fee', _exchange_fee,
      'exchange_shipping_fee', _exchange_shipping_fee,
      'shop_note', _shop_note,
      'notify_customer', _notify_customer
    )::text
  );

  -- Discover exchange variants with reads, then acquire the complete ordered closure.
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT p.exchange_variant_id ORDER BY p.exchange_variant_id), ARRAY[]::bigint[])
    INTO v_variants FROM private.parse_return_lines(_lines) AS p WHERE p.exchange_variant_id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[_order_id], NULL);
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  SELECT r.* INTO v_existing FROM public.order_returns AS r WHERE r.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.order_id <> _order_id OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.number, v_existing.status, true;
    RETURN;
  END IF;

  -- Existing business rule (unchanged).
  IF v_order.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status) THEN
    RAISE EXCEPTION 'ORDER_NOT_RETURNABLE' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  IF NOT private.shop_return_address_set() THEN
    RAISE EXCEPTION 'RETURN_ADDRESS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT s.* INTO v_settings FROM public.shop_return_settings AS s WHERE s.id = 1;

  -- Existing business rule (unchanged).
  IF _return_method = 'not_required' AND NOT v_settings.no_return_needed_enabled THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.order_fulfillment_lines AS fl
      JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id
      WHERE fl.fulfillment_id = p.fulfillment_id
        AND fl.order_item_id = p.order_item_id
        AND f.order_id = _order_id
    )
  ) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    JOIN public.order_fulfillments AS f ON f.id = p.fulfillment_id
    WHERE f.cancelled_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.fulfillment_id, p.order_item_id, pg_catalog.sum(p.quantity)::integer AS requested
      FROM private.parse_return_lines(_lines) AS p
      GROUP BY p.fulfillment_id, p.order_item_id
    ) AS g
    LEFT JOIN private.fulfillment_line_returnable(_order_id) AS fr
      ON fr.fulfillment_id = g.fulfillment_id AND fr.order_item_id = g.order_item_id
    WHERE g.requested > COALESCE(fr.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT p.order_item_id, pg_catalog.sum(p.quantity)::integer AS requested
      FROM private.parse_return_lines(_lines) AS p
      GROUP BY p.order_item_id
    ) AS g
    LEFT JOIN private.order_line_return_counts(_order_id) AS c ON c.order_item_id = g.order_item_id
    WHERE g.requested > COALESCE(c.returnable, 0)
  ) THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  IF EXISTS (
    SELECT 1
    FROM private.parse_return_lines(_lines) AS p
    JOIN public.order_items AS oi ON oi.id = p.order_item_id
    WHERE p.resolution = 'exchange'
      AND NOT EXISTS (
        SELECT 1
        FROM public.item_variants AS v
        WHERE v.id = p.exchange_variant_id
          AND v.item_id = oi.item_id
          AND v.is_active
      )
  ) THEN
    RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  v_shipping_fee := CASE
    WHEN _return_method <> 'shop_label' OR _return_shipping_payer = 'shop' THEN 0
    WHEN _return_shipping_fee IS NOT NULL THEN _return_shipping_fee
    ELSE v_settings.shop_label_fee
  END;
  v_restocking_percent := COALESCE(
    _restocking_fee_percent,
    CASE WHEN v_settings.restocking_fee_enabled THEN v_settings.restocking_fee_percent ELSE 0 END
  );
  v_exchange_fee := COALESCE(
    _exchange_fee,
    CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_fee ELSE 0 END
  );
  v_exchange_shipping_fee := COALESCE(
    _exchange_shipping_fee,
    CASE WHEN v_settings.exchange_fees_enabled THEN v_settings.exchange_shipping_fee ELSE 0 END
  );

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  -- Existing business rule (unchanged).
  SELECT pg_catalog.count(*)::integer + 1 INTO v_number FROM public.order_returns AS r WHERE r.order_id = _order_id;

  BEGIN
    INSERT INTO public.order_returns AS r
      (order_id, number, source, status, request_key, request_fingerprint, approved_at, approved_by,
       return_method, return_shipping_payer, return_carrier, return_tracking_number,
       return_shipping_fee, restocking_fee_percent, exchange_fee, exchange_shipping_fee,
       notify_customer, shop_note, created_by)
    VALUES
      (_order_id, v_number, 'shop', 'open', _request_key, v_fingerprint, pg_catalog.now(), _actor_id,
       _return_method, _return_shipping_payer, _return_carrier, _return_tracking_number,
       v_shipping_fee, v_restocking_percent, v_exchange_fee, v_exchange_shipping_fee,
       _notify_customer, v_note, _actor_id)
    RETURNING r.id INTO v_return_id;
  EXCEPTION WHEN unique_violation THEN
    -- Existing business rule (unchanged).
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'order_returns_request_key_key' THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RAISE;
  END;

  INSERT INTO public.order_return_lines
    (return_id, fulfillment_id, order_item_id, quantity, reason, reason_note, resolution, exchange_variant_id, exchange_method)
  SELECT v_return_id, p.fulfillment_id, p.order_item_id, p.quantity, p.reason, p.reason_note, p.resolution,
         p.exchange_variant_id, p.exchange_method
  FROM private.parse_return_lines(_lines) AS p;

  -- H5: approval fixes the cheapest units for this return, including zero-discount H lines.
  PERFORM private.group_h_claim_return_units(l.id,l.order_item_id,l.quantity)
  FROM public.order_return_lines AS l WHERE l.return_id=v_return_id
    AND EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=l.order_item_id) ORDER BY l.id;
  -- Existing business rule (unchanged).
  IF _notify_customer THEN
    PERFORM private.enqueue_return_email(_order_id, 'return_accepted', v_return_id, NULL::uuid);
  END IF;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_create_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_create_return', _request_key,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_create_return', 'order_id', _order_id, 'actor_id', _actor_id,
      'request_fingerprint', v_fingerprint)::text, 'UTF8')), 'hex'),
    'order_return', v_return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', v_return_id, 'order_id', _order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT v_return_id, v_number, 'open'::text, false;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION private.admin_approve_return(
  _return_id uuid, _actor_id uuid, _lines jsonb, _return_method text,
  _return_shipping_payer text, _return_carrier text, _return_tracking_number text,
  _return_shipping_fee integer, _restocking_fee_percent integer, _exchange_fee integer,
  _exchange_shipping_fee integer, _shop_note text, _notify_customer boolean
) RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_j jsonb; v_id uuid; v_variant bigint; v_seen uuid[] := ARRAY[]::uuid[];
  v_lines jsonb := '[]'::jsonb;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_order_id uuid;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _notify_customer IS NULL
    OR _return_method IS NULL OR _return_method NOT IN ('customer_ships', 'shop_label', 'not_required')
    OR _return_shipping_payer IS NULL OR _return_shipping_payer NOT IN ('shop', 'customer')
    OR (_return_carrier IS NOT NULL AND _return_carrier NOT IN ('yamato', 'sagawa', 'japanpost', 'other'))
    OR (_return_tracking_number IS NOT NULL AND _return_tracking_number !~ '^[0-9A-Za-z-]{1,64}$')
    OR (_return_method = 'not_required' AND (_return_carrier IS NOT NULL OR _return_tracking_number IS NOT NULL))
    OR pg_catalog.char_length(_shop_note) > 500 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Existing business rule (unchanged).
  IF _return_shipping_fee IS NULL OR _return_shipping_fee NOT BETWEEN 0 AND 1000000
    OR _restocking_fee_percent IS NULL OR _restocking_fee_percent NOT BETWEEN 0 AND 100
    OR _exchange_fee IS NULL OR _exchange_fee NOT BETWEEN 0 AND 1000000
    OR _exchange_shipping_fee IS NULL OR _exchange_shipping_fee NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'RETURN_FEE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_lines) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR COALESCE(v_j->>'resolution', '') NOT IN ('refund', 'exchange')
      OR NOT (v_j ?& ARRAY['return_line_id','resolution','exchange_variant_id','exchange_method']) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_id := (v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END;
    IF v_id = ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_seen := v_seen || v_id;
    v_variant := NULL;
    IF v_j->>'resolution' = 'refund' THEN
      IF v_j->>'exchange_variant_id' IS NOT NULL OR v_j->>'exchange_method' IS NOT NULL THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
    ELSE
      IF pg_catalog.jsonb_typeof(v_j->'exchange_variant_id') IS DISTINCT FROM 'number'
        OR (v_j->>'exchange_variant_id') !~ '^-?[0-9]{1,18}$'
        OR COALESCE(v_j->>'exchange_method','') NOT IN ('stock','make') THEN
        RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_variant := (v_j->>'exchange_variant_id')::bigint;
    END IF;
    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'return_line_id',v_id,'resolution',v_j->>'resolution',
      'exchange_variant_id',v_variant,'exchange_method',v_j->>'exchange_method'));
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.id = _return_id) AND (
    pg_catalog.cardinality(v_seen) <> (SELECT pg_catalog.count(*) FROM public.order_return_lines AS l WHERE l.return_id = _return_id)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_seen) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.order_return_lines AS l WHERE l.return_id = _return_id AND l.id = x.id))
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023'; END IF;
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.exchange_variant_id ORDER BY x.exchange_variant_id), ARRAY[]::bigint[])
    INTO v_variants FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(exchange_variant_id bigint)
    WHERE x.exchange_variant_id IS NOT NULL;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);
  IF v_return.status <> 'requested' THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;
  IF NOT private.shop_return_address_set() THEN
    RAISE EXCEPTION 'RETURN_ADDRESS_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF _return_method = 'not_required' AND NOT (
    SELECT s.no_return_needed_enabled FROM public.shop_return_settings AS s WHERE s.id = 1
  ) THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023'; END IF;
  -- Existing business rule (unchanged).
  IF pg_catalog.cardinality(v_seen) <> (SELECT pg_catalog.count(*) FROM public.order_return_lines AS l WHERE l.return_id = _return_id)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_seen) AS x(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.order_return_lines AS l WHERE l.return_id = _return_id AND l.id = x.id)) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(return_line_id uuid,resolution text,exchange_variant_id bigint)
    JOIN public.order_return_lines AS l ON l.id = x.return_line_id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id
    WHERE x.resolution = 'exchange' AND NOT EXISTS (
      SELECT 1 FROM public.item_variants AS v WHERE v.id = x.exchange_variant_id AND v.item_id = oi.item_id AND v.is_active
    )
  ) THEN RAISE EXCEPTION 'RETURN_EXCHANGE_VARIANT_INVALID' USING ERRCODE = '22023'; END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  UPDATE public.order_return_lines AS l
  SET resolution = x.resolution, exchange_variant_id = x.exchange_variant_id, exchange_method = x.exchange_method
  FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(return_line_id uuid,resolution text,exchange_variant_id bigint,exchange_method text)
  WHERE l.id = x.return_line_id AND l.return_id = _return_id;
  UPDATE public.order_returns AS r
  SET status = 'open', approved_at = pg_catalog.now(), approved_by = _actor_id,
      return_method = _return_method, return_shipping_payer = _return_shipping_payer,
      return_carrier = _return_carrier, return_tracking_number = _return_tracking_number,
      return_shipping_fee = CASE WHEN _return_method = 'shop_label' AND _return_shipping_payer = 'customer'
        THEN _return_shipping_fee ELSE 0 END,
      restocking_fee_percent = _restocking_fee_percent, exchange_fee = _exchange_fee,
      exchange_shipping_fee = _exchange_shipping_fee, shop_note = NULLIF(pg_catalog.btrim(_shop_note), ''),
      notify_customer = _notify_customer
  WHERE r.id = _return_id;
  -- H5: approval fixes the cheapest units for this return, including zero-discount H lines.
  PERFORM private.group_h_claim_return_units(l.id,l.order_item_id,l.quantity)
  FROM public.order_return_lines AS l WHERE l.return_id=_return_id
    AND EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=l.order_item_id) ORDER BY l.id;
  IF _notify_customer THEN
    PERFORM private.enqueue_return_email(v_return.order_id, 'return_accepted', _return_id, NULL);
  END IF;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_approve_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_approve_return', pg_catalog.md5('admin_approve_return:' || _return_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_approve_return', 'order_id', v_order_id, 'actor_id', _actor_id,
      'request_fingerprint', pg_catalog.jsonb_build_object('return_id', _return_id, 'actor_id', _actor_id, 'lines', _lines, 'return_method', _return_method, 'return_shipping_payer', _return_shipping_payer, 'return_carrier', _return_carrier, 'return_tracking_number', _return_tracking_number, 'return_shipping_fee', _return_shipping_fee, 'restocking_fee_percent', _restocking_fee_percent, 'exchange_fee', _exchange_fee, 'exchange_shipping_fee', _exchange_shipping_fee, 'shop_note', _shop_note, 'notify_customer', _notify_customer)::text)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT _return_id, 'open'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean) TO service_role;

CREATE OR REPLACE FUNCTION private.admin_cancel_return(_return_id uuid, _actor_id uuid)
RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_return public.order_returns;
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_order_id uuid;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);

  IF v_return.status <> 'open'
     OR EXISTS (
       SELECT 1
       FROM private.order_return_line_progress(_return_id) AS p
       WHERE p.processed > 0
     ) THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  UPDATE public.order_returns AS r
  SET status = 'cancelled',
      cancelled_at = pg_catalog.now(),
      cancelled_by = _actor_id
  WHERE r.id = _return_id;

  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  UPDATE private.order_email_outbox AS e
  SET status = 'skipped',
      finished_at = pg_catalog.now(),
      subject = NULL,
      body_text = NULL,
      body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
      last_error_code = 'return_cancelled'
  WHERE e.return_id = _return_id
    AND e.kind = 'return_accepted'
    AND e.status IN ('pending', 'retry_wait');

  PERFORM private.group_h_release_return_units(_return_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'admin_cancel_return', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_cancel_return', pg_catalog.md5('admin_cancel_return:' || _return_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_cancel_return', 'order_id', v_order_id, 'actor_id', _actor_id,
      'request_fingerprint', pg_catalog.jsonb_build_object('return_id', _return_id, 'actor_id', _actor_id)::text)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT _return_id, 'cancelled'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_cancel_return(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_cancel_return(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_cancel_return(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION private.admin_decline_return(
  _return_id uuid, _actor_id uuid, _decline_reason text, _decline_message text
) RETURNS TABLE (return_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE v_return public.order_returns; v_message text := NULLIF(pg_catalog.btrim(_decline_message), '');
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_order_id uuid;
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _decline_reason IS NULL
    OR _decline_reason NOT IN ('window_passed','final_sale','other') THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_message IS NULL OR pg_catalog.char_length(v_message) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'RETURN_DECLINE_MESSAGE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT r.order_id INTO v_order_id FROM public.order_returns AS r WHERE r.id = _return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_orders := private.lock_group_g_inventory(v_variants, ARRAY[v_order_id], NULL);
  v_return := private.lock_order_return(_return_id);
  IF v_return.status <> 'requested' THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE = '22023'; END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  UPDATE public.order_returns AS r SET status='declined',declined_at=pg_catalog.now(),declined_by=_actor_id,
    decline_reason=_decline_reason,decline_message=v_message WHERE r.id=_return_id;
  PERFORM private.group_h_release_return_units(_return_id);
  PERFORM private.enqueue_return_email(v_return.order_id,'return_declined',_return_id,NULL);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'return_declined_restore', _actor_id);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (v_operation, 'admin_decline_return', pg_catalog.md5('admin_decline_return:' || _return_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'admin_decline_return', 'order_id', v_order_id, 'actor_id', _actor_id,
      'request_fingerprint', pg_catalog.jsonb_build_object('return_id', _return_id, 'actor_id', _actor_id, 'decline_reason', _decline_reason, 'decline_message', _decline_message)::text)::text, 'UTF8')), 'hex'),
    'order_return', _return_id::text, _actor_id,
    pg_catalog.jsonb_build_object('return_id', _return_id, 'order_id', v_order_id));
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT _return_id,'declined'::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_decline_return(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_decline_return(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_decline_return(uuid,uuid,text,text) TO service_role;

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
  v_orders uuid[];
  v_variants bigint[] := ARRAY[]::bigint[];
  v_order_id uuid;
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _actor_can_refund IS NULL OR _request_key IS NULL
    OR _notify_customer IS NULL OR _refund_choice IS NULL OR _refund_choice NOT IN ('now','consult','none')
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
  IF _refund_choice<>'now' AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0) THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  FOR v_j IN SELECT x.value FROM pg_catalog.jsonb_array_elements(_units) AS x(value) LOOP
    IF pg_catalog.jsonb_typeof(v_j) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(v_j->'return_line_id') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_j->'quantity') IS DISTINCT FROM 'number'
      OR (v_j->>'quantity') !~ '^[1-9][0-9]{0,2}$'
      OR COALESCE(v_j->>'disposition','') NOT IN ('restocked','not_restocked','pending_inspection','sent_back') THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023';
    END IF;
    BEGIN v_id:=(v_j->>'return_line_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END;
    IF (v_id::text||':'||(v_j->>'disposition'))=ANY(v_seen) THEN
      RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_seen:=v_seen||(v_id::text||':'||(v_j->>'disposition'));
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
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',x.return_line_id,'disposition',x.disposition,'quantity',x.quantity)
    ORDER BY x.return_line_id,x.disposition) INTO v_units
  FROM pg_catalog.jsonb_to_recordset(_units) AS x(return_line_id uuid,disposition text,quantity integer);
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
  IF NOT _actor_can_refund AND _refund_choice='now' AND NOT (v_return.source='customer_request' AND v_return.return_method<>'not_required') THEN RAISE EXCEPTION 'RETURN_FORBIDDEN' USING ERRCODE='22023'; END IF;
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
  -- Existing business rule (unchanged).
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
  -- Existing business rule (unchanged).
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('return_line_id',u.return_line_id,
      'disposition',u.disposition,'quantity',u.quantity,
      'resolution',CASE WHEN u.disposition='sent_back' THEN NULL WHEN x.action='refund' THEN 'refund' ELSE l.resolution END,
      'exchange_method',CASE WHEN u.disposition='sent_back' OR l.resolution='refund' OR x.action='refund' THEN NULL
        WHEN x.action='make' THEN 'make' ELSE l.exchange_method END) ORDER BY u.return_line_id,u.disposition)
    INTO v_effective
  FROM pg_catalog.jsonb_to_recordset(v_units) AS u(return_line_id uuid,disposition text,quantity integer)
  JOIN public.order_return_lines AS l ON l.id=u.return_line_id
  LEFT JOIN pg_catalog.jsonb_to_recordset(v_overrides) AS x(return_line_id uuid,action text) ON x.return_line_id=l.id;
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
          AND u.resolution='exchange' THEN v_action ELSE u.exchange_method END) ORDER BY u.return_line_id,u.disposition)
      INTO v_effective
    FROM pg_catalog.jsonb_to_recordset(v_effective) AS u(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text);
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
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  WITH before_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states(v_order) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  ), after_receive AS (
    SELECT s.order_item_id, pg_catalog.sum(s.refund_waiting)::integer AS waiting
    FROM private.order_return_line_states_core(v_order,v_effective) AS s
    WHERE s.return_id=_return_id GROUP BY s.order_item_id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,'before_shipment',false,'quantity',t.quantity)
      ORDER BY t.order_item_id) FILTER(WHERE t.quantity>0),'[]'::jsonb),
    COALESCE(pg_catalog.sum(CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=t.order_item_id)
      THEN private.group_h_receiving_amount(_return_id,t.order_item_id,t.quantity,v_effective)
      ELSE private.return_units_amount(t.order_item_id,t.quantity) END) FILTER(WHERE t.quantity>0),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,LEAST(pg_catalog.sum(x.quantity)::integer,
        GREATEST(a.waiting-b.waiting,0)) AS quantity
      FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text)
      JOIN public.order_return_lines AS l ON l.id=x.return_line_id
      JOIN before_receive AS b ON b.order_item_id=l.order_item_id
      JOIN after_receive AS a ON a.order_item_id=l.order_item_id
      WHERE x.resolution='refund'
      GROUP BY l.order_item_id,a.waiting,b.waiting
    ) AS t;
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  IF _refund_choice='now' AND (_refund_amount IS NOT NULL OR _refund_shipping_amount<>0)
    AND (SELECT COALESCE(pg_catalog.sum(x.quantity),0)
      FROM pg_catalog.jsonb_to_recordset(v_lines) AS x(quantity integer))
      < (SELECT COALESCE(pg_catalog.sum(x.quantity),0)
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(resolution text,quantity integer)
        WHERE x.resolution='refund') THEN
    RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023';
  END IF;
  IF _refund_choice='none' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- Existing business rule (unchanged).
  -- Existing business rule (unchanged).
  v_choice:=CASE WHEN pg_catalog.jsonb_array_length(v_lines)=0 THEN 'none' ELSE _refund_choice END;
  v_first_goods:=NOT EXISTS(SELECT 1 FROM public.order_return_receipts AS rr
    JOIN public.order_return_receipt_lines AS u ON u.receipt_id=rr.id
    WHERE rr.return_id=_return_id AND rr.kind='receive' AND u.resolution IN ('refund','exchange'));
  v_first_exchange:=NOT EXISTS(SELECT 1 FROM public.order_items AS e
    JOIN public.order_return_lines AS l ON l.id=e.exchange_return_line_id
    WHERE l.return_id=_return_id AND NOT (e.id=ANY(v_exchange_ids)));
  v_fees:=(v_goods::bigint*v_return.restocking_fee_percent/100)::integer
    +CASE WHEN v_first_goods AND (pg_catalog.jsonb_array_length(v_lines)>0 OR v_exchange>0) AND v_return.return_method='shop_label'
      THEN v_return.return_shipping_fee ELSE 0 END
    +CASE WHEN v_first_exchange AND v_exchange>0 THEN v_return.exchange_fee+v_return.exchange_shipping_fee ELSE 0 END;
  IF _refund_choice='consult' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN v_pending:=v_fees;
  ELSIF _refund_choice='now' AND pg_catalog.jsonb_array_length(v_lines)>0 THEN
    v_amount:=GREATEST(v_goods-v_fees,0)+_refund_shipping_amount;
    -- Existing business rule (unchanged).
    IF _refund_amount IS NOT NULL THEN
      IF _refund_amount<_refund_shipping_amount
        OR _refund_amount>(SELECT a.refundable_amount FROM private.order_refund_amounts(v_order) AS a) THEN
        RAISE EXCEPTION 'RETURN_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
      v_amount:=_refund_amount;
    END IF;
    v_due:=GREATEST(v_fees-v_goods,0);
    IF v_amount=0 THEN v_waived:=true;v_status:='waived';
    ELSE v_refund:=pg_catalog.gen_random_uuid(); END IF;
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
  INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
  SELECT v_receipt,x.return_line_id,x.disposition,x.quantity,x.resolution,x.exchange_method
  FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,disposition text,quantity integer,resolution text,exchange_method text);
  IF v_waived THEN
    -- Existing business rule (unchanged).
    INSERT INTO public.order_return_receipt_lines(receipt_id,return_line_id,disposition,quantity,resolution,exchange_method)
    SELECT v_receipt,w.return_line_id,'refund_waived',w.waived,NULL,NULL FROM (
      SELECT u.return_line_id,LEAST(u.quantity,GREATEST(c.quantity-COALESCE(pg_catalog.sum(u.quantity) OVER(
          PARTITION BY u.order_item_id ORDER BY u.return_line_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::integer,0)) AS waived
      FROM (
        SELECT x.return_line_id,l.order_item_id,pg_catalog.sum(x.quantity)::integer AS quantity
        FROM pg_catalog.jsonb_to_recordset(v_effective) AS x(return_line_id uuid,resolution text,quantity integer)
        JOIN public.order_return_lines AS l ON l.id=x.return_line_id
        WHERE x.resolution='refund' GROUP BY x.return_line_id,l.order_item_id
      ) AS u JOIN pg_catalog.jsonb_to_recordset(v_lines) AS c(order_item_id uuid,quantity integer) ON c.order_item_id=u.order_item_id
    ) AS w WHERE w.waived>0;
  END IF;
  IF v_refund IS NOT NULL THEN
    SELECT r.refund_id,r.amount,r.status INTO v_refund,v_amount,v_status
    FROM private.begin_order_refund_core(v_order,'return',_request_key,v_lines,false,_refund_shipping_amount,v_amount,
      _note,'requested_by_customer',NULL,_notify_customer,_actor_id,_refund_amount,_return_id,LEAST(v_fees,v_goods)) AS r;
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
  IF NOT _actor_can_refund AND v_choice='consult' THEN
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
ALTER FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION private.admin_refund_return(
  _return_id uuid,_actor_id uuid,_request_key uuid,_amount integer,
  _shipping_amount integer,_note text,_notify_customer boolean
) RETURNS TABLE(refund_id uuid,amount integer,status text,replayed boolean)
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
BEGIN
  IF _return_id IS NULL OR _actor_id IS NULL OR _request_key IS NULL OR _notify_customer IS NULL
    OR _shipping_amount IS NULL OR _shipping_amount<0 OR (_amount IS NOT NULL AND _amount<0)
    OR pg_catalog.char_length(_note)>500 THEN RAISE EXCEPTION 'RETURN_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
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
  SELECT r.* INTO v_old FROM public.order_refunds AS r WHERE r.request_key=_request_key;
  IF FOUND THEN
    IF v_old.return_id IS DISTINCT FROM _return_id OR v_old.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT v_old.id,v_old.amount,v_old.status,true;RETURN;
  END IF;
  SELECT rr.* INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.request_key=_request_key;
  IF FOUND THEN
    IF v_receipt.return_id IS DISTINCT FROM _return_id OR v_receipt.kind<>'waive_refund'
      OR v_receipt.request_fingerprint IS DISTINCT FROM v_fp THEN
      RAISE EXCEPTION 'RETURN_REQUEST_MISMATCH' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT NULL::uuid,0,'waived'::text,true;RETURN;
  END IF;
  -- Existing business rule (unchanged).
  IF v_return.status NOT IN ('open','closed') THEN RAISE EXCEPTION 'RETURN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id',t.order_item_id,
      'before_shipment',false,'quantity',t.quantity) ORDER BY t.order_item_id),'[]'::jsonb),
    COALESCE(pg_catalog.sum(CASE WHEN EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS hu WHERE hu.order_item_id=t.order_item_id)
      THEN private.group_h_return_refund_amount(_return_id,t.order_item_id,t.quantity)
      ELSE private.return_units_amount(t.order_item_id,t.quantity) END),0)::integer
    INTO v_lines,v_goods FROM (
      SELECT l.order_item_id,pg_catalog.sum(g.refund_waiting)::integer AS quantity
      FROM private.order_return_line_progress(_return_id) AS g JOIN public.order_return_lines AS l ON l.id=g.return_line_id
      WHERE g.refund_waiting>0 GROUP BY l.order_item_id
    ) AS t;
  IF pg_catalog.jsonb_array_length(v_lines)=0 THEN RAISE EXCEPTION 'RETURN_NOTHING_TO_REFUND' USING ERRCODE='22023'; END IF;
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
    LEAST(v_return.fee_pending_deduction,v_goods)) AS r;
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

  IF v_amount=0 THEN RETURN QUERY SELECT NULL::uuid,0,'waived'::text,false;
  ELSE RETURN QUERY SELECT v_result.refund_id,v_result.amount,v_result.status,v_result.replayed; END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean) TO service_role;

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
  ) AS y LEFT JOIN private.group_h_return_amounts(_return_id) AS h ON h.return_line_id=y.id;

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

CREATE OR REPLACE FUNCTION private.group_g_order_item_rows(_order_ids uuid[])
RETURNS TABLE(order_id uuid, order_item_id uuid, status text, status_rank integer, quantity integer,
  blocked_reasons text[], is_exchange boolean, unit_price integer, line_amount integer, refund_amount integer, first_unit integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH orders AS MATERIALIZED (
    SELECT o.id FROM public.orders AS o WHERE o.id = ANY(_order_ids)
      AND o.status NOT IN ('payment_in_progress','abandoned')
  ), h_amounts AS MATERIALIZED (
    SELECT o.id AS order_id,h.* FROM orders AS o CROSS JOIN LATERAL private.group_h_order_unit_status_amounts(o.id) AS h
  ), discounts AS MATERIALIZED (
    SELECT d.* FROM orders AS o CROSS JOIN LATERAL private.order_line_discounts(o.id) AS d
  ), ranges AS MATERIALIZED (
    SELECT r.*, pg_catalog.array_position(ARRAY['unpaid','payment_expired','in_production','ready','shipped',
      'delivered','cancel_requested','cancelled','return_requested','return_in_progress','refund_waiting','returned'], r.status) AS rank,
      oi.quantity AS q, oi.line_kind = 'exchange' AS exchange,
      CASE WHEN oi.line_kind = 'exchange' THEN 0 ELSE oi.item_price END AS price,
      CASE WHEN oi.line_kind = 'exchange' THEN 0::bigint ELSE oi.line_total::bigint - d.line_discount END AS net
    FROM private.group_g_item_state_ranges(ARRAY(SELECT o.id FROM orders AS o)) AS r
    JOIN public.order_items AS oi ON oi.id = r.order_item_id
    JOIN discounts AS d ON d.order_item_id = oi.id
  ), refunds AS MATERIALIZED (
    SELECT l.order_item_id,
      CASE WHEN l.before_shipment THEN 'before' WHEN f.return_id IS NOT NULL THEN 'return' ELSE 'after' END AS kind,
      pg_catalog.sum(l.amount)::bigint AS amount, pg_catalog.sum(l.quantity)::bigint AS n
    FROM orders AS o JOIN public.order_refunds AS f ON f.order_id = o.id AND f.status = 'succeeded'
    JOIN public.order_refund_lines AS l ON l.refund_id = f.id
    JOIN public.order_items AS oi ON oi.id = l.order_item_id AND oi.order_id = o.id
    GROUP BY l.order_item_id, CASE WHEN l.before_shipment THEN 'before' WHEN f.return_id IS NOT NULL THEN 'return' ELSE 'after' END
  ), targets AS (
    SELECT r.*, f.kind, f.amount, f.n,
      (f.kind = 'before' AND r.status = 'cancelled' OR f.kind = 'return' AND r.status = 'returned'
        OR f.kind = 'after' AND r.status IN ('delivered','shipped')) AS target,
      COALESCE(pg_catalog.sum(r.unit_to - r.unit_from) FILTER (WHERE
        f.kind = 'before' AND r.status = 'cancelled' OR f.kind = 'return' AND r.status = 'returned'
        OR f.kind = 'after' AND r.status IN ('delivered','shipped'))
        OVER (PARTITION BY r.order_item_id, f.kind), 0)::bigint AS t
    FROM ranges AS r JOIN refunds AS f ON f.order_item_id = r.order_item_id
  ), positioned AS (
    SELECT t.*, LEAST(t.n, CASE WHEN t.t = 0 THEN t.q ELSE t.t END)::bigint AS m,
      COALESCE(pg_catalog.sum(t.unit_to - t.unit_from) OVER (PARTITION BY t.order_item_id, t.kind
        ORDER BY CASE WHEN t.t = 0 THEN t.rank WHEN t.status = 'delivered' THEN 0 ELSE 1 END, t.unit_from
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::bigint AS s
    FROM targets AS t WHERE t.target OR t.t = 0
  ), refund_parts AS (
    SELECT p.order_item_id, p.unit_from,
      pg_catalog.sum(p.amount * LEAST(p.s + p.unit_to - p.unit_from, p.m) / p.m
        - p.amount * LEAST(p.s, p.m) / p.m)::bigint AS amount
    FROM positioned AS p GROUP BY p.order_item_id, p.unit_from
  ), amounts AS MATERIALIZED (
    SELECT r.*, r.net * r.unit_to / r.q - r.net * r.unit_from / r.q AS sales,
      COALESCE(f.amount, 0::bigint) AS refund
    FROM ranges AS r LEFT JOIN refund_parts AS f ON f.order_item_id = r.order_item_id AND f.unit_from = r.unit_from
  ), grouped AS (
    SELECT a.order_id, a.order_item_id, a.status, a.rank, pg_catalog.sum(a.unit_to - a.unit_from)::integer AS quantity,
      a.exchange, a.price, pg_catalog.sum(a.sales)::integer AS sales, pg_catalog.sum(a.refund)::integer AS refund,
      pg_catalog.min(a.unit_from) AS first_unit
    FROM amounts AS a GROUP BY a.order_id, a.order_item_id, a.status, a.rank, a.exchange, a.price
  ), reasons AS (
    SELECT a.order_item_id, a.status, pg_catalog.array_agg(DISTINCT b.reason ORDER BY b.reason) AS reasons
    FROM amounts AS a CROSS JOIN LATERAL pg_catalog.unnest(a.blocked_reasons) AS b(reason)
    GROUP BY a.order_item_id, a.status
  )
  SELECT g.order_id, g.order_item_id, g.status, g.rank, g.quantity,
    COALESCE(x.reasons, ARRAY[]::text[]),
    g.exchange, g.price, COALESCE(h.line_amount,g.sales), g.refund, g.first_unit
  FROM grouped AS g LEFT JOIN reasons AS x ON x.order_item_id = g.order_item_id AND x.status = g.status
  LEFT JOIN h_amounts AS h ON h.order_id=g.order_id AND h.order_item_id=g.order_item_id AND h.status=g.status
  ORDER BY g.order_id, g.order_item_id, g.rank, g.first_unit
$$;

ALTER FUNCTION private.group_h_assert_unit_lock() OWNER TO postgres;
ALTER FUNCTION private.group_h_return_unit_dispositions(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_unit_dispositions(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_release_completed_return_claims() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_release_completed_return_claims() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.group_h_assert_unit_lock() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_guard_unit_claim() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_guard_unit_claim() FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_unit_rows(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_unit_rows(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_available_unit_amounts(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_available_unit_amounts(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_claim_return_units(uuid,uuid,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_claim_return_units(uuid,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_claim_refund_units(uuid,uuid,integer,boolean,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_claim_refund_units(uuid,uuid,integer,boolean,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_release_refund_units(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_release_refund_units(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_release_return_units(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_release_return_units(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_line_amount(uuid,integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_line_amount(uuid,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_refund_slices(uuid,uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_refund_slices(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_receiving_amount(uuid,uuid,integer,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_receiving_amount(uuid,uuid,integer,jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_refund_amount(uuid,uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_refund_amount(uuid,uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_return_amounts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_return_amounts(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_order_unit_status_amounts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_order_unit_status_amounts(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- H5_FINAL_ASSERT_BEGIN
DO $h5_final$
DECLARE e record;p record;v_detail text;v_oid oid;
BEGIN
  FOR e IN SELECT * FROM (VALUES
    ('private.group_h_assert_unit_lock()','void',true,'v','h5_unit_claims','2fb79279d92b7338bce847c5be87aa19',false,'plpgsql',0,''),
    ('private.group_h_return_unit_dispositions(uuid)','record',true,'s','h5_return_amounts','7ff8beef97cf06b8d7bb605d5d9daa18',true,'sql',0,'_return_line_id,unit_index,paid_amount,exchange_unit,released_unit'),
    ('private.group_h_release_completed_return_claims()','trigger',true,'v','h5_unit_claims','dd6e20286fe6f4460c5a01c25de47996',false,'plpgsql',0,''),
    ('private.group_h_guard_unit_claim()','trigger',true,'v','h5_unit_claims','6cabad4a243fdeddc63d879c6401b69a',false,'plpgsql',0,''),
    ('private.group_h_return_unit_rows(uuid)','record',true,'s','h5_return_amounts','6e16c3076246e0e179d3a15411464233',true,'sql',0,'_return_line_id,unit_index,paid_amount,exchange_unit,remaining_index'),
    ('private.group_h_available_unit_amounts(uuid,uuid)','integer[]',true,'s','h5_refund_amounts','696427c1d57872a29d688cf61726599b',false,'plpgsql',1,'_order_item_id,_return_id'),
    ('private.group_h_claim_return_units(uuid,uuid,integer)','integer',true,'v','h5_unit_claims','4f1971d4109d6a89fe74b763471bfd7a',false,'plpgsql',0,'_return_line_id,_order_item_id,_quantity'),
    ('private.group_h_claim_refund_units(uuid,uuid,integer,boolean,uuid)','integer',true,'v','h5_unit_claims','13bdf2ac11d47239768cb77ae9f02c57',false,'plpgsql',1,'_refund_id,_order_item_id,_quantity,_before_shipment,_return_line_id'),
    ('private.group_h_release_refund_units(uuid)','void',true,'v','h5_unit_claims','a8bb14351c35528ea9275964feff6782',false,'plpgsql',0,'_refund_id'),
    ('private.group_h_release_return_units(uuid)','void',true,'v','h5_unit_claims','dcc3e69b7ac9cd4a7b1c47fff2282cfa',false,'plpgsql',0,'_return_id'),
    ('private.group_h_return_line_amount(uuid,integer,integer)','integer',true,'s','h5_return_amounts','cb82998a45b5a6ec0654ec8eef1430c2',false,'plpgsql',1,'_return_line_id,_quantity,_offset'),
    ('private.group_h_return_refund_slices(uuid,uuid,integer,uuid)','record',true,'s','h5_return_amounts','d5d187273acad7b4c7d0fed718fbef01',true,'plpgsql',1,'_return_id,_order_item_id,_quantity,_request_key,return_line_id,quantity,unit_offset'),
    ('private.group_h_receiving_amount(uuid,uuid,integer,jsonb)','integer',true,'s','h5_refund_amounts','d68e7edb4f086d31840b5eb7bf351382',false,'plpgsql',0,'_return_id,_order_item_id,_quantity,_effective'),
    ('private.group_h_return_refund_amount(uuid,uuid,integer,uuid)','integer',true,'s','h5_return_amounts','c3d408a52dd065633c6a1f92076442bc',false,'plpgsql',1,'_return_id,_order_item_id,_quantity,_request_key'),
    ('private.group_h_return_amounts(uuid)','record',true,'s','h5_return_amounts','4af94338171b80d2bb2acdce5e53a4e5',true,'plpgsql',0,'_return_id,return_line_id,refund_amounts_by_count,refund_waiting_amount'),
    ('private.group_h_order_unit_status_amounts(uuid)','record',true,'s','h5_status_amounts','7594c04206478ea195797f5bc0473ea3',true,'plpgsql',0,'_order_id,order_item_id,status,line_amount'),
    ('private.return_units_amount(uuid,integer,integer)','integer',false,'s','h5_legacy_fallback','07c7ccb3c78e29b855090822babe9031',false,'plpgsql',1,'_order_item_id,_quantity,_offset'),
    ('public.load_order_refund_materials(uuid)','record',true,'s','h5_refund_amounts','6059050b552c896e1217174811f653f1',true,'sql',0,'_order_id,order_id,order_status,total_amount,shipping_amount,discount_amount,paid_amount,succeeded_amount,open_amount,refundable_amount,refunded_shipping,refundable_shipping,shipped_total,unshipped_total,awaiting_refund_id,awaiting_refund_amount,awaiting_refund_created_at,lines'),
    ('private.begin_order_refund_core(uuid,text,uuid,jsonb,boolean,integer,integer,text,text,text,boolean,uuid,integer,uuid,integer)','record',false,'v','h5_refund_amounts','87c95cb952b542f4df38bac5b84c2853',true,'plpgsql',0,'_order_id,_source,_request_key,_lines,_restock,_shipping_amount,_amount,_note,_stripe_reason,_cancel_reason,_notify_customer,_actor_id,_received_amount,_return_id,_return_fee_deduction,refund_id,amount,status,replayed'),
    ('private.record_external_order_refund(uuid,text,integer,text,text,text,timestamptz,text,text,text,text,timestamptz)','record',true,'v','h5_refund_amounts','ac9a228b87d7b89886cab63ad6c5276d',true,'plpgsql',0,'_order_id,_stripe_refund_id,_amount,_stripe_status,_stripe_pending_reason,_stripe_failure_reason,_customer_action_expires_at,_payment_method_type,_reference_number,_reference_type,_stripe_reason,_stripe_created_at,refund_id,created,source,status,newly_accepted,newly_failed,order_status,refunded_amount,rereserve_shortage,email_enqueued,exception_id'),
    ('private.record_group_g_refund_result(uuid,text,text,text,text,timestamptz,text,text,text,text,uuid[],jsonb)','record',true,'v','h5_refund_amounts','5c16901e99e81b498f14a798df58f9c4',true,'plpgsql',0,'_refund_id,_stripe_refund_id,_stripe_status,_stripe_pending_reason,_stripe_failure_reason,_customer_action_expires_at,_payment_method_type,_reference_number,_reference_type,_operation,_orders,_before,refund_id,order_id,status,newly_accepted,newly_failed,order_status,refunded_amount,rereserve_shortage,email_enqueued,exception_id'),
    ('private.mark_order_refund_error(uuid,text,boolean)','record',true,'v','h5_refund_amounts','4d3cce81b8d548f6686769c66d1cb8ce',true,'plpgsql',0,'_refund_id,_reason,_raise_exception,outcome,order_id,exception_id'),
    ('private.admin_create_return(uuid,uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)','record',true,'v','h5_return_amounts','38c37e3033860cf7e9bfb74f3d17e871',true,'plpgsql',0,'_order_id,_actor_id,_request_key,_lines,_return_method,_return_shipping_payer,_return_carrier,_return_tracking_number,_return_shipping_fee,_restocking_fee_percent,_exchange_fee,_exchange_shipping_fee,_shop_note,_notify_customer,return_id,number,status,replayed'),
    ('private.admin_approve_return(uuid,uuid,jsonb,text,text,text,text,integer,integer,integer,integer,text,boolean)','record',true,'v','h5_return_amounts','df4988293059636caffde41b5898ef19',true,'plpgsql',0,'_return_id,_actor_id,_lines,_return_method,_return_shipping_payer,_return_carrier,_return_tracking_number,_return_shipping_fee,_restocking_fee_percent,_exchange_fee,_exchange_shipping_fee,_shop_note,_notify_customer,return_id,status'),
    ('private.admin_cancel_return(uuid,uuid)','record',true,'v','h5_return_amounts','c66faf00333f30419147ce2a20d576ec',true,'plpgsql',0,'_return_id,_actor_id,return_id,status'),
    ('private.admin_decline_return(uuid,uuid,text,text)','record',true,'v','h5_return_amounts','4961acea012c275e698652b2d2526f5f',true,'plpgsql',0,'_return_id,_actor_id,_decline_reason,_decline_message,return_id,status'),
    ('private.admin_receive_return(uuid,uuid,boolean,uuid,jsonb,jsonb,text,integer,integer,text,boolean,text,text,text)','record',true,'v','h5_return_amounts','41a66c29fd1725b4c7398ddbad3e2233',true,'plpgsql',0,'_return_id,_actor_id,_actor_can_refund,_request_key,_units,_exchange_overrides,_refund_choice,_refund_amount,_refund_shipping_amount,_note,_notify_customer,_sent_back_message,_sent_back_carrier,_sent_back_tracking_number,receipt_id,return_status,refund_id,refund_amount,refund_status,exchange_order_item_ids,fee_due_amount,shop_notice_enqueued,replayed'),
    ('private.admin_refund_return(uuid,uuid,uuid,integer,integer,text,boolean)','record',true,'v','h5_return_amounts','58a3e20bbb4c45eaadf235c4baf0c565',true,'plpgsql',0,'_return_id,_actor_id,_request_key,_amount,_shipping_amount,_note,_notify_customer,refund_id,amount,status,replayed'),
    ('private.return_detail_json(uuid)','jsonb',false,'s','h5_return_amounts','f05255c8186b61334654964ba8e2bd60',false,'plpgsql',0,'_return_id'),
    ('private.group_g_order_item_rows(uuid[])','record',true,'s','h5_status_amounts','2eabe975eba3bc92ff0caee1882f11b7',true,'sql',0,'_order_ids,order_id,order_item_id,status,status_rank,quantity,blocked_reasons,is_exchange,unit_price,line_amount,refund_amount,first_unit')
  ) AS expected(signature,result_type,definer,volatility,detail,body_md5,returns_set,language,defaults,arg_names) LOOP
    v_detail:=e.detail;v_oid:=pg_catalog.to_regprocedure(e.signature);
    SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid=v_oid;
    IF v_oid IS NULL OR p.proowner<>'postgres'::regrole OR p.prosecdef IS DISTINCT FROM e.definer
      OR p.provolatile<>e.volatility::"char" OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR p.prorettype IS DISTINCT FROM pg_catalog.to_regtype(e.result_type)
      OR p.proretset IS DISTINCT FROM e.returns_set OR p.pronargdefaults<>e.defaults
      OR (SELECT l.lanname FROM pg_catalog.pg_language AS l WHERE l.oid=p.prolang)<>e.language
      OR COALESCE(pg_catalog.array_to_string(p.proargnames,','),'')<>e.arg_names
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5
      OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f WHERE f.pronamespace=p.pronamespace AND f.proname=p.proname)<>1 THEN
      RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL=v_detail;
    END IF;
  END LOOP;
  v_detail:='h5_legacy_fallback';
  IF EXISTS (SELECT 1 FROM pg_temp.h5_function_baseline AS b LEFT JOIN pg_catalog.pg_proc AS f ON f.oid=b.oid
    WHERE f.oid IS NULL OR (f.prorettype,f.proretset,f.proowner,f.prosecdef,f.provolatile,f.proconfig,f.proargnames,f.proargtypes,f.pronargdefaults)
      IS DISTINCT FROM (b.prorettype,b.proretset,b.proowner,b.prosecdef,b.provolatile,b.proconfig,b.proargnames,b.proargtypes,b.pronargdefaults)
    OR pg_catalog.has_function_privilege('service_role',f.oid,'EXECUTE') IS DISTINCT FROM b.service) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL='h5_legacy_fallback'; END IF;
  v_detail:='h5_unit_claims';
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS a WHERE a.attrelid='public.order_line_unit_amounts'::regclass
      AND NOT a.attisdropped AND a.attnotnull AND ((a.attname IN ('order_id','order_item_id') AND a.atttypid='uuid'::regtype)
        OR (a.attname IN ('unit_index','paid_amount') AND a.atttypid='integer'::regtype)
        OR (a.attname='created_at' AND a.atttypid='timestamptz'::regtype)))<>5
    OR EXISTS (SELECT 1 FROM (VALUES ('h1_units_relation','private.group_h_validate_relation()',7,false),
      ('h1_units_sum','private.group_h_validate_line()',5,true),('h1_units_truncate','private.group_h_immutable()',34,false)) AS x(name,signature,kind,deferred)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid='public.order_line_unit_amounts'::regclass
        AND t.tgname=x.name AND t.tgfoid=pg_catalog.to_regprocedure(x.signature) AND t.tgtype=x.kind
        AND t.tgenabled='O' AND t.tgdeferrable=x.deferred AND t.tginitdeferred=x.deferred AND NOT t.tgisinternal))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid='public.order_line_unit_amounts'::regclass
    AND t.tgname='h1_units_immutable' AND t.tgfoid='private.group_h_guard_unit_claim()'::regprocedure
    AND t.tgtype=27 AND t.tgenabled='O' AND NOT t.tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid='public.order_line_unit_amounts'::regclass
      AND t.tgname='h5_units_empty_claim' AND t.tgfoid='private.group_h_guard_unit_claim()'::regprocedure
      AND t.tgtype=7 AND t.tgenabled='O' AND NOT t.tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid='public.order_return_receipt_lines'::regclass
      AND t.tgname='h5_return_completed_claims' AND t.tgfoid='private.group_h_release_completed_return_claims()'::regprocedure
      AND t.tgtype=5 AND t.tgenabled='O' AND NOT t.tgisinternal)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS a WHERE a.attrelid='public.order_line_unit_amounts'::regclass
      AND NOT a.attisdropped AND NOT a.attnotnull AND ((a.attname IN ('refund_id','return_line_id') AND a.atttypid='uuid'::regtype)
        OR (a.attname='refund_before_shipment' AND a.atttypid='boolean'::regtype)))<>3
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_line_unit_amounts'::regclass
      AND c.conname='h5_refund_claim_pair' AND c.contype='c' AND c.convalidated
      AND pg_catalog.pg_get_constraintdef(c.oid)='CHECK (((refund_id IS NULL) = (refund_before_shipment IS NULL)))')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_line_unit_amounts'::regclass
      AND c.contype='f' AND c.convalidated AND NOT c.condeferrable AND c.confdeltype='r' AND c.confupdtype='a'
      AND (c.confrelid,c.conkey,c.confkey) IN (
        ('public.order_refunds'::regclass,ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname='refund_id')],ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.confrelid AND a.attname='id')]),
        ('public.order_return_lines'::regclass,ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.conrelid AND a.attname='return_line_id')],ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.confrelid AND a.attname='id')])
      ))<>2 THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL='h5_unit_claims'; END IF;
  v_detail:='h5_public_acl';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c WHERE c.oid='public.order_line_unit_amounts'::regclass
    AND (NOT c.relrowsecurity OR c.relowner<>'postgres'::regrole))
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) AS r(name)
      CROSS JOIN pg_catalog.unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','SELECT','REFERENCES','TRIGGER']) AS k(privilege)
      WHERE pg_catalog.has_table_privilege(r.name,'public.order_line_unit_amounts',k.privilege))
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) AS r(name)
      CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS k(privilege)
      WHERE pg_catalog.has_any_column_privilege(r.name,'public.order_line_unit_amounts',k.privilege))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS fp WHERE fp.pronamespace='private'::regnamespace
      AND fp.proname=ANY(ARRAY['group_h_assert_unit_lock','group_h_guard_unit_claim','group_h_return_unit_dispositions','group_h_release_completed_return_claims','group_h_return_unit_rows','group_h_available_unit_amounts','group_h_claim_return_units','group_h_claim_refund_units','group_h_release_refund_units','group_h_release_return_units','group_h_return_line_amount','group_h_return_refund_slices','group_h_receiving_amount','group_h_return_refund_amount','group_h_return_amounts','group_h_order_unit_status_amounts'])
      AND pg_catalog.has_function_privilege('service_role',fp.oid,'EXECUTE'))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS fp WHERE fp.oid='public.load_order_refund_materials(uuid)'::regprocedure
      AND fp.prosecdef AND fp.provolatile='s' AND pg_catalog.has_function_privilege('service_role',fp.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL='h5_public_acl'; END IF;
  -- Refuse pre-H5 H business rows that would need a backfill; never silently mark their units free.
  v_detail:='h5_unit_claims';
  IF EXISTS (SELECT 1 FROM public.order_refund_lines AS l JOIN public.order_refunds AS r ON r.id=l.refund_id
    WHERE r.status IN ('awaiting_response','pending','succeeded')
      AND EXISTS(SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=l.order_item_id)
      AND (l.quantity<>(SELECT pg_catalog.count(*) FROM public.order_line_unit_amounts AS u
        WHERE u.refund_id=r.id AND u.order_item_id=l.order_item_id AND u.refund_before_shipment=l.before_shipment)
        OR l.amount IS DISTINCT FROM (SELECT COALESCE(pg_catalog.sum(u.paid_amount),0)::integer FROM public.order_line_unit_amounts AS u
          WHERE u.refund_id=r.id AND u.order_item_id=l.order_item_id AND u.refund_before_shipment=l.before_shipment))
      AND NOT (r.errored_at IS NOT NULL AND
        (SELECT pg_catalog.count(*) FROM public.order_line_unit_amounts AS u WHERE u.refund_id=r.id
          AND u.order_item_id=l.order_item_id AND u.refund_before_shipment=l.before_shipment)<=l.quantity
        AND EXISTS (SELECT 1 FROM public.payment_exceptions AS x WHERE x.payment_ref=r.id::text AND x.reason='refund_failed'))) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL='h5_unit_claims'; END IF;
  v_detail:='h5_return_amounts';
  IF EXISTS (SELECT 1 FROM public.order_line_unit_amounts AS u JOIN public.order_refunds AS r ON r.id=u.refund_id
      WHERE r.status NOT IN ('awaiting_response','pending','succeeded') OR NOT EXISTS (
        SELECT 1 FROM public.order_refund_lines AS l WHERE l.refund_id=r.id AND l.order_item_id=u.order_item_id
          AND l.before_shipment=u.refund_before_shipment))
    OR EXISTS (SELECT 1 FROM public.order_return_lines AS l JOIN public.order_returns AS r ON r.id=l.return_id
      CROSS JOIN LATERAL private.order_return_line_progress(r.id) AS rp
      WHERE r.status IN ('open','closed') AND EXISTS(SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=l.order_item_id)
        AND rp.return_line_id=l.id
        AND LEAST(rp.unprocessed+rp.refund_waiting+rp.exchanged+(SELECT pg_catalog.count(*) FROM public.order_line_unit_amounts AS u
          WHERE u.return_line_id=l.id AND u.refund_id IS NOT NULL),
          (SELECT pg_catalog.count(*) FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=l.order_item_id
            AND (u.return_line_id=l.id OR (u.return_line_id IS NULL AND u.refund_id IS NULL))))
          <>(SELECT pg_catalog.count(*) FROM public.order_line_unit_amounts AS u WHERE u.return_line_id=l.id)) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL='h5_return_amounts'; END IF;
  v_detail:='h5_status_amounts';
  IF EXISTS (SELECT 1 FROM public.order_items AS oi
    JOIN public.orders AS o ON o.id=oi.order_id AND o.status NOT IN ('payment_in_progress','abandoned')
    CROSS JOIN LATERAL private.order_line_discounts(o.id) AS d
    WHERE d.order_item_id=oi.id AND EXISTS(SELECT 1 FROM public.order_line_unit_amounts AS u WHERE u.order_item_id=oi.id)
      AND oi.line_total::bigint-d.line_discount IS DISTINCT FROM
        (SELECT pg_catalog.sum(h.line_amount) FROM private.group_h_order_unit_status_amounts(o.id) AS h WHERE h.order_item_id=oi.id)) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL='h5_status_amounts'; END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='GROUP_H_MIGRATION_ASSERTION_FAILED' AND SQLSTATE='P0001' THEN RAISE; END IF;
  RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE = 'P0001', DETAIL=COALESCE(v_detail,'h5_unit_claims'),
    HINT='sqlstate='||SQLSTATE;
END;
$h5_final$;
-- H5_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
