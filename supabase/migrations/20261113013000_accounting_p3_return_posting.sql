BEGIN;
-- Accounting plan 3 S21 (FREQ-578 AC-01..AC-04/AC-06..AC-08/AC-10, FREQ-576-AC-03, FREQ-562-AC-05, FREQ-569-AC-01): the
-- return poster (the arrival entry, the amount decision entry including the 0 yen close, the arrival date correction), the
-- read that traces an arrival entry back to its corrections, and the posting entry point that now calls the return poster.
--
-- New:
--   private.accounting_return_lines(_mode text, _order_id uuid, _goods bigint, _fee bigint)   one builder of the return lines
--     (arrival, decision, waive). The redated entry is built by the same mode as the arrival, from the same fact.
--   private.accounting_post_return_events(_limit integer DEFAULT 50) RETURNS jsonb
--     {posted, parked_new, reparked, resolved, reversed, redated}; no entry point. The amounts come from the return facts
--     only (G, F, payable_delta, covers_amount; never the restocking rate).
--   public.get_return_journal_trace(_receipt_id uuid) RETURNS jsonb   STABLE, service_role only.
-- Rebuilt (CREATE OR REPLACE; the latest definition copied as it is, new text between ACC_P3_BEGIN and ACC_P3_END, the
-- replaced text between ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END; arguments, result,
-- attributes, owner and ACL are unchanged):
--   private.accounting_run_posting (S20, 20261112214341:690-731): the return poster runs after the Stripe poster and before
--     the refund poster; returns is the return poster's posted, and the parked, resolved and has_more sums count it. The S20
--     blocks are kept; the replaced part keeps the md5 of the plan 2 original (S20 replaced the same text).
-- Labels (ACCOUNTING_LABELS, from scripts/accounting/emit-labels.ts):
--   returnArrived: U&'\8FD4\54C1\306E\5230\7740'
--   returnAmountDecided: U&'\8FD4\91D1\306E\984D\306E\6C7A\5B9A'
--   returnArrivalRedated: U&'\5C4A\3044\305F\65E5\306E\76F4\3057'
--   returnFeeRevenue: U&'\8FD4\54C1\306E\624B\6570\6599'
--
-- ROLLBACK (only while no entry of the kinds return_arrived, return_amount_decided or return_arrival_redated exists):
--   re-run CREATE OR REPLACE FUNCTION private.accounting_run_posting from 20261112214341_accounting_p3_refund_posting.sql
--     :690-731;
--   DROP FUNCTION public.get_return_journal_trace(uuid), private.accounting_post_return_events(integer),
--     private.accounting_return_lines(text,uuid,bigint,bigint).

-- ACC_S21_BODY_BEGIN

CREATE TEMP TABLE accounting_s21_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s21_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', pg_catalog.jsonb_build_object(
    'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
    'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
    'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
    'return_facts', (SELECT pg_catalog.count(*) FROM public.accounting_return_facts),
    'corrections', (SELECT pg_catalog.count(*) FROM public.order_return_arrival_corrections)),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(n.nspname, pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))
    FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
    WHERE f.oid IN ('private.accounting_run_posting(integer)'::regprocedure, 'public.accounting_run_posting(integer)'::regprocedure)));

-- 1. The lines of every return entry (one builder, Step 3). Every line carries the order. Modes:
--   arrival   4020 / 2130 return_refund G, and 2130 return_refund / 4050 F (memo returnFeeRevenue)
--   decision  4020 / 2130 return_refund of the payable change (_goods; the other way round when negative)
--   waive     2130 return_refund C (_goods) and 4050 F (memo returnFeeRevenue) / 4020 C + F (the 0 yen close)
CREATE FUNCTION private.accounting_return_lines(_mode text, _order_id uuid, _goods bigint, _fee bigint) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN CASE _mode
    WHEN 'arrival' THEN
      private.accounting_refund_pair('4020', NULL, '2130', 'return_refund', _goods, _order_id)
      || private.accounting_refund_pair('2130', 'return_refund', '4050', NULL, _fee, _order_id, U&'\8FD4\54C1\306E\624B\6570\6599')
    WHEN 'decision' THEN
      private.accounting_refund_pair('4020', NULL, '2130', 'return_refund', _goods, _order_id)
    WHEN 'waive' THEN
      CASE WHEN COALESCE(_goods, 0) <= 0 THEN '[]'::jsonb ELSE
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '2130', 'debit', _goods, 'credit', 0,
          'sub_account', 'return_refund', 'order_id', _order_id::text, 'memo', NULL))
        || CASE WHEN COALESCE(_fee, 0) > 0 THEN pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '4050',
          'debit', _fee, 'credit', 0, 'sub_account', NULL, 'order_id', _order_id::text, 'memo', U&'\8FD4\54C1\306E\624B\6570\6599'))
          ELSE '[]'::jsonb END
        || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '4020', 'debit', 0,
          'credit', _goods + GREATEST(COALESCE(_fee, 0), 0), 'sub_account', NULL, 'order_id', _order_id::text, 'memo', NULL)) END
    ELSE NULL END;
END;
$$;

-- 2. The return poster. Tasks (a fact is never looked at twice: each has an entry or a parked row of its key):
--   arrival   an arrival fact without the entry return_arrived:[receipt]: on the arrival date of the receipt now (the newest
--             correction, else the receipt row), G and F of the fact.
--   decision  a decision fact without the entry return_amount_decided:[fact]. A refund decision books its payable change
--             (0: no_revenue). A 0 yen close (no refund) books the reverse of the arrival for C and F of the fact (C 0:
--             no_revenue). Both wait (refund_prior_unposted, why return_prior) while an arrival of the same return with a
--             smaller seq has no entry. On decided_on.
--   redate    a live (not reversed) arrival entry whose date is not the newest correction's date: the new day is checked
--             first (cutover, period), then the entry is reversed on its own day and booked again with the same lines on
--             the new day (return_arrival_redated:[correction]), in the same block. A parked correction overtaken by a newer
--             one is closed with no entry.
-- New events (no entry and no parked row of their key) are taken arrival, decision, redate, at most _limit in all; then at
-- most 10 open parked rows, oldest last_detected_at first. Each event is one BEGIN ... EXCEPTION block (plan 2).
CREATE FUNCTION private.accounting_post_return_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_job record;
  v_swept record;
  v_fact public.accounting_return_facts%ROWTYPE;
  v_receipt public.order_return_receipts%ROWTYPE;
  v_hist public.order_return_arrival_corrections%ROWTYPE;
  v_entry public.accounting_journal_entries%ROWTYPE;
  v_cutover date;
  v_kind text;
  v_table text;
  v_source text;
  v_order_id uuid;
  v_reason text;
  v_detail jsonb;
  v_date date;
  v_period uuid;
  v_lines jsonb;
  v_result jsonb;
  v_existing uuid;
  v_entry_id uuid;
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
  v_cutover := private.accounting_cutover_on();

  -- A parked correction that a newer correction of the same receipt overtook cannot be posted any more: closed with no entry.
  FOR v_swept IN
    SELECT p.event_kind, p.source_table, p.source_id FROM public.accounting_pending_events AS p
    JOIN public.order_return_arrival_corrections AS h ON h.id::text = p.source_id
    WHERE p.resolved_at IS NULL AND p.event_kind = 'return_arrival_redated' AND p.source_table = 'order_return_arrival_corrections'
      AND EXISTS (SELECT 1 FROM public.order_return_arrival_corrections AS d WHERE d.receipt_id = h.receipt_id AND d.version > h.version)
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
    SELECT j.task, j.lane, j.fact_id, j.correction_id FROM (
      (SELECT n.task, n.lane, n.phase, n.fact_id, n.correction_id, n.sort_a, n.sort_b, n.sort_c FROM (
        (SELECT 'arrival'::text AS task, 0 AS lane, 1 AS phase, f.id AS fact_id, NULL::uuid AS correction_id,
           f.created_at AS sort_a, f.return_id AS sort_b, f.seq AS sort_c
         FROM public.accounting_return_facts AS f
         WHERE f.kind = 'arrival'
           AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
             WHERE e.dedupe_key = private.accounting_event_key('return_arrived', ARRAY[f.receipt_id::text]))
           AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
             WHERE p.event_kind = 'return_arrived' AND p.source_table = 'order_return_receipts' AND p.source_id = f.receipt_id::text)
         ORDER BY f.created_at, f.return_id, f.seq
         LIMIT _limit)
        UNION ALL
        (SELECT 'decision'::text, 0, 2, f.id, NULL::uuid, f.created_at, f.return_id, f.seq
         FROM public.accounting_return_facts AS f
         WHERE f.kind = 'decision'
           AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
             WHERE e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[f.id::text]))
           AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
             WHERE p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts' AND p.source_id = f.id::text)
         ORDER BY f.created_at, f.return_id, f.seq
         LIMIT _limit)
        UNION ALL
        (SELECT 'redate'::text, 0, 3, f.id, h.id, h.created_at, e.id, 0
         FROM public.accounting_journal_entries AS e
         JOIN public.accounting_return_facts AS f ON f.kind = 'arrival' AND f.receipt_id::text = e.source_id
         JOIN LATERAL (SELECT d.id, d.created_at, d.new_on FROM public.order_return_arrival_corrections AS d
           WHERE d.receipt_id = f.receipt_id ORDER BY d.version DESC LIMIT 1) AS h ON true
         WHERE e.source_table = 'order_return_receipts' AND e.event_kind IN ('return_arrived', 'return_arrival_redated')
           AND e.entry_date <> h.new_on
           AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
             WHERE p.event_kind = 'return_arrival_redated' AND p.source_table = 'order_return_arrival_corrections'
               AND p.source_id = h.id::text)
           AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r
             WHERE r.dedupe_key = private.accounting_event_key('return_arrival_redated', ARRAY[h.id::text]))
         ORDER BY h.created_at, e.id
         LIMIT _limit)
      ) AS n ORDER BY n.phase, n.sort_a, n.sort_b, n.sort_c LIMIT _limit)
      UNION ALL
      (SELECT CASE p.event_kind WHEN 'return_arrived' THEN 'arrival' WHEN 'return_amount_decided' THEN 'decision' ELSE 'redate' END,
          1, CASE p.event_kind WHEN 'return_arrived' THEN 1 WHEN 'return_amount_decided' THEN 2 ELSE 3 END,
          CASE p.event_kind
            WHEN 'return_arrived' THEN (SELECT f.id FROM public.accounting_return_facts AS f
              WHERE f.kind = 'arrival' AND f.receipt_id::text = p.source_id)
            WHEN 'return_amount_decided' THEN p.source_id::uuid
            ELSE (SELECT f.id FROM public.accounting_return_facts AS f JOIN public.order_return_arrival_corrections AS h
              ON h.receipt_id = f.receipt_id WHERE f.kind = 'arrival' AND h.id::text = p.source_id) END,
          CASE WHEN p.event_kind = 'return_arrival_redated' THEN p.source_id::uuid END,
          p.last_detected_at, p.id, 0
        FROM public.accounting_pending_events AS p
        WHERE p.resolved_at IS NULL
          AND p.source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND ((p.event_kind = 'return_arrived' AND p.source_table = 'order_return_receipts')
            OR (p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts')
            OR (p.event_kind = 'return_arrival_redated' AND p.source_table = 'order_return_arrival_corrections'))
        ORDER BY p.last_detected_at, p.id
        LIMIT 10)
    ) AS j
    ORDER BY j.lane, j.phase, j.sort_a, j.sort_b, j.sort_c
  LOOP
    v_reason := NULL;
    v_detail := '{}'::jsonb;
    v_date := NULL;
    v_period := NULL;
    v_order_id := NULL;
    v_fact := NULL;
    IF v_job.task = 'arrival' THEN
      v_kind := 'return_arrived';
      v_table := 'order_return_receipts';
    ELSIF v_job.task = 'decision' THEN
      v_kind := 'return_amount_decided';
      v_table := 'accounting_return_facts';
      v_source := v_job.fact_id::text;
    ELSE
      v_kind := 'return_arrival_redated';
      v_table := 'order_return_arrival_corrections';
      v_source := v_job.correction_id::text;
    END IF;
    BEGIN
      SELECT f.* INTO v_fact FROM public.accounting_return_facts AS f WHERE f.id = v_job.fact_id;
      CONTINUE WHEN v_fact.id IS NULL;
      v_order_id := v_fact.order_id;

      IF v_job.task = 'arrival' THEN
        v_source := v_fact.receipt_id::text;
        SELECT e.id INTO v_existing FROM public.accounting_journal_entries AS e
        WHERE e.dedupe_key = private.accounting_event_key('return_arrived', ARRAY[v_fact.receipt_id::text]);
        IF FOUND THEN
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, v_existing);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        SELECT rr.* INTO v_receipt FROM public.order_return_receipts AS rr WHERE rr.id = v_fact.receipt_id;
        -- The arrival date now (the newest correction first): an arrival corrected before it was posted starts on the new day.
        v_date := private.accounting_return_arrival_on(v_fact.receipt_id);
        IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
          v_reason := 'before_cutover';
        ELSE
          v_period := private.accounting_period_for_event(v_date);
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'return_arrived', ARRAY[v_fact.receipt_id::text],
            U&'\8FD4\54C1\306E\5230\7740',
            private.accounting_return_lines('arrival', v_fact.order_id, v_fact.goods_amount, v_fact.fee_amount),
            _source_table => 'order_return_receipts', _source_id => v_fact.receipt_id::text,
            _source_recorded_at => LEAST(v_receipt.created_at, pg_catalog.clock_timestamp()));
          v_entry_id := (v_result ->> 'entry_id')::uuid;
          IF (v_result ->> 'created')::boolean THEN v_posted := v_posted + 1; END IF;
          PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, v_entry_id);
          IF v_job.lane = 1 THEN v_resolved := v_resolved + 1; END IF;
        END IF;

      ELSIF v_job.task = 'decision' THEN
        SELECT e.id INTO v_existing FROM public.accounting_journal_entries AS e
        WHERE e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[v_fact.id::text]);
        IF FOUND THEN
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, v_existing);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        v_date := v_fact.decided_on;
        IF (v_fact.refund_id IS NOT NULL AND v_fact.payable_delta = 0)
          OR (v_fact.refund_id IS NULL AND v_fact.covers_amount = 0) THEN
          -- Nothing to book: the amount is as expected, or the 0 yen close has nothing left to cover (the fee revenue stays).
          v_reason := 'no_revenue';
        ELSIF EXISTS (SELECT 1 FROM public.accounting_return_facts AS a
            WHERE a.return_id = v_fact.return_id AND a.kind = 'arrival' AND a.seq < v_fact.seq
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                WHERE e.dedupe_key = private.accounting_event_key('return_arrived', ARRAY[a.receipt_id::text]))) THEN
          v_reason := 'refund_prior_unposted';
          v_detail := pg_catalog.jsonb_build_object('why', 'return_prior');
        ELSIF v_cutover IS NOT NULL AND v_date < v_cutover THEN
          v_reason := 'before_cutover';
        ELSE
          v_period := private.accounting_period_for_event(v_date);
          v_lines := CASE WHEN v_fact.refund_id IS NULL
            THEN private.accounting_return_lines('waive', v_fact.order_id, v_fact.covers_amount, v_fact.fee_amount)
            ELSE private.accounting_return_lines('decision', v_fact.order_id, v_fact.payable_delta, 0) END;
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'return_amount_decided', ARRAY[v_fact.id::text],
            U&'\8FD4\91D1\306E\984D\306E\6C7A\5B9A', v_lines,
            _source_table => 'accounting_return_facts', _source_id => v_fact.id::text,
            _source_recorded_at => LEAST(v_fact.created_at, pg_catalog.clock_timestamp()));
          v_entry_id := (v_result ->> 'entry_id')::uuid;
          IF (v_result ->> 'created')::boolean THEN v_posted := v_posted + 1; END IF;
          PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, v_entry_id);
          IF v_job.lane = 1 THEN v_resolved := v_resolved + 1; END IF;
        END IF;

      ELSE
        SELECT d.* INTO v_hist FROM public.order_return_arrival_corrections AS d
        WHERE d.receipt_id = v_fact.receipt_id ORDER BY d.version DESC LIMIT 1;
        -- Only the newest correction moves the entry (an overtaken parked one was closed above).
        CONTINUE WHEN v_hist.id IS DISTINCT FROM v_job.correction_id;
        SELECT e.* INTO v_entry FROM public.accounting_journal_entries AS e
        WHERE e.source_table = 'order_return_receipts' AND e.source_id = v_fact.receipt_id::text
          AND e.event_kind IN ('return_arrived', 'return_arrival_redated')
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
        ORDER BY e.entry_no DESC LIMIT 1;
        IF NOT FOUND OR v_entry.entry_date = v_hist.new_on THEN
          -- Nothing left to move: the live entry already has the corrected day (or there is none).
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, NULL);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        -- The new day is checked first: when it cannot be posted the live entry is not reversed.
        v_date := v_hist.new_on;
        IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
          v_reason := 'before_cutover';
        ELSE
          v_period := private.accounting_period_for_event(v_date);
          -- The reason of the reversal is the label; the reason the person wrote stays in the correction row only.
          PERFORM private.accounting_reverse_journal_core(NULL, v_entry.id, U&'\5C4A\3044\305F\65E5\306E\76F4\3057',
            v_entry.entry_date, LEAST(v_hist.created_at, pg_catalog.clock_timestamp()));
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'return_arrival_redated', ARRAY[v_hist.id::text],
            U&'\8FD4\54C1\306E\5230\7740',
            private.accounting_return_lines('arrival', v_fact.order_id, v_fact.goods_amount, v_fact.fee_amount),
            _source_table => 'order_return_receipts', _source_id => v_fact.receipt_id::text,
            _source_recorded_at => LEAST(v_hist.created_at, pg_catalog.clock_timestamp()));
          v_entry_id := (v_result ->> 'entry_id')::uuid;
          v_posted := v_posted + 1;
          v_redated := v_redated + 1;
          PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, v_entry_id);
          IF v_job.lane = 1 THEN v_resolved := v_resolved + 1; END IF;
        END IF;
      END IF;

      IF v_reason = 'no_revenue' THEN
        -- Nothing to book: the row is closed at once and keeps the fact out of the next runs.
        PERFORM private.accounting_park_event(v_kind, v_table, v_source, v_order_id, 'no_revenue', '{}'::jsonb);
        PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, NULL);
        IF v_job.lane = 0 THEN
          v_parked_new := v_parked_new + 1;
        END IF;
        v_resolved := v_resolved + 1;
      ELSIF v_reason IS NOT NULL THEN
        PERFORM private.accounting_park_event(v_kind, v_table, v_source, v_order_id, v_reason, v_detail);
        IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- The rows and the entry numbers of this one event (a correction: both halves) are undone with the block. Only the
      -- SQLSTATE and a fixed code are kept; the text of the exception is never stored.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure(v_kind, v_table, v_source, v_order_id, v_sqlstate, SQLERRM, v_pg_detail, v_date);
      IF v_parked THEN
        IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved, 'reversed', v_reversed, 'redated', v_redated);
END;
$$;

-- 3. The trace of a receive receipt (1-a22): the receipt, its corrections (reason, person, the days before and after) and
--    every entry of the receipt (the arrival entry, its reversals and the redated entries), oldest first. NULL when the
--    receipt is not a receive receipt.
CREATE FUNCTION public.get_return_journal_trace(_receipt_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'receipt', pg_catalog.jsonb_build_object('id', rr.id, 'return_id', rr.return_id, 'arrived_on', rr.arrived_on,
      'created_at', rr.created_at),
    'corrections', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('version', c.version,
        'previous_on', c.previous_on, 'new_on', c.new_on, 'reason', c.reason, 'actor_id', c.actor_id, 'created_at', c.created_at)
        ORDER BY c.version)
      FROM public.order_return_arrival_corrections AS c WHERE c.receipt_id = rr.id), '[]'::jsonb),
    'entries', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('entry_id', e.id, 'entry_no', e.entry_no,
        'event_kind', e.event_kind, 'entry_date', e.entry_date, 'reverses_entry_id', e.reverses_entry_id)
        ORDER BY e.recorded_at, e.entry_date, e.entry_no)
      FROM public.accounting_journal_entries AS e
      WHERE e.source_table = 'order_return_receipts' AND e.source_id = rr.id::text), '[]'::jsonb))
  FROM public.order_return_receipts AS rr
  WHERE rr.id = _receipt_id AND rr.kind = 'receive'
$$;

-- 4. The posting entry point. CREATE OR REPLACE with the latest definition (S20) copied as it is.
CREATE OR REPLACE FUNCTION private.accounting_run_posting(_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_payments jsonb;
  v_shipments jsonb;
  v_stripe jsonb;
  v_disputes jsonb;
-- ACC_P3_BEGIN
  v_refunds jsonb;
-- ACC_P3_END
-- ACC_P3_BEGIN
  v_returns jsonb;
-- ACC_P3_END
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_payments := private.accounting_post_payment_events(_limit);
  v_shipments := private.accounting_post_shipment_events(_limit);
  v_stripe := private.accounting_post_stripe_events(_limit);
-- ACC_P3_BEGIN
  v_returns := private.accounting_post_return_events(_limit);
-- ACC_P3_END
-- ACC_P3_BEGIN
  v_refunds := private.accounting_post_refund_events(_limit);
-- ACC_P3_END
  v_disputes := private.accounting_post_dispute_events(_limit);
-- ACC_P3_REPLACE_BEGIN aa709b104ede79962fa51e4bfeaac07d
  RETURN pg_catalog.jsonb_build_object(
    'payments', (v_payments ->> 'posted')::integer, 'shipments', (v_shipments ->> 'posted')::integer,
    'stripe', (v_stripe ->> 'posted')::integer, 'disputes', (v_disputes ->> 'posted')::integer,
    'refunds', (v_refunds ->> 'posted')::integer, 'returns', (v_returns ->> 'posted')::integer,
    'parked', (v_payments ->> 'parked_new')::integer + (v_payments ->> 'reparked')::integer
      + (v_shipments ->> 'parked_new')::integer + (v_shipments ->> 'reparked')::integer
      + (v_stripe ->> 'parked_new')::integer + (v_stripe ->> 'reparked')::integer
      + (v_returns ->> 'parked_new')::integer + (v_returns ->> 'reparked')::integer
      + (v_refunds ->> 'parked_new')::integer + (v_refunds ->> 'reparked')::integer
      + (v_disputes ->> 'parked_new')::integer + (v_disputes ->> 'reparked')::integer,
    'resolved', (v_payments ->> 'resolved')::integer + (v_shipments ->> 'resolved')::integer
      + (v_stripe ->> 'resolved')::integer + (v_returns ->> 'resolved')::integer + (v_refunds ->> 'resolved')::integer + (v_disputes ->> 'resolved')::integer,
    'has_more', ((v_payments ->> 'posted')::integer + (v_payments ->> 'parked_new')::integer
      + (v_shipments ->> 'posted')::integer + (v_shipments ->> 'parked_new')::integer
      + (v_stripe ->> 'posted')::integer + (v_stripe ->> 'parked_new')::integer
      + (v_returns ->> 'posted')::integer + (v_returns ->> 'parked_new')::integer
      + (v_refunds ->> 'posted')::integer + (v_refunds ->> 'parked_new')::integer
      + (v_disputes ->> 'posted')::integer + (v_disputes ->> 'parked_new')::integer) >= _limit);
-- ACC_P3_REPLACE_END
END;
$$;

ALTER FUNCTION private.accounting_return_lines(text,uuid,bigint,bigint) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_return_events(integer) OWNER TO postgres;
ALTER FUNCTION public.get_return_journal_trace(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_return_lines(text,uuid,bigint,bigint), private.accounting_post_return_events(integer),
  public.get_return_journal_trace(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_return_journal_trace(uuid) TO service_role;

-- ACC_S21_BODY_END

-- ACC_S21_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. The rebuilt entry point is compared after its replaced part is
-- restored from the list below (by the md5 on the marker) and every ACC_P<n> block and all white space are removed.
DO $acc_s21_final$
DECLARE
  v_failed text;
  v_stage text;
  v_search_path text;
  v_baseline jsonb;
  v_src text;
  v_match text[];
  v_original text;
  v_oid oid;
  v_sig text;
  v_role text;
  v_tools CONSTANT text[] := ARRAY[
    'private.accounting_return_lines(text,uuid,bigint,bigint)', 'private.accounting_post_return_events(integer)'];
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s21_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s21_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s21_baseline) <> 1 THEN
    v_failed := 'acc_s21_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s21_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s21_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s21_functions';
  -- acc_s21_functions: the tools are private, SECURITY DEFINER with search_path '', owned by postgres, and nobody runs them;
  -- the trace read is public, SECURITY DEFINER with search_path '', owned by postgres, and only service_role runs it.
  IF v_failed IS NULL THEN
    FOREACH v_sig IN ARRAY v_tools || ARRAY['public.get_return_journal_trace(uuid)'] LOOP
      v_oid := pg_catalog.to_regprocedure(v_sig);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid AND f.prosecdef
          AND f.proowner = 'postgres'::regrole AND f.proconfig = ARRAY['search_path=""']) THEN
        v_failed := 'acc_s21_functions';
        EXIT;
      END IF;
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF pg_catalog.has_function_privilege(v_role, v_oid, 'EXECUTE') <> (v_role = 'service_role' AND NOT (v_sig = ANY (v_tools))) THEN
          v_failed := 'acc_s21_functions';
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee = 0) THEN
        v_failed := 'acc_s21_functions';
      END IF;
      EXIT WHEN v_failed IS NOT NULL;
    END LOOP;
  END IF;

  v_stage := 'acc_s21_function_attrs';
  -- acc_s21_function_attrs: the entry point (private body and public entry) keeps its arguments, result, language,
  -- volatility, security, owner, search_path and ACL.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'attrs')) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'attrs') AS b(nsp, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(b.nsp || '.accounting_run_posting(integer)')
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
        f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))) THEN
    v_failed := 'acc_s21_function_attrs';
  END IF;

  v_stage := 'acc_s21_run_posting';
  -- acc_s21_run_posting: the entry point calls payment, shipment, Stripe, return, refund and dispute in that order, returns
  -- the return poster's posted as returns, sums the return poster into has_more, and with its replaced part restored and
  -- every ACC_P<n> block and all white space removed is the latest plan 2 definition (as S20 checked). The public entry is
  -- one call.
  IF v_failed IS NULL THEN
    SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = 'private.accounting_run_posting(integer)'::regprocedure;
    IF v_src IS NULL
      OR NOT (pg_catalog.strpos(v_src, 'private.accounting_post_payment_events(_limit)') > 0
        AND pg_catalog.strpos(v_src, 'private.accounting_post_payment_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_shipment_events(_limit)')
        AND pg_catalog.strpos(v_src, 'private.accounting_post_shipment_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_stripe_events(_limit)')
        AND pg_catalog.strpos(v_src, 'private.accounting_post_stripe_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_return_events(_limit)')
        AND pg_catalog.strpos(v_src, 'private.accounting_post_return_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_refund_events(_limit)')
        AND pg_catalog.strpos(v_src, 'private.accounting_post_refund_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_dispute_events(_limit)'))
      OR pg_catalog.strpos(v_src, '''refunds'', (v_refunds ->> ''posted'')::integer, ''returns'', (v_returns ->> ''posted'')::integer,') = 0
      OR pg_catalog.strpos(v_src, '+ (v_returns ->> ''parked_new'')::integer + (v_returns ->> ''reparked'')::integer') = 0
      OR pg_catalog.strpos(v_src, '+ (v_returns ->> ''resolved'')::integer') = 0
      OR pg_catalog.strpos(pg_catalog.substr(v_src, pg_catalog.strpos(v_src, '''has_more''')),
        '+ (v_returns ->> ''posted'')::integer + (v_returns ->> ''parked_new'')::integer') = 0
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_REPLACE_BEGIN', 'g')) <> 1
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_BEGIN', 'g')) <> 4 THEN
      v_failed := 'acc_s21_run_posting';
    ELSE
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('aa709b104ede79962fa51e4bfeaac07d', $acc_s21_orig$  RETURN pg_catalog.jsonb_build_object(
    'payments', (v_payments ->> 'posted')::integer, 'shipments', (v_shipments ->> 'posted')::integer,
    'stripe', (v_stripe ->> 'posted')::integer, 'disputes', (v_disputes ->> 'posted')::integer,
    'parked', (v_payments ->> 'parked_new')::integer + (v_payments ->> 'reparked')::integer
      + (v_shipments ->> 'parked_new')::integer + (v_shipments ->> 'reparked')::integer
      + (v_stripe ->> 'parked_new')::integer + (v_stripe ->> 'reparked')::integer
      + (v_disputes ->> 'parked_new')::integer + (v_disputes ->> 'reparked')::integer,
    'resolved', (v_payments ->> 'resolved')::integer + (v_shipments ->> 'resolved')::integer
      + (v_stripe ->> 'resolved')::integer + (v_disputes ->> 'resolved')::integer,
    'has_more', ((v_payments ->> 'posted')::integer + (v_payments ->> 'parked_new')::integer
      + (v_shipments ->> 'posted')::integer + (v_shipments ->> 'parked_new')::integer
      + (v_stripe ->> 'posted')::integer + (v_stripe ->> 'parked_new')::integer
      + (v_disputes ->> 'posted')::integer + (v_disputes ->> 'parked_new')::integer) >= _limit);
$acc_s21_orig$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s21_run_posting';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
        v_original := NULL;
      END LOOP;
      IF v_failed IS NULL AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM 'ed92db40a73e640f5886bd94abc322a5' THEN
        v_failed := 'acc_s21_run_posting';
      END IF;
      IF v_failed IS NULL AND pg_catalog.btrim((SELECT f.prosrc FROM pg_catalog.pg_proc AS f
          WHERE f.oid = 'public.accounting_run_posting(integer)'::regprocedure)) IS DISTINCT FROM 'SELECT private.accounting_run_posting(_limit)' THEN
        v_failed := 'acc_s21_run_posting';
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s21_reads_stable';
  -- acc_s21_reads_stable: the trace read is STABLE, writes nothing, takes no row lock and names no personal column.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = 'public.get_return_journal_trace(uuid)'::regprocedure
        AND (f.provolatile <> 's'
          OR f.prosrc ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M'
          OR f.prosrc ~* '(raw_payload|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address)')) THEN
    v_failed := 'acc_s21_reads_stable';
  END IF;

  v_stage := 'acc_s21_existing_dml_allowlist';
  -- acc_s21_existing_dml_allowlist: this migration writes no row, and the group G writer list is what it was.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline #>> '{counts,entries}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline #>> '{counts,lines}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline #>> '{counts,pending_events}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_return_facts) IS DISTINCT FROM (v_baseline #>> '{counts,return_facts}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.order_return_arrival_corrections) IS DISTINCT FROM (v_baseline #>> '{counts,corrections}')::bigint
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc))
      IS DISTINCT FROM (v_baseline -> 'allowlist')) THEN
    v_failed := 'acc_s21_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s21_functions'), HINT = SQLSTATE;
END;
$acc_s21_final$;
-- ACC_S21_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
