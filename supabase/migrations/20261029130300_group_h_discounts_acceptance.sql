BEGIN;

-- H4_BODY_BEGIN
-- Pin the applied G OIDs before CREATE OR REPLACE; no existing business rows are changed.
CREATE TEMP TABLE group_h4_writer_baseline ON COMMIT DROP AS
  SELECT x::oid AS oid FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x);

CREATE FUNCTION private.group_h_lock_acceptance(_draft_id uuid,_order_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_draft public.checkout_drafts%ROWTYPE; v_ids uuid[]; v_keys text[]; v_discount_id uuid;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521,1);
  PERFORM pg_catalog.pg_advisory_xact_lock(190522,0);
  SELECT d.* INTO v_draft FROM public.checkout_drafts AS d
    WHERE (_draft_id IS NOT NULL AND d.id=_draft_id) OR (_draft_id IS NULL AND d.checkout_session_id=(
      SELECT o.checkout_session_id FROM public.orders AS o WHERE o.id=_order_id)) ORDER BY d.id LIMIT 1;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x ORDER BY x),ARRAY[]::uuid[]) INTO v_ids FROM (
    SELECT (u->>'discountId')::uuid AS x FROM pg_catalog.jsonb_array_elements(COALESCE(v_draft.discount_facts->'usage','[]')) AS t(u)
    UNION SELECT r.discount_id FROM public.discount_redemptions AS r WHERE r.order_id=_order_id
  ) AS ids;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT x ORDER BY x),ARRAY[]::text[]) INTO v_keys FROM (
    SELECT CASE WHEN v_draft.buyer_user_id IS NOT NULL THEN 'member:'||v_draft.buyer_user_id::text
      ELSE 'guest:'||pg_catalog.lower(pg_catalog.btrim(v_draft.shipping_snapshot->>'email')) END AS x WHERE v_draft.id IS NOT NULL
    UNION SELECT r.identity_key FROM public.discount_redemptions AS r WHERE r.order_id=_order_id
  ) AS identities;
  PERFORM private.group_h_lock(v_ids,v_keys);
  -- An observable transaction advisory accompanies each row lock, so helpers can reject a missing caller lock.
  FOREACH v_discount_id IN ARRAY v_ids LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(190524,pg_catalog.hashtext(v_discount_id::text));
  END LOOP;
END;
$$;

CREATE FUNCTION private.group_h_assert_acceptance_locks(_draft_id uuid,_order_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_draft public.checkout_drafts%ROWTYPE; v_key text; v_discount_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks AS l WHERE l.pid=pg_catalog.pg_backend_pid() AND l.locktype='advisory'
    AND l.classid=190521 AND l.objid=1 AND l.objsubid=2 AND l.granted AND l.mode='ExclusiveLock') THEN
    RAISE EXCEPTION 'GROUP_H_LOCK_REQUIRED' USING ERRCODE='55000'; END IF;
  SELECT d.* INTO v_draft FROM public.checkout_drafts AS d WHERE d.id=_draft_id;
  FOR v_key IN SELECT DISTINCT k FROM (
    SELECT CASE WHEN v_draft.buyer_user_id IS NOT NULL THEN 'member:'||v_draft.buyer_user_id::text
      ELSE 'guest:'||pg_catalog.lower(pg_catalog.btrim(v_draft.shipping_snapshot->>'email')) END AS k WHERE v_draft.id IS NOT NULL
    UNION SELECT r.identity_key FROM public.discount_redemptions AS r WHERE r.order_id=_order_id
  ) AS keys LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks AS l WHERE l.pid=pg_catalog.pg_backend_pid() AND l.locktype='advisory'
      AND l.classid=190523 AND l.objid=(pg_catalog.hashtext(v_key)::bigint & 4294967295)::oid AND l.objsubid=2 AND l.granted AND l.mode='ExclusiveLock') THEN
      RAISE EXCEPTION 'GROUP_H_LOCK_REQUIRED' USING ERRCODE='55000'; END IF;
  END LOOP;
  FOR v_discount_id IN SELECT DISTINCT x FROM (
    SELECT (u->>'discountId')::uuid AS x FROM pg_catalog.jsonb_array_elements(COALESCE(v_draft.discount_facts->'usage','[]')) AS t(u)
    UNION SELECT r.discount_id FROM public.discount_redemptions AS r WHERE r.order_id=_order_id
  ) AS ids LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks AS l WHERE l.pid=pg_catalog.pg_backend_pid() AND l.locktype='advisory'
      AND l.classid=190524 AND l.objid=(pg_catalog.hashtext(v_discount_id::text)::bigint & 4294967295)::oid AND l.objsubid=2 AND l.granted AND l.mode='ExclusiveLock') THEN
      RAISE EXCEPTION 'GROUP_H_LOCK_REQUIRED' USING ERRCODE='55000'; END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.group_h_recheck_discount_facts(_draft_id uuid,_order_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_draft public.checkout_drafts%ROWTYPE; v_definition public.discounts%ROWTYPE; v_code public.discount_codes%ROWTYPE;
  v_usage jsonb; v_context jsonb; v_reason text; v_rejection text; v_invalid jsonb := '[]'; v_auto boolean := false;
  v_email text; v_identity text; v_codes text[]; v_items bigint[]; v_previous boolean; v_reserved boolean;
  v_count bigint; v_buyer_count bigint; v_code_count bigint;
BEGIN
  PERFORM private.group_h_assert_acceptance_locks(_draft_id,_order_id);
  SELECT d.* INTO v_draft FROM public.checkout_drafts AS d WHERE d.id=_draft_id;
  IF v_draft.discount_engine_version IS NULL THEN RETURN '{"kind":"valid","rejection":null,"invalidCodes":[]}'::jsonb; END IF;
  v_email := pg_catalog.lower(pg_catalog.btrim(v_draft.shipping_snapshot->>'email'));
  v_identity := CASE WHEN v_draft.buyer_user_id IS NOT NULL THEN 'member:'||v_draft.buyer_user_id::text ELSE 'guest:'||v_email END;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT u->>'code') FILTER(WHERE u->>'code' IS NOT NULL),ARRAY[]::text[])
    INTO v_codes FROM pg_catalog.jsonb_array_elements(v_draft.discount_facts->'usage') AS t(u);
  SELECT pg_catalog.array_agg(DISTINCT (i->>'item_id')::bigint) INTO v_items
    FROM pg_catalog.jsonb_array_elements(v_draft.items_snapshot) AS t(i);
  v_context := private.get_checkout_discount_context(v_draft.buyer_user_id,v_email,v_codes,v_items,pg_catalog.now(),'acceptance');
  SELECT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id IS DISTINCT FROM _order_id
    AND (o.status IN ('paid','shipped') OR o.paid_amount>0)
    AND CASE WHEN v_draft.buyer_user_id IS NOT NULL THEN o.user_id=v_draft.buyer_user_id
      ELSE pg_catalog.lower(pg_catalog.btrim(o.shipping_email))=v_email END) INTO v_previous;
  SELECT EXISTS(SELECT 1 FROM public.discount_redemptions AS r WHERE r.order_id IS DISTINCT FROM _order_id AND r.state='reserved'
    AND r.first_order_only_snapshot AND CASE WHEN v_draft.buyer_user_id IS NOT NULL THEN r.user_id=v_draft.buyer_user_id OR r.identity_key=v_identity
      ELSE pg_catalog.lower(pg_catalog.btrim(r.normalized_email))=v_email END) INTO v_reserved;
  FOR v_usage IN SELECT u FROM pg_catalog.jsonb_array_elements(v_draft.discount_facts->'usage') AS t(u)
    WHERE EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(v_draft.discount_result->'applied') AS a(e) WHERE e->>'discountId'=u->>'discountId')
    ORDER BY u->>'code' NULLS LAST,u->>'discountId' LOOP
    v_reason := NULL;
    SELECT d.* INTO v_definition FROM public.discounts AS d WHERE d.id=(v_usage->>'discountId')::uuid;
    SELECT c.* INTO v_code FROM public.discount_codes AS c WHERE c.id=(v_usage->>'codeId')::uuid AND c.discount_id=v_definition.id;
    SELECT pg_catalog.count(*),pg_catalog.count(*) FILTER(WHERE CASE WHEN v_draft.buyer_user_id IS NOT NULL
      THEN r.user_id=v_draft.buyer_user_id OR r.identity_key=v_identity ELSE pg_catalog.lower(pg_catalog.btrim(r.normalized_email))=v_email END),
      pg_catalog.count(*) FILTER(WHERE r.code_id=v_code.id) INTO v_count,v_buyer_count,v_code_count
      FROM public.discount_redemptions AS r WHERE r.discount_id=v_definition.id AND r.state IN ('reserved','confirmed') AND r.order_id IS DISTINCT FROM _order_id;
    IF v_definition.id IS NULL OR (v_usage->>'codeId' IS NOT NULL AND (v_code.id IS NULL OR v_code.unassigned_at IS NOT NULL)) THEN v_reason := 'discount_not_eligible';
    ELSIF v_definition.stopped THEN v_reason := 'discount_stopped';
    ELSIF v_definition.starts_at>pg_catalog.now() OR (v_definition.ends_at IS NOT NULL AND pg_catalog.now()>=v_definition.ends_at) THEN v_reason := 'discount_expired';
    ELSIF v_definition.usage_limit IS NOT NULL AND v_count>=v_definition.usage_limit THEN v_reason := 'discount_usage_limit';
    ELSIF v_definition.once_per_customer AND v_buyer_count>0 THEN v_reason := 'discount_once_per_customer';
    ELSIF v_code.single_use AND v_code_count>0 THEN v_reason := 'discount_usage_limit';
    ELSIF v_definition.first_order_only AND (v_previous OR v_reserved
      OR (v_draft.discount_facts->>'hasPreviousOrder')::boolean IS DISTINCT FROM v_previous
      OR (v_draft.discount_facts->>'hasFirstOrderReservation')::boolean IS DISTINCT FROM v_reserved) THEN v_reason := 'discount_first_order_changed';
    ELSIF v_definition.kind='repeat' AND v_definition.repeat_previous AND EXISTS(SELECT 1 FROM public.discount_items AS di WHERE di.discount_id=v_definition.id
      AND COALESCE(v_draft.discount_facts->'priorUnitsByItem'->>di.item_id::text,'0')::bigint IS DISTINCT FROM
        COALESCE(v_context->'facts'->'priorUnitsByItem'->>di.item_id::text,'0')::bigint) THEN v_reason := 'discount_prior_units_changed';
    ELSIF v_usage->>'codeId' IS NOT NULL AND ((v_draft.buyer_user_id IS NULL AND (NOT v_definition.allow_guests OR NOT v_code.allow_guests OR v_code.audience<>'anyone'))
      OR (v_code.audience='assigned' AND (v_draft.buyer_user_id IS NULL OR CASE WHEN v_code.single_use THEN v_code.assigned_user_id IS DISTINCT FROM v_draft.buyer_user_id
        ELSE NOT EXISTS(SELECT 1 FROM public.discount_assignments AS a WHERE a.code_id=v_code.id AND a.user_id=v_draft.buyer_user_id) END))) THEN v_reason := 'discount_not_eligible';
    END IF;
    IF v_reason IS NOT NULL THEN
      IF v_usage->>'code' IS NOT NULL THEN
        v_invalid := v_invalid || pg_catalog.jsonb_build_array(v_usage->>'code'); v_rejection := COALESCE(v_rejection,v_reason);
      ELSE v_auto := true; END IF;
    END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('kind',CASE WHEN v_rejection IS NOT NULL THEN 'codes_invalid' WHEN v_auto THEN 'automatic_changed' ELSE 'valid' END,
    'rejection',CASE WHEN v_rejection IS NOT NULL THEN v_rejection WHEN v_auto THEN 'discount_automatic_changed' END,'invalidCodes',v_invalid);
END;
$$;

CREATE FUNCTION private.group_h_copy_order_discounts(_draft_id uuid,_order_id uuid,_line_map jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_draft public.checkout_drafts%ROWTYPE; v_map jsonb;
BEGIN
  PERFORM private.group_h_assert_acceptance_locks(_draft_id,_order_id);
  SELECT d.* INTO v_draft FROM public.checkout_drafts AS d WHERE d.id=_draft_id;
  IF v_draft.discount_engine_version IS NULL THEN RETURN; END IF;
  IF pg_catalog.jsonb_typeof(_line_map) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(_line_map)<>pg_catalog.jsonb_array_length(v_draft.items_snapshot)
    OR NOT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id=_order_id AND o.checkout_session_id=v_draft.checkout_session_id
      AND o.total_amount=(v_draft.discount_result->>'totalAmount')::integer AND o.discount_amount=(v_draft.discount_result->>'discountAmount')::integer)
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(_line_map) AS t(m) GROUP BY m->>'lineKey' HAVING pg_catalog.count(*)<>1)
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(_line_map) AS t(m) GROUP BY m->>'orderItemId' HAVING pg_catalog.count(*)<>1) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  FOR v_map IN SELECT m FROM pg_catalog.jsonb_array_elements(_line_map) AS t(m) LOOP
    IF pg_catalog.jsonb_typeof(v_map)<>'object' OR v_map-ARRAY['lineKey','orderItemId']::text[]<>'{}'::jsonb
      OR NOT (v_map ?& ARRAY['lineKey','orderItemId']) OR NOT EXISTS(
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_draft.items_snapshot) AS t(i)
        JOIN public.order_items AS oi ON oi.id=(v_map->>'orderItemId')::uuid AND oi.order_id=_order_id AND oi.line_kind='order'
          AND oi.item_id=(i->>'item_id')::bigint AND oi.quantity=(i->>'quantity')::integer AND oi.line_total=(i->>'line_total')::integer
        WHERE i->>'source_cart_line_id'=v_map->>'lineKey') THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  INSERT INTO public.order_line_discount_allocations(order_id,order_item_id,discount_id,amount)
    SELECT _order_id,(m->>'orderItemId')::uuid,(a->>'discountId')::uuid,(a->>'amount')::integer
    FROM pg_catalog.jsonb_array_elements(v_draft.discount_result->'allocations') AS t(a)
    JOIN pg_catalog.jsonb_array_elements(_line_map) AS maps(m) ON m->>'lineKey'=a->>'lineKey';
  INSERT INTO public.order_line_unit_amounts(order_id,order_item_id,unit_index,paid_amount)
    SELECT _order_id,(m->>'orderItemId')::uuid,(u->>'unitIndex')::integer,(u->>'paidAmount')::integer
    FROM pg_catalog.jsonb_array_elements(v_draft.discount_result->'unitAmounts') AS t(u)
    JOIN pg_catalog.jsonb_array_elements(_line_map) AS maps(m) ON m->>'lineKey'=u->>'lineKey';
END;
$$;

CREATE FUNCTION private.group_h_reserve_redemptions(_draft_id uuid,_order_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_draft public.checkout_drafts%ROWTYPE; v_buyer uuid; v_user_id uuid;
BEGIN
  PERFORM private.group_h_assert_acceptance_locks(_draft_id,_order_id);
  SELECT d.* INTO v_draft FROM public.checkout_drafts AS d WHERE d.id=_draft_id;
  IF v_draft.discount_engine_version IS NULL THEN RETURN; END IF;
  -- The reconciliation path leaves orders.user_id empty, so the buyer comes from the frozen draft.
  SELECT COALESCE(o.user_id,v_draft.buyer_user_id) INTO v_buyer FROM public.orders AS o
    WHERE o.id=_order_id AND o.checkout_session_id=v_draft.checkout_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  -- A member deleted after confirmation keeps the identity key but not the foreign key (the paid order must still be created).
  v_user_id := CASE WHEN v_buyer IS NOT NULL AND EXISTS(SELECT 1 FROM auth.users AS u WHERE u.id=v_buyer) THEN v_buyer END;
  INSERT INTO public.discount_redemptions(discount_id,code_id,order_id,user_id,identity_key,normalized_email,state,
    name_snapshot,code_snapshot,class_snapshot,amount,first_order_only_snapshot)
    SELECT d.id,(e->>'codeId')::uuid,_order_id,v_user_id,
      CASE WHEN v_buyer IS NOT NULL THEN 'member:'||v_buyer::text
        ELSE 'guest:'||pg_catalog.lower(pg_catalog.btrim(v_draft.shipping_snapshot->>'email')) END,
      pg_catalog.lower(pg_catalog.btrim(v_draft.shipping_snapshot->>'email')),'reserved',e->>'name',e->>'code',e->>'class',(e->>'amount')::integer,d.first_order_only
    FROM pg_catalog.jsonb_array_elements(v_draft.discount_result->'applied') AS t(e)
    JOIN public.discounts AS d ON d.id=(e->>'discountId')::uuid WHERE (e->>'amount')::integer>0
    ON CONFLICT(order_id,discount_id) DO NOTHING;
END;
$$;

CREATE FUNCTION private.group_h_settle_redemptions(_order_id uuid,_paid boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_row public.discount_redemptions%ROWTYPE; v_limit integer; v_once boolean; v_single boolean;
  v_count bigint; v_buyer bigint; v_code bigint; v_kind text; v_changed integer := 0; v_recovered boolean := false; v_exceeded boolean := false;
  v_draft_id uuid; v_existing uuid[];
BEGIN
  IF _order_id IS NULL OR _paid IS NULL THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT d.id INTO v_draft_id FROM public.checkout_drafts AS d JOIN public.orders AS o ON o.checkout_session_id=d.checkout_session_id
    WHERE o.id=_order_id ORDER BY d.id LIMIT 1;
  PERFORM private.group_h_assert_acceptance_locks(v_draft_id,_order_id);
  IF _paid AND NOT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id=_order_id AND (o.status IN ('paid','shipped') OR o.paid_amount>0)) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF NOT _paid AND EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id=_order_id AND (o.status IN ('paid','shipped') OR o.paid_amount>0)) THEN
    RETURN '{"changed":0}'::jsonb; END IF;
  IF _paid AND v_draft_id IS NOT NULL THEN
    SELECT COALESCE(pg_catalog.array_agg(r.id),ARRAY[]::uuid[]) INTO v_existing FROM public.discount_redemptions AS r WHERE r.order_id=_order_id;
    PERFORM private.group_h_reserve_redemptions(v_draft_id,_order_id);
    UPDATE public.discount_redemptions AS r SET reconciliation_fallback=true WHERE r.order_id=_order_id AND NOT r.id=ANY(v_existing);
  END IF;
  FOR v_row IN SELECT r.* FROM public.discount_redemptions AS r WHERE r.order_id=_order_id ORDER BY r.discount_id FOR UPDATE LOOP
    IF NOT _paid THEN
      UPDATE public.discount_redemptions AS r SET state='cancelled',cancelled_at=pg_catalog.now() WHERE r.id=v_row.id AND r.state='reserved';
      IF FOUND THEN v_changed := v_changed+1; END IF;
      CONTINUE;
    END IF;
    IF v_row.state='confirmed' THEN CONTINUE; END IF;
    SELECT d.usage_limit,d.once_per_customer,COALESCE(c.single_use,false) INTO v_limit,v_once,v_single
      FROM public.discounts AS d LEFT JOIN public.discount_codes AS c ON c.id=v_row.code_id WHERE d.id=v_row.discount_id;
    SELECT pg_catalog.count(*),pg_catalog.count(*) FILTER(WHERE r.identity_key=v_row.identity_key OR (v_row.user_id IS NOT NULL AND r.user_id=v_row.user_id)
      OR (v_row.user_id IS NULL AND pg_catalog.lower(pg_catalog.btrim(r.normalized_email))=v_row.normalized_email)),
      pg_catalog.count(*) FILTER(WHERE r.code_id=v_row.code_id) INTO v_count,v_buyer,v_code
      FROM public.discount_redemptions AS r WHERE r.discount_id=v_row.discount_id AND r.state IN ('reserved','confirmed') AND r.order_id<>_order_id;
    v_kind := CASE WHEN (v_limit IS NOT NULL AND v_count+1>v_limit) OR (v_once AND v_buyer>0) OR (v_single AND v_code>0)
      THEN 'discount_limit_exceeded' WHEN v_row.reconciliation_fallback OR v_row.state='cancelled' THEN 'discount_reconciliation_recovered' END;
    v_recovered := v_recovered OR v_kind IS NOT NULL; v_exceeded := v_exceeded OR v_kind='discount_limit_exceeded';
    UPDATE public.discount_redemptions AS r SET state='confirmed',confirmed_at=COALESCE(r.confirmed_at,pg_catalog.now()),
      attention_kind=COALESCE(r.attention_kind,v_kind) WHERE r.id=v_row.id;
    v_changed := v_changed+1;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('changed',v_changed,'recovered',v_recovered,'limitExceeded',v_exceeded);
END;
$$;

CREATE FUNCTION private.group_h_discount_attention_rows(_order_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('orderId',s.order_id,'kind',s.kind,'openedAt',s.opened_at)
    ORDER BY s.opened_at DESC,s.order_id),'[]'::jsonb) FROM (
    SELECT r.order_id,CASE WHEN pg_catalog.bool_or(r.attention_kind='discount_limit_exceeded') THEN 'discount_limit_exceeded'
      ELSE 'discount_reconciliation_recovered' END AS kind,pg_catalog.max(r.confirmed_at) AS opened_at
    FROM public.discount_redemptions AS r WHERE (_order_id IS NULL OR r.order_id=_order_id)
      AND r.state='confirmed' AND r.attention_kind IS NOT NULL AND r.attention_resolved_at IS NULL GROUP BY r.order_id
  ) AS s
$$;

CREATE FUNCTION private.list_admin_discount_attention(_limit integer,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_rows jsonb;
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.orders.read');
  IF _limit IS NULL OR _limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  v_rows := private.group_h_discount_attention_rows(NULL);
  RETURN pg_catalog.jsonb_build_object('rows',COALESCE((SELECT pg_catalog.jsonb_agg(t.x ORDER BY t.n)
    FROM pg_catalog.jsonb_array_elements(v_rows) WITH ORDINALITY AS t(x,n) WHERE t.n<=_limit),'[]'::jsonb),
    'truncated',pg_catalog.jsonb_array_length(v_rows)>_limit);
END;
$$;

CREATE FUNCTION private.admin_resolve_discount_attention(_order_id uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_changed integer;
BEGIN
  PERFORM private.group_h_require_permission(_actor_id,'admin.orders.manage');
  IF _order_id IS NULL THEN RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM private.group_h_lock_acceptance(NULL,_order_id);
  UPDATE public.discount_redemptions AS r SET attention_resolved_at=pg_catalog.now(),attention_resolved_by=_actor_id
    WHERE r.order_id=_order_id AND r.state='confirmed' AND r.attention_kind IS NOT NULL AND r.attention_resolved_at IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object('resolved',v_changed>0);
END;
$$;

CREATE OR REPLACE FUNCTION private.place_order_from_checkout_draft(
  _draft_id uuid,
  _checkout_session_id text,
  _cart_session_id text,
  _stripe_amount_total integer,
  _stripe_amount_discount integer,
  _stripe_currency text,
  _checkout_session_created_at timestamptz,
  _payment_intent_id text DEFAULT NULL,
  _shown_in_stock_variant_ids bigint[] DEFAULT NULL,
  _buyer_user_id uuid DEFAULT NULL
)
RETURNS TABLE (order_id uuid, order_status public.order_status, created boolean, rejection text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  draft_row public.checkout_drafts%ROWTYPE;
  existing_id uuid;
  existing_status public.order_status;
  existing_owner uuid;
  inserted_id uuid;
  v_snapshot jsonb;
  v_variants bigint[];
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_line record;
  v_movement bigint;
  v_allocation uuid;
  v_held integer := 0;
  v_h_line_map jsonb;
  v_h_recheck jsonb;
BEGIN
  IF _draft_id IS NULL
     OR NULLIF(pg_catalog.btrim(_checkout_session_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(_cart_session_id), '') IS NULL
     OR _stripe_amount_total IS NULL
     OR _stripe_amount_discount IS NULL
     OR _stripe_amount_discount < 0
     OR NULLIF(pg_catalog.btrim(_stripe_currency), '') IS NULL
     OR _checkout_session_created_at IS NULL
     OR (_buyer_user_id IS NOT NULL AND _shown_in_stock_variant_ids IS NULL) THEN
    RAISE EXCEPTION 'PLACE_ORDER_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The reconciler gets the existing order of the same Session back without any lock (read only).
  SELECT o.id, o.status INTO existing_id, existing_status
  FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;
  IF existing_id IS NOT NULL AND _shown_in_stock_variant_ids IS NULL THEN
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  -- Close the variant set by an unlocked read of the draft, then take the common advisory first,
  -- the draft next, then items/variants/waiting orders in the global order (Task 4 helper).
  SELECT d.items_snapshot INTO v_snapshot FROM public.checkout_drafts AS d WHERE d.id = _draft_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT r.variant_id ORDER BY r.variant_id), ARRAY[]::bigint[]) INTO v_variants
  FROM public.resolve_checkout_item_variants(COALESCE(v_snapshot, '[]'::jsonb)) AS r
  WHERE r.variant_id IS NOT NULL;
  -- H4: common -> H catalog -> sorted identities -> sorted discounts -> existing G inventory locks.
  PERFORM private.group_h_lock_acceptance(_draft_id,NULL);
  PERFORM private.lock_group_g_inventory(v_variants, ARRAY[]::uuid[], _draft_id);

  SELECT d.* INTO draft_row FROM public.checkout_drafts AS d WHERE d.id = _draft_id;
  -- A variant resolved only after the lock was taken cannot be locked any more in the global order.
  IF EXISTS (
    SELECT 1 FROM public.resolve_checkout_item_variants(COALESCE(draft_row.items_snapshot, '[]'::jsonb)) AS r
    WHERE r.variant_id IS NOT NULL AND NOT (r.variant_id = ANY (v_variants))
  ) THEN
    RAISE EXCEPTION 'GROUP_G_LOCK_SET_CHANGED' USING ERRCODE = '40001';
  END IF;

  -- Order path: proceed only when the buyer at 'proceed to confirmation' equals the buyer now (Group C design 5-3).
  IF _shown_in_stock_variant_ids IS NOT NULL
     AND draft_row.id IS NOT NULL
     AND draft_row.checkout_session_id IS NOT DISTINCT FROM _checkout_session_id
     AND draft_row.session_id IS NOT DISTINCT FROM _cart_session_id
     AND draft_row.buyer_user_id IS DISTINCT FROM _buyer_user_id THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
    RETURN;
  END IF;

  -- If a concurrent acceptance created the order of the same Session while waiting for the locks, return it.
  SELECT o.id, o.status, o.user_id INTO existing_id, existing_status, existing_owner
  FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;

  IF existing_id IS NOT NULL THEN
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND (draft_row.id IS NULL
            OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
            OR draft_row.session_id IS DISTINCT FROM _cart_session_id)
       AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
      RETURN;
    END IF;
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND existing_status = 'payment_in_progress'::public.order_status
       AND private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'cart_changed'::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  IF draft_row.id IS NULL
     OR draft_row.session_id IS DISTINCT FROM _cart_session_id
     OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
     OR draft_row.status IS DISTINCT FROM 'created' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'draft_not_found'::text;
    RETURN;
  END IF;

  IF _stripe_amount_total <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'zero_amount'::text;
    RETURN;
  END IF;

  IF pg_catalog.lower(draft_row.currency) <> pg_catalog.lower(_stripe_currency) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'currency_mismatch'::text;
    RETURN;
  END IF;

  IF draft_row.total_amount + COALESCE(draft_row.discount_amount, 0)
     <> _stripe_amount_total + _stripe_amount_discount THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'amount_mismatch'::text;
    RETURN;
  END IF;

  -- H4: immutable H3 result and buyer, independent of current eligibility or definition versions.
  IF draft_row.discount_engine_version IS NOT NULL THEN
    IF draft_row.discount_engine_version<>1 OR draft_row.discount_snapshot_hash !~ '^[0-9a-f]{64}$'
      OR (draft_row.discount_result->>'subtotalAmount')::bigint<>draft_row.subtotal_amount
      OR (draft_row.discount_result->>'shippingAmount')::bigint<>draft_row.shipping_amount
      OR (draft_row.discount_result->>'totalAmount')::bigint<>_stripe_amount_total
      OR (draft_row.discount_result->>'discountAmount')::bigint<>_stripe_amount_discount
      OR _stripe_amount_total<50
      OR (CASE WHEN draft_row.buyer_user_id IS NOT NULL THEN draft_row.discount_facts->'buyer' IS DISTINCT FROM
          pg_catalog.jsonb_build_object('kind','member','userId',draft_row.buyer_user_id)
        ELSE draft_row.discount_facts->'buyer' IS DISTINCT FROM pg_catalog.jsonb_build_object('kind','guest',
          'normalizedEmail',pg_catalog.lower(pg_catalog.btrim(draft_row.shipping_snapshot->>'email'))) END) THEN
      RETURN QUERY SELECT NULL::uuid,NULL::public.order_status,false,'amount_mismatch'::text;
      RETURN;
    END IF;
  END IF;

  -- Items of resolved variants are already FOR KEY SHARE (R-42) and variants FOR UPDATE by the helper.
  -- A line whose variant does not resolve is only read here; its order_items FK takes KEY SHARE on insert.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
    LEFT JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
    WHERE i.id IS NULL OR i.status IS DISTINCT FROM 'published'
  ) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
    RETURN;
  END IF;

  IF _shown_in_stock_variant_ids IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.resolve_checkout_item_variants(draft_row.items_snapshot) AS r
      LEFT JOIN public.item_variants AS v ON v.id = r.variant_id
      WHERE v.id IS NULL OR NOT v.is_active
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
      RETURN;
    END IF;

    IF private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'cart_changed'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
      JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
      WHERE i.price IS DISTINCT FROM (e.value->>'item_price')::integer
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'price_changed'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.preview_checkout_fulfillment(draft_row.items_snapshot) AS p
      WHERE p.variant_id = ANY (_shown_in_stock_variant_ids)
        AND p.fulfillment = 'backorder'
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'stock_changed'::text;
      RETURN;
    END IF;
  END IF;

  -- H4: no order, hold, usage or copy has been written when this business rejection returns.
  IF draft_row.discount_engine_version IS NOT NULL THEN
    v_h_recheck := private.group_h_recheck_discount_facts(_draft_id,NULL);
    IF v_h_recheck->>'kind'<>'valid' THEN
      RETURN QUERY SELECT NULL::uuid,NULL::public.order_status,false,v_h_recheck->>'rejection';
      RETURN;
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  BEGIN
    INSERT INTO public.orders (
      session_id, user_id, checkout_session_id, payment_intent_id, status,
      subtotal_amount, shipping_amount, discount_amount, total_amount, currency,
      shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city,
      shipping_address, shipping_building, shipping_phone, shipping_kana, checkout_session_created_at
    ) VALUES (
      draft_row.session_id,
      CASE WHEN _shown_in_stock_variant_ids IS NOT NULL THEN draft_row.buyer_user_id ELSE NULL END,
      _checkout_session_id,
      _payment_intent_id,
      'payment_in_progress'::public.order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      _stripe_amount_discount,
      _stripe_amount_total,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone',
      draft_row.shipping_snapshot->>'kanaName',
      _checkout_session_created_at
    )
    RETURNING id INTO inserted_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status, o.user_id INTO existing_id, existing_status, existing_owner
      FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;
      IF existing_id IS NOT NULL THEN
        PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
        IF _shown_in_stock_variant_ids IS NOT NULL AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
          RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
          RETURN;
        END IF;
        RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
        RETURN;
      END IF;
      RAISE;
  END;

  -- Build lines from the snapshot. A line is 'stock' only when its whole variant total is covered by available stock (existing rule).
  WITH resolved AS (
    SELECT * FROM public.resolve_checkout_item_variants(draft_row.items_snapshot)
  ),
  needed AS (
    SELECT r.variant_id, pg_catalog.sum(r.quantity)::integer AS quantity
    FROM resolved AS r WHERE r.variant_id IS NOT NULL GROUP BY r.variant_id
  ),
  covered AS (
    SELECT n.variant_id FROM needed AS n
    JOIN public.item_variants AS v ON v.id = n.variant_id
    WHERE v.is_active AND v.stock_quantity >= n.quantity
  )
  , mapped AS MATERIALIZED (
    SELECT r.*, pg_catalog.gen_random_uuid() AS h_order_item_id FROM resolved AS r
  ), inserted AS (
  INSERT INTO public.order_items (
    id, order_id, item_id, item_name, item_price, item_image_url, color, size,
    quantity, line_total, variant_id, fulfillment_type
  )
  SELECT r.h_order_item_id, inserted_id, r.item_id, r.item_name, r.item_price, r.item_image_url, r.color, r.size,
         r.quantity, r.line_total, r.variant_id,
         CASE WHEN r.variant_id IS NOT NULL AND EXISTS (SELECT 1 FROM covered AS c WHERE c.variant_id = r.variant_id)
           THEN 'stock' ELSE 'backorder' END
  FROM mapped AS r
  ORDER BY r.line_no
  RETURNING id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'lineKey',draft_row.items_snapshot->(m.line_no-1)->>'source_cart_line_id','orderItemId',m.h_order_item_id)
    ORDER BY m.line_no),'[]'::jsonb) INTO v_h_line_map
  FROM mapped AS m JOIN inserted AS i ON i.id=m.h_order_item_id;

  -- Each stock line takes its purchase/-n and exactly one payment hold (H) in this operation. No A before payment.
  FOR v_line IN
    SELECT oi.id AS order_item_id, oi.variant_id, oi.quantity
    FROM public.order_items AS oi
    WHERE oi.order_id = inserted_id AND oi.fulfillment_type = 'stock' AND oi.variant_id IS NOT NULL AND oi.quantity > 0
    ORDER BY oi.variant_id, oi.id
  LOOP
    INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, allocation_operation_id)
    VALUES (v_line.variant_id, -v_line.quantity, 'purchase', inserted_id, v_line.order_item_id, v_operation)
    RETURNING id INTO v_movement;
    INSERT INTO public.order_item_allocations (order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
    VALUES (v_line.order_item_id, v_line.variant_id, v_line.quantity, v_line.quantity, 'payment_hold', v_operation)
    RETURNING id INTO v_allocation;
    INSERT INTO public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason)
    VALUES (v_allocation, 'hold', v_line.quantity, v_operation, 1, v_movement, 'checkout');
    v_held := v_held + v_line.quantity;
  END LOOP;

  -- Complete the draft; write only the discount amount back and keep the total before discount (R-26). The cart is not deleted.
  -- H4: atomic copies and positive-effect reservations, including zero-discount units.
  PERFORM private.group_h_copy_order_discounts(_draft_id,inserted_id,v_h_line_map);
  PERFORM private.group_h_reserve_redemptions(_draft_id,inserted_id);

  UPDATE public.checkout_drafts AS d
  SET status = 'completed',
      discount_amount = _stripe_amount_discount,
      payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE d.id = _draft_id;

  -- payment_in_progress is not displayed (0 ranges); the before/after call keeps one recorder per operation.
  PERFORM private.record_group_g_item_state_changes('[]'::jsonb, ARRAY[inserted_id], v_operation, 1,
    'place_order_from_checkout_draft', NULL);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'place_order_from_checkout_draft',
    pg_catalog.md5('place_order_from_checkout_draft:' || inserted_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'place_order_from_checkout_draft', 'order_id', inserted_id, 'draft_id', _draft_id,
      'checkout_session_id', _checkout_session_id)::text, 'UTF8')), 'hex'),
    'order',
    inserted_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', inserted_id, 'held_quantity', v_held)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT inserted_id, 'payment_in_progress'::public.order_status, true, NULL::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE FUNCTION private.place_reconciled_order_from_checkout_draft(
  _draft_id uuid,
  _checkout_session_id text,
  _cart_session_id text,
  _stripe_amount_total integer,
  _stripe_amount_discount integer,
  _stripe_currency text,
  _checkout_session_created_at timestamptz,
  _payment_intent_id text,
  _stripe_payment_state text
)
RETURNS TABLE (order_id uuid, order_status public.order_status, created boolean, rejection text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  _shown_in_stock_variant_ids bigint[] := NULL;
  _buyer_user_id uuid := NULL;
  draft_row public.checkout_drafts%ROWTYPE;
  existing_id uuid;
  existing_status public.order_status;
  existing_owner uuid;
  inserted_id uuid;
  v_snapshot jsonb;
  v_variants bigint[];
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_line record;
  v_movement bigint;
  v_allocation uuid;
  v_held integer := 0;
  v_h_line_map jsonb;
  v_h_recheck jsonb;
BEGIN
  IF _stripe_payment_state IS NULL OR _stripe_payment_state NOT IN ('paid','awaiting_payment')
    OR NULLIF(pg_catalog.btrim(_payment_intent_id),'') IS NULL THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF _draft_id IS NULL
     OR NULLIF(pg_catalog.btrim(_checkout_session_id), '') IS NULL
     OR NULLIF(pg_catalog.btrim(_cart_session_id), '') IS NULL
     OR _stripe_amount_total IS NULL
     OR _stripe_amount_discount IS NULL
     OR _stripe_amount_discount < 0
     OR NULLIF(pg_catalog.btrim(_stripe_currency), '') IS NULL
     OR _checkout_session_created_at IS NULL
     OR (_buyer_user_id IS NOT NULL AND _shown_in_stock_variant_ids IS NULL) THEN
    RAISE EXCEPTION 'PLACE_ORDER_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The reconciler gets the existing order of the same Session back without any lock (read only).
  SELECT o.id, o.status INTO existing_id, existing_status
  FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;
  IF existing_id IS NOT NULL AND _shown_in_stock_variant_ids IS NULL THEN
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  -- Close the variant set by an unlocked read of the draft, then take the common advisory first,
  -- the draft next, then items/variants/waiting orders in the global order (Task 4 helper).
  SELECT d.items_snapshot INTO v_snapshot FROM public.checkout_drafts AS d WHERE d.id = _draft_id;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT r.variant_id ORDER BY r.variant_id), ARRAY[]::bigint[]) INTO v_variants
  FROM public.resolve_checkout_item_variants(COALESCE(v_snapshot, '[]'::jsonb)) AS r
  WHERE r.variant_id IS NOT NULL;
  -- H4: common -> H catalog -> sorted identities -> sorted discounts -> existing G inventory locks.
  PERFORM private.group_h_lock_acceptance(_draft_id,NULL);
  PERFORM private.lock_group_g_inventory(v_variants, ARRAY[]::uuid[], _draft_id);

  SELECT d.* INTO draft_row FROM public.checkout_drafts AS d WHERE d.id = _draft_id;
  -- A variant resolved only after the lock was taken cannot be locked any more in the global order.
  IF EXISTS (
    SELECT 1 FROM public.resolve_checkout_item_variants(COALESCE(draft_row.items_snapshot, '[]'::jsonb)) AS r
    WHERE r.variant_id IS NOT NULL AND NOT (r.variant_id = ANY (v_variants))
  ) THEN
    RAISE EXCEPTION 'GROUP_G_LOCK_SET_CHANGED' USING ERRCODE = '40001';
  END IF;

  -- Order path: proceed only when the buyer at 'proceed to confirmation' equals the buyer now (Group C design 5-3).
  IF _shown_in_stock_variant_ids IS NOT NULL
     AND draft_row.id IS NOT NULL
     AND draft_row.checkout_session_id IS NOT DISTINCT FROM _checkout_session_id
     AND draft_row.session_id IS NOT DISTINCT FROM _cart_session_id
     AND draft_row.buyer_user_id IS DISTINCT FROM _buyer_user_id THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
    RETURN;
  END IF;

  -- If a concurrent acceptance created the order of the same Session while waiting for the locks, return it.
  SELECT o.id, o.status, o.user_id INTO existing_id, existing_status, existing_owner
  FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;

  IF existing_id IS NOT NULL THEN
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND (draft_row.id IS NULL
            OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
            OR draft_row.session_id IS DISTINCT FROM _cart_session_id)
       AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
      RETURN;
    END IF;
    IF _shown_in_stock_variant_ids IS NOT NULL
       AND existing_status = 'payment_in_progress'::public.order_status
       AND private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'cart_changed'::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
    RETURN;
  END IF;

  IF draft_row.id IS NULL
     OR draft_row.session_id IS DISTINCT FROM _cart_session_id
     OR draft_row.checkout_session_id IS DISTINCT FROM _checkout_session_id
     OR draft_row.status IS DISTINCT FROM 'created' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'draft_not_found'::text;
    RETURN;
  END IF;

  IF _stripe_amount_total <= 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'zero_amount'::text;
    RETURN;
  END IF;

  IF pg_catalog.lower(draft_row.currency) <> pg_catalog.lower(_stripe_currency) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'currency_mismatch'::text;
    RETURN;
  END IF;

  IF draft_row.total_amount + COALESCE(draft_row.discount_amount, 0)
     <> _stripe_amount_total + _stripe_amount_discount THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'amount_mismatch'::text;
    RETURN;
  END IF;

  -- H4: immutable H3 result and buyer, independent of current eligibility or definition versions.
  IF draft_row.discount_engine_version IS NOT NULL THEN
    IF draft_row.discount_engine_version<>1 OR draft_row.discount_snapshot_hash !~ '^[0-9a-f]{64}$'
      OR (draft_row.discount_result->>'subtotalAmount')::bigint<>draft_row.subtotal_amount
      OR (draft_row.discount_result->>'shippingAmount')::bigint<>draft_row.shipping_amount
      OR (draft_row.discount_result->>'totalAmount')::bigint<>_stripe_amount_total
      OR (draft_row.discount_result->>'discountAmount')::bigint<>_stripe_amount_discount
      OR _stripe_amount_total<50
      OR (CASE WHEN draft_row.buyer_user_id IS NOT NULL THEN draft_row.discount_facts->'buyer' IS DISTINCT FROM
          pg_catalog.jsonb_build_object('kind','member','userId',draft_row.buyer_user_id)
        ELSE draft_row.discount_facts->'buyer' IS DISTINCT FROM pg_catalog.jsonb_build_object('kind','guest',
          'normalizedEmail',pg_catalog.lower(pg_catalog.btrim(draft_row.shipping_snapshot->>'email'))) END) THEN
      RETURN QUERY SELECT NULL::uuid,NULL::public.order_status,false,'amount_mismatch'::text;
      RETURN;
    END IF;
  END IF;

  -- Items of resolved variants are already FOR KEY SHARE (R-42) and variants FOR UPDATE by the helper.
  -- A line whose variant does not resolve is only read here; its order_items FK takes KEY SHARE on insert.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
    LEFT JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
    WHERE i.id IS NULL OR i.status IS DISTINCT FROM 'published'
  ) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
    RETURN;
  END IF;

  IF _shown_in_stock_variant_ids IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.resolve_checkout_item_variants(draft_row.items_snapshot) AS r
      LEFT JOIN public.item_variants AS v ON v.id = r.variant_id
      WHERE v.id IS NULL OR NOT v.is_active
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'item_unavailable'::text;
      RETURN;
    END IF;

    IF private.checkout_cart_lines_gone(draft_row.cart_id, draft_row.items_snapshot) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'cart_changed'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(draft_row.items_snapshot) AS e(value)
      JOIN public.items AS i ON i.id = (e.value->>'item_id')::bigint
      WHERE i.price IS DISTINCT FROM (e.value->>'item_price')::integer
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'price_changed'::text;
      RETURN;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.preview_checkout_fulfillment(draft_row.items_snapshot) AS p
      WHERE p.variant_id = ANY (_shown_in_stock_variant_ids)
        AND p.fulfillment = 'backorder'
    ) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'stock_changed'::text;
      RETURN;
    END IF;
  END IF;

  -- H4: verified paid/awaiting reconciliation accepts the frozen discount without current-eligibility rejection.
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);

  BEGIN
    INSERT INTO public.orders (
      session_id, user_id, checkout_session_id, payment_intent_id, status,
      subtotal_amount, shipping_amount, discount_amount, total_amount, currency,
      shipping_email, shipping_full_name, shipping_postal_code, shipping_prefecture, shipping_city,
      shipping_address, shipping_building, shipping_phone, shipping_kana, checkout_session_created_at
    ) VALUES (
      draft_row.session_id,
      CASE WHEN _shown_in_stock_variant_ids IS NOT NULL THEN draft_row.buyer_user_id ELSE NULL END,
      _checkout_session_id,
      _payment_intent_id,
      'payment_in_progress'::public.order_status,
      draft_row.subtotal_amount,
      draft_row.shipping_amount,
      _stripe_amount_discount,
      _stripe_amount_total,
      draft_row.currency,
      draft_row.shipping_snapshot->>'email',
      draft_row.shipping_snapshot->>'fullName',
      draft_row.shipping_snapshot->>'postalCode',
      draft_row.shipping_snapshot->>'prefecture',
      draft_row.shipping_snapshot->>'city',
      draft_row.shipping_snapshot->>'address',
      draft_row.shipping_snapshot->>'building',
      draft_row.shipping_snapshot->>'phone',
      draft_row.shipping_snapshot->>'kanaName',
      _checkout_session_created_at
    )
    RETURNING id INTO inserted_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT o.id, o.status, o.user_id INTO existing_id, existing_status, existing_owner
      FROM public.orders AS o WHERE o.checkout_session_id = _checkout_session_id;
      IF existing_id IS NOT NULL THEN
        PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
        IF _shown_in_stock_variant_ids IS NOT NULL AND existing_owner IS DISTINCT FROM _buyer_user_id THEN
          RETURN QUERY SELECT NULL::uuid, NULL::public.order_status, false, 'login_changed'::text;
          RETURN;
        END IF;
        RETURN QUERY SELECT existing_id, existing_status, false, NULL::text;
        RETURN;
      END IF;
      RAISE;
  END;

  -- Build lines from the snapshot. A line is 'stock' only when its whole variant total is covered by available stock (existing rule).
  WITH resolved AS (
    SELECT * FROM public.resolve_checkout_item_variants(draft_row.items_snapshot)
  ),
  needed AS (
    SELECT r.variant_id, pg_catalog.sum(r.quantity)::integer AS quantity
    FROM resolved AS r WHERE r.variant_id IS NOT NULL GROUP BY r.variant_id
  ),
  covered AS (
    SELECT n.variant_id FROM needed AS n
    JOIN public.item_variants AS v ON v.id = n.variant_id
    WHERE v.is_active AND v.stock_quantity >= n.quantity
  )
  , mapped AS MATERIALIZED (
    SELECT r.*, pg_catalog.gen_random_uuid() AS h_order_item_id FROM resolved AS r
  ), inserted AS (
  INSERT INTO public.order_items (
    id, order_id, item_id, item_name, item_price, item_image_url, color, size,
    quantity, line_total, variant_id, fulfillment_type
  )
  SELECT r.h_order_item_id, inserted_id, r.item_id, r.item_name, r.item_price, r.item_image_url, r.color, r.size,
         r.quantity, r.line_total, r.variant_id,
         CASE WHEN r.variant_id IS NOT NULL AND EXISTS (SELECT 1 FROM covered AS c WHERE c.variant_id = r.variant_id)
           THEN 'stock' ELSE 'backorder' END
  FROM mapped AS r
  ORDER BY r.line_no
  RETURNING id
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'lineKey',draft_row.items_snapshot->(m.line_no-1)->>'source_cart_line_id','orderItemId',m.h_order_item_id)
    ORDER BY m.line_no),'[]'::jsonb) INTO v_h_line_map
  FROM mapped AS m JOIN inserted AS i ON i.id=m.h_order_item_id;

  -- Each stock line takes its purchase/-n and exactly one payment hold (H) in this operation. No A before payment.
  FOR v_line IN
    SELECT oi.id AS order_item_id, oi.variant_id, oi.quantity
    FROM public.order_items AS oi
    WHERE oi.order_id = inserted_id AND oi.fulfillment_type = 'stock' AND oi.variant_id IS NOT NULL AND oi.quantity > 0
    ORDER BY oi.variant_id, oi.id
  LOOP
    INSERT INTO public.stock_movements (variant_id, delta, reason, order_id, order_item_id, allocation_operation_id)
    VALUES (v_line.variant_id, -v_line.quantity, 'purchase', inserted_id, v_line.order_item_id, v_operation)
    RETURNING id INTO v_movement;
    INSERT INTO public.order_item_allocations (order_item_id, variant_id, quantity, remaining_quantity, kind, operation_id)
    VALUES (v_line.order_item_id, v_line.variant_id, v_line.quantity, v_line.quantity, 'payment_hold', v_operation)
    RETURNING id INTO v_allocation;
    INSERT INTO public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason)
    VALUES (v_allocation, 'hold', v_line.quantity, v_operation, 1, v_movement, 'checkout');
    v_held := v_held + v_line.quantity;
  END LOOP;

  -- Complete the draft; write only the discount amount back and keep the total before discount (R-26). The cart is not deleted.
  -- H4: atomic copies and positive-effect reservations, including zero-discount units.
  PERFORM private.group_h_copy_order_discounts(_draft_id,inserted_id,v_h_line_map);
  PERFORM private.group_h_reserve_redemptions(_draft_id,inserted_id);
  UPDATE public.discount_redemptions AS r SET reconciliation_fallback=true WHERE r.order_id=inserted_id;

  UPDATE public.checkout_drafts AS d
  SET status = 'completed',
      discount_amount = _stripe_amount_discount,
      payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE d.id = _draft_id;

  -- payment_in_progress is not displayed (0 ranges); the before/after call keeps one recorder per operation.
  PERFORM private.record_group_g_item_state_changes('[]'::jsonb, ARRAY[inserted_id], v_operation, 1,
    'place_order_from_checkout_draft', NULL);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'place_order_from_checkout_draft',
    pg_catalog.md5('place_order_from_checkout_draft:' || inserted_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'place_order_from_checkout_draft', 'order_id', inserted_id, 'draft_id', _draft_id,
      'checkout_session_id', _checkout_session_id)::text, 'UTF8')), 'hex'),
    'order',
    inserted_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', inserted_id, 'held_quantity', v_held)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT inserted_id, 'payment_in_progress'::public.order_status, true, NULL::text;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION private.mark_order_paid(
  _order_id uuid,
  _expected_status public.order_status,
  _payment_intent_id text,
  _paid_amount integer,
  _paid_currency text,
  _notify_customer boolean,
  _paid_email_variant text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean, amount_matches boolean, needs_review boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
  v_orders uuid[];
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_matches boolean;
  v_missing_variant boolean;
  v_hold record;
  v_promoted integer := 0;
  v_variants bigint[];
  v_allocated integer := 0;
  v_draft_id uuid;
  v_exception_id uuid;
BEGIN
  IF _order_id IS NULL
     OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL
     OR _paid_amount IS NULL
     OR NULLIF(pg_catalog.btrim(_paid_currency), '') IS NULL
     OR _notify_customer IS NULL THEN
    RAISE EXCEPTION 'MARK_PAID_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _paid_email_variant IS NULL
     OR _paid_email_variant NOT IN ('order_confirmed', 'payment_received', 'payment_received_after_expiry') THEN
    RAISE EXCEPTION 'INVALID_PAID_EMAIL_VARIANT' USING ERRCODE = '22023';
  END IF;

  IF _expected_status IS NULL
     OR _expected_status NOT IN (
       'payment_in_progress'::public.order_status,
       'pending'::public.order_status,
       'failed'::public.order_status
     ) THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_STATUS:%', _expected_status USING ERRCODE = '22023';
  END IF;

  PERFORM private.group_h_lock_acceptance(NULL,_order_id);
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id;

  -- Replays and CAS mismatches change nothing (no paid_at, no operation).
  IF target.id IS NULL OR target.status IS DISTINCT FROM _expected_status THEN
    RETURN QUERY SELECT false, NULL::boolean, NULL::boolean;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  v_matches := target.total_amount = _paid_amount
    AND pg_catalog.lower(target.currency) = pg_catalog.lower(_paid_currency);
  -- Only a line without a variant needs the existing review; a normal backorder shortage waits for FIFO.
  SELECT EXISTS (
    SELECT 1 FROM public.order_items AS oi WHERE oi.order_id = _order_id AND oi.variant_id IS NULL
  ) INTO v_missing_variant;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_paid', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  -- The buyer's own H becomes A first (kept even when the amount differs).
  FOR v_hold IN
    SELECT a.id, a.remaining_quantity
    FROM public.order_item_allocations AS a
    JOIN public.order_items AS oi ON oi.id = a.order_item_id
    WHERE oi.order_id = _order_id AND a.kind = 'payment_hold' AND a.remaining_quantity > 0
    ORDER BY a.id
  LOOP
    UPDATE public.order_item_allocations AS a
    SET kind = 'paid', version = a.version + 1, updated_at = pg_catalog.now()
    WHERE a.id = v_hold.id;
    INSERT INTO public.order_item_allocation_events
      (allocation_id, event_type, quantity, operation_id, sequence, reason, actor_id)
    VALUES (v_hold.id, 'promote', v_hold.remaining_quantity, v_operation, 1, 'stripe_payment_paid', NULL);
    v_promoted := v_promoted + v_hold.remaining_quantity;
  END LOOP;

  UPDATE public.orders AS o
  SET status = 'paid'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id),
      paid_amount = _paid_amount,
      paid_at = COALESCE(o.paid_at, pg_catalog.clock_timestamp()),
      review_reason = CASE WHEN v_missing_variant THEN 'stock_not_reserved' ELSE o.review_reason END,
      review_marked_at = CASE WHEN v_missing_variant THEN pg_catalog.now() ELSE o.review_marked_at END
  WHERE o.id = _order_id;

  PERFORM private.group_h_settle_redemptions(_order_id,true);

  -- A different amount: the exception and its hold are created together, before any new FIFO.
  -- The payment reference is the one record_payment_exception resolves to (order Session, then PaymentIntent).
  IF NOT v_matches THEN
    SELECT d.id INTO v_draft_id
    FROM public.checkout_drafts AS d
    WHERE target.checkout_session_id IS NOT NULL AND d.checkout_session_id = target.checkout_session_id
    ORDER BY d.id
    LIMIT 1;
    v_exception_id := private.ensure_group_g_payment_review_hold(
      _order_id, _payment_intent_id, target.checkout_session_id, _payment_intent_id, v_draft_id);
  END IF;

  PERFORM private.clear_cart_for_order(_order_id);

  -- A different amount is reviewed by the shop before the customer hears anything.
  IF v_matches AND _notify_customer THEN
    PERFORM private.enqueue_order_email(_order_id, 'paid', _paid_email_variant);
  END IF;

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'stripe_payment_paid', NULL);

  SELECT pg_catalog.array_agg(DISTINCT oi.variant_id ORDER BY oi.variant_id) INTO v_variants
  FROM public.order_items AS oi
  WHERE oi.order_id = _order_id AND oi.variant_id IS NOT NULL;
  IF COALESCE(pg_catalog.cardinality(v_variants), 0) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, NULL);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', NULL);
  END IF;

  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'mark_order_paid',
    CASE WHEN NULLIF(pg_catalog.btrim(_source_event_id), '') IS NOT NULL
      THEN pg_catalog.md5('stripe:' || _source_event_id)::uuid
      ELSE pg_catalog.md5('mark_order_paid:' || _order_id::text || ':' || _payment_intent_id)::uuid END,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'mark_order_paid', 'order_id', _order_id, 'expected_status', _expected_status,
      'payment_intent_id', _payment_intent_id, 'paid_amount', _paid_amount, 'paid_currency', _paid_currency,
      'notify_customer', _notify_customer, 'paid_email_variant', _paid_email_variant,
      'source_event_id', _source_event_id)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'status', 'paid', 'amount_matches', v_matches,
      'needs_review', v_missing_variant, 'promoted_quantity', v_promoted, 'allocated_quantity', v_allocated,
      'exception_id', v_exception_id, 'source_event_id', _source_event_id)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT true, v_matches, v_missing_variant;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION private.mark_order_awaiting_payment(
  _order_id uuid,
  _payment_intent_id text,
  _source_event_id text DEFAULT NULL
)
RETURNS TABLE (updated boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  target public.orders%ROWTYPE;
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _order_id IS NULL OR NULLIF(pg_catalog.btrim(_payment_intent_id), '') IS NULL THEN
    RAISE EXCEPTION 'MARK_AWAITING_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  PERFORM private.group_h_lock_acceptance(NULL,_order_id);
  PERFORM private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.* INTO target FROM public.orders AS o WHERE o.id = _order_id;

  IF target.id IS NULL OR target.status IS DISTINCT FROM 'payment_in_progress'::public.order_status THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  IF target.payment_intent_id IS NOT NULL AND target.payment_intent_id <> _payment_intent_id THEN
    RAISE EXCEPTION 'PAYMENT_INTENT_MISMATCH' USING ERRCODE = '22023';
  END IF;

  v_before := private.capture_group_g_item_states(ARRAY[_order_id]);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'stripe_payment_awaiting', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  -- The order keeps its H (no A before payment); only the status and its item states change.
  UPDATE public.orders AS o
  SET status = 'pending'::public.order_status,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id)
  WHERE o.id = _order_id;

  UPDATE public.checkout_drafts AS d
  SET payment_intent_id = COALESCE(d.payment_intent_id, _payment_intent_id)
  WHERE target.checkout_session_id IS NOT NULL
    AND d.checkout_session_id = target.checkout_session_id;

  PERFORM private.clear_cart_for_order(_order_id);
  PERFORM private.enqueue_order_email(_order_id, 'awaiting_payment', NULL);

  PERFORM private.record_group_g_item_state_changes(v_before, ARRAY[_order_id], v_operation, 1,
    'stripe_payment_awaiting', NULL);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'mark_order_awaiting_payment',
    CASE WHEN NULLIF(pg_catalog.btrim(_source_event_id), '') IS NOT NULL
      THEN pg_catalog.md5('stripe:' || _source_event_id)::uuid
      ELSE pg_catalog.md5('mark_order_awaiting_payment:' || _order_id::text || ':' || _payment_intent_id)::uuid END,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'mark_order_awaiting_payment', 'order_id', _order_id, 'payment_intent_id', _payment_intent_id,
      'source_event_id', _source_event_id)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'status', 'pending', 'source_event_id', _source_event_id)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT true;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION private.release_stock_for_unpaid_order(
  _order_id uuid,
  _expected_status public.order_status,
  _next_status public.order_status,
  _change_reason text,
  _actor_id uuid DEFAULT NULL,
  _source_event_id text DEFAULT NULL,
  _cancel_reason text DEFAULT NULL,
  _cancel_note text DEFAULT NULL,
  _notify_customer boolean DEFAULT NULL
)
RETURNS TABLE (released boolean, order_id uuid, status public.order_status)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  updated_id uuid;
  v_orders uuid[];
  v_before jsonb;
  v_middle jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_variants bigint[] := ARRAY[]::bigint[];
  v_released integer := 0;
  v_allocated integer := 0;
BEGIN
  IF _order_id IS NULL OR _change_reason IS NULL OR pg_catalog.btrim(_change_reason) = '' THEN
    RAISE EXCEPTION 'RELEASE_ARGUMENT_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF _expected_status IS NULL
     OR _expected_status NOT IN ('payment_in_progress'::public.order_status, 'pending'::public.order_status) THEN
    RAISE EXCEPTION 'INVALID_EXPECTED_STATUS:%', _expected_status USING ERRCODE = '22023';
  END IF;

  IF _next_status IS NULL
     OR _next_status NOT IN (
       'failed'::public.order_status, 'abandoned'::public.order_status, 'cancelled'::public.order_status
     ) THEN
    RAISE EXCEPTION 'INVALID_NEXT_STATUS:%', _next_status USING ERRCODE = '22023';
  END IF;

  -- Abandonment is only for orders whose payment screen never completed. An issued voucher is not abandonment.
  IF _next_status = 'abandoned'::public.order_status
     AND _expected_status <> 'payment_in_progress'::public.order_status THEN
    RAISE EXCEPTION 'ABANDON_REQUIRES_PAYMENT_IN_PROGRESS' USING ERRCODE = '22023';
  END IF;

  -- Cancel is a human decision: actor and reason are required (R-18); 'other' also needs a note (design 5-2).
  IF _next_status = 'cancelled'::public.order_status
     AND (_actor_id IS NULL
          OR _cancel_reason IS NULL
          OR _cancel_reason NOT IN ('customer_request', 'payment_declined', 'suspected_fraud', 'stock_unavailable', 'shop_error', 'other')) THEN
    RAISE EXCEPTION 'CANCEL_REQUIRES_ACTOR_AND_REASON' USING ERRCODE = '22023';
  END IF;

  IF _next_status = 'cancelled'::public.order_status
     AND _cancel_reason = 'other'
     AND NULLIF(pg_catalog.btrim(_cancel_note), '') IS NULL THEN
    RAISE EXCEPTION 'CANCEL_NOTE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The order, its variants and every waiting order of those variants are locked for the FIFO below.
  PERFORM private.group_h_lock_acceptance(NULL,_order_id);
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);

  -- Replays and other states change nothing (CAS); no operation is recorded for them.
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id AND o.status = _expected_status) THEN
    RETURN QUERY SELECT false, _order_id, o.status FROM public.orders AS o WHERE o.id = _order_id;
    RETURN;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(_actor_id::text, ''), true);
  PERFORM pg_catalog.set_config('app.order_change_reason', _change_reason, true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', COALESCE(_source_event_id, ''), true);

  UPDATE public.orders AS o
  SET status = _next_status,
      cancel_reason = CASE
        WHEN _next_status = 'cancelled'::public.order_status THEN _cancel_reason ELSE o.cancel_reason
      END,
      cancel_note = CASE
        WHEN _next_status = 'cancelled'::public.order_status
          THEN NULLIF(pg_catalog.btrim(_cancel_note), '')
        ELSE o.cancel_note
      END,
      cancel_notify_customer = CASE
        WHEN _next_status = 'cancelled'::public.order_status THEN _notify_customer ELSE o.cancel_notify_customer
      END
  WHERE o.id = _order_id
    AND o.status = _expected_status
  RETURNING o.id INTO updated_id;

  PERFORM private.group_h_settle_redemptions(_order_id,false);

  -- Only the existing H is released (cancel/+n, one event per allocation). Untracked legacy ledger rows stay (R-41).
  SELECT h.released_variant_ids, h.released_quantity INTO v_variants, v_released
  FROM private.release_group_g_payment_holds(updated_id, v_operation, _change_reason, _actor_id) AS h;
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, _change_reason, _actor_id);

  -- The released units go to the oldest waiting orders of the same variants (separate state sequence).
  IF pg_catalog.cardinality(v_variants) > 0 THEN
    v_middle := private.capture_group_g_item_states(v_orders);
    v_allocated := private.allocate_group_g_fifo(v_variants, v_operation, _actor_id);
    PERFORM private.record_group_g_item_state_changes(v_middle, v_orders, v_operation, 2, 'fifo', _actor_id);
  END IF;

  IF _next_status = 'failed'::public.order_status THEN
    PERFORM private.enqueue_order_email(updated_id, 'payment_expired', NULL);
  ELSIF _next_status = 'cancelled'::public.order_status AND COALESCE(_notify_customer, false) THEN
    PERFORM private.enqueue_order_email(updated_id, 'canceled', _expected_status::text);
  END IF;

  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'release_stock_for_unpaid_order',
    pg_catalog.md5('release_stock_for_unpaid_order:' || _order_id::text || ':' || _expected_status::text || ':'
      || _next_status::text || ':' || COALESCE(_source_event_id, ''))::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'release_stock_for_unpaid_order', 'order_id', _order_id, 'expected_status', _expected_status,
      'next_status', _next_status, 'change_reason', _change_reason, 'actor_id', _actor_id,
      'source_event_id', _source_event_id, 'cancel_reason', _cancel_reason, 'cancel_note', _cancel_note,
      'notify_customer', _notify_customer)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    _actor_id,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'status', _next_status,
      'released_quantity', v_released, 'allocated_quantity', v_allocated)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);

  RETURN QUERY SELECT true, updated_id, _next_status;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_cancelled_order_paid_amount(
  _order_id uuid,
  _payment_intent_id text,
  _received_amount integer
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_orders uuid[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
BEGIN
  IF _order_id IS NULL
     OR _received_amount IS NULL
     OR _received_amount < 1
     OR _payment_intent_id IS NULL
     OR _payment_intent_id !~ '^pi_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'REFUND_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.group_h_lock_acceptance(NULL,_order_id);
  v_orders := private.lock_group_g_inventory(ARRAY[]::bigint[], ARRAY[_order_id], NULL);
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Not cancelled, already written, or another PaymentIntent: nothing is written (replay).
  IF v_order.status <> 'cancelled'::public.order_status
     OR v_order.paid_amount IS NOT NULL
     OR (v_order.payment_intent_id IS NOT NULL AND v_order.payment_intent_id <> _payment_intent_id) THEN
    RETURN false;
  END IF;

  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  PERFORM pg_catalog.set_config('app.order_actor_id', '', true);
  PERFORM pg_catalog.set_config('app.order_change_reason', 'record_cancelled_order_payment', true);
  PERFORM pg_catalog.set_config('app.order_source_event_id', '', true);

  UPDATE public.orders AS o
  SET paid_amount = _received_amount,
      payment_intent_id = COALESCE(o.payment_intent_id, _payment_intent_id),
      paid_at = COALESCE(o.paid_at, pg_catalog.clock_timestamp())
  WHERE o.id = _order_id;

  PERFORM private.group_h_settle_redemptions(_order_id,true);

  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1,
    'record_cancelled_order_payment', NULL);
  INSERT INTO private.group_g_operations (id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
  VALUES (
    v_operation,
    'record_cancelled_order_paid_amount',
    pg_catalog.md5('record_cancelled_order_paid_amount:' || _order_id::text)::uuid,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'operation', 'record_cancelled_order_paid_amount', 'order_id', _order_id,
      'payment_intent_id', _payment_intent_id, 'received_amount', _received_amount)::text, 'UTF8')), 'hex'),
    'order',
    _order_id::text,
    NULL,
    pg_catalog.jsonb_build_object('order_id', _order_id, 'paid_amount', _received_amount)
  );
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION private.link_guest_orders(_user_id uuid, _email text)
RETURNS TABLE (id uuid, shipping_full_name text, shipping_postal_code text, shipping_prefecture text,
  shipping_city text, shipping_address text, shipping_building text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_email text := pg_catalog.lower(pg_catalog.btrim(_email));
  v_ids uuid[];
  v_id uuid;
  v_h_ids uuid[];
  v_h_discount_id uuid;
BEGIN
  IF _user_id IS NULL OR v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Non-locking read of the account; only a confirmed owner of the same address may link.
  IF NOT EXISTS (
    SELECT 1 FROM auth.users AS u
    WHERE u.id = _user_id AND u.email_confirmed_at IS NOT NULL AND pg_catalog.lower(u.email) = v_email
  ) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT r.discount_id ORDER BY r.discount_id),ARRAY[]::uuid[]) INTO v_h_ids
    FROM public.discount_redemptions AS r JOIN public.orders AS o ON o.id=r.order_id
    WHERE o.user_id IS NULL AND pg_catalog.lower(pg_catalog.btrim(o.shipping_email))=v_email;
  PERFORM private.group_h_lock(v_h_ids,ARRAY['guest:'||v_email,'member:'||_user_id::text]);
  FOREACH v_h_discount_id IN ARRAY v_h_ids LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(190524,pg_catalog.hashtext(v_h_discount_id::text));
  END LOOP;
  SELECT COALESCE(pg_catalog.array_agg(t.id ORDER BY t.id), ARRAY[]::uuid[]) INTO v_ids
  FROM (
    SELECT o.id FROM public.orders AS o
    WHERE o.user_id IS NULL AND pg_catalog.lower(pg_catalog.btrim(o.shipping_email)) = v_email
    ORDER BY o.id
    FOR UPDATE
  ) AS t;

  -- Same id order; re-check user_id so another owner is never replaced.
  FOREACH v_id IN ARRAY v_ids LOOP
    RETURN QUERY
    UPDATE public.orders AS o SET user_id = _user_id
    WHERE o.id = v_id AND o.user_id IS NULL
    RETURNING o.id, o.shipping_full_name, o.shipping_postal_code, o.shipping_prefecture, o.shipping_city,
      o.shipping_address, o.shipping_building, o.created_at;
  END LOOP;
  UPDATE public.discount_redemptions AS r SET user_id=_user_id,identity_key='member:'||_user_id::text
    WHERE r.order_id=ANY(v_ids) AND r.user_id IS NULL;
END;
$$;

-- H4: confirm and acceptance share the paid-history rule; unpaid and refunded history is not confused.
CREATE OR REPLACE FUNCTION private.get_checkout_discount_context(_buyer_user_id uuid,_guest_email text,_codes text[],_item_ids bigint[],_at timestamptz,_phase text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_preview boolean; v_email text; v_identity text; v_previous boolean; v_reservation boolean;
  v_units jsonb := '{}'::jsonb; v_codes text[]; v_usage jsonb; v_discounts jsonb; v_refusals jsonb;
BEGIN
  IF _phase IS NULL OR _phase NOT IN ('preview','confirm','acceptance') OR _at IS NULL OR NOT pg_catalog.isfinite(_at)
    OR _codes IS NULL OR _item_ids IS NULL OR pg_catalog.cardinality(_codes)>5 OR pg_catalog.cardinality(_item_ids)>50
    OR EXISTS(SELECT 1 FROM pg_catalog.unnest(_codes) AS t(c) WHERE c IS NULL OR pg_catalog.upper(pg_catalog.btrim(c))!~'^[A-Z0-9-]{1,64}$')
    OR EXISTS(SELECT 1 FROM pg_catalog.unnest(_item_ids) AS t(id) WHERE id IS NULL OR id<1 OR id>9007199254740991) THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT pg_catalog.upper(pg_catalog.btrim(c)) ORDER BY pg_catalog.upper(pg_catalog.btrim(c))),ARRAY[]::text[])
    INTO v_codes FROM pg_catalog.unnest(_codes) AS t(c);
  v_preview := _buyer_user_id IS NULL AND _phase='preview';
  IF _buyer_user_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM auth.users AS u WHERE u.id=_buyer_user_id AND u.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_identity := 'member:'||_buyer_user_id::text;
  ELSIF NOT v_preview THEN
    v_email := pg_catalog.lower(pg_catalog.btrim(_guest_email));
    IF v_email IS NULL OR v_email!~'^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' OR pg_catalog.length(v_email)>320 THEN
      RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE='22023'; END IF;
    v_identity := 'guest:'||v_email;
  END IF;
  -- This branch is deliberate: guest preview never executes an orders, refund, or identity-history query.
  IF NOT v_preview THEN
    SELECT EXISTS(SELECT 1 FROM public.orders AS o WHERE (o.status IN ('paid','shipped') OR o.paid_amount>0)
      AND CASE WHEN _buyer_user_id IS NOT NULL THEN o.user_id=_buyer_user_id
        ELSE pg_catalog.lower(pg_catalog.btrim(o.shipping_email))=v_email END) INTO v_previous;
    SELECT EXISTS(SELECT 1 FROM public.discount_redemptions AS r WHERE r.state='reserved' AND r.first_order_only_snapshot
      AND CASE WHEN _buyer_user_id IS NOT NULL THEN r.user_id=_buyer_user_id OR r.identity_key=v_identity
        ELSE pg_catalog.lower(pg_catalog.btrim(r.normalized_email))=v_email END) INTO v_reservation;
    IF _buyer_user_id IS NOT NULL THEN
      WITH refunds AS (SELECT l.order_item_id,pg_catalog.sum(l.quantity) AS n FROM public.order_refund_lines AS l
        JOIN public.order_refunds AS r ON r.id=l.refund_id JOIN public.order_items AS oi ON oi.id=l.order_item_id
        JOIN public.orders AS o ON o.id=oi.order_id WHERE r.status='succeeded' AND o.user_id=_buyer_user_id
          AND oi.item_id=ANY(_item_ids) GROUP BY l.order_item_id),
      units AS (SELECT oi.item_id,pg_catalog.sum(GREATEST(oi.quantity-COALESCE(r.n,0),0))::bigint AS n
        FROM public.orders AS o JOIN public.order_items AS oi ON oi.order_id=o.id LEFT JOIN refunds AS r ON r.order_item_id=oi.id
        WHERE o.user_id=_buyer_user_id AND (o.status IN ('paid','shipped') OR o.paid_amount>0)
          AND oi.line_kind='order' AND oi.item_id=ANY(_item_ids) GROUP BY oi.item_id)
      SELECT COALESCE(pg_catalog.jsonb_object_agg(u.item_id::text,u.n),'{}'::jsonb) INTO v_units FROM units AS u;
    END IF;
  END IF;
  WITH selected AS (
    SELECT d.id AS discount_id,c.id AS code_id,c.code,COALESCE(c.audience,'anyone') AS audience,
      COALESCE(c.allow_guests,true) AS allow_guests,COALESCE(c.single_use,false) AS single_use,
      CASE WHEN c.single_use THEN c.assigned_user_id=_buyer_user_id AND c.unassigned_at IS NULL
        ELSE EXISTS(SELECT 1 FROM public.discount_assignments AS a WHERE a.code_id=c.id AND a.user_id=_buyer_user_id) END AS assigned
    FROM public.discounts AS d LEFT JOIN public.discount_codes AS c ON c.discount_id=d.id AND c.code=ANY(v_codes)
    WHERE (d.method='automatic' AND NOT d.stopped AND d.starts_at<=_at AND (d.ends_at IS NULL OR _at<d.ends_at))
      OR (d.method='code' AND c.id IS NOT NULL AND c.unassigned_at IS NULL
        AND CASE WHEN _buyer_user_id IS NULL THEN c.audience='anyone' AND c.allow_guests AND d.allow_guests
          ELSE c.audience='anyone' OR (c.single_use AND c.assigned_user_id=_buyer_user_id)
            OR EXISTS(SELECT 1 FROM public.discount_assignments AS a WHERE a.code_id=c.id AND a.user_id=_buyer_user_id) END)
  ), totals AS (
    SELECT r.discount_id,pg_catalog.count(*) FILTER(WHERE r.state='reserved')::integer AS reserved,
      pg_catalog.count(*) FILTER(WHERE r.state='confirmed')::integer AS confirmed
      FROM public.discount_redemptions AS r WHERE r.discount_id IN (SELECT s.discount_id FROM selected AS s)
      GROUP BY r.discount_id
  ), code_totals AS (
    SELECT r.code_id,pg_catalog.count(*)::integer AS n FROM public.discount_redemptions AS r
      WHERE r.code_id IN (SELECT s.code_id FROM selected AS s) AND r.state IN ('reserved','confirmed') GROUP BY r.code_id
  )
  SELECT COALESCE((SELECT pg_catalog.jsonb_agg(private.group_h_definition(x.discount_id) ORDER BY x.discount_id)
    FROM (SELECT DISTINCT s.discount_id FROM selected AS s) AS x),'[]'::jsonb),
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('discountId',s.discount_id,
      'reserved',COALESCE(t.reserved,0),'confirmed',COALESCE(t.confirmed,0),
      'buyerUses',NULL,'assigned',COALESCE(s.assigned,false),'codeId',s.code_id,'code',s.code,
      'audience',s.audience,'allowGuests',s.allow_guests,'singleUse',s.single_use,'codeUses',COALESCE(ct.n,0)) ORDER BY s.discount_id,s.code_id)
      FROM selected AS s LEFT JOIN totals AS t ON t.discount_id=s.discount_id LEFT JOIN code_totals AS ct ON ct.code_id=s.code_id),'[]'::jsonb),
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code',c,'reason',CASE WHEN _buyer_user_id IS NULL THEN 'not_eligible'
      WHEN EXISTS(SELECT 1 FROM public.discount_codes AS known WHERE known.code=c) THEN 'not_eligible' ELSE 'not_found' END) ORDER BY c)
      FROM pg_catalog.unnest(v_codes) AS codes(c) WHERE NOT EXISTS(SELECT 1 FROM selected AS s WHERE s.code=c)),'[]'::jsonb)
    INTO v_discounts,v_usage,v_refusals;
  IF NOT v_preview THEN
    -- Personal usage is deliberately a separate statement that cannot execute during guest preview.
    WITH uses AS (SELECT r.discount_id,pg_catalog.count(*)::integer AS n FROM public.discount_redemptions AS r
      WHERE r.state IN ('reserved','confirmed') AND CASE WHEN _buyer_user_id IS NOT NULL THEN r.user_id=_buyer_user_id OR r.identity_key=v_identity
        ELSE pg_catalog.lower(pg_catalog.btrim(r.normalized_email))=v_email END GROUP BY r.discount_id)
    SELECT COALESCE(pg_catalog.jsonb_agg(u.x || pg_catalog.jsonb_build_object('buyerUses',COALESCE(p.n,0)) ORDER BY u.ordinal),'[]'::jsonb)
      INTO v_usage FROM pg_catalog.jsonb_array_elements(v_usage) WITH ORDINALITY AS u(x,ordinal)
      LEFT JOIN uses AS p ON p.discount_id=(u.x->>'discountId')::uuid;
  END IF;
  RETURN pg_catalog.jsonb_build_object('discounts',v_discounts,'facts',pg_catalog.jsonb_build_object('phase',_phase,'at',_at,
    'buyer',CASE WHEN _buyer_user_id IS NULL THEN pg_catalog.jsonb_build_object('kind','guest','normalizedEmail',v_email)
      ELSE pg_catalog.jsonb_build_object('kind','member','userId',_buyer_user_id) END,
    'hasPreviousOrder',v_previous,'hasFirstOrderReservation',v_reservation,'priorUnitsByItem',v_units,'usage',v_usage),'refusals',v_refusals);
END;
$$;

CREATE OR REPLACE FUNCTION private.get_admin_order_detail(_order_id uuid, _actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT o.* INTO v_order FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_G_ORDER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  WITH rows AS MATERIALIZED (SELECT * FROM private.group_g_order_item_rows(ARRAY[_order_id])),
  refunds AS MATERIALIZED (SELECT f.* FROM public.order_refunds AS f WHERE f.order_id = _order_id)
  SELECT pg_catalog.jsonb_build_object(
    'order',pg_catalog.jsonb_build_object('id',v_order.id,'status',v_order.status,'createdAt',v_order.created_at,
      'paidAt',v_order.paid_at,'customerKind',CASE WHEN v_order.user_id IS NULL THEN 'guest' ELSE 'member' END,
      'customerName',pg_catalog.btrim(v_order.shipping_full_name),'customerEmail',pg_catalog.btrim(v_order.shipping_email),
      'shipTo',pg_catalog.jsonb_build_object('fullName',v_order.shipping_full_name,'postalCode',v_order.shipping_postal_code,
        'prefecture',v_order.shipping_prefecture,'city',v_order.shipping_city,'address',v_order.shipping_address,
        'building',v_order.shipping_building,'phone',v_order.shipping_phone),'currency',v_order.currency),
    'amounts',pg_catalog.jsonb_build_object(
      'productNet',(SELECT COALESCE(pg_catalog.sum(oi.line_total::bigint - d.line_discount),0) FROM public.order_items AS oi
        JOIN private.order_line_discounts(_order_id) AS d ON d.order_item_id = oi.id
        WHERE oi.order_id = _order_id AND oi.line_kind = 'order'),
      'discount',v_order.discount_amount,'shipping',v_order.shipping_amount,'total',v_order.total_amount,
      'paidAmount',v_order.paid_amount,'refundedAmount',v_order.refunded_amount,
      'refundAttachedToRows',(SELECT COALESCE(pg_catalog.sum(r.refund_amount),0) FROM rows AS r),
      'refundNotAttached',(SELECT COALESCE(pg_catalog.sum(f.shipping_amount::bigint + f.adjustment_amount),0) FROM refunds AS f WHERE f.status = 'succeeded'),
      'refundProcessingAmount',(SELECT COALESCE(pg_catalog.sum(f.amount),0) FROM refunds AS f WHERE f.status IN ('awaiting_response','pending'))),
    'rows',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'orderItemId',r.order_item_id,'itemName',oi.item_name,'color',oi.color,'size',oi.size,'isExchange',r.is_exchange,
      'status',r.status,'statusRank',r.status_rank,'quantity',r.quantity,'unitPrice',r.unit_price,
      'lineAmount',r.line_amount,'refundAmount',r.refund_amount,'blockedReasons',r.blocked_reasons)
      ORDER BY r.order_id,r.order_item_id,r.status_rank,r.first_unit)
      FROM rows AS r JOIN public.order_items AS oi ON oi.id = r.order_item_id),'[]'::jsonb),
    'attention',pg_catalog.jsonb_build_object(
      'discounts',private.group_h_discount_attention_rows(_order_id),
      'paymentExceptions',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',e.id,'reason',e.reason,
        'detectionCount',e.detection_count,'firstDetectedAt',e.first_detected_at) ORDER BY e.first_detected_at,e.id)
        FROM public.payment_exceptions AS e WHERE e.order_id = _order_id AND e.resolved_at IS NULL),'[]'::jsonb),
      'review',CASE WHEN v_order.review_reason IS NOT NULL AND v_order.reviewed_at IS NULL THEN
        pg_catalog.jsonb_build_object('reason',v_order.review_reason,'markedAt',v_order.review_marked_at) ELSE NULL END,
      'deliveries',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('fulfillmentId',a.fulfillment_id,
        'kind',a.kind,'openedAt',a.opened_at) ORDER BY a.opened_at,a.id)
        FROM public.order_fulfillment_attention AS a JOIN public.order_fulfillments AS f ON f.id = a.fulfillment_id
        WHERE f.order_id = _order_id AND a.resolved_at IS NULL),'[]'::jsonb)),
    'permissions',pg_catalog.jsonb_build_object('read',true,
      'manage',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.orders.manage']),
      'refund',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.orders.refund']),
      'return',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.orders.return']),
      'allocate',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.orders.allocate','admin.orders.read']),
      'shippingRead',private.group_g_actor_has_permissions(_actor_id,ARRAY['admin.shipping.read','admin.orders.read']))) INTO v_result;
  RETURN v_result;
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
    'private.admin_swap_order_allocations(uuid,uuid,uuid,integer,text,uuid,uuid)',
    'private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text)'
  ]::pg_catalog.regprocedure[];
$$;
CREATE FUNCTION public.list_admin_discount_attention(_limit integer,_actor_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_admin_discount_attention(_limit,_actor_id) $$;

CREATE FUNCTION public.admin_resolve_discount_attention(_order_id uuid,_actor_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_resolve_discount_attention(_order_id,_actor_id) $$;

CREATE FUNCTION public.place_reconciled_order_from_checkout_draft(
  _draft_id uuid,
  _checkout_session_id text,
  _cart_session_id text,
  _stripe_amount_total integer,
  _stripe_amount_discount integer,
  _stripe_currency text,
  _checkout_session_created_at timestamptz,
  _payment_intent_id text,
  _stripe_payment_state text
) RETURNS TABLE (order_id uuid, order_status public.order_status, created boolean, rejection text)
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.place_reconciled_order_from_checkout_draft(_draft_id,_checkout_session_id,_cart_session_id,_stripe_amount_total,_stripe_amount_discount,_stripe_currency,_checkout_session_created_at,_payment_intent_id,_stripe_payment_state) $$;

ALTER FUNCTION private.group_h_lock_acceptance(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_lock_acceptance(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_assert_acceptance_locks(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_assert_acceptance_locks(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_recheck_discount_facts(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_recheck_discount_facts(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_copy_order_discounts(uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_copy_order_discounts(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_reserve_redemptions(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_reserve_redemptions(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_settle_redemptions(uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_settle_redemptions(uuid,boolean) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.group_h_discount_attention_rows(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_discount_attention_rows(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.list_admin_discount_attention(integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_admin_discount_attention(integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_admin_discount_attention(integer,uuid) TO service_role;
ALTER FUNCTION public.list_admin_discount_attention(integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_discount_attention(integer,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_discount_attention(integer,uuid) TO service_role;
ALTER FUNCTION private.admin_resolve_discount_attention(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_resolve_discount_attention(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_resolve_discount_attention(uuid,uuid) TO service_role;
ALTER FUNCTION public.admin_resolve_discount_attention(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_resolve_discount_attention(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_discount_attention(uuid,uuid) TO service_role;
ALTER FUNCTION private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid) TO service_role;
ALTER FUNCTION public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid) TO service_role;
ALTER FUNCTION private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text) TO service_role;
ALTER FUNCTION public.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text) TO service_role;
ALTER FUNCTION private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) TO service_role;
ALTER FUNCTION public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text) TO service_role;
ALTER FUNCTION private.mark_order_awaiting_payment(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.mark_order_awaiting_payment(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.mark_order_awaiting_payment(uuid,text,text) TO service_role;
ALTER FUNCTION public.mark_order_awaiting_payment(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_order_awaiting_payment(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_order_awaiting_payment(uuid,text,text) TO service_role;
ALTER FUNCTION private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean) TO service_role;
ALTER FUNCTION public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean) TO service_role;
ALTER FUNCTION private.record_cancelled_order_paid_amount(uuid,text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_cancelled_order_paid_amount(uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.record_cancelled_order_paid_amount(uuid,text,integer) TO service_role;
ALTER FUNCTION public.record_cancelled_order_paid_amount(uuid,text,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_cancelled_order_paid_amount(uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_cancelled_order_paid_amount(uuid,text,integer) TO service_role;
ALTER FUNCTION private.link_guest_orders(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.link_guest_orders(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.link_guest_orders(uuid,text) TO service_role;
ALTER FUNCTION public.link_guest_orders(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.link_guest_orders(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_guest_orders(uuid,text) TO service_role;
ALTER FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) TO service_role;
ALTER FUNCTION public.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) TO service_role;
ALTER FUNCTION private.get_admin_order_detail(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_admin_order_detail(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_admin_order_detail(uuid,uuid) TO service_role;
ALTER FUNCTION public.get_admin_order_detail(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_order_detail(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_order_detail(uuid,uuid) TO service_role;
ALTER FUNCTION private.group_g_writer_allowlist() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_writer_allowlist() FROM PUBLIC, anon, authenticated, service_role;
-- H4_BODY_END

-- H4_FINAL_ASSERT_BEGIN
DO $h4_final$
DECLARE
  e record; p record; w record; v_oid oid; v_name text; v_detail text; v_expected_delegate text;
BEGIN
  FOR e IN SELECT * FROM (VALUES
    ('group_h_lock_acceptance(uuid,uuid)','void',false,'plpgsql','v',false,0,'_draft_id,_order_id','h4_member_lock','ad499ab3771dd86c49e46daa3829685f'),
    ('group_h_assert_acceptance_locks(uuid,uuid)','void',false,'plpgsql','v',false,0,'_draft_id,_order_id','h4_member_lock','7c5f8f26c9f0638a1847a55a38350d99'),
    ('group_h_recheck_discount_facts(uuid,uuid)','jsonb',false,'plpgsql','v',false,1,'_draft_id,_order_id','h4_member_lock','1b07869c9336bdebc83200f4de93cf47'),
    ('group_h_copy_order_discounts(uuid,uuid,jsonb)','void',false,'plpgsql','v',false,0,'_draft_id,_order_id,_line_map','h4_acceptance','fca08998ff46f1256001b27a519f1314'),
    ('group_h_reserve_redemptions(uuid,uuid)','void',false,'plpgsql','v',false,0,'_draft_id,_order_id','h4_redemption_lifecycle','f065f0d5e0039cad9ad0bf164cf3f41a'),
    ('group_h_settle_redemptions(uuid,boolean)','jsonb',false,'plpgsql','v',false,0,'_order_id,_paid','h4_redemption_lifecycle','56e2637b56b44e94d0c758a1050595f9'),
    ('group_h_discount_attention_rows(uuid)','jsonb',false,'sql','s',false,0,'_order_id','h4_attention','963974396ac16407600fdb92ca214dc2'),
    ('list_admin_discount_attention(integer,uuid)','jsonb',false,'plpgsql','s',true,0,'_limit,_actor_id','h4_attention','17cb972d393d41317055889e63fdb069'),
    ('admin_resolve_discount_attention(uuid,uuid)','jsonb',false,'plpgsql','v',true,0,'_order_id,_actor_id','h4_attention','74d5e4915652ced28fa5a5dc077ab085'),
    ('place_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,bigint[],uuid)','record',true,'plpgsql','v',true,3,'_draft_id,_checkout_session_id,_cart_session_id,_stripe_amount_total,_stripe_amount_discount,_stripe_currency,_checkout_session_created_at,_payment_intent_id,_shown_in_stock_variant_ids,_buyer_user_id,order_id,order_status,created,rejection','h4_acceptance','e800502ccabdb6a25a3392e8c274911e'),
    ('place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text)','record',true,'plpgsql','v',true,0,'_draft_id,_checkout_session_id,_cart_session_id,_stripe_amount_total,_stripe_amount_discount,_stripe_currency,_checkout_session_created_at,_payment_intent_id,_stripe_payment_state,order_id,order_status,created,rejection','h4_reconciled_recovery','8237ea1bfc835f262960f501dcdfe390'),
    ('mark_order_paid(uuid,public.order_status,text,integer,text,boolean,text,text)','record',true,'plpgsql','v',true,1,'_order_id,_expected_status,_payment_intent_id,_paid_amount,_paid_currency,_notify_customer,_paid_email_variant,_source_event_id,updated,amount_matches,needs_review','h4_redemption_lifecycle','36ff83361729cd5820972816234e58a5'),
    ('mark_order_awaiting_payment(uuid,text,text)','boolean',true,'plpgsql','v',true,1,'_order_id,_payment_intent_id,_source_event_id,updated','h4_redemption_lifecycle','74f28623affb160970e538780bf9213f'),
    ('release_stock_for_unpaid_order(uuid,public.order_status,public.order_status,text,uuid,text,text,text,boolean)','record',true,'plpgsql','v',true,5,'_order_id,_expected_status,_next_status,_change_reason,_actor_id,_source_event_id,_cancel_reason,_cancel_note,_notify_customer,released,order_id,status','h4_redemption_lifecycle','e4139ff0161ed8b94d48341957649cf1'),
    ('record_cancelled_order_paid_amount(uuid,text,integer)','boolean',false,'plpgsql','v',true,0,'_order_id,_payment_intent_id,_received_amount','h4_reconciled_recovery','9824f57897e5e189c81106163f19fde0'),
    ('link_guest_orders(uuid,text)','record',true,'plpgsql','v',true,0,'_user_id,_email,id,shipping_full_name,shipping_postal_code,shipping_prefecture,shipping_city,shipping_address,shipping_building,created_at','h4_member_lock','6d42e3f7459a6bd6c86e5fbd81434072'),
    ('get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text)','jsonb',false,'plpgsql','s',true,0,'_buyer_user_id,_guest_email,_codes,_item_ids,_at,_phase','h4_member_lock','aa44f0698e74672ffab6df0949edf414'),
    ('get_admin_order_detail(uuid,uuid)','jsonb',false,'plpgsql','s',true,0,'_order_id,_actor_id','h4_attention','87d26678c21c1d51f9beb469f681c398'),
    ('group_g_writer_allowlist()','pg_catalog.regprocedure[]',false,'sql','s',false,0,'','h4_writer_allowlist','1a9bd697484b32bb5f44793ced4b70df')
  ) AS expected(signature,result_type,returns_set,language,volatility,service,defaults,arg_names,detail,body_md5) LOOP
    v_name := pg_catalog.split_part(e.signature,'(',1);
    v_oid := pg_catalog.to_regprocedure('private.'||e.signature);
    SELECT f.*,l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
    IF NOT FOUND OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid=f.pronamespace
      WHERE n.nspname='private' AND f.proname=v_name)<>1 THEN v_detail := e.detail; EXIT; END IF;
    IF p.proowner<>'postgres'::regrole OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
      OR p.prorettype<>pg_catalog.to_regtype(e.result_type) OR p.proretset<>e.returns_set OR p.prokind<>'f'
      OR p.provolatile<>e.volatility::"char" OR p.lanname<>e.language OR p.proisstrict OR p.proleakproof
      OR p.proparallel<>'u' OR p.pronargdefaults<>e.defaults
      OR COALESCE(pg_catalog.array_to_string(p.proargnames,','),'')<>e.arg_names THEN v_detail := e.detail; EXIT; END IF;
    IF pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')<>e.service
      OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
      v_detail := 'h4_public_acl'; EXIT; END IF;
    IF pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5 THEN v_detail := e.detail; EXIT; END IF;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid=f.pronamespace
      WHERE n.nspname='public' AND f.proname=v_name)<>(CASE WHEN e.service THEN 1 ELSE 0 END) THEN v_detail := 'h4_public_acl'; EXIT; END IF;
    IF e.service THEN
      v_oid := pg_catalog.to_regprocedure('public.'||e.signature);
      SELECT f.*,l.lanname INTO w FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
      IF NOT FOUND THEN v_detail := 'h4_public_acl'; EXIT; END IF;
      v_expected_delegate := 'select'||CASE WHEN e.returns_set THEN '*from' ELSE '' END||'private.'||v_name||'('||
        pg_catalog.array_to_string(p.proargnames[1:p.pronargs],',')||')';
      IF w.proowner<>'postgres'::regrole OR w.prosecdef OR w.lanname<>'sql' OR w.proconfig IS DISTINCT FROM ARRAY['search_path=""']
        OR w.prorettype<>p.prorettype OR w.proretset<>p.proretset OR w.proallargtypes IS DISTINCT FROM p.proallargtypes
        OR w.proargmodes IS DISTINCT FROM p.proargmodes OR w.proargtypes IS DISTINCT FROM p.proargtypes
        OR w.prokind<>'f' OR w.provolatile<>p.provolatile OR w.proisstrict OR w.proleakproof OR w.proparallel<>'u'
        OR w.pronargdefaults<>p.pronargdefaults OR w.proargnames IS DISTINCT FROM p.proargnames
        OR pg_catalog.regexp_replace(pg_catalog.lower(w.prosrc),'[[:space:];]','','g')<>v_expected_delegate
        OR NOT pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')
        OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(w.proacl,pg_catalog.acldefault('f',w.proowner))) AS a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
        v_detail := 'h4_public_acl'; EXIT; END IF;
    END IF;
  END LOOP;
  IF v_detail IS NULL AND ((SELECT pg_catalog.count(*) FROM pg_temp.group_h4_writer_baseline)<>76
    OR (SELECT pg_catalog.array_agg(x::oid ORDER BY x::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x)) IS DISTINCT FROM
      (SELECT pg_catalog.array_agg(x ORDER BY x) FROM (SELECT b.oid AS x FROM pg_temp.group_h4_writer_baseline AS b
        UNION ALL SELECT 'private.place_reconciled_order_from_checkout_draft(uuid,text,text,integer,integer,text,timestamptz,text,text)'::regprocedure::oid) AS expected)
    OR (SELECT pg_catalog.count(DISTINCT x) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS t(x))<>77) THEN
    v_detail := 'h4_writer_allowlist'; END IF;
  IF v_detail IS NOT NULL THEN RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001',DETAIL=v_detail; END IF;
END;
$h4_final$;
-- H4_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
