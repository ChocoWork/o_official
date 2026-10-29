BEGIN;
-- H6: order discount breakdown views. Order-time names, codes and amounts are read from the frozen redemptions only.
-- No existing business row is written; replaced readers keep signature, owner, SECURITY, volatility, search_path and ACL.
CREATE TEMP TABLE h6_function_baseline ON COMMIT DROP AS
SELECT p.oid,p.prorettype,p.proretset,p.proowner,p.prosecdef,p.provolatile,p.proconfig,p.proargnames,p.proargtypes,p.pronargdefaults,
  pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE') AS service
FROM pg_catalog.pg_proc AS p WHERE p.oid=ANY(ARRAY[
  'public.get_order_status_public_material(uuid)'::regprocedure,
  'private.get_admin_order_detail(uuid,uuid)'::regprocedure]::oid[]);

-- H6_BODY_BEGIN
-- Internal only (no EXECUTE for any API role): the breakdown of one order.
-- Current orders: one row per positive redemption (product class first, then order class, then discount id); the sum must equal
-- orders.discount_amount. Legacy orders (no positive redemption): one row with the ASCII name sentinel 'discount' for the old
-- total (rows = [] when the old total is zero). The TypeScript side turns the sentinel into the display label in one place.
CREATE FUNCTION private.order_discount_breakdown(_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_discount integer;
  v_rows jsonb;
  v_total bigint;
BEGIN
  SELECT o.discount_amount INTO v_discount FROM public.orders AS o WHERE o.id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_H_ORDER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', r.name_snapshot,
      'amount', r.amount,
      'discountId', r.discount_id,
      'code', r.code_snapshot,
      'lineAllocations', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('orderItemId', a.order_item_id, 'amount', a.amount)
          ORDER BY a.order_item_id)
        FROM public.order_line_discount_allocations AS a
        WHERE a.order_id = r.order_id AND a.discount_id = r.discount_id AND a.amount > 0
      ), '[]'::jsonb)
    ) ORDER BY (r.class_snapshot = 'order'), r.discount_id), '[]'::jsonb),
    COALESCE(pg_catalog.sum(r.amount), 0)::bigint
  INTO v_rows, v_total
  FROM public.discount_redemptions AS r
  WHERE r.order_id = _order_id AND r.amount > 0;
  IF v_total > 0 THEN
    IF v_total <> v_discount::bigint THEN
      RAISE EXCEPTION 'GROUP_H_ORDER_BREAKDOWN_INVALID' USING ERRCODE = '55000';
    END IF;
    RETURN pg_catalog.jsonb_build_object('rows', v_rows, 'legacy', false);
  END IF;
  IF v_discount > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'rows', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'name', 'discount', 'amount', v_discount, 'discountId', NULL::uuid, 'code', NULL::text, 'lineAllocations', '[]'::jsonb)),
      'legacy', true);
  END IF;
  RETURN pg_catalog.jsonb_build_object('rows', '[]'::jsonb, 'legacy', true);
END;
$$;

-- Service-role entry (the only entry to the full breakdown, with codes and per-line amounts). The caller authorizes first.
CREATE FUNCTION private.get_order_discount_breakdown(_order_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _order_id IS NULL THEN
    RAISE EXCEPTION 'GROUP_H_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN private.order_discount_breakdown(_order_id);
END;
$$;

CREATE FUNCTION public.get_order_discount_breakdown(_order_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_order_discount_breakdown(_order_id) $$;

-- Replacement 1 of 2: the public status material keeps its body (G3) and gains one key: discounts = [{name, amount}] only.
CREATE OR REPLACE FUNCTION public.get_order_status_public_material(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order jsonb;
BEGIN
  IF _order_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'id', o.id,
    'created_at', o.created_at,
    'status', o.status,
    'subtotal_amount', o.subtotal_amount,
    'shipping_amount', o.shipping_amount,
    'discount_amount', o.discount_amount,
    'total_amount', o.total_amount,
    'currency', o.currency,
    'order_items', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', oi.id,
        'item_id', oi.item_id,
        'variant_id', oi.variant_id,
        'item_name', oi.item_name,
        'item_image_url', oi.item_image_url,
        'color', oi.color,
        'size', oi.size,
        'quantity', oi.quantity,
        'line_total', oi.line_total,
        'line_kind', oi.line_kind
      ) ORDER BY oi.created_at, oi.id)
      FROM public.order_items AS oi
      WHERE oi.order_id = o.id
    ), '[]'::jsonb)
  ) INTO v_order
  FROM public.orders AS o
  WHERE o.id = _order_id
    AND o.status NOT IN ('payment_in_progress', 'abandoned');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'order', v_order,
    'line_rows', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'order_id', _order_id,
        'order_item_id', l.order_item_id,
        'variant_id', l.variant_id,
        'fulfillment_type', l.fulfillment_type,
        'quantity', l.quantity,
        'shipped', l.shipped,
        'completed', l.completed,
        'refunded_before_shipment', l.refunded_before_shipment,
        'refunded_after_shipment', l.refunded_after_shipment,
        'in_production', l.in_production,
        'ready_unshipped', l.ready_unshipped,
        'unshipped', l.unshipped
      ) ORDER BY l.order_item_id)
      FROM private.order_line_fulfillment(_order_id) AS l
    ), '[]'::jsonb),
    'fulfillments', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'fulfillment_id', f.id,
        'number', f.number,
        'shipping_carrier', f.shipping_carrier,
        'shipped_at', f.shipped_at,
        'cancelled_at', f.cancelled_at,
        'lines', COALESCE((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'order_item_id', fl.order_item_id, 'quantity', fl.quantity
          ) ORDER BY fl.order_item_id)
          FROM public.order_fulfillment_lines AS fl
          WHERE fl.fulfillment_id = f.id
        ), '[]'::jsonb)
      ) ORDER BY f.number)
      FROM public.order_fulfillments AS f
      WHERE f.order_id = _order_id
    ), '[]'::jsonb),
    'delivery_detail', pg_catalog.jsonb_build_object(
      'enabled', COALESCE((
        SELECT s.delivery_tracking_enabled FROM public.shop_settings AS s WHERE s.id = 1
      ), false),
      'fulfillments', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'fulfillment_id', f.id,
          'cancelled_at', f.cancelled_at,
          'tracking_version', f.tracking_version,
          'delivery_status', f.delivery_status,
          'delivery_status_at', f.delivery_status_at,
          'delivered_at', f.delivered_at,
          'registration', (
            SELECT pg_catalog.jsonb_build_object('state', r.state, 'ever_registered', r.ever_registered)
            FROM private.fulfillment_tracking_registrations AS r
            WHERE r.fulfillment_id = private.tracking_registration_owner(f.id, f.tracking_version)
              AND r.tracking_version = f.tracking_version
          ),
          'events', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'tracking_version', e.tracking_version,
              'status', e.status,
              'happened_at', e.happened_at,
              'recorded_at', e.recorded_at
            ) ORDER BY e.happened_at DESC, e.recorded_at DESC, e.id)
            FROM public.order_fulfillment_events AS e
            WHERE e.fulfillment_id = f.id
              AND e.tracking_version = f.tracking_version
          ), '[]'::jsonb)
        ) ORDER BY f.number)
        FROM public.order_fulfillments AS f
        WHERE f.order_id = _order_id
      ), '[]'::jsonb)
    ),
    'delivery_summary', (
      SELECT pg_catalog.jsonb_build_object(
        'active_count', (pg_catalog.count(*) FILTER (WHERE f.cancelled_at IS NULL))::integer,
        'delivered_count', (pg_catalog.count(*) FILTER (WHERE f.cancelled_at IS NULL AND f.delivered_at IS NOT NULL))::integer
      )
      FROM public.order_fulfillments AS f
      WHERE f.order_id = _order_id
    ),
    'refund_rows', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'refund_id', r.id, 'created_at', r.created_at, 'amount', r.amount, 'status', r.status
      ) ORDER BY r.created_at DESC, r.id DESC)
      FROM public.order_refunds AS r
      WHERE r.order_id = _order_id
    ), '[]'::jsonb),
    'discounts', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', x.value->>'name', 'amount', (x.value->>'amount')::integer)
        ORDER BY x.ordinality)
      FROM pg_catalog.jsonb_array_elements(private.order_discount_breakdown(_order_id)->'rows') WITH ORDINALITY AS x(value, ordinality)
    ), '[]'::jsonb)
  );
END;
$$;

-- Replacement 2 of 2: the admin order detail keeps its H4 body and gains the full breakdown (orders.read only).
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
    'discounts',COALESCE(private.order_discount_breakdown(_order_id)->'rows','[]'::jsonb),
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

ALTER FUNCTION private.order_discount_breakdown(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.order_discount_breakdown(uuid) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.get_order_discount_breakdown(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_order_discount_breakdown(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_order_discount_breakdown(uuid) TO service_role;
ALTER FUNCTION public.get_order_discount_breakdown(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_order_discount_breakdown(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_discount_breakdown(uuid) TO service_role;
ALTER FUNCTION public.get_order_status_public_material(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_order_status_public_material(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_order_status_public_material(uuid) TO service_role;
ALTER FUNCTION private.get_admin_order_detail(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_admin_order_detail(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_admin_order_detail(uuid,uuid) TO service_role;
-- H6_BODY_END

-- H6_FINAL_ASSERT_BEGIN
DO $h6_final$
DECLARE
  e record; p record; w record; v_oid oid; v_detail text; v_src text;
BEGIN
  FOR e IN SELECT * FROM (VALUES
    ('private.order_discount_breakdown(uuid)','plpgsql','s',false,'_order_id','h6_order_breakdown','e5eaa9dc30fb4f7ab214050e4a41c31d'),
    ('private.get_order_discount_breakdown(uuid)','plpgsql','s',true,'_order_id','h6_order_breakdown','6057c9ad00813f80e31795009fd344ef'),
    ('public.get_order_status_public_material(uuid)','plpgsql','s',true,'_order_id','h6_customer_projection','740b103de460889605723dff0a5d089f'),
    ('private.get_admin_order_detail(uuid,uuid)','plpgsql','s',true,'_order_id,_actor_id','h6_admin_projection','923e2a01caeff25f265cc251a1956082')
  ) AS expected(signature,language,volatility,service,arg_names,detail,body_md5) LOOP
    v_detail:=e.detail;
    v_oid:=pg_catalog.to_regprocedure(e.signature);
    SELECT f.*,l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
    IF v_oid IS NULL OR NOT FOUND OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR p.prorettype<>'jsonb'::regtype OR p.proretset OR p.prokind<>'f' OR p.provolatile<>e.volatility::"char"
      OR p.lanname<>e.language OR p.proisstrict OR p.proleakproof OR p.proparallel<>'u' OR p.pronargdefaults<>0
      OR COALESCE(pg_catalog.array_to_string(p.proargnames,','),'')<>e.arg_names
      OR pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5 THEN
      RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
    END IF;
    v_detail:='h6_public_acl';
    IF pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
      OR pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')<>e.service
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f WHERE f.pronamespace=p.pronamespace AND f.proname=p.proname)<>1 THEN
      RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
    END IF;
  END LOOP;

  -- The public entry of the full breakdown is a SECURITY INVOKER SQL delegate with the same name and arguments.
  v_detail:='h6_public_acl';
  v_oid:=pg_catalog.to_regprocedure('public.get_order_discount_breakdown(uuid)');
  SELECT f.*,l.lanname INTO w FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid=f.prolang WHERE f.oid=v_oid;
  SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid='private.get_order_discount_breakdown(uuid)'::regprocedure;
  IF v_oid IS NULL OR w.proowner<>'postgres'::regrole OR w.prosecdef OR w.lanname<>'sql'
    OR w.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
    OR w.prorettype<>p.prorettype OR w.proretset OR w.prokind<>'f' OR w.provolatile<>p.provolatile
    OR w.proisstrict OR w.proleakproof OR w.proparallel<>'u' OR w.pronargdefaults<>0
    OR w.proargnames IS DISTINCT FROM p.proargnames OR w.proargtypes IS DISTINCT FROM p.proargtypes
    OR pg_catalog.regexp_replace(pg_catalog.lower(w.prosrc),'[[:space:];]','','g')<>'selectprivate.get_order_discount_breakdown(_order_id)'
    OR NOT pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')
    OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(w.proacl,pg_catalog.acldefault('f',w.proowner))) AS a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f
      WHERE f.pronamespace='public'::regnamespace AND f.proname='get_order_discount_breakdown')<>1 THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
  END IF;
  -- No public copy of the internal helper, no private copy of the public material, and no extra overloads.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid=f.pronamespace
      WHERE (n.nspname='public' AND f.proname='order_discount_breakdown')
         OR (n.nspname='private' AND f.proname='get_order_status_public_material')) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
  END IF;

  -- The two replaced readers keep every attribute and the service-role ACL they had before H6.
  v_detail:='h6_customer_projection';
  IF NOT EXISTS (SELECT 1 FROM pg_temp.h6_function_baseline AS b JOIN pg_catalog.pg_proc AS f ON f.oid=b.oid
      WHERE b.oid='public.get_order_status_public_material(uuid)'::regprocedure
        AND (f.prorettype,f.proretset,f.proowner,f.prosecdef,f.provolatile,f.proconfig,f.proargnames,f.proargtypes,f.pronargdefaults)
          IS NOT DISTINCT FROM (b.prorettype,b.proretset,b.proowner,b.prosecdef,b.provolatile,b.proconfig,b.proargnames,b.proargtypes,b.pronargdefaults)
        AND pg_catalog.has_function_privilege('service_role',f.oid,'EXECUTE') IS NOT DISTINCT FROM b.service) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
  END IF;
  SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid='public.get_order_status_public_material(uuid)'::regprocedure;
  -- Public projection: names and amounts through the internal helper only; no code, discount id, allocation or identity column.
  IF pg_catalog.strpos(v_src,'private.order_discount_breakdown(')=0 OR pg_catalog.strpos(v_src,$q$'discounts'$q$)=0
    OR v_src ~* '(code_snapshot|discount_redemptions|order_line_discount_allocations|lineAllocations|discountId|identity_key|normalized_email|attention_)' THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
  END IF;

  v_detail:='h6_admin_projection';
  IF NOT EXISTS (SELECT 1 FROM pg_temp.h6_function_baseline AS b JOIN pg_catalog.pg_proc AS f ON f.oid=b.oid
      WHERE b.oid='private.get_admin_order_detail(uuid,uuid)'::regprocedure
        AND (f.prorettype,f.proretset,f.proowner,f.prosecdef,f.provolatile,f.proconfig,f.proargnames,f.proargtypes,f.pronargdefaults)
          IS NOT DISTINCT FROM (b.prorettype,b.proretset,b.proowner,b.prosecdef,b.provolatile,b.proconfig,b.proargnames,b.proargtypes,b.pronargdefaults)
        AND pg_catalog.has_function_privilege('service_role',f.oid,'EXECUTE') IS NOT DISTINCT FROM b.service) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
  END IF;
  SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid='private.get_admin_order_detail(uuid,uuid)'::regprocedure;
  -- Admin reads the breakdown with orders.read only (not the discounts settings permissions).
  IF pg_catalog.strpos(v_src,'private.order_discount_breakdown(')=0 OR pg_catalog.strpos(v_src,$q$ARRAY['admin.orders.read']$q$)=0
    OR v_src ~* 'admin\.discounts\.' THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
  END IF;

  -- Existing frozen data: the positive redemptions of an order add up to the order's discount_amount.
  v_detail:='h6_order_breakdown';
  IF EXISTS (SELECT 1 FROM public.orders AS o
      JOIN (SELECT r.order_id,pg_catalog.sum(r.amount)::bigint AS total FROM public.discount_redemptions AS r GROUP BY r.order_id) AS s ON s.order_id=o.id
      WHERE s.total>0 AND s.total<>o.discount_amount::bigint) THEN
    RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='GROUP_H_MIGRATION_ASSERTION_FAILED' AND SQLSTATE='P0001' THEN RAISE; END IF;
  RAISE EXCEPTION 'GROUP_H_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=COALESCE(v_detail,'h6_order_breakdown'),
    HINT='sqlstate='||SQLSTATE;
END;
$h6_final$;
-- H6_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
