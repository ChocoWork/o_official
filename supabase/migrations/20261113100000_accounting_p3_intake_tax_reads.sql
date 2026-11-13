BEGIN;
-- Accounting plan 3 S23 (FREQ-582 AC-01..AC-08, FREQ-583 AC-01..AC-04, FREQ-578-AC-09): the intake, the two stage
-- reconciliation, the Stripe balance reconciliation and the deferred revenue anomalies count the refund and return entries of
-- plan 3, and a list of the refunds for the consumption tax return is added.
--
-- Rebuilt (CREATE OR REPLACE; the latest definition copied as it is, new text between ACC_P3_BEGIN and ACC_P3_END, the
-- replaced text between ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END; arguments, result, attributes,
-- owner and ACL are unchanged; the public entries are not touched):
--   private.accounting_intake_events (only definition: S12 20261108210000:123-172): pre_shipment_cancel is, for each entry of
--     kind pre_shipment_refund or refund_failed and their reversals, minus (2150 and 2130 refund_owed_pre debit - credit less
--     the entry's 4010 credit - debit); 0 is not listed. return_refund entries do not move the intake.
--   private.get_intake_breakdown (only definition: S12 :212-249): adds post_shipment_refund (1160 and 1040 debit - credit
--     of the return_refund entries); breakdown_ok is unchanged.
--   private.get_intake_reconciliation (only definition: S12 :267-370): the exception return_refund_2130 is the debit - credit
--     of 2130 refund_owed_pre in the window; the 2150 moves of refund_failed and refund_abandoned entries are explained by it
--     and the intake (not other); sales_before_return also takes the 4010 of pre_shipment_refund, refund_failed and
--     refund_abandoned entries.
--   private.list_deferred_revenue_anomalies (only definition: S12 :424-448): two return reasons,
--     return_refund_retried_during_error and return_waived_with_failed_refund.
--   private.get_stripe_balance_reconciliation (only definition: S9 20261108180000:1020-1109): a refund transaction is done
--     once the refund poster booked it.
-- New (STABLE, SECURITY DEFINER private bodies, INVOKER public entries, service_role only; the tool is owner only):
--   private.accounting_tax_refund_rows(_from date, _to date): the money lines of the refunds (+ when the money went out, -
--     when it came back) with the original sale day, the two period statuses and the exclusion.
--   private/public.list_consumption_tax_refunds(_from, _to, _limit, _after_date, _after_key) and
--   private/public.get_consumption_tax_refund_totals(_from, _to).
--
-- ROLLBACK (no row is written by this migration): re-run CREATE FUNCTION private.accounting_intake_events,
--   private.get_intake_breakdown, private.get_intake_reconciliation and private.list_deferred_revenue_anomalies from
--   20261108210000_accounting_p2_intake_reads.sql and private.get_stripe_balance_reconciliation from
--   20261108180000_accounting_p2_stripe_posting.sql as CREATE OR REPLACE; DROP FUNCTION
--   public.get_consumption_tax_refund_totals(date,date), public.list_consumption_tax_refunds(date,date,integer,date,text),
--   private.get_consumption_tax_refund_totals(date,date), private.list_consumption_tax_refunds(date,date,integer,date,text),
--   private.accounting_tax_refund_rows(date,date).

-- ACC_S23_BODY_BEGIN

CREATE TEMP TABLE accounting_s23_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s23_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', pg_catalog.jsonb_build_object(
    'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
    'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
    'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
    'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods)),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(s.sig, (SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a)))
      FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(s.sig)))
    FROM pg_catalog.unnest(ARRAY['private.accounting_intake_events(date,date)', 'private.get_intake_breakdown(date,date)',
      'private.get_intake_reconciliation(date,date)', 'private.list_deferred_revenue_anomalies()',
      'private.get_stripe_balance_reconciliation(date)']) AS s(sig)));

-- 1. The intake events (FREQ-582-AC-01..04, AC-07).
CREATE OR REPLACE FUNCTION private.accounting_intake_events(_from date, _to date)
RETURNS TABLE(order_id uuid, event_date date, kind text, amount bigint, key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH lines AS (
    SELECT * FROM private.accounting_effective_lines(_from, _to)
  ), line_events AS (
    SELECT b.order_id, b.entry_date AS event_date,
      CASE b.eff_kind WHEN 'payment_confirmed' THEN 'payment' WHEN 'pre_shipment_refund' THEN 'pre_shipment_cancel'
        ELSE 'dispute_unshipped_restored' END AS kind,
      (b.credit - b.debit)::bigint AS amount, b.entry_id::text || ':' || b.line_no::text AS key
    FROM lines AS b
    WHERE b.account_code = '2150' AND b.order_id IS NOT NULL
-- ACC_P3_REPLACE_BEGIN 72bd47b1a6c03810bcc0d67d0937b1a8
      AND (b.eff_kind = 'payment_confirmed'
-- ACC_P3_REPLACE_END
        OR (b.eff_kind = 'dispute_event' AND pg_catalog.split_part(b.eff_key, ':', 3) = 'reversal'
          AND EXISTS (SELECT 1 FROM lines AS m WHERE m.entry_id = b.entry_id AND m.account_code = '1160'
            AND m.memo = 'dispute_reversal_kind:L')))
-- ACC_P3_BEGIN
  ), refund_moves AS (
    -- Plan 3 Task 9: a pre-shipment refund entry, a refund failure entry and their reversals take off the intake the 2150
    -- and 2130 refund_owed_pre debit - credit of the entry minus its 4010 credit - debit (the transfer adjust d of rule 3-2,
    -- a sales adjustment, not a cancel of the order). Success -P, bank transfer of the debt -P, failure after the money was
    -- taken +P, failure before it 0, a reversed success +P. A 2130 line without a sub account counts as refund_owed_pre (the
    -- fixtures of plan 2 book it so).
    SELECT r.order_id, r.entry_id, r.entry_date,
      COALESCE(pg_catalog.sum(r.debit - r.credit) FILTER (WHERE r.account_code IN ('2150', '2130')), 0) AS taken,
      COALESCE(pg_catalog.sum(r.credit - r.debit) FILTER (WHERE r.account_code = '4010'), 0) AS adjust,
      pg_catalog.min(r.line_no) AS first_line
    FROM lines AS r
    WHERE r.order_id IS NOT NULL AND r.eff_kind IN ('pre_shipment_refund', 'refund_failed')
      AND (r.account_code IN ('2150', '4010')
        OR (r.account_code = '2130' AND COALESCE(r.sub_account, 'refund_owed_pre') = 'refund_owed_pre'))
    GROUP BY r.order_id, r.entry_id, r.entry_date
-- ACC_P3_END
  ), dispute_lines AS (
    SELECT pg_catalog.split_part(d.eff_key, ':', 2) AS dispute_id, pg_catalog.split_part(d.eff_key, ':', 3) AS stage,
      d.order_id, d.debit, d.credit,
      EXISTS (SELECT 1 FROM public.accounting_journal_lines AS m WHERE m.entry_id = d.entry_id AND m.account_code = '1160'
        AND m.memo = 'dispute_reversal_kind:R') AS is_early
    FROM private.accounting_effective_lines(NULL, 'infinity'::date) AS d
    WHERE d.account_code = '2150' AND d.order_id IS NOT NULL AND d.eff_kind = 'dispute_event'
  ), per_dispute AS (
    SELECT dl.dispute_id, pg_catalog.min(dl.order_id::text)::uuid AS order_id,
      COALESCE(pg_catalog.sum(dl.debit - dl.credit) FILTER (WHERE dl.stage = 'withdrawn'), 0) AS unshipped,
      COALESCE(pg_catalog.sum(dl.credit - dl.debit) FILTER (WHERE dl.stage = 'reversal' AND dl.is_early), 0) AS returned_early
    FROM dispute_lines AS dl
    GROUP BY dl.dispute_id
  ), confirmed AS (
    SELECT pd.order_id, COALESCE(c.entry_date, n.lost_on) AS confirm_date, COALESCE(c.id, n.id)::text || ':0' AS key,
      (pd.unshipped - pd.returned_early)::bigint AS pending
    FROM per_dispute AS pd
    LEFT JOIN LATERAL (
      SELECT ce.id, ce.entry_date FROM public.accounting_journal_entries AS ce
      WHERE ce.dedupe_key = 'dispute_event:' || pd.dispute_id || ':confirmed:lost'
    ) AS c ON true
    LEFT JOIN LATERAL (
      SELECT p.id, (p.detail ->> 'lost_on')::date AS lost_on FROM public.accounting_pending_events AS p
      WHERE p.event_kind = 'dispute_event' AND p.source_table = 'stripe_disputes' AND p.source_id = pd.dispute_id
        AND p.reason = 'no_revenue' AND p.resolved_at IS NOT NULL AND (p.detail ->> 'lost_on') IS NOT NULL
    ) AS n ON true
    WHERE c.id IS NOT NULL OR n.id IS NOT NULL
  )
  SELECT le.order_id, le.event_date, le.kind, le.amount, le.key FROM line_events AS le
-- ACC_P3_BEGIN
  UNION ALL
  SELECT rm.order_id, rm.entry_date, 'pre_shipment_cancel', (rm.adjust - rm.taken)::bigint,
    rm.entry_id::text || ':' || rm.first_line::text FROM refund_moves AS rm
  WHERE rm.adjust - rm.taken <> 0
-- ACC_P3_END
  UNION ALL
  SELECT cf.order_id, cf.confirm_date, 'dispute_unshipped', -cf.pending, cf.key FROM confirmed AS cf
  WHERE cf.pending <> 0 AND cf.confirm_date >= GREATEST(_from, private.accounting_read_start()) AND cf.confirm_date <= _to
$$;

-- 2. The intake breakdown (8-h): the refunds after shipment in their own column.
CREATE OR REPLACE FUNCTION private.get_intake_breakdown(_from date, _to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_payment bigint;
  v_cancel bigint;
  v_deducted bigint;
  v_restored bigint;
  v_intake bigint;
  v_subtotal bigint;
  v_discount bigint;
  v_shipping bigint;
  v_count integer;
-- ACC_P3_BEGIN
  v_post_refund bigint;
-- ACC_P3_END
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'payment'), 0),
    COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'pre_shipment_cancel'), 0),
    COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'dispute_unshipped'), 0),
    COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'dispute_unshipped_restored'), 0)
  INTO v_payment, v_cancel, v_deducted, v_restored
  FROM private.accounting_intake_events(_from, _to) AS e;
  v_intake := v_payment + v_cancel + v_deducted + v_restored;
-- ACC_P3_BEGIN
  -- Plan 3 Task 9: the refunds after shipment (return_refund entries and their reversals, the 1160 and 1040 debit - credit)
  -- are shown apart; they are neither added to nor taken off the intake.
  v_post_refund := COALESCE((SELECT pg_catalog.sum(l.debit - l.credit) FROM private.accounting_effective_lines(_from, _to) AS l
    WHERE l.eff_kind = 'return_refund' AND l.account_code IN ('1160', '1040') AND l.order_id IS NOT NULL), 0);
-- ACC_P3_END
  -- Each order counts with the sign of its net payment in the window (a payment reversed in a later window is negative there).
  SELECT COALESCE(pg_catalog.sum(g.sign * o.subtotal_amount), 0), COALESCE(pg_catalog.sum(g.sign * o.discount_amount), 0),
    COALESCE(pg_catalog.sum(g.sign * o.shipping_amount), 0), pg_catalog.count(*)
  INTO v_subtotal, v_discount, v_shipping, v_count
  FROM (SELECT e.order_id, pg_catalog.sign(pg_catalog.sum(e.amount)) AS sign
    FROM private.accounting_intake_events(_from, _to) AS e
    WHERE e.kind = 'payment' GROUP BY e.order_id HAVING pg_catalog.sum(e.amount) <> 0) AS g
  JOIN public.orders AS o ON o.id = g.order_id;
  RETURN pg_catalog.jsonb_build_object('subtotal_before_discount', v_subtotal, 'discount', v_discount, 'shipping', v_shipping,
    'payment', v_payment, 'pre_shipment_cancel', v_cancel, 'dispute_unshipped', v_deducted,
    'dispute_unshipped_restored', v_restored, 'intake', v_intake, 'order_count', v_count,
-- ACC_P3_BEGIN
    'post_shipment_refund', v_post_refund,
-- ACC_P3_END
    'breakdown_ok', (v_subtotal - v_discount + v_shipping + v_cancel + v_deducted + v_restored = v_intake));
END;
$$;

-- 3. The two stage reconciliation (FREQ-582-AC-02, AC-05, AC-07, AC-08).
CREATE OR REPLACE FUNCTION private.get_intake_reconciliation(_from date, _to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_opening bigint;
  v_closing bigint;
  v_intake bigint;
  v_deducted bigint;
  v_sales bigint;
  v_returns bigint;
  v_orders_4010 bigint;
  v_fee bigint;
  v_other_4010 bigint;
  v_other_4020 bigint;
  v_pending_move bigint;
  v_pending bigint;
  v_refund_2130 bigint;
  v_other_sum bigint;
  v_others jsonb;
  v_exceptions jsonb;
  v_booked bigint;
  v_by_account jsonb;
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_opening := COALESCE((SELECT pg_catalog.sum(b.balance) FROM private.accounting_order_balances(_from - 1) AS b), 0);
  v_closing := COALESCE((SELECT pg_catalog.sum(b.balance) FROM private.accounting_order_balances(_to) AS b), 0);
  SELECT COALESCE(pg_catalog.sum(e.amount), 0), COALESCE(pg_catalog.sum(e.amount) FILTER (WHERE e.kind = 'dispute_unshipped'), 0)
  INTO v_intake, v_deducted FROM private.accounting_intake_events(_from, _to) AS e;

  -- The 2150 change of the window by the kind of entry that made it.
  WITH ln AS (
    SELECT * FROM private.accounting_effective_lines(_from, _to)
  ), ent AS (
    SELECT l.entry_id, pg_catalog.bool_or(l.account_code = '2130') AS has_2130,
      pg_catalog.bool_or(l.account_code = '1160' AND l.memo = 'dispute_reversal_kind:L') AS is_late,
      pg_catalog.bool_or(l.account_code = '1160' AND l.memo = 'dispute_reversal_kind:R') AS is_early
    FROM ln AS l GROUP BY l.entry_id
  ), moves AS (
    SELECT CASE
        WHEN l.eff_kind = 'payment_confirmed' THEN 'payment'
        WHEN l.eff_kind = 'pre_shipment_refund' THEN 'pre_shipment_cancel'
        WHEN l.eff_kind IN ('shipment_confirmed', 'shipment_redated') THEN 'shipment'
        WHEN l.eff_kind = 'dispute_event' AND pg_catalog.split_part(l.eff_key, ':', 3) = 'withdrawn' THEN 'dispute_pending'
        WHEN l.eff_kind = 'dispute_event' AND pg_catalog.split_part(l.eff_key, ':', 3) = 'reversal' AND e.is_early THEN 'dispute_pending'
        WHEN l.eff_kind = 'dispute_event' AND pg_catalog.split_part(l.eff_key, ':', 3) = 'reversal' AND e.is_late THEN 'dispute_late'
-- ACC_P3_REPLACE_BEGIN ebd9071cd86239fd14d842bab4bb7ced
        WHEN l.eff_kind IN ('refund_failed', 'refund_abandoned') THEN 'refund'
-- ACC_P3_REPLACE_END
        ELSE 'other' END AS cls,
      l.eff_kind, (l.credit - l.debit) AS delta
    FROM ln AS l JOIN ent AS e ON e.entry_id = l.entry_id
    WHERE l.account_code = '2150' AND l.order_id IS NOT NULL
  )
  SELECT COALESCE(pg_catalog.sum(m.delta) FILTER (WHERE m.cls = 'dispute_pending'), 0),
-- ACC_P3_REPLACE_BEGIN 37ec8ba1f050914f79b75f78a1d5f071
    -- Plan 3 Task 9: the debit - credit of 2130 refund_owed_pre in the window (a 2130 line without a sub account of a refund
    -- kind counts as it).
    COALESCE((SELECT pg_catalog.sum(x.debit - x.credit) FROM ln AS x WHERE x.account_code = '2130'
      AND (x.sub_account = 'refund_owed_pre'
        OR (x.sub_account IS NULL AND x.eff_kind IN ('pre_shipment_refund', 'refund_failed', 'refund_abandoned')))), 0),
-- ACC_P3_REPLACE_END
    COALESCE(pg_catalog.sum(m.delta) FILTER (WHERE m.cls = 'other'), 0),
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', 'other', 'label_key', 'other',
        'event_kind', o.eff_kind, 'amount', o.amount) ORDER BY o.eff_kind COLLATE "C")
      FROM (SELECT m2.eff_kind, pg_catalog.sum(m2.delta)::bigint AS amount FROM moves AS m2 WHERE m2.cls = 'other'
        GROUP BY m2.eff_kind HAVING pg_catalog.sum(m2.delta) <> 0) AS o), '[]'::jsonb)
  INTO v_pending_move, v_refund_2130, v_other_sum, v_others
  FROM moves AS m;
  -- The part of the withdrawals taken off 2150 that the intake has not taken off yet (and the part that came back early).
  v_pending := v_pending_move - v_deducted;
  v_exceptions := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('kind', 'dispute_pending', 'label_key', 'dispute_pending', 'amount', v_pending),
    pg_catalog.jsonb_build_object('kind', 'return_refund_2130', 'label_key', 'return_refund_2130', 'amount', v_refund_2130))
    || v_others;

  -- The sales rows of the window.
  SELECT COALESCE(pg_catalog.sum(l.credit - l.debit) FILTER (WHERE l.account_code = '4010' AND l.order_id IS NOT NULL
-- ACC_P3_REPLACE_BEGIN 88dec7935405557a92e8c456b56a9acf
        AND l.eff_kind IN ('shipment_confirmed', 'shipment_redated', 'pre_shipment_refund', 'refund_failed',
          'refund_abandoned')), 0),
-- ACC_P3_REPLACE_END
    COALESCE(pg_catalog.sum(l.debit - l.credit) FILTER (WHERE l.account_code = '4020' AND l.order_id IS NOT NULL), 0),
    COALESCE(pg_catalog.sum(l.credit - l.debit) FILTER (WHERE l.account_code = '4010' AND l.order_id IS NOT NULL), 0),
    COALESCE(pg_catalog.sum(l.credit - l.debit) FILTER (WHERE l.account_code = '4050'), 0),
    COALESCE(pg_catalog.sum(l.credit - l.debit) FILTER (WHERE l.account_code = '4010' AND l.order_id IS NULL), 0),
    COALESCE(pg_catalog.sum(l.debit - l.credit) FILTER (WHERE l.account_code = '4020' AND l.order_id IS NULL), 0)
  INTO v_sales, v_returns, v_orders_4010, v_fee, v_other_4010, v_other_4020
  FROM private.accounting_effective_lines(_from, _to) AS l;
  v_booked := v_orders_4010 - v_returns;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('account_code', x.account_code, 'sub_account', x.sub_account,
      'amount', x.amount) ORDER BY x.account_code COLLATE "C", x.sub_account COLLATE "C" NULLS FIRST), '[]'::jsonb)
  INTO v_by_account
  FROM (
    SELECT l.account_code, l.sub_account, pg_catalog.sum(l.debit - l.credit)::bigint AS amount
    FROM private.accounting_effective_lines(_from, _to) AS l
    WHERE l.eff_kind = 'dispute_event' AND l.account_code NOT IN ('1160', '2150')
      AND NOT (l.account_code = '1470' AND l.sub_account = 'dispute_pending')
    GROUP BY l.account_code, l.sub_account
    HAVING pg_catalog.sum(l.debit - l.credit) <> 0
  ) AS x;

  RETURN pg_catalog.jsonb_build_object(
    'opening_backlog', v_opening, 'intake', v_intake, 'sales_before_return', v_sales, 'closing_backlog', v_closing,
    'exceptions', v_exceptions,
    'unexplained', v_closing - (v_opening + v_intake - v_sales + v_pending + v_refund_2130 + v_other_sum),
    'returns', v_returns, 'booked_sales_net_orders', v_booked, 'return_fee_revenue_4050', v_fee,
    'other_4010', v_other_4010, 'other_4020', v_other_4020,
    'book_sales_total', v_booked + v_other_4010 - v_other_4020,
    'unexplained2', (v_sales - v_returns) - v_booked,
    'dispute_confirmed_by_account', v_by_account);
END;
$$;

-- 4. The deferred revenue anomalies (FREQ-578-AC-09).
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
    ) AS x
    LEFT JOIN private.accounting_order_balances('infinity'::date) AS ob ON ob.order_id = x.order_id
-- ACC_P3_END
  ) AS f
  WHERE f.reason IS NOT NULL;
  RETURN pg_catalog.jsonb_build_object('anomalies', v_rows);
END;
$$;

-- 5. The Stripe balance reconciliation (FREQ-582-AC-06).
CREATE OR REPLACE FUNCTION private.get_stripe_balance_reconciliation(_through date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_balance bigint;
  v_ledger_1160 bigint;
  v_ledger_1130 bigint;
  v_in_transit bigint;
  v_topup_entries bigint;
  v_unjournaled jsonb;
BEGIN
  IF _through IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.sum(b.net), 0) INTO v_balance FROM public.stripe_balance_transactions AS b
  WHERE private.accounting_jst_date(b.stripe_created_at) <= _through;
  SELECT COALESCE(pg_catalog.sum(l.debit - l.credit) FILTER (WHERE l.account_code = '1160'), 0),
    COALESCE(pg_catalog.sum(l.debit - l.credit) FILTER (WHERE l.account_code = '1130' AND l.sub_account = 'processor:stripe'), 0),
    COALESCE(pg_catalog.sum(l.debit - l.credit) FILTER (WHERE l.account_code = '1150'), 0)
  INTO v_ledger_1160, v_ledger_1130, v_in_transit
  FROM public.accounting_journal_lines AS l
  JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
  WHERE e.entry_date <= _through AND l.account_code IN ('1160', '1130', '1150');
  SELECT COALESCE(pg_catalog.sum(l.debit - l.credit), 0) INTO v_topup_entries
  FROM public.accounting_journal_lines AS l
  JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
  WHERE e.event_kind = 'balance_topup' AND e.entry_date <= _through AND l.account_code = '1160'
    AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id);

  WITH t AS (
    SELECT b.id, b.payment_intent_id, b.source_id, b.reporting_category, b.amount, b.net, k.kind, private.accounting_stripe_fee_amount(k.kind, b.fee, b.net) AS fee_amount
    FROM public.stripe_balance_transactions AS b
    CROSS JOIN LATERAL (SELECT private.accounting_stripe_category_kind(b.type, b.reporting_category) AS kind) AS k
    WHERE private.accounting_jst_date(b.stripe_created_at) <= _through),
  c AS (
    SELECT t.*,
      CASE WHEN t.kind IS NULL THEN 0 WHEN t.kind = 'tax_adjustment' THEN t.net WHEN t.kind = 'fee_only' THEN 0 ELSE t.amount END AS p_amt,
      CASE WHEN t.kind IS NULL OR t.kind = 'tax_adjustment' THEN 0 ELSE -t.fee_amount END AS f_amt,
      EXISTS (SELECT 1 FROM public.accounting_pending_events AS pe
        WHERE pe.source_table = 'stripe_balance_transactions' AND pe.source_id = t.id
          AND pe.event_kind IN ('payout_started', 'payout_failed') AND pe.reason = 'payout_mismatch'
          AND pe.resolved_at IS NOT NULL AND pe.resolved_entry_id IS NULL AND pe.detail ->> 'payout_state' = 'payout_net_zero') AS net_zero
    FROM t),
  d AS (
    SELECT c.*,
      CASE c.kind
        -- The sale is on the books when a payment entry sourced from this transaction exists and has not been reversed (not
        -- decided by the payment intent column: a sync that carries no intent must not turn a posted sale into an unposted one).
        WHEN 'sale' THEN EXISTS (SELECT 1 FROM public.accounting_journal_entries AS se
          WHERE se.event_kind = 'payment_confirmed' AND se.source_table = 'stripe_balance_transactions' AND se.source_id = c.id
            AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS sr WHERE sr.reverses_entry_id = se.id))
        WHEN 'tax_adjustment' THEN private.accounting_entry_live('stripe_tax_adjustment', c.id)
        WHEN 'payout' THEN c.net_zero OR private.accounting_entry_live('payout_started', c.source_id)
        WHEN 'payout_failure' THEN c.net_zero OR private.accounting_entry_live('payout_failed', c.id)
        -- A dispute withdrawal (amount < 0) or its reversal (amount > 0) is on the books when the dispute entry of that
        -- transaction exists and has not been reversed. The key is S11's (private.accounting_dispute_key, built by
        -- accounting_event_key); this function is plpgsql, so the name is resolved when it runs.
        WHEN 'dispute' THEN EXISTS (SELECT 1 FROM public.accounting_journal_entries AS de
          WHERE de.dedupe_key = CASE WHEN c.reporting_category = 'dispute' AND c.amount < 0
              THEN private.accounting_dispute_key(c.source_id, 'withdrawn', c.id)
            WHEN c.reporting_category = 'dispute_reversal' AND c.amount > 0
              THEN private.accounting_dispute_key(c.source_id, 'reversal', c.id) END
            AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS dr WHERE dr.reverses_entry_id = de.id))
-- ACC_P3_BEGIN
        -- Plan 3 Task 9: a refund transaction is on the books once the refund poster marked it: the success entry of its
        -- number (kept marked when the abandon of the shop reversed it), the failure entry of the refund whose failure
        -- transaction it is, or the abandon that reversed the success entries of that refund; when the money was taken and
        -- given back with no succeeded row (P3-T6f), both transactions of the refund once both are dated on or before the
        -- day. A refund transaction with no order_refunds row stays planned_p3 (plan 2 Ruling P2-T4-N1-final).
        WHEN 'refund_principal' THEN EXISTS (SELECT 1 FROM public.accounting_journal_entries AS re
            WHERE re.event_kind IN ('pre_shipment_refund', 'return_refund') AND re.source_table = 'order_refunds'
              AND re.dedupe_key IN ('pre_shipment_refund:' || c.id, 'return_refund:' || c.id)
              AND (NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS rr WHERE rr.reverses_entry_id = re.id)
                OR EXISTS (SELECT 1 FROM public.accounting_refund_events AS ra
                  WHERE ra.refund_id::text = re.source_id AND ra.state = 'abandoned')))
          OR EXISTS (SELECT 1 FROM public.stripe_refunds AS sr
            JOIN public.order_refunds AS r ON r.stripe_refund_id = sr.id
            WHERE sr.failure_balance_transaction_id = c.id
              AND (EXISTS (SELECT 1 FROM public.accounting_journal_entries AS fe
                  WHERE fe.event_kind = 'refund_failed' AND fe.source_table = 'order_refunds' AND fe.source_id = r.id::text)
                OR (EXISTS (SELECT 1 FROM public.accounting_refund_events AS fa WHERE fa.refund_id = r.id AND fa.state = 'abandoned')
                  AND EXISTS (SELECT 1 FROM public.accounting_journal_entries AS se
                    JOIN public.accounting_journal_entries AS sv ON sv.reverses_entry_id = se.id
                    WHERE se.event_kind IN ('pre_shipment_refund', 'return_refund') AND se.source_table = 'order_refunds'
                      AND se.source_id = r.id::text))))
          OR EXISTS (SELECT 1 FROM public.stripe_refunds AS sb
            JOIN public.order_refunds AS rb ON rb.stripe_refund_id = sb.id
            JOIN public.stripe_balance_transactions AS tb ON tb.id = sb.balance_transaction_id
            JOIN public.stripe_balance_transactions AS tf ON tf.id = sb.failure_balance_transaction_id
            WHERE c.id IN (tb.id, tf.id)
              AND private.accounting_jst_date(tb.stripe_created_at) <= _through
              AND private.accounting_jst_date(tf.stripe_created_at) <= _through
              AND NOT EXISTS (SELECT 1 FROM public.accounting_refund_events AS sx WHERE sx.refund_id = rb.id AND sx.state = 'succeeded'))
-- ACC_P3_END
        ELSE false END AS p_done,
      c.f_amt = 0 OR private.accounting_entry_live('stripe_fee', c.id) AS f_done
    FROM c),
  parts AS (
    SELECT CASE d.kind WHEN 'refund_principal' THEN 'planned_p3' WHEN 'payout' THEN 'payout_unposted'
        WHEN 'payout_failure' THEN 'payout_unposted' WHEN 'manual_topup' THEN 'manual_topup' ELSE 'pending' END AS bucket,
      d.id, d.p_amt AS amount
    FROM d WHERE d.kind IS NOT NULL AND NOT d.p_done AND d.p_amt <> 0
    UNION ALL
    SELECT CASE d.kind WHEN 'manual_topup' THEN 'manual_topup' ELSE 'pending' END, d.id, d.f_amt
    FROM d WHERE d.kind IS NOT NULL AND NOT d.f_done AND d.f_amt <> 0
    UNION ALL
    SELECT 'unknown', d.id, d.net FROM d WHERE d.kind IS NULL AND d.net <> 0),
  agg AS (
    SELECT p.bucket, pg_catalog.count(DISTINCT p.id) AS n, pg_catalog.sum(p.amount) AS s FROM parts AS p GROUP BY p.bucket)
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', b.kind, 'count', COALESCE(a.n, 0),
      'net_sum', COALESCE(a.s, 0) - CASE WHEN b.kind = 'manual_topup' THEN v_topup_entries ELSE 0 END) ORDER BY b.ord)
  INTO v_unjournaled
  FROM (VALUES (1, 'planned_p3'), (2, 'pending'), (3, 'unknown'), (4, 'payout_unposted'), (5, 'manual_topup')) AS b(ord, kind)
  LEFT JOIN agg AS a ON a.bucket = b.kind;

  RETURN pg_catalog.jsonb_build_object('through', pg_catalog.to_char(_through, 'YYYY-MM-DD'), 'stripe_balance', v_balance,
    'ledger_1160', v_ledger_1160, 'ledger_1130_stripe', v_ledger_1130,
    'difference', v_balance - (v_ledger_1160 + v_ledger_1130), 'unjournaled', v_unjournaled,
    'payout_in_transit_1150', v_in_transit);
END;
$$;

-- 6. The refunds for the consumption tax return (FREQ-583). A money line of a refund: the 1160 or 1040 line of an entry of
--    kind pre_shipment_refund or return_refund (+ credit - debit: the money went to the customer on the day of the balance
--    transaction or of the bank transfer; a reversal comes back with -), and the 2130 line of a refund_failed entry that
--    took the money back into the Stripe balance (debit - credit, so -). The part is pre for the kind pre_shipment_refund
--    and for the refund_owed_pre line of a failure, else post. A pre part has no original sale (before_sale: the units were
--    not shipped); a post part's original sale is the earliest live shipment entry of the order. The statuses are those of
--    the periods of the entries (taxable only from consumption_taxable_from on).
CREATE FUNCTION private.accounting_tax_refund_rows(_from date, _to date)
RETURNS TABLE(entry_id uuid, line_key text, refund_date date, order_id uuid, amount bigint, refund_id uuid,
  original_sale_date date, sale_period_status text, refund_period_status text, exclusion text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  WITH money AS (
    SELECT l.entry_id, l.line_no, l.entry_date, l.order_id,
      CASE WHEN l.account_code IN ('1160', '1040') THEN l.credit - l.debit ELSE l.debit - l.credit END AS amount,
      CASE WHEN l.eff_kind = 'pre_shipment_refund' OR (l.eff_kind = 'refund_failed' AND l.sub_account = 'refund_owed_pre')
        THEN 'pre' ELSE 'post' END AS part
    FROM private.accounting_effective_lines(_from, _to) AS l
    WHERE l.order_id IS NOT NULL
      AND ((l.eff_kind IN ('pre_shipment_refund', 'return_refund') AND l.account_code IN ('1160', '1040'))
        OR (l.eff_kind = 'refund_failed' AND l.account_code = '2130'
          AND EXISTS (SELECT 1 FROM public.accounting_journal_lines AS m WHERE m.entry_id = l.entry_id AND m.account_code = '1160')))
  ), dated AS (
    SELECT mo.*, e.period_id,
      CASE WHEN COALESCE(o.source_table, e.source_table) = 'order_refunds' THEN COALESCE(o.source_id, e.source_id)::uuid END
        AS refund_id,
      s.entry_date AS sale_date, s.period_id AS sale_period_id
    FROM money AS mo
    JOIN public.accounting_journal_entries AS e ON e.id = mo.entry_id
    LEFT JOIN public.accounting_journal_entries AS o ON o.id = e.reverses_entry_id
    LEFT JOIN LATERAL (
      SELECT se.entry_date, se.period_id FROM public.accounting_journal_entries AS se
      WHERE mo.part = 'post' AND se.event_kind IN ('shipment_confirmed', 'shipment_redated') AND se.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS sr WHERE sr.reverses_entry_id = se.id)
        AND EXISTS (SELECT 1 FROM public.accounting_journal_lines AS sl WHERE sl.entry_id = se.id AND sl.order_id = mo.order_id)
      ORDER BY se.entry_date, se.entry_no
      LIMIT 1
    ) AS s ON true
    WHERE mo.amount <> 0
  ), stated AS (
    SELECT d.*, CASE WHEN d.sale_date IS NULL THEN NULL
        WHEN private.accounting_period_taxable(d.sale_period_id, d.sale_date) THEN 'taxable' ELSE 'exempt' END AS sale_status,
      CASE WHEN private.accounting_period_taxable(d.period_id, d.entry_date) THEN 'taxable' ELSE 'exempt' END AS refund_status
    FROM dated AS d
  )
  SELECT st.entry_id, st.entry_id::text || ':' || st.line_no::text, st.entry_date, st.order_id, st.amount::bigint, st.refund_id,
    st.sale_date, st.sale_status, st.refund_status,
    CASE WHEN st.sale_date IS NULL THEN 'before_sale' WHEN st.sale_status = 'exempt' THEN 'exempt_sale_14_1_6'
      WHEN st.refund_status = 'exempt' THEN 'after_exit_14_1_7' ELSE 'none' END
  FROM stated AS st
$$;

-- The rows by (refund_date, line_key), _limit (1..200) at a time; the next page starts after next_after_date and
-- next_after_key. tax_rate is 10 (orders has no tax rate column; the standard rate of clothes), tax_amount is the absolute
-- amount x 10 / 110 rounded down with the sign of the amount. item_summary is the refund lines (name x quantity, at most 5)
-- or, without them, the order's items. No name, mail or address.
CREATE FUNCTION private.list_consumption_tax_refunds(_from date, _to date, _limit integer DEFAULT 200,
  _after_date date DEFAULT NULL, _after_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_rows jsonb;
  v_more boolean;
  v_last_date date;
  v_last_key text;
  v_note CONSTANT text := U&'\6D88\8CBB\7A0E\6CD5\65BD\884C\4EE458\6761\306E2\306B\3088\308A7\5E74\9593\4FDD\5B58\3059\308B';
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to OR _limit IS NULL OR _limit < 1 OR _limit > 200
    OR (_after_date IS NULL) <> (_after_key IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('entry_id', n.entry_id, 'line_key', n.line_key,
      'refund_date', pg_catalog.to_char(n.refund_date, 'YYYY-MM-DD'), 'order_id', n.order_id,
      'order_number', 'ORD-' || pg_catalog.upper(pg_catalog.left(n.order_id::text, 8)), 'amount', n.amount, 'tax_rate', 10,
      'tax_amount', CASE WHEN n.amount < 0 THEN -(pg_catalog.abs(n.amount) * 10 / 110) ELSE n.amount * 10 / 110 END,
      'item_summary', COALESCE(
        (SELECT pg_catalog.string_agg(i.item_name || U&'\00D7' || i.quantity::text, ', ' ORDER BY i.ord) FROM (
          SELECT oi.item_name, rl.quantity, pg_catalog.row_number() OVER (ORDER BY oi.created_at, oi.id) AS ord
          FROM public.order_refund_lines AS rl JOIN public.order_items AS oi ON oi.id = rl.order_item_id
          WHERE rl.refund_id = n.refund_id ORDER BY oi.created_at, oi.id LIMIT 5) AS i),
        (SELECT pg_catalog.string_agg(i.item_name || U&'\00D7' || i.quantity::text, ', ' ORDER BY i.ord) FROM (
          SELECT oi.item_name, oi.quantity, pg_catalog.row_number() OVER (ORDER BY oi.created_at, oi.id) AS ord
          FROM public.order_items AS oi WHERE oi.order_id = n.order_id AND oi.line_kind = 'order'
          ORDER BY oi.created_at, oi.id LIMIT 5) AS i)),
      'original_sale_date', pg_catalog.to_char(n.original_sale_date, 'YYYY-MM-DD'),
      'sale_period_status', n.sale_period_status, 'refund_period_status', n.refund_period_status, 'exclusion', n.exclusion)
      ORDER BY n.rn) FILTER (WHERE n.rn <= _limit), '[]'::jsonb),
    pg_catalog.count(*) > _limit,
    (pg_catalog.array_agg(n.refund_date ORDER BY n.rn) FILTER (WHERE n.rn = _limit))[1],
    (pg_catalog.array_agg(n.line_key ORDER BY n.rn) FILTER (WHERE n.rn = _limit))[1]
  INTO v_rows, v_more, v_last_date, v_last_key
  FROM (
    SELECT p.*, pg_catalog.row_number() OVER (ORDER BY p.refund_date, p.line_key COLLATE "C") AS rn
    FROM (
      SELECT r.* FROM private.accounting_tax_refund_rows(_from, _to) AS r
      WHERE _after_date IS NULL OR r.refund_date > _after_date
        OR (r.refund_date = _after_date AND r.line_key COLLATE "C" > _after_key COLLATE "C")
      ORDER BY r.refund_date, r.line_key COLLATE "C"
      LIMIT _limit + 1
    ) AS p
  ) AS n;
  RETURN pg_catalog.jsonb_build_object('rows', v_rows,
    'next_after_date', CASE WHEN v_more THEN pg_catalog.to_char(v_last_date, 'YYYY-MM-DD') END,
    'next_after_key', CASE WHEN v_more THEN v_last_key END, 'retention_note', v_note);
END;
$$;

-- The totals of the window: included is exclusion none only; the tax is summed row by row as on the list.
CREATE FUNCTION private.get_consumption_tax_refund_totals(_from date, _to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF _from IS NULL OR _to IS NULL OR _from > _to THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.jsonb_build_object(
      'included_amount', COALESCE(pg_catalog.sum(r.amount) FILTER (WHERE r.exclusion = 'none'), 0),
      'included_tax', COALESCE(pg_catalog.sum(CASE WHEN r.amount < 0 THEN -(pg_catalog.abs(r.amount) * 10 / 110)
          ELSE r.amount * 10 / 110 END)
        FILTER (WHERE r.exclusion = 'none'), 0),
      'excluded_amount', COALESCE(pg_catalog.sum(r.amount) FILTER (WHERE r.exclusion <> 'none'), 0),
      'excluded_by', pg_catalog.jsonb_build_object(
        'before_sale', COALESCE(pg_catalog.sum(r.amount) FILTER (WHERE r.exclusion = 'before_sale'), 0),
        'exempt_sale_14_1_6', COALESCE(pg_catalog.sum(r.amount) FILTER (WHERE r.exclusion = 'exempt_sale_14_1_6'), 0),
        'after_exit_14_1_7', COALESCE(pg_catalog.sum(r.amount) FILTER (WHERE r.exclusion = 'after_exit_14_1_7'), 0)))
  INTO v_result
  FROM private.accounting_tax_refund_rows(_from, _to) AS r;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.list_consumption_tax_refunds(_from date, _to date, _limit integer DEFAULT 200,
  _after_date date DEFAULT NULL, _after_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_consumption_tax_refunds(_from, _to, _limit, _after_date, _after_key) $$;

CREATE FUNCTION public.get_consumption_tax_refund_totals(_from date, _to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_consumption_tax_refund_totals(_from, _to) $$;

-- Owners and EXECUTE. service_role: the two reads (private and public); the tool is owner only.
ALTER FUNCTION private.accounting_tax_refund_rows(date,date) OWNER TO postgres;
ALTER FUNCTION private.list_consumption_tax_refunds(date,date,integer,date,text) OWNER TO postgres;
ALTER FUNCTION private.get_consumption_tax_refund_totals(date,date) OWNER TO postgres;
ALTER FUNCTION public.list_consumption_tax_refunds(date,date,integer,date,text) OWNER TO postgres;
ALTER FUNCTION public.get_consumption_tax_refund_totals(date,date) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.accounting_tax_refund_rows(date,date),
  private.list_consumption_tax_refunds(date,date,integer,date,text), private.get_consumption_tax_refund_totals(date,date),
  public.list_consumption_tax_refunds(date,date,integer,date,text), public.get_consumption_tax_refund_totals(date,date)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.list_consumption_tax_refunds(date,date,integer,date,text), private.get_consumption_tax_refund_totals(date,date),
  public.list_consumption_tax_refunds(date,date,integer,date,text), public.get_consumption_tax_refund_totals(date,date)
TO service_role;
-- ACC_S23_BODY_END

-- ACC_S23_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. acc_s23_functions: the five new functions exist once in their
-- schema, with their arguments, language, security, owner and search_path; the tool runs for nobody, the reads for
-- service_role only. acc_s23_function_attrs: the five rebuilt functions keep their arguments, result, language,
-- volatility, security, owner, search_path and ACL. acc_s23_body_unchanged: each rebuilt function has its replaced parts
-- and ACC_P3 blocks, and with the replaced parts restored from the list below (by the md5 on the marker) and every
-- ACC_P<n> block and all white space removed is the body it was copied from (plan 2 S12, S9). acc_s23_reads_stable: the
-- rebuilt and the new functions are STABLE, write nothing and name no personal column. acc_s23_existing_dml_allowlist:
-- this migration writes no row, and the group G writer list is what it was.
DO $acc_s23_final$
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
  v_stage := 'acc_s23_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s23_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s23_baseline) <> 1 THEN
    v_failed := 'acc_s23_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s23_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s23_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s23_functions';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_tax_refund_rows(date,date)', 'sql', true,
        '_from,_to,entry_id,line_key,refund_date,order_id,amount,refund_id,original_sale_date,sale_period_status,refund_period_status,exclusion',
        false),
      ('private.list_consumption_tax_refunds(date,date,integer,date,text)', 'plpgsql', false,
        '_from,_to,_limit,_after_date,_after_key', true),
      ('private.get_consumption_tax_refund_totals(date,date)', 'plpgsql', false, '_from,_to', true),
      ('public.list_consumption_tax_refunds(date,date,integer,date,text)', 'sql', false,
        '_from,_to,_limit,_after_date,_after_key', true),
      ('public.get_consumption_tax_refund_totals(date,date)', 'sql', false, '_from,_to', true)
    ) AS x(signature, lang, retset, arg_names, service_role)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
          WHERE f.oid = v_oid AND f.prosecdef = (e.signature LIKE 'private.%') AND f.provolatile = 's' AND l.lanname = e.lang
            AND f.proretset = e.retset
            AND f.prorettype = CASE WHEN e.retset THEN 'record'::regtype ELSE 'jsonb'::regtype END
            AND f.proowner = 'postgres'::regrole AND f.prokind = 'f'
            AND f.proconfig = ARRAY['search_path=""']::text[]
            AND pg_catalog.array_to_string(f.proargnames, ',') = e.arg_names)
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o JOIN pg_catalog.pg_proc AS f ON f.oid = v_oid
          WHERE o.pronamespace = f.pronamespace AND o.proname = f.proname) <> 1
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') <> e.service_role
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee <> f.proowner
            AND NOT (e.service_role AND a.grantee = 'service_role'::regrole AND a.privilege_type = 'EXECUTE')) THEN
        v_failed := 'acc_s23_functions';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s23_function_attrs';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'attrs')) <> 5
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'attrs') AS b(sig, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(b.sig)
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
        f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))) THEN
    v_failed := 'acc_s23_function_attrs';
  END IF;

  v_stage := 'acc_s23_body_unchanged';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_intake_events(date,date)', 1, 2, '783a5a8b18ac22c128311d695ab3c7f0', 'refund_moves AS ('),
      ('private.get_intake_breakdown(date,date)', 0, 3, 'd7019e982fdf9d5214ace59c41cb9167', '''post_shipment_refund'', v_post_refund'),
      ('private.get_intake_reconciliation(date,date)', 3, 0, 'dee5f0f341bcc091e355679712657fcf', 'x.sub_account = ''refund_owed_pre'''),
      ('private.list_deferred_revenue_anomalies()', 0, 1, 'd891511d05127d0b0be979b7e3591c81', '''return_waived_with_failed_refund'''),
      ('private.get_stripe_balance_reconciliation(date)', 0, 1, '19017665c51c40ddd8733fc3e6c80807', 'WHEN ''refund_principal'' THEN')
    ) AS x(signature, replaced, added, digest, needle)
    LOOP
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF v_src IS NULL OR pg_catalog.strpos(v_src, e.needle) = 0
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_REPLACE_BEGIN', 'g')) <> e.replaced
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_BEGIN', 'g')) <> e.added THEN
        v_failed := 'acc_s23_body_unchanged';
        EXIT;
      END IF;
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('72bd47b1a6c03810bcc0d67d0937b1a8', $acc_s23_o1$      AND (b.eff_kind IN ('payment_confirmed', 'pre_shipment_refund')
$acc_s23_o1$),
    ('ebd9071cd86239fd14d842bab4bb7ced', $acc_s23_o2$        WHEN e.has_2130 THEN 'return_refund_2130'
$acc_s23_o2$),
    ('37ec8ba1f050914f79b75f78a1d5f071', $acc_s23_o3$    COALESCE(pg_catalog.sum(m.delta) FILTER (WHERE m.cls = 'return_refund_2130'), 0),
$acc_s23_o3$),
    ('88dec7935405557a92e8c456b56a9acf', $acc_s23_o4$        AND l.eff_kind IN ('shipment_confirmed', 'shipment_redated')), 0),
$acc_s23_o4$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s23_body_unchanged';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
        v_original := NULL;
      END LOOP;
      IF v_failed IS NULL AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM e.digest THEN
        v_failed := 'acc_s23_body_unchanged';
      END IF;
      EXIT WHEN v_failed IS NOT NULL;
    END LOOP;
  END IF;

  v_stage := 'acc_s23_reads_stable';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_intake_events(date,date)'), ('private.get_intake_breakdown(date,date)'),
      ('private.get_intake_reconciliation(date,date)'), ('private.list_deferred_revenue_anomalies()'),
      ('private.get_stripe_balance_reconciliation(date)'), ('private.accounting_tax_refund_rows(date,date)'),
      ('private.list_consumption_tax_refunds(date,date,integer,date,text)'), ('private.get_consumption_tax_refund_totals(date,date)'),
      ('public.list_consumption_tax_refunds(date,date,integer,date,text)'), ('public.get_consumption_tax_refund_totals(date,date)')
    ) AS x(signature)
    LOOP
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure(e.signature) AND f.provolatile = 's';
      IF v_src IS NULL
        OR v_src ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M'
        OR v_src ~* '(raw_payload|evidence_details|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address|user_id|session_id)' THEN
        v_failed := 'acc_s23_reads_stable';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s23_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline #>> '{counts,entries}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline #>> '{counts,lines}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline #>> '{counts,pending_events}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline #>> '{counts,periods}')::bigint
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc))
      IS DISTINCT FROM (v_baseline -> 'allowlist')) THEN
    v_failed := 'acc_s23_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s23_functions'), HINT = SQLSTATE;
END;
$acc_s23_final$;
-- ACC_S23_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
