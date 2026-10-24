-- G-2 foundation (Task 1): the stock window switches to stock permissions, two G-1 follow-ups,
-- and the anon / authenticated EXECUTE revoke on 11 public functions (FREQ-540-AC-06, AC-09).
-- Later G-2 tasks extend the body section of this file. Applied G-1 SQL is never edited.
BEGIN;

-- G2A_BODY_BEGIN

-- 1. One permission check for every G-2 DB function. The actor holds all of _codes when the UNION of the
--    permissions of every active (and unexpired) role of the actor contains each code, the same meaning as
--    authorizeAdminPermissions in src/lib/auth/admin-rbac.ts. One role does not have to hold them all.
--    NULL actor / NULL or empty array / a NULL element / an unregistered code => false.
--    Internal helper: no EXECUTE for anyone but the owner (callers are SECURITY DEFINER bodies owned by postgres).
CREATE FUNCTION private.group_g_actor_has_permissions(_actor_id uuid, _codes text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN _actor_id IS NULL OR _codes IS NULL OR pg_catalog.cardinality(_codes) = 0 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM (SELECT DISTINCT c.code FROM pg_catalog.unnest(_codes) AS c(code)) AS wanted
      WHERE wanted.code IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.user_roles AS ur
        JOIN public.roles AS r ON r.id = ur.role_id
        JOIN public.role_permissions AS rp ON rp.role_id = r.id
        JOIN public.permissions AS p ON p.id = rp.permission_id
        WHERE ur.user_id = _actor_id AND ur.active
          AND (ur.expires_at IS NULL OR ur.expires_at > pg_catalog.now())
          AND p.code = wanted.code))
  END;
$$;
ALTER FUNCTION private.group_g_actor_has_permissions(uuid,text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_actor_has_permissions(uuid,text[]) FROM PUBLIC, anon, authenticated, service_role;

-- 2. Ids (ascending) of the orders that can still have production (waiting) units for the variants. NULL = every
--    variant. It is a pre-filter for group_g_item_state_ranges (the read-side projection), so it must be a SUPERSET of
--    every order the projection can count as in_production; it only drops orders that can never yield one:
--      - payment_in_progress / abandoned: the projection hides them.
--      - shipped: kept when the projection can still count an unshipped, uncancelled unit, i.e. some item has
--        quantity > non-cancelled shipped quantity + before-shipment refund quantity (refund status awaiting_response /
--        pending / succeeded) - the projection's own "remaining > cancelled" condition, so a shipped order with no
--        shipment records is kept as G-1 counts it - or when it has an unresolved return (requested/open), refund
--        (awaiting_response / pending / error), cancel request (requested) or a failed / error pre-shipment refund
--        (the pre-filter of allocate_group_g_fifo's waiting_orders, G-1). A fully shipped order with nothing open is dropped.
--      - paid: always.
--      - any other status (pending, failed, cancelled): the projection counts an order as paid when status is paid /
--        shipped, paid_at is set, paid_amount > 0, a unit is shipped or a paid allocation remains. A cancelled order
--        with no shipment and no paid allocation has every unit cancelled (G-1 rule), so paid_at / paid_amount alone do
--        not keep it. Unpaid pending / failed orders with no shipment and no paid allocation have no waiting units.
--        Known cost: a cancelled order that has a shipment or a paid allocation stays in the pre-filter even when the
--        projection ends up counting nothing for it (the pre-filter stays a superset; the projection decides).
--    lock_group_g_inventory is deliberately unchanged. Its closure does not take cancelled, abandoned, expired-failed
--    or fully shipped orders without open work, UNLESS they still hold a remaining paid allocation or payment hold on a
--    target variant (G-1 takes any order holding one, whatever its status), and it does take pending / payment_in_progress /
--    non-expired failed orders (they may hold H or be paid late);
--    tests/integration/db/group_g2_g1_followups.integration.test.ts pins both.
CREATE FUNCTION private.group_g_open_work_order_ids(_variant_ids bigint[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.array_agg(o.id ORDER BY o.id), ARRAY[]::uuid[])
  FROM public.orders AS o
  WHERE o.status NOT IN ('payment_in_progress', 'abandoned')
    AND EXISTS (SELECT 1 FROM public.order_items AS oi
      WHERE oi.order_id = o.id AND oi.variant_id IS NOT NULL
        AND (_variant_ids IS NULL OR oi.variant_id = ANY(_variant_ids)))
    AND (o.status = 'paid'
      OR (o.status = 'shipped' AND (
        EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.order_id = o.id AND r.status IN ('requested', 'open'))
        OR EXISTS (SELECT 1 FROM public.order_refunds AS r WHERE r.order_id = o.id AND r.status IN ('awaiting_response', 'pending', 'error'))
        OR EXISTS (SELECT 1 FROM public.order_cancel_requests AS r WHERE r.order_id = o.id AND r.status = 'requested')
        OR EXISTS (SELECT 1 FROM public.order_refund_lines AS rl JOIN public.order_refunds AS r ON r.id = rl.refund_id
          WHERE r.order_id = o.id AND rl.before_shipment AND r.status IN ('error', 'failed'))
        OR EXISTS (SELECT 1 FROM public.order_items AS oi
          WHERE oi.order_id = o.id
            AND oi.quantity > COALESCE((SELECT pg_catalog.sum(fl.quantity) FROM public.order_fulfillment_lines AS fl
                JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id AND f.cancelled_at IS NULL
                WHERE fl.order_item_id = oi.id), 0)
              + COALESCE((SELECT pg_catalog.sum(rl.quantity) FROM public.order_refund_lines AS rl
                JOIN public.order_refunds AS r ON r.id = rl.refund_id AND r.status IN ('awaiting_response', 'pending', 'succeeded')
                WHERE rl.order_item_id = oi.id AND rl.before_shipment), 0))))
      OR (o.status NOT IN ('paid', 'shipped') AND (
        (o.status <> 'cancelled' AND (o.paid_at IS NOT NULL OR COALESCE(o.paid_amount, 0) > 0))
        OR EXISTS (SELECT 1 FROM public.order_items AS oi
          JOIN public.order_item_allocations AS a ON a.order_item_id = oi.id
          WHERE oi.order_id = o.id AND a.kind = 'paid' AND a.remaining_quantity > 0)
        OR EXISTS (SELECT 1 FROM public.order_items AS oi
          JOIN public.order_fulfillment_lines AS fl ON fl.order_item_id = oi.id
          JOIN public.order_fulfillments AS f ON f.id = fl.fulfillment_id AND f.cancelled_at IS NULL
          WHERE oi.order_id = o.id))));
$$;
ALTER FUNCTION private.group_g_open_work_order_ids(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_g_open_work_order_ids(bigint[]) FROM PUBLIC, anon, authenticated, service_role;

-- 3. Stock entry: the permission check is the only change from G-1 (admin.items.manage -> admin.stock.manage + admin.stock.read).
--    Replaces 20261023211425_group_g1_allocation.sql:1734. Signature, owner, ACL and return type are unchanged.
CREATE OR REPLACE FUNCTION private.admin_record_stock_movement(_item_id bigint, _variant_id bigint, _delta integer, _reason text,
  _note text, _actor_id uuid, _request_key uuid, _expected_release_quantity integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_orders uuid[];
  v_before jsonb;
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_previous_operation text := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_note text := NULLIF(pg_catalog.regexp_replace(_note, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  v_fingerprint text;
  v_existing private.group_g_operations%ROWTYPE;
  v_free integer;
  v_paid integer;
  v_allocation record;
  v_release integer := 0;
  v_remaining integer;
  v_quantity integer;
  v_release_movement bigint;
  v_movement bigint;
  v_allocated integer;
  v_result jsonb;
BEGIN
  IF _item_id IS NULL OR _variant_id IS NULL OR _item_id <= 0 OR _variant_id <= 0 OR _delta IS NULL OR _delta = 0
    OR _reason IS NULL OR _reason NOT IN ('restock', 'adjustment') OR (_reason = 'restock' AND _delta < 0)
    OR _actor_id IS NULL OR _request_key IS NULL OR pg_catalog.length(v_note) > 200
    OR _expected_release_quantity < 0 THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_orders := private.lock_group_g_inventory(ARRAY[_variant_id], ARRAY[]::uuid[], NULL);
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.stock.manage', 'admin.stock.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'stock_move', 'item_id', _item_id, 'variant_ids', ARRAY[_variant_id], 'delta', _delta,
    'reason', _reason, 'note', v_note, 'actor_id', _actor_id, 'expected_release_quantity', _expected_release_quantity)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op WHERE op.operation = 'stock_move' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.item_variants AS v WHERE v.id = _variant_id AND v.item_id = _item_id) THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- F and the releasable A are read directly under the lock (no projection of historical orders).
  -- Only allocations of locked orders count, so the release loop below never touches an unlocked order.
  SELECT v.stock_quantity INTO v_free FROM public.item_variants AS v WHERE v.id = _variant_id;
  SELECT COALESCE(pg_catalog.sum(a.remaining_quantity), 0)::integer INTO v_paid
  FROM public.order_item_allocations AS a JOIN public.order_items AS oi ON oi.id = a.order_item_id
  WHERE a.variant_id = _variant_id AND a.kind = 'paid' AND a.remaining_quantity > 0 AND oi.order_id = ANY(v_orders);
  IF _delta < 0 THEN
    IF -_delta::bigint > v_free::bigint + v_paid THEN
      RAISE EXCEPTION 'GROUP_G_STOCK_INSUFFICIENT' USING ERRCODE = '23514';
    END IF;
    v_release := GREATEST(-_delta::bigint - v_free, 0)::integer;
    IF (v_release > 0 AND _expected_release_quantity IS NULL)
      OR (_expected_release_quantity IS NOT NULL AND _expected_release_quantity <> v_release) THEN
      RAISE EXCEPTION 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED' USING ERRCODE = '55000',
        DETAIL = pg_catalog.jsonb_build_object('releasedQuantity', v_release)::text;
    END IF;
    IF v_release > 0 AND v_note IS NULL THEN
      RAISE EXCEPTION 'GROUP_G_STOCK_RELEASE_REASON_REQUIRED' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_before := private.capture_group_g_item_states(v_orders);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
  v_remaining := v_release;
  FOR v_allocation IN
    SELECT a.id, a.remaining_quantity, a.order_item_id, oi.order_id
    FROM public.order_item_allocations AS a JOIN public.order_items AS oi ON oi.id = a.order_item_id
    JOIN public.orders AS o ON o.id = oi.order_id
    WHERE a.variant_id = _variant_id AND a.kind = 'paid' AND a.remaining_quantity > 0 AND oi.order_id = ANY(v_orders)
    ORDER BY o.created_at DESC, o.id DESC, oi.id DESC, a.id DESC
  LOOP
    EXIT WHEN v_remaining = 0;
    v_quantity := LEAST(v_remaining, v_allocation.remaining_quantity);
    UPDATE public.order_item_allocations AS a SET remaining_quantity = a.remaining_quantity - v_quantity, version = a.version + 1
      WHERE a.id = v_allocation.id;
    INSERT INTO public.stock_movements(variant_id, delta, reason, note, order_id, order_item_id, allocation_operation_id, created_by)
      VALUES(_variant_id, v_quantity, 'allocation_release', v_note, v_allocation.order_id, v_allocation.order_item_id, v_operation, _actor_id)
      RETURNING id INTO v_release_movement;
    INSERT INTO public.order_item_allocation_events(allocation_id, event_type, quantity, operation_id, sequence, stock_movement_id, reason, actor_id)
      VALUES(v_allocation.id, 'release', v_quantity, v_operation, 1, v_release_movement, 'stock_adjustment', _actor_id);
    v_remaining := v_remaining - v_quantity;
  END LOOP;
  INSERT INTO public.stock_movements(variant_id, delta, reason, note, created_by)
    VALUES(_variant_id, _delta, _reason, v_note, _actor_id) RETURNING id INTO v_movement;
  v_allocated := private.allocate_group_g_fifo(ARRAY[_variant_id], v_operation, _actor_id);
  PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'stock_move', _actor_id);
  v_result := pg_catalog.jsonb_build_object('movementId', v_movement::text, 'releasedQuantity', v_release,
    'allocatedQuantity', v_allocated, 'replayed', false);
  INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
    VALUES(v_operation, 'stock_move', _request_key, v_fingerprint, 'variant', _variant_id::text, _actor_id, v_result);
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('app.group_g_operation_id', COALESCE(v_previous_operation, ''), true);
  RAISE;
END;
$$;

-- 4. Inventory read: "production" (waiting) is computed only over the orders that can still have production units
--    (the superset pre-filter of section 2), not over every order that ever held the variant. The result (waiting) is
--    the same as the unfiltered projection, because the pre-filter keeps every order the projection can count;
--    tests/integration/db/group_g2_g1_followups.integration.test.ts compares the two per variant.
--    Replaces 20261023211425_group_g1_allocation.sql:1565. Signature, owner, ACL and return type are unchanged.
CREATE OR REPLACE FUNCTION private.list_group_g_variant_inventory(_variant_ids bigint[])
RETURNS TABLE(variant_id bigint, free integer, paid_allocated integer, payment_held integer, on_hand integer, waiting integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _variant_ids IS NULL OR pg_catalog.cardinality(_variant_ids) = 0 THEN RETURN; END IF;
  IF pg_catalog.cardinality(_variant_ids) > 500 THEN
    RAISE EXCEPTION 'TOO_MANY_VARIANTS' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH wanted AS MATERIALIZED (
    SELECT v.id, v.stock_quantity FROM public.item_variants AS v WHERE v.id = ANY(_variant_ids)
  ), allocations AS (
    SELECT a.variant_id,
      COALESCE(pg_catalog.sum(a.remaining_quantity) FILTER (WHERE a.kind = 'paid'), 0)::integer AS paid,
      COALESCE(pg_catalog.sum(a.remaining_quantity) FILTER (WHERE a.kind = 'payment_hold'), 0)::integer AS held
    FROM public.order_item_allocations AS a WHERE a.variant_id IN (SELECT w.id FROM wanted AS w)
    GROUP BY a.variant_id
  ), production AS (
    SELECT oi.variant_id, pg_catalog.sum(s.unit_to - s.unit_from)::integer AS quantity
    FROM private.group_g_item_state_ranges(
      private.group_g_open_work_order_ids(ARRAY(SELECT w.id FROM wanted AS w))
    ) AS s JOIN public.order_items AS oi ON oi.id = s.order_item_id
    WHERE s.status = 'in_production' GROUP BY oi.variant_id
  )
  SELECT w.id, w.stock_quantity, COALESCE(a.paid, 0), COALESCE(a.held, 0),
    w.stock_quantity + COALESCE(a.paid, 0) + COALESCE(a.held, 0), COALESCE(p.quantity, 0)
  FROM wanted AS w LEFT JOIN allocations AS a ON a.variant_id = w.id
  LEFT JOIN production AS p ON p.variant_id = w.id ORDER BY w.id;
END;
$$;

-- 5. orders.paid_at: the first value (NULL -> value) may only be written while this connection holds the common
--    advisory (190521,1), the same pg_locks check as allocate_group_g_fifo. value -> another value / NULL stays
--    GROUP_G_PAID_AT_IMMUTABLE. Replaces 20261023211425_group_g1_allocation.sql:2797 (INVOKER, search_path empty).
CREATE OR REPLACE FUNCTION private.guard_group_g_paid_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at THEN
    RAISE EXCEPTION 'GROUP_G_PAID_AT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks AS l
    WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'advisory'
      AND l.classid = 190521 AND l.objid = 1 AND l.objsubid = 2
      AND l.mode = 'ExclusiveLock' AND l.granted
  ) THEN
    RAISE EXCEPTION 'GROUP_G_INVENTORY_LOCK_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- 6. Security (FREQ-540-AC-09): the base migration (20260901102912_remote_schema.sql:3926-4010) only revoked
--    PUBLIC and granted postgres + service_role, so the Supabase default privileges left anon / authenticated able
--    to EXECUTE these 11 SECURITY DEFINER functions in a database built from migrations (an anon caller could
--    revoke other users' sessions). Production already has only postgres + service_role, so nothing changes there.
--    No GRANT: service_role and postgres keep EXECUTE. The two trigger functions are only checked at CREATE TRIGGER.
REVOKE EXECUTE ON FUNCTION
  public.cleanup_password_reset_tokens(integer),
  public.clear_admin_expense_cost_allocations(bigint),
  public.create_profile_for_new_auth_user(),
  public.find_auth_user_id_by_email(text),
  public.increment_rate_limit_counter(inet,text,timestamp with time zone,integer),
  public.increment_rate_limit_counter(inet,text,timestamp with time zone),
  public.is_auth_session_active(uuid),
  public.record_admin_finance_entry_revision(),
  public.replace_admin_expense_cost_allocations(bigint,jsonb,uuid),
  public.revoke_auth_session(uuid),
  public.revoke_auth_sessions_for_user(uuid)
FROM PUBLIC, anon, authenticated;

-- G2A_BODY_END

-- G2A_FINAL_ASSERT_BEGIN
-- Task 1 expectation: each of the 11 functions exists, anon / authenticated / PUBLIC cannot EXECUTE it (PUBLIC is read
-- from the effective ACL, where a NULL proacl means the default that includes PUBLIC) and service_role can.
DO $g2a_final_public_function_acl$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.cleanup_password_reset_tokens(integer)'),
      ('public.clear_admin_expense_cost_allocations(bigint)'),
      ('public.create_profile_for_new_auth_user()'),
      ('public.find_auth_user_id_by_email(text)'),
      ('public.increment_rate_limit_counter(inet,text,timestamp with time zone,integer)'),
      ('public.increment_rate_limit_counter(inet,text,timestamp with time zone)'),
      ('public.is_auth_session_active(uuid)'),
      ('public.record_admin_finance_entry_revision()'),
      ('public.replace_admin_expense_cost_allocations(bigint,jsonb,uuid)'),
      ('public.revoke_auth_session(uuid)'),
      ('public.revoke_auth_sessions_for_user(uuid)')
    ) AS e(sig)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    WHERE p.oid IS NULL
       OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x
                  WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'public_function_acl';
  END IF;
END;
$g2a_final_public_function_acl$;
-- G2A_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
