BEGIN;
-- Accounting plan 2 S6 (FREQ-569 AC-01/AC-03/AC-05, FREQ-563 AC-02/AC-03, FREQ-562 AC-01): the posting foundation that
-- tasks 2-9 build on. Parked events, the units a shipment entry used, the pre-shipment refund allocations, the
-- numbers the group G lock hands out, the allocation tool and the two group G functions that take a number.
--
-- Tables (all public, owned by postgres, RLS on and no policy; PUBLIC, anon and authenticated hold nothing;
-- service_role holds SELECT only):
--   accounting_pending_events           events that cannot be posted yet (one row per kind/source), with the reason
--   accounting_shipment_units           the units a shipment entry used (append only)
--   accounting_unit_refund_allocations  pre-shipment refund amounts per unit (append only; a deferred trigger keeps the
--                                       sum of one unit between 0 and its paid amount)
--   accounting_g_slip_facts             the confirm / cancel fact of a shipment slip with its number (append only)
--   index accounting_journal_lines (order_id, account_code) for the per-order deferred revenue balance
-- Sequence private.accounting_g_fact_seq: the number is taken only while the group G lock (190521,1) is held
-- (private.accounting_take_g_fact_seq), so the order of the numbers is the order of the commits. Times (now()) are
-- never used to order two facts.
-- Tools (private, no entry point unless noted): accounting_allocate_amount, accounting_cutover_on,
--   accounting_take_g_fact_seq, accounting_record_slip_fact, accounting_g_fact_seq_at, accounting_shipped_units,
--   accounting_unit_values, accounting_record_unit_refund, accounting_pending_detail_valid, accounting_park_event,
--   accounting_unpark_event, accounting_pending_event_json.
-- Reads and the writer for service_role (private body + public entry of the same name):
--   list_accounting_pending_events, get_accounting_pending_summary, admin_resolve_accounting_pending_event.
-- Two group G functions get one line each (CREATE OR REPLACE with the latest definition copied as it is; only the
-- text between the ACC_P2_BEGIN and ACC_P2_END comment lines is new): private.admin_confirm_shipment_slip (G-4) and
-- private.admin_cancel_shipment_slip (G-3) record the fact right after they change the stage. Arguments, result,
-- SECURITY, search_path, ACL, owner and the group G writer list are unchanged.
-- ops_job_heartbeats_job_check gets the eighth job accounting_post.
-- Lock order of every writer: (190521,1) -> (190525,0) -> (190525, hashtext(period_id)) (private.accounting_lock_all).
--
-- ROLLBACK (only while no row exists in the four new tables):
--   re-run CREATE OR REPLACE of the two group G functions from 20261026045859_group_g4_orders_foundation.sql (confirm) and
--   20261025100130_group_g3_shipping_slips.sql (cancel); restore ops_job_heartbeats_job_check without accounting_post;
--   DROP FUNCTION the public and private list_accounting_pending_events, get_accounting_pending_summary,
--     admin_resolve_accounting_pending_event and the private accounting_* functions of this file;
--   DROP INDEX public.accounting_journal_lines_order_account_idx;
--   DROP SEQUENCE private.accounting_g_fact_seq;
--   DROP TABLE public.accounting_unit_refund_allocations, public.accounting_shipment_units,
--     public.accounting_g_slip_facts, public.accounting_pending_events;

-- ACC_S6_BODY_BEGIN

-- 0. Before anything is created: no shipment slip may be confirmed or cancelled yet (a slip without a fact would have
--    no number). Production and a reset local database hold none (design 0-4). The baseline the final assert compares
--    with is taken after this check; a replay of the assert (tests) pins the current state here first
--    (pinAccountingS6Baseline).
DO $acc_s6_precheck$
BEGIN
  IF EXISTS (SELECT 1 FROM public.shipment_slips AS s WHERE s.stage IN ('confirmed', 'cancelled')) THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'acc_s6_slip_fact_backfill';
  END IF;
END
$acc_s6_precheck$;

CREATE TEMP TABLE accounting_s6_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s6_baseline(payload)
SELECT pg_catalog.jsonb_build_object('missing_slip_facts', 0, 'pending_events', 0, 'shipment_units', 0,
  'unit_refund_allocations', 0, 'g_slip_facts', 0,
  'allowlist_md5', (SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(w.proc::oid::text, ',' ORDER BY w.proc::oid), ''))
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)));

-- 1. Tables.
CREATE TABLE public.accounting_pending_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_kind text NOT NULL,
  source_table text NOT NULL,
  source_id text NOT NULL,
  order_id uuid NULL,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  detection_count integer NOT NULL DEFAULT 1,
  resolved_at timestamptz NULL,
  resolved_entry_id uuid NULL,
  resolved_by uuid NULL,
  resolution_note text NULL,
  resolution_request_key uuid NULL,
  resolution_request_hash text NULL,
  CONSTRAINT accounting_pending_events_pkey PRIMARY KEY (id),
  CONSTRAINT accounting_pending_events_source_key UNIQUE (event_kind, source_table, source_id),
  CONSTRAINT accounting_pending_events_resolution_request_key_key UNIQUE (resolution_request_key),
  CONSTRAINT accounting_pending_events_resolved_entry_id_fkey FOREIGN KEY (resolved_entry_id)
    REFERENCES public.accounting_journal_entries (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_pending_events_event_kind_check CHECK (event_kind = ANY (private.accounting_event_kinds())),
  CONSTRAINT accounting_pending_events_reason_check CHECK (reason IN (
    'payment_journal_missing', 'order_not_postable', 'amount_mismatch', 'no_order', 'units_insufficient',
    'shipment_date_mismatch', 'deferred_revenue_short', 'period_missing', 'posting_error', 'before_cutover',
    'unknown_category', 'payout_mismatch', 'dispute_refund_overlap', 'dispute_return_refund_pending',
    'dispute_withdrawal_missing', 'dispute_shipment_pending', 'shipment_lines_mismatch', 'no_revenue')),
  CONSTRAINT accounting_pending_events_detail_check CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT accounting_pending_events_detection_count_check CHECK (detection_count >= 1),
  CONSTRAINT accounting_pending_events_resolution_note_check CHECK (char_length(resolution_note) <= 500)
);
CREATE INDEX accounting_pending_events_open_idx
  ON public.accounting_pending_events (resolved_at, first_detected_at);
CREATE INDEX accounting_pending_events_order_idx ON public.accounting_pending_events (order_id);

-- Which units a shipment entry used. Which unit is shipped is not decided here (accounting_shipped_units decides).
CREATE TABLE public.accounting_shipment_units (
  entry_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  unit_index integer NOT NULL,
  paid_amount integer NOT NULL,
  refunded_amount integer NOT NULL DEFAULT 0,
  CONSTRAINT accounting_shipment_units_pkey PRIMARY KEY (entry_id, order_item_id, unit_index),
  CONSTRAINT accounting_shipment_units_entry_id_fkey FOREIGN KEY (entry_id)
    REFERENCES public.accounting_journal_entries (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_shipment_units_order_item_id_fkey FOREIGN KEY (order_item_id)
    REFERENCES public.order_items (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_shipment_units_unit_index_check CHECK (unit_index >= 0),
  CONSTRAINT accounting_shipment_units_paid_amount_check CHECK (paid_amount >= 0),
  CONSTRAINT accounting_shipment_units_refunded_amount_check CHECK (refunded_amount >= 0)
);

-- Pre-shipment refund amounts per unit. Keys: the refund number (positive), reapply:<refund number> (positive, a
-- rewrite after an error), cover:<refund number> (positive, plan 3), release:<original key>:<n> (negative, a release).
-- fact_seq / locked_at come from accounting_take_g_fact_seq inside the group G lock; only fact_seq is used to compare.
CREATE TABLE public.accounting_unit_refund_allocations (
  order_item_id uuid NOT NULL,
  unit_index integer NOT NULL,
  refund_key text NOT NULL,
  amount integer NOT NULL,
  fact_seq bigint NOT NULL,
  locked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_unit_refund_allocations_pkey PRIMARY KEY (order_item_id, unit_index, refund_key),
  CONSTRAINT accounting_unit_refund_allocations_fact_seq_key UNIQUE (fact_seq),
  CONSTRAINT accounting_unit_refund_allocations_order_item_id_fkey FOREIGN KEY (order_item_id)
    REFERENCES public.order_items (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_unit_refund_allocations_unit_fkey FOREIGN KEY (order_item_id, unit_index)
    REFERENCES public.order_line_unit_amounts (order_item_id, unit_index) ON DELETE RESTRICT,
  CONSTRAINT accounting_unit_refund_allocations_unit_index_check CHECK (unit_index >= 0),
  CONSTRAINT accounting_unit_refund_allocations_refund_key_check CHECK (refund_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  CONSTRAINT accounting_unit_refund_allocations_amount_check CHECK (amount <> 0)
);

-- The confirm / cancel fact of a shipment slip, written by the group G functions right after they change the stage.
CREATE TABLE public.accounting_g_slip_facts (
  slip_id uuid NOT NULL,
  kind text NOT NULL,
  fact_seq bigint NOT NULL,
  locked_at timestamptz NOT NULL,
  CONSTRAINT accounting_g_slip_facts_pkey PRIMARY KEY (slip_id, kind),
  CONSTRAINT accounting_g_slip_facts_fact_seq_key UNIQUE (fact_seq),
  CONSTRAINT accounting_g_slip_facts_slip_id_fkey FOREIGN KEY (slip_id)
    REFERENCES public.shipment_slips (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_g_slip_facts_kind_check CHECK (kind IN ('confirm', 'cancel'))
);

ALTER TABLE public.accounting_pending_events OWNER TO postgres;
ALTER TABLE public.accounting_shipment_units OWNER TO postgres;
ALTER TABLE public.accounting_unit_refund_allocations OWNER TO postgres;
ALTER TABLE public.accounting_g_slip_facts OWNER TO postgres;
ALTER TABLE public.accounting_pending_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_shipment_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_unit_refund_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_g_slip_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.accounting_pending_events, public.accounting_shipment_units,
  public.accounting_unit_refund_allocations, public.accounting_g_slip_facts
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
  public.accounting_pending_events, public.accounting_shipment_units,
  public.accounting_unit_refund_allocations, public.accounting_g_slip_facts
TO service_role;

-- The order-wide deferred revenue balance and the backlog read the lines of 2150 by order.
CREATE INDEX accounting_journal_lines_order_account_idx
  ON public.accounting_journal_lines (order_id, account_code) WHERE order_id IS NOT NULL;

-- 2. The sequence of the group G facts. Nothing is granted: only the SECURITY DEFINER tool below reads it.
CREATE SEQUENCE private.accounting_g_fact_seq AS bigint;
ALTER SEQUENCE private.accounting_g_fact_seq OWNER TO postgres;
REVOKE ALL ON SEQUENCE private.accounting_g_fact_seq FROM PUBLIC, anon, authenticated, service_role;

-- 3. Append only (UPDATE, DELETE and TRUNCATE are refused for every role; ALWAYS so a replica-mode load cannot rewrite
--    them either) and the deferred sum check of one unit.
CREATE TRIGGER accounting_shipment_units_no_update_delete BEFORE UPDATE OR DELETE ON public.accounting_shipment_units
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_shipment_units_no_truncate BEFORE TRUNCATE ON public.accounting_shipment_units
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_unit_refund_allocations_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_unit_refund_allocations
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_unit_refund_allocations_no_truncate BEFORE TRUNCATE ON public.accounting_unit_refund_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_g_slip_facts_no_update_delete BEFORE UPDATE OR DELETE ON public.accounting_g_slip_facts
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_g_slip_facts_no_truncate BEFORE TRUNCATE ON public.accounting_g_slip_facts
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.accounting_shipment_units ENABLE ALWAYS TRIGGER accounting_shipment_units_no_update_delete;
ALTER TABLE public.accounting_shipment_units ENABLE ALWAYS TRIGGER accounting_shipment_units_no_truncate;
ALTER TABLE public.accounting_unit_refund_allocations ENABLE ALWAYS TRIGGER accounting_unit_refund_allocations_no_update_delete;
ALTER TABLE public.accounting_unit_refund_allocations ENABLE ALWAYS TRIGGER accounting_unit_refund_allocations_no_truncate;
ALTER TABLE public.accounting_g_slip_facts ENABLE ALWAYS TRIGGER accounting_g_slip_facts_no_update_delete;
ALTER TABLE public.accounting_g_slip_facts ENABLE ALWAYS TRIGGER accounting_g_slip_facts_no_truncate;

-- The sum of the allocations of one unit stays between 0 and its paid amount (checked at COMMIT, or at once after
-- SET CONSTRAINTS ALL IMMEDIATE, so a release row and the row it releases may arrive in either order).
CREATE FUNCTION private.accounting_check_unit_allocation_sum() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_paid integer;
  v_total bigint;
BEGIN
  SELECT u.paid_amount INTO v_paid FROM public.order_line_unit_amounts AS u
  WHERE u.order_item_id = NEW.order_item_id AND u.unit_index = NEW.unit_index;
  SELECT COALESCE(pg_catalog.sum(a.amount), 0) INTO v_total FROM public.accounting_unit_refund_allocations AS a
  WHERE a.order_item_id = NEW.order_item_id AND a.unit_index = NEW.unit_index;
  IF v_paid IS NULL OR v_total < 0 OR v_total > v_paid THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023', DETAIL = 'unit_allocation_sum';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER accounting_unit_refund_allocations_sum AFTER INSERT ON public.accounting_unit_refund_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.accounting_check_unit_allocation_sum();

-- 4. The allocation tool (design 2-h, 4-e2, 5-g). floor(total * w[i] / sum(w)) for every i, then the remainder is
--    added one yen at a time to the elements whose weight is not 0, in index order. The sum is always the total.
--    The same values as allocateByWeight in src/lib/accounting/allocate.ts (both have the same fixed vectors).
CREATE FUNCTION private.accounting_allocate_amount(_total bigint, _weights bigint[]) RETURNS bigint[]
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_sum numeric;
  v_result bigint[];
BEGIN
  IF _total IS NULL OR _total < 0 OR _weights IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(_weights) AS w(weight) WHERE w.weight IS NULL OR w.weight < 0) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.sum(w.weight), 0) INTO v_sum FROM pg_catalog.unnest(_weights) AS w(weight);
  IF v_sum = 0 THEN
    IF _total > 0 THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    RETURN ARRAY(SELECT 0::bigint FROM pg_catalog.unnest(_weights));
  END IF;
  WITH base AS (
    SELECT t.n, t.weight, pg_catalog.floor(_total::numeric * t.weight / v_sum)::bigint AS share
    FROM pg_catalog.unnest(_weights) WITH ORDINALITY AS t(weight, n)
  ), rest AS (
    SELECT _total - pg_catalog.sum(b.share) AS r FROM base AS b
  ), ranked AS (
    SELECT b.n, b.weight, b.share,
      pg_catalog.row_number() OVER (PARTITION BY (b.weight > 0) ORDER BY b.n) AS rk
    FROM base AS b
  )
  SELECT pg_catalog.array_agg(k.share + CASE WHEN k.weight > 0 AND k.rk <= (SELECT r.r FROM rest AS r) THEN 1 ELSE 0 END
    ORDER BY k.n)
  INTO v_result FROM ranked AS k;
  RETURN v_result;
END;
$$;

-- The day the new books start (accounting_settings.cutover_on).
CREATE FUNCTION private.accounting_cutover_on() RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT s.cutover_on FROM public.accounting_settings AS s WHERE s.id = 1 $$;

-- 5. The numbers of the group G facts. Only while the group G lock (190521,1) is held (else GROUP_H_LOCK_REQUIRED /
--    55000): the lock is kept to the end of the transaction, so the numbers of committed rows are in lock order, which
--    is commit order. clock_timestamp() is the time the number was taken (inside the lock), never the transaction
--    start. Gaps (aborted transactions) do not matter.
CREATE FUNCTION private.accounting_take_g_fact_seq() RETURNS TABLE(fact_seq bigint, locked_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  fact_seq := pg_catalog.nextval('private.accounting_g_fact_seq');
  locked_at := pg_catalog.clock_timestamp();
  RETURN NEXT;
END;
$$;

-- One fact row of a shipment slip; the second call for the same (slip, kind) is refused by the primary key.
CREATE FUNCTION private.accounting_record_slip_fact(_slip_id uuid, _kind text) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_seq bigint;
  v_at timestamptz;
BEGIN
  SELECT t.fact_seq, t.locked_at INTO v_seq, v_at FROM private.accounting_take_g_fact_seq() AS t;
  IF _slip_id IS NULL OR _kind IS NULL OR _kind NOT IN ('confirm', 'cancel') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.accounting_g_slip_facts (slip_id, kind, fact_seq, locked_at) VALUES (_slip_id, _kind, v_seq, v_at);
  RETURN v_seq;
END;
$$;

-- The largest fact number taken at or before an instant (0 when none). For the dispute runner, which compares with
-- the time Stripe reports; the number, not the time, orders the facts afterwards.
CREATE FUNCTION private.accounting_g_fact_seq_at(_at timestamptz) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.max(m.fact_seq), 0) FROM (
    SELECT f.fact_seq FROM public.accounting_g_slip_facts AS f WHERE f.locked_at <= _at
    UNION ALL
    SELECT a.fact_seq FROM public.accounting_unit_refund_allocations AS a WHERE a.locked_at <= _at
  ) AS m
$$;

-- 6. Which units of an order item are shipped as of fact number N (NULL = now, for callers holding the group G lock).
--    Only order_items.line_kind = 'order' units count (an exchange item has none here). Every comparison uses fact
--    numbers, never times. For each slip s of the item with confirm number c(s) <= N, in c order: s takes
--    shipment_slip_lines.quantity units, lowest unit_index first, skipping
--      (1) the units taken by an earlier slip s' that was still alive when s was confirmed (no cancel number, or one
--          larger than c(s)), also when s' is cancelled later, and
--      (2) the units whose allocations with fact_seq < c(s) add up to a paid amount above 0 (refunded in full).
--    Whether a shipment entry exists is not looked at; the refund claim of group H is not looked at either (plan 3 writes
--    a full allocation in the same transaction). The rows returned are the units of the slips that are still alive at N
--    (cancel number missing or larger than N). The answer for N never changes after later rows are committed.
CREATE FUNCTION private.accounting_shipped_units(_order_item_id uuid, _as_of_seq bigint)
RETURNS TABLE(unit_index integer, slip_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_slip record;
  v_history jsonb := '[]'::jsonb;
  v_excluded integer[];
  v_taken integer[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.order_items AS oi WHERE oi.id = _order_item_id AND oi.line_kind = 'order') THEN
    RETURN;
  END IF;
  FOR v_slip IN
    SELECT f.slip_id AS slip_id, f.fact_seq AS confirm_seq, x.fact_seq AS cancel_seq, l.quantity AS quantity
    FROM public.accounting_g_slip_facts AS f
    JOIN public.shipment_slip_lines AS l ON l.slip_id = f.slip_id AND l.order_item_id = _order_item_id
    LEFT JOIN public.accounting_g_slip_facts AS x ON x.slip_id = f.slip_id AND x.kind = 'cancel'
    WHERE f.kind = 'confirm' AND (_as_of_seq IS NULL OR f.fact_seq <= _as_of_seq)
    ORDER BY f.fact_seq
  LOOP
    v_excluded := ARRAY(
      SELECT DISTINCT e.unit::integer
      FROM pg_catalog.jsonb_array_elements(v_history) AS h(entry)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(h.entry -> 'units') AS e(unit)
      WHERE h.entry -> 'cancel_seq' = 'null'::jsonb OR (h.entry ->> 'cancel_seq')::bigint > v_slip.confirm_seq
      UNION
      SELECT u.unit_index
      FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id = _order_item_id AND u.paid_amount > 0
        AND COALESCE((SELECT pg_catalog.sum(a.amount) FROM public.accounting_unit_refund_allocations AS a
          WHERE a.order_item_id = u.order_item_id AND a.unit_index = u.unit_index
            AND a.fact_seq < v_slip.confirm_seq), 0) = u.paid_amount);
    v_taken := ARRAY(
      SELECT u.unit_index FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id = _order_item_id AND NOT (u.unit_index = ANY (v_excluded))
      ORDER BY u.unit_index LIMIT v_slip.quantity);
    v_history := v_history || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'confirm_seq', v_slip.confirm_seq, 'cancel_seq', v_slip.cancel_seq, 'units', pg_catalog.to_jsonb(v_taken)));
    IF v_slip.cancel_seq IS NULL OR (_as_of_seq IS NOT NULL AND v_slip.cancel_seq > _as_of_seq) THEN
      RETURN QUERY SELECT t.unit, v_slip.slip_id FROM pg_catalog.unnest(v_taken) AS t(unit);
    END IF;
  END LOOP;
  RETURN;
END;
$$;

-- The value of every unit of an order as of fact number N: the paid amount minus the allocations with fact_seq <= N
-- (NULL = all), shipped or not alike (the same yardstick as the shipment entry). One place for the formula; the
-- dispute runner and plan 3 use it. Only line_kind = 'order' items.
CREATE FUNCTION private.accounting_unit_values(_order_id uuid, _as_of_seq bigint)
RETURNS TABLE(order_item_id uuid, unit_index integer, shipped boolean, value integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT u.order_item_id, u.unit_index, (u.unit_index = ANY (s.units)) AS shipped,
    (u.paid_amount - COALESCE((SELECT pg_catalog.sum(a.amount) FROM public.accounting_unit_refund_allocations AS a
      WHERE a.order_item_id = u.order_item_id AND a.unit_index = u.unit_index
        AND (_as_of_seq IS NULL OR a.fact_seq <= _as_of_seq)), 0))::integer AS value
  FROM public.order_items AS oi
  CROSS JOIN LATERAL (
    SELECT COALESCE(pg_catalog.array_agg(su.unit_index), ARRAY[]::integer[]) AS units
    FROM private.accounting_shipped_units(oi.id, _as_of_seq) AS su
  ) AS s
  JOIN public.order_line_unit_amounts AS u ON u.order_item_id = oi.id
  WHERE oi.order_id = _order_id AND oi.line_kind = 'order'
  ORDER BY u.order_item_id, u.unit_index
$$;

-- One allocation row (plan 3 calls it for a pre-shipment refund; plan 2 never does). The number is taken first, so a
-- caller without the group G lock gets GROUP_H_LOCK_REQUIRED. A unit that is shipped now (accounting_shipped_units
-- with N = NULL) takes no row, positive or negative. Positive keys: <refund number>, reapply:<n>, cover:<n>.
-- Negative keys: release:<original key>:<n>, up to the positive rows of <original key>, reapply:<original key> and
-- cover:<original key> minus the releases already written for <original key>.
CREATE FUNCTION private.accounting_record_unit_refund(_refund_key text, _order_item_id uuid, _unit_index integer,
  _amount integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_seq bigint;
  v_at timestamptz;
  v_base text;
  v_positive bigint;
  v_released bigint;
BEGIN
  SELECT t.fact_seq, t.locked_at INTO v_seq, v_at FROM private.accounting_take_g_fact_seq() AS t;
  IF _refund_key IS NULL OR _refund_key !~ '^[A-Za-z0-9_.:-]{1,128}$' OR _order_item_id IS NULL OR _unit_index IS NULL
    OR _unit_index < 0 OR _amount IS NULL OR _amount = 0 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM private.accounting_shipped_units(_order_item_id, NULL) AS s WHERE s.unit_index = _unit_index) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _amount > 0 THEN
    IF pg_catalog.starts_with(_refund_key, 'release:') THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF _refund_key !~ '^release:.+:[0-9]+$' THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_base := pg_catalog.regexp_replace(pg_catalog.substr(_refund_key, 9), ':[0-9]+$', '');
    IF v_base = '' OR v_base ~ '^(release|reapply|cover):' THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(pg_catalog.sum(a.amount) FILTER (WHERE a.amount > 0
        AND a.refund_key IN (v_base, 'reapply:' || v_base, 'cover:' || v_base)), 0),
      COALESCE(pg_catalog.sum(-a.amount) FILTER (WHERE a.amount < 0 AND pg_catalog.starts_with(a.refund_key, 'release:')
        AND pg_catalog.regexp_replace(pg_catalog.substr(a.refund_key, 9), ':[0-9]+$', '') = v_base), 0)
    INTO v_positive, v_released FROM public.accounting_unit_refund_allocations AS a
    WHERE a.order_item_id = _order_item_id AND a.unit_index = _unit_index;
    IF -_amount > v_positive - v_released THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  INSERT INTO public.accounting_unit_refund_allocations (order_item_id, unit_index, refund_key, amount, fact_seq, locked_at)
  VALUES (_order_item_id, _unit_index, _refund_key, _amount, v_seq, v_at);
END;
$$;

-- 7. Parked events. The detail keys are fixed per reason (no personal data, no raw exception text); the values are
--    dates, fixed words, identifiers and non-negative integers only. period_missing must carry entry_date.
CREATE FUNCTION private.accounting_pending_detail_valid(_reason text, _detail jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_allowed text[];
  v_key text;
  v_value jsonb;
  v_number numeric;
BEGIN
  IF _reason IS NULL OR _detail IS NULL OR pg_catalog.jsonb_typeof(_detail) <> 'object' THEN
    RETURN false;
  END IF;
  v_allowed := CASE _reason
    WHEN 'period_missing' THEN ARRAY['entry_date', 'cause']
    WHEN 'posting_error' THEN ARRAY['error_sqlstate', 'error_code', 'entry_date']
    WHEN 'amount_mismatch' THEN ARRAY['stripe_amount', 'order_total']
    WHEN 'order_not_postable' THEN ARRAY['reason']
    WHEN 'payment_journal_missing' THEN ARRAY['order_count']
    WHEN 'deferred_revenue_short' THEN ARRAY['shortage']
    WHEN 'payout_mismatch' THEN ARRAY['payout_state']
    WHEN 'dispute_withdrawal_missing' THEN ARRAY['waiting_on', 'dispute_status']
    WHEN 'no_revenue' THEN ARRAY['lost_on']
    ELSE ARRAY[]::text[] END;
  IF _reason = 'period_missing' AND NOT (_detail ? 'entry_date') THEN
    RETURN false;
  END IF;
  FOR v_key, v_value IN SELECT d.key, d.value FROM pg_catalog.jsonb_each(_detail) AS d(key, value) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RETURN false;
    END IF;
    IF v_key IN ('entry_date', 'lost_on') THEN
      IF pg_catalog.jsonb_typeof(v_value) <> 'string' OR (v_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN false;
      END IF;
      BEGIN
        PERFORM (v_value #>> '{}')::date;
      EXCEPTION WHEN OTHERS THEN
        RETURN false;
      END;
    ELSIF v_key IN ('stripe_amount', 'order_total', 'order_count', 'shortage') THEN
      IF pg_catalog.jsonb_typeof(v_value) <> 'number' THEN
        RETURN false;
      END IF;
      v_number := (v_value #>> '{}')::numeric;
      IF v_number < 0 OR v_number <> pg_catalog.trunc(v_number) OR v_number > 9007199254740991 THEN
        RETURN false;
      END IF;
    ELSIF pg_catalog.jsonb_typeof(v_value) <> 'string' THEN
      RETURN false;
    ELSIF v_key = 'cause' THEN
      IF (v_value #>> '{}') <> 'sole_ended_not_switched' THEN RETURN false; END IF;
    ELSIF v_key = 'error_sqlstate' THEN
      IF (v_value #>> '{}') !~ '^[0-9A-Z]{5}$' THEN RETURN false; END IF;
    ELSIF v_key = 'error_code' THEN
      IF (v_value #>> '{}') <> 'unexpected_error' AND (v_value #>> '{}') !~ '^(ACCOUNTING|GROUP_G|GROUP_H)_[A-Z0-9_]{1,80}$' THEN
        RETURN false;
      END IF;
    ELSIF v_key = 'reason' THEN
      IF (v_value #>> '{}') NOT IN ('shipping', 'units_sum', 'units_missing') THEN RETURN false; END IF;
    ELSIF v_key = 'payout_state' THEN
      IF (v_value #>> '{}') NOT IN ('payout_not_posted', 'payout_net_zero') THEN RETURN false; END IF;
    ELSIF v_key = 'waiting_on' THEN
      IF (v_value #>> '{}') <> 'dispute_account_unassigned' THEN RETURN false; END IF;
    ELSIF v_key = 'dispute_status' THEN
      IF (v_value #>> '{}') !~ '^[a-z_]{1,40}$' THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- Park an event: an open row of the same (kind, table, id) gets its reason, detail and last detection time (the count
-- goes up); a new one is inserted; a resolved row is left alone (a person's confirmation is never reopened).
CREATE FUNCTION private.accounting_park_event(_kind text, _source_table text, _source_id text, _order_id uuid,
  _reason text, _detail jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _kind IS NULL OR NOT (_kind = ANY (private.accounting_event_kinds())) OR _source_table IS NULL OR _source_id IS NULL
    OR _reason IS NULL OR NOT private.accounting_pending_detail_valid(_reason, COALESCE(_detail, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.accounting_pending_events AS p (event_kind, source_table, source_id, order_id, reason, detail)
  VALUES (_kind, _source_table, _source_id, _order_id, _reason, COALESCE(_detail, '{}'::jsonb))
  ON CONFLICT ON CONSTRAINT accounting_pending_events_source_key DO UPDATE
  SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, order_id = COALESCE(EXCLUDED.order_id, p.order_id),
    last_detected_at = pg_catalog.now(), detection_count = p.detection_count + 1
  WHERE p.resolved_at IS NULL;
END;
$$;

-- Resolve an open event automatically (the entry now exists, or there is no revenue: _entry_id may be NULL then).
CREATE FUNCTION private.accounting_unpark_event(_kind text, _source_table text, _source_id text, _entry_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE public.accounting_pending_events AS p
  SET resolved_at = pg_catalog.now(), resolved_entry_id = _entry_id
  WHERE p.event_kind = _kind AND p.source_table = _source_table AND p.source_id = _source_id AND p.resolved_at IS NULL;
END;
$$;

-- One event as the reads return it (no resolver, no note, no request key).
CREATE FUNCTION private.accounting_pending_event_json(_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object('id', p.id, 'event_kind', p.event_kind, 'source_table', p.source_table,
    'source_id', p.source_id, 'order_id', p.order_id, 'reason', p.reason, 'detail', p.detail,
    'first_detected_at', p.first_detected_at, 'last_detected_at', p.last_detected_at,
    'detection_count', p.detection_count, 'resolved_at', p.resolved_at, 'resolved_entry_id', p.resolved_entry_id)
  FROM public.accounting_pending_events AS p WHERE p.id = _id
$$;

-- 8. Reads and the writer for service_role.
-- Newest first by (first_detected_at, id); the next page starts after the pair of the last row (both or none).
CREATE FUNCTION private.list_accounting_pending_events(_include_resolved boolean DEFAULT false, _limit integer DEFAULT 50,
  _after_at timestamptz DEFAULT NULL, _after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rows jsonb;
  v_ids uuid[];
  v_more boolean;
  v_last_at timestamptz;
  v_last_id uuid;
BEGIN
  IF _include_resolved IS NULL OR _limit IS NULL OR _limit < 1 OR _limit > 100 OR (_after_at IS NULL) <> (_after_id IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(q.id ORDER BY q.first_detected_at DESC, q.id DESC) INTO v_ids FROM (
    SELECT p.id, p.first_detected_at FROM public.accounting_pending_events AS p
    WHERE (_include_resolved OR p.resolved_at IS NULL)
      AND (_after_at IS NULL OR (p.first_detected_at, p.id) < (_after_at, _after_id))
    ORDER BY p.first_detected_at DESC, p.id DESC LIMIT _limit + 1) AS q;
  v_more := COALESCE(pg_catalog.cardinality(v_ids), 0) > _limit;
  IF v_more THEN
    v_ids := v_ids[1:_limit];
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(private.accounting_pending_event_json(i.id) ORDER BY i.n), '[]'::jsonb)
  INTO v_rows FROM pg_catalog.unnest(COALESCE(v_ids, ARRAY[]::uuid[])) WITH ORDINALITY AS i(id, n);
  IF v_more THEN
    SELECT p.first_detected_at, p.id INTO v_last_at, v_last_id FROM public.accounting_pending_events AS p
    WHERE p.id = v_ids[pg_catalog.cardinality(v_ids)];
  END IF;
  RETURN pg_catalog.jsonb_build_object('events', v_rows,
    'next_after_at', pg_catalog.to_jsonb(v_last_at), 'next_after_id', pg_catalog.to_jsonb(v_last_id),
    'open_count', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events AS p WHERE p.resolved_at IS NULL));
END;
$$;

CREATE FUNCTION private.get_accounting_pending_summary() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'open_count', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events AS p WHERE p.resolved_at IS NULL),
    'by_reason', COALESCE((SELECT pg_catalog.jsonb_object_agg(r.reason, r.n)
      FROM (SELECT p.reason, pg_catalog.count(*) AS n FROM public.accounting_pending_events AS p
        WHERE p.resolved_at IS NULL GROUP BY p.reason) AS r), '{}'::jsonb),
    'oldest_at', (SELECT pg_catalog.min(p.first_detected_at) FROM public.accounting_pending_events AS p
      WHERE p.resolved_at IS NULL))
$$;

-- A person marks an open event as confirmed (admin.accounting.entries.correct). Only events outside the new books
-- (before_cutover) or worth no money (no_revenue) can be closed this way; every other reason moves money and stays
-- open until its entry exists (ACCOUNTING_EVENT_NOT_POSTABLE). A resolved event is ACCOUNTING_PENDING_RESOLVED. The same
-- request key with the same content returns the first result; other content is ACCOUNTING_REQUEST_KEY_CONFLICT.
CREATE FUNCTION private.admin_resolve_accounting_pending_event(_actor_id uuid, _event_id uuid, _note text,
  _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_row public.accounting_pending_events%ROWTYPE;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.entries.correct']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _event_id IS NULL OR _request_key IS NULL OR _note IS NULL OR pg_catalog.char_length(pg_catalog.btrim(_note)) = 0
    OR pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'resolve_pending_event',
    'actor', _actor_id, 'event_id', _event_id, 'note', _note));
  SELECT * INTO v_row FROM public.accounting_pending_events AS p WHERE p.resolution_request_key = _request_key;
  IF FOUND THEN
    IF v_row.resolution_request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN private.accounting_pending_event_json(v_row.id);
  END IF;
  SELECT * INTO v_row FROM public.accounting_pending_events AS p WHERE p.id = _event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_PENDING_RESOLVED' USING ERRCODE = '55000';
  END IF;
  IF v_row.reason NOT IN ('before_cutover', 'no_revenue') THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  UPDATE public.accounting_pending_events AS p
  SET resolved_at = pg_catalog.now(), resolved_by = _actor_id, resolution_note = _note,
    resolution_request_key = _request_key, resolution_request_hash = v_hash
  WHERE p.id = _event_id;
  RETURN private.accounting_pending_event_json(_event_id);
END;
$$;

CREATE FUNCTION public.list_accounting_pending_events(_include_resolved boolean DEFAULT false, _limit integer DEFAULT 50,
  _after_at timestamptz DEFAULT NULL, _after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_accounting_pending_events(_include_resolved, _limit, _after_at, _after_id) $$;

CREATE FUNCTION public.get_accounting_pending_summary() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_accounting_pending_summary() $$;

CREATE FUNCTION public.admin_resolve_accounting_pending_event(_actor_id uuid, _event_id uuid, _note text,
  _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_resolve_accounting_pending_event(_actor_id, _event_id, _note, _request_key) $$;

-- 9. The fact lines of the two group G functions. CREATE OR REPLACE with the latest definition copied as it is
--    (G-4 for the confirm, G-3 for the cancel); the only difference is the text between ACC_P2_BEGIN and ACC_P2_END,
--    right after the UPDATE that changes the stage. The lock is taken at the top of both functions
--    (private.lock_group_g_shipment_slips), before this line. A replayed request returns before the stage changes, so it
--    takes no number; a refused one rolls the number row back with the rest.
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

CREATE OR REPLACE FUNCTION private.admin_cancel_shipment_slip(_slip_id uuid, _expected_version integer, _actor_id uuid, _request_key uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_operation uuid := pg_catalog.gen_random_uuid();
  v_existing private.group_g_operations%ROWTYPE;
  v_slip public.shipment_slips%ROWTYPE;
  v_fingerprint text;
  v_orders uuid[];
  v_before jsonb;
  v_shipment record;
  v_status public.order_status;
  v_unshipped integer;
  v_restored integer := 0;
  v_version integer;
  v_result jsonb;
  v_previous_operation text;
  v_previous_actor text;
  v_previous_reason text;
  v_previous_change text;
BEGIN
  IF _slip_id IS NULL OR _expected_version IS NULL OR _expected_version < 1 OR _actor_id IS NULL OR _request_key IS NULL THEN
    RAISE EXCEPTION 'GROUP_G_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;

  PERFORM private.lock_group_g_shipment_slips(ARRAY[_slip_id], ARRAY[]::uuid[], true);
  IF NOT private.group_g_actor_has_permissions(_actor_id,
      ARRAY['admin.shipping.manage', 'admin.shipping.read', 'admin.orders.manage', 'admin.orders.read']) THEN
    RAISE EXCEPTION 'GROUP_G_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
    'operation', 'shipment_slip_cancel', 'slip_id', _slip_id, 'actor_id', _actor_id)::text, 'UTF8')), 'hex');
  SELECT op.* INTO v_existing FROM private.group_g_operations AS op
    WHERE op.operation = 'shipment_slip_cancel' AND op.request_key = _request_key;
  IF FOUND THEN
    IF v_existing.fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'GROUP_G_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT s.* INTO v_slip FROM public.shipment_slips AS s WHERE s.id = _slip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_slip.stage = 'cancelled' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_CANCELLED' USING ERRCODE = '55000';
  END IF;
  IF v_slip.stage <> 'confirmed' THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_NOT_CONFIRMED' USING ERRCODE = '55000';
  END IF;
  IF v_slip.version <> _expected_version THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_VERSION_CONFLICT' USING ERRCODE = '55000';
  END IF;

  -- refusals for every order of the slip, before any write
  IF EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf JOIN public.orders AS o ON o.id = sf.order_id
    WHERE sf.slip_id = _slip_id AND o.status NOT IN ('paid'::public.order_status, 'shipped'::public.order_status)
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_CANCEL_NOT_ALLOWED' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf
    JOIN public.order_return_lines AS rl ON rl.fulfillment_id = sf.fulfillment_id
    JOIN public.order_returns AS r ON r.id = rl.return_id
    WHERE sf.slip_id = _slip_id AND r.status IN ('requested', 'open', 'closed')
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_HAS_RETURN' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shipment_slip_fulfillments AS sf
    JOIN public.order_fulfillment_lines AS fl ON fl.fulfillment_id = sf.fulfillment_id
    CROSS JOIN LATERAL private.order_line_fulfillment(sf.order_id) AS l
    WHERE sf.slip_id = _slip_id AND l.order_item_id = fl.order_item_id AND l.shipped - fl.quantity < l.refunded_after_shipment
  ) THEN
    RAISE EXCEPTION 'GROUP_G_SLIP_REFUNDED' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(sf.order_id ORDER BY sf.order_id) INTO v_orders
    FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = _slip_id;
  v_before := private.capture_group_g_item_states(v_orders);
  v_previous_operation := pg_catalog.current_setting('app.group_g_operation_id', true);
  v_previous_actor := pg_catalog.current_setting('app.order_actor_id', true);
  v_previous_reason := pg_catalog.current_setting('app.order_change_reason', true);
  v_previous_change := pg_catalog.current_setting('app.group_g_slip_change', true);
  BEGIN
    PERFORM pg_catalog.set_config('app.group_g_operation_id', v_operation::text, true);
    FOR v_shipment IN
      SELECT sf.order_id, f.id AS fulfillment_id
      FROM public.shipment_slip_fulfillments AS sf JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
      WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL
      ORDER BY sf.order_id
    LOOP
      UPDATE public.order_fulfillments SET cancelled_at = pg_catalog.now(), cancelled_by = _actor_id
        WHERE id = v_shipment.fulfillment_id;
      PERFORM private.stop_fulfillment_registrations(v_shipment.fulfillment_id, 'cancelled');
      PERFORM private.close_delivery_attention(v_shipment.fulfillment_id);
      v_restored := v_restored + private.restore_group_g_shipment(v_shipment.fulfillment_id, v_slip.confirm_operation_id,
        v_operation, _actor_id, v_slip.number);
      SELECT o.status INTO v_status FROM public.orders AS o WHERE o.id = v_shipment.order_id;
      SELECT COALESCE(pg_catalog.sum(l.unshipped), 0)::integer INTO v_unshipped
        FROM private.order_line_fulfillment(v_shipment.order_id) AS l;
      IF v_status = 'shipped'::public.order_status AND v_unshipped > 0 THEN
        PERFORM pg_catalog.set_config('app.order_actor_id', _actor_id::text, true);
        PERFORM pg_catalog.set_config('app.order_change_reason', 'admin_cancel_fulfillment', true);
        UPDATE public.orders SET status = 'paid'::public.order_status, shipped_at = NULL, shipping_carrier = NULL, tracking_number = NULL
          WHERE id = v_shipment.order_id;
      END IF;
      UPDATE private.order_email_outbox AS e
        SET status = 'skipped', finished_at = pg_catalog.now(), subject = NULL, body_text = NULL,
            body_erased_at = CASE WHEN e.subject IS NOT NULL THEN pg_catalog.now() ELSE e.body_erased_at END,
            last_error_code = 'fulfillment_cancelled'
        WHERE e.fulfillment_id = v_shipment.fulfillment_id AND e.status IN ('pending', 'retry_wait');
    END LOOP;
    PERFORM pg_catalog.set_config('app.group_g_slip_change', 'cancel', true);
    UPDATE public.shipment_slips SET stage = 'cancelled', cancelled_at = pg_catalog.now(), cancelled_by = _actor_id,
      version = version + 1, updated_at = pg_catalog.now()
      WHERE id = _slip_id RETURNING version INTO v_version;
    -- ACC_P2_BEGIN
    PERFORM private.accounting_record_slip_fact(_slip_id, 'cancel');
    -- ACC_P2_END
    INSERT INTO public.shipment_slip_versions(slip_id, version, kind, shipping_carrier, tracking_number, tracking_version, shipment_date, actor_id, operation_id)
      VALUES(_slip_id, v_version, 'cancel', v_slip.shipping_carrier, v_slip.tracking_number, v_slip.tracking_version, v_slip.shipment_date, _actor_id, v_operation);
    PERFORM private.record_group_g_item_state_changes(v_before, v_orders, v_operation, 1, 'shipment_slip_cancel', _actor_id);
    v_result := pg_catalog.jsonb_build_object('id', _slip_id::text, 'version', v_version, 'restoredQuantity', v_restored, 'replayed', false);
    INSERT INTO private.group_g_operations(id, operation, request_key, fingerprint, cause_type, cause_id, actor_id, result)
      VALUES(v_operation, 'shipment_slip_cancel', _request_key, v_fingerprint, 'shipment_slip', _slip_id::text, _actor_id, v_result);
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

-- 10. The periodic jobs: the eighth job accounting_post (the existing seven stay).
ALTER TABLE public.ops_job_heartbeats
  DROP CONSTRAINT ops_job_heartbeats_job_check,
  ADD CONSTRAINT ops_job_heartbeats_job_check CHECK (
    job IN ('webhook_worker', 'order_sweep', 'stripe_reconcile', 'order_email_worker', 'order_email_delivery_check', 'return_photo_purge', 'delivery_tracking', 'accounting_post')
  );

-- 11. Owners and EXECUTE. service_role: the three reads / writer of this file (private and public); everything else
--     is owner only.
ALTER FUNCTION private.accounting_check_unit_allocation_sum() OWNER TO postgres;
ALTER FUNCTION private.accounting_allocate_amount(bigint,bigint[]) OWNER TO postgres;
ALTER FUNCTION private.accounting_cutover_on() OWNER TO postgres;
ALTER FUNCTION private.accounting_take_g_fact_seq() OWNER TO postgres;
ALTER FUNCTION private.accounting_record_slip_fact(uuid,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_g_fact_seq_at(timestamptz) OWNER TO postgres;
ALTER FUNCTION private.accounting_shipped_units(uuid,bigint) OWNER TO postgres;
ALTER FUNCTION private.accounting_unit_values(uuid,bigint) OWNER TO postgres;
ALTER FUNCTION private.accounting_record_unit_refund(text,uuid,integer,integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_pending_detail_valid(text,jsonb) OWNER TO postgres;
ALTER FUNCTION private.accounting_park_event(text,text,text,uuid,text,jsonb) OWNER TO postgres;
ALTER FUNCTION private.accounting_unpark_event(text,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_pending_event_json(uuid) OWNER TO postgres;
ALTER FUNCTION private.list_accounting_pending_events(boolean,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION private.get_accounting_pending_summary() OWNER TO postgres;
ALTER FUNCTION private.admin_resolve_accounting_pending_event(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.list_accounting_pending_events(boolean,integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_accounting_pending_summary() OWNER TO postgres;
ALTER FUNCTION public.admin_resolve_accounting_pending_event(uuid,uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_check_unit_allocation_sum(), private.accounting_allocate_amount(bigint,bigint[]),
  private.accounting_cutover_on(), private.accounting_take_g_fact_seq(), private.accounting_record_slip_fact(uuid,text),
  private.accounting_g_fact_seq_at(timestamptz), private.accounting_shipped_units(uuid,bigint),
  private.accounting_unit_values(uuid,bigint), private.accounting_record_unit_refund(text,uuid,integer,integer),
  private.accounting_pending_detail_valid(text,jsonb), private.accounting_park_event(text,text,text,uuid,text,jsonb),
  private.accounting_unpark_event(text,text,text,uuid), private.accounting_pending_event_json(uuid),
  private.list_accounting_pending_events(boolean,integer,timestamptz,uuid), private.get_accounting_pending_summary(),
  private.admin_resolve_accounting_pending_event(uuid,uuid,text,uuid),
  public.list_accounting_pending_events(boolean,integer,timestamptz,uuid), public.get_accounting_pending_summary(),
  public.admin_resolve_accounting_pending_event(uuid,uuid,text,uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.list_accounting_pending_events(boolean,integer,timestamptz,uuid), private.get_accounting_pending_summary(),
  private.admin_resolve_accounting_pending_event(uuid,uuid,text,uuid),
  public.list_accounting_pending_events(boolean,integer,timestamptz,uuid), public.get_accounting_pending_summary(),
  public.admin_resolve_accounting_pending_event(uuid,uuid,text,uuid)
TO service_role;
-- ACC_S6_BODY_END

-- ACC_S6_FINAL_ASSERT_BEGIN
-- Compare catalog meaning (columns, constraint definitions, triggers, ACL entries, has_*_privilege, function
-- attributes), never ACL text serialization. Foreign keys are compared by column and table names, so the result does
-- not depend on the caller's search_path. The group G functions are compared with every ACC_P<n> block removed, so a
-- later plan that adds its own block does not break this check.
DO $acc_s6_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_tables CONSTANT text[] := ARRAY['accounting_pending_events', 'accounting_shipment_units',
    'accounting_unit_refund_allocations', 'accounting_g_slip_facts'];
  v_append_only CONSTANT text[] := ARRAY['accounting_shipment_units', 'accounting_unit_refund_allocations',
    'accounting_g_slip_facts'];
  e record;
  p record;
  v_oid oid;
  v_stage text;
  v_baseline jsonb;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s6_existing_dml_allowlist';
  -- The baseline must exist with one well-formed row (else acc_s6_existing_dml_allowlist).
  IF pg_catalog.to_regclass('pg_temp.accounting_s6_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s6_baseline) <> 1 THEN
    v_failed := 'acc_s6_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s6_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['missing_slip_facts', 'pending_events', 'shipment_units',
          'unit_refund_allocations', 'g_slip_facts', 'allowlist_md5']) AS k(name) WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s6_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s6_tables';
  -- acc_s6_tables: the four tables exist in public, are ordinary tables owned by postgres, and have exactly these
  -- columns (name, type, NOT NULL, default) in this order.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM (VALUES
    ('accounting_pending_events', 'id uuid not null default gen_random_uuid(), event_kind text not null, source_table text not null, source_id text not null, order_id uuid, reason text not null, detail jsonb not null default ''{}''::jsonb, first_detected_at timestamp with time zone not null default now(), last_detected_at timestamp with time zone not null default now(), detection_count integer not null default 1, resolved_at timestamp with time zone, resolved_entry_id uuid, resolved_by uuid, resolution_note text, resolution_request_key uuid, resolution_request_hash text'),
    ('accounting_shipment_units', 'entry_id uuid not null, order_item_id uuid not null, unit_index integer not null, paid_amount integer not null, refunded_amount integer not null default 0'),
    ('accounting_unit_refund_allocations', 'order_item_id uuid not null, unit_index integer not null, refund_key text not null, amount integer not null, fact_seq bigint not null, locked_at timestamp with time zone not null, created_at timestamp with time zone not null default now()'),
    ('accounting_g_slip_facts', 'slip_id uuid not null, kind text not null, fact_seq bigint not null, locked_at timestamp with time zone not null')
  ) AS t(name, columns)
  LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
  WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> 'postgres'::regrole
    OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
          || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM t.columns) THEN
    v_failed := 'acc_s6_tables';
  END IF;

  v_stage := 'acc_s6_constraints';
  -- acc_s6_constraints: every CHECK / PRIMARY KEY / UNIQUE / FOREIGN KEY below exists, is validated and is not
  -- deferrable; the four tables have no other one; the deferred sum trigger of the allocations exists as it was made;
  -- the three reading indexes exist.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
    ('accounting_g_slip_facts', 'accounting_g_slip_facts_fact_seq_key', 'u', 'fact_seq'),
    ('accounting_g_slip_facts', 'accounting_g_slip_facts_kind_check', 'c', 'CHECK ((kind = ANY (ARRAY[''confirm''::text, ''cancel''::text])))'),
    ('accounting_g_slip_facts', 'accounting_g_slip_facts_pkey', 'p', 'slip_id,kind'),
    ('accounting_g_slip_facts', 'accounting_g_slip_facts_slip_id_fkey', 'f', 'slip_id>public.shipment_slips(id)ras'),
    ('accounting_pending_events', 'accounting_pending_events_detail_check', 'c', 'CHECK ((jsonb_typeof(detail) = ''object''::text))'),
    ('accounting_pending_events', 'accounting_pending_events_detection_count_check', 'c', 'CHECK ((detection_count >= 1))'),
    ('accounting_pending_events', 'accounting_pending_events_event_kind_check', 'c', 'CHECK ((event_kind = ANY (accounting_event_kinds())))'),
    ('accounting_pending_events', 'accounting_pending_events_pkey', 'p', 'id'),
    ('accounting_pending_events', 'accounting_pending_events_reason_check', 'c', 'CHECK ((reason = ANY (ARRAY[''payment_journal_missing''::text, ''order_not_postable''::text, ''amount_mismatch''::text, ''no_order''::text, ''units_insufficient''::text, ''shipment_date_mismatch''::text, ''deferred_revenue_short''::text, ''period_missing''::text, ''posting_error''::text, ''before_cutover''::text, ''unknown_category''::text, ''payout_mismatch''::text, ''dispute_refund_overlap''::text, ''dispute_return_refund_pending''::text, ''dispute_withdrawal_missing''::text, ''dispute_shipment_pending''::text, ''shipment_lines_mismatch''::text, ''no_revenue''::text])))'),
    ('accounting_pending_events', 'accounting_pending_events_resolution_note_check', 'c', 'CHECK ((char_length(resolution_note) <= 500))'),
    ('accounting_pending_events', 'accounting_pending_events_resolution_request_key_key', 'u', 'resolution_request_key'),
    ('accounting_pending_events', 'accounting_pending_events_resolved_entry_id_fkey', 'f', 'resolved_entry_id>public.accounting_journal_entries(id)ras'),
    ('accounting_pending_events', 'accounting_pending_events_source_key', 'u', 'event_kind,source_table,source_id'),
    ('accounting_shipment_units', 'accounting_shipment_units_entry_id_fkey', 'f', 'entry_id>public.accounting_journal_entries(id)ras'),
    ('accounting_shipment_units', 'accounting_shipment_units_order_item_id_fkey', 'f', 'order_item_id>public.order_items(id)ras'),
    ('accounting_shipment_units', 'accounting_shipment_units_paid_amount_check', 'c', 'CHECK ((paid_amount >= 0))'),
    ('accounting_shipment_units', 'accounting_shipment_units_pkey', 'p', 'entry_id,order_item_id,unit_index'),
    ('accounting_shipment_units', 'accounting_shipment_units_refunded_amount_check', 'c', 'CHECK ((refunded_amount >= 0))'),
    ('accounting_shipment_units', 'accounting_shipment_units_unit_index_check', 'c', 'CHECK ((unit_index >= 0))'),
    ('accounting_unit_refund_allocations', 'accounting_unit_refund_allocations_amount_check', 'c', 'CHECK ((amount <> 0))'),
    ('accounting_unit_refund_allocations', 'accounting_unit_refund_allocations_fact_seq_key', 'u', 'fact_seq'),
    ('accounting_unit_refund_allocations', 'accounting_unit_refund_allocations_order_item_id_fkey', 'f', 'order_item_id>public.order_items(id)ras'),
    ('accounting_unit_refund_allocations', 'accounting_unit_refund_allocations_pkey', 'p', 'order_item_id,unit_index,refund_key'),
    ('accounting_unit_refund_allocations', 'accounting_unit_refund_allocations_refund_key_check', 'c', 'CHECK ((refund_key ~ ''^[A-Za-z0-9_.:-]{1,128}$''::text))'),
    ('accounting_unit_refund_allocations', 'accounting_unit_refund_allocations_unit_fkey', 'f', 'order_item_id,unit_index>public.order_line_unit_amounts(order_item_id,unit_index)ras'),
    ('accounting_unit_refund_allocations', 'accounting_unit_refund_allocations_unit_index_check', 'c', 'CHECK ((unit_index >= 0))')
    ) AS x(table_name, name, kind, definition)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = pg_catalog.to_regclass('public.' || x.table_name) AND c.conname = x.name
        AND c.contype = x.kind::"char" AND c.convalidated AND NOT c.condeferrable
        AND CASE WHEN c.contype = 'c'
          THEN pg_catalog.replace(pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g'),
            'private.', '')
          ELSE (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
              FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
              JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.num)
            || CASE WHEN c.contype = 'f' THEN '>'
              || (SELECT n.nspname::text || '.' || r.relname::text FROM pg_catalog.pg_class AS r
                JOIN pg_catalog.pg_namespace AS n ON n.oid = r.relnamespace WHERE r.oid = c.confrelid)
              || '(' || (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
                FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
                JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.confrelid AND a.attnum = k.num) || ')'
              || c.confdeltype::text || c.confupdtype::text || c.confmatchtype::text
            ELSE '' END
          END = CASE WHEN x.kind = 'c' THEN pg_catalog.replace(x.definition, 'private.', '') ELSE x.definition END))
    -- The event kind CHECK depends on exactly the private function.
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_depend AS d JOIN pg_catalog.pg_constraint AS c ON c.oid = d.objid
      WHERE d.classid = 'pg_catalog.pg_constraint'::regclass AND d.refclassid = 'pg_catalog.pg_proc'::regclass
        AND c.conname = 'accounting_pending_events_event_kind_check'
        AND d.refobjid = 'private.accounting_event_kinds()'::regprocedure::oid) <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid IN (SELECT pg_catalog.to_regclass('public.' || t) FROM pg_catalog.unnest(v_tables) AS t)
        AND c.contype <> 't') <> 26
    -- The deferred sum trigger of the allocations.
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.accounting_unit_refund_allocations'::regclass
        AND t.tgname = 'accounting_unit_refund_allocations_sum'
        AND t.tgfoid = 'private.accounting_check_unit_allocation_sum()'::regprocedure AND t.tgtype = 5
        AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
        AND t.tgnargs = 0 AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr::int2[]) = 0) <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid IN (SELECT pg_catalog.to_regclass('public.' || t) FROM pg_catalog.unnest(v_tables) AS t)
        AND c.contype = 't') <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS x ON x.oid = i.indexrelid
      JOIN pg_catalog.pg_am AS am ON am.oid = x.relam
      WHERE i.indrelid IN ('public.accounting_pending_events'::regclass, 'public.accounting_journal_lines'::regclass)
        AND NOT i.indisunique AND i.indisvalid AND i.indisready AND i.indexprs IS NULL AND am.amname = 'btree'
        AND (x.relname::text, (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
          FROM pg_catalog.unnest(i.indkey::int2[]) WITH ORDINALITY AS k(num, ord)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.num),
          COALESCE(pg_catalog.pg_get_expr(i.indpred, i.indrelid), '')) IN (
          ('accounting_pending_events_open_idx', 'resolved_at,first_detected_at', ''),
          ('accounting_pending_events_order_idx', 'order_id', ''),
          ('accounting_journal_lines_order_account_idx', 'order_id,account_code', '(order_id IS NOT NULL)'))) <> 3) THEN
    v_failed := 'acc_s6_constraints';
  END IF;

  v_stage := 'acc_s6_immutable';
  -- acc_s6_immutable: BEFORE UPDATE OR DELETE (row) and BEFORE TRUNCATE (statement) on the three append-only tables,
  -- enabled ALWAYS (also under session_replication_role = replica), calling the reject function, and no other user
  -- trigger on them but the deferred sum trigger.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM pg_catalog.unnest(v_append_only) AS t(name)
      CROSS JOIN (VALUES ('_no_update_delete', 27), ('_no_truncate', 34)) AS k(suffix, kind)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS g
        WHERE g.tgrelid = pg_catalog.to_regclass('public.' || t.name) AND g.tgname::text = t.name || k.suffix
          AND g.tgfoid = 'private.reject_accounting_mutation()'::regprocedure AND g.tgtype = k.kind
          AND g.tgenabled = 'A' AND NOT g.tgisinternal AND g.tgconstraint = 0 AND NOT g.tgdeferrable
          AND g.tgnargs = 0 AND g.tgqual IS NULL))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT pg_catalog.to_regclass('public.' || t)
        FROM pg_catalog.unnest(v_append_only) AS t)) <> 7
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE NOT g.tgisinternal AND g.tgrelid = 'public.accounting_pending_events'::regclass) <> 0) THEN
    v_failed := 'acc_s6_immutable';
  END IF;

  v_stage := 'acc_s6_rls_acl';
  -- acc_s6_rls_acl: RLS on and no policy; PUBLIC, anon and authenticated hold nothing (table or column);
  -- service_role holds SELECT and nothing else.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(name)
    JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE NOT c.relrowsecurity
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = c.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
          OR (acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type <> 'SELECT'))
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type = 'SELECT')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
        WHERE pg_catalog.has_table_privilege(r.role, c.oid, q.privilege))
      OR pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')) THEN
    v_failed := 'acc_s6_rls_acl';
  END IF;

  v_stage := 'acc_s6_function_attrs';
  -- acc_s6_function_attrs: owner, SECURITY, volatility, language, result, set-returning, argument names and defaults,
  -- search_path, EXECUTE (only the three reads / writer for service_role), one function per name, and the public entries
  -- delegate.
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private', 'accounting_check_unit_allocation_sum()', true, 'v', 'plpgsql', 'trigger', '', 0, false, false),
      ('private', 'accounting_allocate_amount(bigint,bigint[])', true, 'i', 'plpgsql', 'bigint[]', '_total,_weights', 0, false, false),
      ('private', 'accounting_cutover_on()', true, 's', 'sql', 'date', '', 0, false, false),
      ('private', 'accounting_take_g_fact_seq()', true, 'v', 'plpgsql', 'record', '', 0, false, true),
      ('private', 'accounting_record_slip_fact(uuid,text)', true, 'v', 'plpgsql', 'bigint', '_slip_id,_kind', 0, false, false),
      ('private', 'accounting_g_fact_seq_at(timestamptz)', true, 's', 'sql', 'bigint', '_at', 0, false, false),
      ('private', 'accounting_shipped_units(uuid,bigint)', true, 's', 'plpgsql', 'record', '_order_item_id,_as_of_seq', 0, false, true),
      ('private', 'accounting_unit_values(uuid,bigint)', true, 's', 'sql', 'record', '_order_id,_as_of_seq', 0, false, true),
      ('private', 'accounting_record_unit_refund(text,uuid,integer,integer)', true, 'v', 'plpgsql', 'void',
        '_refund_key,_order_item_id,_unit_index,_amount', 0, false, false),
      ('private', 'accounting_pending_detail_valid(text,jsonb)', true, 'i', 'plpgsql', 'boolean', '_reason,_detail', 0, false, false),
      ('private', 'accounting_park_event(text,text,text,uuid,text,jsonb)', true, 'v', 'plpgsql', 'void',
        '_kind,_source_table,_source_id,_order_id,_reason,_detail', 0, false, false),
      ('private', 'accounting_unpark_event(text,text,text,uuid)', true, 'v', 'plpgsql', 'void',
        '_kind,_source_table,_source_id,_entry_id', 0, false, false),
      ('private', 'accounting_pending_event_json(uuid)', true, 's', 'sql', 'jsonb', '_id', 0, false, false),
      ('private', 'list_accounting_pending_events(boolean,integer,timestamptz,uuid)', true, 's', 'plpgsql', 'jsonb',
        '_include_resolved,_limit,_after_at,_after_id', 4, true, false),
      ('private', 'get_accounting_pending_summary()', true, 's', 'sql', 'jsonb', '', 0, true, false),
      ('private', 'admin_resolve_accounting_pending_event(uuid,uuid,text,uuid)', true, 'v', 'plpgsql', 'jsonb',
        '_actor_id,_event_id,_note,_request_key', 0, true, false),
      ('public', 'list_accounting_pending_events(boolean,integer,timestamptz,uuid)', false, 's', 'sql', 'jsonb',
        '_include_resolved,_limit,_after_at,_after_id', 4, true, false),
      ('public', 'get_accounting_pending_summary()', false, 's', 'sql', 'jsonb', '', 0, true, false),
      ('public', 'admin_resolve_accounting_pending_event(uuid,uuid,text,uuid)', false, 'v', 'sql', 'jsonb',
        '_actor_id,_event_id,_note,_request_key', 0, true, false)
    ) AS x(schema_name, signature, definer, volatility, language, result_type, arg_names, defaults, service, retset)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      IF v_oid IS NULL THEN v_failed := 'acc_s6_function_attrs'; EXIT; END IF;
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = v_oid;
      IF p.proowner <> 'postgres'::regrole OR p.prosecdef IS DISTINCT FROM e.definer
        OR p.provolatile <> e.volatility::"char" OR p.lanname <> e.language
        OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset IS DISTINCT FROM e.retset
        OR p.prokind <> 'f' OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames[1:p.pronargs], ','), '') <> e.arg_names
        OR p.pronargdefaults <> e.defaults
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) <> 1
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') IS DISTINCT FROM e.service
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        OR (e.schema_name = 'public' AND pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:];]', '', 'g')
          <> 'selectprivate.' || p.proname::text || '(' || e.arg_names || ')') THEN
        v_failed := 'acc_s6_function_attrs'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- None of the 13 private tools of this file has a public entry (only these names: a later task may add its own
  -- public accounting_* function, e.g. accounting_run_posting, without breaking a replay of this assert).
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
    WHERE f.pronamespace = 'public'::regnamespace AND f.proname = ANY (ARRAY['accounting_check_unit_allocation_sum',
      'accounting_allocate_amount', 'accounting_cutover_on', 'accounting_take_g_fact_seq', 'accounting_record_slip_fact',
      'accounting_g_fact_seq_at', 'accounting_shipped_units', 'accounting_unit_values', 'accounting_record_unit_refund',
      'accounting_pending_detail_valid', 'accounting_park_event', 'accounting_unpark_event',
      'accounting_pending_event_json'])) THEN
    v_failed := 'acc_s6_function_attrs';
  END IF;

  v_stage := 'acc_s6_heartbeat_check';
  -- acc_s6_heartbeat_check: the job CHECK names the eight jobs (the seven before and accounting_post), and nothing else
  -- constrains the column the same way.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.ops_job_heartbeats'::regclass AND c.conname = 'ops_job_heartbeats_job_check'
        AND c.contype = 'c' AND c.convalidated AND NOT c.condeferrable
        AND pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
          = 'CHECK ((job = ANY (ARRAY[''webhook_worker''::text, ''order_sweep''::text, ''stripe_reconcile''::text, ''order_email_worker''::text, ''order_email_delivery_check''::text, ''return_photo_purge''::text, ''delivery_tracking''::text, ''accounting_post''::text])))') <> 1) THEN
    v_failed := 'acc_s6_heartbeat_check';
  END IF;

  v_stage := 'acc_s6_seq_acl';
  -- acc_s6_seq_acl: the sequence of the facts is a bigint sequence owned by postgres that no role but the owner can use.
  IF v_failed IS NULL AND (
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_sequence AS s ON s.seqrelid = c.oid
      WHERE c.oid = pg_catalog.to_regclass('private.accounting_g_fact_seq') AND c.relkind = 'S'
        AND c.relowner = 'postgres'::regrole AND s.seqtypid = 'bigint'::regtype
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('s', c.relowner))) AS acl
          WHERE acl.grantee <> c.relowner))
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
      CROSS JOIN pg_catalog.unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS q(privilege)
      WHERE pg_catalog.has_sequence_privilege(r.role, 'private.accounting_g_fact_seq'::regclass, q.privilege))) THEN
    v_failed := 'acc_s6_seq_acl';
  END IF;

  v_stage := 'acc_s6_slip_fact_backfill';
  -- acc_s6_slip_fact_backfill: a confirmed slip has its confirm fact and a cancelled slip has both facts, except for
  -- the slips that existed without them when the baseline was taken (none at apply time).
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.shipment_slips AS s
      WHERE s.stage IN ('confirmed', 'cancelled') AND NOT EXISTS (SELECT 1 FROM public.accounting_g_slip_facts AS f
        WHERE f.slip_id = s.id AND f.kind = 'confirm'))
    + (SELECT pg_catalog.count(*) FROM public.shipment_slips AS s
      WHERE s.stage = 'cancelled' AND NOT EXISTS (SELECT 1 FROM public.accounting_g_slip_facts AS f
        WHERE f.slip_id = s.id AND f.kind = 'cancel'))
    IS DISTINCT FROM (v_baseline ->> 'missing_slip_facts')::bigint) THEN
    v_failed := 'acc_s6_slip_fact_backfill';
  END IF;

  v_stage := 'acc_s6_g_body_unchanged';
  -- acc_s6_g_body_unchanged: with every ACC_P<n> block removed and the white space dropped, the confirm and the cancel
  -- function are the latest definitions (G-4 for the confirm, G-3 for the cancel; the md5 of that text), and the
  -- ACC_P2 block is the one fact line. One digit in the pattern: a longer one would make the whole expression greedy.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(f.prosrc,
        '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g'))
      FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)'))
      IS DISTINCT FROM 'e6d4c5ad820247aa47618a951a5f6449'
    OR (SELECT pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(f.prosrc,
        '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g'))
      FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)'))
      IS DISTINCT FROM '919f4cd51d1bf67bba72b517c6a54d49'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)')
        AND pg_catalog.strpos(pg_catalog.regexp_replace(f.prosrc, '[[:space:]]+', ' ', 'g'),
          '-- ACC_P2_BEGIN PERFORM private.accounting_record_slip_fact(_slip_id, ''confirm''); -- ACC_P2_END') > 0)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)')
        AND pg_catalog.strpos(pg_catalog.regexp_replace(f.prosrc, '[[:space:]]+', ' ', 'g'),
          '-- ACC_P2_BEGIN PERFORM private.accounting_record_slip_fact(_slip_id, ''cancel''); -- ACC_P2_END') > 0)) THEN
    v_failed := 'acc_s6_g_body_unchanged';
  END IF;

  v_stage := 'acc_s6_g_function_attrs';
  -- acc_s6_g_function_attrs: arguments, result, attributes, ACL, search_path and owner of the two group G functions
  -- (and their public entries) are what G-3 / G-4 made them.
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private', 'admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)', 'plpgsql',
        '_slip_id,_expected_version,_carrier,_tracking_number,_shipment_date,_notify_customer,_actor_id,_request_key'),
      ('public', 'admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)', 'sql',
        '_slip_id,_expected_version,_carrier,_tracking_number,_shipment_date,_notify_customer,_actor_id,_request_key'),
      ('private', 'admin_cancel_shipment_slip(uuid,integer,uuid,uuid)', 'plpgsql', '_slip_id,_expected_version,_actor_id,_request_key'),
      ('public', 'admin_cancel_shipment_slip(uuid,integer,uuid,uuid)', 'sql', '_slip_id,_expected_version,_actor_id,_request_key')
    ) AS x(schema_name, signature, language, arg_names)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      IF v_oid IS NULL THEN v_failed := 'acc_s6_g_function_attrs'; EXIT; END IF;
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = v_oid;
      IF p.proowner <> 'postgres'::regrole OR p.prosecdef IS DISTINCT FROM (e.schema_name = 'private')
        OR p.provolatile <> 'v' OR p.lanname <> e.language OR p.prorettype <> 'jsonb'::regtype OR p.proretset
        OR p.prokind <> 'f' OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames, ','), '') <> e.arg_names OR p.pronargdefaults <> 0
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        OR (e.schema_name = 'public' AND pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:];]', '', 'g')
          <> 'selectprivate.' || p.proname::text || '(' || e.arg_names || ')') THEN
        v_failed := 'acc_s6_g_function_attrs'; EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s6_g_allowlist_unchanged';
  -- acc_s6_g_allowlist_unchanged: the group G writer list is what it was (md5 of the sorted OIDs) and still holds the two
  -- functions; this migration adds no writer.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(w.proc::oid::text, ',' ORDER BY w.proc::oid), ''))
      FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)) IS DISTINCT FROM (v_baseline ->> 'allowlist_md5')
    OR NOT (pg_catalog.to_regprocedure('private.admin_confirm_shipment_slip(uuid,integer,text,text,date,boolean,uuid,uuid)')
      = ANY (private.group_g_writer_allowlist()))
    OR NOT (pg_catalog.to_regprocedure('private.admin_cancel_shipment_slip(uuid,integer,uuid,uuid)')
      = ANY (private.group_g_writer_allowlist()))) THEN
    v_failed := 'acc_s6_g_allowlist_unchanged';
  END IF;

  v_stage := 'acc_s6_existing_dml_allowlist';
  -- acc_s6_existing_dml_allowlist: this migration writes no row. The four tables hold what the baseline counted (zero at
  -- apply time).
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_shipment_units) IS DISTINCT FROM (v_baseline ->> 'shipment_units')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_unit_refund_allocations)
      IS DISTINCT FROM (v_baseline ->> 'unit_refund_allocations')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_g_slip_facts) IS DISTINCT FROM (v_baseline ->> 'g_slip_facts')::bigint) THEN
    v_failed := 'acc_s6_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the
  -- SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s6_tables'), HINT = SQLSTATE;
END;
$acc_s6_final$;
-- ACC_S6_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
