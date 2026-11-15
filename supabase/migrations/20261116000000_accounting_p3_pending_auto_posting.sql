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
    FROM pg_catalog.unnest(ARRAY['private.accounting_refund_wait(uuid,text)']) AS s(sig)));

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
-- ACC_S27_BODY_END

-- ACC_S27_FINAL_ASSERT_BEGIN
-- Filled in by Task 4 (function attributes, unchanged bodies, no new reason, no row written).
-- ACC_S27_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
