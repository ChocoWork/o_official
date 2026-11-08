BEGIN;
-- Accounting plan 2 S8 (FREQ-563 AC-01..AC-06, FREQ-564 AC-01..AC-04, FREQ-569 AC-01/AC-06): the shipment posting. One confirmed
-- shipment slip becomes one entry "deferred revenue 2150 / sales 4010" (event kind shipment_confirmed, key
-- shipment_confirmed:<slip number>), one line pair per item, for the paid amount of the units that were sent minus the
-- pre-shipment refund allocations of those units, with the order on both lines. A cancelled slip gets the reversal of its
-- entry (on the original day). A corrected shipment date gets the reversal of the live entry (original day) and a new
-- entry on the new day (kind shipment_redated, key shipment_redated:<date history row id>) with the same lines; the units
-- are copied to the new entry. The group G tables and functions are read only here (no row lock, no write, no edit).
--
-- private.accounting_post_shipment_events(_limit integer DEFAULT 50) RETURNS jsonb
--   {posted, parked_new, reparked, resolved, reversed, redated}. reversed (slip cancellations) and redated (date
--   corrections) are counted inside posted too: posted is every entry the call created for a finished event. No entry point:
--   the runner of a later task (public.accounting_run_posting) is the only caller; PUBLIC, anon, authenticated and
--   service_role hold no EXECUTE.
--   * First statement after the argument check: private.accounting_lock_all(NULL) (locks 1 and 2 of the plan-1 order; the
--     core takes the period lock). The group G lock (190521,1) is the same lock, so a slip cannot be confirmed, cancelled
--     or corrected while a run is open.
--   * First, every open parked row of a slip that was cancelled, and every open parked date correction that a later
--     correction of the same slip overtook, is resolved with no entry.
--   * Then at most _limit new events, in this order: (b) live shipment entries of cancelled slips (first, so a re-shipment of
--     the same units in the same call finds the deferred revenue back); (a) confirmed slips with no entry and no parked row
--     of any state, in the order of their confirm number; (c) live shipment entries whose
--     day differs from the slip's day, with the latest correction in the date history. Then, in the same call, at most
--     10 still-open parked rows (confirm / date correction / cancellation) are looked at again, oldest last_detected_at
--     first. The two groups cannot overlap (a parked row of any state keeps an event out of the first group).
--   * Each event, from the day check to the parking or the posting, is one BEGIN ... EXCEPTION block: a failure undoes
--     that one event (the entry, its units, the cancellation and the new entry of a date correction, and the numbers), is
--     parked through private.accounting_park_failure (period_missing with the day, else posting_error with SQLSTATE and a
--     fixed code), and the next event goes on.
--   * Source times: the slip's confirmed_at for a confirmation, its cancelled_at for a cancellation, the date history row's
--     created_at for a date correction, each LEAST(..., clock_timestamp()).
-- private.accounting_shipment_plan(_slip_id, _confirm_seq) decides the units sent (private.accounting_shipped_units at the
--   confirm number of the slip) and the amounts, in one place: the payment entry of every order, the item quantities
--   against the shipments, the units, the deferred revenue of every order, the lines. A date correction does not decide
--   again: it copies the lines and the units of the entry it replaces.
-- private.accounting_shipment_date_reason(_slip_id, _date): shipment_date_mismatch or before_cutover or NULL.
-- Reads for service_role (private body + public entry): get_shipment_journal_trace(slip) and list_journal_shipment_meta(entries).
-- Labels: ACCOUNTING_LABELS.shipmentRevenue, shipmentCancelled and quantityTimes, pasted from scripts/accounting/emit-labels.ts:
--   shipmentRevenue: U&'\51FA\8377\306B\3088\308B\58F2\4E0A'
--   shipmentCancelled: U&'\51FA\8377\306E\53D6\308A\6D88\3057'
--   quantityTimes: U&' \00D7 '
--
-- ROLLBACK (only while no entry of kind shipment_confirmed or shipment_redated exists):
--   DROP FUNCTION public.get_shipment_journal_trace(uuid), public.list_journal_shipment_meta(uuid[]),
--     private.get_shipment_journal_trace(uuid), private.list_journal_shipment_meta(uuid[]),
--     private.accounting_post_shipment_events(integer), private.accounting_shipment_plan(uuid,bigint),
--     private.accounting_shipment_date_reason(uuid,date);

-- ACC_S8_BODY_BEGIN
-- The baseline the final assert compares with: row counts of the accounting tables this file must not write, and one
-- fingerprint of the group G tables (columns, constraints, user triggers) and group G functions (arguments, result,
-- attributes, body). Only catalog numbers and node trees are used, never rendered text, so the fingerprint does not depend on
-- the search_path of the caller. The text of the fingerprint query is the same in the final assert (a test compares them).
-- ACC_S8_BASELINE_BEGIN
CREATE TEMP TABLE accounting_s8_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s8_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
  'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'shipment_units', (SELECT pg_catalog.count(*) FROM public.accounting_shipment_units),
  'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods),
  'g_digest', (SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(x.part, '|' ORDER BY x.part), '')) FROM (
    SELECT 'tab:' || c.relname || ':' || c.relkind::text || ':' || c.relowner::text || ':' || c.relrowsecurity::text AS part
    FROM pg_catalog.pg_class AS c
    WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname = ANY (ARRAY['shipment_slips', 'shipment_slip_lines',
      'shipment_slip_fulfillments', 'shipment_slip_versions', 'shipment_date_history', 'order_fulfillments', 'order_fulfillment_lines'])
    UNION ALL
    SELECT 'col:' || c.relname || ':' || a.attnum::text || ':' || a.attname || ':' || a.atttypid::text || ':' || a.atttypmod::text
      || ':' || a.attnotnull::text || ':' || COALESCE(pg_catalog.md5(d.adbin::text), '')
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname = ANY (ARRAY['shipment_slips', 'shipment_slip_lines',
      'shipment_slip_fulfillments', 'shipment_slip_versions', 'shipment_date_history', 'order_fulfillments', 'order_fulfillment_lines'])
    UNION ALL
    SELECT 'con:' || c.relname || ':' || o.conname || ':' || o.contype::text || ':' || o.convalidated::text || ':'
      || COALESCE(o.conkey::text, '') || ':' || COALESCE(o.confrelid::text, '') || ':' || COALESCE(o.confkey::text, '') || ':'
      || COALESCE(pg_catalog.md5(o.conbin::text), '')
    FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_constraint AS o ON o.conrelid = c.oid
    WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname = ANY (ARRAY['shipment_slips', 'shipment_slip_lines',
      'shipment_slip_fulfillments', 'shipment_slip_versions', 'shipment_date_history', 'order_fulfillments', 'order_fulfillment_lines'])
    UNION ALL
    SELECT 'trg:' || c.relname || ':' || t.tgname || ':' || t.tgenabled::text || ':' || t.tgtype::text || ':' || t.tgfoid::text
      || ':' || COALESCE(t.tgattr::text, '') || ':' || COALESCE(pg_catalog.md5(t.tgqual::text), '')
    FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_trigger AS t ON t.tgrelid = c.oid
    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname = ANY (ARRAY['shipment_slips',
      'shipment_slip_lines', 'shipment_slip_fulfillments', 'shipment_slip_versions', 'shipment_date_history', 'order_fulfillments',
      'order_fulfillment_lines'])
    UNION ALL
    SELECT 'fn:' || n.nspname || '.' || p.proname || ':' || p.proargtypes::text || ':' || p.prorettype::text || ':'
      || p.prosecdef::text || ':' || p.provolatile::text || ':' || COALESCE(p.proconfig::text, '') || ':' || pg_catalog.md5(p.prosrc)
    FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f' AND p.proname ~ '(shipment|fulfillment|group_g_)'
      AND p.proname !~ '^accounting_'
      AND p.proname NOT IN ('get_shipment_journal_trace', 'list_journal_shipment_meta')
  ) AS x));
-- ACC_S8_BASELINE_END

-- 1. The day of the slip against the shipments and the cutover day. NULL when both are fine.
CREATE FUNCTION private.accounting_shipment_date_reason(_slip_id uuid, _date date) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cutover date;
BEGIN
  IF _slip_id IS NULL OR _date IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shipment_slip_fulfillments AS sf
    JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id
    WHERE sf.slip_id = _slip_id AND f.cancelled_at IS NULL AND f.shipment_date IS DISTINCT FROM _date) THEN
    RETURN 'shipment_date_mismatch';
  END IF;
  v_cutover := private.accounting_cutover_on();
  IF v_cutover IS NOT NULL AND _date < v_cutover THEN
    RETURN 'before_cutover';
  END IF;
  RETURN NULL;
END;
$$;

-- 1b. The order of a slip that has exactly one order (NULL for several), known before any check, so every park of the slip
--     carries it.
CREATE FUNCTION private.accounting_shipment_single_order(_slip_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN (SELECT CASE WHEN pg_catalog.count(DISTINCT sf.order_id) = 1 THEN pg_catalog.min(sf.order_id::text)::uuid END
    FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = _slip_id);
END;
$$;

-- 2. The one place that decides the units sent and the amounts of a confirmed slip. The answer is
--    {reason, detail, order_ids} when the slip cannot be posted (reason in payment_journal_missing, shipment_lines_mismatch,
--    units_insufficient, deferred_revenue_short, no_revenue) and {reason: null, lines, units, order_ids} otherwise.
--    Only items of order_items.line_kind = 'order' count (an exchange item never becomes revenue). The refund allocations
--    counted are those with a number below the confirm number of the slip (the answer never changes after later rows).
CREATE FUNCTION private.accounting_shipment_plan(_slip_id uuid, _confirm_seq bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_orders uuid[];
  v_order_count integer;
  v_item record;
  v_unit record;
  v_order record;
  v_taken integer[];
  v_item_amount bigint;
  v_balance bigint;
  v_shortage bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_units jsonb := '[]'::jsonb;
  v_lines jsonb;
BEGIN
  IF _slip_id IS NULL OR _confirm_seq IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(DISTINCT sf.order_id ORDER BY sf.order_id) INTO v_orders
  FROM public.shipment_slip_fulfillments AS sf WHERE sf.slip_id = _slip_id;
  v_orders := COALESCE(v_orders, ARRAY[]::uuid[]);
  v_order_count := 0;

  -- Every order of the slip needs a payment entry that is not reversed. The state and the payment time of the order
  -- are not looked at: the books decide.
  -- order_count is the number of orders of the slip that have none.
  SELECT pg_catalog.count(*) INTO v_order_count FROM pg_catalog.unnest(v_orders) AS o(id) WHERE NOT EXISTS (
    SELECT 1 FROM public.accounting_journal_lines AS l
    JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
    WHERE l.order_id = o.id AND l.account_code = '2150' AND e.event_kind = 'payment_confirmed'
      AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id));
  IF v_order_count > 0 THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'payment_journal_missing',
      'detail', pg_catalog.jsonb_build_object('order_count', v_order_count), 'order_ids', pg_catalog.to_jsonb(v_orders));
  END IF;

  -- The slip's own lines are the truth; the lines of the (not cancelled) shipments must say the same per item.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT l.order_item_id, pg_catalog.sum(l.quantity)::bigint AS quantity FROM public.shipment_slip_lines AS l
      WHERE l.slip_id = _slip_id GROUP BY l.order_item_id) AS a
    FULL JOIN (
      SELECT fl.order_item_id, pg_catalog.sum(fl.quantity)::bigint AS quantity
      FROM public.shipment_slip_fulfillments AS sf
      JOIN public.order_fulfillments AS f ON f.id = sf.fulfillment_id AND f.cancelled_at IS NULL
      JOIN public.order_fulfillment_lines AS fl ON fl.fulfillment_id = f.id
      WHERE sf.slip_id = _slip_id GROUP BY fl.order_item_id) AS b ON b.order_item_id = a.order_item_id
    WHERE a.quantity IS DISTINCT FROM b.quantity) THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'shipment_lines_mismatch', 'detail', '{}'::jsonb,
      'order_ids', pg_catalog.to_jsonb(v_orders));
  END IF;

  FOR v_item IN
    SELECT l.order_item_id, l.quantity, oi.order_id, oi.item_name, oi.line_kind
    FROM public.shipment_slip_lines AS l JOIN public.order_items AS oi ON oi.id = l.order_item_id
    WHERE l.slip_id = _slip_id ORDER BY oi.order_id, l.order_item_id
  LOOP
    CONTINUE WHEN v_item.line_kind <> 'order';
    v_taken := ARRAY(SELECT su.unit_index FROM private.accounting_shipped_units(v_item.order_item_id, _confirm_seq) AS su
      WHERE su.slip_id = _slip_id ORDER BY su.unit_index);
    IF COALESCE(pg_catalog.cardinality(v_taken), 0) <> v_item.quantity THEN
      RETURN pg_catalog.jsonb_build_object('reason', 'units_insufficient', 'detail', '{}'::jsonb,
        'order_ids', pg_catalog.to_jsonb(v_orders));
    END IF;
    v_item_amount := 0;
    FOR v_unit IN
      SELECT u.unit_index, u.paid_amount,
        COALESCE((SELECT pg_catalog.sum(a.amount) FROM public.accounting_unit_refund_allocations AS a
          WHERE a.order_item_id = u.order_item_id AND a.unit_index = u.unit_index AND a.fact_seq < _confirm_seq), 0)::integer AS refunded
      FROM public.order_line_unit_amounts AS u
      WHERE u.order_item_id = v_item.order_item_id AND u.unit_index = ANY (v_taken) ORDER BY u.unit_index
    LOOP
      v_units := v_units || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('order_item_id', v_item.order_item_id,
        'unit_index', v_unit.unit_index, 'paid_amount', v_unit.paid_amount, 'refunded_amount', v_unit.refunded));
      v_item_amount := v_item_amount + v_unit.paid_amount - v_unit.refunded;
    END LOOP;
    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('idx', pg_catalog.jsonb_array_length(v_rows),
      'order_id', v_item.order_id, 'name', v_item.item_name, 'quantity', v_item.quantity, 'amount', v_item_amount));
  END LOOP;

  -- The deferred revenue of every order must cover what is sent (all entries of the order, reversals included).
  FOR v_order IN
    SELECT r.order_id, pg_catalog.sum(r.amount) AS amount
    FROM pg_catalog.jsonb_to_recordset(v_rows) AS r(order_id uuid, amount bigint)
    GROUP BY r.order_id HAVING pg_catalog.sum(r.amount) > 0 ORDER BY r.order_id
  LOOP
    SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0) INTO v_balance FROM public.accounting_journal_lines AS l
    WHERE l.order_id = v_order.order_id AND l.account_code = '2150';
    IF v_order.amount > v_balance THEN
      v_shortage := v_shortage + (v_order.amount - v_balance);
    END IF;
  END LOOP;
  IF v_shortage > 0 THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'deferred_revenue_short',
      'detail', pg_catalog.jsonb_build_object('shortage', v_shortage), 'order_ids', pg_catalog.to_jsonb(v_orders));
  END IF;

  -- One pair of lines per item (debit 2150, credit 4010); an item worth nothing makes no line.
  SELECT COALESCE(pg_catalog.jsonb_agg(x.line ORDER BY x.idx, x.side), '[]'::jsonb) INTO v_lines FROM (
    SELECT r.idx, s.side,
      CASE s.side
        WHEN 1 THEN pg_catalog.jsonb_build_object('account_code', '2150', 'debit', r.amount, 'credit', 0,
          'order_id', r.order_id::text, 'memo', r.name || U&' \00D7 ' || r.quantity::text)
        ELSE pg_catalog.jsonb_build_object('account_code', '4010', 'debit', 0, 'credit', r.amount, 'order_id', r.order_id::text)
      END AS line
    FROM pg_catalog.jsonb_to_recordset(v_rows) AS r(idx integer, order_id uuid, name text, quantity integer, amount bigint)
    CROSS JOIN (VALUES (1), (2)) AS s(side)
    WHERE r.amount > 0) AS x;
  IF pg_catalog.jsonb_array_length(v_lines) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('reason', 'no_revenue', 'detail', '{}'::jsonb, 'order_ids', pg_catalog.to_jsonb(v_orders));
  END IF;
  RETURN pg_catalog.jsonb_build_object('reason', NULL, 'lines', v_lines, 'units', v_units, 'order_ids', pg_catalog.to_jsonb(v_orders));
END;
$$;

-- 3. The poster. Order inside one call: the lock, the sweep of parked rows that cannot be posted any more, the jobs.
CREATE FUNCTION private.accounting_post_shipment_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_job record;
  v_swept record;
  v_slip public.shipment_slips%ROWTYPE;
  v_entry public.accounting_journal_entries%ROWTYPE;
  v_hist public.shipment_date_history%ROWTYPE;
  v_kind text;
  v_table text;
  v_source_id text;
  v_reason text;
  v_detail jsonb;
  v_date date;
  v_period uuid;
  v_order_id uuid;
  v_seq bigint;
  v_plan jsonb;
  v_lines jsonb;
  v_result jsonb;
  v_entry_id uuid;
  v_existing uuid;
  v_sqlstate text;
  v_pg_detail text;
  v_parked boolean;
  v_posted integer := 0;
  v_parked_new integer := 0;
  v_reparked integer := 0;
  v_resolved integer := 0;
  v_reversed integer := 0;
  v_redated integer := 0;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);

  -- Parked rows that cannot be posted any more: the slip was cancelled, or a later correction of the same slip overtook the
  -- parked one. They close with no entry.
  FOR v_swept IN
    SELECT p.event_kind, p.source_table, p.source_id FROM public.accounting_pending_events AS p
    WHERE p.resolved_at IS NULL AND (
      (p.event_kind = 'shipment_confirmed' AND p.source_table = 'shipment_slips' AND EXISTS (
        SELECT 1 FROM public.shipment_slips AS s WHERE s.id::text = p.source_id AND s.stage = 'cancelled'))
      OR (p.event_kind = 'shipment_redated' AND p.source_table = 'shipment_date_history' AND EXISTS (
        SELECT 1 FROM public.shipment_date_history AS h JOIN public.shipment_slips AS s ON s.id = h.slip_id
        WHERE h.id::text = p.source_id AND (s.stage = 'cancelled' OR h.id IS DISTINCT FROM (
          SELECT d.id FROM public.shipment_date_history AS d WHERE d.slip_id = s.id AND d.kind = 'correction'
          ORDER BY d.version DESC LIMIT 1)))))
    ORDER BY p.id
  LOOP
    BEGIN
      PERFORM private.accounting_unpark_event(v_swept.event_kind, v_swept.source_table, v_swept.source_id, NULL);
      v_resolved := v_resolved + 1;
    EXCEPTION WHEN OTHERS THEN
      -- One row that cannot be closed must not stop the call: it stays open and is tried again next time.
      NULL;
    END;
  END LOOP;

  FOR v_job IN
    SELECT j.task, j.lane, j.slip_id, j.entry_id, j.history_id FROM (
      (SELECT n.task, n.lane, n.phase, n.slip_id, n.entry_id, n.history_id, n.sort_a, n.sort_b FROM (
        (SELECT 'confirm'::text AS task, 0 AS lane, 2 AS phase, s.id AS slip_id, NULL::uuid AS entry_id, NULL::uuid AS history_id,
           COALESCE(f.fact_seq, 9223372036854775807)::numeric AS sort_a, s.id AS sort_b
         FROM public.shipment_slips AS s
         LEFT JOIN public.accounting_g_slip_facts AS f ON f.slip_id = s.id AND f.kind = 'confirm'
         WHERE s.stage = 'confirmed'
           AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
             WHERE e.dedupe_key = private.accounting_event_key('shipment_confirmed', ARRAY[s.number]))
           AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
             WHERE p.event_kind = 'shipment_confirmed' AND p.source_table = 'shipment_slips' AND p.source_id = s.id::text)
         ORDER BY COALESCE(f.fact_seq, 9223372036854775807), s.id
         LIMIT _limit)
        UNION ALL
        (SELECT 'cancel'::text, 0, 1, s.id, e.id, NULL::uuid, COALESCE(x.fact_seq, 0)::numeric, e.id
         FROM public.accounting_journal_entries AS e
         JOIN public.shipment_slips AS s ON e.source_table = 'shipment_slips' AND e.source_id = s.id::text
         LEFT JOIN public.accounting_g_slip_facts AS x ON x.slip_id = s.id AND x.kind = 'cancel'
         WHERE e.event_kind IN ('shipment_confirmed', 'shipment_redated') AND s.stage = 'cancelled'
           AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
             WHERE p.event_kind = 'reversal' AND p.source_table = 'accounting_journal_entries' AND p.source_id = e.id::text)
         ORDER BY COALESCE(x.fact_seq, 0), e.id
         LIMIT _limit)
        UNION ALL
        (SELECT 'redate'::text, 0, 3, s.id, e.id, h.id, EXTRACT(EPOCH FROM h.created_at)::numeric, e.id
         FROM public.accounting_journal_entries AS e
         JOIN public.shipment_slips AS s ON e.source_table = 'shipment_slips' AND e.source_id = s.id::text AND s.stage = 'confirmed'
         JOIN LATERAL (SELECT d.id, d.created_at FROM public.shipment_date_history AS d
           WHERE d.slip_id = s.id AND d.kind = 'correction' ORDER BY d.version DESC LIMIT 1) AS h ON true
         WHERE e.event_kind IN ('shipment_confirmed', 'shipment_redated') AND e.entry_date <> s.shipment_date
           AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
             WHERE p.event_kind = 'shipment_redated' AND p.source_table = 'shipment_date_history' AND p.source_id = h.id::text)
           AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r
             WHERE r.dedupe_key = private.accounting_event_key('shipment_redated', ARRAY[h.id::text]))
         ORDER BY h.created_at, e.id
         LIMIT _limit)
      ) AS n ORDER BY n.phase, n.sort_a, n.sort_b LIMIT _limit)
      UNION ALL
      (SELECT r.task, r.lane, r.phase, r.slip_id, r.entry_id, r.history_id, r.sort_a, r.sort_b FROM (
        (SELECT 'confirm'::text AS task, 1 AS lane, 2 AS phase, s.id AS slip_id, NULL::uuid AS entry_id, NULL::uuid AS history_id,
           EXTRACT(EPOCH FROM p.last_detected_at)::numeric AS sort_a, p.id AS sort_b
         FROM public.accounting_pending_events AS p
         JOIN public.shipment_slips AS s ON p.source_table = 'shipment_slips' AND p.source_id = s.id::text
         WHERE p.resolved_at IS NULL AND p.event_kind = 'shipment_confirmed' AND s.stage = 'confirmed')
        UNION ALL
        (SELECT 'redate'::text, 1, 3, s.id, NULL::uuid, h.id, EXTRACT(EPOCH FROM p.last_detected_at)::numeric, p.id
         FROM public.accounting_pending_events AS p
         JOIN public.shipment_date_history AS h ON p.source_table = 'shipment_date_history' AND p.source_id = h.id::text
         JOIN public.shipment_slips AS s ON s.id = h.slip_id AND s.stage = 'confirmed'
         WHERE p.resolved_at IS NULL AND p.event_kind = 'shipment_redated')
        UNION ALL
        (SELECT 'cancel'::text, 1, 1, s.id, e.id, NULL::uuid, EXTRACT(EPOCH FROM p.last_detected_at)::numeric, p.id
         FROM public.accounting_pending_events AS p
         JOIN public.accounting_journal_entries AS e ON p.source_table = 'accounting_journal_entries' AND p.source_id = e.id::text
         JOIN public.shipment_slips AS s ON e.source_table = 'shipment_slips' AND e.source_id = s.id::text
         WHERE p.resolved_at IS NULL AND p.event_kind = 'reversal')
      ) AS r ORDER BY r.sort_a, r.sort_b LIMIT 10)
    ) AS j
    ORDER BY j.lane, j.phase, j.sort_a, j.sort_b
  LOOP
    v_reason := NULL;
    v_detail := '{}'::jsonb;
    v_date := NULL;
    v_period := NULL;
    v_order_id := NULL;
    IF v_job.task = 'confirm' THEN
      v_kind := 'shipment_confirmed';
      v_table := 'shipment_slips';
      v_source_id := v_job.slip_id::text;
    ELSIF v_job.task = 'redate' THEN
      v_kind := 'shipment_redated';
      v_table := 'shipment_date_history';
      v_source_id := v_job.history_id::text;
    ELSE
      v_kind := 'reversal';
      v_table := 'accounting_journal_entries';
      v_source_id := v_job.entry_id::text;
    END IF;
    BEGIN
      IF v_job.task = 'confirm' THEN
        SELECT * INTO v_slip FROM public.shipment_slips AS s WHERE s.id = v_job.slip_id;
        IF NOT FOUND OR v_slip.stage <> 'confirmed' THEN
          CONTINUE;
        END IF;
        SELECT e.id INTO v_existing FROM public.accounting_journal_entries AS e
        WHERE e.dedupe_key = private.accounting_event_key('shipment_confirmed', ARRAY[v_slip.number]);
        IF FOUND THEN
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event(v_kind, v_table, v_source_id, v_existing);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        SELECT f.fact_seq INTO v_seq FROM public.accounting_g_slip_facts AS f WHERE f.slip_id = v_slip.id AND f.kind = 'confirm';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
        END IF;
        -- The day check, then the period, then the amounts: an owner action (the period) shows before the money checks.
        v_date := v_slip.shipment_date;
        v_order_id := private.accounting_shipment_single_order(v_slip.id);
        v_reason := private.accounting_shipment_date_reason(v_slip.id, v_date);
        IF v_reason IS NULL THEN
          v_period := private.accounting_period_for_event(v_date);
          v_plan := private.accounting_shipment_plan(v_slip.id, v_seq);
          v_reason := v_plan ->> 'reason';
          v_detail := COALESCE(v_plan -> 'detail', '{}'::jsonb);
          IF pg_catalog.jsonb_array_length(v_plan -> 'order_ids') = 1 THEN
            v_order_id := (v_plan -> 'order_ids' ->> 0)::uuid;
          END IF;
        END IF;
        IF v_reason = 'no_revenue' THEN
          -- Nothing to book (an exchange-only slip): the row is closed at once and keeps the slip out of the next runs.
          PERFORM private.accounting_park_event(v_kind, v_table, v_source_id, v_order_id, 'no_revenue', '{}'::jsonb);
          PERFORM private.accounting_unpark_event(v_kind, v_table, v_source_id, NULL);
          IF v_job.lane = 0 THEN
            v_parked_new := v_parked_new + 1;
          END IF;
          v_resolved := v_resolved + 1;
        ELSIF v_reason IS NOT NULL THEN
          PERFORM private.accounting_park_event(v_kind, v_table, v_source_id, v_order_id, v_reason, v_detail);
          IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
        ELSE
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'shipment_confirmed',
            ARRAY[v_slip.number], U&'\51FA\8377\306B\3088\308B\58F2\4E0A', v_plan -> 'lines',
            _source_table => 'shipment_slips', _source_id => v_slip.id::text,
            _source_recorded_at => LEAST(v_slip.confirmed_at, pg_catalog.clock_timestamp()));
          v_entry_id := (v_result ->> 'entry_id')::uuid;
          IF (v_result ->> 'created')::boolean THEN
            INSERT INTO public.accounting_shipment_units (entry_id, order_item_id, unit_index, paid_amount, refunded_amount)
            SELECT v_entry_id, u.order_item_id, u.unit_index, u.paid_amount, u.refunded_amount
            FROM pg_catalog.jsonb_to_recordset(v_plan -> 'units')
              AS u(order_item_id uuid, unit_index integer, paid_amount integer, refunded_amount integer);
            v_posted := v_posted + 1;
          END IF;
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event(v_kind, v_table, v_source_id, v_entry_id);
            v_resolved := v_resolved + 1;
          END IF;
        END IF;

      ELSIF v_job.task = 'redate' THEN
        SELECT * INTO v_slip FROM public.shipment_slips AS s WHERE s.id = v_job.slip_id;
        IF NOT FOUND OR v_slip.stage <> 'confirmed' THEN
          CONTINUE;
        END IF;
        SELECT d.* INTO v_hist FROM public.shipment_date_history AS d
        WHERE d.slip_id = v_slip.id AND d.kind = 'correction' ORDER BY d.version DESC LIMIT 1;
        IF NOT FOUND OR v_hist.id IS DISTINCT FROM v_job.history_id THEN
          CONTINUE;
        END IF;
        IF v_job.entry_id IS NULL THEN
          SELECT e.* INTO v_entry FROM public.accounting_journal_entries AS e
          WHERE e.source_table = 'shipment_slips' AND e.source_id = v_slip.id::text
            AND e.event_kind IN ('shipment_confirmed', 'shipment_redated')
            AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
          ORDER BY e.recorded_at DESC, e.entry_no DESC LIMIT 1;
        ELSE
          SELECT e.* INTO v_entry FROM public.accounting_journal_entries AS e WHERE e.id = v_job.entry_id;
        END IF;
        IF NOT FOUND OR v_entry.entry_date = v_slip.shipment_date OR EXISTS (
          SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = v_entry.id) THEN
          -- Nothing left to move: the live entry already has the day of the slip (or there is none).
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event(v_kind, v_table, v_source_id, NULL);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        -- The new day is checked first: when it cannot be posted the live entry is not reversed.
        v_date := v_slip.shipment_date;
        v_order_id := private.accounting_shipment_single_order(v_slip.id);
        v_reason := private.accounting_shipment_date_reason(v_slip.id, v_date);
        IF v_reason IS NULL THEN
          v_period := private.accounting_period_for_event(v_date);
        END IF;
        IF v_reason IS NOT NULL THEN
          PERFORM private.accounting_park_event(v_kind, v_table, v_source_id, v_order_id, v_reason, '{}'::jsonb);
          IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
        ELSE
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('account_code', l.account_code, 'debit', l.debit,
            'credit', l.credit, 'sub_account', l.sub_account, 'counterparty', l.counterparty, 'order_id', l.order_id::text,
            'memo', l.memo) ORDER BY l.line_no)
          INTO v_lines FROM public.accounting_journal_lines AS l WHERE l.entry_id = v_entry.id;
          PERFORM private.accounting_reverse_journal_core(NULL, v_entry.id, v_hist.reason, NULL,
            LEAST(v_hist.created_at, pg_catalog.clock_timestamp()));
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'shipment_redated',
            ARRAY[v_hist.id::text], U&'\51FA\8377\306B\3088\308B\58F2\4E0A', v_lines,
            _source_table => 'shipment_slips', _source_id => v_slip.id::text,
            _source_recorded_at => LEAST(v_hist.created_at, pg_catalog.clock_timestamp()));
          v_entry_id := (v_result ->> 'entry_id')::uuid;
          INSERT INTO public.accounting_shipment_units (entry_id, order_item_id, unit_index, paid_amount, refunded_amount)
          SELECT v_entry_id, u.order_item_id, u.unit_index, u.paid_amount, u.refunded_amount
          FROM public.accounting_shipment_units AS u WHERE u.entry_id = v_entry.id;
          v_posted := v_posted + 1;
          v_redated := v_redated + 1;
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event(v_kind, v_table, v_source_id, v_entry_id);
            v_resolved := v_resolved + 1;
          END IF;
        END IF;

      ELSE
        SELECT e.* INTO v_entry FROM public.accounting_journal_entries AS e WHERE e.id = v_job.entry_id;
        IF NOT FOUND THEN
          CONTINUE;
        END IF;
        v_date := v_entry.entry_date;
        SELECT r.id INTO v_existing FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = v_entry.id;
        IF FOUND THEN
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event(v_kind, v_table, v_source_id, v_existing);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        SELECT s.* INTO v_slip FROM public.shipment_slips AS s
        WHERE v_entry.source_table = 'shipment_slips' AND s.id::text = v_entry.source_id;
        IF NOT FOUND OR v_slip.stage <> 'cancelled' THEN
          CONTINUE;
        END IF;
        v_result := private.accounting_reverse_journal_core(NULL, v_entry.id, U&'\51FA\8377\306E\53D6\308A\6D88\3057', NULL,
          LEAST(v_slip.cancelled_at, pg_catalog.clock_timestamp()));
        IF (v_result ->> 'created')::boolean THEN
          v_posted := v_posted + 1;
          v_reversed := v_reversed + 1;
        END IF;
        IF v_job.lane = 1 THEN
          PERFORM private.accounting_unpark_event(v_kind, v_table, v_source_id, (v_result ->> 'entry_id')::uuid);
          v_resolved := v_resolved + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- The rows and the entry numbers of this one event (a date correction: both halves) are undone with the block. Only
      -- the SQLSTATE and a fixed code are kept; the text of the exception is never stored.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure(v_kind, v_table, v_source_id, v_order_id, v_sqlstate, SQLERRM, v_pg_detail, v_date);
      -- false: nothing could be parked; the event is counted nowhere and is taken again as a new event next run.
      IF v_parked THEN
        IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved, 'reversed', v_reversed, 'redated', v_redated);
END;
$$;

-- 4. Reads for service_role.
-- From a slip: the slip, its date history (reason, person, days before and after) and every entry that carries the slip as its
-- source (the shipment entry, the reversals, the redated entries).
CREATE FUNCTION private.get_shipment_journal_trace(_slip_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_slip public.shipment_slips%ROWTYPE;
BEGIN
  IF _slip_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_slip FROM public.shipment_slips AS s WHERE s.id = _slip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'slip', pg_catalog.jsonb_build_object('number', v_slip.number, 'confirmed_at', v_slip.confirmed_at,
      'shipment_date', pg_catalog.to_char(v_slip.shipment_date, 'YYYY-MM-DD'), 'stage', v_slip.stage),
    'history', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('version', h.version, 'kind', h.kind,
        'previous_date', pg_catalog.to_char(h.previous_date, 'YYYY-MM-DD'), 'new_date', pg_catalog.to_char(h.new_date, 'YYYY-MM-DD'),
        'reason', h.reason, 'actor_id', h.actor_id, 'created_at', h.created_at) ORDER BY h.version)
      FROM public.shipment_date_history AS h WHERE h.slip_id = _slip_id), '[]'::jsonb),
    'entries', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('entry_id', e.id, 'entry_no', e.entry_no,
        'event_kind', e.event_kind, 'entry_date', pg_catalog.to_char(e.entry_date, 'YYYY-MM-DD'), 'recorded_at', e.recorded_at,
        'reverses_entry_id', e.reverses_entry_id) ORDER BY e.recorded_at, e.entry_no, e.id)
      FROM public.accounting_journal_entries AS e WHERE e.source_table = 'shipment_slips' AND e.source_id = _slip_id::text), '[]'::jsonb));
END;
$$;

-- From entries (up to 200): the slip number, the shipment day and the day the slip was confirmed, for the entries whose source
-- is a shipment slip (the confirmed day is the slip's confirmed_at, not the time the entry was stored).
CREATE FUNCTION private.list_journal_shipment_meta(_entry_ids uuid[])
RETURNS TABLE(entry_id uuid, slip_number text, shipment_date date, confirmed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _entry_ids IS NULL OR pg_catalog.cardinality(_entry_ids) > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT DISTINCT e.id, s.number, s.shipment_date, s.confirmed_at
  FROM pg_catalog.unnest(_entry_ids) AS i(id)
  JOIN public.accounting_journal_entries AS e ON e.id = i.id
  JOIN public.shipment_slips AS s ON e.source_table = 'shipment_slips' AND e.source_id = s.id::text
  ORDER BY e.id;
END;
$$;

CREATE FUNCTION public.get_shipment_journal_trace(_slip_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_shipment_journal_trace(_slip_id) $$;

CREATE FUNCTION public.list_journal_shipment_meta(_entry_ids uuid[])
RETURNS TABLE(entry_id uuid, slip_number text, shipment_date date, confirmed_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT m.entry_id, m.slip_number, m.shipment_date, m.confirmed_at FROM private.list_journal_shipment_meta(_entry_ids) AS m $$;

-- 5. Owners and EXECUTE. The poster, the plan and the day check are owner only; the two reads (private and public) are for
--    service_role.
ALTER FUNCTION private.accounting_shipment_date_reason(uuid,date) OWNER TO postgres;
ALTER FUNCTION private.accounting_shipment_plan(uuid,bigint) OWNER TO postgres;
ALTER FUNCTION private.accounting_shipment_single_order(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_shipment_events(integer) OWNER TO postgres;
ALTER FUNCTION private.get_shipment_journal_trace(uuid) OWNER TO postgres;
ALTER FUNCTION private.list_journal_shipment_meta(uuid[]) OWNER TO postgres;
ALTER FUNCTION public.get_shipment_journal_trace(uuid) OWNER TO postgres;
ALTER FUNCTION public.list_journal_shipment_meta(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_shipment_date_reason(uuid,date), private.accounting_shipment_plan(uuid,bigint),
  private.accounting_shipment_single_order(uuid), private.accounting_post_shipment_events(integer), private.get_shipment_journal_trace(uuid),
  private.list_journal_shipment_meta(uuid[]), public.get_shipment_journal_trace(uuid), public.list_journal_shipment_meta(uuid[])
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.get_shipment_journal_trace(uuid), private.list_journal_shipment_meta(uuid[]),
  public.get_shipment_journal_trace(uuid), public.list_journal_shipment_meta(uuid[])
TO service_role;
-- ACC_S8_BODY_END

-- ACC_S8_FINAL_ASSERT_BEGIN
-- Catalog meaning only (never ACL text).
-- acc_s8_functions: the three private functions exist once each and their text keeps the rules of the plan (the first lock,
--   the units from the one tool, the accounts, the keys through the core, the reversal core, the source times, the failure
--   helper, no row lock, nothing of the order's state or payment time).
-- acc_s8_function_attrs: owner, SECURITY, volatility, language, result, arguments, search_path and EXECUTE of the seven functions.
-- acc_s8_reads_stable: the two reads (private and public) are STABLE and their text writes nothing.
-- acc_s8_g_untouched: the group G tables (columns, constraints, user triggers) and functions are the same as before this file.
-- acc_s8_existing_dml_allowlist: this migration wrote no row (entries, lines, parked events, units and periods are what the
--   baseline counted).
DO $acc_s8_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_oid oid;
  v_src text;
  v_baseline jsonb;
  v_digest text;
  v_p record;
  v_e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s8_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s8_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s8_baseline) <> 1 THEN
    v_failed := 'acc_s8_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s8_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['entries', 'lines', 'pending_events', 'shipment_units', 'periods', 'g_digest'])
        AS k(name) WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s8_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s8_functions';
  IF v_failed IS NULL THEN
    v_oid := pg_catalog.to_regprocedure('private.accounting_post_shipment_events(integer)');
    IF v_oid IS NULL
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
        WHERE o.pronamespace = 'private'::regnamespace AND o.proname = 'accounting_post_shipment_events') <> 1 THEN
      v_failed := 'acc_s8_functions';
    ELSE
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF pg_catalog.strpos(v_src, 'PERFORM private.accounting_lock_all(NULL);') = 0
        OR pg_catalog.strpos(v_src, 'PERFORM private.accounting_lock_all(NULL);') > pg_catalog.strpos(v_src, 'FOR v_swept IN')
        OR pg_catalog.strpos(v_src, 'PERFORM private.accounting_lock_all(NULL);') > pg_catalog.strpos(v_src, 'FOR v_job IN')
        OR pg_catalog.strpos(v_src, 'private.accounting_post_journal_core(NULL, v_period, v_date, ''shipment_confirmed'',') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_post_journal_core(NULL, v_period, v_date, ''shipment_redated'',') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_reverse_journal_core(NULL, v_entry.id,') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_shipment_plan(v_slip.id, v_seq)') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_shipment_date_reason(v_slip.id, v_date)') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_period_for_event(v_date)') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_event_key(''shipment_confirmed'', ARRAY[s.number])') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_event_key(''shipment_redated'', ARRAY[h.id::text])') = 0
        OR pg_catalog.strpos(v_src, '_source_recorded_at => LEAST(v_slip.confirmed_at, pg_catalog.clock_timestamp())') = 0
        OR pg_catalog.strpos(v_src, 'LEAST(v_slip.cancelled_at, pg_catalog.clock_timestamp())') = 0
        OR pg_catalog.strpos(v_src, '_source_recorded_at => LEAST(v_hist.created_at, pg_catalog.clock_timestamp())') = 0
        OR pg_catalog.strpos(v_src, 'LEAST(v_hist.created_at, pg_catalog.clock_timestamp())') = 0
        OR pg_catalog.strpos(v_src, 'EXCEPTION WHEN OTHERS') = 0
        OR pg_catalog.strpos(v_src, 'v_parked := private.accounting_park_failure(v_kind,') = 0
        OR pg_catalog.strpos(v_src, 'IF v_parked THEN') = 0
        OR v_src ~* 'paid_at' OR v_src ~* 'public\.orders\M' OR v_src ~* 'FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)' THEN
        v_failed := 'acc_s8_functions';
      END IF;
    END IF;
    IF v_failed IS NULL THEN
      v_oid := pg_catalog.to_regprocedure('private.accounting_shipment_plan(uuid,bigint)');
      IF v_oid IS NULL
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = 'private'::regnamespace AND o.proname = 'accounting_shipment_plan') <> 1 THEN
        v_failed := 'acc_s8_functions';
      ELSE
        SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
        IF pg_catalog.strpos(v_src, 'private.accounting_shipped_units(v_item.order_item_id, _confirm_seq)') = 0
          OR pg_catalog.strpos(v_src, 'public.accounting_unit_refund_allocations') = 0
          OR pg_catalog.strpos(v_src, 'a.fact_seq < _confirm_seq') = 0
          OR pg_catalog.strpos(v_src, '''2150''') = 0 OR pg_catalog.strpos(v_src, '''4010''') = 0
          OR pg_catalog.strpos(v_src, '''payment_confirmed''') = 0
          OR pg_catalog.strpos(v_src, 'payment_journal_missing') = 0 OR pg_catalog.strpos(v_src, 'shipment_lines_mismatch') = 0
          OR pg_catalog.strpos(v_src, 'units_insufficient') = 0 OR pg_catalog.strpos(v_src, 'deferred_revenue_short') = 0
          OR pg_catalog.strpos(v_src, 'no_revenue') = 0
          OR pg_catalog.strpos(v_src, 'v_item.line_kind <> ''order''') = 0
          OR v_src ~* 'paid_at' OR v_src ~* 'public\.orders\M' OR v_src ~* 'FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)' THEN
          v_failed := 'acc_s8_functions';
        END IF;
      END IF;
    END IF;
    IF v_failed IS NULL THEN
      v_oid := pg_catalog.to_regprocedure('private.accounting_shipment_date_reason(uuid,date)');
      IF v_oid IS NULL
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = 'private'::regnamespace AND o.proname = 'accounting_shipment_date_reason') <> 1 THEN
        v_failed := 'acc_s8_functions';
      ELSE
        SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
        IF pg_catalog.strpos(v_src, 'shipment_date_mismatch') = 0 OR pg_catalog.strpos(v_src, 'before_cutover') = 0
          OR pg_catalog.strpos(v_src, 'private.accounting_cutover_on()') = 0
          OR v_src ~* 'FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)' THEN
          v_failed := 'acc_s8_functions';
        END IF;
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s8_function_attrs';
  IF v_failed IS NULL THEN
    FOR v_e IN SELECT * FROM (VALUES
      ('private.accounting_post_shipment_events(integer)', 'jsonb', 'v', '_limit', 1, false, true),
      ('private.accounting_shipment_plan(uuid,bigint)', 'jsonb', 's', '_slip_id,_confirm_seq', 0, false, true),
      ('private.accounting_shipment_date_reason(uuid,date)', 'text', 's', '_slip_id,_date', 0, false, true),
      ('private.accounting_shipment_single_order(uuid)', 'uuid', 's', '_slip_id', 0, false, true),
      ('private.get_shipment_journal_trace(uuid)', 'jsonb', 's', '_slip_id', 0, true, false),
      ('private.list_journal_shipment_meta(uuid[])', 'TABLE(entry_id uuid, slip_number text, shipment_date date, confirmed_at timestamp with time zone)', 's', '_entry_ids', 0, true, false),
      ('public.get_shipment_journal_trace(uuid)', 'jsonb', 's', '_slip_id', 0, true, false),
      ('public.list_journal_shipment_meta(uuid[])', 'TABLE(entry_id uuid, slip_number text, shipment_date date, confirmed_at timestamp with time zone)', 's', '_entry_ids', 0, true, false)
    ) AS x(signature, result_type, volatility, arg_names, defaults, service_exec, owner_only_name)
    LOOP
      SELECT f.*, l.lanname INTO v_p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = pg_catalog.to_regprocedure(v_e.signature);
      IF v_p.oid IS NULL
        OR v_p.proowner <> 'postgres'::regrole
        OR v_p.prosecdef <> (pg_catalog.starts_with(v_e.signature, 'private.'))
        OR v_p.provolatile <> v_e.volatility::"char"
        OR v_p.lanname <> (CASE WHEN pg_catalog.starts_with(v_e.signature, 'public.') THEN 'sql' ELSE 'plpgsql' END)
        OR pg_catalog.pg_get_function_result(v_p.oid) <> v_e.result_type
        OR v_p.proisstrict OR v_p.proleakproof OR v_p.prokind <> 'f'
        OR v_p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(v_p.proargnames[1:v_p.pronargs], ','), '') <> v_e.arg_names
        OR v_p.pronargdefaults <> v_e.defaults
        OR pg_catalog.has_function_privilege('anon', v_p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_p.oid, 'EXECUTE') <> v_e.service_exec
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(v_p.proacl, pg_catalog.acldefault('f', v_p.proowner))) AS a
          WHERE a.grantee <> v_p.proowner AND NOT (v_e.service_exec AND a.grantee = 'service_role'::regrole AND a.privilege_type = 'EXECUTE'))
        OR (v_e.owner_only_name AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = v_p.proname)) THEN
        v_failed := 'acc_s8_function_attrs';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s8_reads_stable';
  IF v_failed IS NULL THEN
    FOR v_e IN SELECT * FROM (VALUES
      ('private.get_shipment_journal_trace(uuid)'), ('private.list_journal_shipment_meta(uuid[])'),
      ('public.get_shipment_journal_trace(uuid)'), ('public.list_journal_shipment_meta(uuid[])')) AS x(signature)
    LOOP
      SELECT f.* INTO v_p FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(v_e.signature);
      IF v_p.oid IS NULL OR v_p.provolatile <> 's'
        OR v_p.prosrc ~* '(INSERT INTO|UPDATE |DELETE FROM|TRUNCATE|PERFORM |FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|set_config|nextval)' THEN
        v_failed := 'acc_s8_reads_stable';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s8_g_untouched';
  IF v_failed IS NULL THEN
    SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(x.part, '|' ORDER BY x.part), '')) INTO v_digest FROM (
    SELECT 'tab:' || c.relname || ':' || c.relkind::text || ':' || c.relowner::text || ':' || c.relrowsecurity::text AS part
    FROM pg_catalog.pg_class AS c
    WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname = ANY (ARRAY['shipment_slips', 'shipment_slip_lines',
      'shipment_slip_fulfillments', 'shipment_slip_versions', 'shipment_date_history', 'order_fulfillments', 'order_fulfillment_lines'])
    UNION ALL
    SELECT 'col:' || c.relname || ':' || a.attnum::text || ':' || a.attname || ':' || a.atttypid::text || ':' || a.atttypmod::text
      || ':' || a.attnotnull::text || ':' || COALESCE(pg_catalog.md5(d.adbin::text), '')
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname = ANY (ARRAY['shipment_slips', 'shipment_slip_lines',
      'shipment_slip_fulfillments', 'shipment_slip_versions', 'shipment_date_history', 'order_fulfillments', 'order_fulfillment_lines'])
    UNION ALL
    SELECT 'con:' || c.relname || ':' || o.conname || ':' || o.contype::text || ':' || o.convalidated::text || ':'
      || COALESCE(o.conkey::text, '') || ':' || COALESCE(o.confrelid::text, '') || ':' || COALESCE(o.confkey::text, '') || ':'
      || COALESCE(pg_catalog.md5(o.conbin::text), '')
    FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_constraint AS o ON o.conrelid = c.oid
    WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname = ANY (ARRAY['shipment_slips', 'shipment_slip_lines',
      'shipment_slip_fulfillments', 'shipment_slip_versions', 'shipment_date_history', 'order_fulfillments', 'order_fulfillment_lines'])
    UNION ALL
    SELECT 'trg:' || c.relname || ':' || t.tgname || ':' || t.tgenabled::text || ':' || t.tgtype::text || ':' || t.tgfoid::text
      || ':' || COALESCE(t.tgattr::text, '') || ':' || COALESCE(pg_catalog.md5(t.tgqual::text), '')
    FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_trigger AS t ON t.tgrelid = c.oid
    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname = ANY (ARRAY['shipment_slips',
      'shipment_slip_lines', 'shipment_slip_fulfillments', 'shipment_slip_versions', 'shipment_date_history', 'order_fulfillments',
      'order_fulfillment_lines'])
    UNION ALL
    SELECT 'fn:' || n.nspname || '.' || p.proname || ':' || p.proargtypes::text || ':' || p.prorettype::text || ':'
      || p.prosecdef::text || ':' || p.provolatile::text || ':' || COALESCE(p.proconfig::text, '') || ':' || pg_catalog.md5(p.prosrc)
    FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private') AND p.prokind = 'f' AND p.proname ~ '(shipment|fulfillment|group_g_)'
      AND p.proname !~ '^accounting_'
      AND p.proname NOT IN ('get_shipment_journal_trace', 'list_journal_shipment_meta')
    ) AS x;
    IF v_digest IS DISTINCT FROM (v_baseline ->> 'g_digest') THEN
      v_failed := 'acc_s8_g_untouched';
    END IF;
  END IF;

  v_stage := 'acc_s8_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline ->> 'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline ->> 'lines')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_shipment_units) IS DISTINCT FROM (v_baseline ->> 'shipment_units')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline ->> 'periods')::bigint) THEN
    v_failed := 'acc_s8_existing_dml_allowlist';
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
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s8_functions'), HINT = SQLSTATE;
END;
$acc_s8_final$;
-- ACC_S8_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
