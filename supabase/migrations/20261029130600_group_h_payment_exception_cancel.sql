BEGIN;

-- H7: unpaid cancellation through the human payment-exception resolver releases H reservations.
-- @impl FREQ-549-AC-03
-- @design docs/04_DetailDesign/states/discount-redemptions.md ST-REDEMPTION-05
-- G common -> H catalog -> buyer -> discount -> G inventory (the H4 helper takes the first four).
-- Existing business rows, the public delegate, and the G writer allowlist are not changed here.
-- H7_BASELINE_BEGIN
CREATE TEMP TABLE h7_function_baseline ON COMMIT DROP AS
SELECT p.oid,p.prorettype,p.proretset,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proargnames,p.proargtypes,
  p.proallargtypes,p.proargmodes,p.pronargdefaults,pg_catalog.pg_get_expr(p.proargdefaults,0) AS defaults,
  pg_catalog.obj_description(p.oid,'pg_proc') AS comment
FROM pg_catalog.pg_proc AS p WHERE p.oid=ANY(ARRAY[
  'private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)'::regprocedure,
  'public.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)'::regprocedure]::oid[]);
CREATE TEMP TABLE h7_writer_baseline ON COMMIT DROP AS
SELECT x::oid AS oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x);
-- H7_BASELINE_END

-- H7_BODY_BEGIN
CREATE OR REPLACE FUNCTION private.resolve_payment_exception(
  _exception_id uuid,
  _actor_id uuid,
  _note text DEFAULT NULL,
  _cancel_order boolean DEFAULT false,
  _cancel_reason text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (resolved boolean, order_id uuid, cancelled_from public.order_status)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.payment_exceptions%ROWTYPE;
  v_order_id uuid;
  v_orders uuid[];
  v_before jsonb;
  v_middle jsonb;
  v_cancel boolean := COALESCE(_cancel_order, false);
  current_status public.order_status;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_variants bigint[] := ARRAY[]::bigint[];
  v_released integer := 0;
  v_holds integer := 0;
  v_allocated integer := 0;
BEGIN
  IF _exception_id IS NULL OR _actor_id IS NULL THEN
    RAISE EXCEPTION 'RESOLVE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _note IS NOT NULL AND pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_TOO_LONG' USING ERRCODE = '22023';
  END IF;

  SELECT e.order_id INTO v_order_id FROM public.payment_exceptions AS e WHERE e.id = _exception_id;
  PERFORM private.group_h_lock_acceptance(NULL, v_order_id);
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[],
    CASE WHEN v_order_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_order_id] END, NULL);
  SELECT e.* INTO target FROM public.payment_exceptions AS e WHERE e.id = _exception_id FOR UPDATE;

  IF target.id IS NULL OR target.resolved_at IS NOT NULL THEN
    RETURN QUERY SELECT false, target.order_id, NULL::public.order_status;
    RETURN;
  END IF;

  -- The order was attached after the non-locking read; it cannot be locked late.
  IF target.order_id IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION 'GROUP_G_LOCK_SET_CHANGED' USING ERRCODE = '40001';
  END IF;

  IF target.reason = 'refund_failed' AND (_note IS NULL OR _note ~ '^[[:space:]]*$') THEN
    RAISE EXCEPTION 'RESOLUTION_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF v_cancel THEN
    IF NULLIF(pg_catalog.btrim(_note), '') IS NULL THEN
      RAISE EXCEPTION 'RESOLUTION_NOTE_REQUIRED' USING ERRCODE = '22023';
    END IF;

    SELECT o.status INTO current_status FROM public.orders AS o WHERE o.id = target.order_id;

    IF current_status IS NULL
       OR current_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
      RAISE EXCEPTION 'ORDER_NOT_CANCELLABLE' USING ERRCODE = '22023';
    END IF;

    -- The unpaid-release contract for a cancel (actor and one of the six reasons).
    IF _cancel_reason IS NULL
       OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other') THEN
      RAISE EXCEPTION 'CANCEL_REQUIRES_ACTOR_AND_REASON' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  IF v_cancel THEN
    PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
    PERFORM pg_catalog.set_config('app.order_change_reason', 'resolve_payment_exception', true);
    PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

    UPDATE public.orders AS o
    SET status = 'cancelled'::public.order_status,
        cancel_reason = _cancel_reason,
        cancel_note = NULLIF(pg_catalog.btrim(_note), ''),
        cancel_notify_customer = _notify_customer
    WHERE o.id = target.order_id
      AND o.status = current_status;
    PERFORM private.group_h_settle_redemptions(target.order_id, false);

    SELECT h.released_variant_ids, h.released_quantity INTO v_variants, v_released
    FROM private.release_group_g_payment_holds(target.order_id, v_operation, 'resolve_payment_exception', _actor_id) AS h;

    IF COALESCE(_notify_customer, false) THEN
      PERFORM private.enqueue_order_email(target.order_id, 'canceled', current_status::text);
    END IF;
  END IF;

  v_holds := private.release_group_g_payment_review_holds(_exception_id, _actor_id);

  UPDATE public.payment_exceptions AS e
  SET resolved_at = pg_catalog.now(),
      resolved_by = _actor_id,
      resolution_note = NULLIF(pg_catalog.btrim(_note), '')
  WHERE e.id = _exception_id;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'resolve_payment_exception', _actor_id);

  -- Released H goes to the oldest waiting orders; a released review hold lets the order rejoin FIFO
  -- (the projection still excludes it while any other block remains).
  IF v_holds > 0 AND target.order_id IS NOT NULL THEN
    v_variants := v_variants || ARRAY(
      SELECT oi.variant_id FROM public.order_items AS oi
      WHERE oi.order_id = target.order_id AND oi.variant_id IS NOT NULL);
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x.id ORDER BY x.id), ARRAY[]::bigint[]) INTO v_variants
  FROM pg_catalog.unnest(v_variants) AS x(id);
  IF pg_catalog.cardinality(v_variants) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  END IF;

  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'resolve_payment_exception',
    pg_catalog.md5('resolve_payment_exception:' || _exception_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'resolve_payment_exception', 'exception_id', _exception_id, 'actor_id', _actor_id,
      'note', _note, 'cancel_order', v_cancel, 'cancel_reason', _cancel_reason,
      'notify_customer', _notify_customer)::text, 'UTF8')), 'hex'),
    'payment_exception',
    _exception_id::text,
    _actor_id,
    pg_catalog.jsonb_build_object('exception_id', _exception_id, 'order_id', target.order_id,
      'cancelled_from', CASE WHEN v_cancel THEN current_status END, 'released_quantity', v_released,
      'released_holds', v_holds, 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT
    true,
    target.order_id,
    CASE WHEN v_cancel THEN current_status ELSE NULL::public.order_status END;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;
ALTER FUNCTION private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean) TO service_role;
-- H7_BODY_END

-- H7_FINAL_ASSERT_BEGIN
DO $h7_final$
DECLARE
  e record; p record; w record; v_oid oid; v_detail text;
BEGIN
  v_detail:='h7_payment_exception_cancel';
  FOR e IN SELECT * FROM (VALUES
    ('resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)','656d6fc09913ed4865fe2b26029b0fd0')
  ) AS expected(signature,body_md5) LOOP
    v_oid:=pg_catalog.to_regprocedure('private.'||e.signature);
    SELECT f.*,l.lanname INTO p FROM pg_catalog.pg_proc AS f
      JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
    IF v_oid IS NULL OR NOT FOUND OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR p.prorettype<>'record'::regtype OR NOT p.proretset OR p.prokind<>'f' OR p.provolatile<>'v'
      OR p.lanname<>'plpgsql' OR p.proisstrict OR p.proleakproof OR p.proparallel<>'u'
      OR p.pronargs<>6 OR p.pronargdefaults<>4
      OR COALESCE(pg_catalog.array_to_string(p.proargnames,','),'')<>'_exception_id,_actor_id,_note,_cancel_order,_cancel_reason,_notify_customer,resolved,order_id,cancelled_from'
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f
        WHERE f.pronamespace='private'::regnamespace AND f.proname='resolve_payment_exception')<>1 THEN
      RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
    END IF;
    -- Keep the same OID, defaults, argument/return modes and comment as G-1 (including a NULL comment).
    IF NOT EXISTS (SELECT 1 FROM pg_temp.h7_function_baseline AS b WHERE b.oid=p.oid
        AND (p.prorettype,p.proretset,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proargnames,p.proargtypes,
          p.proallargtypes,p.proargmodes,p.pronargdefaults,pg_catalog.pg_get_expr(p.proargdefaults,0),pg_catalog.obj_description(p.oid,'pg_proc'))
          IS NOT DISTINCT FROM (b.prorettype,b.proretset,b.proowner,b.prosecdef,b.provolatile,b.proconfig,b.proargnames,b.proargtypes,
            b.proallargtypes,b.proargmodes,b.pronargdefaults,b.defaults,b.comment)) THEN
      RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
    END IF;

    v_detail:='h7_public_acl';
    IF pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
      OR NOT pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
    END IF;
    v_oid:=pg_catalog.to_regprocedure('public.'||e.signature);
    SELECT f.*,l.lanname INTO w FROM pg_catalog.pg_proc AS f
      JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
    IF v_oid IS NULL OR NOT FOUND OR w.proowner<>'postgres'::regrole OR w.prosecdef OR w.lanname<>'sql'
      OR w.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR w.prorettype<>p.prorettype OR w.proretset<>p.proretset OR w.proallargtypes IS DISTINCT FROM p.proallargtypes
      OR w.proargmodes IS DISTINCT FROM p.proargmodes OR w.proargtypes IS DISTINCT FROM p.proargtypes
      OR w.proargnames IS DISTINCT FROM p.proargnames OR w.pronargs<>p.pronargs OR w.pronargdefaults<>p.pronargdefaults
      OR pg_catalog.pg_get_expr(w.proargdefaults,0) IS DISTINCT FROM pg_catalog.pg_get_expr(p.proargdefaults,0)
      OR w.prokind<>'f' OR w.provolatile<>p.provolatile OR w.proisstrict OR w.proleakproof OR w.proparallel<>'u'
      OR pg_catalog.regexp_replace(pg_catalog.lower(w.prosrc),'[[:space:];]','','g')<>
        'select*fromprivate.resolve_payment_exception(_exception_id,_actor_id,_note,_cancel_order,_cancel_reason,_notify_customer)'
      OR NOT pg_catalog.has_function_privilege('service_role',w.oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('anon',w.oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',w.oid,'EXECUTE')
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(w.proacl,pg_catalog.acldefault('f',w.proowner))) AS a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f
        WHERE f.pronamespace='public'::regnamespace AND f.proname='resolve_payment_exception')<>1
      OR NOT EXISTS (SELECT 1 FROM pg_temp.h7_function_baseline AS b WHERE b.oid=w.oid
        AND pg_catalog.obj_description(w.oid,'pg_proc') IS NOT DISTINCT FROM b.comment) THEN
      RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
    END IF;
  END LOOP;

  v_detail:='h7_writer_allowlist';
  IF (SELECT pg_catalog.count(*) FROM pg_temp.h7_function_baseline)<>2
    OR (SELECT pg_catalog.count(*) FROM pg_temp.h7_writer_baseline)<>77
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))<>77
    OR (SELECT pg_catalog.array_agg(x::oid ORDER BY x::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))
      IS DISTINCT FROM (SELECT pg_catalog.array_agg(b.oid ORDER BY b.oid) FROM pg_temp.h7_writer_baseline AS b)
    OR NOT ('private.resolve_payment_exception(uuid,uuid,text,boolean,text,boolean)'::regprocedure::oid=ANY(
      SELECT x::oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x)))
    OR (SELECT pg_catalog.md5(pg_catalog.replace(f.prosrc,E'\r','')) FROM pg_catalog.pg_proc AS f
      WHERE f.oid='private.group_g_writer_allowlist()'::regprocedure)<>'1a9bd697484b32bb5f44793ced4b70df' THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='GROUP_H_MIGRATION_ASSERTION_FAILED' AND SQLSTATE='P0001' THEN RAISE; END IF;
  RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=COALESCE(v_detail,'h7_payment_exception_cancel'),
    HINT='sqlstate='||SQLSTATE;
END;
$h7_final$;
-- H7_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
