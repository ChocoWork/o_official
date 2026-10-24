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

-- 7. Purchase orders (G-2 Task 2, FREQ-530): nine public tables, owner postgres, uuid primary keys. This file only creates
--    them, it writes no data. Rows are written by the SECURITY DEFINER functions of later Tasks, which take the common
--    advisory (190521,1) first. Actor columns (created_by, actor_id, uploaded_by) are plain uuid without a foreign key, so
--    deleting a user never updates an append-only history. Every foreign key is ON DELETE RESTRICT; the ones to
--    private.group_g_operations are DEFERRABLE INITIALLY DEFERRED (the operation row is written last in a transaction).
CREATE TABLE public.purchase_orders (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  number text NOT NULL,
  supplier_name text NOT NULL,
  memo text,
  stage text NOT NULL DEFAULT 'ordered',
  version integer NOT NULL DEFAULT 1,
  ordered_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_orders_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_orders_number_key UNIQUE (number),
  CONSTRAINT purchase_orders_number_check CHECK (number ~ '^PO-[0-9]{8}-[0-9]{4}$'),
  CONSTRAINT purchase_orders_supplier_name_check CHECK (pg_catalog.char_length(supplier_name) BETWEEN 1 AND 100),
  CONSTRAINT purchase_orders_memo_check CHECK (memo IS NULL OR pg_catalog.char_length(memo) <= 500),
  CONSTRAINT purchase_orders_stage_check CHECK (stage IN ('ordered', 'quantity_confirmed')),
  CONSTRAINT purchase_orders_version_check CHECK (version >= 1)
);
ALTER TABLE public.purchase_orders OWNER TO postgres;

-- line_no is the input order (lists and details sort by it). item_name / color_name / size_label are copies taken when
-- the order is placed. unit_price_yen NULL means "not registered", 0 means 0 yen. confirmed_quantity NULL means "not
-- confirmed yet"; outstanding_quantity is NULL until it is confirmed.
CREATE TABLE public.purchase_order_lines (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  purchase_order_id uuid NOT NULL,
  line_no integer NOT NULL,
  variant_id bigint NOT NULL,
  item_name text NOT NULL,
  color_name text,
  size_label text,
  provisional_quantity integer NOT NULL,
  confirmed_quantity integer,
  received_quantity integer NOT NULL DEFAULT 0,
  unit_price_yen integer,
  outstanding_quantity integer GENERATED ALWAYS AS (confirmed_quantity - received_quantity) STORED,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_order_lines_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_order_lines_purchase_order_id_fkey FOREIGN KEY (purchase_order_id)
    REFERENCES public.purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_lines_variant_id_fkey FOREIGN KEY (variant_id)
    REFERENCES public.item_variants (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_lines_order_variant_key UNIQUE (purchase_order_id, variant_id),
  CONSTRAINT purchase_order_lines_order_line_no_key UNIQUE (purchase_order_id, line_no),
  CONSTRAINT purchase_order_lines_line_no_check CHECK (line_no >= 1),
  CONSTRAINT purchase_order_lines_provisional_quantity_check CHECK (provisional_quantity BETWEEN 1 AND 99999),
  CONSTRAINT purchase_order_lines_confirmed_quantity_check CHECK (confirmed_quantity IS NULL OR confirmed_quantity BETWEEN 0 AND 99999),
  CONSTRAINT purchase_order_lines_received_quantity_check CHECK (received_quantity >= 0),
  CONSTRAINT purchase_order_lines_unit_price_yen_check CHECK (unit_price_yen IS NULL OR unit_price_yen BETWEEN 0 AND 9999999),
  CONSTRAINT purchase_order_lines_version_check CHECK (version >= 1),
  CONSTRAINT purchase_order_lines_confirmed_received_check CHECK (confirmed_quantity IS NULL OR confirmed_quantity >= received_quantity),
  CONSTRAINT purchase_order_lines_unconfirmed_received_check CHECK (confirmed_quantity IS NOT NULL OR received_quantity = 0)
);
ALTER TABLE public.purchase_order_lines OWNER TO postgres;
CREATE INDEX purchase_order_lines_variant_outstanding_idx
  ON public.purchase_order_lines (variant_id) WHERE outstanding_quantity > 0;

-- One row per changed line (or per order when line_id is NULL). revision_no is the version of the order after the operation.
CREATE TABLE public.purchase_order_revisions (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  purchase_order_id uuid NOT NULL,
  line_id uuid,
  revision_no integer NOT NULL,
  kind text NOT NULL,
  before_quantity integer,
  after_quantity integer,
  before_unit_price_yen integer,
  after_unit_price_yen integer,
  before_supplier_name text,
  after_supplier_name text,
  before_memo text,
  after_memo text,
  reason text,
  actor_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_order_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_order_revisions_purchase_order_id_fkey FOREIGN KEY (purchase_order_id)
    REFERENCES public.purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_revisions_line_id_fkey FOREIGN KEY (line_id)
    REFERENCES public.purchase_order_lines (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_revisions_operation_id_fkey FOREIGN KEY (operation_id)
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT purchase_order_revisions_revision_key UNIQUE NULLS NOT DISTINCT (purchase_order_id, revision_no, line_id, kind),
  CONSTRAINT purchase_order_revisions_revision_no_check CHECK (revision_no >= 1),
  CONSTRAINT purchase_order_revisions_kind_check CHECK (kind IN ('order', 'header', 'quantity', 'short_close')),
  CONSTRAINT purchase_order_revisions_quantity_check CHECK (
    (before_quantity IS NULL OR before_quantity BETWEEN 0 AND 99999) AND (after_quantity IS NULL OR after_quantity BETWEEN 0 AND 99999)),
  CONSTRAINT purchase_order_revisions_unit_price_check CHECK (
    (before_unit_price_yen IS NULL OR before_unit_price_yen BETWEEN 0 AND 9999999)
    AND (after_unit_price_yen IS NULL OR after_unit_price_yen BETWEEN 0 AND 9999999)),
  CONSTRAINT purchase_order_revisions_text_check CHECK (
    (before_supplier_name IS NULL OR pg_catalog.char_length(before_supplier_name) BETWEEN 1 AND 100)
    AND (after_supplier_name IS NULL OR pg_catalog.char_length(after_supplier_name) BETWEEN 1 AND 100)
    AND (before_memo IS NULL OR pg_catalog.char_length(before_memo) <= 500)
    AND (after_memo IS NULL OR pg_catalog.char_length(after_memo) <= 500)),
  CONSTRAINT purchase_order_revisions_reason_check CHECK (reason IS NULL OR pg_catalog.char_length(reason) BETWEEN 1 AND 200)
);
ALTER TABLE public.purchase_order_revisions OWNER TO postgres;

-- closed_quantity is the outstanding quantity that was given up; the revision row (kind short_close) holds the new confirmed quantity.
CREATE TABLE public.purchase_order_short_closures (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  line_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  closed_quantity integer NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_order_short_closures_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_order_short_closures_line_id_fkey FOREIGN KEY (line_id)
    REFERENCES public.purchase_order_lines (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_short_closures_revision_id_fkey FOREIGN KEY (revision_id)
    REFERENCES public.purchase_order_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_short_closures_revision_id_key UNIQUE (revision_id),
  CONSTRAINT purchase_order_short_closures_closed_quantity_check CHECK (closed_quantity > 0),
  CONSTRAINT purchase_order_short_closures_reason_check CHECK (pg_catalog.char_length(reason) BETWEEN 1 AND 200)
);
ALTER TABLE public.purchase_order_short_closures OWNER TO postgres;

-- kind reverse is an offsetting receipt (a cancelled receipt or a quantity correction); it always carries a reason.
CREATE TABLE public.purchase_order_receipts (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  purchase_order_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'receive',
  received_on date NOT NULL,
  memo text,
  reason text,
  actor_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_order_receipts_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_order_receipts_purchase_order_id_fkey FOREIGN KEY (purchase_order_id)
    REFERENCES public.purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_receipts_operation_id_fkey FOREIGN KEY (operation_id)
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT purchase_order_receipts_kind_check CHECK (kind IN ('receive', 'reverse')),
  CONSTRAINT purchase_order_receipts_memo_check CHECK (memo IS NULL OR pg_catalog.char_length(memo) <= 200),
  CONSTRAINT purchase_order_receipts_reason_check CHECK (reason IS NULL OR pg_catalog.char_length(reason) BETWEEN 1 AND 200),
  CONSTRAINT purchase_order_receipts_kind_reason_check CHECK ((kind = 'reverse') = (reason IS NOT NULL))
);
ALTER TABLE public.purchase_order_receipts OWNER TO postgres;

-- quantity > 0 is a receipt of good units, quantity < 0 offsets an earlier positive row (reverses_receipt_line_id).
-- Every row ties to exactly one untagged stock_movements row (stock_movement_id UNIQUE).
CREATE TABLE public.purchase_order_receipt_lines (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  receipt_id uuid NOT NULL,
  line_id uuid NOT NULL,
  quantity integer NOT NULL,
  reverses_receipt_line_id uuid,
  stock_movement_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_order_receipt_lines_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_order_receipt_lines_receipt_id_fkey FOREIGN KEY (receipt_id)
    REFERENCES public.purchase_order_receipts (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_receipt_lines_line_id_fkey FOREIGN KEY (line_id)
    REFERENCES public.purchase_order_lines (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_receipt_lines_reverses_receipt_line_id_fkey FOREIGN KEY (reverses_receipt_line_id)
    REFERENCES public.purchase_order_receipt_lines (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_receipt_lines_stock_movement_id_fkey FOREIGN KEY (stock_movement_id)
    REFERENCES public.stock_movements (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_receipt_lines_stock_movement_id_key UNIQUE (stock_movement_id),
  CONSTRAINT purchase_order_receipt_lines_receipt_line_key UNIQUE (receipt_id, line_id),
  CONSTRAINT purchase_order_receipt_lines_quantity_check CHECK (quantity <> 0 AND quantity BETWEEN -99999 AND 99999),
  CONSTRAINT purchase_order_receipt_lines_reverses_check CHECK ((quantity < 0) = (reverses_receipt_line_id IS NOT NULL))
);
ALTER TABLE public.purchase_order_receipt_lines OWNER TO postgres;
CREATE INDEX purchase_order_receipt_lines_line_idx ON public.purchase_order_receipt_lines (line_id);
CREATE INDEX purchase_order_receipt_lines_reverses_idx
  ON public.purchase_order_receipt_lines (reverses_receipt_line_id) WHERE reverses_receipt_line_id IS NOT NULL;

-- A reservation is the promise of one storage key for one upload. Whether it was used is decided by the attachment that
-- points at it (reservation_id), so the reservation row is never changed.
CREATE TABLE public.purchase_order_attachment_reservations (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  purchase_order_id uuid NOT NULL,
  kind text NOT NULL,
  original_file_name text NOT NULL,
  storage_path text NOT NULL,
  created_by uuid NOT NULL,
  operation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_order_attachment_reservations_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_order_attachment_reservations_purchase_order_id_fkey FOREIGN KEY (purchase_order_id)
    REFERENCES public.purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_attachment_reservations_operation_id_fkey FOREIGN KEY (operation_id)
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT purchase_order_attachment_reservations_storage_path_key UNIQUE (storage_path),
  CONSTRAINT purchase_order_attachment_reservations_kind_check CHECK (kind IN ('quote', 'invoice')),
  CONSTRAINT purchase_order_attachment_reservations_file_name_check CHECK (pg_catalog.char_length(original_file_name) BETWEEN 1 AND 255)
);
ALTER TABLE public.purchase_order_attachment_reservations OWNER TO postgres;

-- storage_path is the same value as the reservation's. sha256_source is browser (the hash the browser sent matched the
-- stored file) or server (the file was no longer at hand and the server hashed the stored file).
CREATE TABLE public.purchase_order_attachments (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  purchase_order_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  kind text NOT NULL,
  original_file_name text NOT NULL,
  storage_path text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  sha256_source text NOT NULL,
  uploaded_by uuid NOT NULL,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_order_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_order_attachments_purchase_order_id_fkey FOREIGN KEY (purchase_order_id)
    REFERENCES public.purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_attachments_reservation_id_fkey FOREIGN KEY (reservation_id)
    REFERENCES public.purchase_order_attachment_reservations (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_attachments_operation_id_fkey FOREIGN KEY (operation_id)
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT purchase_order_attachments_reservation_id_key UNIQUE (reservation_id),
  CONSTRAINT purchase_order_attachments_storage_path_key UNIQUE (storage_path),
  CONSTRAINT purchase_order_attachments_kind_check CHECK (kind IN ('quote', 'invoice')),
  CONSTRAINT purchase_order_attachments_file_name_check CHECK (pg_catalog.char_length(original_file_name) BETWEEN 1 AND 255),
  CONSTRAINT purchase_order_attachments_mime_type_check CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  CONSTRAINT purchase_order_attachments_size_bytes_check CHECK (size_bytes BETWEEN 1 AND 20971520),
  CONSTRAINT purchase_order_attachments_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT purchase_order_attachments_sha256_source_check CHECK (sha256_source IN ('browser', 'server'))
);
ALTER TABLE public.purchase_order_attachments OWNER TO postgres;

-- Revision 1 is the first record of the document's transaction details; later revisions (corrections, voiding) carry a reason.
-- replaces_attachment_id is set only on revision 1 of an attachment that replaces an earlier one.
CREATE TABLE public.purchase_order_attachment_revisions (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  attachment_id uuid NOT NULL,
  revision_no integer NOT NULL,
  transaction_date date NOT NULL,
  amount_yen bigint NOT NULL,
  currency text NOT NULL,
  counterparty text NOT NULL,
  voided boolean NOT NULL DEFAULT false,
  reason text,
  replaces_attachment_id uuid,
  actor_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT purchase_order_attachment_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT purchase_order_attachment_revisions_attachment_id_fkey FOREIGN KEY (attachment_id)
    REFERENCES public.purchase_order_attachments (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_attachment_revisions_replaces_attachment_fkey FOREIGN KEY (replaces_attachment_id)
    REFERENCES public.purchase_order_attachments (id) ON DELETE RESTRICT,
  CONSTRAINT purchase_order_attachment_revisions_operation_id_fkey FOREIGN KEY (operation_id)
    REFERENCES private.group_g_operations (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT purchase_order_attachment_revisions_attachment_revision_key UNIQUE (attachment_id, revision_no),
  CONSTRAINT purchase_order_attachment_revisions_revision_no_check CHECK (revision_no >= 1),
  CONSTRAINT purchase_order_attachment_revisions_transaction_date_check CHECK (transaction_date >= DATE '2000-01-01'),
  CONSTRAINT purchase_order_attachment_revisions_amount_yen_check CHECK (amount_yen BETWEEN 0 AND 99999999999),
  CONSTRAINT purchase_order_attachment_revisions_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT purchase_order_attachment_revisions_counterparty_check CHECK (pg_catalog.char_length(counterparty) BETWEEN 1 AND 100),
  CONSTRAINT purchase_order_attachment_revisions_reason_check CHECK (reason IS NULL OR pg_catalog.char_length(reason) BETWEEN 1 AND 200),
  CONSTRAINT purchase_order_attachment_revisions_revision_reason_check CHECK (revision_no = 1 OR reason IS NOT NULL),
  CONSTRAINT purchase_order_attachment_revisions_voided_reason_check CHECK (NOT voided OR reason IS NOT NULL),
  CONSTRAINT purchase_order_attachment_revisions_replaces_check CHECK (replaces_attachment_id IS NULL OR revision_no = 1)
);
ALTER TABLE public.purchase_order_attachment_revisions OWNER TO postgres;
CREATE INDEX purchase_order_attachment_revisions_search_idx
  ON public.purchase_order_attachment_revisions (transaction_date, amount_yen, counterparty);
CREATE INDEX purchase_order_attachment_revisions_attachment_idx
  ON public.purchase_order_attachment_revisions (attachment_id, revision_no DESC);

-- 8. Append-only guards. The seven history tables reject UPDATE, DELETE and TRUNCATE even from the owner's plain SQL
--    (the same function and message as the G-1 history tables). purchase_orders / purchase_order_lines reject DELETE and
--    TRUNCATE the same way; their UPDATE goes through the guard of section 9.
CREATE TRIGGER purchase_order_revisions_no_update BEFORE UPDATE ON public.purchase_order_revisions
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_revisions_no_delete BEFORE DELETE ON public.purchase_order_revisions
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_revisions_no_truncate BEFORE TRUNCATE ON public.purchase_order_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_short_closures_no_update BEFORE UPDATE ON public.purchase_order_short_closures
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_short_closures_no_delete BEFORE DELETE ON public.purchase_order_short_closures
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_short_closures_no_truncate BEFORE TRUNCATE ON public.purchase_order_short_closures
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_receipts_no_update BEFORE UPDATE ON public.purchase_order_receipts
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_receipts_no_delete BEFORE DELETE ON public.purchase_order_receipts
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_receipts_no_truncate BEFORE TRUNCATE ON public.purchase_order_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_receipt_lines_no_update BEFORE UPDATE ON public.purchase_order_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_receipt_lines_no_delete BEFORE DELETE ON public.purchase_order_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_receipt_lines_no_truncate BEFORE TRUNCATE ON public.purchase_order_receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachment_reservations_no_update BEFORE UPDATE ON public.purchase_order_attachment_reservations
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachment_reservations_no_delete BEFORE DELETE ON public.purchase_order_attachment_reservations
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachment_reservations_no_truncate BEFORE TRUNCATE ON public.purchase_order_attachment_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachments_no_update BEFORE UPDATE ON public.purchase_order_attachments
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachments_no_delete BEFORE DELETE ON public.purchase_order_attachments
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachments_no_truncate BEFORE TRUNCATE ON public.purchase_order_attachments
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachment_revisions_no_update BEFORE UPDATE ON public.purchase_order_attachment_revisions
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachment_revisions_no_delete BEFORE DELETE ON public.purchase_order_attachment_revisions
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_attachment_revisions_no_truncate BEFORE TRUNCATE ON public.purchase_order_attachment_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_orders_no_truncate BEFORE TRUNCATE ON public.purchase_orders
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_lines_no_delete BEFORE DELETE ON public.purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER purchase_order_lines_no_truncate BEFORE TRUNCATE ON public.purchase_order_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();

-- 9. Guard of the two mutable tables. The columns that identify an order or a line (and the copies taken when it was
--    placed) never change. An update that changes anything must raise version by exactly one and must hold the common
--    advisory (190521,1) on this connection (the same pg_locks check as allocate_group_g_fifo). An update that changes
--    nothing passes untouched.
CREATE FUNCTION private.guard_group_g_purchase_order_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'purchase_orders' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.ordered_at IS DISTINCT FROM OLD.ordered_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'GROUP_G_PURCHASE_ORDER_GUARD' USING ERRCODE = '55000', DETAIL = 'immutable_column';
    END IF;
  ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
     OR NEW.line_no IS DISTINCT FROM OLD.line_no OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
     OR NEW.item_name IS DISTINCT FROM OLD.item_name OR NEW.color_name IS DISTINCT FROM OLD.color_name
     OR NEW.size_label IS DISTINCT FROM OLD.size_label OR NEW.provisional_quantity IS DISTINCT FROM OLD.provisional_quantity
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'GROUP_G_PURCHASE_ORDER_GUARD' USING ERRCODE = '55000', DETAIL = 'immutable_column';
  END IF;
  -- the generated column outstanding_quantity is left out: it is computed after the BEFORE triggers
  IF (pg_catalog.to_jsonb(NEW) - 'outstanding_quantity') IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'outstanding_quantity') THEN
    RETURN NEW;
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'GROUP_G_PURCHASE_ORDER_GUARD' USING ERRCODE = '55000', DETAIL = 'version';
  END IF;
  IF NOT EXISTS (
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
ALTER FUNCTION private.guard_group_g_purchase_order_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.guard_group_g_purchase_order_change() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER purchase_orders_change_guard BEFORE UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION private.guard_group_g_purchase_order_change();
CREATE TRIGGER purchase_order_lines_change_guard BEFORE UPDATE ON public.purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION private.guard_group_g_purchase_order_change();

-- 10. A receipt row ties to exactly one ledger row of the stock_movements table, checked when the row is inserted:
--     the same variant as the order line, delta = quantity, reason restock for a positive row and adjustment for a negative
--     row, and allocation_operation_id IS NULL (an untagged row, so the G-1 consistency trigger of tagged rows never
--     applies to it). The receipt and the line belong to the same order. A negative row points at a positive row of the
--     same line, in a receipt of kind receive of the same order. Violations are GROUP_G_PO_RECEIPT_LINE_MISMATCH / 23514
--     with a DETAIL of movement, line_order or reverses.
CREATE FUNCTION private.check_purchase_order_receipt_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_movement record;
  v_line record;
  v_receipt record;
  v_origin record;
BEGIN
  SELECT sm.variant_id, sm.delta, sm.reason, sm.allocation_operation_id INTO v_movement
  FROM public.stock_movements AS sm WHERE sm.id = NEW.stock_movement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_PO_RECEIPT_LINE_MISMATCH' USING ERRCODE = '23514', DETAIL = 'movement';
  END IF;
  SELECT l.purchase_order_id, l.variant_id INTO v_line FROM public.purchase_order_lines AS l WHERE l.id = NEW.line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_PO_RECEIPT_LINE_MISMATCH' USING ERRCODE = '23514', DETAIL = 'line_order';
  END IF;
  SELECT r.purchase_order_id INTO v_receipt FROM public.purchase_order_receipts AS r WHERE r.id = NEW.receipt_id;
  IF NOT FOUND OR v_receipt.purchase_order_id IS DISTINCT FROM v_line.purchase_order_id THEN
    RAISE EXCEPTION 'GROUP_G_PO_RECEIPT_LINE_MISMATCH' USING ERRCODE = '23514', DETAIL = 'line_order';
  END IF;
  IF v_movement.variant_id IS DISTINCT FROM v_line.variant_id
     OR v_movement.delta IS DISTINCT FROM NEW.quantity
     OR v_movement.reason IS DISTINCT FROM (CASE WHEN NEW.quantity > 0 THEN 'restock' ELSE 'adjustment' END)
     OR v_movement.allocation_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_PO_RECEIPT_LINE_MISMATCH' USING ERRCODE = '23514', DETAIL = 'movement';
  END IF;
  IF NEW.reverses_receipt_line_id IS NOT NULL THEN
    SELECT o.quantity, o.line_id, r.purchase_order_id, r.kind INTO v_origin
    FROM public.purchase_order_receipt_lines AS o JOIN public.purchase_order_receipts AS r ON r.id = o.receipt_id
    WHERE o.id = NEW.reverses_receipt_line_id;
    IF NOT FOUND OR v_origin.quantity <= 0 OR v_origin.line_id IS DISTINCT FROM NEW.line_id
       OR v_origin.purchase_order_id IS DISTINCT FROM v_receipt.purchase_order_id OR v_origin.kind IS DISTINCT FROM 'receive' THEN
      RAISE EXCEPTION 'GROUP_G_PO_RECEIPT_LINE_MISMATCH' USING ERRCODE = '23514', DETAIL = 'reverses';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.check_purchase_order_receipt_line() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.check_purchase_order_receipt_line() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER purchase_order_receipt_lines_check_line BEFORE INSERT ON public.purchase_order_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION private.check_purchase_order_receipt_line();

-- 11. Received quantity (checked at commit, for the line a row touched): received_quantity must equal the sum of the
--     receipt rows of the line (GROUP_G_PO_RECEIVED_MISMATCH / 23514), and the offsets that point at one positive row
--     must not add up to more than that row (GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED / 23514).
CREATE FUNCTION private.check_purchase_order_line_received() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_line_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'purchase_order_lines' THEN
    v_line_id := NEW.id;
  ELSE
    v_line_id := NEW.line_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_lines AS l
    WHERE l.id = v_line_id
      AND l.received_quantity IS DISTINCT FROM (
        SELECT COALESCE(pg_catalog.sum(rl.quantity), 0) FROM public.purchase_order_receipt_lines AS rl WHERE rl.line_id = l.id)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_PO_RECEIVED_MISMATCH' USING ERRCODE = '23514', DETAIL = 'received_quantity';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.purchase_order_receipt_lines AS p
    WHERE p.line_id = v_line_id AND p.quantity > 0
      AND -(SELECT COALESCE(pg_catalog.sum(n.quantity), 0) FROM public.purchase_order_receipt_lines AS n
            WHERE n.reverses_receipt_line_id = p.id) > p.quantity
  ) THEN
    RAISE EXCEPTION 'GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED' USING ERRCODE = '23514', DETAIL = 'reverse';
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION private.check_purchase_order_line_received() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.check_purchase_order_line_received() FROM PUBLIC, anon, authenticated, service_role;
CREATE CONSTRAINT TRIGGER group_g_po_line_received AFTER INSERT OR UPDATE ON public.purchase_order_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.check_purchase_order_line_received();
CREATE CONSTRAINT TRIGGER group_g_po_line_received AFTER INSERT ON public.purchase_order_receipt_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.check_purchase_order_line_received();

-- 12. Row security and privileges. New public tables get anon / authenticated privileges from the Supabase defaults, so
--     all of them are removed first. service_role may only read the two tables that hold storage keys (the later
--     Tasks look keys up through them); every write goes through a SECURITY DEFINER function. The privileges on
--     schema private are not touched.
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_short_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_attachment_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_attachment_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny direct client access" ON public.purchase_orders
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.purchase_order_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.purchase_order_revisions
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.purchase_order_short_closures
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.purchase_order_receipts
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.purchase_order_receipt_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.purchase_order_attachment_reservations
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.purchase_order_attachments
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.purchase_order_attachment_revisions
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.purchase_orders, public.purchase_order_lines, public.purchase_order_revisions,
  public.purchase_order_short_closures, public.purchase_order_receipts, public.purchase_order_receipt_lines,
  public.purchase_order_attachment_reservations, public.purchase_order_attachments, public.purchase_order_attachment_revisions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.purchase_order_attachment_reservations, public.purchase_order_attachments TO service_role;

-- 13. Storage bucket for the original documents (quotes and invoices). Private; 20 MiB per object; PDF, JPEG and PNG only.
--     No policy on storage.objects is created: anon / authenticated can do nothing with it, and reads and writes go through
--     service_role and signed URLs only. Objects are removed through the Storage API (a SQL delete of storage.objects would
--     leave the stored file behind). The final assertion fails when a bucket of this id already exists with other settings.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('purchase-order-documents', 'purchase-order-documents', false, 20971520, ARRAY['application/pdf', 'image/jpeg', 'image/png'])
ON CONFLICT (id) DO NOTHING;

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

-- Task 2 expectation: the nine purchase-order tables (rows, RLS, owner, policies, columns, constraints, indexes, triggers),
-- the three trigger functions and the private bucket. The table privileges are compared by meaning in the next block.
-- The expected sets grow with every Task that adds to this file.
DO $g2a_final_objects$
DECLARE
  v_failed text;
  v_tables regclass[] := ARRAY[
    'public.purchase_orders'::regclass, 'public.purchase_order_lines'::regclass,
    'public.purchase_order_revisions'::regclass, 'public.purchase_order_short_closures'::regclass,
    'public.purchase_order_receipts'::regclass, 'public.purchase_order_receipt_lines'::regclass,
    'public.purchase_order_attachment_reservations'::regclass, 'public.purchase_order_attachments'::regclass,
    'public.purchase_order_attachment_revisions'::regclass
  ];
BEGIN
  -- ordinary tables with row security, owned by postgres, still empty
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class AS c
      WHERE c.oid = ANY (v_tables) AND c.relkind = 'r' AND c.relrowsecurity AND c.relowner = 'postgres'::regrole) <> 9 THEN
    v_failed := 'purchase_tables';
  ELSIF EXISTS (SELECT 1 FROM public.purchase_orders) OR EXISTS (SELECT 1 FROM public.purchase_order_lines)
     OR EXISTS (SELECT 1 FROM public.purchase_order_revisions) OR EXISTS (SELECT 1 FROM public.purchase_order_short_closures)
     OR EXISTS (SELECT 1 FROM public.purchase_order_receipts) OR EXISTS (SELECT 1 FROM public.purchase_order_receipt_lines)
     OR EXISTS (SELECT 1 FROM public.purchase_order_attachment_reservations) OR EXISTS (SELECT 1 FROM public.purchase_order_attachments)
     OR EXISTS (SELECT 1 FROM public.purchase_order_attachment_revisions) THEN
    v_failed := 'purchase_table_rows';
  -- one restrictive policy per table that denies anon and authenticated everything
  ELSIF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy AS p WHERE p.polrelid = ANY (v_tables)) <> 9
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy AS p
         WHERE p.polrelid = ANY (v_tables) AND p.polname = 'deny direct client access' AND NOT p.polpermissive AND p.polcmd = '*'
           AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'false'
           AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = 'false'
           AND (SELECT pg_catalog.array_agg(r ORDER BY r) FROM pg_catalog.unnest(p.polroles) AS u(r))
             = (SELECT pg_catalog.array_agg(r ORDER BY r) FROM pg_catalog.unnest(ARRAY['anon'::regrole::oid, 'authenticated'::regrole::oid]) AS u(r))) <> 9 THEN
    v_failed := 'purchase_table_policies';
  -- columns, in table order, as name:type with ! for NOT NULL (tz = timestamp with time zone); outstanding_quantity is
  -- the only generated column
  ELSIF EXISTS (
    SELECT 1
    FROM (VALUES
      ('purchase_orders', 'id:uuid!,number:text!,supplier_name:text!,memo:text,stage:text!,version:integer!,ordered_at:tz!,created_by:uuid!,created_at:tz!,updated_at:tz!'),
      ('purchase_order_lines', 'id:uuid!,purchase_order_id:uuid!,line_no:integer!,variant_id:bigint!,item_name:text!,color_name:text,size_label:text,provisional_quantity:integer!,confirmed_quantity:integer,received_quantity:integer!,unit_price_yen:integer,outstanding_quantity:integer,version:integer!,created_at:tz!,updated_at:tz!'),
      ('purchase_order_revisions', 'id:uuid!,purchase_order_id:uuid!,line_id:uuid,revision_no:integer!,kind:text!,before_quantity:integer,after_quantity:integer,before_unit_price_yen:integer,after_unit_price_yen:integer,before_supplier_name:text,after_supplier_name:text,before_memo:text,after_memo:text,reason:text,actor_id:uuid!,operation_id:uuid!,created_at:tz!'),
      ('purchase_order_short_closures', 'id:uuid!,line_id:uuid!,revision_id:uuid!,closed_quantity:integer!,reason:text!,actor_id:uuid!,created_at:tz!'),
      ('purchase_order_receipts', 'id:uuid!,purchase_order_id:uuid!,kind:text!,received_on:date!,memo:text,reason:text,actor_id:uuid!,operation_id:uuid!,created_at:tz!'),
      ('purchase_order_receipt_lines', 'id:uuid!,receipt_id:uuid!,line_id:uuid!,quantity:integer!,reverses_receipt_line_id:uuid,stock_movement_id:bigint!,created_at:tz!'),
      ('purchase_order_attachment_reservations', 'id:uuid!,purchase_order_id:uuid!,kind:text!,original_file_name:text!,storage_path:text!,created_by:uuid!,operation_id:uuid!,expires_at:tz!,created_at:tz!'),
      ('purchase_order_attachments', 'id:uuid!,purchase_order_id:uuid!,reservation_id:uuid!,kind:text!,original_file_name:text!,storage_path:text!,mime_type:text!,size_bytes:bigint!,sha256:text!,sha256_source:text!,uploaded_by:uuid!,operation_id:uuid!,created_at:tz!'),
      ('purchase_order_attachment_revisions', 'id:uuid!,attachment_id:uuid!,revision_no:integer!,transaction_date:date!,amount_yen:bigint!,currency:text!,counterparty:text!,voided:boolean!,reason:text,replaces_attachment_id:uuid,actor_id:uuid!,operation_id:uuid!,created_at:tz!')
    ) AS e(rel, cols)
    WHERE e.cols IS DISTINCT FROM (
      SELECT pg_catalog.string_agg(a.attname::text || ':'
               || pg_catalog.replace(pg_catalog.format_type(a.atttypid, a.atttypmod), 'timestamp with time zone', 'tz')
               || CASE WHEN a.attnotnull THEN '!' ELSE '' END, ',' ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = ('public.' || e.rel)::regclass AND a.attnum > 0 AND NOT a.attisdropped)
  )
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS a
         WHERE a.attrelid = ANY (v_tables) AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = 's') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
         WHERE a.attrelid = 'public.purchase_order_lines'::regclass AND a.attname = 'outstanding_quantity'
           AND a.attgenerated = 's' AND NOT a.attisdropped) THEN
    v_failed := 'purchase_table_columns';
  -- constraints (87 in all): every one by name (without the table name), kind and, for the primary, unique and foreign keys,
  -- its columns (joined by +) and, for a foreign key, the table it points at. The set must be exactly this one.
  -- Every foreign key is ON UPDATE NO ACTION / ON DELETE RESTRICT and points at the id of its target; only the keys to
  -- the operation table and the two constraint triggers are deferrable (initially deferred).
  ELSIF EXISTS (
    WITH expected(rel, token) AS (
      SELECT e.rel, x.token
      FROM (VALUES
        ('purchase_orders', 'pkey:p(id),number_key:u(number),number_check:c,supplier_name_check:c,memo_check:c,stage_check:c,version_check:c'),
        ('purchase_order_lines', 'pkey:p(id),purchase_order_id_fkey:f>purchase_orders(purchase_order_id),variant_id_fkey:f>item_variants(variant_id),order_variant_key:u(purchase_order_id+variant_id),order_line_no_key:u(purchase_order_id+line_no),line_no_check:c,provisional_quantity_check:c,confirmed_quantity_check:c,received_quantity_check:c,unit_price_yen_check:c,version_check:c,confirmed_received_check:c,unconfirmed_received_check:c,group_g_po_line_received:t'),
        ('purchase_order_revisions', 'pkey:p(id),purchase_order_id_fkey:f>purchase_orders(purchase_order_id),line_id_fkey:f>purchase_order_lines(line_id),operation_id_fkey:f>group_g_operations(operation_id),revision_key:u(purchase_order_id+revision_no+line_id+kind),revision_no_check:c,kind_check:c,quantity_check:c,unit_price_check:c,text_check:c,reason_check:c'),
        ('purchase_order_short_closures', 'pkey:p(id),line_id_fkey:f>purchase_order_lines(line_id),revision_id_fkey:f>purchase_order_revisions(revision_id),revision_id_key:u(revision_id),closed_quantity_check:c,reason_check:c'),
        ('purchase_order_receipts', 'pkey:p(id),purchase_order_id_fkey:f>purchase_orders(purchase_order_id),operation_id_fkey:f>group_g_operations(operation_id),kind_check:c,memo_check:c,reason_check:c,kind_reason_check:c'),
        ('purchase_order_receipt_lines', 'pkey:p(id),receipt_id_fkey:f>purchase_order_receipts(receipt_id),line_id_fkey:f>purchase_order_lines(line_id),reverses_receipt_line_id_fkey:f>purchase_order_receipt_lines(reverses_receipt_line_id),stock_movement_id_fkey:f>stock_movements(stock_movement_id),stock_movement_id_key:u(stock_movement_id),receipt_line_key:u(receipt_id+line_id),quantity_check:c,reverses_check:c,group_g_po_line_received:t'),
        ('purchase_order_attachment_reservations', 'pkey:p(id),purchase_order_id_fkey:f>purchase_orders(purchase_order_id),operation_id_fkey:f>group_g_operations(operation_id),storage_path_key:u(storage_path),kind_check:c,file_name_check:c'),
        ('purchase_order_attachments', 'pkey:p(id),purchase_order_id_fkey:f>purchase_orders(purchase_order_id),reservation_id_fkey:f>purchase_order_attachment_reservations(reservation_id),operation_id_fkey:f>group_g_operations(operation_id),reservation_id_key:u(reservation_id),storage_path_key:u(storage_path),kind_check:c,file_name_check:c,mime_type_check:c,size_bytes_check:c,sha256_check:c,sha256_source_check:c'),
        ('purchase_order_attachment_revisions', 'pkey:p(id),attachment_id_fkey:f>purchase_order_attachments(attachment_id),replaces_attachment_fkey:f>purchase_order_attachments(replaces_attachment_id),operation_id_fkey:f>group_g_operations(operation_id),attachment_revision_key:u(attachment_id+revision_no),revision_no_check:c,transaction_date_check:c,amount_yen_check:c,currency_check:c,counterparty_check:c,reason_check:c,revision_reason_check:c,voided_reason_check:c,replaces_check:c')
      ) AS e(rel, cons)
      CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.string_to_array(e.cons, ',')) AS x(token)
    ), actual(rel, token) AS (
      SELECT cl.relname::text,
             pg_catalog.replace(c.conname::text, cl.relname::text || '_', '') || ':' || c.contype::text
             || CASE WHEN c.contype = 'f' THEN '>' || (SELECT r.relname::text FROM pg_catalog.pg_class AS r WHERE r.oid = c.confrelid) ELSE '' END
             || CASE WHEN c.contype IN ('p', 'u', 'f') THEN '(' || (
                  SELECT pg_catalog.string_agg(a.attname::text, '+' ORDER BY k.ord)
                  FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) || ')' ELSE '' END
      FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_class AS cl ON cl.oid = c.conrelid
      WHERE c.conrelid = ANY (v_tables) AND c.contype <> 'n'
    )
    SELECT 1 FROM expected AS e FULL JOIN actual AS a ON a.rel = e.rel AND a.token = e.token
    WHERE e.token IS NULL OR a.token IS NULL
  )
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
         WHERE c.conrelid = ANY (v_tables) AND c.contype = 'f'
           AND NOT (c.confdeltype = 'r' AND c.confupdtype = 'a' AND c.convalidated
                    AND c.confkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = c.confrelid AND a.attname = 'id')]))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
         WHERE c.conrelid = ANY (v_tables) AND c.contype <> 'n'
           AND (c.condeferred <> c.condeferrable
                OR c.condeferrable <> (c.contype = 't' OR (c.contype = 'f' AND c.confrelid = 'private.group_g_operations'::regclass))))
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_index AS i ON i.indexrelid = c.conindid
         WHERE c.conrelid = ANY (v_tables) AND c.contype = 'u' AND i.indnullsnotdistinct) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c JOIN pg_catalog.pg_index AS i ON i.indexrelid = c.conindid
         WHERE c.conrelid = 'public.purchase_order_revisions'::regclass AND c.conname = 'purchase_order_revisions_revision_key'
           AND i.indnullsnotdistinct) THEN
    v_failed := 'purchase_table_constraints';
  -- indexes: the 9 primary keys, the 11 unique constraints and the 5 below (spaces, parentheses and the schema name are ignored)
  ELSIF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i WHERE i.indrelid = ANY (v_tables)) <> 25
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_indexes AS x
         JOIN (VALUES
           ('purchase_order_lines_variant_outstanding_idx',
            'CREATEINDEXpurchase_order_lines_variant_outstanding_idxONpurchase_order_linesUSINGbtreevariant_idWHEREoutstanding_quantity>0'),
           ('purchase_order_receipt_lines_line_idx',
            'CREATEINDEXpurchase_order_receipt_lines_line_idxONpurchase_order_receipt_linesUSINGbtreeline_id'),
           ('purchase_order_receipt_lines_reverses_idx',
            'CREATEINDEXpurchase_order_receipt_lines_reverses_idxONpurchase_order_receipt_linesUSINGbtreereverses_receipt_line_idWHEREreverses_receipt_line_idISNOTNULL'),
           ('purchase_order_attachment_revisions_search_idx',
            'CREATEINDEXpurchase_order_attachment_revisions_search_idxONpurchase_order_attachment_revisionsUSINGbtreetransaction_date,amount_yen,counterparty'),
           ('purchase_order_attachment_revisions_attachment_idx',
            'CREATEINDEXpurchase_order_attachment_revisions_attachment_idxONpurchase_order_attachment_revisionsUSINGbtreeattachment_id,revision_noDESC')
         ) AS e(name, def)
           ON x.schemaname = 'public' AND x.indexname = e.name
          AND pg_catalog.regexp_replace(x.indexdef, '[ ()]|public\.', '', 'g') = e.def) <> 5 THEN
    v_failed := 'purchase_table_indexes';
  -- triggers (30 in all, none disabled): every one as name (without the table name) : tgtype : function, where tgtype 19 /
  -- 11 / 34 is BEFORE UPDATE row / BEFORE DELETE row / BEFORE TRUNCATE statement, 7 is BEFORE INSERT row, 21 / 5 is AFTER
  -- INSERT OR UPDATE row / AFTER INSERT row, and the function is r = reject_group_g_event_mutation, g = the purchase order
  -- guard, c = the receipt row check, l = the received quantity check. The set must be exactly this one.
  ELSIF EXISTS (
    WITH expected(rel, token) AS (
      SELECT e.rel, x.token
      FROM (VALUES
        ('purchase_order_revisions', 'no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('purchase_order_short_closures', 'no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('purchase_order_receipts', 'no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('purchase_order_receipt_lines', 'no_update:19:r,no_delete:11:r,no_truncate:34:r,check_line:7:c,group_g_po_line_received:5:l'),
        ('purchase_order_attachment_reservations', 'no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('purchase_order_attachments', 'no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('purchase_order_attachment_revisions', 'no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('purchase_orders', 'no_delete:11:r,no_truncate:34:r,change_guard:19:g'),
        ('purchase_order_lines', 'no_delete:11:r,no_truncate:34:r,change_guard:19:g,group_g_po_line_received:21:l')
      ) AS e(rel, trig)
      CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.string_to_array(e.trig, ',')) AS x(token)
    ), actual(rel, token) AS (
      SELECT cl.relname::text,
             pg_catalog.replace(t.tgname::text, cl.relname::text || '_', '') || ':' || t.tgtype::text || ':'
             || CASE WHEN t.tgfoid = 'private.reject_group_g_event_mutation()'::regprocedure THEN 'r'
                     WHEN t.tgfoid = 'private.guard_group_g_purchase_order_change()'::regprocedure THEN 'g'
                     WHEN t.tgfoid = 'private.check_purchase_order_receipt_line()'::regprocedure THEN 'c'
                     WHEN t.tgfoid = 'private.check_purchase_order_line_received()'::regprocedure THEN 'l'
                     ELSE '?' END
             || CASE WHEN t.tgenabled = 'O' THEN '' ELSE '!' END
      FROM pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_class AS cl ON cl.oid = t.tgrelid
      WHERE t.tgrelid = ANY (v_tables) AND NOT t.tgisinternal
    )
    SELECT 1 FROM expected AS e FULL JOIN actual AS a ON a.rel = e.rel AND a.token = e.token
    WHERE e.token IS NULL OR a.token IS NULL
  )
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
         WHERE t.tgrelid = ANY (v_tables) AND t.tgname = 'group_g_po_line_received'
           AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred AND NOT t.tgisinternal) <> 2 THEN
    v_failed := 'purchase_table_triggers';
  -- the three trigger functions: owner postgres, search_path empty, nobody but the owner may execute them
  ELSIF EXISTS (
    SELECT 1
    FROM (VALUES
      ('private.guard_group_g_purchase_order_change()', false),
      ('private.check_purchase_order_receipt_line()', true),
      ('private.check_purchase_order_line_received()', true)
    ) AS e(sig, definer)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    WHERE p.oid IS NULL
       OR p.proowner <> 'postgres'::regrole
       OR p.prosecdef <> e.definer
       OR NOT ('search_path=""' = ANY (COALESCE(p.proconfig, ARRAY[]::text[])))
       OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS x
                  WHERE x.grantee = 0)
  ) THEN
    v_failed := 'purchase_functions';
  -- the private bucket keeps exactly these settings even when a bucket of this id existed before this file ran
  ELSIF NOT EXISTS (
    SELECT 1 FROM storage.buckets AS b
    WHERE b.id = 'purchase-order-documents' AND b.name = 'purchase-order-documents' AND b.public IS FALSE
      AND b.file_size_limit = 20971520
      AND (SELECT pg_catalog.array_agg(m ORDER BY m) FROM pg_catalog.unnest(b.allowed_mime_types) AS u(m))
        = ARRAY['application/pdf', 'image/jpeg', 'image/png']
  ) THEN
    v_failed := 'purchase_bucket';
  -- no policy on storage.objects names the bucket
  ELSIF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
      AND (COALESCE(p.qual, '') LIKE '%purchase-order-documents%' OR COALESCE(p.with_check, '') LIKE '%purchase-order-documents%')
  ) THEN
    v_failed := 'purchase_bucket_policies';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g2a_final_objects$;

-- The privileges of the nine tables, compared by meaning (not by the text of the ACL: production may carry other grantees such
-- as supabase_admin). Wanted: postgres holds every privilege; service_role holds SELECT on purchase_order_attachments and
-- purchase_order_attachment_reservations only. Not wanted: any privilege of PUBLIC, anon or authenticated (column
-- privileges too), anything of service_role beyond that SELECT (column privileges too), and MAINTAIN (PostgreSQL 17 and
-- later) for anyone but the owner.
DO $g2a_final_table_acl$
DECLARE
  v_failed text;
  v_maintain text[] := CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
    THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  v_all text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] || v_maintain;
  v_service_forbidden text[] := ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] || v_maintain;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.purchase_orders', false),
      ('public.purchase_order_lines', false),
      ('public.purchase_order_revisions', false),
      ('public.purchase_order_short_closures', false),
      ('public.purchase_order_receipts', false),
      ('public.purchase_order_receipt_lines', false),
      ('public.purchase_order_attachment_reservations', true),
      ('public.purchase_order_attachments', true),
      ('public.purchase_order_attachment_revisions', false)
    ) AS e(rel, service_select)
    CROSS JOIN LATERAL (SELECT pg_catalog.to_regclass(e.rel) AS r) AS t
    WHERE t.r IS NULL
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(priv)
                  WHERE NOT pg_catalog.has_table_privilege('postgres', t.r, p.priv))
       OR pg_catalog.has_table_privilege('service_role', t.r, 'SELECT') <> e.service_select
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE((SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = t.r),
                    pg_catalog.acldefault('r', 'postgres'::regrole))) AS x WHERE x.grantee = 0)
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']) AS g(role)
                  CROSS JOIN pg_catalog.unnest(v_all) AS p(priv)
                  WHERE pg_catalog.has_table_privilege(g.role, t.r, p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']) AS g(role)
                  CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(priv)
                  WHERE pg_catalog.has_any_column_privilege(g.role, t.r, p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_service_forbidden) AS p(priv)
                  WHERE pg_catalog.has_table_privilege('service_role', t.r, p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'REFERENCES']) AS p(priv)
                  WHERE pg_catalog.has_any_column_privilege('service_role', t.r, p.priv))
       OR (NOT e.service_select AND pg_catalog.has_any_column_privilege('service_role', t.r, 'SELECT'))
  ) THEN
    v_failed := 'purchase_table_acl';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g2a_final_table_acl$;
-- G2A_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
