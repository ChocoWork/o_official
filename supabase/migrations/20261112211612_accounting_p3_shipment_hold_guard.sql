BEGIN;
-- Accounting plan 3 S19 (FREQ-580 AC-02/AC-03, FREQ-576 AC-05/AC-06): the shipment slip confirm refuses an order under a
-- dispute hold.
--
-- Rebuilt (the latest definition copied as it is, one new statement between ACC_P3_BEGIN and ACC_P3_END):
--   private.admin_confirm_shipment_slip (plan 2 S6, 20261108150000)   after the existence check of the orders and before
--     "(1) every order is paid": PERFORM private.accounting_assert_no_dispute_hold(v_orders) (tool of S15). The replay branch
--     returns before it, so a request that already confirmed the slip still gets its first result. A refusal
--     (ACCOUNTING_DISPUTE_HOLD / 55000) leaves the slip a draft and writes nothing. Arguments, result, attributes, owner and
--     ACL are unchanged (CREATE OR REPLACE); the public entry and the cancel function are not touched.
--
-- ROLLBACK: re-run CREATE OR REPLACE of private.admin_confirm_shipment_slip from 20261108150000_accounting_p2_posting_tables.sql
--   :670-885.

-- ACC_S19_BODY_BEGIN

CREATE TEMP TABLE accounting_s19_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s19_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', pg_catalog.jsonb_build_object(
    'slips', (SELECT pg_catalog.count(*) FROM public.shipment_slips),
    'fulfillments', (SELECT pg_catalog.count(*) FROM public.order_fulfillments),
    'operations', (SELECT pg_catalog.count(*) FROM private.group_g_operations)),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(n.nspname, pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))
    FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
    WHERE f.oid IN ('private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)'::regprocedure,
      'public.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)'::regprocedure)));

-- 1. The confirm function. CREATE OR REPLACE with the latest definition (plan 2 S6) copied as it is; the only difference is
--    the text between ACC_P3_BEGIN and ACC_P3_END.
CREATE OR REPLACE FUNCTION private.admin_confirm_shipment_slip(_slip_id uuid, _expected_version integer, _carrier text, _tracking_number text,
  _shipment_date date, _notify_customer boolean, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_existing private.group_g_operations%ROWTYPE;
  v_slip public.shipment_slips%ROWTYPE;
  v_fingerprint text;
  v_orders uuid[];
  v_items uuid[];
  v_before jsonb;
  v_order uuid;
  v_line record;
  v_lines jsonb;
  v_fulfillment uuid;
  v_quantity integer;
  v_number integer;
  v_completes boolean;
  v_payment_review boolean;
  v_exchange_fee boolean;
  v_address boolean;
  v_unshippable boolean;
  v_exceeds boolean;
  v_verdict text;
  v_version integer;
  v_fulfillments jsonb := '[]'::jsonb;
  v_result jsonb;
  v_previous_operation text;
  v_previous_actor text;
  v_previous_reason text;
  v_previous_change text;
BEGIN
  _tracking_number := NULLIF(pg_catalog.btrim(_tracking_number), '');
  IF _slip_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL
    OR _shipment_date IS NULL OR _notify_customer IS NULL
    OR (_carrier IS NOT NULL AND _carrier NOT IN ('yamato','sagawa','japanpost'))
    OR (_tracking_number IS NOT NULL AND _tracking_number !~ '^[0-9A-Za-z-]{1,64}$') THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (_carrier IS NULL) <> (_tracking_number IS NULL) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_TRACKING_INCOMPLETE' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
    ARRAY['admin.shipping.manage','admin.shipping.read','admin.orders.manage','admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_slip FROM public.shipment_slips AS s WHERE s.id = _slip_id;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_slip_confirm', 'slip_id', _slip_id, 'carrier', _carrier, 'tracking_number', _tracking_number,
    'shipment_date', _shipment_date, 'notify_customer', _notify_customer, 'lines', v_slip.draft_lines, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_slip_confirm' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;
  IF v_slip.id IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_slip.stage <> 'draft' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_DRAFT' USING ERRCODE = '55000';
  END IF;
  IF v_slip.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF v_slip.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_DRAFT_EXPIRED' USING ERRCODE = '55000';
  END IF;
  IF pg_catalog.jsonb_array_length(v_slip.draft_lines) = 0 THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_EMPTY' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(d."orderItemId" ORDER BY d."orderItemId") INTO v_items
    FROM pg_catalog.jsonb_to_recordset(v_slip.draft_lines) AS d("orderItemId" uuid, quantity integer);
  SELECT pg_catalog.array_agg(DISTINCT oi.order_id ORDER BY oi.order_id) INTO v_orders
    FROM public.order_items AS oi WHERE oi.id = ANY(v_items);
  IF (SELECT pg_catalog.count(*) FROM public.order_items AS oi WHERE oi.id = ANY(v_items)) <> pg_catalog.cardinality(v_items) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- ACC_P3_BEGIN
  PERFORM private.accounting_assert_no_dispute_hold(v_orders);
  -- ACC_P3_END
  -- (1) every order is paid
  IF EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = ANY(v_orders) AND o.status <> 'paid') THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;
  -- (2) the blocked reasons and (4) the quantities come from the same single evaluation of group_g_shipment_ready
  WITH ready AS MATERIALIZED (
    SELECT r.order_item_id, r.shippable, r.blocked_reasons
    FROM private.group_g_shipment_ready(v_orders) AS r WHERE r.order_item_id = ANY(v_items)
  ), wanted AS (
    SELECT (e.value ->> 'orderItemId')::uuid AS item_id, (e.value ->> 'quantity')::integer AS quantity
    FROM pg_catalog.jsonb_array_elements(v_slip.draft_lines) AS e(value)
  )
  SELECT COALESCE((SELECT pg_catalog.bool_or('payment_review' = ANY(r.blocked_reasons)) FROM ready AS r), false),
         COALESCE((SELECT pg_catalog.bool_or('exchange_fee_waiting' = ANY(r.blocked_reasons)) FROM ready AS r), false),
         COALESCE((SELECT pg_catalog.bool_or('address_incomplete' = ANY(r.blocked_reasons)) FROM ready AS r), false),
         COALESCE((SELECT pg_catalog.bool_or('variant_missing' = ANY(r.blocked_reasons) OR 'paid_at_missing' = ANY(r.blocked_reasons))
                   FROM ready AS r), false),
         EXISTS (SELECT 1 FROM wanted AS w LEFT JOIN ready AS r ON r.order_item_id = w.item_id
                 WHERE w.quantity > COALESCE(r.shippable, 0))
    INTO v_payment_review, v_exchange_fee, v_address, v_unshippable, v_exceeds;
  IF v_payment_review THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED' USING ERRCODE = '22023';
  ELSIF v_exchange_fee THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_EXCHANGE_ON_HOLD' USING ERRCODE = '22023';
  ELSIF v_address THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ADDRESS_INCOMPLETE' USING ERRCODE = '22023';
  ELSIF v_unshippable THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ORDER_NOT_SHIPPABLE' USING ERRCODE = '22023';
  END IF;
  -- (3) the bundle verdict
  v_verdict := private.group_g_bundle_verdict(v_orders);
  IF v_verdict = 'customer_mismatch' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_CUSTOMER_MISMATCH' USING ERRCODE = '22023';
  ELSIF v_verdict = 'address_mismatch' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ADDRESS_MISMATCH' USING ERRCODE = '22023';
  ELSIF v_verdict IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_ADDRESS_INCOMPLETE' USING ERRCODE = '22023';
  END IF;
  -- (4) the quantities
  IF v_exceeds THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_QUANTITY_EXCEEDS_READY' USING ERRCODE = '22023';
  END IF;

  -- (5) All included orders' first payment dates bound the same JST calendar date.
  IF _shipment_date > (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date OR EXISTS (
    SELECT 1 FROM public.orders AS o WHERE o.id = ANY(v_orders)
      AND (o.paid_at IS NULL OR (o.paid_at AT TIME ZONE 'Asia/Tokyo')::date > _shipment_date)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SHIPMENT_DATE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  v_previous_operation := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_previous_actor := pg_catalog.current_setting('app.order_actor_id', true);
  v_previous_reason := pg_catalog.current_setting('app.order_change_reason', true);
  v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  BEGIN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
    FOREACH v_order IN ARRAY v_orders LOOP
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_item_id', d."orderItemId", 'quantity', d.quantity)
        ORDER BY d."orderItemId"), pg_catalog.sum(d.quantity) INTO v_lines, v_quantity
      FROM pg_catalog.jsonb_to_recordset(v_slip.draft_lines) AS d("orderItemId" uuid, quantity integer)
      JOIN public.order_items AS oi ON oi.id = d."orderItemId" WHERE oi.order_id = v_order;
      SELECT COALESCE(pg_catalog.sum(f.unshipped), 0) - v_quantity = 0 INTO v_completes
        FROM private.order_line_fulfillment(v_order) AS f;
      SELECT COALESCE(pg_catalog.max(f.number), 0) + 1 INTO v_number FROM public.order_fulfillments AS f WHERE f.order_id = v_order;
      INSERT INTO public.order_fulfillments(order_id, number, request_key, shipping_carrier, tracking_number,
        notify_customer, completes_order, created_by, shipped_at, delivery_status_at, request_fingerprint, shipment_date)
      VALUES(v_order, v_number, pg_catalog.md5('slip_fulfillment:' || _request_key::text || ':' || v_order::text)::uuid,
        _carrier, _tracking_number, _notify_customer, v_completes, _actor_id, pg_catalog.now(), pg_catalog.now(),
        private.fulfillment_create_fingerprint(v_order, _carrier, _tracking_number, _notify_customer, v_lines), _shipment_date)
      RETURNING id INTO v_fulfillment;
      -- G-1 checks shipped + remaining paid allocations immediately after each line INSERT.
      -- Consume first so no statement double-counts the same units; the deferred G-3 guard
      -- checks the final line/consume balance, including any rollback of a later order.
      FOR v_line IN SELECT d.* FROM pg_catalog.jsonb_to_recordset(v_lines) AS d(order_item_id uuid, quantity integer)
        ORDER BY d.order_item_id LOOP
        PERFORM private.consume_group_g_allocations(v_line.order_item_id, v_line.quantity, v_operation, _actor_id);
        INSERT INTO public.order_fulfillment_lines(fulfillment_id, order_item_id, quantity)
          VALUES(v_fulfillment, v_line.order_item_id, v_line.quantity);
      END LOOP;
      INSERT INTO public.order_fulfillment_events(fulfillment_id, tracking_version, status, happened_at, source)
        VALUES(v_fulfillment, 1, 'confirmed', pg_catalog.now(), 'shipment');
      INSERT INTO public.shipment_slip_fulfillments(slip_id, order_id, fulfillment_id) VALUES(_slip_id, v_order, v_fulfillment);
      IF v_completes THEN
        PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
        PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_create_fulfillment', true);
        UPDATE public.orders SET status = 'shipped'::public.order_status, shipped_at = pg_catalog.now(),
          shipping_carrier = _carrier, tracking_number = _tracking_number WHERE id = v_order;
      END IF;
      IF _notify_customer THEN
        PERFORM private.enqueue_order_email(v_order, 'shipped', NULL, v_fulfillment);
      END IF;
      v_fulfillments := v_fulfillments || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'orderId', v_order::text, 'fulfillmentId', v_fulfillment::text, 'number', v_number, 'completesOrder', v_completes));
    END LOOP;
    IF _tracking_number IS NOT NULL THEN
      PERFORM private.register_group_g_slip_tracking(_slip_id, 1, _actor_id, v_operation);
    END IF;
    PERFORM pg_catalog.set_config('app.group_g_slip_change', 'confirm', true);
    UPDATE public.shipment_slips SET stage = 'confirmed', confirmed_at = pg_catalog.now(), confirmed_by = _actor_id,
      confirm_operation_id = v_operation, confirm_request_key = _request_key, shipping_carrier = _carrier,
      tracking_number = _tracking_number, notify_customer = _notify_customer, shipment_date = _shipment_date,
      expires_at = NULL, version = version + 1, updated_at = pg_catalog.now()
      WHERE id = _slip_id RETURNING version INTO v_version;
    -- ACC_P2_BEGIN
    PERFORM private.accounting_record_slip_fact(_slip_id, 'confirm');
    -- ACC_P2_END
    INSERT INTO public.shipment_slip_lines(slip_id, order_item_id, quantity)
      SELECT _slip_id, d."orderItemId", d.quantity FROM pg_catalog.jsonb_to_recordset(v_slip.draft_lines) AS d("orderItemId" uuid, quantity integer);
    INSERT INTO public.shipment_slip_versions(slip_id, version, kind, shipping_carrier, tracking_number, tracking_version, shipment_date, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'confirm', _carrier, _tracking_number, 1, _shipment_date, _actor_id, v_operation);
    INSERT INTO public.shipment_date_history(slip_id, version, kind, previous_date, new_date, reason, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'initial', (pg_catalog.now() AT TIME ZONE 'Asia/Tokyo')::date, _shipment_date, NULL, _actor_id, v_operation);
    PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'shipment_slip_confirm', _actor_id);
    v_result := pg_catalog.jsonb_build_object('id', _slip_id::text, 'number', v_slip.number, 'version', v_version,
      'shipmentDate', _shipment_date::text, 'fulfillments', v_fulfillments, 'replayed', false);
    INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
      VALUES(v_operation, 'shipment_slip_confirm', _request_key, v_fingerprint, 'shipment_slip', _slip_id::text, _actor_id, v_result);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
    PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_previous_actor, ''), true);
    PERFORM pg_catalog.set_config('app.order_change_reason', COALESCE(v_previous_reason, ''), true);
    PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
    RAISE;
  END;
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  PERFORM pg_catalog.set_config('app.order_actor_id', COALESCE(v_previous_actor, ''), true);
  PERFORM pg_catalog.set_config('app.order_change_reason', COALESCE(v_previous_reason, ''), true);
  PERFORM pg_catalog.set_config('app.group_g_slip_change', COALESCE(v_previous_change, ''), true);
  RETURN v_result;
END;
$$;
-- ACC_S19_BODY_END

-- ACC_S19_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. The rebuilt body, with every ACC_P<n> block and all white space
-- removed, is the latest definition (the md5 of that text).
DO $acc_s19_final$
DECLARE
  v_failed text;
  v_stage text;
  v_search_path text;
  v_baseline jsonb;
  v_src text;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s19_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s19_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s19_baseline) <> 1 THEN
    v_failed := 'acc_s19_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s19_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s19_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s19_function_attrs';
  -- acc_s19_function_attrs: the private body and the public entry keep their arguments, result, language, volatility,
  -- security, owner, search_path and ACL.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'attrs')) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'attrs') AS b(nsp, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f
        ON f.oid = pg_catalog.to_regprocedure(b.nsp || '.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)')
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
        f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))) THEN
    v_failed := 'acc_s19_function_attrs';
  END IF;

  v_stage := 'acc_s19_body_unchanged';
  -- acc_s19_body_unchanged: the rebuilt body has exactly one ACC_P3 block (the dispute hold line), and with every ACC_P<n>
  -- block removed it is the latest definition.
  IF v_failed IS NULL THEN
    SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)');
    IF v_src IS NULL
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_BEGIN', 'g')) <> 1
      OR pg_catalog.strpos(v_src, '-- ACC_P3_BEGIN' || pg_catalog.chr(10) || '  PERFORM private.accounting_assert_no_dispute_hold(v_orders);'
        || pg_catalog.chr(10) || '  -- ACC_P3_END') = 0
      OR pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM 'e6d4c5ad820247aa47618a951a5f6449' THEN
      v_failed := 'acc_s19_body_unchanged';
    END IF;
  END IF;

  v_stage := 'acc_s19_g_allowlist_unchanged';
  -- acc_s19_g_allowlist_unchanged: the writer list is what it was at the start of this migration (77 entries).
  IF v_failed IS NULL AND (
    pg_catalog.jsonb_array_length(v_baseline -> 'allowlist') <> 77
    OR pg_catalog.cardinality(private.group_g_writer_allowlist()) <> 77
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc))
      IS DISTINCT FROM (v_baseline -> 'allowlist')) THEN
    v_failed := 'acc_s19_g_allowlist_unchanged';
  END IF;

  v_stage := 'acc_s19_existing_dml_allowlist';
  -- acc_s19_existing_dml_allowlist: this migration writes no row.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.shipment_slips) IS DISTINCT FROM (v_baseline #>> '{counts,slips}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.order_fulfillments) IS DISTINCT FROM (v_baseline #>> '{counts,fulfillments}')::bigint
    OR (SELECT pg_catalog.count(*) FROM private.group_g_operations) IS DISTINCT FROM (v_baseline #>> '{counts,operations}')::bigint) THEN
    v_failed := 'acc_s19_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s19_function_attrs'), HINT = SQLSTATE;
END;
$acc_s19_final$;
-- ACC_S19_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
