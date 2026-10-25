BEGIN;

-- G3A_BODY_BEGIN
-- G-3 foundation (FREQ-533-AC-02, FREQ-533-AC-04, FREQ-540-AC-12).
-- Actor identifiers deliberately have no foreign keys: user deletion must not mutate history.
-- 1. Shipment-slip tables. No sequence and no business rows are created by this file.
CREATE TABLE public.shipment_slips (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  number text NOT NULL UNIQUE,
  stage text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  customer_kind text NOT NULL,
  customer_user_id uuid,
  customer_email text,
  ship_to_full_name text NOT NULL,
  ship_to_postal_code text NOT NULL,
  ship_to_prefecture text NOT NULL,
  ship_to_city text NOT NULL,
  ship_to_address text NOT NULL,
  ship_to_phone text NOT NULL,
  ship_to_building text,
  draft_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  shipping_carrier text,
  tracking_number text,
  notify_customer boolean,
  shipment_date date,
  tracking_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  confirm_request_key uuid UNIQUE,
  confirm_operation_id uuid REFERENCES private.group_g_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  confirmed_at timestamptz,
  confirmed_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  discarded_at timestamptz,
  discarded_by uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT shipment_slips_number_check CHECK (number ~ '^SL-[0-9]{8}-[0-9]{4}$'),
  CONSTRAINT shipment_slips_stage_check CHECK (stage IN ('draft','confirmed','cancelled','discarded')),
  CONSTRAINT shipment_slips_version_check CHECK (version >= 1),
  CONSTRAINT shipment_slips_customer_kind_check CHECK (customer_kind IN ('member','guest')),
  CONSTRAINT shipment_slips_customer_check CHECK (
    (customer_kind = 'member') = (customer_user_id IS NOT NULL)
    AND (customer_kind = 'guest') = (customer_email IS NOT NULL)
  ),
  CONSTRAINT shipment_slips_ship_to_full_name_check CHECK (pg_catalog.char_length(ship_to_full_name) >= 1),
  CONSTRAINT shipment_slips_ship_to_postal_code_check CHECK (pg_catalog.char_length(ship_to_postal_code) >= 1),
  CONSTRAINT shipment_slips_ship_to_prefecture_check CHECK (pg_catalog.char_length(ship_to_prefecture) >= 1),
  CONSTRAINT shipment_slips_ship_to_city_check CHECK (pg_catalog.char_length(ship_to_city) >= 1),
  CONSTRAINT shipment_slips_ship_to_address_check CHECK (pg_catalog.char_length(ship_to_address) >= 1),
  CONSTRAINT shipment_slips_ship_to_phone_check CHECK (pg_catalog.char_length(ship_to_phone) >= 1),
  CONSTRAINT shipment_slips_draft_lines_check CHECK (pg_catalog.jsonb_typeof(draft_lines) = 'array'),
  CONSTRAINT shipment_slips_shipping_carrier_check CHECK (shipping_carrier IN ('yamato','sagawa','japanpost')),
  CONSTRAINT shipment_slips_tracking_number_check CHECK (tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  CONSTRAINT shipment_slips_tracking_version_check CHECK (tracking_version >= 1),
  CONSTRAINT shipment_slips_expires_check CHECK ((stage = 'draft') = (expires_at IS NOT NULL)),
  CONSTRAINT shipment_slips_confirmed_check CHECK (
    stage NOT IN ('confirmed','cancelled') OR (
      confirmed_at IS NOT NULL AND shipment_date IS NOT NULL AND notify_customer IS NOT NULL
      AND confirm_operation_id IS NOT NULL AND confirm_request_key IS NOT NULL
    )
  ),
  CONSTRAINT shipment_slips_cancelled_check CHECK ((stage = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT shipment_slips_discarded_check CHECK ((stage = 'discarded') = (discarded_at IS NOT NULL)),
  CONSTRAINT shipment_slips_tracking_check CHECK ((shipping_carrier IS NULL) = (tracking_number IS NULL))
);
ALTER TABLE public.shipment_slips OWNER TO postgres;

CREATE TABLE public.shipment_slip_lines (
  slip_id uuid NOT NULL REFERENCES public.shipment_slips(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (slip_id, order_item_id),
  CONSTRAINT shipment_slip_lines_quantity_check CHECK (quantity BETWEEN 1 AND 99999)
);
ALTER TABLE public.shipment_slip_lines OWNER TO postgres;

CREATE TABLE public.shipment_slip_fulfillments (
  slip_id uuid NOT NULL REFERENCES public.shipment_slips(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  fulfillment_id uuid NOT NULL UNIQUE REFERENCES public.order_fulfillments(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (slip_id, order_id)
);
ALTER TABLE public.shipment_slip_fulfillments OWNER TO postgres;

CREATE TABLE public.shipment_slip_versions (
  slip_id uuid NOT NULL REFERENCES public.shipment_slips(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  kind text NOT NULL,
  shipping_carrier text,
  tracking_number text,
  tracking_version integer NOT NULL,
  shipment_date date NOT NULL,
  reason text,
  actor_id uuid NOT NULL,
  operation_id uuid NOT NULL REFERENCES private.group_g_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (slip_id, version),
  CONSTRAINT shipment_slip_versions_version_check CHECK (version >= 1),
  CONSTRAINT shipment_slip_versions_kind_check CHECK (kind IN ('confirm','tracking_update','delivered','date_correction','cancel')),
  CONSTRAINT shipment_slip_versions_shipping_carrier_check CHECK (shipping_carrier IN ('yamato','sagawa','japanpost')),
  CONSTRAINT shipment_slip_versions_tracking_number_check CHECK (tracking_number ~ '^[0-9A-Za-z-]{1,64}$'),
  CONSTRAINT shipment_slip_versions_tracking_version_check CHECK (tracking_version >= 1),
  CONSTRAINT shipment_slip_versions_reason_check CHECK (pg_catalog.char_length(reason) BETWEEN 1 AND 200)
);
ALTER TABLE public.shipment_slip_versions OWNER TO postgres;

CREATE TABLE public.shipment_date_history (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  slip_id uuid NOT NULL REFERENCES public.shipment_slips(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  kind text NOT NULL,
  previous_date date NOT NULL,
  new_date date NOT NULL,
  reason text,
  actor_id uuid NOT NULL,
  operation_id uuid NOT NULL REFERENCES private.group_g_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (slip_id, version),
  CONSTRAINT shipment_date_history_kind_check CHECK (kind IN ('initial','correction')),
  CONSTRAINT shipment_date_history_reason_check CHECK (
    (kind = 'correction') = (reason IS NOT NULL)
    AND (reason IS NULL OR pg_catalog.char_length(reason) BETWEEN 1 AND 200)
  )
);
ALTER TABLE public.shipment_date_history OWNER TO postgres;

CREATE TABLE private.shipment_tracking_registrations (
  slip_id uuid NOT NULL REFERENCES public.shipment_slips(id) ON DELETE RESTRICT,
  tracking_version integer NOT NULL,
  leader_fulfillment_id uuid NOT NULL REFERENCES public.order_fulfillments(id) ON DELETE RESTRICT,
  carrier text NOT NULL,
  tracking_number text NOT NULL,
  operation_id uuid NOT NULL REFERENCES private.group_g_operations(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (slip_id, tracking_version),
  CONSTRAINT shipment_tracking_registrations_leader_version_key UNIQUE (leader_fulfillment_id, tracking_version),
  CONSTRAINT shipment_tracking_registrations_tracking_version_check CHECK (tracking_version >= 1),
  CONSTRAINT shipment_tracking_registrations_carrier_check CHECK (carrier IN ('yamato','sagawa','japanpost')),
  CONSTRAINT shipment_tracking_registrations_tracking_number_check CHECK (tracking_number ~ '^[0-9A-Z-]{1,64}$')
);
ALTER TABLE private.shipment_tracking_registrations OWNER TO postgres;

-- 2. Read indexes (unique and primary-key indexes are created with their constraints).
CREATE INDEX shipment_slips_stage_updated_idx ON public.shipment_slips(stage, updated_at DESC);
CREATE INDEX shipment_slip_lines_order_item_idx ON public.shipment_slip_lines(order_item_id);

-- 3. G-1 cleanup and local seeds leave no fulfillments. Existing rows are a safe stop.
ALTER TABLE public.order_fulfillments ADD COLUMN shipment_date date;
DO $g3a_fulfillments_empty$
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_fulfillments) THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'shipping_fulfillment_rows';
  END IF;
END
$g3a_fulfillments_empty$;
ALTER TABLE public.order_fulfillments
  ADD CONSTRAINT order_fulfillments_shipment_date_check CHECK (legacy OR shipment_date IS NOT NULL);
ALTER TABLE public.order_fulfillments DROP CONSTRAINT order_fulfillments_tracking_check;
ALTER TABLE public.order_fulfillments
  ADD CONSTRAINT order_fulfillments_tracking_check CHECK (legacy OR ((shipping_carrier IS NULL) = (tracking_number IS NULL)));

-- 4. Operation marks limit both the transition and the changed columns.
CREATE FUNCTION private.guard_group_g_shipment_slip_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_change text;
  v_allowed text[];
  v_from text;
  v_to text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GROUP_G_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  v_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  CASE v_change
    WHEN 'draft' THEN
      v_from := 'draft'; v_to := 'draft';
      v_allowed := ARRAY['draft_lines','customer_kind','customer_user_id','customer_email',
        'ship_to_full_name','ship_to_postal_code','ship_to_prefecture','ship_to_city',
        'ship_to_address','ship_to_phone','ship_to_building','expires_at'];
    WHEN 'discard' THEN
      v_from := 'draft'; v_to := 'discarded';
      v_allowed := ARRAY['stage','discarded_at','discarded_by','expires_at'];
    WHEN 'confirm' THEN
      v_from := 'draft'; v_to := 'confirmed';
      v_allowed := ARRAY['stage','confirmed_at','confirmed_by','confirm_operation_id','confirm_request_key',
        'shipping_carrier','tracking_number','notify_customer','shipment_date','expires_at'];
    WHEN 'tracking' THEN
      v_from := 'confirmed'; v_to := 'confirmed';
      v_allowed := ARRAY['shipping_carrier','tracking_number','tracking_version'];
    WHEN 'deliver' THEN
      v_from := 'confirmed'; v_to := 'confirmed'; v_allowed := ARRAY[]::text[];
    WHEN 'date' THEN
      v_from := 'confirmed'; v_to := 'confirmed'; v_allowed := ARRAY['shipment_date'];
    WHEN 'cancel' THEN
      v_from := 'confirmed'; v_to := 'cancelled'; v_allowed := ARRAY['stage','cancelled_at','cancelled_by'];
    ELSE
      RAISE EXCEPTION 'GROUP_G_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END CASE;
  IF OLD.stage IS DISTINCT FROM v_from OR NEW.stage IS DISTINCT FROM v_to
     OR NEW.version::bigint IS DISTINCT FROM OLD.version::bigint + 1
     OR (pg_catalog.to_jsonb(NEW) - (v_allowed || ARRAY['version','updated_at']))
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - (v_allowed || ARRAY['version','updated_at'])) THEN
    RAISE EXCEPTION 'GROUP_G_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION private.guard_group_g_shipment_slip_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.guard_group_g_shipment_slip_change() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.check_group_g_shipment_consumption() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items uuid[];
  v_item uuid;
  v_shipped bigint;
  v_net bigint;
  v_has_restore boolean;
  v_has_cancelled boolean;
  v_detail text;
BEGIN
  IF TG_TABLE_NAME = 'order_fulfillment_lines' THEN
    v_items := ARRAY[NEW.order_item_id];
  ELSIF TG_TABLE_NAME = 'order_fulfillments' THEN
    -- Read final rows, not the queued NEW image: all linked fulfillments may be cancelled later
    -- in the same transaction. A slip's cancellation must be atomic across its orders.
    IF EXISTS (
      SELECT 1
      FROM public.shipment_slip_fulfillments AS own
      JOIN public.order_fulfillments AS current_f ON current_f.id = own.fulfillment_id
      JOIN public.shipment_slip_fulfillments AS sibling ON sibling.slip_id = own.slip_id
      JOIN public.order_fulfillments AS other_f ON other_f.id = sibling.fulfillment_id
      WHERE own.fulfillment_id = NEW.id
        AND (current_f.cancelled_at IS NULL) <> (other_f.cancelled_at IS NULL)
    ) THEN
      RAISE EXCEPTION 'GROUP_G_SHIPMENT_CONSUMPTION' USING ERRCODE = '23514', DETAIL = 'slip_partial_cancel';
    END IF;
    SELECT pg_catalog.array_agg(l.order_item_id ORDER BY l.order_item_id) INTO v_items
    FROM public.order_fulfillment_lines AS l WHERE l.fulfillment_id = NEW.id;
  ELSE
    SELECT ARRAY[a.order_item_id] INTO v_items
    FROM public.order_item_allocations AS a WHERE a.id = NEW.allocation_id;
  END IF;

  FOREACH v_item IN ARRAY COALESCE(v_items, ARRAY[]::uuid[]) LOOP
    SELECT COALESCE(pg_catalog.sum(l.quantity), 0) INTO v_shipped
    FROM public.order_fulfillment_lines AS l
    JOIN public.order_fulfillments AS f ON f.id = l.fulfillment_id
    WHERE l.order_item_id = v_item AND NOT f.legacy AND f.cancelled_at IS NULL;
    -- Cancellation evidence includes cancelled rows; shipped includes active rows only.
    SELECT EXISTS (
      SELECT 1 FROM public.order_fulfillment_lines AS l
      JOIN public.order_fulfillments AS f ON f.id = l.fulfillment_id
      WHERE l.order_item_id = v_item AND NOT f.legacy AND f.cancelled_at IS NOT NULL
    ) INTO v_has_cancelled;
    SELECT COALESCE(pg_catalog.sum(CASE e.event_type WHEN 'consume' THEN e.quantity::bigint
                                 WHEN 'restore' THEN -e.quantity::bigint ELSE 0 END), 0),
           COALESCE(pg_catalog.bool_or(e.event_type = 'restore'), false)
      INTO v_net, v_has_restore
    FROM public.order_item_allocations AS a
    JOIN public.order_item_allocation_events AS e ON e.allocation_id = a.id
    WHERE a.order_item_id = v_item AND e.event_type IN ('consume','restore');
    IF v_shipped > v_net THEN
      v_detail := CASE WHEN v_has_restore AND NOT v_has_cancelled THEN 'restore_without_cancel' ELSE 'line_without_consume' END;
    ELSIF v_shipped < v_net THEN
      v_detail := CASE WHEN v_has_cancelled THEN 'cancel_without_restore' ELSE 'consume_without_line' END;
    ELSE
      CONTINUE;
    END IF;
    RAISE EXCEPTION 'GROUP_G_SHIPMENT_CONSUMPTION' USING ERRCODE = '23514', DETAIL = v_detail;
  END LOOP;
  RETURN NULL;
END;
$$;
ALTER FUNCTION private.check_group_g_shipment_consumption() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.check_group_g_shipment_consumption() FROM PUBLIC, anon, authenticated, service_role;

-- Latest E-4 definition, with a single isolated shipment_date branch added.
-- CREATE OR REPLACE preserves its existing owner and ACL. Its existing INVOKER mode
-- is needed for CURRENT_USER to keep checking the caller of the established branches.
CREATE OR REPLACE FUNCTION private.restrict_fulfillment_record_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_change text;
  v_allowed text[];
BEGIN
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'order_fulfillments' THEN
    IF pg_catalog.current_setting('app.fulfillment_change', true) = 'shipment_date' THEN
      IF CURRENT_USER IS DISTINCT FROM (
           SELECT pg_catalog.pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc AS p
           WHERE p.oid = 'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)'::pg_catalog.regprocedure
         ) OR OLD.cancelled_at IS NOT NULL
         OR (pg_catalog.to_jsonb(NEW) - 'shipment_date') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'shipment_date') THEN
        RAISE EXCEPTION 'DELIVERY_RECORD_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
    IF (pg_catalog.to_jsonb(NEW) - 'cancelled_at' - 'cancelled_by')
         IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'cancelled_at' - 'cancelled_by') THEN
      v_change := pg_catalog.current_setting('app.fulfillment_change', true);
      IF v_change IS NULL OR v_change NOT IN ('tracking_edit', 'manual', 'tracking')
         OR CURRENT_USER IS DISTINCT FROM (
           SELECT pg_catalog.pg_get_userbyid(p.proowner)
           FROM pg_catalog.pg_proc AS p
           WHERE p.oid = 'public.admin_create_fulfillment(uuid,uuid,uuid,text,text,boolean,jsonb)'::pg_catalog.regprocedure
         )
         OR OLD.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION 'DELIVERY_RECORD_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      v_allowed := ARRAY[
        'shipping_carrier', 'tracking_number', 'notify_customer',
        'delivery_status', 'delivery_status_at', 'delivered_at', 'tracking_version'
      ];
      IF OLD.request_fingerprint IS NULL AND NEW.request_fingerprint IS NOT NULL
         AND v_change = 'tracking_edit' THEN
        v_allowed := pg_catalog.array_append(v_allowed, 'request_fingerprint');
      END IF;
      IF (pg_catalog.to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - v_allowed)
         OR (v_change = 'tracking_edit' AND NEW.tracking_version <> OLD.tracking_version + 1)
         OR (v_change <> 'tracking_edit' AND NEW.tracking_version <> OLD.tracking_version)
         OR (v_change = 'tracking' AND OLD.delivery_status = 'delivered' AND NEW.delivery_status <> 'delivered') THEN
        RAISE EXCEPTION 'DELIVERY_RECORD_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - 'cancelled_at' - 'cancelled_by')
       IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'cancelled_at' - 'cancelled_by')
     OR OLD.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION '% allows only one cancellation', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER shipment_slips_change_guard BEFORE UPDATE OR DELETE ON public.shipment_slips
  FOR EACH ROW EXECUTE FUNCTION private.guard_group_g_shipment_slip_change();
CREATE TRIGGER shipment_slips_no_truncate BEFORE TRUNCATE ON public.shipment_slips
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_lines_no_update BEFORE UPDATE ON public.shipment_slip_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_lines_no_delete BEFORE DELETE ON public.shipment_slip_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_lines_no_truncate BEFORE TRUNCATE ON public.shipment_slip_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_fulfillments_no_update BEFORE UPDATE ON public.shipment_slip_fulfillments
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_fulfillments_no_delete BEFORE DELETE ON public.shipment_slip_fulfillments
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_fulfillments_no_truncate BEFORE TRUNCATE ON public.shipment_slip_fulfillments
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_versions_no_update BEFORE UPDATE ON public.shipment_slip_versions
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_versions_no_delete BEFORE DELETE ON public.shipment_slip_versions
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_slip_versions_no_truncate BEFORE TRUNCATE ON public.shipment_slip_versions
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_date_history_no_update BEFORE UPDATE ON public.shipment_date_history
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_date_history_no_delete BEFORE DELETE ON public.shipment_date_history
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_date_history_no_truncate BEFORE TRUNCATE ON public.shipment_date_history
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_tracking_registrations_no_update BEFORE UPDATE ON private.shipment_tracking_registrations
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_tracking_registrations_no_delete BEFORE DELETE ON private.shipment_tracking_registrations
  FOR EACH ROW EXECUTE FUNCTION private.reject_group_g_event_mutation();
CREATE TRIGGER shipment_tracking_registrations_no_truncate BEFORE TRUNCATE ON private.shipment_tracking_registrations
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_group_g_event_mutation();

CREATE CONSTRAINT TRIGGER group_g_shipment_consumption AFTER INSERT ON public.order_fulfillment_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_group_g_shipment_consumption();
CREATE CONSTRAINT TRIGGER group_g_shipment_consumption AFTER UPDATE OF cancelled_at ON public.order_fulfillments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_group_g_shipment_consumption();
CREATE CONSTRAINT TRIGGER group_g_shipment_consumption AFTER INSERT ON public.order_item_allocation_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.event_type IN ('consume','restore'))
  EXECUTE FUNCTION private.check_group_g_shipment_consumption();

-- 5. RLS is defence in depth: no application role, including service_role, has table access.
ALTER TABLE public.shipment_slips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_slip_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_slip_fulfillments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_slip_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_date_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.shipment_tracking_registrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny direct client access" ON public.shipment_slips
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.shipment_slip_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.shipment_slip_fulfillments
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.shipment_slip_versions
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON public.shipment_date_history
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny direct client access" ON private.shipment_tracking_registrations
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.shipment_slips, public.shipment_slip_lines,
  public.shipment_slip_fulfillments, public.shipment_slip_versions,
  public.shipment_date_history, private.shipment_tracking_registrations
  FROM PUBLIC, anon, authenticated, service_role;

-- 6. The same seventeen reasons are defined by ALLOCATION_EVENT_REASON_CODES.
ALTER TABLE public.order_item_allocation_events DROP CONSTRAINT order_item_allocation_events_reason_check;
ALTER TABLE public.order_item_allocation_events ADD CONSTRAINT order_item_allocation_events_reason_check CHECK (
  reason IS NULL OR reason IN (
    'fifo','checkout','stripe_payment_paid','stock_adjustment','refund_restock','refund_release',
    'stripe_checkout_expired','stripe_voucher_expired','admin_cancel','admin_cancel_failed_order',
    'resolve_payment_exception','status_change','fixture_allocation','fixture_release','fixture_shipment',
    'shipment_confirm','shipment_cancel'
  )
);

-- 7. PostgreSQL cannot replace a function while changing its TABLE return shape.
DROP FUNCTION public.item_delete_blockers(bigint[]);
CREATE FUNCTION public.item_delete_blockers(_item_ids bigint[])
RETURNS TABLE (item_id bigint, has_orders boolean, has_stock_movements boolean, has_open_checkouts boolean, has_purchase_orders boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ids.id,
         EXISTS (SELECT 1 FROM public.order_items AS oi WHERE oi.item_id = ids.id),
         EXISTS (
           SELECT 1 FROM public.stock_movements AS m
           JOIN public.item_variants AS v ON v.id = m.variant_id WHERE v.item_id = ids.id
         ),
         EXISTS (SELECT 1 FROM public.find_open_checkout_sessions_for_item(ids.id)),
         EXISTS (
           SELECT 1 FROM public.purchase_order_lines AS l
           JOIN public.item_variants AS v ON v.id = l.variant_id WHERE v.item_id = ids.id
         )
  FROM pg_catalog.unnest(_item_ids) AS ids(id);
$$;
ALTER FUNCTION public.item_delete_blockers(bigint[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.item_delete_blockers(bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.item_delete_blockers(bigint[]) TO service_role;
-- G3A_BODY_END

-- G3A_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never textual ACLs or the whole existing-data population.
DO $g3a_final_objects$
DECLARE
  v_failed text;
  v_tables regclass[] := ARRAY[
    pg_catalog.to_regclass('public.shipment_slips'), pg_catalog.to_regclass('public.shipment_slip_lines'),
    pg_catalog.to_regclass('public.shipment_slip_fulfillments'), pg_catalog.to_regclass('public.shipment_slip_versions'),
    pg_catalog.to_regclass('public.shipment_date_history'), pg_catalog.to_regclass('private.shipment_tracking_registrations')
  ];
BEGIN
  -- Six tables, exact column shape, owner, restrictive policy, named keys/checks and indexes.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class AS c
      WHERE c.oid = ANY(v_tables) AND c.relkind = 'r' AND c.relowner = 'postgres'::regrole AND c.relrowsecurity) <> 6
     OR EXISTS (
       SELECT 1 FROM (VALUES
         ('public.shipment_slips',32),('public.shipment_slip_lines',4),('public.shipment_slip_fulfillments',4),
         ('public.shipment_slip_versions',11),('public.shipment_date_history',10),('private.shipment_tracking_registrations',7)
       ) AS e(rel, cols)
       WHERE (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS a
         WHERE a.attrelid = pg_catalog.to_regclass(e.rel) AND a.attnum > 0 AND NOT a.attisdropped) <> e.cols
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(r)
       WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS p
         WHERE p.polrelid = t.r AND p.polname = 'deny direct client access' AND NOT p.polpermissive AND p.polcmd = '*'
           AND pg_catalog.pg_get_expr(p.polqual,p.polrelid) = 'false'
           AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) = 'false'
           AND (SELECT pg_catalog.array_agg(r ORDER BY r) FROM pg_catalog.unnest(p.polroles) AS u(r))
             = (SELECT pg_catalog.array_agg(r ORDER BY r)
                FROM pg_catalog.unnest(ARRAY['anon'::regrole::oid,'authenticated'::regrole::oid]) AS u(r)))
     )
     OR EXISTS (
       SELECT 1 FROM (VALUES
         ('public.shipment_slips','shipment_slips_pkey','p'),
         ('public.shipment_slips','shipment_slips_number_key','u'),
         ('public.shipment_slips','shipment_slips_confirm_request_key_key','u'),
         ('public.shipment_slips','shipment_slips_number_check','c'),
         ('public.shipment_slips','shipment_slips_stage_check','c'),
         ('public.shipment_slips','shipment_slips_customer_check','c'),
         ('public.shipment_slips','shipment_slips_expires_check','c'),
         ('public.shipment_slips','shipment_slips_confirmed_check','c'),
         ('public.shipment_slips','shipment_slips_cancelled_check','c'),
         ('public.shipment_slips','shipment_slips_discarded_check','c'),
         ('public.shipment_slips','shipment_slips_tracking_check','c'),
         ('public.shipment_slip_lines','shipment_slip_lines_pkey','p'),
         ('public.shipment_slip_lines','shipment_slip_lines_quantity_check','c'),
         ('public.shipment_slip_fulfillments','shipment_slip_fulfillments_pkey','p'),
         ('public.shipment_slip_fulfillments','shipment_slip_fulfillments_fulfillment_id_key','u'),
         ('public.shipment_slip_versions','shipment_slip_versions_pkey','p'),
         ('public.shipment_slip_versions','shipment_slip_versions_kind_check','c'),
         ('public.shipment_date_history','shipment_date_history_pkey','p'),
         ('public.shipment_date_history','shipment_date_history_slip_id_version_key','u'),
         ('public.shipment_date_history','shipment_date_history_reason_check','c'),
         ('private.shipment_tracking_registrations','shipment_tracking_registrations_pkey','p'),
         ('private.shipment_tracking_registrations','shipment_tracking_registrations_leader_version_key','u')
       ) AS e(rel,name,kind)
       WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
         WHERE c.conrelid = pg_catalog.to_regclass(e.rel) AND c.conname = e.name AND c.contype::text = e.kind AND c.convalidated)
     )
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = ANY(v_tables) AND c.contype = 'f'
       AND (c.confdeltype <> 'r' OR c.confupdtype <> 'a' OR NOT c.convalidated
         OR c.condeferrable <> (c.confrelid = 'private.group_g_operations'::regclass)
         OR c.condeferred <> c.condeferrable))
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index AS i
       WHERE i.indexrelid = pg_catalog.to_regclass('public.shipment_slips_stage_updated_idx') AND i.indisvalid)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index AS i
       WHERE i.indexrelid = pg_catalog.to_regclass('public.shipment_slip_lines_order_item_idx') AND i.indisvalid) THEN
    v_failed := 'shipping_tables';
  ELSIF EXISTS (
    WITH expected(rel,token) AS (
      SELECT e.rel,x.token FROM (VALUES
        ('shipment_slips','change_guard:27:g,no_truncate:34:r'),
        ('shipment_slip_lines','no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('shipment_slip_fulfillments','no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('shipment_slip_versions','no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('shipment_date_history','no_update:19:r,no_delete:11:r,no_truncate:34:r'),
        ('shipment_tracking_registrations','no_update:19:r,no_delete:11:r,no_truncate:34:r')
      ) AS e(rel,trig) CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.string_to_array(e.trig,',')) AS x(token)
    ), actual(rel,token) AS (
      SELECT c.relname::text, pg_catalog.replace(t.tgname::text,c.relname::text || '_','') || ':' || t.tgtype::text || ':'
        || CASE WHEN t.tgfoid = 'private.reject_group_g_event_mutation()'::regprocedure THEN 'r'
                WHEN t.tgfoid = 'private.guard_group_g_shipment_slip_change()'::regprocedure THEN 'g' ELSE '?' END
        || CASE WHEN t.tgenabled = 'O' AND NOT t.tgdeferrable AND t.tgqual IS NULL THEN '' ELSE '!' END
      FROM pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
      WHERE t.tgrelid = ANY(v_tables) AND NOT t.tgisinternal
    )
    SELECT 1 FROM expected AS e FULL JOIN actual AS a ON a.rel = e.rel AND a.token = e.token
    WHERE e.token IS NULL OR a.token IS NULL
  ) THEN
    v_failed := 'shipping_table_triggers';
  ELSIF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
      WHERE t.tgname = 'group_g_shipment_consumption' AND NOT t.tgisinternal) <> 3
     OR EXISTS (
       SELECT 1 FROM (VALUES ('public.order_fulfillment_lines',5),('public.order_fulfillments',17),
         ('public.order_item_allocation_events',5)) AS e(rel,kind)
       WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
         JOIN pg_catalog.pg_constraint AS c ON c.oid = t.tgconstraint
         WHERE t.tgrelid = e.rel::regclass AND t.tgname = 'group_g_shipment_consumption' AND t.tgtype = e.kind
           AND t.tgenabled = 'O' AND t.tgdeferrable AND t.tginitdeferred AND c.contype = 't'
           AND c.condeferrable AND c.condeferred
           AND t.tgfoid = 'private.check_group_g_shipment_consumption()'::regprocedure
           AND CASE WHEN e.rel = 'public.order_fulfillments' THEN
             t.tgattr::text = (SELECT a.attnum::text FROM pg_catalog.pg_attribute AS a
               WHERE a.attrelid = t.tgrelid AND a.attname = 'cancelled_at') AND t.tgqual IS NULL
             WHEN e.rel = 'public.order_item_allocation_events' THEN
               t.tgattr::text = '' AND t.tgqual IS NOT NULL
               AND pg_catalog.regexp_replace(pg_catalog.pg_get_triggerdef(t.oid), '[ ()]|::text', '', 'g')
                 LIKE '%WHENnew.event_type=ANYARRAY[''consume'',''restore'']EXECUTEFUNCTION%'
             ELSE t.tgattr::text = '' AND t.tgqual IS NULL END)
     ) THEN
    v_failed := 'shipping_consumption_triggers';
  ELSIF EXISTS (SELECT 1 FROM public.shipment_slips WHERE created_at = pg_catalog.transaction_timestamp())
     OR EXISTS (SELECT 1 FROM public.shipment_slip_lines WHERE created_at = pg_catalog.transaction_timestamp())
     OR EXISTS (SELECT 1 FROM public.shipment_slip_fulfillments WHERE created_at = pg_catalog.transaction_timestamp())
     OR EXISTS (SELECT 1 FROM public.shipment_slip_versions WHERE created_at = pg_catalog.transaction_timestamp())
     OR EXISTS (SELECT 1 FROM public.shipment_date_history WHERE created_at = pg_catalog.transaction_timestamp())
     OR EXISTS (SELECT 1 FROM private.shipment_tracking_registrations WHERE created_at = pg_catalog.transaction_timestamp()) THEN
    v_failed := 'shipping_table_rows';
  ELSIF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
       WHERE a.attrelid = 'public.order_fulfillments'::regclass AND a.attname = 'shipment_date'
         AND a.atttypid = 'date'::regtype AND NOT a.attisdropped AND NOT a.attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
       WHERE c.conrelid = 'public.order_fulfillments'::regclass AND c.conname = 'order_fulfillments_shipment_date_check'
         AND c.contype = 'c' AND c.convalidated
         AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid), '[ ()]', '', 'g') = 'legacyORshipment_dateISNOTNULL')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
       WHERE c.conrelid = 'public.order_fulfillments'::regclass AND c.conname = 'order_fulfillments_tracking_check'
         AND c.contype = 'c' AND c.convalidated
         AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid), '[ ()]', '', 'g') = 'legacyORshipping_carrierISNULL=tracking_numberISNULL') THEN
    v_failed := 'shipping_fulfillment_columns';
  ELSIF EXISTS (
    SELECT 1 FROM (VALUES ('private.guard_group_g_shipment_slip_change()',true),
      ('private.check_group_g_shipment_consumption()',true),('private.restrict_fulfillment_record_update()',false)) AS e(sig,definer)
    LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(e.sig)
    WHERE p.oid IS NULL OR p.proowner <> 'postgres'::regrole OR p.prosecdef <> e.definer
       OR p.prorettype <> 'trigger'::regtype OR p.proretset OR p.provolatile <> 'v'
       OR NOT (COALESCE(p.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=""'])
       OR NOT pg_catalog.has_function_privilege('postgres',p.oid,'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS x
         WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
       OR (e.definer AND EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) AS g(role)
         WHERE pg_catalog.has_function_privilege(g.role,p.oid,'EXECUTE')))
  ) THEN
    v_failed := 'shipping_guard_functions';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = 'public.order_item_allocation_events'::regclass AND c.conname = 'order_item_allocation_events_reason_check'
      AND c.contype = 'c' AND c.convalidated
      AND (SELECT pg_catalog.array_agg(m[1] ORDER BY m[1])
           FROM pg_catalog.regexp_matches(pg_catalog.pg_get_expr(c.conbin,c.conrelid), '''([^'']+)''', 'g') AS x(m))
        = (SELECT pg_catalog.array_agg(r ORDER BY r) FROM pg_catalog.unnest(ARRAY[
          'fifo','checkout','stripe_payment_paid','stock_adjustment','refund_restock','refund_release',
          'stripe_checkout_expired','stripe_voucher_expired','admin_cancel','admin_cancel_failed_order',
          'resolve_payment_exception','status_change','fixture_allocation','fixture_release','fixture_shipment',
          'shipment_confirm','shipment_cancel']) AS e(r))
      AND pg_catalog.pg_get_expr(c.conbin,c.conrelid) LIKE '%reason IS NULL%'
  ) THEN
    v_failed := 'shipping_reason_codes';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure('public.item_delete_blockers(bigint[])')
      AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 's' AND p.proretset
      AND p.prorettype = 'record'::regtype AND p.proargnames = ARRAY['_item_ids','item_id','has_orders','has_stock_movements','has_open_checkouts','has_purchase_orders']
      AND p.proallargtypes = ARRAY['bigint[]'::regtype::oid,'bigint'::regtype::oid,'boolean'::regtype::oid,'boolean'::regtype::oid,'boolean'::regtype::oid,'boolean'::regtype::oid]
      AND p.proargmodes = ARRAY['i','t','t','t','t','t']::"char"[]
      AND COALESCE(p.proconfig,ARRAY[]::text[]) @> ARRAY['search_path=""']
      AND pg_catalog.has_function_privilege('postgres',p.oid,'EXECUTE')
      AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS x
        WHERE x.grantee = 0 AND x.privilege_type = 'EXECUTE')
  ) THEN
    v_failed := 'shipping_delete_blockers';
  END IF;
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
END
$g3a_final_objects$;

-- Semantic table and column ACL checks tolerate unrelated grantees and ACL ordering.
-- PostgreSQL 17 adds MAINTAIN: it is also forbidden to every application role.
DO $g3a_final_table_acl$
DECLARE
  v_maintain text[] := CASE WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
    THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
  v_all text[] := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] || v_maintain;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.unnest(ARRAY[
      'public.shipment_slips','public.shipment_slip_lines','public.shipment_slip_fulfillments',
      'public.shipment_slip_versions','public.shipment_date_history','private.shipment_tracking_registrations'
    ]) AS e(rel)
    CROSS JOIN LATERAL (SELECT pg_catalog.to_regclass(e.rel) AS r) AS t
    WHERE t.r IS NULL
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_all) AS p(priv)
         WHERE NOT pg_catalog.has_table_privilege('postgres',t.r,p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_all) AS p(priv)
         WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
           (SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = t.r),pg_catalog.acldefault('r','postgres'::regrole))) AS x
           WHERE x.grantee = 'postgres'::regrole AND x.privilege_type = p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
         (SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = t.r),pg_catalog.acldefault('r','postgres'::regrole))) AS x
         WHERE x.grantee = 0)
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) AS g(role)
         CROSS JOIN pg_catalog.unnest(v_all) AS p(priv) WHERE pg_catalog.has_table_privilege(g.role,t.r,p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon','authenticated','service_role']) AS g(role)
         CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p(priv)
         WHERE pg_catalog.has_any_column_privilege(g.role,t.r,p.priv))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
         CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS x
         WHERE a.attrelid = t.r AND a.attnum > 0 AND NOT a.attisdropped AND x.grantee = 0)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'shipping_table_acl';
  END IF;
END
$g3a_final_table_acl$;
-- G3A_FINAL_ASSERT_END

NOTIFY pgrst, 'reload schema';
COMMIT;
