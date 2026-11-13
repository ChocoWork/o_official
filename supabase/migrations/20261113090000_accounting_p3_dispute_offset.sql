BEGIN;
-- Accounting plan 3 S22 (FREQ-581 AC-01..AC-08, FREQ-568-AC-07, FREQ-569-AC-01): the card dispute poster of plan 2 no longer
-- holds a withdrawal for a refund or a return, and a lost dispute (C) is offset against the order's return payable R
-- (2130 return_refund) and the post-shipment refunds already paid Z; a late withdrawal (L) gives back in the same order.
--
-- New (private, SECURITY DEFINER, STABLE, no EXECUTE for anyone):
--   private.accounting_dispute_offset_ready(_dispute_id text, _order_id uuid, _lost_on date) RETURNS TABLE(ready, reason)
--     C waits (dispute_refund_overlap) while a refund of the order made on or before the loss day (Japan) still has its Stripe
--     result open (latest accounting state requested, accepted or error) or a refund posting step not in the books, and
--     (dispute_return_refund_pending) while an arrival dated on or before the loss day (or whose live entry is) has no live
--     entry on its present arrival day, or a decision with a payable change decided on or before the loss day has no entry.
--     A dispute with no order never waits.
--   private.accounting_dispute_offset_amounts(_order_id uuid, _lost_on date, _amount bigint) RETURNS TABLE(pay, review)
--     R = credit - debit of 2130 return_refund of the order dated on or before the loss day (all entries, reversals too).
--     Z = credit - debit of 1160 and 1040 in the entries of kind return_refund (bank transfers too) and their reversals, minus
--     the post-shipment part a taken refund failure gave back (the 2130 refund_owed_post / return_refund credit of a
--     refund_failed entry with a 1160 line, and its reversal with the sign), all dated on or before the loss day, minus the
--     present balance of 1470 dispute_refund_overlap_review of the order (used by another dispute); below 0 is 0.
--     pay = min(max(R, 0), S), review = min(Z, S - pay).
--   private.accounting_dispute_reversal_targets(_dispute_id text, _amount bigint)
--     RETURNS TABLE(cost_account, cost_part, review_part, payable_part, waiting)
--     The shipped part of an L goes back to the expense account of C (or the account X assigned; waiting while C sits in the
--     unassigned sub-account and X is not done) up to its present balance in the dispute, then to 1470
--     dispute_refund_overlap_review up to the dispute's balance, then the rest to 2130 return_refund.
-- Rebuilt (CREATE OR REPLACE; the latest definition, plan 2 S11 20261108200000:352-771, copied as it is, new text between
-- ACC_P3_BEGIN and ACC_P3_END, the replaced text between ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END;
-- arguments, result, attributes, owner and ACL are unchanged):
--   private.accounting_post_dispute_events: W drops the two holds; C waits for offset_ready and books the offset lines
--     (debit 2130 return_refund pay, debit 1470 dispute_refund_overlap_review review, the cost line only for the rest; memo
--     offset_pay:<n> and offset_review:<n>); L credits the targets.
--
-- ROLLBACK (only while no confirmed entry has an offset line): re-run CREATE FUNCTION private.accounting_post_dispute_events
--   from 20261108200000_accounting_p2_dispute_posting.sql :352-771 as CREATE OR REPLACE;
--   DROP FUNCTION private.accounting_dispute_reversal_targets(text,bigint), private.accounting_dispute_offset_amounts(uuid,date,bigint),
--     private.accounting_dispute_offset_ready(text,uuid,date).

-- ACC_S22_BODY_BEGIN

CREATE TEMP TABLE accounting_s22_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s22_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', pg_catalog.jsonb_build_object(
    'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
    'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
    'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events)),
  'attrs', (SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a)))
    FROM pg_catalog.pg_proc AS f WHERE f.oid = 'private.accounting_post_dispute_events(integer)'::regprocedure));

-- 1. The wait of C (FREQ-581-AC-05). The refund state is the latest accounting state row; a refund without accounting facts
--    (never posted by the refund poster) is not looked at.
CREATE FUNCTION private.accounting_dispute_offset_ready(_dispute_id text, _order_id uuid, _lost_on date)
RETURNS TABLE(ready boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  ready := true;
  reason := NULL;
  IF _dispute_id IS NULL OR _order_id IS NULL OR _lost_on IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_refunds AS r
      JOIN public.accounting_refund_facts AS f ON f.refund_id = r.id
      WHERE r.order_id = _order_id AND private.accounting_jst_date(r.created_at) <= _lost_on
        AND ((SELECT x.state FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id ORDER BY x.seq DESC LIMIT 1)
            IN ('requested', 'accepted', 'error')
          OR (EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state = 'succeeded')
            AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
              WHERE e.event_kind IN ('pre_shipment_refund', 'return_refund') AND e.source_table = 'order_refunds'
                AND e.source_id = r.id::text)
            AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
              WHERE p.event_kind IN ('pre_shipment_refund', 'return_refund') AND p.source_table = 'order_refunds'
                AND p.source_id = r.id::text AND (p.resolved_at IS NOT NULL OR p.reason = 'before_cutover')))
          OR (EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state IN ('failed', 'owed'))
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
                AND (p.resolved_at IS NOT NULL OR p.reason = 'before_cutover'))))) THEN
    ready := false;
    reason := 'dispute_refund_overlap';
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_return_facts AS a
      CROSS JOIN LATERAL (SELECT private.accounting_return_arrival_on(a.receipt_id) AS arrival_on) AS d
      WHERE a.order_id = _order_id AND a.kind = 'arrival'
        AND (d.arrival_on <= _lost_on
          OR EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.source_table = 'order_return_receipts' AND e.source_id = a.receipt_id::text
              AND e.event_kind IN ('return_arrived', 'return_arrival_redated') AND e.entry_date <= _lost_on
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS v WHERE v.reverses_entry_id = e.id)))
        AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
          WHERE e.source_table = 'order_return_receipts' AND e.source_id = a.receipt_id::text
            AND e.event_kind IN ('return_arrived', 'return_arrival_redated') AND e.entry_date = d.arrival_on
            AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS v WHERE v.reverses_entry_id = e.id))
        AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
          WHERE p.event_kind = 'return_arrived' AND p.source_table = 'order_return_receipts' AND p.source_id = a.receipt_id::text
            AND ((p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NULL) OR p.reason = 'before_cutover')))
    OR EXISTS (SELECT 1 FROM public.accounting_return_facts AS a
      WHERE a.order_id = _order_id AND a.kind = 'decision' AND a.payable_delta <> 0 AND a.decided_on <= _lost_on
        AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
          WHERE e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[a.id::text]))
        AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
          WHERE p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts' AND p.source_id = a.id::text
            AND ((p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NULL) OR p.reason = 'before_cutover'))) THEN
    ready := false;
    reason := 'dispute_return_refund_pending';
  END IF;
  RETURN NEXT;
END;
$$;

-- 2. R and Z (FREQ-581-AC-02, AC-03). Only entries dated on or before the loss day count; _amount is S.
CREATE FUNCTION private.accounting_dispute_offset_amounts(_order_id uuid, _lost_on date, _amount bigint)
RETURNS TABLE(pay bigint, review bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_r bigint;
  v_z bigint;
  v_used bigint;
BEGIN
  pay := 0;
  review := 0;
  IF _order_id IS NULL OR _lost_on IS NULL OR _amount IS NULL OR _amount <= 0 THEN
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0)::bigint INTO v_r
  FROM public.accounting_journal_lines AS l
  JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
  WHERE l.order_id = _order_id AND l.account_code = '2130' AND l.sub_account = 'return_refund' AND e.entry_date <= _lost_on;
  SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0)::bigint INTO v_z
  FROM public.accounting_journal_lines AS l
  JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
  LEFT JOIN public.accounting_journal_entries AS o ON o.id = e.reverses_entry_id
  WHERE l.order_id = _order_id AND l.account_code IN ('1160', '1040') AND e.entry_date <= _lost_on
    AND (e.event_kind = 'return_refund' OR (e.event_kind = 'reversal' AND o.event_kind = 'return_refund'));
  v_z := v_z + (SELECT COALESCE(pg_catalog.sum(l.debit - l.credit), 0)::bigint
    FROM public.accounting_journal_lines AS l
    JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
    LEFT JOIN public.accounting_journal_entries AS o ON o.id = e.reverses_entry_id
    WHERE l.order_id = _order_id AND l.account_code = '2130' AND l.sub_account IN ('refund_owed_post', 'return_refund')
      AND e.entry_date <= _lost_on
      AND (e.event_kind = 'refund_failed' OR (e.event_kind = 'reversal' AND o.event_kind = 'refund_failed'))
      AND EXISTS (SELECT 1 FROM public.accounting_journal_lines AS c WHERE c.entry_id = e.id AND c.account_code = '1160'));
  SELECT COALESCE(pg_catalog.sum(l.debit - l.credit), 0)::bigint INTO v_used
  FROM public.accounting_journal_lines AS l
  WHERE l.order_id = _order_id AND l.account_code = '1470' AND l.sub_account = 'dispute_refund_overlap_review';
  v_z := GREATEST(v_z - v_used, 0);
  pay := LEAST(GREATEST(v_r, 0), _amount);
  review := LEAST(v_z, _amount - pay);
  RETURN NEXT;
END;
$$;

-- 3. Where the shipped part of a late withdrawal goes back (FREQ-581-AC-04). No row lock; the poster holds the locks.
CREATE FUNCTION private.accounting_dispute_reversal_targets(_dispute_id text, _amount bigint)
RETURNS TABLE(cost_account text, cost_part bigint, review_part bigint, payable_part bigint, waiting boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_line text;
  v_left bigint;
BEGIN
  IF _dispute_id IS NULL OR _amount IS NULL OR _amount <= 0
    OR NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
      WHERE e.dedupe_key = private.accounting_dispute_key(_dispute_id, 'confirmed', 'lost')) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- The cost line of C: the debit line that is not an offset line (none when the offsets took all of S).
  SELECT c.account_code INTO v_line FROM private.accounting_dispute_confirmed_account(_dispute_id) AS c
  WHERE c.account_code <> '2130'
    AND NOT (c.account_code = '1470' AND c.sub_account IS NOT DISTINCT FROM 'dispute_refund_overlap_review');
  waiting := false;
  cost_account := v_line;
  cost_part := 0;
  review_part := 0;
  payable_part := 0;
  IF v_line = '1470' THEN
    cost_account := private.accounting_dispute_assigned_account(_dispute_id);
    IF cost_account IS NULL THEN
      waiting := true;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;
  v_left := _amount;
  IF cost_account IS NOT NULL THEN
    cost_part := LEAST(v_left, GREATEST(private.accounting_dispute_balance(_dispute_id, cost_account, NULL), 0));
  END IF;
  v_left := v_left - cost_part;
  review_part := LEAST(v_left,
    GREATEST(private.accounting_dispute_balance(_dispute_id, '1470', 'dispute_refund_overlap_review'), 0));
  payable_part := v_left - review_part;
  RETURN NEXT;
END;
$$;

-- 4. The poster. CREATE OR REPLACE with the latest definition (plan 2 S11) copied as it is.
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

ALTER FUNCTION private.accounting_dispute_offset_ready(text,uuid,date) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_offset_amounts(uuid,date,bigint) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_reversal_targets(text,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.accounting_dispute_offset_ready(text,uuid,date),
  private.accounting_dispute_offset_amounts(uuid,date,bigint), private.accounting_dispute_reversal_targets(text,bigint)
FROM PUBLIC, anon, authenticated, service_role;
-- ACC_S22_BODY_END

-- ACC_S22_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. acc_s22_functions: the three tools exist once, private, SECURITY
-- DEFINER, STABLE plpgsql with search_path '', owned by postgres, with their arguments and results, and nobody runs them.
-- acc_s22_function_attrs: the poster keeps its arguments, result, language, volatility, security, owner, search_path and ACL.
-- acc_s22_body_unchanged: the poster has 4 replaced parts and 2 ACC_P3 blocks, and with the replaced parts restored from the
-- list below (by the md5 on the marker) and every ACC_P<n> block and all white space removed it is the plan 2 S11 body.
-- acc_s22_existing_dml_allowlist: this migration writes no row, and the group G writer list is what it was.
DO $acc_s22_final$
DECLARE
  v_failed text;
  v_stage text;
  v_search_path text;
  v_baseline jsonb;
  v_src text;
  v_match text[];
  v_original text;
  v_oid oid;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s22_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s22_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s22_baseline) <> 1 THEN
    v_failed := 'acc_s22_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s22_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s22_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s22_functions';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_dispute_offset_ready(text,uuid,date)', '_dispute_id,_order_id,_lost_on,ready,reason'),
      ('private.accounting_dispute_offset_amounts(uuid,date,bigint)', '_order_id,_lost_on,_amount,pay,review'),
      ('private.accounting_dispute_reversal_targets(text,bigint)',
        '_dispute_id,_amount,cost_account,cost_part,review_part,payable_part,waiting')
    ) AS x(signature, arg_names)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
          WHERE f.oid = v_oid AND f.prosecdef AND f.provolatile = 's' AND l.lanname = 'plpgsql' AND f.proretset
            AND f.prorettype = 'record'::regtype AND f.proowner = 'postgres'::regrole AND f.prokind = 'f'
            AND f.proconfig = ARRAY['search_path=""']::text[]
            AND pg_catalog.array_to_string(f.proargnames, ',') = e.arg_names)
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.proname = (SELECT f.proname FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid)) <> 1
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee <> f.proowner)
        OR (SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid)
          ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M' THEN
        v_failed := 'acc_s22_functions';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s22_function_attrs';
  IF v_failed IS NULL AND (v_baseline ->> 'attrs') IS DISTINCT FROM (SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a)))
    FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure('private.accounting_post_dispute_events(integer)')) THEN
    v_failed := 'acc_s22_function_attrs';
  END IF;

  v_stage := 'acc_s22_body_unchanged';
  IF v_failed IS NULL THEN
    SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
    WHERE f.oid = pg_catalog.to_regprocedure('private.accounting_post_dispute_events(integer)');
    IF v_src IS NULL
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_REPLACE_BEGIN', 'g')) <> 4
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_BEGIN', 'g')) <> 2
      OR pg_catalog.strpos(v_src, 'private.accounting_dispute_offset_ready(v_dispute_id, v_order_id, v_date)') = 0
      OR pg_catalog.strpos(v_src, 'private.accounting_dispute_offset_amounts(v_order_id, v_date, v_amount)') = 0
      OR pg_catalog.strpos(v_src, 'private.accounting_dispute_reversal_targets(v_dispute_id, v_shipped)') = 0
      OR pg_catalog.strpos(v_src, 'public.stripe_refunds') > 0 THEN
      v_failed := 'acc_s22_body_unchanged';
    ELSE
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('78e0d53f69cd6a67741d23e9a151e38d', $acc_s22_o1$          IF EXISTS (SELECT 1 FROM public.stripe_refunds AS f
            WHERE f.status = 'succeeded' AND (f.order_id = v_order_id
              OR (v_dispute.payment_intent_id IS NOT NULL AND f.payment_intent_id = v_dispute.payment_intent_id))) THEN
            v_reason := 'dispute_refund_overlap';
          ELSIF (SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0) FROM public.accounting_journal_lines AS l
            WHERE l.order_id = v_order_id AND l.account_code = '2130') <> 0 THEN
            v_reason := 'dispute_return_refund_pending';
          END IF;
$acc_s22_o1$),
    ('5682703eb86477a5ab6406a7b0417970', $acc_s22_o2$          IF v_kind = 'L' AND v_shipped > 0 THEN
            SELECT c.account_code, c.sub_account INTO v_debit_account, v_debit_sub
            FROM private.accounting_dispute_confirmed_account(v_dispute_id) AS c;
            IF NOT FOUND THEN
              RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
            END IF;
            IF v_debit_account = '1470' THEN
              v_account := private.accounting_dispute_assigned_account(v_dispute_id);
              IF v_account IS NULL THEN
                v_reason := 'dispute_withdrawal_missing';
                v_detail := pg_catalog.jsonb_build_object('waiting_on', 'dispute_account_unassigned');
              END IF;
            ELSE
              v_account := v_debit_account;
            END IF;
          END IF;
$acc_s22_o2$),
    ('e96d9d3db4de231a621b3c2957350bad', $acc_s22_o3$              v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', v_account,
                'debit', 0, 'credit', v_shipped));
$acc_s22_o3$),
    ('ed2e91010e8299e8f87dd455dc13dfa9', $acc_s22_o4$          SELECT s.account_code INTO v_account FROM public.accounting_dispute_account_settings AS s WHERE s.reason = v_cause;
          IF v_account IS NULL THEN
            v_lines := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1470', 'debit', v_amount,
              'credit', 0, 'sub_account', 'dispute_confirmed_unassigned', 'memo', 'dispute_reason:' || v_cause));
          ELSE
            v_lines := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', v_account, 'debit', v_amount,
              'credit', 0, 'memo', 'dispute_reason:' || v_cause));
          END IF;
$acc_s22_o4$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s22_body_unchanged';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
        v_original := NULL;
      END LOOP;
      IF v_failed IS NULL AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM 'be33247d41422ff1384c8037a7dba912' THEN
        v_failed := 'acc_s22_body_unchanged';
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s22_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline #>> '{counts,entries}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline #>> '{counts,lines}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline #>> '{counts,pending_events}')::bigint
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc))
      IS DISTINCT FROM (v_baseline -> 'allowlist')) THEN
    v_failed := 'acc_s22_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s22_functions'), HINT = SQLSTATE;
END;
$acc_s22_final$;
-- ACC_S22_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
