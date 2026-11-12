BEGIN;
-- Accounting plan 3 S20 (FREQ-577 AC-01..AC-03/AC-05/AC-07/AC-09/AC-10, FREQ-579 AC-01..AC-08, FREQ-562-AC-05,
-- FREQ-569 AC-01/AC-02): the refund posting, the bank transfer repayment, the owed-refund settle and its table, the read of
-- refunds waiting for a cancel decision or still owed, and the posting entry point that now calls the refund poster.
--
-- New:
--   public.accounting_refund_settlements (append only; RLS on; service_role may SELECT only).
--   private.accounting_refund_pair / accounting_refund_lines   one builder of the refund lines (success, owed, abandon, settle,
--     bank transfer). Every line carries the order.
--   private.accounting_order_account_balance                   credit - debit of an account (and sub account) of an order.
--   private.accounting_refund_first_adjust                     d of rule 3-2 for the first refund of its event.
--   private.accounting_refund_wait                             return_prior / original, the only two waits.
--   private.accounting_post_refund_events(_limit integer DEFAULT 50) RETURNS jsonb
--     {posted, parked_new, reparked, resolved, reversed}; no entry point. The amounts come from the refund's own fact (P, Q, F,
--     shipping) and the balance transaction only; no other refund's balance is read (a retry refund that shares an event
--     with a failed one has its own fact, so its amount is counted once).
--   admin_record_refund_bank_transfer / admin_settle_owed_by_refund / list_refund_accounting_states (private body and
--     public entry, service_role only).
--   The request key of a bank transfer is kept in the admin_requests of the period that holds the entry (the plan-1 store
--   read by private.accounting_request_replay); the brief names no other place.
-- Rebuilt (CREATE OR REPLACE; the latest definition copied as it is, new text between ACC_P3_BEGIN and ACC_P3_END, the
-- replaced text between ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END; arguments, result,
-- attributes, owner and ACL are unchanged):
--   private.accounting_run_posting (plan 2 S11, 20261108200000:1007-1036): the refund poster runs after the Stripe poster and
--     before the dispute poster; the result gets refunds and returns (0 until Task 7), and the parked, resolved and has_more
--     sums count the refund poster too.
-- Labels (ACCOUNTING_LABELS, from scripts/accounting/emit-labels.ts):
--   refundPreShipment: U&'\51FA\8377\524D\306E\8FD4\91D1'
--   refundReturn: U&'\8FD4\54C1\306E\8FD4\91D1'
--   refundAfterShipment: U&'\51FA\8377\5F8C\306E\8FD4\91D1\30FB\5024\5F15\304D'
--   refundOwed: U&'\8FD4\91D1\306E\672A\6255\3044'
--   refundBankTransfer: U&'\632F\8FBC\3067\306E\8FD4\91D1'
--   refundCancelled: U&'\8FD4\91D1\306E\53D6\308A\6D88\3057'
--   returnFeeRevenue: U&'\8FD4\54C1\306E\624B\6570\6599'
--
-- ROLLBACK (only while no entry of the kinds pre_shipment_refund, return_refund, refund_failed or refund_abandoned exists):
--   re-run CREATE OR REPLACE FUNCTION private.accounting_run_posting from 20261108200000_accounting_p2_dispute_posting.sql
--     :1007-1036;
--   DROP FUNCTION public.list_refund_accounting_states(integer,timestamptz,uuid),
--     private.list_refund_accounting_states(integer,timestamptz,uuid),
--     public.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid), private.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid),
--     public.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid),
--     private.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid),
--     private.accounting_post_refund_events(integer), private.accounting_refund_wait(uuid,text),
--     private.accounting_refund_first_adjust(uuid,bigint), private.accounting_order_account_balance(uuid,text,text),
--     private.accounting_refund_lines(text,uuid,bigint,bigint,bigint,bigint,boolean),
--     private.accounting_refund_pair(text,text,text,text,bigint,uuid,text);
--   DROP TABLE public.accounting_refund_settlements;

-- ACC_S20_BODY_BEGIN

CREATE TEMP TABLE accounting_s20_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s20_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', pg_catalog.jsonb_build_object(
    'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
    'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
    'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
    'refund_events', (SELECT pg_catalog.count(*) FROM public.accounting_refund_events),
    'period_requests', (SELECT COALESCE(pg_catalog.sum((SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p.admin_requests))), 0)
      FROM public.accounting_periods AS p)),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(n.nspname, pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))
    FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n ON n.oid = f.pronamespace
    WHERE f.oid IN ('private.accounting_run_posting(integer)'::regprocedure, 'public.accounting_run_posting(integer)'::regprocedure)));

-- 1. The settle rows (one per paying refund). Append only, like the Task 1 tables.
CREATE TABLE public.accounting_refund_settlements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  owed_refund_id uuid NOT NULL,
  paying_refund_id uuid NOT NULL,
  pre_amount integer NOT NULL,
  post_amount integer NOT NULL,
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_refund_settlements_pkey PRIMARY KEY (id),
  CONSTRAINT accounting_refund_settlements_owed_refund_id_fkey FOREIGN KEY (owed_refund_id)
    REFERENCES public.order_refunds (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_refund_settlements_paying_refund_id_fkey FOREIGN KEY (paying_refund_id)
    REFERENCES public.order_refunds (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_refund_settlements_request_key_key UNIQUE (request_key),
  CONSTRAINT accounting_refund_settlements_paying_refund_id_key UNIQUE (paying_refund_id),
  CONSTRAINT accounting_refund_settlements_pre_amount_check CHECK (pre_amount >= 0),
  CONSTRAINT accounting_refund_settlements_post_amount_check CHECK (post_amount >= 0)
);
ALTER TABLE public.accounting_refund_settlements OWNER TO postgres;
ALTER TABLE public.accounting_refund_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_refund_settlements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.accounting_refund_settlements TO service_role;
CREATE TRIGGER accounting_refund_settlements_no_update_delete BEFORE UPDATE OR DELETE
  ON public.accounting_refund_settlements FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_refund_settlements_no_truncate BEFORE TRUNCATE
  ON public.accounting_refund_settlements FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.accounting_refund_settlements ENABLE ALWAYS TRIGGER accounting_refund_settlements_no_update_delete;
ALTER TABLE public.accounting_refund_settlements ENABLE ALWAYS TRIGGER accounting_refund_settlements_no_truncate;

-- 2. Tools. A pair of lines: debit / credit of _amount (the other way round when negative, nothing when 0), with the order.
CREATE FUNCTION private.accounting_refund_pair(_debit text, _debit_sub text, _credit text, _credit_sub text, _amount bigint,
  _order_id uuid, _memo text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN COALESCE(_amount, 0) = 0 THEN '[]'::jsonb
    WHEN _amount > 0 THEN pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code', _debit, 'debit', _amount, 'credit', 0, 'sub_account', _debit_sub,
        'order_id', _order_id::text, 'memo', _memo),
      pg_catalog.jsonb_build_object('account_code', _credit, 'debit', 0, 'credit', _amount, 'sub_account', _credit_sub,
        'order_id', _order_id::text, 'memo', _memo))
    ELSE pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code', _credit, 'debit', -_amount, 'credit', 0, 'sub_account', _credit_sub,
        'order_id', _order_id::text, 'memo', _memo),
      pg_catalog.jsonb_build_object('account_code', _debit, 'debit', 0, 'credit', -_amount, 'sub_account', _debit_sub,
        'order_id', _order_id::text, 'memo', _memo))
  END
$$;

-- The lines of every refund entry (one builder, Step 3). _plain is a return refund that is not a hold-back release or a
-- pre-shipment cancel: its Q goes through 2130 return_refund (the arrival entry raised it). Modes:
--   success_pre   2150 / 1160 P, and 2150 / 4010 d
--   success_post  2130 return_refund (plain) or 4020 / 1160 Q, and 4020 / 4050 F (memo returnFeeRevenue; not plain)
--   owed_unpulled 2150 / 2130 refund_owed_pre P, 2150 / 4010 d, and 4020 / 2130 refund_owed_post Q (not plain)
--   owed_pulled   1160 / 2130 refund_owed_pre P, and 1160 / 2130 refund_owed_post (return_refund when plain) Q
--   abandon       2150 / 4010 s (_pre), and 2150 / 4010 d
--   settle        2130 refund_owed_pre / 2150 P, and 2130 refund_owed_post / 4020 Q
--   bank_pre_shipment / bank_post_shipment / bank_return   2130 (refund_owed_pre / refund_owed_post / return_refund) / 1040
CREATE FUNCTION private.accounting_refund_lines(_mode text, _order_id uuid, _pre bigint, _post bigint, _adjust bigint,
  _fee bigint, _plain boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN CASE _mode
    WHEN 'success_pre' THEN
      private.accounting_refund_pair('2150', NULL, '1160', NULL, _pre, _order_id)
      || private.accounting_refund_pair('2150', NULL, '4010', NULL, _adjust, _order_id)
    WHEN 'success_post' THEN
      CASE WHEN _plain THEN private.accounting_refund_pair('2130', 'return_refund', '1160', NULL, _post, _order_id)
        ELSE private.accounting_refund_pair('4020', NULL, '1160', NULL, _post, _order_id)
          || private.accounting_refund_pair('4020', NULL, '4050', NULL, _fee, _order_id, U&'\8FD4\54C1\306E\624B\6570\6599') END
    WHEN 'owed_unpulled' THEN
      private.accounting_refund_pair('2150', NULL, '2130', 'refund_owed_pre', _pre, _order_id)
      || private.accounting_refund_pair('2150', NULL, '4010', NULL, _adjust, _order_id)
      || CASE WHEN _plain THEN '[]'::jsonb
        ELSE private.accounting_refund_pair('4020', NULL, '2130', 'refund_owed_post', _post, _order_id) END
    WHEN 'owed_pulled' THEN
      private.accounting_refund_pair('1160', NULL, '2130', 'refund_owed_pre', _pre, _order_id)
      || private.accounting_refund_pair('1160', NULL, '2130', CASE WHEN _plain THEN 'return_refund' ELSE 'refund_owed_post' END,
        _post, _order_id)
    WHEN 'abandon' THEN
      private.accounting_refund_pair('2150', NULL, '4010', NULL, _pre, _order_id)
      || private.accounting_refund_pair('2150', NULL, '4010', NULL, _adjust, _order_id)
    WHEN 'settle' THEN
      private.accounting_refund_pair('2130', 'refund_owed_pre', '2150', NULL, _pre, _order_id)
      || private.accounting_refund_pair('2130', 'refund_owed_post', '4020', NULL, _post, _order_id)
    WHEN 'bank_pre_shipment' THEN private.accounting_refund_pair('2130', 'refund_owed_pre', '1040', NULL, _pre, _order_id)
    WHEN 'bank_post_shipment' THEN private.accounting_refund_pair('2130', 'refund_owed_post', '1040', NULL, _pre, _order_id)
    WHEN 'bank_return' THEN private.accounting_refund_pair('2130', 'return_refund', '1040', NULL, _pre, _order_id)
    ELSE NULL END;
END;
$$;

-- Credit - debit of an account of one order (all entries, reversals included); _sub NULL counts every sub account.
CREATE FUNCTION private.accounting_order_account_balance(_order_id uuid, _account text, _sub text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0)::bigint FROM public.accounting_journal_lines AS l
  WHERE l.order_id = _order_id AND l.account_code = _account AND (_sub IS NULL OR l.sub_account = _sub)
$$;

-- d of rule 3-2: the transfer adjusts of the refund's pre-shipment cancel event written before the state row (_before_seq),
-- for the first refund of the event only (no other refund of the event was requested before it; the same test as the
-- cancel decision). 0 for any other refund.
CREATE FUNCTION private.accounting_refund_first_adjust(_refund_id uuid, _before_seq bigint) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM public.order_unit_event_refunds AS er
        JOIN public.accounting_refund_events AS x ON x.refund_id = er.refund_id AND x.state = 'requested'
        WHERE er.event_id = f.event_id AND er.refund_id <> _refund_id
          AND x.fact_seq < COALESCE((SELECT y.fact_seq FROM public.accounting_refund_events AS y
            WHERE y.refund_id = _refund_id AND y.state = 'requested'), 0))
      THEN (SELECT COALESCE(pg_catalog.sum(t.amount), 0) FROM public.accounting_refund_transfer_adjusts AS t
        WHERE t.event_id = f.event_id AND t.fact_seq < _before_seq)
      ELSE 0 END
    FROM public.accounting_refund_facts AS f
    WHERE f.refund_id = _refund_id AND f.event_kind = 'pre_shipment_cancel' AND f.event_id IS NOT NULL), 0)::integer
$$;

-- The two waits of the refund posting (Step 3; the amounts never read another refund). 'success': a return refund (not a
-- hold-back release or a pre-shipment cancel) waits for the arrival entries of its return (arrivals before its decision)
-- and the entries of the decisions with a payable change (up to its own decision): return_prior. Any other step (a failure
-- or a cancel after the money was taken) waits for the success of the same refund: original. NULL when nothing is missing.
CREATE FUNCTION private.accounting_refund_wait(_refund_id uuid, _step text) RETURNS text
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
              AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
                WHERE e.dedupe_key = private.accounting_event_key('return_amount_decided', ARRAY[a.id::text]))))) THEN
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

-- 3. The refund poster. Steps of a refund (its state rows; a refund without a fact, a legacy one, is never looked at):
--   success    a succeeded row and the balance transaction of the Stripe refund: pre_shipment_refund:[txn] (P, d) and
--              return_refund:[txn] (Q, F), on the Japanese day of the transaction.
--   failure    a failed row (else an owed row): refund_failed:[refund, row]. Not taken yet: on the day of the row (a plain
--              return refund books nothing). Taken: on the day of the failure transaction, after the success entry.
--   undecided  a canceled row without a decision: parked as refund_cancel_undecided (closed when the decision comes).
--   abandon    an abandoned row: taken: the success entries are reversed on the day of the failure transaction; s and the
--              carried d go to refund_abandoned:[refund, row]; nothing to book closes as no_revenue.
-- New events (no entry and no parked row of their step) are taken oldest state row first, at most _limit; then at most 10
-- open parked rows, oldest last_detected_at first. Each event is one BEGIN ... EXCEPTION block (plan 2).
CREATE FUNCTION private.accounting_post_refund_events(_limit integer DEFAULT 50) RETURNS jsonb
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
      v_plain := v_fact.source = 'return' AND v_fact.event_kind NOT IN ('holdback_release', 'pre_shipment_cancel');
      SELECT s.* INTO v_sr FROM public.stripe_refunds AS s WHERE s.id = v_refund.stripe_refund_id;
      -- Taken: the Stripe refund has its balance transaction, or a success was recorded before (its transaction may come
      -- later; the failure and the cancel then wait for it instead of booking a debt that was never taken).
      v_pulled := v_sr.balance_transaction_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM public.accounting_refund_events AS x WHERE x.refund_id = v_refund.id AND x.state = 'succeeded');
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

      ELSIF v_job.step = 'failure' AND NOT v_pulled THEN
        v_date := private.accounting_jst_date(v_row.occurred_at);
        v_at := LEAST(v_row.occurred_at, pg_catalog.clock_timestamp());
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
        IF v_pulled THEN
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
          v_date := private.accounting_jst_date(v_row.occurred_at);
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

-- 4. The posting entry point. CREATE OR REPLACE with the latest definition (plan 2 S11) copied as it is.
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
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_payments := private.accounting_post_payment_events(_limit);
  v_shipments := private.accounting_post_shipment_events(_limit);
  v_stripe := private.accounting_post_stripe_events(_limit);
-- ACC_P3_BEGIN
  v_refunds := private.accounting_post_refund_events(_limit);
-- ACC_P3_END
  v_disputes := private.accounting_post_dispute_events(_limit);
-- ACC_P3_REPLACE_BEGIN aa709b104ede79962fa51e4bfeaac07d
  RETURN pg_catalog.jsonb_build_object(
    'payments', (v_payments ->> 'posted')::integer, 'shipments', (v_shipments ->> 'posted')::integer,
    'stripe', (v_stripe ->> 'posted')::integer, 'disputes', (v_disputes ->> 'posted')::integer,
    'refunds', (v_refunds ->> 'posted')::integer, 'returns', 0,
    'parked', (v_payments ->> 'parked_new')::integer + (v_payments ->> 'reparked')::integer
      + (v_shipments ->> 'parked_new')::integer + (v_shipments ->> 'reparked')::integer
      + (v_stripe ->> 'parked_new')::integer + (v_stripe ->> 'reparked')::integer
      + (v_refunds ->> 'parked_new')::integer + (v_refunds ->> 'reparked')::integer
      + (v_disputes ->> 'parked_new')::integer + (v_disputes ->> 'reparked')::integer,
    'resolved', (v_payments ->> 'resolved')::integer + (v_shipments ->> 'resolved')::integer
      + (v_stripe ->> 'resolved')::integer + (v_refunds ->> 'resolved')::integer + (v_disputes ->> 'resolved')::integer,
    'has_more', ((v_payments ->> 'posted')::integer + (v_payments ->> 'parked_new')::integer
      + (v_shipments ->> 'posted')::integer + (v_shipments ->> 'parked_new')::integer
      + (v_stripe ->> 'posted')::integer + (v_stripe ->> 'parked_new')::integer
      + (v_refunds ->> 'posted')::integer + (v_refunds ->> 'parked_new')::integer
      + (v_disputes ->> 'posted')::integer + (v_disputes ->> 'parked_new')::integer) >= _limit);
-- ACC_P3_REPLACE_END
END;
$$;

-- 5. The bank transfer repayment (5-d, 1-a07): the shop paid an owed refund (or a return refund waiting) by bank. The key
--    is bank-<number>.<origin>; the same number and origin again adds nothing (the core answers created false) and other
--    content is ACCOUNTING_DEDUPE_CONTENT_MISMATCH. The request key lives in the admin_requests of the entry's period.
CREATE FUNCTION private.admin_record_refund_bank_transfer(_actor_id uuid, _order_id uuid, _origin text, _amount bigint,
  _bank_date date, _bank_txn_no text, _note text, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior jsonb;
  v_cutover date;
  v_confirmed date;
  v_kind text;
  v_sub text;
  v_parts text[];
  v_period uuid;
  v_note text;
  v_result jsonb;
  v_label CONSTANT text := U&'\632F\8FBC\3067\306E\8FD4\91D1';
BEGIN
  IF NOT COALESCE(private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.finance.manage']), false) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_note := NULLIF(pg_catalog.btrim(_note), '');
  IF _order_id IS NULL OR _origin IS NULL OR _origin NOT IN ('pre_shipment', 'post_shipment', 'return')
    OR _amount IS NULL OR _amount < 1 OR _amount > 9007199254740991 OR _bank_date IS NULL OR _request_key IS NULL
    OR _bank_txn_no IS NULL OR _bank_txn_no !~ '^[A-Za-z0-9_-]{1,100}$' OR pg_catalog.char_length(_note) > 500
    OR _bank_date > private.accounting_jst_date(pg_catalog.clock_timestamp()) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'record_refund_bank_transfer',
    'actor', _actor_id, 'order_id', _order_id, 'origin', _origin, 'amount', _amount, 'bank_date', _bank_date,
    'bank_txn_no', _bank_txn_no, 'note', _note));
  v_prior := private.accounting_request_replay(_request_key, v_hash);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders AS o WHERE o.id = _order_id) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_cutover := private.accounting_cutover_on();
  IF v_cutover IS NOT NULL AND _bank_date < v_cutover THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_confirmed := private.accounting_order_dispute_confirmed_on(_order_id);
  IF v_confirmed IS NOT NULL AND _bank_date <= v_confirmed THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023', DETAIL = 'dispute_confirmed';
  END IF;
  v_kind := CASE WHEN _origin = 'pre_shipment' THEN 'pre_shipment_refund' ELSE 'return_refund' END;
  v_sub := CASE _origin WHEN 'pre_shipment' THEN 'refund_owed_pre' WHEN 'post_shipment' THEN 'refund_owed_post'
    ELSE 'return_refund' END;
  v_parts := ARRAY['bank-' || _bank_txn_no || '.' || _origin];
  v_period := private.accounting_period_for_event(_bank_date, _actor_id);
  -- A key seen before goes to the core as it is (created false, or DEDUPE_CONTENT_MISMATCH); a new one must fit the
  -- payable of the order (no entry yet means nothing is owed).
  IF NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
      WHERE e.dedupe_key = private.accounting_event_key(v_kind, v_parts))
    AND private.accounting_order_account_balance(_order_id, '2130', v_sub) < _amount THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  v_result := private.accounting_post_journal_core(_actor_id, v_period, _bank_date, v_kind, v_parts,
    CASE WHEN v_note IS NULL THEN v_label ELSE v_label || ' / ' || v_note END,
    private.accounting_refund_lines('bank_' || _origin, _order_id, _amount, 0, 0, 0, false));
  UPDATE public.accounting_periods AS p SET admin_requests = p.admin_requests || pg_catalog.jsonb_build_object(
    _request_key::text, pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result))
  WHERE p.id = (v_result ->> 'period_id')::uuid;
  RETURN v_result;
END;
$$;

-- 6. The settle of an owed refund by a retry refund (owed debt 2): the smaller of what the owed refund still owes and what the
--    retry paid, side by side (pre / post), within the order's payable of that side. The entry gives the deferred revenue
--    (pre) and the returns account (post) back on the day of the retry's balance transaction.
CREATE FUNCTION private.admin_settle_owed_by_refund(_actor_id uuid, _owed_refund_id uuid, _paying_refund_id uuid,
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

-- 7. The read of refunds waiting for the cancel decision or still owing (no name, no mail). owed_pre / owed_post: what the
--    refund's owed entries raised, less its settles, within the order's payable of that side. Newest first by
--    (created_at, id); the next page starts after the pair of the last row (both or none).
CREATE FUNCTION private.list_refund_accounting_states(_limit integer DEFAULT 50, _after_at timestamptz DEFAULT NULL,
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
    SELECT s.* FROM s WHERE s.undecided OR s.owed_pre > 0 OR s.owed_post > 0
    ORDER BY s.created_at DESC, s.id DESC LIMIT _limit
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('refund_id', q.id, 'order_id', q.order_id,
      'order_number', 'ORD-' || pg_catalog.upper(pg_catalog.left(q.order_id::text, 8)), 'source', q.source,
      'state', CASE WHEN q.undecided THEN 'canceled' ELSE q.state END, 'pre_amount', q.pre_shipment_amount,
      'post_amount', q.post_shipment_amount, 'owed_pre', q.owed_pre, 'owed_post', q.owed_post, 'canceled_at', q.canceled_at)
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

-- 8. Entries (SQL INVOKER, the same name in public).
CREATE FUNCTION public.admin_record_refund_bank_transfer(_actor_id uuid, _order_id uuid, _origin text, _amount bigint,
  _bank_date date, _bank_txn_no text, _note text, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_record_refund_bank_transfer(_actor_id, _order_id, _origin, _amount, _bank_date, _bank_txn_no, _note, _request_key) $$;
CREATE FUNCTION public.admin_settle_owed_by_refund(_actor_id uuid, _owed_refund_id uuid, _paying_refund_id uuid,
  _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_settle_owed_by_refund(_actor_id, _owed_refund_id, _paying_refund_id, _request_key) $$;
CREATE FUNCTION public.list_refund_accounting_states(_limit integer DEFAULT 50, _after_at timestamptz DEFAULT NULL,
  _after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_refund_accounting_states(_limit, _after_at, _after_id) $$;

ALTER FUNCTION private.accounting_refund_pair(text,text,text,text,bigint,uuid,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_refund_lines(text,uuid,bigint,bigint,bigint,bigint,boolean) OWNER TO postgres;
ALTER FUNCTION private.accounting_order_account_balance(uuid,text,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_refund_first_adjust(uuid,bigint) OWNER TO postgres;
ALTER FUNCTION private.accounting_refund_wait(uuid,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_refund_events(integer) OWNER TO postgres;
ALTER FUNCTION private.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION private.list_refund_accounting_states(integer,timestamptz,uuid) OWNER TO postgres;
ALTER FUNCTION public.list_refund_accounting_states(integer,timestamptz,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_refund_pair(text,text,text,text,bigint,uuid,text),
  private.accounting_refund_lines(text,uuid,bigint,bigint,bigint,bigint,boolean),
  private.accounting_order_account_balance(uuid,text,text), private.accounting_refund_first_adjust(uuid,bigint),
  private.accounting_refund_wait(uuid,text), private.accounting_post_refund_events(integer),
  private.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid),
  public.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid),
  private.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid), public.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid),
  private.list_refund_accounting_states(integer,timestamptz,uuid), public.list_refund_accounting_states(integer,timestamptz,uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid),
  public.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid),
  private.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid), public.admin_settle_owed_by_refund(uuid,uuid,uuid,uuid),
  private.list_refund_accounting_states(integer,timestamptz,uuid), public.list_refund_accounting_states(integer,timestamptz,uuid)
TO service_role;
-- ACC_S20_BODY_END

-- ACC_S20_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. The rebuilt entry point is compared after its replaced part is
-- restored from the list below (by the md5 on the marker) and every ACC_P<n> block and all white space are removed.
DO $acc_s20_final$
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
    'private.accounting_refund_pair(text,text,text,text,bigint,uuid,text)',
    'private.accounting_refund_lines(text,uuid,bigint,bigint,bigint,bigint,boolean)',
    'private.accounting_order_account_balance(uuid,text,text)', 'private.accounting_refund_first_adjust(uuid,bigint)',
    'private.accounting_refund_wait(uuid,text)', 'private.accounting_post_refund_events(integer)'];
  v_entries CONSTANT text[] := ARRAY[
    'admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid)',
    'admin_settle_owed_by_refund(uuid,uuid,uuid,uuid)', 'list_refund_accounting_states(integer,timestamptz,uuid)'];
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s20_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s20_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s20_baseline) <> 1 THEN
    v_failed := 'acc_s20_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s20_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s20_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s20_tables';
  -- acc_s20_tables: the settle table has its columns and constraints, RLS on, and refuses UPDATE, DELETE and TRUNCATE
  -- always.
  IF v_failed IS NULL AND (
    pg_catalog.to_regclass('public.accounting_refund_settlements') IS NULL
    OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
        || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END, ', ' ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = 'public.accounting_refund_settlements'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
      IS DISTINCT FROM 'id uuid not null, owed_refund_id uuid not null, paying_refund_id uuid not null, pre_amount integer not null, '
        || 'post_amount integer not null, actor_id uuid not null, request_key uuid not null, request_hash text not null, '
        || 'created_at timestamp with time zone not null'
    OR (SELECT pg_catalog.string_agg(c.conname::text || ' ' || c.contype::text || ' ' || pg_catalog.pg_get_constraintdef(c.oid), E'\n' ORDER BY c.conname)
      FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = 'public.accounting_refund_settlements'::regclass)
      IS DISTINCT FROM E'accounting_refund_settlements_owed_refund_id_fkey f FOREIGN KEY (owed_refund_id) REFERENCES public.order_refunds(id) ON DELETE RESTRICT\n'
        || E'accounting_refund_settlements_paying_refund_id_fkey f FOREIGN KEY (paying_refund_id) REFERENCES public.order_refunds(id) ON DELETE RESTRICT\n'
        || E'accounting_refund_settlements_paying_refund_id_key u UNIQUE (paying_refund_id)\n'
        || E'accounting_refund_settlements_pkey p PRIMARY KEY (id)\n'
        || E'accounting_refund_settlements_post_amount_check c CHECK ((post_amount >= 0))\n'
        || E'accounting_refund_settlements_pre_amount_check c CHECK ((pre_amount >= 0))\n'
        || 'accounting_refund_settlements_request_key_key u UNIQUE (request_key)'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.accounting_refund_settlements'::regclass
      AND c.relrowsecurity AND c.relowner = 'postgres'::regrole)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.accounting_refund_settlements'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'A'
        AND t.tgfoid = 'private.reject_accounting_mutation()'::regprocedure
        AND t.tgname IN ('accounting_refund_settlements_no_update_delete', 'accounting_refund_settlements_no_truncate')) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.accounting_refund_settlements'::regclass AND NOT t.tgisinternal) <> 2) THEN
    v_failed := 'acc_s20_tables';
  END IF;

  v_stage := 'acc_s20_rls_acl';
  -- acc_s20_rls_acl: only service_role may read the settle table (besides the owner); no policy.
  IF v_failed IS NULL AND (
    (SELECT COALESCE(pg_catalog.string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text, a.privilege_type), '')
      FROM pg_catalog.pg_class AS c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS a
      WHERE c.oid = 'public.accounting_refund_settlements'::regclass AND a.grantee <> c.relowner) IS DISTINCT FROM 'service_role:SELECT'
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS p WHERE p.polrelid = 'public.accounting_refund_settlements'::regclass)) THEN
    v_failed := 'acc_s20_rls_acl';
  END IF;

  v_stage := 'acc_s20_functions';
  -- acc_s20_functions: the tools and bodies are private, SECURITY DEFINER with search_path '', owned by postgres; nobody runs
  -- the tools; only service_role runs the three bodies and their public entries (SQL, SECURITY INVOKER, one call).
  IF v_failed IS NULL THEN
    FOREACH v_sig IN ARRAY v_tools || ARRAY(SELECT 'private.' || e FROM pg_catalog.unnest(v_entries) AS e) LOOP
      v_oid := pg_catalog.to_regprocedure(v_sig);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid AND f.prosecdef
          AND f.proowner = 'postgres'::regrole AND f.proconfig = ARRAY['search_path=""']) THEN
        v_failed := 'acc_s20_functions';
        EXIT;
      END IF;
      FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF pg_catalog.has_function_privilege(v_role, v_oid, 'EXECUTE') <> (v_role = 'service_role' AND NOT (v_sig = ANY (v_tools))) THEN
          v_failed := 'acc_s20_functions';
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee = 0) THEN
        v_failed := 'acc_s20_functions';
      END IF;
      EXIT WHEN v_failed IS NOT NULL;
    END LOOP;
  END IF;
  IF v_failed IS NULL THEN
    FOREACH v_sig IN ARRAY v_entries LOOP
      v_oid := pg_catalog.to_regprocedure('public.' || v_sig);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
          WHERE f.oid = v_oid AND NOT f.prosecdef AND l.lanname = 'sql' AND f.proowner = 'postgres'::regrole
            AND f.proconfig = ARRAY['search_path=""']
            AND pg_catalog.btrim(f.prosrc) ~ ('^SELECT private\.' || pg_catalog.split_part(v_sig, '(', 1) || '\([^;]*\)$'))
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee = 0) THEN
        v_failed := 'acc_s20_functions';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s20_function_attrs';
  -- acc_s20_function_attrs: the entry point (private body and public entry) keeps its arguments, result, language,
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
    v_failed := 'acc_s20_function_attrs';
  END IF;

  v_stage := 'acc_s20_run_posting';
  -- acc_s20_run_posting: the entry point calls payment, shipment, Stripe, refund and dispute in that order, returns
  -- refunds and returns (0), sums the refund poster into has_more, and with its replaced part restored and every ACC_P<n>
  -- block and all white space removed is the latest definition. The public entry is one call.
  IF v_failed IS NULL THEN
    SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = 'private.accounting_run_posting(integer)'::regprocedure;
    IF v_src IS NULL
      OR NOT (pg_catalog.strpos(v_src, 'private.accounting_post_payment_events(_limit)') > 0
        AND pg_catalog.strpos(v_src, 'private.accounting_post_payment_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_shipment_events(_limit)')
        AND pg_catalog.strpos(v_src, 'private.accounting_post_shipment_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_stripe_events(_limit)')
        AND pg_catalog.strpos(v_src, 'private.accounting_post_stripe_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_refund_events(_limit)')
        AND pg_catalog.strpos(v_src, 'private.accounting_post_refund_events(_limit)') < pg_catalog.strpos(v_src, 'private.accounting_post_dispute_events(_limit)'))
      OR pg_catalog.strpos(v_src, '''refunds'', (v_refunds ->> ''posted'')::integer, ''returns'', 0,') = 0
      OR pg_catalog.strpos(pg_catalog.substr(v_src, pg_catalog.strpos(v_src, '''has_more''')),
        '+ (v_refunds ->> ''posted'')::integer + (v_refunds ->> ''parked_new'')::integer') = 0
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_REPLACE_BEGIN', 'g')) <> 1
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_BEGIN', 'g')) <> 2 THEN
      v_failed := 'acc_s20_run_posting';
    ELSE
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('aa709b104ede79962fa51e4bfeaac07d', $acc_s20_orig$  RETURN pg_catalog.jsonb_build_object(
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
$acc_s20_orig$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s20_run_posting';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
        v_original := NULL;
      END LOOP;
      IF v_failed IS NULL AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM 'ed92db40a73e640f5886bd94abc322a5' THEN
        v_failed := 'acc_s20_run_posting';
      END IF;
      IF v_failed IS NULL AND pg_catalog.btrim((SELECT f.prosrc FROM pg_catalog.pg_proc AS f
          WHERE f.oid = 'public.accounting_run_posting(integer)'::regprocedure)) IS DISTINCT FROM 'SELECT private.accounting_run_posting(_limit)' THEN
        v_failed := 'acc_s20_run_posting';
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s20_reads_stable';
  -- acc_s20_reads_stable: the read (body and entry) is STABLE, writes nothing, takes no row lock and names no personal column.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid IN ('private.list_refund_accounting_states(integer,timestamptz,uuid)'::regprocedure,
        'public.list_refund_accounting_states(integer,timestamptz,uuid)'::regprocedure)
        AND (f.provolatile <> 's'
          OR f.prosrc ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M'
          OR f.prosrc ~* '(raw_payload|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address)')) THEN
    v_failed := 'acc_s20_reads_stable';
  END IF;

  v_stage := 'acc_s20_existing_dml_allowlist';
  -- acc_s20_existing_dml_allowlist: this migration writes no row, and the group G writer list is what it was.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline #>> '{counts,entries}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline #>> '{counts,lines}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline #>> '{counts,pending_events}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_events) IS DISTINCT FROM (v_baseline #>> '{counts,refund_events}')::bigint
    OR (SELECT COALESCE(pg_catalog.sum((SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p.admin_requests))), 0)
      FROM public.accounting_periods AS p) IS DISTINCT FROM (v_baseline #>> '{counts,period_requests}')::numeric
    -- The table is new, so it starts empty (counts.settlements is absent and means 0).
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_settlements)
      IS DISTINCT FROM COALESCE((v_baseline #>> '{counts,settlements}')::bigint, 0)
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc))
      IS DISTINCT FROM (v_baseline -> 'allowlist')) THEN
    v_failed := 'acc_s20_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s20_functions'), HINT = SQLSTATE;
END;
$acc_s20_final$;
-- ACC_S20_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
