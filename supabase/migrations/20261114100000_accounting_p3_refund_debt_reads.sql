BEGIN;
-- Accounting plan 3 S25 (Ruling P3-T11e, P3-T11f; FREQ-579-AC-04, FREQ-579-AC-05): the read of refunds waiting for a decision or
-- still owing also says which unit event each refund belongs to and lists the plain return refunds that still owe; and a
-- read lists the refunds that can pay an owed refund off (admin_settle_owed_by_refund takes them as they are).
--
-- Rebuilt (CREATE OR REPLACE; the latest definition copied as it is, new text between ACC_P3_BEGIN and ACC_P3_END, the
-- replaced text between ACC_P3_REPLACE_BEGIN <md5 of the original> and ACC_P3_REPLACE_END; arguments, result, attributes,
-- owner and ACL are unchanged; the public entry is not touched):
--   private.list_refund_accounting_states (only definition: S20 20261112214341:907-966): every row gets event_id and
--     event_kind (accounting_refund_facts, already joined) and owed_return (P3-T11f): for a plain return refund (source
--     return, event kind not holdback_release or pre_shipment_cancel) whose last state is owed or failed, the 2130
--     return_refund balance of the order, never below 0 and never above the refund's own post-shipment amount, less the
--     amounts of the return-origin refunds of the order still in flight at Stripe (order_refunds.status awaiting_response or
--     pending, the open_total test of the refundable amount); 0 for every other row. A row with owed_return above 0 is
--     listed too (Ruling P3-T11i).
--   private.admin_record_refund_bank_transfer (only definition: S20 20261112214341:736-802): for origin return, a new key is
--     refused with ACCOUNTING_REFUND_IN_FLIGHT / 55000 while a return-origin refund of the order is in flight (status
--     awaiting_response or pending), before the balance check. Else unchanged; arguments, result, attributes, owner and ACL
--     are unchanged and the public entry is not touched. Without it, a transfer recorded while a Stripe refund is still
--     processing would pay the customer twice when that refund succeeds.
-- New (STABLE; private body SECURITY DEFINER, public entry SECURITY INVOKER; service_role only):
--   private/public.list_refund_settle_candidates(_owed_refund_id uuid) RETURNS jsonb  {"candidates": [...]}
--     The refunds of the order of the owed refund that admin_settle_owed_by_refund would take as the paying refund: not the
--     owed refund itself; a facts row, a balance transaction of the Stripe refund and a succeeded state row; not already
--     the paying refund of a settlement; the settled amount (smaller of what the owed refund still owes and what the paying
--     refund paid, side by side) is above 0 and within the order balance of 2130 refund_owed_pre and refund_owed_post; the
--     day of its balance transaction is not before the cutover. The owed refund needs a facts row and a refund_failed entry
--     and must not be linked to a pre_shipment_cancel event, else there are no rows. Each row: refund_id, amount,
--     succeeded_on (the JST day of the balance transaction of the Stripe refund, the day the settle entry is booked on:
--     private.accounting_jst_date(stripe_balance_transactions.stripe_created_at), Ruling P3-T11h), event_id, event_kind, same_event (both facts event ids are not NULL
--     and equal). Order: same_event first, then succeeded_on, then refund_id. Not mirrored (they raise when the settle
--     writes): the period of the entry date (accounting_period_for_event) and the checks of the journal core. No name, mail
--     or address is read.
--
-- ROLLBACK (no row is written by this migration): DROP FUNCTION public.list_refund_settle_candidates(uuid),
--   private.list_refund_settle_candidates(uuid); re-run CREATE FUNCTION private.list_refund_accounting_states and
--   private.admin_record_refund_bank_transfer from 20261112214341_accounting_p3_refund_posting.sql:907-966 and :736-802 as
--   CREATE OR REPLACE.

-- ACC_S25_BODY_BEGIN

CREATE TEMP TABLE accounting_s25_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s25_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'allowlist', (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid)
    FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc)),
  'counts', pg_catalog.jsonb_build_object(
    'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
    'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
    'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
    'settlements', (SELECT pg_catalog.count(*) FROM public.accounting_refund_settlements)),
  'attrs', (SELECT pg_catalog.jsonb_object_agg(s.sig, (SELECT pg_catalog.md5(pg_catalog.concat_ws('|',
      f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
      f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
      (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
        FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a)))
      FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(s.sig)))
    FROM pg_catalog.unnest(ARRAY['private.list_refund_accounting_states(integer,timestamptz,uuid)',
      'public.list_refund_accounting_states(integer,timestamptz,uuid)',
      'private.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid)',
      'public.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid)']) AS s(sig)));

-- 1. The debt read (P3-T11e, P3-T11f).
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
      -- still in flight at Stripe, and at most the refund's own post-shipment amount; never below 0 (P3-T11i).
      CASE WHEN f.source = 'return' AND f.event_kind NOT IN ('holdback_release', 'pre_shipment_cancel')
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

-- 1b. The bank transfer writer: a return transfer waits for the in-flight Stripe refunds (P3-T11i).
CREATE OR REPLACE FUNCTION private.admin_record_refund_bank_transfer(_actor_id uuid, _order_id uuid, _origin text, _amount bigint,
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
-- ACC_P3_BEGIN
  -- Ruling P3-T11i: while a return-origin refund of the order is in flight at Stripe (the open_total test of the refundable
  -- amount), a new return transfer would pay the customer twice when that refund succeeds. A key seen before is still answered.
  IF _origin = 'return'
    AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
      WHERE e.dedupe_key = private.accounting_event_key(v_kind, v_parts))
    AND EXISTS (SELECT 1 FROM public.order_refunds AS r
      WHERE r.order_id = _order_id AND r.source = 'return' AND r.status IN ('awaiting_response', 'pending')) THEN
    RAISE EXCEPTION 'ACCOUNTING_REFUND_IN_FLIGHT' USING ERRCODE = '55000';
  END IF;
-- ACC_P3_END
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

-- 2. The settle candidates (P3-T11e). Every test below is one of admin_settle_owed_by_refund (S20), in its order.
CREATE FUNCTION private.list_refund_settle_candidates(_owed_refund_id uuid) RETURNS jsonb
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

CREATE FUNCTION public.list_refund_settle_candidates(_owed_refund_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_refund_settle_candidates(_owed_refund_id) $$;

ALTER FUNCTION private.list_refund_settle_candidates(uuid) OWNER TO postgres;
ALTER FUNCTION public.list_refund_settle_candidates(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.list_refund_settle_candidates(uuid), public.list_refund_settle_candidates(uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.list_refund_settle_candidates(uuid), public.list_refund_settle_candidates(uuid) TO service_role;
-- ACC_S25_BODY_END

-- ACC_S25_FINAL_ASSERT_BEGIN
-- Compare catalog meaning, never ACL text serialization. acc_s25_functions: the candidate read exists once as a private
-- SECURITY DEFINER plpgsql body and a public SECURITY INVOKER sql entry, STABLE, search_path '', owned by postgres, and only
-- service_role runs them. acc_s25_function_attrs: the rebuilt debt read (private body and public entry) keeps its arguments,
-- result, language, volatility, security, owner, search_path and ACL, and so do the rebuilt bank transfer writer and its
-- entry. acc_s25_body_unchanged: the rebuilt debt read has 2 replaced parts and 1 added block, the rebuilt bank transfer
-- writer 0 and 1, and with the replaced parts restored (by the md5 on the marker) and every ACC_P<n> block and all white
-- space removed each is the body it was copied from (S20). acc_s25_reads_stable: both reads, their bodies and the public
-- entry, are STABLE, write nothing, take no row lock and name no personal column. acc_s25_existing_dml_allowlist: this
-- migration writes no row, and the group G writer list is what it was.
DO $acc_s25_final$
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
  v_stage := 'acc_s25_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s25_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s25_baseline) <> 1 THEN
    v_failed := 'acc_s25_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s25_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object' OR NOT (v_baseline ? 'allowlist')
      OR NOT (v_baseline ? 'counts') OR NOT (v_baseline ? 'attrs') THEN
      v_failed := 'acc_s25_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s25_functions';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.list_refund_settle_candidates(uuid)', 'plpgsql', true),
      ('public.list_refund_settle_candidates(uuid)', 'sql', false)
    ) AS x(signature, lang, secdef)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      IF v_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
          WHERE f.oid = v_oid AND f.prosecdef = e.secdef AND f.provolatile = 's' AND l.lanname = e.lang AND NOT f.proretset
            AND f.prorettype = 'jsonb'::regtype AND f.proowner = 'postgres'::regrole AND f.prokind = 'f'
            AND f.proconfig = ARRAY['search_path=""']::text[]
            AND pg_catalog.array_to_string(f.proargnames, ',') = '_owed_refund_id')
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.proname = 'list_refund_settle_candidates'
            AND o.pronamespace = (SELECT f.pronamespace FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid)) <> 1
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
          CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
          WHERE f.oid = v_oid AND a.grantee <> f.proowner
            AND NOT (a.grantee = 'service_role'::regrole AND a.privilege_type = 'EXECUTE')) THEN
        v_failed := 'acc_s25_functions';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s25_function_attrs';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_baseline -> 'attrs')) <> 4
    OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(v_baseline -> 'attrs') AS b(sig, attrs)
      LEFT JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(b.sig)
      WHERE f.oid IS NULL OR b.attrs IS DISTINCT FROM pg_catalog.md5(pg_catalog.concat_ws('|',
        f.prorettype::oid::text, f.proargtypes::text, COALESCE(f.proargnames::text, ''), f.pronargdefaults, f.prolang, f.provolatile,
        f.prosecdef, f.proretset, f.proowner::regrole::text, COALESCE(f.proconfig::text, ''),
        (SELECT COALESCE(pg_catalog.string_agg(a.grantee::text || ':' || a.privilege_type, ',' ORDER BY a.grantee, a.privilege_type), '')
          FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a))))) THEN
    v_failed := 'acc_s25_function_attrs';
  END IF;

  v_stage := 'acc_s25_body_unchanged';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.list_refund_accounting_states(integer,timestamptz,uuid)', 2, 1, '28ec43c85c10e95fbf2644396a894f28', true,
        'f.event_id, f.event_kind,|AS owed_return|OR s.owed_return > 0|''event_id'', q.event_id, ''event_kind'', q.event_kind, ''owed_return'', q.owed_return|f.source = ''return'' AND f.event_kind NOT IN (''holdback_release'', ''pre_shipment_cancel'')|IN (''owed'', ''failed'')|LEAST(private.accounting_order_account_balance(r.order_id, ''2130'', ''return_refund''),|accounting_order_account_balance(r.order_id, ''2130'', ''return_refund'')|f.post_shipment_amount|x2.source = ''return'' AND x2.status IN (''awaiting_response'', ''pending'')'),
      ('private.admin_record_refund_bank_transfer(uuid,uuid,text,bigint,date,text,text,uuid)', 0, 1, '316d2c2d7c61b6a3f00b7c499d44ec71', false,
        '_origin = ''return''|r.source = ''return'' AND r.status IN (''awaiting_response'', ''pending'')|''ACCOUNTING_REFUND_IN_FLIGHT''')
    ) AS x(signature, replaced, added, digest, readonly, needle)
    LOOP
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF v_src IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(e.needle, '|')) AS n(part)
          WHERE pg_catalog.strpos(v_src, n.part) = 0)
        OR (e.readonly AND v_src ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M')
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_REPLACE_BEGIN', 'g')) <> e.replaced
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.regexp_matches(v_src, '-- ACC_P3_BEGIN', 'g')) <> e.added THEN
        v_failed := 'acc_s25_body_unchanged';
        EXIT;
      END IF;
      LOOP
        v_match := pg_catalog.regexp_match(v_src, '-- ACC_P3_REPLACE_BEGIN (.*?)-- ACC_P3_REPLACE_END');
        EXIT WHEN v_match IS NULL;
        SELECT o.original INTO v_original FROM (VALUES
    ('ca1a3021e675a63708ad29a6414346a3', $acc_s25_o1$    SELECT s.* FROM s WHERE s.undecided OR s.owed_pre > 0 OR s.owed_post > 0
$acc_s25_o1$),
    ('32ef77284162680fade869fa15bcf036', $acc_s25_o2$      'post_amount', q.post_shipment_amount, 'owed_pre', q.owed_pre, 'owed_post', q.owed_post, 'canceled_at', q.canceled_at)
$acc_s25_o2$)
        ) AS o(hash, original) WHERE o.hash = pg_catalog.left(v_match[1], 32);
        IF v_original IS NULL THEN
          v_failed := 'acc_s25_body_unchanged';
          EXIT;
        END IF;
        v_src := pg_catalog.replace(v_src, '-- ACC_P3_REPLACE_BEGIN ' || v_match[1] || '-- ACC_P3_REPLACE_END', v_original);
        v_original := NULL;
      END LOOP;
      IF v_failed IS NULL AND pg_catalog.md5(pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_src,
          '-- ACC_P[0-9]_BEGIN.*?-- ACC_P[0-9]_END', '', 'g'), '[[:space:]]+', '', 'g')) IS DISTINCT FROM e.digest THEN
        v_failed := 'acc_s25_body_unchanged';
      END IF;
      EXIT WHEN v_failed IS NOT NULL;
    END LOOP;
  END IF;

  v_stage := 'acc_s25_reads_stable';
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid IN ('private.list_refund_accounting_states(integer,timestamptz,uuid)'::regprocedure,
        'public.list_refund_accounting_states(integer,timestamptz,uuid)'::regprocedure,
        'private.list_refund_settle_candidates(uuid)'::regprocedure, 'public.list_refund_settle_candidates(uuid)'::regprocedure)
        AND (f.provolatile <> 's'
          OR f.prosrc ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M'
          OR f.prosrc ~* '(raw_payload|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address|full_name|email)')) THEN
    v_failed := 'acc_s25_reads_stable';
  END IF;

  v_stage := 'acc_s25_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline #>> '{counts,entries}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline #>> '{counts,lines}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline #>> '{counts,pending_events}')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_refund_settlements) IS DISTINCT FROM (v_baseline #>> '{counts,settlements}')::bigint
    OR (SELECT pg_catalog.jsonb_agg(w.proc::oid::bigint ORDER BY w.proc::oid) FROM pg_catalog.unnest(private.group_g_writer_allowlist()) AS w(proc))
      IS DISTINCT FROM (v_baseline -> 'allowlist')) THEN
    v_failed := 'acc_s25_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s25_functions'), HINT = SQLSTATE;
END;
$acc_s25_final$;
-- ACC_S25_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
