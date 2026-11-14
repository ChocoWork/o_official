BEGIN;
-- Accounting plan 3 S24 (Ruling P3-T11a, P3-T11b; FREQ-569, FREQ-581, FREQ-582): a person closes a pending row of reason
-- order_not_postable by linking the manual journal entry that settles it; the second lost dispute of an order no longer waits
-- on a 0 yen close parked for a person; a refund balance transaction whose pending row was closed by a person leaves planned_p3
-- of the Stripe balance reconciliation.
--
-- New (VOLATILE; private body SECURITY DEFINER, public entry SECURITY INVOKER, service_role only):
--   private/public.admin_link_accounting_pending_entry(_actor_id uuid, _event_id uuid, _entry_id uuid, _note text,
--     _request_key uuid) RETURNS jsonb
--     Follows private.admin_resolve_accounting_pending_event (plan 2): admin.accounting.entries.correct, a note of 1-500
--     characters after trim, accounting_lock_all, a replay of the same request key (same content: the first result; other
--     content: ACCOUNTING_REQUEST_KEY_CONFLICT; the hash covers the entry), ACCOUNTING_NOT_FOUND, ACCOUNTING_PENDING_RESOLVED.
--     Only reason order_not_postable (else ACCOUNTING_EVENT_NOT_POSTABLE). The entry must exist, be of kind manual_entry, not
--     be a reversal and have no live reversal; else ACCOUNTING_LINK_ENTRY_INVALID / 22023 with DETAIL link_not_found,
--     link_not_manual or link_reversed. When the row has an order, an entry that has lines with an order must have one of this
--     order (P3-T11b: an entry with no order on any line, which is every entry of the expense form, passes); else DETAIL
--     link_other_order. One entry may close several rows. The row gets resolved_at, resolved_by, resolution_note, the request
--     key, its hash and resolved_entry_id.
-- Rebuilt (CREATE OR REPLACE; the latest definition copied as it is, new text between ACC_P3_BEGIN and ACC_P3_END, the
-- replaced text between ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END; arguments, result, attributes,
-- owner and ACL are unchanged):
--   private.accounting_dispute_offset_ready (only definition: S22 20261113090000:73-134): the decision branch of the wait
--     for the second kind skips a decision whose pending row is order_not_postable with detail reason dispute_lost, open or
--     closed (P3-T8e, Task 8 new Minor 1).
--   private.get_stripe_balance_reconciliation (latest: S23 20261113100000:377): a refund transaction whose pending row of
--     kind pre_shipment_refund, return_refund (balance transaction) or refund_failed (failure transaction) is closed is done
--     (Task 9 Minor 1).
--
-- ROLLBACK (only while no pending row has been closed through the new function): DROP FUNCTION
--   public.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid), private.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid);
--   re-run CREATE OR REPLACE of private.accounting_dispute_offset_ready from 20261113090000_accounting_p3_dispute_offset.sql
--   :73-134 and of private.get_stripe_balance_reconciliation from 20261113100000_accounting_p3_intake_tax_reads.sql :377-.

-- ACC_S24_BODY_BEGIN

CREATE TEMP TABLE accounting_s24_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s24_baseline(payload)
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
    FROM pg_catalog.unnest(ARRAY['private.accounting_dispute_offset_ready(text,uuid,date)',
      'private.get_stripe_balance_reconciliation(date)']) AS s(sig)));

-- 1. The link of a pending row to a manual entry.
CREATE FUNCTION private.admin_link_accounting_pending_entry(_actor_id uuid, _event_id uuid, _entry_id uuid, _note text,
  _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_row public.accounting_pending_events%ROWTYPE;
  v_entry public.accounting_journal_entries%ROWTYPE;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.entries.correct']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _event_id IS NULL OR _entry_id IS NULL OR _request_key IS NULL OR _note IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(_note)) = 0 OR pg_catalog.char_length(_note) > 500 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'link_pending_entry',
    'actor', _actor_id, 'event_id', _event_id, 'entry_id', _entry_id, 'note', _note));
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
  IF v_row.reason <> 'order_not_postable' THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_entry FROM public.accounting_journal_entries AS e WHERE e.id = _entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_LINK_ENTRY_INVALID' USING ERRCODE = '22023', DETAIL = 'link_not_found';
  END IF;
  IF v_entry.event_kind <> 'manual_entry' OR v_entry.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_LINK_ENTRY_INVALID' USING ERRCODE = '22023', DETAIL = 'link_not_manual';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = v_entry.id) THEN
    RAISE EXCEPTION 'ACCOUNTING_LINK_ENTRY_INVALID' USING ERRCODE = '22023', DETAIL = 'link_reversed';
  END IF;
  IF v_row.order_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.accounting_journal_lines AS l WHERE l.entry_id = v_entry.id AND l.order_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_lines AS l
      WHERE l.entry_id = v_entry.id AND l.order_id = v_row.order_id) THEN
    RAISE EXCEPTION 'ACCOUNTING_LINK_ENTRY_INVALID' USING ERRCODE = '22023', DETAIL = 'link_other_order';
  END IF;
  UPDATE public.accounting_pending_events AS p
  SET resolved_at = pg_catalog.now(), resolved_by = _actor_id, resolution_note = _note,
    resolution_request_key = _request_key, resolution_request_hash = v_hash, resolved_entry_id = _entry_id
  WHERE p.id = _event_id;
  RETURN private.accounting_pending_event_json(_event_id);
END;
$$;

CREATE FUNCTION public.admin_link_accounting_pending_entry(_actor_id uuid, _event_id uuid, _entry_id uuid, _note text,
  _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_link_accounting_pending_entry(_actor_id, _event_id, _entry_id, _note, _request_key) $$;

-- 2. The wait of the second kind of C (FREQ-581-AC-05) skips a 0 yen close parked for a person (P3-T8e).
CREATE OR REPLACE FUNCTION private.accounting_dispute_offset_ready(_dispute_id text, _order_id uuid, _lost_on date)
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
-- ACC_P3_REPLACE_BEGIN 4b9d58f2d34ada082fb4acaebb6328b0
            AND ((p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NULL) OR p.reason = 'before_cutover'))
        AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
          WHERE p.event_kind = 'return_amount_decided' AND p.source_table = 'accounting_return_facts' AND p.source_id = a.id::text
            AND p.reason = 'order_not_postable' AND p.detail ->> 'reason' = 'dispute_lost')) THEN
-- ACC_P3_REPLACE_END
    ready := false;
    reason := 'dispute_return_refund_pending';
  END IF;
  RETURN NEXT;
END;
$$;

-- 3. The Stripe balance reconciliation: a refund transaction whose pending row a person closed is done (Task 9 Minor 1).
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
-- ACC_P3_BEGIN
          OR EXISTS (SELECT 1 FROM public.stripe_refunds AS sm
            JOIN public.order_refunds AS rm ON rm.stripe_refund_id = sm.id
            JOIN public.accounting_pending_events AS pm ON pm.source_table = 'order_refunds' AND pm.source_id = rm.id::text
            WHERE pm.resolved_at IS NOT NULL
              AND ((pm.event_kind IN ('pre_shipment_refund', 'return_refund') AND sm.balance_transaction_id = c.id)
                OR (pm.event_kind = 'refund_failed' AND sm.failure_balance_transaction_id = c.id)))
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

ALTER FUNCTION private.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid),
  public.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid),
  public.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid) TO service_role;
-- ACC_S24_BODY_END

-- ACC_S24_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. acc_s24_functions: the link function exists once as a private
-- SECURITY DEFINER plpgsql body and a public SECURITY INVOKER sql entry, VOLATILE, search_path '', owned by postgres, and only
-- service_role runs them. acc_s24_function_attrs: the two rebuilt functions keep their arguments, result, language,
-- volatility, security, owner, search_path and ACL. acc_s24_body_unchanged: the wait of C has 1 replaced part and 0 added
-- blocks, the Stripe reconciliation 0 and 2 (the block of S23 and the one of this file), and each with the replaced part
-- restored (by the md5 on the marker) and every ACC_P<n> block and all white space removed is the body it was copied from
-- (S22, S23). acc_s24_existing_dml_allowlist: this migration writes no row, and the group G writer list is what it was.
DO $acc_s24_final$
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
  v_stage := 'acc_s24_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s24_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s24_baseline) <> 1 THEN
    v_failed := 'acc_s24_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s24_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s24_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s24_functions';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid)', 'plpgsql', true),
      ('public.admin_link_accounting_pending_entry(uuid,uuid,uuid,text,uuid)', 'sql', false)
    ) AS x(signature, lang, secdef)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
          WHERE f.oid = v_oid AND f.prosecdef = e.secdef AND f.provolatile = 'v' AND l.lanname = e.lang AND NOT f.proretset
            AND f.prorettype = 'jsonb'::regtype AND f.proowner = 'postgres'::regrole AND f.prokind = 'f'
            AND f.proconfig = ARRAY['search_path=""']::text[]
            AND pg_catalog.array_to_string(f.proargnames, ',') = '_actor_id,_event_id,_entry_id,_note,_request_key')
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.proname = 'admin_link_accounting_pending_entry'
            AND o.pronamespace = (SELECT f.pronamespace FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid)) <> 1
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee <> f.proowner
            AND NOT (a.grantee = 'service_role'::regrole AND a.privilege_type = 'EXECUTE')) THEN
        v_failed := 'acc_s24_functions';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s24_function_attrs';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'attrs')) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'attrs') AS b(sig, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(b.sig)
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
        f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))) THEN
    v_failed := 'acc_s24_function_attrs';
  END IF;

  v_stage := 'acc_s24_body_unchanged';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_dispute_offset_ready(text,uuid,date)', 1, 0, '5aadb4ec8cf0fc4dc22b183e0b516ec9',
        'p.reason = ''order_not_postable'' AND p.detail ->> ''reason'' = ''dispute_lost'''),
      ('private.get_stripe_balance_reconciliation(date)', 0, 2, '19017665c51c40ddd8733fc3e6c80807',
        'pm.event_kind = ''refund_failed'' AND sm.failure_balance_transaction_id = c.id|WHERE pm.resolved_at IS NOT NULL')
    ) AS x(signature, replaced, added, digest, needle)
    LOOP
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF v_src IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(e.needle, '|')) AS n(part)
          WHERE pg_catalog.strpos(v_src, n.part) = 0)
        OR v_src ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M'
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_REPLACE_BEGIN', 'g')) <> e.replaced
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_BEGIN', 'g')) <> e.added THEN
        v_failed := 'acc_s24_body_unchanged';
        EXIT;
      END IF;
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('4b9d58f2d34ada082fb4acaebb6328b0', $acc_s24_o1$            AND ((p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NULL) OR p.reason = 'before_cutover'))) THEN
$acc_s24_o1$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s24_body_unchanged';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
        v_original := NULL;
      END LOOP;
      IF v_failed IS NULL AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM e.digest THEN
        v_failed := 'acc_s24_body_unchanged';
      END IF;
      EXIT WHEN v_failed IS NOT NULL;
    END LOOP;
  END IF;

  v_stage := 'acc_s24_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline #>> '{counts,entries}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline #>> '{counts,lines}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline #>> '{counts,pending_events}')::bigint
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc))
      IS DISTINCT FROM (v_baseline -> 'allowlist')) THEN
    v_failed := 'acc_s24_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s24_functions'), HINT = SQLSTATE;
END;
$acc_s24_final$;
-- ACC_S24_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
