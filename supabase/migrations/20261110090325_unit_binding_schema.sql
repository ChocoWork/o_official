BEGIN;

-- Unit binding, migration A (FREQ-642), 2026-11-10: the tables of the per-unit record, the order-time discount snapshot,
-- the prior-units count by kept slots, and the reason settings of defective and wrong-item returns.
-- @impl FREQ-642-AC-16 FREQ-642-AC-20 FREQ-642-AC-30
-- @design docs/superpowers/specs/2026-11-08-exchange-unit-binding-design.md
-- 1. Eight new public tables (RLS, service_role SELECT only, written by private functions only). Seven are append only
--    (UPDATE, DELETE and TRUNCATE are refused with GROUP_H_IMMUTABLE); order_unit_slots is the one mutable state table
--    (its rows are never deleted; the state moves only through the receive and refund functions of the next migrations).
-- 2. private.group_h_copy_order_discounts also writes one order_discount_snapshots row and one order_unit_slots row per
--    unit of an H order. Everything else it does is unchanged.
-- 3. private.get_checkout_discount_context counts the prior units of a member by kept slots for an order that has slots
--    and by the old formula for an order that has none. Everything else it does is unchanged.
-- 4. shop_return_reason_settings: defective and wrong_item accept an exchange only.
-- Applied migrations are never edited. The G writer allowlist is not changed here.

-- UB_SCHEMA_BEGIN
CREATE TABLE public.order_discount_snapshots (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  engine_version smallint NOT NULL,
  definitions jsonb NOT NULL,
  codes text[] NOT NULL,
  facts jsonb NOT NULL,
  lines jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_discount_snapshots_shape_check CHECK (
    pg_catalog.jsonb_typeof(definitions) = 'array' AND pg_catalog.jsonb_typeof(facts) = 'object'
    AND pg_catalog.jsonb_typeof(lines) = 'array')
);

CREATE TABLE public.order_unit_slots (
  order_item_id uuid NOT NULL,
  unit_index integer NOT NULL,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  item_id bigint NOT NULL,
  state text NOT NULL DEFAULT 'kept' CHECK (state IN ('kept', 'returned_customer', 'returned_shop')),
  current_price integer NOT NULL CHECK (current_price >= 0),
  holder_order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  holder_unit_index integer NOT NULL CHECK (holder_unit_index >= 0),
  last_event_id uuid,
  PRIMARY KEY (order_item_id, unit_index),
  FOREIGN KEY (order_item_id, unit_index) REFERENCES public.order_line_unit_amounts(order_item_id, unit_index) ON DELETE RESTRICT
);
CREATE INDEX order_unit_slots_order_idx ON public.order_unit_slots(order_id);
CREATE INDEX order_unit_slots_item_state_idx ON public.order_unit_slots(item_id, state);
CREATE INDEX order_unit_slots_holder_idx ON public.order_unit_slots(holder_order_item_id, holder_unit_index);

CREATE TABLE public.order_unit_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('return_receive', 'pre_shipment_cancel', 'cancel_reverted', 'hold_release')),
  request_key uuid,
  return_id uuid REFERENCES public.order_returns(id) ON DELETE RESTRICT,
  receipt_id uuid REFERENCES public.order_return_receipts(id) ON DELETE RESTRICT,
  reverts_event_id uuid UNIQUE REFERENCES public.order_unit_events(id) ON DELETE RESTRICT,
  entitlement_previous integer NOT NULL DEFAULT 0,
  entitlement_max_before integer NOT NULL DEFAULT 0,
  entitlement_gross integer NOT NULL DEFAULT 0,
  entitlement_shop_only integer NOT NULL DEFAULT 0,
  fee_amount integer NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  hold_total integer NOT NULL DEFAULT 0 CHECK (hold_total >= 0),
  entitlement integer NOT NULL DEFAULT 0,
  standard_refund integer NOT NULL DEFAULT 0 CHECK (standard_refund >= 0),
  now_refund integer NOT NULL DEFAULT 0 CHECK (now_refund >= 0),
  consult_refund integer NOT NULL DEFAULT 0 CHECK (consult_refund >= 0),
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT order_unit_events_refund_split_check CHECK (now_refund + consult_refund = standard_refund)
);
CREATE INDEX order_unit_events_order_idx ON public.order_unit_events(order_id, seq);
CREATE INDEX order_unit_events_return_idx ON public.order_unit_events(return_id) WHERE return_id IS NOT NULL;
CREATE INDEX order_unit_events_request_key_idx ON public.order_unit_events(request_key) WHERE request_key IS NOT NULL;

ALTER TABLE public.order_unit_slots
  ADD CONSTRAINT order_unit_slots_last_event_fkey FOREIGN KEY (last_event_id) REFERENCES public.order_unit_events(id) ON DELETE RESTRICT;

CREATE TABLE public.order_unit_exchange_links (
  exchange_order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  exchange_unit_index integer NOT NULL CHECK (exchange_unit_index >= 0),
  slot_order_item_id uuid NOT NULL,
  slot_unit_index integer NOT NULL,
  previous_order_item_id uuid REFERENCES public.order_items(id) ON DELETE RESTRICT,
  previous_unit_index integer CHECK (previous_unit_index >= 0),
  receipt_id uuid NOT NULL REFERENCES public.order_return_receipts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (exchange_order_item_id, exchange_unit_index),
  FOREIGN KEY (slot_order_item_id, slot_unit_index) REFERENCES public.order_unit_slots(order_item_id, unit_index) ON DELETE RESTRICT,
  CONSTRAINT order_unit_exchange_links_previous_check CHECK ((previous_order_item_id IS NULL) = (previous_unit_index IS NULL))
);
CREATE INDEX order_unit_exchange_links_slot_idx ON public.order_unit_exchange_links(slot_order_item_id, slot_unit_index);

CREATE TABLE public.order_unit_event_lines (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.order_unit_events(id) ON DELETE RESTRICT,
  line_kind text NOT NULL CHECK (line_kind IN ('returned', 'kept', 'hold')),
  order_item_id uuid,
  unit_index integer,
  slot_order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  holder_order_item_id uuid REFERENCES public.order_items(id) ON DELETE RESTRICT,
  holder_unit_index integer,
  state_before text CHECK (state_before IN ('kept', 'returned_customer', 'returned_shop')),
  state_after text CHECK (state_after IN ('kept', 'returned_customer', 'returned_shop')),
  price_before integer,
  price_after integer,
  allocation integer NOT NULL,
  correction integer NOT NULL,
  part text CHECK (part IN ('now', 'consult')),
  return_line_id uuid REFERENCES public.order_return_lines(id) ON DELETE RESTRICT,
  shipped boolean NOT NULL,
  FOREIGN KEY (order_item_id, unit_index) REFERENCES public.order_unit_slots(order_item_id, unit_index) ON DELETE RESTRICT,
  CONSTRAINT order_unit_event_lines_unit_check CHECK ((order_item_id IS NULL) = (unit_index IS NULL))
);
CREATE INDEX order_unit_event_lines_event_idx ON public.order_unit_event_lines(event_id);
CREATE INDEX order_unit_event_lines_unit_idx ON public.order_unit_event_lines(order_item_id, unit_index);

CREATE TABLE public.order_unit_holds (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.order_unit_events(id) ON DELETE RESTRICT,
  held_order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  later_order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  item_id bigint NOT NULL,
  amount integer NOT NULL CHECK (amount <> 0),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX order_unit_holds_event_idx ON public.order_unit_holds(event_id);
CREATE INDEX order_unit_holds_held_idx ON public.order_unit_holds(held_order_id);
CREATE INDEX order_unit_holds_later_idx ON public.order_unit_holds(later_order_id);

CREATE TABLE public.order_unit_event_refunds (
  event_id uuid NOT NULL REFERENCES public.order_unit_events(id) ON DELETE RESTRICT,
  refund_id uuid NOT NULL REFERENCES public.order_refunds(id) ON DELETE RESTRICT,
  part text NOT NULL CHECK (part IN ('now', 'consult', 'release')),
  PRIMARY KEY (event_id, refund_id)
);
CREATE INDEX order_unit_event_refunds_refund_idx ON public.order_unit_event_refunds(refund_id);

CREATE TABLE public.order_return_line_treatments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  return_line_id uuid NOT NULL REFERENCES public.order_return_lines(id) ON DELETE RESTRICT,
  treatment text NOT NULL CHECK (treatment IN ('shop', 'customer')),
  receipt_id uuid REFERENCES public.order_return_receipts(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX order_return_line_treatments_line_idx ON public.order_return_line_treatments(return_line_id, created_at);
-- UB_SCHEMA_END

-- UB_ACL_BEGIN
-- Append only. The slot table also refuses DELETE and TRUNCATE, but its rows may be updated by the private functions.
CREATE TRIGGER ub_order_discount_snapshots_immutable BEFORE UPDATE OR DELETE ON public.order_discount_snapshots
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_discount_snapshots_truncate BEFORE TRUNCATE ON public.order_discount_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_slots_no_delete BEFORE DELETE ON public.order_unit_slots
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_slots_truncate BEFORE TRUNCATE ON public.order_unit_slots
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_exchange_links_immutable BEFORE UPDATE OR DELETE ON public.order_unit_exchange_links
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_exchange_links_truncate BEFORE TRUNCATE ON public.order_unit_exchange_links
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_events_immutable BEFORE UPDATE OR DELETE ON public.order_unit_events
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_events_truncate BEFORE TRUNCATE ON public.order_unit_events
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_event_lines_immutable BEFORE UPDATE OR DELETE ON public.order_unit_event_lines
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_event_lines_truncate BEFORE TRUNCATE ON public.order_unit_event_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_holds_immutable BEFORE UPDATE OR DELETE ON public.order_unit_holds
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_holds_truncate BEFORE TRUNCATE ON public.order_unit_holds
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_event_refunds_immutable BEFORE UPDATE OR DELETE ON public.order_unit_event_refunds
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_unit_event_refunds_truncate BEFORE TRUNCATE ON public.order_unit_event_refunds
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_return_line_treatments_immutable BEFORE UPDATE OR DELETE ON public.order_return_line_treatments
  FOR EACH ROW EXECUTE FUNCTION private.group_h_immutable();
CREATE TRIGGER ub_order_return_line_treatments_truncate BEFORE TRUNCATE ON public.order_return_line_treatments
  FOR EACH STATEMENT EXECUTE FUNCTION private.group_h_immutable();

ALTER TABLE public.order_discount_snapshots ENABLE ALWAYS TRIGGER ub_order_discount_snapshots_immutable;
ALTER TABLE public.order_discount_snapshots ENABLE ALWAYS TRIGGER ub_order_discount_snapshots_truncate;
ALTER TABLE public.order_unit_slots ENABLE ALWAYS TRIGGER ub_order_unit_slots_no_delete;
ALTER TABLE public.order_unit_slots ENABLE ALWAYS TRIGGER ub_order_unit_slots_truncate;
ALTER TABLE public.order_unit_exchange_links ENABLE ALWAYS TRIGGER ub_order_unit_exchange_links_immutable;
ALTER TABLE public.order_unit_exchange_links ENABLE ALWAYS TRIGGER ub_order_unit_exchange_links_truncate;
ALTER TABLE public.order_unit_events ENABLE ALWAYS TRIGGER ub_order_unit_events_immutable;
ALTER TABLE public.order_unit_events ENABLE ALWAYS TRIGGER ub_order_unit_events_truncate;
ALTER TABLE public.order_unit_event_lines ENABLE ALWAYS TRIGGER ub_order_unit_event_lines_immutable;
ALTER TABLE public.order_unit_event_lines ENABLE ALWAYS TRIGGER ub_order_unit_event_lines_truncate;
ALTER TABLE public.order_unit_holds ENABLE ALWAYS TRIGGER ub_order_unit_holds_immutable;
ALTER TABLE public.order_unit_holds ENABLE ALWAYS TRIGGER ub_order_unit_holds_truncate;
ALTER TABLE public.order_unit_event_refunds ENABLE ALWAYS TRIGGER ub_order_unit_event_refunds_immutable;
ALTER TABLE public.order_unit_event_refunds ENABLE ALWAYS TRIGGER ub_order_unit_event_refunds_truncate;
ALTER TABLE public.order_return_line_treatments ENABLE ALWAYS TRIGGER ub_order_return_line_treatments_immutable;
ALTER TABLE public.order_return_line_treatments ENABLE ALWAYS TRIGGER ub_order_return_line_treatments_truncate;

ALTER TABLE public.order_discount_snapshots OWNER TO postgres;
ALTER TABLE public.order_unit_slots OWNER TO postgres;
ALTER TABLE public.order_unit_exchange_links OWNER TO postgres;
ALTER TABLE public.order_unit_events OWNER TO postgres;
ALTER TABLE public.order_unit_event_lines OWNER TO postgres;
ALTER TABLE public.order_unit_holds OWNER TO postgres;
ALTER TABLE public.order_unit_event_refunds OWNER TO postgres;
ALTER TABLE public.order_return_line_treatments OWNER TO postgres;

ALTER TABLE public.order_discount_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_unit_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_unit_exchange_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_unit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_unit_event_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_unit_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_unit_event_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_return_line_treatments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny direct client access" ON public.order_discount_snapshots;
CREATE POLICY "deny direct client access" ON public.order_discount_snapshots
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_unit_slots;
CREATE POLICY "deny direct client access" ON public.order_unit_slots
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_unit_exchange_links;
CREATE POLICY "deny direct client access" ON public.order_unit_exchange_links
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_unit_events;
CREATE POLICY "deny direct client access" ON public.order_unit_events
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_unit_event_lines;
CREATE POLICY "deny direct client access" ON public.order_unit_event_lines
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_unit_holds;
CREATE POLICY "deny direct client access" ON public.order_unit_holds
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_unit_event_refunds;
CREATE POLICY "deny direct client access" ON public.order_unit_event_refunds
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "deny direct client access" ON public.order_return_line_treatments;
CREATE POLICY "deny direct client access" ON public.order_return_line_treatments
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON public.order_discount_snapshots FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_unit_slots FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_unit_exchange_links FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_unit_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_unit_event_lines FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_unit_holds FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_unit_event_refunds FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.order_return_line_treatments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.order_discount_snapshots TO service_role;
GRANT SELECT ON public.order_unit_slots TO service_role;
GRANT SELECT ON public.order_unit_exchange_links TO service_role;
GRANT SELECT ON public.order_unit_events TO service_role;
GRANT SELECT ON public.order_unit_event_lines TO service_role;
GRANT SELECT ON public.order_unit_holds TO service_role;
GRANT SELECT ON public.order_unit_event_refunds TO service_role;
GRANT SELECT ON public.order_return_line_treatments TO service_role;
REVOKE ALL ON SEQUENCE public.order_unit_events_seq_seq FROM PUBLIC, anon, authenticated, service_role;
-- UB_ACL_END

-- UB_FUNCTIONS_BEGIN
-- Same signature and body as H4 (20261029130300), plus the snapshot row and the slot rows after the unit amounts.
CREATE OR REPLACE FUNCTION private.group_h_copy_order_discounts(_draft_id uuid,_order_id uuid,_line_map jsonb) RETURNS void
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
  -- The order-time snapshot: the definitions that took an amount, the facts of the draft, and the order lines (unit price before discount).
  INSERT INTO public.order_discount_snapshots(order_id,engine_version,definitions,codes,facts,lines)
    SELECT _order_id,v_draft.discount_engine_version,
      COALESCE((SELECT pg_catalog.jsonb_agg(private.group_h_definition(x.discount_id) ORDER BY x.discount_id)
        FROM (SELECT DISTINCT (e->>'discountId')::uuid AS discount_id FROM pg_catalog.jsonb_array_elements(v_draft.discount_result->'applied') AS t(e)
          WHERE (e->>'amount')::integer>0) AS x),'[]'::jsonb),
      COALESCE((SELECT pg_catalog.array_agg(DISTINCT e->>'code' ORDER BY e->>'code')
        FROM pg_catalog.jsonb_array_elements(v_draft.discount_result->'applied') AS t(e)
        WHERE (e->>'amount')::integer>0 AND e->>'code' IS NOT NULL),ARRAY[]::text[]),
      pg_catalog.jsonb_build_object('priorUnitsByItem',v_draft.discount_facts->'priorUnitsByItem','buyer',v_draft.discount_facts->'buyer',
        'at',v_draft.discount_facts->'at','hasPreviousOrder',v_draft.discount_facts->'hasPreviousOrder',
        'hasFirstOrderReservation',v_draft.discount_facts->'hasFirstOrderReservation','usage',v_draft.discount_facts->'usage'),
      COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('lineKey',m->>'lineKey','orderItemId',m->>'orderItemId',
          'itemId',oi.item_id,'unitPrice',oi.item_price,'quantity',oi.quantity) ORDER BY m->>'lineKey')
        FROM pg_catalog.jsonb_array_elements(_line_map) AS maps(m)
        JOIN public.order_items AS oi ON oi.id=(m->>'orderItemId')::uuid AND oi.order_id=_order_id AND oi.line_kind='order'),'[]'::jsonb);
  -- One slot per unit: kept, priced at what was paid, held by itself.
  INSERT INTO public.order_unit_slots(order_item_id,unit_index,order_id,item_id,current_price,holder_order_item_id,holder_unit_index)
    SELECT u.order_item_id,u.unit_index,u.order_id,oi.item_id,u.paid_amount,u.order_item_id,u.unit_index
    FROM public.order_line_unit_amounts AS u JOIN public.order_items AS oi ON oi.id=u.order_item_id
    WHERE u.order_id=_order_id;
END;
$$;

-- Same signature and body as H4 (20261029130300); only the member's prior-units statement changes: an order that has slots
-- counts its kept slots, an order without slots (older than this migration) keeps the old formula.
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
      legacy AS (SELECT oi.item_id,pg_catalog.sum(GREATEST(oi.quantity-COALESCE(r.n,0),0))::bigint AS n
        FROM public.orders AS o JOIN public.order_items AS oi ON oi.order_id=o.id LEFT JOIN refunds AS r ON r.order_item_id=oi.id
        WHERE o.user_id=_buyer_user_id AND (o.status IN ('paid','shipped') OR o.paid_amount>0)
          AND oi.line_kind='order' AND oi.item_id=ANY(_item_ids)
          AND NOT EXISTS(SELECT 1 FROM public.order_unit_slots AS s WHERE s.order_id=o.id) GROUP BY oi.item_id),
      slotted AS (SELECT s.item_id,pg_catalog.count(*) FILTER (WHERE s.state='kept')::bigint AS n
        FROM public.orders AS o JOIN public.order_unit_slots AS s ON s.order_id=o.id
        WHERE o.user_id=_buyer_user_id AND (o.status IN ('paid','shipped') OR o.paid_amount>0)
          AND s.item_id=ANY(_item_ids) GROUP BY s.item_id),
      units AS (SELECT t.item_id,pg_catalog.sum(t.n)::bigint AS n
        FROM (SELECT l.item_id,l.n FROM legacy AS l UNION ALL SELECT k.item_id,k.n FROM slotted AS k) AS t GROUP BY t.item_id)
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

ALTER FUNCTION private.group_h_copy_order_discounts(uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.group_h_copy_order_discounts(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text) TO service_role;
-- UB_FUNCTIONS_END

-- UB_SETTINGS_BEGIN
-- Defective and wrong-item returns: the customer's wish is an exchange only (2026-11-10). Only resolutions changes.
UPDATE public.shop_return_reason_settings SET resolutions = 'exchange_only' WHERE reason IN ('defective', 'wrong_item');
-- UB_SETTINGS_END

-- UB_FINAL_ASSERT_BEGIN
DO $ub_final$
DECLARE
  e record; p record; v_oid oid; v_detail text;
BEGIN
  -- ub_tables: columns (name:type in order) and the append-only triggers of the eight tables.
  FOR e IN SELECT * FROM (VALUES
    ('order_discount_snapshots','order_id:uuid,engine_version:smallint,definitions:jsonb,codes:text[],facts:jsonb,lines:jsonb,created_at:timestamp with time zone',2),
    ('order_unit_slots','order_item_id:uuid,unit_index:integer,order_id:uuid,item_id:bigint,state:text,current_price:integer,holder_order_item_id:uuid,holder_unit_index:integer,last_event_id:uuid',2),
    ('order_unit_exchange_links','exchange_order_item_id:uuid,exchange_unit_index:integer,slot_order_item_id:uuid,slot_unit_index:integer,previous_order_item_id:uuid,previous_unit_index:integer,receipt_id:uuid,created_at:timestamp with time zone',2),
    ('order_unit_events','id:uuid,seq:bigint,order_id:uuid,kind:text,request_key:uuid,return_id:uuid,receipt_id:uuid,reverts_event_id:uuid,entitlement_previous:integer,entitlement_max_before:integer,entitlement_gross:integer,entitlement_shop_only:integer,fee_amount:integer,hold_total:integer,entitlement:integer,standard_refund:integer,now_refund:integer,consult_refund:integer,actor_id:uuid,created_at:timestamp with time zone',2),
    ('order_unit_event_lines','id:uuid,event_id:uuid,line_kind:text,order_item_id:uuid,unit_index:integer,slot_order_id:uuid,holder_order_item_id:uuid,holder_unit_index:integer,state_before:text,state_after:text,price_before:integer,price_after:integer,allocation:integer,correction:integer,part:text,return_line_id:uuid,shipped:boolean',2),
    ('order_unit_holds','id:uuid,event_id:uuid,held_order_id:uuid,later_order_id:uuid,item_id:bigint,amount:integer,created_at:timestamp with time zone',2),
    ('order_unit_event_refunds','event_id:uuid,refund_id:uuid,part:text',2),
    ('order_return_line_treatments','id:uuid,return_line_id:uuid,treatment:text,receipt_id:uuid,actor_id:uuid,created_at:timestamp with time zone',2)
  ) AS expected(table_name,columns,triggers) LOOP
    IF (SELECT pg_catalog.string_agg(a.attname||':'||pg_catalog.format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a WHERE a.attrelid=pg_catalog.to_regclass('public.'||e.table_name) AND a.attnum>0 AND NOT a.attisdropped)
        IS DISTINCT FROM e.columns
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid=pg_catalog.to_regclass('public.'||e.table_name)
        AND NOT g.tgisinternal AND g.tgfoid='private.group_h_immutable()'::regprocedure AND g.tgenabled='A')<>e.triggers
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid=pg_catalog.to_regclass('public.'||e.table_name)
        AND NOT g.tgisinternal)<>e.triggers THEN
      v_detail := 'ub_tables'; EXIT; END IF;
    -- The slot table refuses DELETE and TRUNCATE only; every other table also refuses UPDATE.
    IF (e.table_name='order_unit_slots') <> NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger AS g WHERE g.tgrelid=pg_catalog.to_regclass('public.'||e.table_name)
        AND NOT g.tgisinternal AND (g.tgtype & 16)=16) THEN
      v_detail := 'ub_tables'; EXIT; END IF;
  END LOOP;
  IF v_detail IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_unit_events'::regclass
      AND c.contype='c' AND c.conname='order_unit_events_refund_split_check')<>1
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_unit_slots'::regclass AND c.contype='f'
      AND c.confrelid='public.order_line_unit_amounts'::regclass AND c.confdeltype='r')
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_unit_exchange_links'::regclass AND c.contype='f'
      AND c.confrelid='public.order_unit_slots'::regclass AND c.confdeltype='r')
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_unit_slots'::regclass AND c.contype='c')<>3
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c WHERE c.conrelid='public.order_unit_events'::regclass AND c.contype='u')<>2) THEN
    v_detail := 'ub_tables'; END IF;
  -- ub_acl: RLS, the restrictive policy, SELECT only for service_role, nothing for anon and authenticated, postgres owner.
  IF v_detail IS NULL THEN
    FOR e IN SELECT pg_catalog.unnest(ARRAY['order_discount_snapshots','order_unit_slots','order_unit_exchange_links','order_unit_events',
      'order_unit_event_lines','order_unit_holds','order_unit_event_refunds','order_return_line_treatments']) AS table_name LOOP
      v_oid := pg_catalog.to_regclass('public.'||e.table_name)::oid;
      IF NOT (SELECT c.relrowsecurity AND c.relowner='postgres'::regrole FROM pg_catalog.pg_class AS c WHERE c.oid=v_oid)
        OR NOT pg_catalog.has_table_privilege('service_role',v_oid,'SELECT')
        OR pg_catalog.has_table_privilege('service_role',v_oid,'INSERT') OR pg_catalog.has_table_privilege('service_role',v_oid,'UPDATE')
        OR pg_catalog.has_table_privilege('service_role',v_oid,'DELETE') OR pg_catalog.has_table_privilege('service_role',v_oid,'TRUNCATE')
        OR pg_catalog.has_table_privilege('anon',v_oid,'SELECT') OR pg_catalog.has_table_privilege('authenticated',v_oid,'SELECT')
        OR pg_catalog.has_table_privilege('authenticated',v_oid,'UPDATE') OR pg_catalog.has_table_privilege('anon',v_oid,'INSERT')
        OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy AS y WHERE y.polrelid=v_oid AND y.polname='deny direct client access'
          AND NOT y.polpermissive AND y.polcmd='*') THEN
        v_detail := 'ub_acl'; EXIT; END IF;
    END LOOP;
  END IF;
  -- ub_functions: the two replaced bodies are exactly the ones this file wrote, with the H4 signature, owner, ACL and settings.
  IF v_detail IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('group_h_copy_order_discounts(uuid,uuid,jsonb)','void',false,'v',false,'7905f5e5323b8db102098f495a894aa0'),
      ('get_checkout_discount_context(uuid,text,text[],bigint[],timestamptz,text)','jsonb',true,'s',true,'c1aaf6936147ed7e4dff06fa1a3351c6')
    ) AS expected(signature,result_type,stable_reader,volatility,service,body_md5) LOOP
      v_oid := pg_catalog.to_regprocedure('private.'||e.signature);
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid=v_oid;
      IF NOT FOUND OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid=f.pronamespace
          WHERE n.nspname='private' AND f.proname=pg_catalog.split_part(e.signature,'(',1))<>1
        OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']
        OR p.prorettype<>pg_catalog.to_regtype(e.result_type) OR p.provolatile<>e.volatility::"char"
        OR pg_catalog.md5(pg_catalog.replace(p.prosrc,E'\r',''))<>e.body_md5 THEN
        v_detail := 'ub_functions'; EXIT; END IF;
      IF pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE')<>e.service
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) AS a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
        v_detail := 'ub_acl'; EXIT; END IF;
    END LOOP;
  END IF;
  -- ub_settings: both rows accept an exchange only; the other reason rows keep what the earlier migrations and the admin set.
  IF v_detail IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.shop_return_reason_settings AS s
      WHERE s.reason IN ('defective','wrong_item') AND s.resolutions='exchange_only')<>2) THEN
    v_detail := 'ub_settings'; END IF;
  IF v_detail IS NOT NULL THEN
    RAISE EXCEPTION 'UNIT_BINDING_SCHEMA_MIGRATION_ASSERTION_FAILED' USING ERRCODE='P0001', DETAIL=v_detail; END IF;
END;
$ub_final$;
-- UB_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
