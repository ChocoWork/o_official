BEGIN;
-- Accounting plan 3 S27 (spec 2026-11-15-accounting-pending-manual-entry-design; FREQ-643): the two posters book the two parked
-- kinds of order_not_postable (dispute_lost, return_closed_after_lost) on their own. This file is built task by task; the
-- first part (Task 1) holds the precheck, two private helpers and the rebuilt wait of the refund poster.
--
-- New (private; LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''; owner postgres; no grant to anyone):
--   private.accounting_order_refunds_in_flight(_order_id uuid, _decision_fact_id uuid)
--     RETURNS TABLE(refund_id uuid, excluded boolean, post_shipment_amount integer)
--     The refunds of the order that are in one of the five shapes of spec 3-3 (not cut at any day), and which of them leave
--     the count for the return poster (the three conditions of spec 3-3; excluded is false when _decision_fact_id is NULL).
--   private.accounting_order_return_payable(_order_id uuid, _through date) RETURNS bigint
--     The credit minus the debit of 2130 return_refund of the order up to _through (all of it when _through is NULL; a
--     negative value is returned as it is). A refund success is counted on the day the refund was made, not the entry day.
-- Rebuilt (CREATE OR REPLACE; the latest definition copied as it is, the replaced text between ACC_P3_REPLACE_BEGIN <md5 of
-- the original> and ACC_P3_REPLACE_END; arguments, result, attributes, owner and ACL are unchanged):
--   private.accounting_refund_wait (only definition: S20 20261112214341:199-240): a decision whose pending row is
--     no_revenue and closed with no entry (nothing to book) counts as done for the return_prior wait of a refund success.
--   private.accounting_post_return_events (latest definition: S22 20261113090000:808-1095, copied as it is): only the inside of
--     the dispute_lost branch (between ACC_P3_BEGIN and ACC_P3_END) is rebuilt. A 0 yen close after the loss day of a card
--     dispute whose C is booked waits (earlier day first, refunds in flight, other returns not decided) or books only w =
--     min(c, max(P_eff, 0)) with P_eff = min(P(D), P(now) - left-out refunds), or closes as no_revenue when P_eff <= 0.
--     After the entry, 2130 of the order is read again (up to the day and now); below 0 raises
--     ACCOUNTING_POSTING_BALANCE_NEGATIVE (23514).
--   private.accounting_post_dispute_events (latest definition: S22 20261113090000:246-714, copied as it is): three ACC_P3 blocks
--     (new variables; the stop of return_closed_after_lost becomes the waits of spec 3-3: refunds in flight, then the thing with the
--     earlier day; the fix entries after C). C is booked as it is, then for each later 0 yen close day d_n a fix entry (debit 4020,
--     credit 2130 return_refund, y_n = max(-B(d_n), 0), key dispute_event:closefix:<dp>:<n>) is booked in the same event.
--
-- ROLLBACK (no row is written by this migration): DROP FUNCTION private.accounting_order_refunds_in_flight(uuid,uuid),
--   private.accounting_order_return_payable(uuid,date); re-run CREATE OR REPLACE of private.accounting_refund_wait from
--   20261112214341_accounting_p3_refund_posting.sql :199-240.

-- ACC_S27_PRECHECK_BEGIN
-- A pending row of order_not_postable (dispute_lost or return_closed_after_lost) that a person already closed through the link
-- of S24 has no entry of its own that this migration could know; the refund after that decision would wait for ever. Stop and
-- let a person put that order right first. Open rows are fine: the posters handle them after this migration.
DO $acc_s27_precheck$
DECLARE
  v_closed integer;
  v_open integer;
BEGIN
  SELECT pg_catalog.count(*) INTO v_closed FROM public.accounting_pending_events AS p
  WHERE p.reason = 'order_not_postable' AND p.detail ->> 'reason' IN ('dispute_lost', 'return_closed_after_lost')
    AND p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NOT NULL AND p.resolved_by IS NOT NULL;
  IF v_closed <> 0 THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'acc_s27_precheck';
  END IF;
  SELECT pg_catalog.count(*) INTO v_open FROM public.accounting_pending_events AS p
  WHERE p.reason = 'order_not_postable' AND p.detail ->> 'reason' IN ('dispute_lost', 'return_closed_after_lost')
    AND p.resolved_at IS NULL;
  RAISE NOTICE 'acc_s27_precheck: open order_not_postable rows (dispute_lost, return_closed_after_lost) = %', v_open;
END;
$acc_s27_precheck$;
-- ACC_S27_PRECHECK_END

-- ACC_S27_BODY_BEGIN

CREATE TEMP TABLE accounting_s27_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s27_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', pg_catalog.jsonb_build_object(
    'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
    'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
    'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events)),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(s.sig, (SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a)))
      FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(s.sig)))
    FROM pg_catalog.unnest(ARRAY['private.accounting_refund_wait(uuid,text)', 'private.accounting_post_return_events(integer)',
      'private.accounting_post_dispute_events(integer)']) AS s(sig)));

-- 1. The 2130 return_refund balance of an order up to a day (the R of spec 2-2). No row lock; the poster holds the locks.
CREATE FUNCTION private.accounting_order_return_payable(_order_id uuid, _through date) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_r bigint;
BEGIN
  IF _order_id IS NULL THEN
    RETURN 0;
  END IF;
  SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0)::bigint INTO v_r
  FROM public.accounting_journal_lines AS l
  JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
  LEFT JOIN public.accounting_journal_entries AS o ON o.id = e.reverses_entry_id
  LEFT JOIN public.order_refunds AS f ON e.reverses_entry_id IS NULL AND e.event_kind = 'return_refund'
    AND e.source_table = 'order_refunds' AND f.id::text = e.source_id
  WHERE l.order_id = _order_id AND l.account_code = '2130' AND l.sub_account = 'return_refund'
    AND (_through IS NULL OR CASE WHEN f.id IS NULL THEN e.entry_date ELSE private.accounting_jst_date(f.created_at) END <= _through);
  RETURN v_r;
END;
$$;
REVOKE ALL ON FUNCTION private.accounting_order_return_payable(uuid, date) FROM PUBLIC, anon, authenticated, service_role;

-- 2. The refunds of an order that are in the way of a lost dispute (the five shapes of spec 3-3; no day cut) and which of them
-- the return poster leaves out of the count (spec 3-3, three conditions that all hold). No row lock.
CREATE FUNCTION private.accounting_order_refunds_in_flight(_order_id uuid, _decision_fact_id uuid)
RETURNS TABLE(refund_id uuid, excluded boolean, post_shipment_amount integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_x public.accounting_return_facts%ROWTYPE;
BEGIN
  IF _order_id IS NULL THEN
    RETURN;
  END IF;
  IF _decision_fact_id IS NOT NULL THEN
    SELECT x.* INTO v_x FROM public.accounting_return_facts AS x WHERE x.id = _decision_fact_id AND x.kind = 'decision';
  END IF;
  RETURN QUERY
  SELECT t.rid, COALESCE(v_x.id IS NOT NULL AND t.early
      AND private.accounting_refund_wait(t.rid, 'success') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.accounting_return_facts AS a
        WHERE a.return_id = t.ret_id
          AND ((a.kind = 'arrival' AND (t.dseq IS NULL OR a.seq < t.dseq)
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                WHERE e.dedupe_key = private.accounting_event_key('return_arrived', ARRAY[a.receipt_id::text])))
            OR (a.kind = 'decision' AND a.payable_delta <> 0 AND (t.dseq IS NULL OR a.seq <= t.dseq)
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                WHERE e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[a.id::text]))
              AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
                WHERE p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts'
                  AND p.source_id = a.id::text AND p.reason = 'no_revenue' AND p.resolved_at IS NOT NULL
                  AND p.resolved_entry_id IS NULL)
              AND (a.decided_on, a.created_at, a.return_id, a.seq) < (v_x.decided_on, v_x.created_at, v_x.return_id, v_x.seq))))
    , false), t.psa
  FROM (
    SELECT r.id AS rid, f.post_shipment_amount AS psa, f.return_id AS ret_id,
      (SELECT d.seq FROM public.accounting_return_facts AS d WHERE d.refund_id = r.id AND d.kind = 'decision') AS dseq,
      ((SELECT x.state FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id ORDER BY x.seq DESC LIMIT 1)
          IN ('requested', 'accepted', 'error')
        OR (EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state = 'succeeded')
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.event_kind IN ('pre_shipment_refund', 'return_refund') AND e.source_table = 'order_refunds'
              AND e.source_id = r.id::text)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind IN ('pre_shipment_refund', 'return_refund') AND p.source_table = 'order_refunds'
              AND p.source_id = r.id::text AND (p.resolved_at IS NOT NULL OR p.reason = 'before_cutover')))) AS early,
      ((EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state IN ('failed', 'owed'))
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.event_kind = 'refund_failed' AND e.source_table = 'order_refunds' AND e.source_id = r.id::text)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'refund_failed' AND p.source_table = 'order_refunds' AND p.source_id = r.id::text
              AND (p.resolved_at IS NOT NULL OR p.reason = 'before_cutover')))
        OR (EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state = 'canceled')
          AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
            WHERE x.refund_id = r.id AND x.state IN ('abandoned', 'owed')))
        OR (EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state = 'abandoned')
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.event_kind = 'refund_abandoned' AND e.source_table = 'order_refunds' AND e.source_id = r.id::text)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'refund_abandoned' AND p.source_table = 'order_refunds' AND p.source_id = r.id::text
              AND (p.resolved_at IS NOT NULL OR p.reason = 'before_cutover')))) AS late
    FROM public.order_refunds AS r
    JOIN public.accounting_refund_facts AS f ON f.refund_id = r.id
    WHERE r.order_id = _order_id
  ) AS t
  WHERE t.early OR t.late
  ORDER BY t.rid;
END;
$$;
REVOKE ALL ON FUNCTION private.accounting_order_refunds_in_flight(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 3. The wait of the refund poster: a decision that was closed as no_revenue with no entry is done (spec 3-6).
CREATE OR REPLACE FUNCTION private.accounting_refund_wait(_refund_id uuid, _step text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_fact public.accounting_refund_facts%ROWTYPE;
  v_seq integer;
BEGIN
  SELECT f.* INTO v_fact FROM public.accounting_refund_facts AS f WHERE f.refund_id = _refund_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF _step = 'success' THEN
    IF v_fact.source <> 'return' OR v_fact.event_kind IN ('holdback_release', 'pre_shipment_cancel') OR v_fact.return_id IS NULL THEN
      RETURN NULL;
    END IF;
    SELECT a.seq INTO v_seq FROM public.accounting_return_facts AS a WHERE a.refund_id = _refund_id AND a.kind = 'decision';
    IF EXISTS (SELECT 1 FROM public.accounting_return_facts AS a
        WHERE a.return_id = v_fact.return_id
          AND ((a.kind = 'arrival' AND (v_seq IS NULL OR a.seq < v_seq)
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                WHERE e.dedupe_key = private.accounting_event_key('return_arrived', ARRAY[a.receipt_id::text])))
            OR (a.kind = 'decision' AND a.payable_delta <> 0 AND (v_seq IS NULL OR a.seq <= v_seq)
-- ACC_P3_REPLACE_BEGIN 34d9183df09973c30c4b44a410b9d25b
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                WHERE e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[a.id::text]))
              AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
                WHERE p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts'
                  AND p.source_id = a.id::text AND p.reason = 'no_revenue' AND p.resolved_at IS NOT NULL
                  AND p.resolved_entry_id IS NULL)))) THEN
-- ACC_P3_REPLACE_END
      RETURN 'return_prior';
    END IF;
    RETURN NULL;
  END IF;
  -- A failure also goes ahead of a success that waits only for the deferred revenue: a retry that paid first took it, and
  -- the settle that gives it back needs this failure entry (the success comes in after the settle).
  IF NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
      WHERE e.event_kind IN ('pre_shipment_refund', 'return_refund') AND e.source_table = 'order_refunds'
        AND e.source_id = _refund_id::text)
    AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
      WHERE p.event_kind IN ('pre_shipment_refund', 'return_refund') AND p.source_table = 'order_refunds'
        AND p.source_id = _refund_id::text
        AND (p.resolved_at IS NOT NULL OR (_step = 'failure' AND p.reason = 'deferred_revenue_short'))) THEN
    RETURN 'original';
  END IF;
  RETURN NULL;
END;
$$;

-- 4. The return poster (S22 20261113090000:808-1095 copied as it is; only the inside of the dispute_lost branch between
-- ACC_P3_BEGIN and ACC_P3_END is rebuilt: the waits of spec 3-3, then the 0 yen close for w only or no_revenue, spec 3-2, 4-1, 4-3).
CREATE OR REPLACE FUNCTION private.accounting_post_return_events(_limit integer DEFAULT 50) RETURNS jsonb
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
-- ACC_P3_BEGIN
        ELSIF v_fact.refund_id IS NULL AND EXISTS (SELECT 1 FROM public.stripe_disputes AS d
            WHERE private.accounting_dispute_order(d.id) = v_fact.order_id
              AND private.accounting_jst_date(private.accounting_dispute_lost_at(d.id)) <= v_date
              AND EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                WHERE e.dedupe_key = private.accounting_dispute_key(d.id, 'confirmed', 'lost'))) THEN
          -- A 0 yen close (no refund) on or after the loss day of a card dispute of the order whose C is already booked (spec
          -- 3-2, 3-3). C already took the payable of the order, so the close is cut down to what is left (w) or not booked at all.
          DECLARE
            v_p_day bigint;
            v_p_now bigint;
            v_cut bigint;
            v_eff bigint;
            v_w bigint;
            v_check_day bigint;
            v_check_now bigint;
          BEGIN
            IF EXISTS (SELECT 1 FROM public.accounting_return_facts AS a
                WHERE a.order_id = v_fact.order_id AND a.kind = 'decision' AND a.id <> v_fact.id
                  AND (a.decided_on, a.created_at, a.return_id, a.seq) < (v_fact.decided_on, v_fact.created_at, v_fact.return_id, v_fact.seq)
                  AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                    WHERE e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[a.id::text]))
                  AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
                    WHERE p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts'
                      AND p.source_id = a.id::text AND (p.resolved_at IS NOT NULL OR p.reason = 'before_cutover')))
              OR EXISTS (SELECT 1 FROM public.stripe_disputes AS d2
                WHERE private.accounting_dispute_order(d2.id) = v_fact.order_id
                  AND private.accounting_dispute_lost_at(d2.id) IS NOT NULL
                  AND (v_cutover IS NULL OR private.accounting_jst_date(private.accounting_dispute_lost_at(d2.id)) >= v_cutover)
                  AND NOT private.accounting_dispute_confirmed_done(d2.id)
                  AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
                    WHERE p.event_kind = 'dispute_event' AND p.source_table = 'stripe_disputes' AND p.source_id = d2.id
                      AND p.resolved_at IS NOT NULL)
                  AND (SELECT pg_catalog.max(e.entry_date) FROM public.accounting_journal_entries AS e
                    JOIN public.accounting_return_facts AS f ON f.id::text = e.source_id
                    WHERE e.event_kind = 'return_amount_decided' AND e.source_table = 'accounting_return_facts'
                      AND f.order_id = v_fact.order_id AND f.refund_id IS NULL
                      AND e.entry_date > private.accounting_jst_date(private.accounting_dispute_lost_at(d2.id))
                      AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)) < v_date) THEN
              -- The thing with the earlier day goes first (spec 3-5): a decision of the order that is not booked yet, or a C
              -- that is not booked yet and will be dated before this close.
              v_reason := 'dispute_return_refund_pending';
              v_detail := pg_catalog.jsonb_build_object('why', 'return');
            ELSIF EXISTS (SELECT 1 FROM private.accounting_order_refunds_in_flight(v_fact.order_id, v_fact.id) AS r WHERE NOT r.excluded) THEN
              v_reason := 'dispute_refund_overlap';
              v_detail := pg_catalog.jsonb_build_object('why', 'refund');
            ELSIF EXISTS (SELECT 1 FROM (SELECT DISTINCT o.return_id FROM public.accounting_return_facts AS o
                  WHERE o.order_id = v_fact.order_id AND o.return_id <> v_fact.return_id) AS k
                WHERE COALESCE((SELECT pg_catalog.sum(f.goods_amount - f.fee_amount) FROM public.accounting_return_facts AS f
                    WHERE f.return_id = k.return_id AND f.kind = 'arrival'), 0)
                  + COALESCE((SELECT pg_catalog.sum(f.payable_delta) FROM public.accounting_return_facts AS f
                    WHERE f.return_id = k.return_id AND f.kind = 'decision'), 0)
                  - COALESCE((SELECT pg_catalog.sum(f.decided_amount) FROM public.accounting_return_facts AS f
                    JOIN public.order_refunds AS rf ON rf.id = f.refund_id
                    WHERE f.return_id = k.return_id AND f.kind = 'decision'
                      AND NOT (rf.status = 'failed' OR (rf.status = 'canceled' AND EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
                        WHERE x.refund_id = rf.id AND x.state = 'abandoned')))), 0) > 0) THEN
              -- Another return of the order has an amount that is not decided yet: how much of the payable C took is its, not
              -- this close's, cannot be told from the sum of 2130.
              v_reason := 'dispute_return_refund_pending';
              v_detail := pg_catalog.jsonb_build_object('why', 'return');
            ELSE
              v_p_day := private.accounting_order_return_payable(v_fact.order_id, v_date);
              v_p_now := private.accounting_order_return_payable(v_fact.order_id, NULL);
              SELECT COALESCE(pg_catalog.sum(r.post_shipment_amount), 0)::bigint INTO v_cut
              FROM private.accounting_order_refunds_in_flight(v_fact.order_id, v_fact.id) AS r WHERE r.excluded;
              v_eff := LEAST(v_p_day, v_p_now - v_cut);
              IF v_eff <= 0 THEN
                -- Nothing is left to take back: nothing is booked and the row closes as no_revenue (the refund wait counts it).
                v_reason := 'no_revenue';
              ELSE
                v_w := LEAST(v_fact.covers_amount, v_eff);
                v_period := private.accounting_period_for_event(v_date);
                v_lines := private.accounting_return_lines('waive', v_fact.order_id, v_w, v_fact.fee_amount);
                v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'return_amount_decided', ARRAY[v_fact.id::text],
                  U&'\8FD4\91D1\306E\984D\306E\6C7A\5B9A', v_lines,
                  _source_table => 'accounting_return_facts', _source_id => v_fact.id::text,
                  _source_recorded_at => LEAST(v_fact.created_at, pg_catalog.clock_timestamp()));
                v_entry_id := (v_result ->> 'entry_id')::uuid;
                IF (v_result ->> 'created')::boolean THEN v_posted := v_posted + 1; END IF;
                -- 1470 dispute_refund_overlap_review is not read: this entry never touches 1470.
                -- Read after the entry, in statements of their own (a STABLE function reads the start of its statement).
                v_check_day := private.accounting_order_return_payable(v_fact.order_id, v_date);
                v_check_now := private.accounting_order_return_payable(v_fact.order_id, NULL);
                IF v_check_day < 0 OR v_check_now < 0 THEN
                  RAISE EXCEPTION 'ACCOUNTING_POSTING_BALANCE_NEGATIVE' USING ERRCODE = '23514';
                END IF;
                PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, v_entry_id);
                IF v_job.lane = 1 THEN v_resolved := v_resolved + 1; END IF;
              END IF;
            END IF;
          END;
-- ACC_P3_END
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
          v_reversed := v_reversed + 1;
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

-- 5. The dispute poster (S22 20261113090000:246-714 copied as it is; only the three ACC_P3 blocks are rebuilt or added: the new variables,
-- the waits of spec 3-3 in place of the stop of return_closed_after_lost, and the fix entries after C, spec 3-2, 3-5, 4-2).
CREATE OR REPLACE FUNCTION private.accounting_post_dispute_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_label_withdrawn CONSTANT text := U&'\30AB\30FC\30C9\4F1A\793E\304B\3089\306E\652F\6255\3044\306E\53D6\308A\6D88\3057';
  c_label_confirmed CONSTANT text := U&'\30AB\30FC\30C9\4F1A\793E\304B\3089\306E\652F\6255\3044\306E\53D6\308A\6D88\3057\306E\78BA\5B9A';
  c_label_reversal CONSTANT text := U&'\30AB\30FC\30C9\4F1A\793E\304B\3089\306E\652F\6255\3044\306E\53D6\308A\6D88\3057\306E\53D6\308A\4E0B\3052';
  v_job record;
  v_bt public.stripe_balance_transactions%ROWTYPE;
  v_dispute public.stripe_disputes%ROWTYPE;
  v_cutover date;
  v_table text;
  v_source_id text;
  v_dispute_id text;
  v_key text;
  v_existing uuid;
  v_date date;
  v_period uuid;
  v_order_id uuid;
  v_reason text;
  v_detail jsonb;
  v_lost timestamptz;
  v_seq bigint;
  v_units integer;
  v_shipped bigint;
  v_deferred bigint;
  v_balance bigint;
  v_amount bigint;
  v_kind text;
  v_cause text;
  v_account text;
  v_debit_account text;
  v_debit_sub text;
  v_label text;
  v_lines jsonb;
  v_result jsonb;
  v_entry_id uuid;
  v_recorded timestamptz;
  v_sqlstate text;
  v_pg_detail text;
  v_parked boolean;
  v_posted integer := 0;
  v_parked_new integer := 0;
  v_reparked integer := 0;
  v_resolved integer := 0;
  v_withdrawn integer := 0;
  v_confirmed_count integer := 0;
  v_reversals integer := 0;
  v_late integer := 0;
-- ACC_P3_BEGIN
  v_ready boolean;
  v_why text;
  v_pay bigint;
  v_review bigint;
  v_rest bigint;
  v_cost_part bigint;
  v_review_part bigint;
  v_payable_part bigint;
  v_waiting boolean;
  v_close_last date;
  v_fix_result jsonb;
  v_fix_entry_id uuid;
  v_fix_n integer;
  v_fix_y bigint;
  v_fix_date date;
  v_fix_check_day bigint;
  v_fix_check_now bigint;
  v_fix_review bigint;
  v_fix_sum bigint;
  v_fix_last date;
  v_fix_now bigint;
-- ACC_P3_END
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_cutover := private.accounting_cutover_on();

  FOR v_job IN
    SELECT j.task, j.lane, j.phase, j.txn_id, j.dispute_id FROM (
      (SELECT n.task, n.lane, n.phase, n.txn_id, n.dispute_id, n.sort_at FROM (
        SELECT 'withdraw'::text AS task, 0 AS lane, 1 AS phase, t.id AS txn_id, t.source_id AS dispute_id, t.stripe_created_at AS sort_at
        FROM public.stripe_balance_transactions AS t
        WHERE t.reporting_category = 'dispute' AND t.amount < 0
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = private.accounting_dispute_key(t.source_id, 'withdrawn', t.id))
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'dispute_event' AND p.source_table = 'stripe_balance_transactions' AND p.source_id = t.id)
        UNION ALL
        SELECT 'reversal'::text, 0,
          CASE WHEN private.accounting_dispute_reversal_kind(t.source_id, t.stripe_created_at) = 'L' THEN 4 ELSE 2 END,
          t.id, t.source_id, t.stripe_created_at
        FROM public.stripe_balance_transactions AS t
        WHERE t.reporting_category = 'dispute_reversal' AND t.amount > 0
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = private.accounting_dispute_key(t.source_id, 'reversal', t.id))
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'dispute_event' AND p.source_table = 'stripe_balance_transactions' AND p.source_id = t.id)
        UNION ALL
        SELECT 'confirm'::text, 0, 3, NULL::text, d.id, d.stripe_created_at
        FROM public.stripe_disputes AS d
        WHERE EXISTS (SELECT 1 FROM public.stripe_dispute_events AS h WHERE h.dispute_id = d.id AND h.status = 'lost')
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = private.accounting_dispute_key(d.id, 'confirmed', 'lost'))
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'dispute_event' AND p.source_table = 'stripe_disputes' AND p.source_id = d.id)
      ) AS n ORDER BY n.phase, n.sort_at, n.dispute_id, n.txn_id LIMIT _limit)
      UNION ALL
      (SELECT r.task, 1, r.phase, r.txn_id, r.dispute_id, r.sort_at FROM (
        SELECT CASE WHEN t.reporting_category = 'dispute' THEN 'withdraw' ELSE 'reversal' END AS task,
          CASE WHEN t.reporting_category = 'dispute' THEN 1
            WHEN private.accounting_dispute_reversal_kind(t.source_id, t.stripe_created_at) = 'L' THEN 4 ELSE 2 END AS phase,
          t.id AS txn_id, t.source_id AS dispute_id, t.stripe_created_at AS sort_at, p.last_detected_at, p.id
        FROM public.accounting_pending_events AS p
        JOIN public.stripe_balance_transactions AS t ON p.source_table = 'stripe_balance_transactions' AND p.source_id = t.id
        WHERE p.event_kind = 'dispute_event' AND p.resolved_at IS NULL
          AND t.reporting_category IN ('dispute', 'dispute_reversal')
        UNION ALL
        SELECT 'confirm', 3, NULL::text, d.id, d.stripe_created_at, p.last_detected_at, p.id
        FROM public.accounting_pending_events AS p
        JOIN public.stripe_disputes AS d ON p.source_table = 'stripe_disputes' AND p.source_id = d.id
        WHERE p.event_kind = 'dispute_event' AND p.resolved_at IS NULL
      ) AS r ORDER BY r.last_detected_at, r.id LIMIT 10)
    ) AS j
    ORDER BY j.phase, j.lane, j.sort_at, j.dispute_id, j.txn_id
  LOOP
    v_reason := NULL;
    v_detail := '{}'::jsonb;
    v_date := NULL;
    v_period := NULL;
    v_order_id := NULL;
    v_kind := NULL;
    v_account := NULL;
    v_dispute_id := v_job.dispute_id;
    v_table := CASE WHEN v_job.task = 'confirm' THEN 'stripe_disputes' ELSE 'stripe_balance_transactions' END;
    v_source_id := CASE WHEN v_job.task = 'confirm' THEN v_job.dispute_id ELSE v_job.txn_id END;
    BEGIN
      IF v_job.task = 'withdraw' THEN
        -- W: the amount leaves Stripe's balance.
        SELECT t.* INTO v_bt FROM public.stripe_balance_transactions AS t WHERE t.id = v_job.txn_id;
        IF NOT FOUND THEN
          CONTINUE;
        END IF;
        v_date := private.accounting_jst_date(v_bt.stripe_created_at);
        SELECT e.id INTO v_existing FROM public.accounting_journal_entries AS e
        WHERE e.dedupe_key = private.accounting_dispute_key(v_dispute_id, 'withdrawn', v_bt.id);
        IF FOUND THEN
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event('dispute_event', v_table, v_source_id, v_existing);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        SELECT d.* INTO v_dispute FROM public.stripe_disputes AS d WHERE d.id = v_dispute_id;
        IF NOT FOUND THEN
          v_reason := 'no_order';
        ELSE
          v_order_id := private.accounting_dispute_order(v_dispute_id);
          IF v_order_id IS NULL THEN
            v_reason := 'no_order';
          END IF;
        END IF;
        IF v_reason IS NULL AND v_cutover IS NOT NULL AND v_date < v_cutover THEN
          v_reason := 'before_cutover';
        END IF;
        IF v_reason IS NULL THEN
          v_period := private.accounting_period_for_event(v_date);
-- ACC_P3_REPLACE_BEGIN 78e0d53f69cd6a67741d23e9a151e38d
-- ACC_P3_REPLACE_END
        END IF;
        IF v_reason IS NULL THEN
          -- N: every group G lock taken up to the withdrawal time is finished (the poster holds the lock now), so N does not
          -- change. A slip confirmed at or before N whose shipment entry is not in the books yet is waited for, so whether a
          -- unit is shipped never depends on the order the posters run in.
          v_seq := private.accounting_g_fact_seq_at(v_bt.stripe_created_at);
          IF EXISTS (SELECT 1 FROM public.shipment_slips AS s
            JOIN public.accounting_g_slip_facts AS f ON f.slip_id = s.id AND f.kind = 'confirm'
            WHERE s.stage = 'confirmed' AND f.fact_seq <= v_seq
              AND EXISTS (SELECT 1 FROM public.shipment_slip_lines AS sl JOIN public.order_items AS oi ON oi.id = sl.order_item_id
                WHERE sl.slip_id = s.id AND oi.order_id = v_order_id)
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                WHERE e.dedupe_key = private.accounting_event_key('shipment_confirmed', ARRAY[s.number]))
              AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
                WHERE p.event_kind = 'shipment_confirmed' AND p.source_table = 'shipment_slips' AND p.source_id = s.id::text
                  AND ((p.reason = 'no_revenue' AND p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NULL)
                    OR p.reason = 'before_cutover'))) THEN
            v_reason := 'dispute_shipment_pending';
          END IF;
        END IF;
        IF v_reason IS NULL THEN
          SELECT s.units, s.shipped, s.deferred INTO v_units, v_shipped, v_deferred
          FROM private.accounting_dispute_split_withdrawn(v_order_id, -v_bt.amount::bigint, v_seq) AS s;
          IF v_units = 0 THEN
            v_reason := 'order_not_postable';
            v_detail := pg_catalog.jsonb_build_object('reason', 'units_missing');
          ELSE
            v_balance := (SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0) FROM public.accounting_journal_lines AS l
              WHERE l.order_id = v_order_id AND l.account_code = '2150');
            IF v_deferred > v_balance THEN
              v_reason := 'deferred_revenue_short';
              v_detail := pg_catalog.jsonb_build_object('shortage', v_deferred - v_balance);
            END IF;
          END IF;
        END IF;
        IF v_reason IS NOT NULL THEN
          PERFORM private.accounting_park_event('dispute_event', v_table, v_source_id, v_order_id, v_reason, v_detail);
          IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
        ELSE
          v_cause := private.accounting_dispute_cause(v_dispute.reason);
          v_lines := pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('account_code', '1160', 'debit', 0, 'credit', -v_bt.amount::bigint));
          IF v_deferred > 0 THEN
            v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '2150',
              'debit', v_deferred, 'credit', 0, 'order_id', v_order_id::text));
          END IF;
          IF v_shipped > 0 THEN
            v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1470',
              'debit', v_shipped, 'credit', 0, 'sub_account', 'dispute_pending', 'memo', 'dispute_reason:' || v_cause));
          END IF;
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'dispute_event',
            ARRAY[v_dispute_id, 'withdrawn', v_bt.id], c_label_withdrawn, v_lines,
            _source_table => 'stripe_balance_transactions', _source_id => v_bt.id,
            _source_recorded_at => LEAST(v_bt.synced_at, pg_catalog.clock_timestamp()));
          v_entry_id := (v_result ->> 'entry_id')::uuid;
          IF (v_result ->> 'created')::boolean THEN
            v_posted := v_posted + 1;
            v_withdrawn := v_withdrawn + 1;
          END IF;
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event('dispute_event', v_table, v_source_id, v_entry_id);
            v_resolved := v_resolved + 1;
          END IF;
        END IF;

      ELSIF v_job.task = 'reversal' THEN
        -- R or L: part of the amount comes back.
        SELECT t.* INTO v_bt FROM public.stripe_balance_transactions AS t WHERE t.id = v_job.txn_id;
        IF NOT FOUND THEN
          CONTINUE;
        END IF;
        v_date := private.accounting_jst_date(v_bt.stripe_created_at);
        SELECT e.id INTO v_existing FROM public.accounting_journal_entries AS e
        WHERE e.dedupe_key = private.accounting_dispute_key(v_dispute_id, 'reversal', v_bt.id);
        IF FOUND THEN
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event('dispute_event', v_table, v_source_id, v_existing);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        SELECT d.* INTO v_dispute FROM public.stripe_disputes AS d WHERE d.id = v_dispute_id;
        IF NOT FOUND THEN
          v_reason := 'no_order';
        ELSE
          v_order_id := private.accounting_dispute_order(v_dispute_id);
          IF v_order_id IS NULL THEN
            v_reason := 'no_order';
          END IF;
        END IF;
        IF v_reason IS NULL AND NOT private.accounting_dispute_withdrawn_all_posted(v_dispute_id) THEN
          v_reason := 'dispute_withdrawal_missing';
        END IF;
        IF v_reason IS NULL THEN
          v_kind := private.accounting_dispute_reversal_kind(v_dispute_id, v_bt.stripe_created_at);
          IF v_kind IS NULL THEN
            v_reason := 'dispute_withdrawal_missing';
            IF v_dispute.status ~ '^[a-z_]{1,40}$' THEN
              v_detail := pg_catalog.jsonb_build_object('dispute_status', v_dispute.status);
            END IF;
          ELSIF v_kind = 'L' AND NOT private.accounting_dispute_confirmed_done(v_dispute_id) THEN
            v_reason := 'dispute_withdrawal_missing';
          END IF;
        END IF;
        IF v_reason IS NULL THEN
          SELECT s.amount, s.shipped_part, s.deferred_part INTO v_amount, v_shipped, v_deferred
          FROM private.accounting_dispute_split_reversal(v_dispute_id, v_bt.id) AS s;
-- ACC_P3_REPLACE_BEGIN 5682703eb86477a5ab6406a7b0417970
          IF v_kind = 'L' AND v_shipped > 0 THEN
            SELECT g.cost_account, g.cost_part, g.review_part, g.payable_part, g.waiting
            INTO v_account, v_cost_part, v_review_part, v_payable_part, v_waiting
            FROM private.accounting_dispute_reversal_targets(v_dispute_id, v_shipped) AS g;
            IF v_waiting THEN
              v_reason := 'dispute_withdrawal_missing';
              v_detail := pg_catalog.jsonb_build_object('waiting_on', 'dispute_account_unassigned');
            END IF;
          END IF;
-- ACC_P3_REPLACE_END
        END IF;
        IF v_reason IS NULL AND v_cutover IS NOT NULL AND v_date < v_cutover THEN
          v_reason := 'before_cutover';
        END IF;
        IF v_reason IS NULL THEN
          v_period := private.accounting_period_for_event(v_date);
        END IF;
        IF v_reason IS NOT NULL THEN
          PERFORM private.accounting_park_event('dispute_event', v_table, v_source_id, v_order_id, v_reason, v_detail);
          IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
        ELSE
          v_lines := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1160', 'debit', v_amount,
            'credit', 0, 'memo', 'dispute_reversal_kind:' || v_kind));
          IF v_deferred > 0 THEN
            v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '2150',
              'debit', 0, 'credit', v_deferred, 'order_id', v_order_id::text));
          END IF;
          IF v_shipped > 0 THEN
            IF v_kind = 'R' THEN
              v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1470',
                'debit', 0, 'credit', v_shipped, 'sub_account', 'dispute_pending'));
            ELSE
-- ACC_P3_REPLACE_BEGIN e96d9d3db4de231a621b3c2957350bad
              IF v_cost_part > 0 THEN
                v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', v_account,
                  'debit', 0, 'credit', v_cost_part));
              END IF;
              IF v_review_part > 0 THEN
                v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1470',
                  'debit', 0, 'credit', v_review_part, 'sub_account', 'dispute_refund_overlap_review', 'order_id', v_order_id::text));
              END IF;
              IF v_payable_part > 0 THEN
                v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '2130',
                  'debit', 0, 'credit', v_payable_part, 'sub_account', 'return_refund', 'order_id', v_order_id::text));
              END IF;
-- ACC_P3_REPLACE_END
            END IF;
          END IF;
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'dispute_event',
            ARRAY[v_dispute_id, 'reversal', v_bt.id], c_label_reversal, v_lines,
            _source_table => 'stripe_balance_transactions', _source_id => v_bt.id,
            _source_recorded_at => LEAST(v_bt.synced_at, pg_catalog.clock_timestamp()));
          v_entry_id := (v_result ->> 'entry_id')::uuid;
          IF (v_result ->> 'created')::boolean THEN
            v_posted := v_posted + 1;
            IF v_kind = 'R' THEN v_reversals := v_reversals + 1; ELSE v_late := v_late + 1; END IF;
          END IF;
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event('dispute_event', v_table, v_source_id, v_entry_id);
            v_resolved := v_resolved + 1;
          END IF;
        END IF;

      ELSE
        -- C: the dispute is lost. The loss time is Stripe's time, never the time this system learned of it.
        SELECT e.id INTO v_existing FROM public.accounting_journal_entries AS e
        WHERE e.dedupe_key = private.accounting_dispute_key(v_dispute_id, 'confirmed', 'lost');
        IF FOUND THEN
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event('dispute_event', v_table, v_source_id, v_existing);
            v_resolved := v_resolved + 1;
          END IF;
          CONTINUE;
        END IF;
        SELECT d.* INTO v_dispute FROM public.stripe_disputes AS d WHERE d.id = v_dispute_id;
        IF NOT FOUND THEN
          CONTINUE;
        END IF;
        v_lost := private.accounting_dispute_lost_at(v_dispute_id);
        IF v_lost IS NULL THEN
          CONTINUE;
        END IF;
        v_date := private.accounting_jst_date(v_lost);
        v_order_id := private.accounting_dispute_order(v_dispute_id);
        IF NOT private.accounting_dispute_withdrawn_all_posted(v_dispute_id) THEN
          v_reason := 'dispute_withdrawal_missing';
        ELSIF EXISTS (SELECT 1 FROM public.stripe_balance_transactions AS t
          WHERE t.source_id = v_dispute_id AND t.reporting_category = 'dispute_reversal' AND t.amount > 0
            AND t.stripe_created_at <= v_lost
            AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
              WHERE e.dedupe_key = private.accounting_dispute_key(v_dispute_id, 'reversal', t.id))) THEN
          -- A reversal at or before the loss time is R and goes first, so C takes the balance as it is after it.
          v_reason := 'dispute_withdrawal_missing';
        END IF;
        IF v_reason IS NULL THEN
          v_amount := private.accounting_dispute_balance(v_dispute_id, '1470', 'dispute_pending');
          IF v_amount = 0 THEN
            -- Nothing is left to confirm (the units were all unshipped, or R brought all of it back): no entry.
            PERFORM private.accounting_park_event('dispute_event', v_table, v_source_id, v_order_id, 'no_revenue',
              pg_catalog.jsonb_build_object('lost_on', pg_catalog.to_char(v_date, 'YYYY-MM-DD')));
            PERFORM private.accounting_unpark_event('dispute_event', v_table, v_source_id, NULL);
            IF v_job.lane = 0 THEN
              v_parked_new := v_parked_new + 1;
            END IF;
            v_resolved := v_resolved + 1;
            CONTINUE;
          ELSIF v_amount < 0 THEN
            RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
          END IF;
          IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
            v_reason := 'before_cutover';
          ELSE
            v_period := private.accounting_period_for_event(v_date);
          END IF;
-- ACC_P3_BEGIN
          IF v_reason IS NULL AND v_order_id IS NOT NULL THEN
            SELECT r.ready, r.reason INTO v_ready, v_why
            FROM private.accounting_dispute_offset_ready(v_dispute_id, v_order_id, v_date) AS r;
            IF NOT v_ready THEN
              v_reason := CASE v_why WHEN 'dispute_refund_overlap' THEN 'dispute_refund_overlap' ELSE 'dispute_return_refund_pending' END;
              v_detail := pg_catalog.jsonb_build_object('why', CASE WHEN v_reason = 'dispute_refund_overlap' THEN 'refund' ELSE 'return' END);
            END IF;
          END IF;
          IF v_reason IS NULL AND v_order_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
              JOIN public.accounting_return_facts AS f ON f.id::text = e.source_id
              WHERE e.event_kind = 'return_amount_decided' AND e.source_table = 'accounting_return_facts'
                AND f.order_id = v_order_id AND f.refund_id IS NULL AND e.entry_date > v_date
                AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)) THEN
            -- A 0 yen close of the order booked after the loss day took C and F back (spec 3-3): C is booked as it is and the fix
            -- entries come after it. First the waits, in the order of the spec: the refunds in flight (all of them; none is left
            -- out on this side), then the thing with the earlier day (spec 3-5). The three waits of C itself are above.
            IF EXISTS (SELECT 1 FROM private.accounting_order_refunds_in_flight(v_order_id, NULL)) THEN
              v_reason := 'dispute_refund_overlap';
              v_detail := pg_catalog.jsonb_build_object('why', 'refund');
            ELSE
              -- The key day of this C: the day of the last 0 yen close entry after the loss day (not reversed).
              SELECT pg_catalog.max(e.entry_date) INTO v_close_last FROM public.accounting_journal_entries AS e
              JOIN public.accounting_return_facts AS f ON f.id::text = e.source_id
              WHERE e.event_kind = 'return_amount_decided' AND e.source_table = 'accounting_return_facts'
                AND f.order_id = v_order_id AND f.refund_id IS NULL AND e.entry_date > v_date
                AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id);
              IF EXISTS (SELECT 1 FROM public.accounting_return_facts AS a
                  WHERE a.order_id = v_order_id AND a.kind = 'decision' AND a.decided_on <= v_close_last
                    AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                      WHERE e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[a.id::text]))
                    AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
                      WHERE p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts'
                        AND p.source_id = a.id::text AND (p.resolved_at IS NOT NULL OR p.reason = 'before_cutover')))
                OR EXISTS (SELECT 1 FROM (SELECT d2.id AS did,
                      (SELECT pg_catalog.max(e.entry_date) FROM public.accounting_journal_entries AS e
                        JOIN public.accounting_return_facts AS f ON f.id::text = e.source_id
                        WHERE e.event_kind = 'return_amount_decided' AND e.source_table = 'accounting_return_facts'
                          AND f.order_id = v_order_id AND f.refund_id IS NULL
                          AND e.entry_date > private.accounting_jst_date(private.accounting_dispute_lost_at(d2.id))
                          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)) AS last_on
                    FROM public.stripe_disputes AS d2
                    WHERE d2.id <> v_dispute_id
                      AND private.accounting_dispute_order(d2.id) = v_order_id
                      AND private.accounting_dispute_lost_at(d2.id) IS NOT NULL
                      AND (v_cutover IS NULL OR private.accounting_jst_date(private.accounting_dispute_lost_at(d2.id)) >= v_cutover)
                      AND NOT private.accounting_dispute_confirmed_done(d2.id)
                      AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
                        WHERE p.event_kind = 'dispute_event' AND p.source_table = 'stripe_disputes' AND p.source_id = d2.id
                          AND p.resolved_at IS NOT NULL)) AS k
                  WHERE k.last_on < v_close_last OR (k.last_on = v_close_last AND k.did < v_dispute_id)) THEN
                v_reason := 'dispute_return_refund_pending';
                v_detail := pg_catalog.jsonb_build_object('why', 'return');
              END IF;
            END IF;
          END IF;
-- ACC_P3_END
        END IF;
        IF v_reason IS NOT NULL THEN
          PERFORM private.accounting_park_event('dispute_event', v_table, v_source_id, v_order_id, v_reason, v_detail);
          IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
        ELSE
          v_cause := private.accounting_dispute_cause(v_dispute.reason);
-- ACC_P3_REPLACE_BEGIN ed2e91010e8299e8f87dd455dc13dfa9
          SELECT o.pay, o.review INTO v_pay, v_review
          FROM private.accounting_dispute_offset_amounts(v_order_id, v_date, v_amount) AS o;
          v_rest := v_amount - v_pay - v_review;
          v_lines := '[]'::jsonb;
          IF v_rest > 0 THEN
            SELECT s.account_code INTO v_account FROM public.accounting_dispute_account_settings AS s WHERE s.reason = v_cause;
            IF v_account IS NULL THEN
              v_lines := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1470', 'debit', v_rest,
                'credit', 0, 'sub_account', 'dispute_confirmed_unassigned', 'memo', 'dispute_reason:' || v_cause));
            ELSE
              v_lines := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', v_account, 'debit', v_rest,
                'credit', 0, 'memo', 'dispute_reason:' || v_cause));
            END IF;
          END IF;
          IF v_pay > 0 THEN
            v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '2130', 'debit', v_pay,
              'credit', 0, 'sub_account', 'return_refund', 'order_id', v_order_id::text, 'memo', 'offset_pay:' || v_pay::text));
          END IF;
          IF v_review > 0 THEN
            v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1470', 'debit', v_review,
              'credit', 0, 'sub_account', 'dispute_refund_overlap_review', 'order_id', v_order_id::text,
              'memo', 'offset_review:' || v_review::text));
          END IF;
-- ACC_P3_REPLACE_END
          v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1470', 'debit', 0,
            'credit', v_amount, 'sub_account', 'dispute_pending',
            'memo', 'dispute_lost_at:' || pg_catalog.to_char(v_lost AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
          v_recorded := (SELECT pg_catalog.min(h.created_at) FROM public.stripe_dispute_events AS h
            WHERE h.dispute_id = v_dispute_id AND h.status = 'lost');
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'dispute_event',
            ARRAY[v_dispute_id, 'confirmed', 'lost'], c_label_confirmed, v_lines,
            _source_table => 'stripe_disputes', _source_id => v_dispute_id,
            _source_recorded_at => LEAST(v_recorded, pg_catalog.clock_timestamp()));
          v_entry_id := (v_result ->> 'entry_id')::uuid;
          IF (v_result ->> 'created')::boolean THEN
            v_posted := v_posted + 1;
            v_confirmed_count := v_confirmed_count + 1;
          END IF;
-- ACC_P3_BEGIN
          -- Fix entries (spec 4-2): every day d_n of a 0 yen close of the order after the loss day (not reversed) that went in before
          -- C took the payable of the order back once more. C is in the books now (read in statements of their own, a STABLE
          -- function reads the start of its statement), so y_n = max(-B(d_n), 0), B(d_n) = 2130 up to d_n with C and the earlier
          -- fixes. The fix has its own variables: v_result and v_entry_id stay C's, the pending row of lane 1 is tied to C.
          IF v_order_id IS NOT NULL AND (v_result ->> 'created')::boolean THEN
            v_fix_n := 0;
            v_fix_sum := 0;
            SELECT pg_catalog.max(e.entry_date) INTO v_fix_last FROM public.accounting_journal_entries AS e
            JOIN public.accounting_return_facts AS f ON f.id::text = e.source_id
            WHERE e.event_kind = 'return_amount_decided' AND e.source_table = 'accounting_return_facts'
              AND f.order_id = v_order_id AND f.refund_id IS NULL AND e.entry_date > v_date
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id);
            FOR v_fix_date IN
              SELECT DISTINCT e.entry_date FROM public.accounting_journal_entries AS e
              JOIN public.accounting_return_facts AS f ON f.id::text = e.source_id
              WHERE e.event_kind = 'return_amount_decided' AND e.source_table = 'accounting_return_facts'
                AND f.order_id = v_order_id AND f.refund_id IS NULL AND e.entry_date > v_date
                AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
              ORDER BY e.entry_date
            LOOP
              v_fix_n := v_fix_n + 1;
              v_fix_y := GREATEST(0 - private.accounting_order_return_payable(v_order_id, v_fix_date), 0);
              IF v_fix_date = v_fix_last THEN
                -- D12: the last fix also takes back what C took more than the later money moves left, up to C's own 2130 debit (pay)
                -- less the earlier fixes. A double payment that has nothing to do with C is not hidden: the check below fails.
                v_fix_now := private.accounting_order_return_payable(v_order_id, NULL);
                v_fix_y := GREATEST(v_fix_y, LEAST(0 - v_fix_now, v_pay - v_fix_sum), 0);
              END IF;
              IF v_fix_y > 0 THEN
                -- The day of the fix first: when its period is missing, the whole event (C too) goes back and the parked row names
                -- this day.
                v_date := v_fix_date;
                v_period := private.accounting_period_for_event(v_date);
                v_fix_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'dispute_event',
                  ARRAY['closefix', v_dispute_id, v_fix_n::text], U&'\8FD4\91D1\306E\984D\306E\6C7A\5B9A',
                  pg_catalog.jsonb_build_array(
                    pg_catalog.jsonb_build_object('account_code', '4020', 'debit', v_fix_y, 'credit', 0, 'order_id', v_order_id::text,
                      'memo', 'closefix:' || v_fix_n::text),
                    pg_catalog.jsonb_build_object('account_code', '2130', 'debit', 0, 'credit', v_fix_y, 'sub_account', 'return_refund',
                      'order_id', v_order_id::text, 'memo', 'closefix:' || v_fix_n::text)),
                  _source_table => 'stripe_disputes', _source_id => v_dispute_id);
                v_fix_entry_id := (v_fix_result ->> 'entry_id')::uuid;
                v_fix_sum := v_fix_sum + v_fix_y;
                v_fix_check_day := private.accounting_order_return_payable(v_order_id, v_date);
                IF v_fix_check_day < 0 THEN
                  RAISE EXCEPTION 'ACCOUNTING_POSTING_BALANCE_NEGATIVE' USING ERRCODE = '23514';
                END IF;
              END IF;
            END LOOP;
            IF v_fix_n > 0 THEN
              v_fix_check_now := private.accounting_order_return_payable(v_order_id, NULL);
              v_fix_review := (SELECT COALESCE(pg_catalog.sum(l.debit - l.credit), 0) FROM public.accounting_journal_lines AS l
                WHERE l.order_id = v_order_id AND l.account_code = '1470' AND l.sub_account = 'dispute_refund_overlap_review');
              IF v_fix_check_now < 0 OR v_fix_review < 0 THEN
                RAISE EXCEPTION 'ACCOUNTING_POSTING_BALANCE_NEGATIVE' USING ERRCODE = '23514';
              END IF;
            END IF;
          END IF;
-- ACC_P3_END
          IF v_job.lane = 1 THEN
            PERFORM private.accounting_unpark_event('dispute_event', v_table, v_source_id, v_entry_id);
            v_resolved := v_resolved + 1;
          END IF;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- The rows and the entry number of this one event are undone with the block. Only the SQLSTATE and a fixed code are
      -- kept; the text of the exception is never stored.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure('dispute_event', v_table, v_source_id, v_order_id, v_sqlstate, SQLERRM,
        v_pg_detail, v_date);
      -- false: nothing could be parked; the event is counted nowhere and is taken again as a new event next run.
      IF v_parked THEN
        IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved, 'withdrawn', v_withdrawn, 'confirmed', v_confirmed_count, 'reversals', v_reversals,
    'late_reversals', v_late);
END;
$$;
-- ACC_S27_BODY_END

-- ACC_S27_FINAL_ASSERT_BEGIN
-- Filled in by Task 4 (function attributes, unchanged bodies, no new reason, no row written).
-- ACC_S27_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
