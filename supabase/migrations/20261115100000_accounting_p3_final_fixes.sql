BEGIN;
-- Accounting plan 3 S26 (final review fixes; Ruling P3-F1, P3-F2, P3-F3; FREQ-578-AC-01, FREQ-579-AC-01, FREQ-579-AC-04,
-- FREQ-579-AC-05, FREQ-578-AC-09): a return that sends nothing back books one entry on the refund day, the settle refuses a
-- plain return refund, and a negative 2130 return_refund balance is listed as an anomaly. No row is written and no table or
-- column changes; only function bodies are rebuilt.
--
-- Rebuilt (CREATE OR REPLACE; the latest definition copied as it is, new text between ACC_P3_BEGIN and ACC_P3_END, the
-- replaced text between ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END; arguments, result, attributes,
-- owner and ACL are unchanged; the public entries are not touched):
--   private.accounting_record_return_arrival (only definition: S18 20261112200809:123-154) and
--   private.accounting_record_return_decision (only definition: S18 :161-): nothing is recorded for a return whose
--     return_method is not_required (spec 5-e, plan item 14, P3-F1). admin_receive_return and admin_refund_return are not
--     touched; they call these two and now get no fact for such a return.
--   private.accounting_post_refund_events (only definition: S20 20261112214341:255-): v_plain (a return refund that goes
--     through 2130 return_refund) is false for such a return, so its refund books 4020 / 1160 on the refund day and a failure
--     debt goes to refund_owed_post.
--   private.admin_settle_owed_by_refund (only definition: S20 :807-): an owed refund that is a plain return refund (source
--     return, event kind not holdback_release or pre_shipment_cancel, return_method not not_required) is refused with
--     ACCOUNTING_ARGUMENT_INVALID / 22023, DETAIL settle_plain_return (P3-F2, P3-T11j).
--   private.list_refund_settle_candidates (latest: S25 20261114100000:280-): no candidates for such an owed refund.
--   private.list_refund_accounting_states (latest: S25 :64-): owed_return is 0 for a not_required return (its debt is
--     refund_owed_post).
--   private.list_deferred_revenue_anomalies (latest: S23 20261113100000:313-): a third reason,
--     return_refund_negative_balance, for an order whose 2130 return_refund balance is below 0 (P3-F3).
--
-- ROLLBACK (no row is written by this migration): re-run CREATE OR REPLACE of each function above from the migration and
--   lines named for it.

-- ACC_S26_BODY_BEGIN

CREATE TEMP TABLE accounting_s26_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s26_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', pg_catalog.jsonb_build_object(
    'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
    'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
    'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
    'settlements', (SELECT pg_catalog.count(*) FROM public.accounting_refund_settlements),
    'return_facts', (SELECT pg_catalog.count(*) FROM public.accounting_return_facts)),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(s.sig, (SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a)))
      FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(s.sig)))
    FROM pg_catalog.unnest(ARRAY['private.accounting_record_return_arrival(uuid,uuid,uuid,integer,integer)',
      'private.accounting_record_return_decision(uuid,uuid,uuid,integer,uuid,integer,integer,integer)',
      'private.accounting_post_refund_events(integer)',
      'private.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid)',
      'public.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid)',
      'private.list_refund_accounting_states(integer,timestamptz,uuid)',
      'public.list_refund_accounting_states(integer,timestamptz,uuid)',
      'private.list_refund_settle_candidates(uuid)',
      'public.list_refund_settle_candidates(uuid)',
      'private.list_deferred_revenue_anomalies()']) AS s(sig)));

-- 1. A return that sends nothing back has no arrival and no decision (P3-F1).
CREATE OR REPLACE FUNCTION private.accounting_record_return_arrival(_receipt_id uuid, _return_id uuid, _order_id uuid,
  _goods_amount integer, _fee_amount integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_next integer;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  IF _receipt_id IS NULL OR _goods_amount IS NULL OR _fee_amount IS NULL OR _goods_amount < 0 OR _fee_amount < 0
    OR _fee_amount > _goods_amount
    OR NOT EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.id = _return_id AND r.order_id = _order_id)
    OR NOT EXISTS (SELECT 1 FROM public.order_return_receipts AS rr
      WHERE rr.id = _receipt_id AND rr.return_id = _return_id AND rr.kind = 'receive') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
-- ACC_P3_BEGIN
  -- Ruling P3-F1 (spec 5-e, plan item 14): a return that sends nothing back (return_method not_required) has no arrival; its
  -- refund books one entry on the refund day.
  IF EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = _return_id AND rt.return_method = 'not_required') THEN
    RETURN;
  END IF;
-- ACC_P3_END
  IF _goods_amount = 0 OR EXISTS (SELECT 1 FROM public.accounting_return_facts AS f
      WHERE f.receipt_id = _receipt_id AND f.kind = 'arrival') THEN
    RETURN;
  END IF;
  SELECT COALESCE(pg_catalog.max(f.seq), 0) + 1 INTO v_next FROM public.accounting_return_facts AS f WHERE f.return_id = _return_id;
  INSERT INTO public.accounting_return_facts (return_id, order_id, seq, kind, receipt_id, goods_amount, fee_amount)
  VALUES (_return_id, _order_id, v_next, 'arrival', _receipt_id, _goods_amount, _fee_amount);
END;
$$;

CREATE OR REPLACE FUNCTION private.accounting_record_return_decision(_return_id uuid, _order_id uuid, _refund_id uuid,
  _decided_amount integer, _receipt_id uuid DEFAULT NULL, _fee_amount integer DEFAULT 0, _goods_now integer DEFAULT NULL,
  _fee_now integer DEFAULT NULL) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_kind text;
  v_refund public.order_refunds%ROWTYPE;
  v_left bigint;
  v_covers bigint;
  v_fee bigint;
  v_next integer;
BEGIN
  PERFORM private.group_h_assert_unit_lock();
  IF _return_id IS NULL OR _order_id IS NULL OR _decided_amount IS NULL OR _decided_amount < 0
    OR _fee_amount IS NULL OR _fee_amount < 0
    OR NOT EXISTS (SELECT 1 FROM public.order_returns AS r WHERE r.id = _return_id AND r.order_id = _order_id) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
-- ACC_P3_BEGIN
  -- Ruling P3-F1: no decision either for a return that sends nothing back (it has no arrival to decide against).
  IF EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = _return_id AND rt.return_method = 'not_required') THEN
    RETURN;
  END IF;
-- ACC_P3_END
  IF _receipt_id IS NOT NULL THEN
    SELECT rr.kind INTO v_kind FROM public.order_return_receipts AS rr WHERE rr.id = _receipt_id AND rr.return_id = _return_id;
    IF v_kind IS NULL OR v_kind NOT IN ('receive', 'waive_refund') THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_kind = 'receive' THEN
    IF _goods_now IS NULL OR _fee_now IS NULL OR _goods_now < 0 OR _fee_now < 0 OR _fee_now > _goods_now THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSIF _goods_now IS NOT NULL OR _fee_now IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _refund_id IS NOT NULL THEN
    IF (v_kind IS NOT NULL AND v_kind <> 'receive') OR (v_kind = 'receive' AND _fee_amount <> _fee_now) THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = _refund_id;
    IF NOT FOUND OR v_refund.return_id IS DISTINCT FROM _return_id OR v_refund.order_id <> _order_id THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.accounting_return_facts AS f WHERE f.kind = 'decision' AND f.refund_id = _refund_id) THEN
      RETURN;
    END IF;
  ELSE
    IF _receipt_id IS NULL OR _decided_amount <> 0 OR _fee_amount <> 0 THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.accounting_return_facts AS f WHERE f.kind = 'decision' AND f.receipt_id = _receipt_id) THEN
      RETURN;
    END IF;
  END IF;
  SELECT COALESCE((SELECT pg_catalog.sum(f.goods_amount - f.fee_amount) FROM public.accounting_return_facts AS f
      WHERE f.return_id = _return_id AND f.kind = 'arrival'), 0)
    + COALESCE((SELECT pg_catalog.sum(f.payable_delta) FROM public.accounting_return_facts AS f
      WHERE f.return_id = _return_id AND f.kind = 'decision'), 0)
    - COALESCE((SELECT pg_catalog.sum(f.decided_amount) FROM public.accounting_return_facts AS f
      JOIN public.order_refunds AS rf ON rf.id = f.refund_id
      WHERE f.return_id = _return_id AND f.kind = 'decision'
        AND NOT (rf.status = 'failed' OR (rf.status = 'canceled' AND EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
          WHERE x.refund_id = rf.id AND x.state = 'abandoned')))), 0)
  INTO v_left;
  v_left := GREATEST(v_left, 0);
  IF v_kind = 'receive' THEN
    v_covers := CASE WHEN _goods_now = 0 THEN 0 ELSE LEAST(GREATEST(_goods_now - _fee_now, 0), v_left) END;
    v_fee := CASE WHEN _refund_id IS NOT NULL THEN _fee_amount WHEN _goods_now = 0 THEN 0 ELSE _fee_now END;
  ELSIF v_kind = 'waive_refund' THEN
    v_covers := v_left;
    SELECT GREATEST(
      COALESCE((SELECT pg_catalog.sum(f.fee_amount) FROM public.accounting_return_facts AS f
        WHERE f.return_id = _return_id AND f.kind = 'arrival'), 0)
      - COALESCE((SELECT pg_catalog.sum(f.fee_amount) FROM public.accounting_return_facts AS f
        JOIN public.order_refunds AS rf ON rf.id = f.refund_id
        WHERE f.return_id = _return_id AND f.kind = 'decision'
          AND NOT (rf.status = 'failed' OR (rf.status = 'canceled' AND EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
            WHERE x.refund_id = rf.id AND x.state = 'abandoned')))), 0)
      - COALESCE((SELECT pg_catalog.sum(f.fee_amount) FROM public.accounting_return_facts AS f
        WHERE f.return_id = _return_id AND f.kind = 'decision' AND f.refund_id IS NULL), 0), 0)
    INTO v_fee;
  ELSIF EXISTS (SELECT 1 FROM public.order_discount_snapshots AS s WHERE s.order_id = _order_id) THEN
    -- Ruling P3-C8: the (event, part) rows this refund is linked to (the core linked them from the reader), each counted once
    -- (primary key event, refund, part), plus each earlier failed refund linked to one of the same (event, part), once.
    SELECT COALESCE((SELECT pg_catalog.sum(CASE er.part WHEN 'now' THEN e.now_refund ELSE e.consult_refund END)
        FROM public.order_unit_event_refunds AS er JOIN public.order_unit_events AS e ON e.id = er.event_id
        WHERE er.refund_id = _refund_id AND er.part IN ('now', 'consult')), 0)
      + COALESCE((SELECT pg_catalog.sum(f.payable_delta) FROM public.accounting_return_facts AS f
        WHERE f.kind = 'decision' AND f.refund_id IN (
          SELECT p.refund_id FROM public.order_unit_event_refunds AS p
          JOIN public.order_refunds AS rf ON rf.id = p.refund_id
          JOIN public.order_unit_event_refunds AS n ON n.refund_id = _refund_id AND n.event_id = p.event_id AND n.part = p.part
          WHERE p.refund_id <> _refund_id AND rf.status = 'failed')), 0)
    INTO v_covers;
    v_covers := GREATEST(v_covers, 0);
    v_fee := _fee_amount;
  ELSE
    v_covers := v_left;
    v_fee := _fee_amount;
  END IF;
  SELECT COALESCE(pg_catalog.max(f.seq), 0) + 1 INTO v_next FROM public.accounting_return_facts AS f WHERE f.return_id = _return_id;
  INSERT INTO public.accounting_return_facts (return_id, order_id, seq, kind, receipt_id, refund_id, goods_amount, fee_amount,
    covers_amount, decided_amount, payable_delta, decided_on)
  VALUES (_return_id, _order_id, v_next, 'decision', _receipt_id, _refund_id, 0, v_fee, v_covers, _decided_amount,
    _decided_amount - v_covers, private.accounting_jst_date(pg_catalog.now()));
END;
$$;

-- 2. Its refund is not plain (P3-F1).
CREATE OR REPLACE FUNCTION private.accounting_post_refund_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_job record;
  v_entry record;
  v_refund public.order_refunds%ROWTYPE;
  v_fact public.accounting_refund_facts%ROWTYPE;
  v_row public.accounting_refund_events%ROWTYPE;
  v_sr public.stripe_refunds%ROWTYPE;
  v_bt public.stripe_balance_transactions%ROWTYPE;
  v_cutover date;
  v_kind text;
  v_table text;
  v_source text;
  v_reason text;
  v_detail jsonb;
  v_date date;
  v_period uuid;
  v_at timestamptz;
  v_d integer;
  v_s integer;
  v_plain boolean;
  v_pulled boolean;
  v_back boolean;
  v_why text;
  v_lines jsonb;
  v_result jsonb;
  v_first uuid;
  v_made integer;
  v_rev integer;
  v_closed integer;
  v_mark boolean;
  v_sqlstate text;
  v_pg_detail text;
  v_parked boolean;
  v_posted integer := 0;
  v_parked_new integer := 0;
  v_reparked integer := 0;
  v_resolved integer := 0;
  v_reversed integer := 0;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_cutover := private.accounting_cutover_on();

  FOR v_job IN
    SELECT j.lane, j.step, j.refund_id, j.row_id, j.pending_id, j.pending_kind FROM (
      (SELECT 0 AS lane, c.step, c.refund_id, c.row_id, NULL::uuid AS pending_id, NULL::text AS pending_kind,
          c.seq, NULL::timestamptz AS at
        FROM (
          SELECT 'success'::text AS step, x.refund_id, x.id AS row_id, x.fact_seq AS seq
          FROM public.accounting_refund_events AS x
          JOIN public.accounting_refund_facts AS f ON f.refund_id = x.refund_id
          JOIN public.order_refunds AS r ON r.id = x.refund_id
          JOIN public.stripe_refunds AS sr ON sr.id = r.stripe_refund_id
          JOIN public.stripe_balance_transactions AS bt ON bt.id = sr.balance_transaction_id
          WHERE x.state = 'succeeded'
            AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
              WHERE e.event_kind IN ('pre_shipment_refund', 'return_refund') AND e.source_table = 'order_refunds'
                AND e.source_id = x.refund_id::text)
            AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
              WHERE p.event_kind IN ('pre_shipment_refund', 'return_refund') AND p.source_table = 'order_refunds'
                AND p.source_id = x.refund_id::text)
          UNION ALL
          SELECT 'failure', x.refund_id, x.id, x.fact_seq
          FROM (SELECT DISTINCT ON (y.refund_id) y.* FROM public.accounting_refund_events AS y
            WHERE y.state IN ('failed', 'owed') ORDER BY y.refund_id, (y.state = 'failed') DESC, y.fact_seq) AS x
          JOIN public.accounting_refund_facts AS f ON f.refund_id = x.refund_id
          WHERE NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
              WHERE e.event_kind = 'refund_failed' AND e.source_table = 'order_refunds' AND e.source_id = x.refund_id::text)
            AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
              WHERE p.event_kind = 'refund_failed' AND p.source_table = 'order_refunds' AND p.source_id = x.refund_id::text)
          UNION ALL
          SELECT 'undecided', x.refund_id, x.id, x.fact_seq
          FROM public.accounting_refund_events AS x
          JOIN public.accounting_refund_facts AS f ON f.refund_id = x.refund_id
          WHERE x.state = 'canceled'
            AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS y
              WHERE y.refund_id = x.refund_id AND y.state IN ('abandoned', 'owed'))
            AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
              WHERE p.event_kind = 'refund_abandoned' AND p.source_table = 'accounting_refund_events' AND p.source_id = x.id::text)
          UNION ALL
          SELECT 'abandon', x.refund_id, x.id, x.fact_seq
          FROM public.accounting_refund_events AS x
          JOIN public.accounting_refund_facts AS f ON f.refund_id = x.refund_id
          WHERE x.state = 'abandoned'
            AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
              WHERE e.event_kind = 'refund_abandoned' AND e.source_table = 'order_refunds' AND e.source_id = x.refund_id::text)
            AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
              WHERE p.event_kind = 'refund_abandoned' AND p.source_table = 'order_refunds' AND p.source_id = x.refund_id::text)
        ) AS c
        ORDER BY c.seq
        LIMIT _limit)
      UNION ALL
      (SELECT 1, CASE WHEN p.source_table = 'accounting_refund_events' THEN 'undecided'
            WHEN p.event_kind = 'refund_failed' THEN 'failure'
            WHEN p.event_kind = 'refund_abandoned' THEN 'abandon' ELSE 'success' END,
          CASE WHEN p.source_table = 'accounting_refund_events'
            THEN (SELECT y.refund_id FROM public.accounting_refund_events AS y WHERE y.id::text = p.source_id)
            ELSE p.source_id::uuid END,
          CASE WHEN p.source_table = 'accounting_refund_events' THEN p.source_id::uuid END,
          p.id, p.event_kind, NULL::bigint, p.last_detected_at
        FROM public.accounting_pending_events AS p
        WHERE p.resolved_at IS NULL
          AND p.source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND ((p.source_table = 'order_refunds'
              AND p.event_kind IN ('pre_shipment_refund', 'return_refund', 'refund_failed', 'refund_abandoned'))
            OR (p.source_table = 'accounting_refund_events' AND p.event_kind = 'refund_abandoned'))
        ORDER BY p.last_detected_at, p.id
        LIMIT 10)
    ) AS j
    ORDER BY j.lane, j.seq, j.at, j.pending_id
  LOOP
    v_kind := NULL;
    v_table := 'order_refunds';
    v_source := v_job.refund_id::text;
    v_reason := NULL;
    v_detail := '{}'::jsonb;
    v_date := NULL;
    v_period := NULL;
    v_first := NULL;
    v_made := 0;
    v_rev := 0;
    v_closed := 0;
    v_mark := false;
    v_refund := NULL;
    BEGIN
      -- A parked row closed earlier in this call (a decision closes its undecided row) is not looked at again.
      CONTINUE WHEN v_job.lane = 1 AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
        WHERE p.id = v_job.pending_id AND p.resolved_at IS NULL);
      SELECT r.* INTO v_refund FROM public.order_refunds AS r WHERE r.id = v_job.refund_id;
      SELECT f.* INTO v_fact FROM public.accounting_refund_facts AS f WHERE f.refund_id = v_job.refund_id;
      CONTINUE WHEN v_refund.id IS NULL OR v_fact.refund_id IS NULL;
      IF v_job.step = 'success' THEN
        SELECT x.* INTO v_row FROM public.accounting_refund_events AS x WHERE x.refund_id = v_refund.id AND x.state = 'succeeded';
      ELSIF v_job.step = 'failure' THEN
        SELECT x.* INTO v_row FROM public.accounting_refund_events AS x WHERE x.refund_id = v_refund.id AND x.state IN ('failed', 'owed')
        ORDER BY (x.state = 'failed') DESC, x.fact_seq LIMIT 1;
      ELSIF v_job.step = 'undecided' THEN
        SELECT x.* INTO v_row FROM public.accounting_refund_events AS x WHERE x.id = v_job.row_id;
      ELSE
        SELECT x.* INTO v_row FROM public.accounting_refund_events AS x WHERE x.refund_id = v_refund.id AND x.state = 'abandoned';
      END IF;
      CONTINUE WHEN v_row.id IS NULL;
-- ACC_P3_REPLACE_BEGIN d10c81ee5666749e8cad229bbdfe04b4
      -- Ruling P3-F1: a return that sends nothing back (not_required) has no arrival entry, so its refund is not plain: the
      -- refund day books 4020 / 1160, and a failure debt goes to refund_owed_post.
      v_plain := v_fact.source = 'return' AND v_fact.event_kind NOT IN ('holdback_release', 'pre_shipment_cancel')
        AND NOT EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = v_fact.return_id AND rt.return_method = 'not_required');
-- ACC_P3_REPLACE_END
      SELECT s.* INTO v_sr FROM public.stripe_refunds AS s WHERE s.id = v_refund.stripe_refund_id;
      -- Taken: the Stripe refund has its balance transaction, or a success was recorded before (its transaction may come
      -- later; the failure and the cancel then wait for it instead of booking a debt that was never taken).
      v_pulled := v_sr.balance_transaction_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = v_refund.id AND x.state = 'succeeded');
      -- Taken and given back without a succeeded row (Stripe moved the refund pending -> failed or canceled, or the sync saw
      -- only the end): the cash nets to 0 and no success will come, so the failure and the abandon are booked as not taken,
      -- on the day of the failure transaction (P3-T6f).
      v_back := v_pulled AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
        WHERE x.refund_id = v_refund.id AND x.state = 'succeeded');
      IF v_back AND v_job.step IN ('failure', 'abandon') THEN
        SELECT t.* INTO v_bt FROM public.stripe_balance_transactions AS t WHERE t.id = v_sr.failure_balance_transaction_id;
      END IF;
      IF v_job.step = 'success' THEN
        v_d := private.accounting_refund_first_adjust(v_refund.id, v_row.fact_seq);
        v_kind := COALESCE(v_job.pending_kind,
          CASE WHEN v_fact.pre_shipment_amount > 0 OR v_d <> 0 THEN 'pre_shipment_refund' ELSE 'return_refund' END);
      ELSIF v_job.step = 'failure' THEN
        v_kind := 'refund_failed';
      ELSE
        v_kind := 'refund_abandoned';
        IF v_job.step = 'undecided' THEN
          v_table := 'accounting_refund_events';
          v_source := v_row.id::text;
        END IF;
      END IF;
      IF v_job.step IN ('failure', 'abandon') THEN
        -- A decision (owed / abandoned) closes the undecided row of the cancel.
        UPDATE public.accounting_pending_events AS p SET resolved_at = pg_catalog.now(), resolved_entry_id = NULL
        WHERE p.event_kind = 'refund_abandoned' AND p.source_table = 'accounting_refund_events' AND p.resolved_at IS NULL
          AND p.source_id IN (SELECT x.id::text FROM public.accounting_refund_events AS x
            WHERE x.refund_id = v_refund.id AND x.state = 'canceled');
        GET DIAGNOSTICS v_closed = ROW_COUNT;
      END IF;

      IF v_job.step = 'success' THEN
        SELECT t.* INTO v_bt FROM public.stripe_balance_transactions AS t WHERE t.id = v_sr.balance_transaction_id;
        CONTINUE WHEN v_bt.id IS NULL;
        v_date := private.accounting_jst_date(v_bt.stripe_created_at);
        v_at := LEAST(v_bt.synced_at, pg_catalog.clock_timestamp());
        IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
          v_reason := 'before_cutover';
        ELSE
          v_period := private.accounting_period_for_event(v_date);
          IF pg_catalog.abs(v_bt.amount) <> v_refund.amount THEN
            v_reason := 'amount_mismatch';
            v_detail := pg_catalog.jsonb_build_object('mismatch', 'refund_amount');
          ELSIF v_fact.pre_shipment_amount + v_fact.post_shipment_amount + v_fact.shipping_amount <> v_refund.amount THEN
            v_reason := 'amount_mismatch';
            v_detail := pg_catalog.jsonb_build_object('mismatch', 'split');
          ELSIF v_fact.shipping_amount <> 0 THEN
            v_reason := 'order_not_postable';
            v_detail := pg_catalog.jsonb_build_object('reason', 'shipping');
          ELSE
            v_why := private.accounting_refund_wait(v_refund.id, 'success');
            IF v_why IS NOT NULL THEN
              v_reason := 'refund_prior_unposted';
              v_detail := pg_catalog.jsonb_build_object('why', v_why);
            ELSIF v_fact.pre_shipment_amount + v_d > 0 AND v_fact.pre_shipment_amount + v_d
                > private.accounting_order_account_balance(v_refund.order_id, '2150', NULL) THEN
              v_reason := 'deferred_revenue_short';
              v_detail := pg_catalog.jsonb_build_object('shortage', v_fact.pre_shipment_amount + v_d
                - private.accounting_order_account_balance(v_refund.order_id, '2150', NULL));
            ELSE
              v_lines := private.accounting_refund_lines('success_pre', v_refund.order_id, v_fact.pre_shipment_amount, 0, v_d, 0, v_plain);
              IF pg_catalog.jsonb_array_length(v_lines) > 0 THEN
                v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'pre_shipment_refund', ARRAY[v_bt.id],
                  U&'\51FA\8377\524D\306E\8FD4\91D1', v_lines, _source_table => 'order_refunds', _source_id => v_refund.id::text,
                  _source_recorded_at => v_at);
                v_first := COALESCE(v_first, (v_result ->> 'entry_id')::uuid);
                IF (v_result ->> 'created')::boolean THEN v_made := v_made + 1; END IF;
              END IF;
              v_lines := private.accounting_refund_lines('success_post', v_refund.order_id, 0, v_fact.post_shipment_amount, 0,
                v_fact.fee_amount, v_plain);
              IF pg_catalog.jsonb_array_length(v_lines) > 0 THEN
                v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'return_refund', ARRAY[v_bt.id],
                  CASE WHEN v_plain THEN U&'\8FD4\54C1\306E\8FD4\91D1' ELSE U&'\51FA\8377\5F8C\306E\8FD4\91D1\30FB\5024\5F15\304D' END,
                  v_lines, _source_table => 'order_refunds', _source_id => v_refund.id::text, _source_recorded_at => v_at);
                v_first := COALESCE(v_first, (v_result ->> 'entry_id')::uuid);
                IF (v_result ->> 'created')::boolean THEN v_made := v_made + 1; END IF;
              END IF;
              IF v_first IS NULL THEN
                v_reason := 'no_revenue';
              END IF;
            END IF;
          END IF;
        END IF;

      ELSIF v_job.step = 'failure' AND v_back AND v_bt.id IS NULL THEN
        v_reason := 'refund_prior_unposted';
        v_detail := pg_catalog.jsonb_build_object('why', 'failure_txn_missing');

      ELSIF v_job.step = 'failure' AND (NOT v_pulled OR v_back) THEN
        IF v_back THEN
          v_date := private.accounting_jst_date(v_bt.stripe_created_at);
          v_at := LEAST(v_bt.synced_at, pg_catalog.clock_timestamp());
        ELSE
          v_date := private.accounting_jst_date(v_row.occurred_at);
          v_at := LEAST(v_row.occurred_at, pg_catalog.clock_timestamp());
        END IF;
        IF v_plain THEN
          -- The arrival entry's payable stays; nothing was taken.
          v_reason := 'no_revenue';
        ELSIF v_cutover IS NOT NULL AND v_date < v_cutover THEN
          v_reason := 'before_cutover';
        ELSE
          v_period := private.accounting_period_for_event(v_date);
          IF v_fact.shipping_amount <> 0 THEN
            v_reason := 'order_not_postable';
            v_detail := pg_catalog.jsonb_build_object('reason', 'shipping');
          ELSE
            v_d := private.accounting_refund_first_adjust(v_refund.id, v_row.fact_seq);
            v_lines := private.accounting_refund_lines('owed_unpulled', v_refund.order_id, v_fact.pre_shipment_amount,
              v_fact.post_shipment_amount, v_d, 0, v_plain);
            IF pg_catalog.jsonb_array_length(v_lines) = 0 THEN
              v_reason := 'no_revenue';
            ELSE
              v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'refund_failed',
                ARRAY[v_refund.id::text, v_row.id::text], U&'\8FD4\91D1\306E\672A\6255\3044', v_lines,
                _source_table => 'order_refunds', _source_id => v_refund.id::text, _source_recorded_at => v_at);
              v_first := (v_result ->> 'entry_id')::uuid;
              IF (v_result ->> 'created')::boolean THEN v_made := v_made + 1; END IF;
            END IF;
          END IF;
        END IF;

      ELSIF v_job.step = 'failure' THEN
        SELECT t.* INTO v_bt FROM public.stripe_balance_transactions AS t WHERE t.id = v_sr.failure_balance_transaction_id;
        IF v_bt.id IS NULL THEN
          v_reason := 'refund_prior_unposted';
          v_detail := pg_catalog.jsonb_build_object('why', 'failure_txn_missing');
        ELSE
          v_date := private.accounting_jst_date(v_bt.stripe_created_at);
          v_at := LEAST(v_bt.synced_at, pg_catalog.clock_timestamp());
          IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
            v_reason := 'before_cutover';
          ELSE
            v_period := private.accounting_period_for_event(v_date);
            v_why := private.accounting_refund_wait(v_refund.id, 'failure');
            IF pg_catalog.abs(v_bt.amount) <> v_refund.amount THEN
              v_reason := 'amount_mismatch';
              v_detail := pg_catalog.jsonb_build_object('mismatch', 'refund_amount');
            ELSIF v_fact.shipping_amount <> 0 THEN
              v_reason := 'order_not_postable';
              v_detail := pg_catalog.jsonb_build_object('reason', 'shipping');
            ELSIF v_why IS NOT NULL THEN
              v_reason := 'refund_prior_unposted';
              v_detail := pg_catalog.jsonb_build_object('why', v_why);
            ELSE
              v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'refund_failed',
                ARRAY[v_refund.id::text, v_row.id::text], U&'\8FD4\91D1\306E\672A\6255\3044',
                private.accounting_refund_lines('owed_pulled', v_refund.order_id, v_fact.pre_shipment_amount,
                  v_fact.post_shipment_amount, 0, 0, v_plain),
                _source_table => 'order_refunds', _source_id => v_refund.id::text, _source_recorded_at => v_at);
              v_first := (v_result ->> 'entry_id')::uuid;
              IF (v_result ->> 'created')::boolean THEN v_made := v_made + 1; END IF;
            END IF;
          END IF;
        END IF;

      ELSIF v_job.step = 'undecided' THEN
        IF EXISTS (SELECT 1 FROM public.accounting_refund_events AS x
            WHERE x.refund_id = v_refund.id AND x.state IN ('abandoned', 'owed')) THEN
          v_reason := 'decided';
        ELSE
          v_reason := 'refund_cancel_undecided';
          v_detail := pg_catalog.jsonb_build_object('refund_id', v_refund.id::text,
            'canceled_on', pg_catalog.to_char(private.accounting_jst_date(v_row.occurred_at), 'YYYY-MM-DD'));
        END IF;

      ELSE
        -- abandon: s and the carried d were counted by the decision; the poster never counts them again.
        v_s := COALESCE(v_row.release_shortfall, 0);
        v_d := COALESCE(v_row.carried_adjust, 0);
        v_at := LEAST(v_row.occurred_at, pg_catalog.clock_timestamp());
        IF v_back AND v_bt.id IS NULL THEN
          v_reason := 'refund_prior_unposted';
          v_detail := pg_catalog.jsonb_build_object('why', 'failure_txn_missing');
        ELSIF v_pulled AND NOT v_back THEN
          SELECT t.* INTO v_bt FROM public.stripe_balance_transactions AS t WHERE t.id = v_sr.failure_balance_transaction_id;
          IF v_bt.id IS NULL THEN
            v_reason := 'refund_prior_unposted';
            v_detail := pg_catalog.jsonb_build_object('why', 'failure_txn_missing');
          ELSE
            v_date := private.accounting_jst_date(v_bt.stripe_created_at);
            IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
              v_reason := 'before_cutover';
            ELSE
              v_period := private.accounting_period_for_event(v_date);
              v_why := private.accounting_refund_wait(v_refund.id, 'abandon');
              IF v_fact.shipping_amount <> 0 THEN
                v_reason := 'order_not_postable';
                v_detail := pg_catalog.jsonb_build_object('reason', 'shipping');
              ELSIF v_why IS NOT NULL THEN
                v_reason := 'refund_prior_unposted';
                v_detail := pg_catalog.jsonb_build_object('why', v_why);
              ELSE
                -- The success entries are reversed on the day of the failure transaction, never on their own day.
                FOR v_entry IN
                  SELECT e.id FROM public.accounting_journal_entries AS e
                  WHERE e.event_kind IN ('pre_shipment_refund', 'return_refund') AND e.source_table = 'order_refunds'
                    AND e.source_id = v_refund.id::text
                    AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
                  ORDER BY e.entry_no
                LOOP
                  v_result := private.accounting_reverse_journal_core(NULL, v_entry.id, U&'\8FD4\91D1\306E\53D6\308A\6D88\3057',
                    v_date, v_at);
                  v_first := COALESCE(v_first, (v_result ->> 'entry_id')::uuid);
                  IF (v_result ->> 'created')::boolean THEN
                    v_made := v_made + 1;
                    v_rev := v_rev + 1;
                  END IF;
                END LOOP;
              END IF;
            END IF;
          END IF;
        ELSE
          v_date := private.accounting_jst_date(CASE WHEN v_back THEN v_bt.stripe_created_at ELSE v_row.occurred_at END);
          IF v_s = 0 AND v_d = 0 THEN
            v_reason := 'no_revenue';
          ELSIF v_cutover IS NOT NULL AND v_date < v_cutover THEN
            v_reason := 'before_cutover';
          ELSE
            v_period := private.accounting_period_for_event(v_date);
          END IF;
        END IF;
        IF v_reason IS NULL AND (v_s <> 0 OR v_d <> 0) THEN
          v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'refund_abandoned',
            ARRAY[v_refund.id::text, v_row.id::text], U&'\8FD4\91D1\306E\53D6\308A\6D88\3057',
            private.accounting_refund_lines('abandon', v_refund.order_id, v_s, 0, v_d, 0, v_plain),
            _source_table => 'order_refunds', _source_id => v_refund.id::text, _source_recorded_at => v_at);
          v_first := (v_result ->> 'entry_id')::uuid;
          IF (v_result ->> 'created')::boolean THEN v_made := v_made + 1; END IF;
        ELSIF v_reason IS NULL AND v_first IS NULL THEN
          v_reason := 'no_revenue';
        ELSIF v_reason IS NULL THEN
          -- Only reversals: a closed row keeps the refund out of the next runs.
          v_mark := true;
        END IF;
      END IF;

      IF v_reason = 'decided' THEN
        PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, NULL);
        v_resolved := v_resolved + 1;
      ELSIF v_reason = 'no_revenue' THEN
        -- Nothing to book: the row is closed at once and keeps the refund out of the next runs.
        PERFORM private.accounting_park_event(v_kind, v_table, v_source, v_refund.order_id, 'no_revenue', '{}'::jsonb);
        PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, NULL);
        IF v_job.lane = 0 THEN
          v_parked_new := v_parked_new + 1;
        END IF;
        v_resolved := v_resolved + 1;
      ELSIF v_reason IS NOT NULL THEN
        PERFORM private.accounting_park_event(v_kind, v_table, v_source, v_refund.order_id, v_reason, v_detail);
        IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      ELSE
        IF v_mark THEN
          PERFORM private.accounting_park_event(v_kind, v_table, v_source, v_refund.order_id, 'no_revenue', '{}'::jsonb);
          PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, v_first);
        ELSIF v_job.lane = 1 THEN
          PERFORM private.accounting_unpark_event(v_kind, v_table, v_source, v_first);
        END IF;
        IF v_job.lane = 1 THEN
          v_resolved := v_resolved + 1;
        END IF;
        v_posted := v_posted + v_made;
        v_reversed := v_reversed + v_rev;
      END IF;
      v_resolved := v_resolved + v_closed;
    EXCEPTION WHEN OTHERS THEN
      -- The rows and the entry numbers of this one event are undone with the block. Only the SQLSTATE and a fixed code
      -- are kept; the text of the exception is never stored.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure(COALESCE(v_kind, 'refund_failed'), v_table, v_source, v_refund.order_id,
        v_sqlstate, SQLERRM, v_pg_detail, v_date);
      IF v_parked THEN
        IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved, 'reversed', v_reversed);
END;
$$;

-- 3. The settle refuses a plain return refund, and the candidate read lists none for it (P3-F2).
CREATE OR REPLACE FUNCTION private.admin_settle_owed_by_refund(_actor_id uuid, _owed_refund_id uuid, _paying_refund_id uuid,
  _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior public.accounting_refund_settlements%ROWTYPE;
  v_owed public.order_refunds%ROWTYPE;
  v_paying public.order_refunds%ROWTYPE;
  v_owed_fact public.accounting_refund_facts%ROWTYPE;
  v_pay_fact public.accounting_refund_facts%ROWTYPE;
  v_bt public.stripe_balance_transactions%ROWTYPE;
  v_cutover date;
  v_date date;
  v_period uuid;
  v_pre bigint;
  v_post bigint;
  v_row uuid;
  v_id uuid := pg_catalog.gen_random_uuid();
  v_entry jsonb;
BEGIN
  IF NOT COALESCE(private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.entries.correct']), false) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _owed_refund_id IS NULL OR _paying_refund_id IS NULL OR _request_key IS NULL OR _owed_refund_id = _paying_refund_id THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'settle_owed_by_refund', 'actor', _actor_id,
    'owed_refund_id', _owed_refund_id, 'paying_refund_id', _paying_refund_id));
  SELECT s.* INTO v_prior FROM public.accounting_refund_settlements AS s WHERE s.request_key = _request_key;
  IF FOUND AND v_prior.request_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  IF NOT FOUND THEN
    SELECT s.* INTO v_prior FROM public.accounting_refund_settlements AS s WHERE s.paying_refund_id = _paying_refund_id;
    IF FOUND AND v_prior.owed_refund_id <> _owed_refund_id THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_prior.id IS NOT NULL THEN
    SELECT pg_catalog.jsonb_build_object('entry_id', e.id, 'entry_no', e.entry_no) INTO v_entry
    FROM public.accounting_journal_entries AS e
    WHERE e.source_table = 'accounting_refund_settlements' AND e.source_id = v_prior.id::text AND e.event_kind = 'refund_abandoned';
    RETURN pg_catalog.jsonb_build_object('settlement_id', v_prior.id, 'owed_refund_id', v_prior.owed_refund_id,
      'paying_refund_id', v_prior.paying_refund_id, 'pre_amount', v_prior.pre_amount, 'post_amount', v_prior.post_amount,
      'entry_id', v_entry -> 'entry_id', 'entry_no', v_entry -> 'entry_no', 'replayed', true);
  END IF;
  SELECT r.* INTO v_owed FROM public.order_refunds AS r WHERE r.id = _owed_refund_id;
  SELECT r.* INTO v_paying FROM public.order_refunds AS r WHERE r.id = _paying_refund_id;
  IF v_owed.id IS NULL OR v_paying.id IS NULL OR v_owed.order_id <> v_paying.order_id THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  -- A refund of a pre-shipment cancel event cannot be settled (ruling P3-B6): its debt is paid by bank transfer.
  IF EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er JOIN public.order_unit_events AS e ON e.id = er.event_id
      WHERE er.refund_id = _owed_refund_id AND e.kind = 'pre_shipment_cancel') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT f.* INTO v_owed_fact FROM public.accounting_refund_facts AS f WHERE f.refund_id = _owed_refund_id;
  SELECT f.* INTO v_pay_fact FROM public.accounting_refund_facts AS f WHERE f.refund_id = _paying_refund_id;
-- ACC_P3_BEGIN
  -- Ruling P3-F2: a plain return refund (the arrival entry holds its debt in 2130 return_refund; a bank transfer pays it) is
  -- never settled: the settle debits refund_owed_post, which belongs to other refunds of the order.
  IF v_owed_fact.refund_id IS NOT NULL AND v_owed_fact.source = 'return'
    AND v_owed_fact.event_kind NOT IN ('holdback_release', 'pre_shipment_cancel')
    AND NOT EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = v_owed_fact.return_id AND rt.return_method = 'not_required') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023', DETAIL = 'settle_plain_return';
  END IF;
-- ACC_P3_END
  SELECT t.* INTO v_bt FROM public.stripe_refunds AS sr
  JOIN public.stripe_balance_transactions AS t ON t.id = sr.balance_transaction_id
  WHERE sr.id = v_paying.stripe_refund_id;
  IF v_owed_fact.refund_id IS NULL OR v_pay_fact.refund_id IS NULL OR v_bt.id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
      WHERE e.event_kind = 'refund_failed' AND e.source_table = 'order_refunds' AND e.source_id = _owed_refund_id::text)
    OR NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = _paying_refund_id AND x.state = 'succeeded') THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  SELECT GREATEST(LEAST(v_owed_fact.pre_shipment_amount - COALESCE(pg_catalog.sum(s.pre_amount), 0), v_pay_fact.pre_shipment_amount), 0),
    GREATEST(LEAST(v_owed_fact.post_shipment_amount - COALESCE(pg_catalog.sum(s.post_amount), 0), v_pay_fact.post_shipment_amount), 0)
  INTO v_pre, v_post FROM public.accounting_refund_settlements AS s WHERE s.owed_refund_id = _owed_refund_id;
  IF v_pre + v_post = 0
    OR v_pre > private.accounting_order_account_balance(v_owed.order_id, '2130', 'refund_owed_pre')
    OR v_post > private.accounting_order_account_balance(v_owed.order_id, '2130', 'refund_owed_post') THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  v_date := private.accounting_jst_date(v_bt.stripe_created_at);
  v_cutover := private.accounting_cutover_on();
  IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_period := private.accounting_period_for_event(v_date, _actor_id);
  v_row := private.accounting_record_refund_event(_paying_refund_id, 'settled', NULL, _actor_id);
  v_entry := private.accounting_post_journal_core(_actor_id, v_period, v_date, 'refund_abandoned',
    ARRAY[_paying_refund_id::text, v_row::text], U&'\8FD4\91D1\306E\672A\6255\3044',
    private.accounting_refund_lines('settle', v_owed.order_id, v_pre, v_post, 0, 0, false),
    _source_table => 'accounting_refund_settlements', _source_id => v_id::text);
  INSERT INTO public.accounting_refund_settlements (id, owed_refund_id, paying_refund_id, pre_amount, post_amount, actor_id,
    request_key, request_hash)
  VALUES (v_id, _owed_refund_id, _paying_refund_id, v_pre, v_post, _actor_id, _request_key, v_hash);
  RETURN pg_catalog.jsonb_build_object('settlement_id', v_id, 'owed_refund_id', _owed_refund_id,
    'paying_refund_id', _paying_refund_id, 'pre_amount', v_pre, 'post_amount', v_post,
    'entry_id', v_entry -> 'entry_id', 'entry_no', v_entry -> 'entry_no', 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION private.list_refund_settle_candidates(_owed_refund_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owed public.order_refunds%ROWTYPE;
  v_owed_fact public.accounting_refund_facts%ROWTYPE;
  v_cutover date;
  v_bal_pre bigint;
  v_bal_post bigint;
  v_rows jsonb;
BEGIN
  IF _owed_refund_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT r.* INTO v_owed FROM public.order_refunds AS r WHERE r.id = _owed_refund_id;
  SELECT f.* INTO v_owed_fact FROM public.accounting_refund_facts AS f WHERE f.refund_id = _owed_refund_id;
  -- The owed side: a refund of a pre-shipment cancel event is paid by bank transfer, never settled (P3-B6); the owed refund
  -- needs its facts row and the entry of its failure.
  IF v_owed.id IS NULL OR v_owed_fact.refund_id IS NULL
    OR EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er JOIN public.order_unit_events AS e ON e.id = er.event_id
      WHERE er.refund_id = _owed_refund_id AND e.kind = 'pre_shipment_cancel')
    OR NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
      WHERE e.event_kind = 'refund_failed' AND e.source_table = 'order_refunds' AND e.source_id = _owed_refund_id::text) THEN
    RETURN pg_catalog.jsonb_build_object('candidates', '[]'::jsonb);
  END IF;
-- ACC_P3_BEGIN
  -- Ruling P3-F2: the settle refuses a plain return refund (a bank transfer pays it), so there are no candidates for it.
  IF v_owed_fact.source = 'return' AND v_owed_fact.event_kind NOT IN ('holdback_release', 'pre_shipment_cancel')
    AND NOT EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = v_owed_fact.return_id AND rt.return_method = 'not_required') THEN
    RETURN pg_catalog.jsonb_build_object('candidates', '[]'::jsonb);
  END IF;
-- ACC_P3_END
  v_cutover := private.accounting_cutover_on();
  v_bal_pre := private.accounting_order_account_balance(v_owed.order_id, '2130', 'refund_owed_pre');
  v_bal_post := private.accounting_order_account_balance(v_owed.order_id, '2130', 'refund_owed_post');
  WITH settled AS (
    SELECT COALESCE(pg_catalog.sum(s.pre_amount), 0) AS pre, COALESCE(pg_catalog.sum(s.post_amount), 0) AS post
    FROM public.accounting_refund_settlements AS s WHERE s.owed_refund_id = _owed_refund_id
  ), c AS (
    SELECT p.id, p.amount, pf.event_id, pf.event_kind,
      (v_owed_fact.event_id IS NOT NULL AND pf.event_id IS NOT NULL AND pf.event_id = v_owed_fact.event_id) AS same_event,
      private.accounting_jst_date(t.stripe_created_at) AS succeeded_on,
      GREATEST(LEAST(v_owed_fact.pre_shipment_amount - st.pre, pf.pre_shipment_amount), 0) AS pre,
      GREATEST(LEAST(v_owed_fact.post_shipment_amount - st.post, pf.post_shipment_amount), 0) AS post
    FROM public.order_refunds AS p
    JOIN public.accounting_refund_facts AS pf ON pf.refund_id = p.id
    JOIN public.accounting_refund_events AS se ON se.refund_id = p.id AND se.state = 'succeeded'
    JOIN public.stripe_refunds AS sr ON sr.id = p.stripe_refund_id
    JOIN public.stripe_balance_transactions AS t ON t.id = sr.balance_transaction_id
    CROSS JOIN settled AS st
    WHERE p.order_id = v_owed.order_id AND p.id <> _owed_refund_id
      AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_settlements AS s2 WHERE s2.paying_refund_id = p.id)
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('refund_id', c.id, 'amount', c.amount,
      'succeeded_on', pg_catalog.to_char(c.succeeded_on, 'YYYY-MM-DD'), 'event_id', c.event_id, 'event_kind', c.event_kind,
      'same_event', c.same_event) ORDER BY c.same_event DESC, c.succeeded_on, c.id), '[]'::jsonb)
  INTO v_rows FROM c
  WHERE c.pre + c.post > 0 AND c.pre <= v_bal_pre AND c.post <= v_bal_post
    AND (v_cutover IS NULL OR c.succeeded_on >= v_cutover);
  RETURN pg_catalog.jsonb_build_object('candidates', v_rows);
END;
$$;

-- 4. The debt read keeps owed_return 0 for a not_required return (P3-F1).
CREATE OR REPLACE FUNCTION private.list_refund_accounting_states(_limit integer DEFAULT 50, _after_at timestamptz DEFAULT NULL,
  _after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rows jsonb;
  v_last_at timestamptz;
  v_last_id uuid;
  v_count integer;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 100 OR (_after_at IS NULL) <> (_after_id IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  WITH s AS (
    SELECT r.id, r.order_id, r.source, r.created_at, f.pre_shipment_amount, f.post_shipment_amount,
-- ACC_P3_BEGIN
      f.event_id, f.event_kind,
      -- owed_return (P3-T11f): a plain return refund (source return, not a hold-back release or a pre-shipment cancel) whose
      -- last state is owed or failed owes what admin_record_refund_bank_transfer takes for origin return: the 2130
      -- return_refund balance of the order (its check is balance < amount), less the return-origin refunds of the order
      -- still in flight at Stripe, and at most the refund's own post-shipment amount; never below 0 (P3-T11i). A return that
      -- sends nothing back (not_required) has no arrival entry: its debt is refund_owed_post, never owed_return (P3-F1).
      CASE WHEN f.source = 'return' AND f.event_kind NOT IN ('holdback_release', 'pre_shipment_cancel')
          AND NOT EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = f.return_id AND rt.return_method = 'not_required')
          AND (SELECT x.state FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id ORDER BY x.seq DESC LIMIT 1)
            IN ('owed', 'failed')
        THEN GREATEST(LEAST(private.accounting_order_account_balance(r.order_id, '2130', 'return_refund'),
          private.accounting_order_account_balance(r.order_id, '2130', 'return_refund')
            - (SELECT COALESCE(pg_catalog.sum(x2.amount), 0) FROM public.order_refunds AS x2
              WHERE x2.order_id = r.order_id AND x2.source = 'return' AND x2.status IN ('awaiting_response', 'pending')),
          f.post_shipment_amount), 0)
        ELSE 0 END AS owed_return,
-- ACC_P3_END
      (SELECT x.occurred_at FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state = 'canceled') AS canceled_at,
      EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state = 'canceled')
        AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id AND x.state IN ('abandoned', 'owed'))
        AS undecided,
      (SELECT x.state FROM public.accounting_refund_events AS x WHERE x.refund_id = r.id ORDER BY x.seq DESC LIMIT 1) AS state,
      GREATEST(LEAST(
        COALESCE((SELECT pg_catalog.sum(l.credit - l.debit) FROM public.accounting_journal_entries AS e
          JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id
          WHERE e.event_kind = 'refund_failed' AND e.source_table = 'order_refunds' AND e.source_id = r.id::text
            AND l.account_code = '2130' AND l.sub_account = 'refund_owed_pre'), 0)
        - COALESCE((SELECT pg_catalog.sum(t.pre_amount) FROM public.accounting_refund_settlements AS t WHERE t.owed_refund_id = r.id), 0),
        private.accounting_order_account_balance(r.order_id, '2130', 'refund_owed_pre')), 0) AS owed_pre,
      GREATEST(LEAST(
        COALESCE((SELECT pg_catalog.sum(l.credit - l.debit) FROM public.accounting_journal_entries AS e
          JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id
          WHERE e.event_kind = 'refund_failed' AND e.source_table = 'order_refunds' AND e.source_id = r.id::text
            AND l.account_code = '2130' AND l.sub_account = 'refund_owed_post'), 0)
        - COALESCE((SELECT pg_catalog.sum(t.post_amount) FROM public.accounting_refund_settlements AS t WHERE t.owed_refund_id = r.id), 0),
        private.accounting_order_account_balance(r.order_id, '2130', 'refund_owed_post')), 0) AS owed_post
    FROM public.order_refunds AS r
    JOIN public.accounting_refund_facts AS f ON f.refund_id = r.id
    WHERE _after_at IS NULL OR (r.created_at, r.id) < (_after_at, _after_id)
  ), q AS (
-- ACC_P3_REPLACE_BEGIN ca1a3021e675a63708ad29a6414346a3
    SELECT s.* FROM s WHERE s.undecided OR s.owed_pre > 0 OR s.owed_post > 0 OR s.owed_return > 0
-- ACC_P3_REPLACE_END
    ORDER BY s.created_at DESC, s.id DESC LIMIT _limit
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('refund_id', q.id, 'order_id', q.order_id,
      'order_number', 'ORD-' || pg_catalog.upper(pg_catalog.left(q.order_id::text, 8)), 'source', q.source,
      'state', CASE WHEN q.undecided THEN 'canceled' ELSE q.state END, 'pre_amount', q.pre_shipment_amount,
-- ACC_P3_REPLACE_BEGIN 32ef77284162680fade869fa15bcf036
      'post_amount', q.post_shipment_amount, 'owed_pre', q.owed_pre, 'owed_post', q.owed_post, 'canceled_at', q.canceled_at,
      'event_id', q.event_id, 'event_kind', q.event_kind, 'owed_return', q.owed_return)
-- ACC_P3_REPLACE_END
      ORDER BY q.created_at DESC, q.id DESC), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(q.created_at ORDER BY q.created_at, q.id))[1],
    (pg_catalog.array_agg(q.id ORDER BY q.created_at, q.id))[1]
  INTO v_rows, v_count, v_last_at, v_last_id FROM q;
  IF v_count < _limit THEN
    v_last_at := NULL;
    v_last_id := NULL;
  END IF;
  RETURN pg_catalog.jsonb_build_object('refunds', v_rows, 'next_after_at', v_last_at, 'next_after_id', v_last_id);
END;
$$;

-- 5. A negative 2130 return_refund balance is an anomaly (P3-F3).
CREATE OR REPLACE FUNCTION private.list_deferred_revenue_anomalies() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rows jsonb;
BEGIN
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('order_id', f.order_id,
      'order_number', 'ORD-' || pg_catalog.upper(pg_catalog.left(f.order_id::text, 8)), 'balance', f.balance, 'reason', f.reason)
      ORDER BY f.order_id), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT b.order_id, b.balance,
      CASE
        WHEN b.balance < 0 THEN 'negative_balance'
        WHEN EXISTS (SELECT 1 FROM private.accounting_unit_values(b.order_id, NULL::bigint) AS v)
          AND NOT EXISTS (SELECT 1 FROM private.accounting_unit_values(b.order_id, NULL::bigint) AS v WHERE NOT v.shipped AND v.value > 0)
          THEN 'balance_after_all_shipped_or_refunded'
      END AS reason
    FROM private.accounting_order_balances('infinity'::date) AS b
    WHERE b.balance <> 0
-- ACC_P3_BEGIN
    -- Plan 3 Task 9: two return reasons, one row per order and reason (an order can also have a row of a reason above).
    -- return_refund_retried_during_error: a refund of the return was still in error (its latest state row before the
    -- other refund's requested row, by fact_seq) when another refund of the same return was requested.
    -- return_waived_with_failed_refund: the return has a 0 yen close and the payable of the Task 4 formula (arrival G - F,
    -- plus every decision's payable_delta, less the decided amount of the refunds that did not end failed or abandoned) is
    -- above 0. Only the return facts and the refund state rows are read.
    UNION ALL
    SELECT x.order_id, COALESCE(ob.balance, 0), x.reason
    FROM (
      SELECT DISTINCT a.order_id, 'return_refund_retried_during_error' AS reason
      FROM public.accounting_return_facts AS a
      JOIN public.accounting_refund_events AS ae ON ae.refund_id = a.refund_id AND ae.state = 'error'
      JOIN public.accounting_return_facts AS c ON c.return_id = a.return_id AND c.kind = 'decision'
        AND c.refund_id IS NOT NULL AND c.refund_id <> a.refund_id
      JOIN public.accounting_refund_events AS cr ON cr.refund_id = c.refund_id AND cr.state = 'requested'
        AND cr.fact_seq > ae.fact_seq
      WHERE a.kind = 'decision' AND a.refund_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS ax
          WHERE ax.refund_id = a.refund_id AND ax.fact_seq > ae.fact_seq AND ax.fact_seq < cr.fact_seq)
      UNION ALL
      SELECT w.order_id, 'return_waived_with_failed_refund'
      FROM (
        SELECT pg_catalog.min(rf.order_id::text)::uuid AS order_id,
          pg_catalog.bool_or(rf.kind = 'decision' AND rf.refund_id IS NULL) AS waived,
          COALESCE(pg_catalog.sum(rf.goods_amount - rf.fee_amount) FILTER (WHERE rf.kind = 'arrival'), 0)
            + COALESCE(pg_catalog.sum(rf.payable_delta) FILTER (WHERE rf.kind = 'decision'), 0)
            - COALESCE(pg_catalog.sum(rf.decided_amount) FILTER (WHERE rf.kind = 'decision' AND rf.refund_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS fx
                WHERE fx.refund_id = rf.refund_id AND fx.state IN ('failed', 'abandoned'))), 0) AS payable_left
        FROM public.accounting_return_facts AS rf
        GROUP BY rf.return_id
      ) AS w
      WHERE w.waived AND w.payable_left > 0
      -- Ruling P3-F3: an order whose 2130 return_refund balance is below 0 was paid twice (a retry that went on after a
      -- bank transfer, P3-T11k); no other read shows it.
      UNION ALL
      SELECT n.order_id, 'return_refund_negative_balance'
      FROM (
        SELECT l.order_id FROM public.accounting_journal_lines AS l
        WHERE l.account_code = '2130' AND l.sub_account = 'return_refund' AND l.order_id IS NOT NULL
        GROUP BY l.order_id HAVING pg_catalog.sum(l.credit - l.debit) < 0
      ) AS n
    ) AS x
    LEFT JOIN private.accounting_order_balances('infinity'::date) AS ob ON ob.order_id = x.order_id
-- ACC_P3_END
  ) AS f
  WHERE f.reason IS NOT NULL;
  RETURN pg_catalog.jsonb_build_object('anomalies', v_rows);
END;
$$;
-- ACC_S26_BODY_END

-- ACC_S26_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. acc_s26_function_attrs: every rebuilt function (private body and
-- public entry where there is one) keeps its arguments, result, language, volatility, security, owner, search_path and ACL.
-- acc_s26_body_unchanged: each rebuilt body has the counted replaced parts and added blocks and, with the replaced parts
-- restored (by the md5 on the marker) and every ACC_P<n> block and all white space removed, is the body it was copied from.
-- acc_s26_reads_stable: the three reads, private bodies and public entries, are STABLE, write nothing, take no row lock and
-- name no personal column. acc_s26_existing_dml_allowlist: this migration writes no row, and the group G writer list is what
-- it was.
DO $acc_s26_final$
DECLARE
  v_failed text;
  v_stage text;
  v_search_path text;
  v_baseline jsonb;
  v_src text;
  v_match text[];
  v_original text;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s26_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s26_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s26_baseline) <> 1 THEN
    v_failed := 'acc_s26_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s26_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s26_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s26_function_attrs';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'attrs')) <> 10
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'attrs') AS b(sig, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(b.sig)
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
        f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))) THEN
    v_failed := 'acc_s26_function_attrs';
  END IF;

  v_stage := 'acc_s26_body_unchanged';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_record_return_arrival(uuid,uuid,uuid,integer,integer)', 0, 1, '6e227bd116b1d57f4243510deeff4cdc', false,
        'return_method = ''not_required''|IF EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = _return_id'),
      ('private.accounting_record_return_decision(uuid,uuid,uuid,integer,uuid,integer,integer,integer)', 0, 1, '5ad994eaeb41f50fe1479f1afa59013b', false,
        'return_method = ''not_required''|IF EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = _return_id'),
      ('private.accounting_post_refund_events(integer)', 1, 0, '2f20a946fdcad5e1266f868d55ff4e37', false,
        'AND NOT EXISTS (SELECT 1 FROM public.order_returns AS rt WHERE rt.id = v_fact.return_id AND rt.return_method = ''not_required'')|v_plain := v_fact.source = ''return'' AND v_fact.event_kind NOT IN (''holdback_release'', ''pre_shipment_cancel'')'),
      ('private.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid)', 0, 1, 'ded09f6252f450fb9906d292971e1ac9', false,
        '''settle_plain_return''|rt.id = v_owed_fact.return_id AND rt.return_method = ''not_required''|v_owed_fact.event_kind NOT IN (''holdback_release'', ''pre_shipment_cancel'')'),
      ('private.list_refund_accounting_states(integer,timestamptz,uuid)', 2, 1, '28ec43c85c10e95fbf2644396a894f28', true,
        'f.event_id, f.event_kind,|AS owed_return|OR s.owed_return > 0|f.source = ''return'' AND f.event_kind NOT IN (''holdback_release'', ''pre_shipment_cancel'')|rt.id = f.return_id AND rt.return_method = ''not_required''|IN (''owed'', ''failed'')|f.post_shipment_amount), 0)'),
      ('private.list_refund_settle_candidates(uuid)', 0, 1, 'c9e93920ebeb0aa6e84bae16d060878f', true,
        'rt.id = v_owed_fact.return_id AND rt.return_method = ''not_required''|v_owed_fact.event_kind NOT IN (''holdback_release'', ''pre_shipment_cancel'')'),
      ('private.list_deferred_revenue_anomalies()', 0, 1, 'd891511d05127d0b0be979b7e3591c81', true,
        '''return_waived_with_failed_refund''|''return_refund_negative_balance''|l.account_code = ''2130'' AND l.sub_account = ''return_refund''')
    ) AS x(signature, replaced, added, digest, readonly, needle)
    LOOP
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF v_src IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(e.needle, '|')) AS n(part)
          WHERE pg_catalog.strpos(v_src, n.part) = 0)
        OR (e.readonly AND v_src ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M')
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_REPLACE_BEGIN', 'g')) <> e.replaced
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_BEGIN', 'g')) <> e.added THEN
        v_failed := 'acc_s26_body_unchanged';
        EXIT;
      END IF;
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('d10c81ee5666749e8cad229bbdfe04b4', $acc_s26_o1$      v_plain := v_fact.source = 'return' AND v_fact.event_kind NOT IN ('holdback_release', 'pre_shipment_cancel');
$acc_s26_o1$),
    ('ca1a3021e675a63708ad29a6414346a3', $acc_s26_o2$    SELECT s.* FROM s WHERE s.undecided OR s.owed_pre > 0 OR s.owed_post > 0
$acc_s26_o2$),
    ('32ef77284162680fade869fa15bcf036', $acc_s26_o3$      'post_amount', q.post_shipment_amount, 'owed_pre', q.owed_pre, 'owed_post', q.owed_post, 'canceled_at', q.canceled_at)
$acc_s26_o3$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s26_body_unchanged';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
        v_original := NULL;
      END LOOP;
      IF v_failed IS NULL AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM e.digest THEN
        v_failed := 'acc_s26_body_unchanged';
      END IF;
      EXIT WHEN v_failed IS NOT NULL;
    END LOOP;
  END IF;

  v_stage := 'acc_s26_reads_stable';
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid IN ('private.list_refund_accounting_states(integer,timestamptz,uuid)'::regprocedure,
        'public.list_refund_accounting_states(integer,timestamptz,uuid)'::regprocedure,
        'private.list_refund_settle_candidates(uuid)'::regprocedure, 'public.list_refund_settle_candidates(uuid)'::regprocedure,
        'private.list_deferred_revenue_anomalies()'::regprocedure)
        AND (f.provolatile <> 's'
          OR f.prosrc ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M'
          OR f.prosrc ~* '(raw_payload|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address|full_name|email)')) THEN
    v_failed := 'acc_s26_reads_stable';
  END IF;

  v_stage := 'acc_s26_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline #>> '{counts,entries}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline #>> '{counts,lines}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline #>> '{counts,pending_events}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_settlements) IS DISTINCT FROM (v_baseline #>> '{counts,settlements}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_return_facts) IS DISTINCT FROM (v_baseline #>> '{counts,return_facts}')::bigint
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc))
      IS DISTINCT FROM (v_baseline -> 'allowlist')) THEN
    v_failed := 'acc_s26_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s26_function_attrs'), HINT = SQLSTATE;
END;
$acc_s26_final$;
-- ACC_S26_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
