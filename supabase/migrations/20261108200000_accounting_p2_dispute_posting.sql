BEGIN;
-- Accounting plan 2 S11 (FREQ-568 AC-01..AC-07, FREQ-562 AC-05, FREQ-569 AC-01/AC-02/AC-06): the card network dispute posting, the
-- setting of the account a lost dispute is booked to, the reads that show a dispute, and the one posting entry point
-- public.accounting_run_posting that calls every poster. The group G / H tables and functions and every returns / refund object are
-- not touched; stripe_disputes / stripe_dispute_events / stripe_balance_transactions are only read.
--
-- Entries (kind dispute_event, key dispute_event:<dispute>:<stage>:<ref>; a dispute number and a transaction number match
-- ^[A-Za-z0-9_.-]{1,128}$):
--   W withdrawn   [dispute,'withdrawn',txn]  the day of the balance transaction (amount < 0). Credit 1160 (the amount A), debit 2150
--                 (U, the unshipped units, order id on the line), debit 1470 sub dispute_pending (S, the shipped units, memo
--                 dispute_reason:<cause>). S and U split A by the remaining value of every unit as of the fact number N of the
--                 withdrawal time (private.accounting_unit_values, private.accounting_allocate_amount; yen left over go to the
--                 lowest unit number). The fee of the dispute is Task 4's stripe_fee.
--   C confirmed   [dispute,'confirmed','lost'] the Japan day of the loss time. Amount = the present balance of 1470 dispute_pending
--                 of the dispute. Debit: the account the setting names for the cause, else 1470 sub dispute_confirmed_unassigned;
--                 credit 1470 dispute_pending (memo dispute_lost_at:<UTC time> = the loss time C used). A balance of 0 books nothing:
--                 the parked row closes at once as no_revenue (detail lost_on).
--   R / L         [dispute,'reversal',txn] the day of a dispute_reversal balance transaction (amount > 0): debit 1160 (memo
--                 dispute_reversal_kind:R or :L), credit 2150 (the deferred part, order id) and, for the shipped part, 1470
--                 dispute_pending (R) or the account C used (L: the setting account, or the account X assigned). The split of B uses
--                 the cumulative sum of the dispute's reversals in (stripe_created_at, id) order: shipped part =
--                 floor(S*Bc/A) - floor(S*Bp/A), the rest is the deferred part.
--   X assigned    [dispute,'assigned','1'] dated like C; debit the setting account, credit 1470 dispute_confirmed_unassigned; only by
--                 admin_assign_dispute_confirmed (a person), once per dispute.
-- Stages wait for each other (reason dispute_withdrawal_missing, or dispute_shipment_pending for W): W <- shipments confirmed by the
-- withdrawal time; R <- W; C <- W and every R at or before the loss time; L <- W and C (and X when C sits in the unassigned
-- sub-account and the shipped part is above 0, detail waiting_on dispute_account_unassigned). A reversal waits for the dispute to
-- be settled (won, lost, warning_closed, or a lost history row; detail dispute_status). R or L is decided after that by Stripe's
-- time: the loss time (the earliest stripe_event_created_at of the lost history rows, else the earliest occurred_at of them;
-- private.accounting_dispute_lost_at) against the stripe_created_at of the reversal: later = L, same or earlier = R. Once C is done
-- (an entry, or no_revenue) every reversal that is left is L: C is never computed again.
--
-- private.accounting_post_dispute_events(_limit integer DEFAULT 50) RETURNS jsonb
--   {posted, parked_new, reparked, resolved, withdrawn, confirmed, reversals, late_reversals}; the last four are counted inside posted.
--   First statement after the argument check: private.accounting_lock_all(NULL). No row lock anywhere. One query lists the jobs:
--   at most _limit new events (no entry, no parked row of any state) in the order of the stages W, R, C, L (then oldest first), then
--   at most 10 open parked rows. A reversal is placed after C when it is an L. Each job, from the day check to the parking or the
--   posting, is one BEGIN ... EXCEPTION block; a failure is parked through private.accounting_park_failure (period_missing with
--   entry_date, else posting_error); the count goes up only when it returns true. A no_revenue C counts as parked_new and
--   resolved (like the shipment poster), so has_more cannot go false while candidates remain.
--
-- private.accounting_run_posting(_limit integer) RETURNS jsonb  +  public.accounting_run_posting(_limit integer DEFAULT 50)
--   (INVOKER, service_role only). _limit 1..200 (else ACCOUNTING_ARGUMENT_INVALID). It calls the payment, shipment, Stripe and
--   dispute posters in that order, each of which takes its own locks, and returns {payments, shipments, stripe, disputes, parked,
--   resolved, has_more}: the first four are the entries each poster created, parked = parked_new + reparked, and has_more is true
--   when posted + parked_new summed over the posters reaches _limit. Counting rules the callers must know: a shipment or a dispute
--   no_revenue (the row is parked and closed at once) is counted in parked_new, so also in parked, although it is resolved; a
--   net-zero payout resolution of the Stripe poster (Task 4) is counted only in resolved, so a batch made only of those leaves
--   has_more false: they leave the candidates by themselves.
--
-- Tables: accounting_dispute_account_settings (cause -> account; written by admin_set_dispute_account_setting) and
--   accounting_dispute_assignments (append only; one row per assigned dispute). RLS on, no policy, service_role SELECT only.
-- Writers (private + public, service_role): admin_set_dispute_account_setting (admin.accounting.settings.manage; the account must
--   be an expense or a revenue account, else ACCOUNTING_DISPUTE_ACCOUNT_INVALID), admin_assign_dispute_confirmed
--   (admin.accounting.entries.correct).
-- Reads (STABLE, service_role; none returns raw_payload, evidence_details or a name): list_dispute_account_settings,
--   list_accounting_disputes, get_order_dispute_holds, get_slip_dispute_holds.
--
-- Labels: ACCOUNTING_LABELS.disputeWithdrawn, disputeConfirmed, disputeReversal and disputeAssigned, pasted from
-- scripts/accounting/emit-labels.ts:
--   disputeWithdrawn: U&'\30AB\30FC\30C9\4F1A\793E\304B\3089\306E\652F\6255\3044\306E\53D6\308A\6D88\3057'
--   disputeConfirmed: U&'\30AB\30FC\30C9\4F1A\793E\304B\3089\306E\652F\6255\3044\306E\53D6\308A\6D88\3057\306E\78BA\5B9A'
--   disputeReversal: U&'\30AB\30FC\30C9\4F1A\793E\304B\3089\306E\652F\6255\3044\306E\53D6\308A\6D88\3057\306E\53D6\308A\4E0B\3052'
--   disputeAssigned: U&'\30AB\30FC\30C9\4F1A\793E\304B\3089\306E\652F\6255\3044\306E\53D6\308A\6D88\3057\306E\79D1\76EE\306E\632F\308A\66FF\3048'
--
-- DEPENDENCY: the S9 balance read (public/private.get_stripe_balance_reconciliation) calls private.accounting_dispute_key when it runs,
-- to count a dispute transaction as journaled; dropping that function breaks the read.
-- ROLLBACK (only while no entry of kind dispute_event exists and both tables are empty). WARNING: the shipment poster of S8
-- (private.accounting_post_shipment_events) calls private.accounting_dispute_order; dropping that function (or this whole list)
-- breaks the shipment poster, so recreate the function of S8 without the dispute wait first:
--   DROP FUNCTION public.accounting_run_posting(integer), public.get_slip_dispute_holds(uuid), public.get_order_dispute_holds(uuid[]),
--     public.list_accounting_disputes(integer,timestamptz,text), public.list_dispute_account_settings(),
--     public.admin_assign_dispute_confirmed(uuid,text,uuid), public.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid),
--     private.accounting_run_posting(integer), private.get_slip_dispute_holds(uuid), private.get_order_dispute_holds(uuid[]),
--     private.list_accounting_disputes(integer,timestamptz,text), private.list_dispute_account_settings(),
--     private.admin_assign_dispute_confirmed(uuid,text,uuid), private.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid),
--     private.accounting_post_dispute_events(integer), private.accounting_dispute_json(text),
--     private.accounting_dispute_assigned_account(text), private.accounting_dispute_confirmed_account(text),
--     private.accounting_dispute_split_reversal(text,text), private.accounting_dispute_split_withdrawn(uuid,bigint,bigint),
--     private.accounting_dispute_reversal_kind(text,timestamptz), private.accounting_dispute_withdrawn_all_posted(text),
--     private.accounting_dispute_withdrawn_totals(text),
--     private.accounting_dispute_balance(text,text,text), private.accounting_dispute_order(text),
--     private.accounting_dispute_confirmed_done(text), private.accounting_dispute_settled(text),
--     private.accounting_dispute_lost_at(text), private.accounting_dispute_key(text,text,text), private.accounting_dispute_cause(text);
--   DROP TABLE public.accounting_dispute_assignments, public.accounting_dispute_account_settings;

-- ACC_S11_BODY_BEGIN
-- 1. The tables.
CREATE TABLE public.accounting_dispute_account_settings (
  reason text NOT NULL,
  account_code text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_by uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  admin_requests jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_dispute_account_settings_pkey PRIMARY KEY (reason),
  CONSTRAINT accounting_dispute_account_settings_account_code_fkey FOREIGN KEY (account_code)
    REFERENCES public.accounting_accounts (code) ON DELETE RESTRICT,
  CONSTRAINT accounting_dispute_account_settings_reason_check CHECK (char_length(reason) BETWEEN 1 AND 64),
  CONSTRAINT accounting_dispute_account_settings_version_check CHECK (version >= 1),
  CONSTRAINT accounting_dispute_account_settings_admin_requests_check CHECK (jsonb_typeof(admin_requests) = 'object')
);

CREATE TABLE public.accounting_dispute_assignments (
  dispute_id text NOT NULL,
  entry_id uuid NOT NULL,
  assigned_by uuid NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  CONSTRAINT accounting_dispute_assignments_pkey PRIMARY KEY (dispute_id),
  CONSTRAINT accounting_dispute_assignments_request_key_key UNIQUE (request_key),
  CONSTRAINT accounting_dispute_assignments_dispute_id_fkey FOREIGN KEY (dispute_id)
    REFERENCES public.stripe_disputes (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_dispute_assignments_entry_id_fkey FOREIGN KEY (entry_id)
    REFERENCES public.accounting_journal_entries (id) ON DELETE RESTRICT
);

ALTER TABLE public.accounting_dispute_account_settings OWNER TO postgres;
ALTER TABLE public.accounting_dispute_assignments OWNER TO postgres;
ALTER TABLE public.accounting_dispute_account_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_dispute_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_dispute_account_settings, public.accounting_dispute_assignments
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.accounting_dispute_account_settings, public.accounting_dispute_assignments TO service_role;

CREATE TRIGGER accounting_dispute_assignments_no_update_delete BEFORE UPDATE OR DELETE ON public.accounting_dispute_assignments
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_dispute_assignments_no_truncate BEFORE TRUNCATE ON public.accounting_dispute_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
ALTER TABLE public.accounting_dispute_assignments ENABLE ALWAYS TRIGGER accounting_dispute_assignments_no_update_delete;
ALTER TABLE public.accounting_dispute_assignments ENABLE ALWAYS TRIGGER accounting_dispute_assignments_no_truncate;

-- The baseline the final assert compares with: no migration step writes an entry, a line, a parked row, a period, a setting or an
-- assignment. A replay of the assert (tests) pins the current state here first (pinAccountingS11Baseline).
CREATE TEMP TABLE accounting_s11_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s11_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
  'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods),
  'settings', (SELECT pg_catalog.count(*) FROM public.accounting_dispute_account_settings),
  'assignments', (SELECT pg_catalog.count(*) FROM public.accounting_dispute_assignments));

-- 2. Small tools (owner only).
-- The cause of a dispute as the settings know it: one of the sixteen Stripe reasons, else other.
CREATE FUNCTION private.accounting_dispute_cause(_reason text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN _reason IN ('fraudulent', 'product_not_received', 'product_unacceptable', 'unrecognized', 'duplicate',
    'subscription_canceled', 'credit_not_processed', 'general', 'bank_cannot_process', 'check_returned', 'customer_initiated',
    'debit_not_authorized', 'incorrect_account_details', 'insufficient_funds', 'noncompliant', 'other') THEN _reason ELSE 'other' END
$$;

-- The key of a dispute entry, NULL when a part cannot be in a key (so a query can ask "is there an entry" without raising).
CREATE FUNCTION private.accounting_dispute_key(_dispute_id text, _stage text, _ref text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN _dispute_id ~ '^[A-Za-z0-9_.-]{1,128}$' AND _stage ~ '^[A-Za-z0-9_.-]{1,128}$' AND _ref ~ '^[A-Za-z0-9_.-]{1,128}$'
    THEN private.accounting_event_key('dispute_event', ARRAY[_dispute_id, _stage, _ref]) END
$$;

-- The time of the loss. The earliest Stripe time of the lost history rows; only when none of them has one (the notification was
-- missed and Stripe no longer lists the event) the earliest time this system received a lost row. NULL when there is no lost row.
CREATE FUNCTION private.accounting_dispute_lost_at(_dispute_id text) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN pg_catalog.count(*) = 0 THEN NULL
    ELSE COALESCE(pg_catalog.min(e.stripe_event_created_at), pg_catalog.min(e.occurred_at)) END
  FROM public.stripe_dispute_events AS e WHERE e.dispute_id = _dispute_id AND e.status = 'lost'
$$;

-- The dispute is settled: its state is won, lost or warning_closed, or a lost history row exists. Funds come back only then.
CREATE FUNCTION private.accounting_dispute_settled(_dispute_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((SELECT d.status IN ('won', 'lost', 'warning_closed') FROM public.stripe_disputes AS d WHERE d.id = _dispute_id), false)
    OR EXISTS (SELECT 1 FROM public.stripe_dispute_events AS e WHERE e.dispute_id = _dispute_id AND e.status = 'lost')
$$;

-- Step C is done: the entry exists, or it closed as no_revenue.
CREATE FUNCTION private.accounting_dispute_confirmed_done(_dispute_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
      WHERE e.dedupe_key = private.accounting_dispute_key(_dispute_id, 'confirmed', 'lost'))
    OR EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
      WHERE p.event_kind = 'dispute_event' AND p.source_table = 'stripe_disputes' AND p.source_id = _dispute_id
        AND p.reason = 'no_revenue' AND p.resolved_at IS NOT NULL AND p.resolved_entry_id IS NULL)
$$;

-- The order of a dispute: the stored order, else the order paid with the same payment intent.
CREATE FUNCTION private.accounting_dispute_order(_dispute_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(d.order_id, (SELECT o.id FROM public.orders AS o
    WHERE d.payment_intent_id IS NOT NULL AND o.payment_intent_id = d.payment_intent_id ORDER BY o.created_at, o.id LIMIT 1))
  FROM public.stripe_disputes AS d WHERE d.id = _dispute_id
$$;

-- The present balance (debit - credit) of one account (and one sub-account, NULL = the lines without one) in the entries of a
-- dispute and in the reversals of those entries.
CREATE FUNCTION private.accounting_dispute_balance(_dispute_id text, _account_code text, _sub_account text) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.sum(l.debit - l.credit), 0)::bigint
  FROM public.accounting_journal_entries AS e
  JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id
  WHERE l.account_code = _account_code AND l.sub_account IS NOT DISTINCT FROM _sub_account
    AND (pg_catalog.starts_with(e.dedupe_key, 'dispute_event:' || _dispute_id || ':')
      OR EXISTS (SELECT 1 FROM public.accounting_journal_entries AS o
        WHERE o.id = e.reverses_entry_id AND pg_catalog.starts_with(o.dedupe_key, 'dispute_event:' || _dispute_id || ':')))
$$;

-- What the withdrawal entries of a dispute took: the amount A (credit 1160), the shipped part S (debit 1470) and the deferred
-- part U (debit 2150), read from the lines, never from a stored ratio.
CREATE FUNCTION private.accounting_dispute_withdrawn_totals(_dispute_id text)
RETURNS TABLE(entries integer, total bigint, shipped bigint, deferred bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.count(DISTINCT e.id)::integer,
    COALESCE(pg_catalog.sum(l.credit) FILTER (WHERE l.account_code = '1160'), 0)::bigint,
    COALESCE(pg_catalog.sum(l.debit) FILTER (WHERE l.account_code = '1470'), 0)::bigint,
    COALESCE(pg_catalog.sum(l.debit) FILTER (WHERE l.account_code = '2150'), 0)::bigint
  FROM public.accounting_journal_entries AS e
  JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id
  WHERE pg_catalog.starts_with(e.dedupe_key, 'dispute_event:' || _dispute_id || ':withdrawn:')
    AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
$$;

-- Every withdrawal transaction of the dispute is in the books (and there is at least one). C and R wait for this, so they never take a
-- partial S while a second withdrawal is parked.
CREATE FUNCTION private.accounting_dispute_withdrawn_all_posted(_dispute_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM private.accounting_dispute_withdrawn_totals(_dispute_id) AS w WHERE w.entries > 0)
    AND NOT EXISTS (SELECT 1 FROM public.stripe_balance_transactions AS t
      WHERE t.source_id = _dispute_id AND t.reporting_category = 'dispute' AND t.amount < 0
        AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
          WHERE e.dedupe_key = private.accounting_dispute_key(_dispute_id, 'withdrawn', t.id)))
$$;

-- R or L of a reversal (NULL: the dispute is not settled yet). Decided by Stripe's time only; once C is done every reversal that
-- is left is L (C took the balance as it was; it is never computed again).
CREATE FUNCTION private.accounting_dispute_reversal_kind(_dispute_id text, _created_at timestamptz) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_lost timestamptz;
BEGIN
  IF NOT private.accounting_dispute_settled(_dispute_id) THEN
    RETURN NULL;
  END IF;
  IF private.accounting_dispute_confirmed_done(_dispute_id) THEN
    RETURN 'L';
  END IF;
  v_lost := private.accounting_dispute_lost_at(_dispute_id);
  IF v_lost IS NOT NULL AND _created_at > v_lost THEN
    RETURN 'L';
  END IF;
  RETURN 'R';
END;
$$;

-- How a withdrawal splits (design 4-e2): the value of every unit of the order as of fact number N, shipped or not, the amount
-- shared out by those values (leftover yen to the lowest unit), and the sums of the shipped and of the unshipped units.
-- units = 0 when there is nothing to share by (no unit, or all values 0).
CREATE FUNCTION private.accounting_dispute_split_withdrawn(_order_id uuid, _amount bigint, _as_of_seq bigint)
RETURNS TABLE(units integer, shipped bigint, deferred bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_values bigint[];
  v_flags boolean[];
  v_shares bigint[];
BEGIN
  SELECT pg_catalog.array_agg(v.value::bigint ORDER BY v.order_item_id, v.unit_index),
    pg_catalog.array_agg(v.shipped ORDER BY v.order_item_id, v.unit_index)
  INTO v_values, v_flags FROM private.accounting_unit_values(_order_id, _as_of_seq) AS v;
  IF v_values IS NULL OR (SELECT COALESCE(pg_catalog.sum(x.value), 0) FROM pg_catalog.unnest(v_values) AS x(value)) <= 0 THEN
    units := 0;
    shipped := 0;
    deferred := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  v_shares := private.accounting_allocate_amount(_amount, v_values);
  units := pg_catalog.cardinality(v_values);
  shipped := (SELECT COALESCE(pg_catalog.sum(v_shares[i.n]), 0) FROM pg_catalog.generate_subscripts(v_shares, 1) AS i(n) WHERE v_flags[i.n]);
  deferred := _amount - shipped;
  RETURN NEXT;
END;
$$;

-- How a reversal splits: its amount B, and the shipped part floor(S*Bc/A) - floor(S*Bp/A) where Bc is the sum of the reversals of
-- the dispute up to and including this one in (stripe_created_at, id) order and Bp the sum before it. Only Stripe-side facts
-- decide, so the answer does not depend on the order the entries go in; the parts add up to S when the reversals add up to A.
CREATE FUNCTION private.accounting_dispute_split_reversal(_dispute_id text, _txn_id text)
RETURNS TABLE(amount bigint, shipped_part bigint, deferred_part bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_entries integer;
  v_a bigint;
  v_s bigint;
  v_b bigint;
  v_bc bigint;
  v_bp bigint;
BEGIN
  SELECT w.entries, w.total, w.shipped INTO v_entries, v_a, v_s FROM private.accounting_dispute_withdrawn_totals(_dispute_id) AS w;
  SELECT r.amt, r.cum INTO v_b, v_bc FROM (
    SELECT t.id, t.amount::bigint AS amt,
      pg_catalog.sum(t.amount) OVER (ORDER BY t.stripe_created_at, t.id)::bigint AS cum
    FROM public.stripe_balance_transactions AS t
    WHERE t.source_id = _dispute_id AND t.reporting_category = 'dispute_reversal' AND t.amount > 0) AS r
  WHERE r.id = _txn_id;
  IF v_entries = 0 OR v_a <= 0 OR v_b IS NULL OR v_bc > v_a THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_bp := v_bc - v_b;
  amount := v_b;
  shipped_part := pg_catalog.floor(v_s::numeric * v_bc / v_a)::bigint - pg_catalog.floor(v_s::numeric * v_bp / v_a)::bigint;
  deferred_part := v_b - shipped_part;
  RETURN NEXT;
END;
$$;

-- The confirmed entry of a dispute and the account it debited (the line with a debit that is not 1470 dispute_pending is the only
-- debit line of it). No row while C has no entry.
CREATE FUNCTION private.accounting_dispute_confirmed_account(_dispute_id text)
RETURNS TABLE(entry_id uuid, entry_date date, account_code text, sub_account text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT e.id, e.entry_date, l.account_code, l.sub_account
  FROM public.accounting_journal_entries AS e
  JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id AND l.debit > 0
  WHERE e.dedupe_key = private.accounting_dispute_key(_dispute_id, 'confirmed', 'lost')
$$;

-- The account X debited (NULL while the dispute is not assigned).
CREATE FUNCTION private.accounting_dispute_assigned_account(_dispute_id text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT l.account_code
  FROM public.accounting_journal_entries AS e
  JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id AND l.debit > 0
  WHERE e.dedupe_key = private.accounting_dispute_key(_dispute_id, 'assigned', '1')
$$;

-- 3. The poster.
CREATE FUNCTION private.accounting_post_dispute_events(_limit integer DEFAULT 50) RETURNS jsonb
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
          IF EXISTS (SELECT 1 FROM public.stripe_refunds AS f
            WHERE f.status = 'succeeded' AND (f.order_id = v_order_id
              OR (v_dispute.payment_intent_id IS NOT NULL AND f.payment_intent_id = v_dispute.payment_intent_id))) THEN
            v_reason := 'dispute_refund_overlap';
          ELSIF (SELECT COALESCE(pg_catalog.sum(l.credit - l.debit), 0) FROM public.accounting_journal_lines AS l
            WHERE l.order_id = v_order_id AND l.account_code = '2130') <> 0 THEN
            v_reason := 'dispute_return_refund_pending';
          END IF;
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
          IF v_kind = 'L' AND v_shipped > 0 THEN
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
              v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', v_account,
                'debit', 0, 'credit', v_shipped));
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
        END IF;
        IF v_reason IS NOT NULL THEN
          PERFORM private.accounting_park_event('dispute_event', v_table, v_source_id, v_order_id, v_reason, v_detail);
          IF v_job.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
        ELSE
          v_cause := private.accounting_dispute_cause(v_dispute.reason);
          SELECT s.account_code INTO v_account FROM public.accounting_dispute_account_settings AS s WHERE s.reason = v_cause;
          IF v_account IS NULL THEN
            v_lines := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1470', 'debit', v_amount,
              'credit', 0, 'sub_account', 'dispute_confirmed_unassigned', 'memo', 'dispute_reason:' || v_cause));
          ELSE
            v_lines := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', v_account, 'debit', v_amount,
              'credit', 0, 'memo', 'dispute_reason:' || v_cause));
          END IF;
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

-- 4. The writers.
-- The account a lost dispute of one cause is booked to. New row: _expected_version NULL; a change: the version must match.
CREATE FUNCTION private.admin_set_dispute_account_setting(_actor_id uuid, _reason text, _account_code text,
  _expected_version bigint, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior jsonb;
  v_row public.accounting_dispute_account_settings%ROWTYPE;
  v_version bigint;
  v_updated_at timestamptz;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.settings.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _reason IS NULL OR private.accounting_dispute_cause(_reason) <> _reason OR _account_code IS NULL OR _request_key IS NULL
    OR (_expected_version IS NOT NULL AND _expected_version < 1) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'set_dispute_account_setting', 'actor', _actor_id,
    'reason', _reason, 'account', _account_code, 'version', _expected_version::text));
  SELECT s.admin_requests -> (_request_key::text) INTO v_prior
  FROM public.accounting_dispute_account_settings AS s WHERE s.admin_requests ? (_request_key::text);
  IF v_prior IS NOT NULL THEN
    IF v_prior ->> 'hash' IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior -> 'result';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounting_accounts AS a
    WHERE a.code = _account_code AND a.account_type IN ('expense', 'revenue')) THEN
    RAISE EXCEPTION 'ACCOUNTING_DISPUTE_ACCOUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.accounting_dispute_account_settings AS s WHERE s.reason = _reason FOR UPDATE;
  IF _expected_version IS NULL THEN
    IF FOUND THEN
      RAISE EXCEPTION 'ACCOUNTING_VERSION_CONFLICT' USING ERRCODE = '40001';
    END IF;
    v_version := 1;
  ELSE
    IF NOT FOUND OR v_row.version <> _expected_version THEN
      RAISE EXCEPTION 'ACCOUNTING_VERSION_CONFLICT' USING ERRCODE = '40001';
    END IF;
    v_version := v_row.version + 1;
  END IF;
  v_updated_at := pg_catalog.now();
  v_result := pg_catalog.jsonb_build_object('reason', _reason, 'account_code', _account_code, 'version', v_version::text,
    'updated_at', v_updated_at);
  IF _expected_version IS NULL THEN
    INSERT INTO public.accounting_dispute_account_settings (reason, account_code, version, updated_by, updated_at, admin_requests)
    VALUES (_reason, _account_code, v_version, _actor_id, v_updated_at,
      pg_catalog.jsonb_build_object(_request_key::text, pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result)));
  ELSE
    UPDATE public.accounting_dispute_account_settings AS s
    SET account_code = _account_code, version = v_version, updated_by = _actor_id, updated_at = v_updated_at,
      admin_requests = s.admin_requests || pg_catalog.jsonb_build_object(_request_key::text,
        pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result))
    WHERE s.reason = _reason;
  END IF;
  RETURN v_result;
END;
$$;

-- X: book the confirmed loss that was left in the unassigned sub-account to the account the setting names now. Once per dispute.
-- The day is the day of C, so the expense stands in the year of the loss whenever a person does this.
CREATE FUNCTION private.admin_assign_dispute_confirmed(_actor_id uuid, _dispute_id text, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_label CONSTANT text := U&'\30AB\30FC\30C9\4F1A\793E\304B\3089\306E\652F\6255\3044\306E\53D6\308A\6D88\3057\306E\79D1\76EE\306E\632F\308A\66FF\3048';
  v_hash text;
  v_row public.accounting_dispute_assignments%ROWTYPE;
  v_dispute public.stripe_disputes%ROWTYPE;
  v_confirmed record;
  v_cause text;
  v_account text;
  v_balance bigint;
  v_period uuid;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.entries.correct']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _dispute_id IS NULL OR _dispute_id !~ '^dp_[A-Za-z0-9]+$' OR _request_key IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'assign_dispute_confirmed', 'actor', _actor_id,
    'dispute', _dispute_id));
  SELECT * INTO v_row FROM public.accounting_dispute_assignments AS a WHERE a.request_key = _request_key;
  IF FOUND THEN
    IF v_row.request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
  ELSE
    SELECT * INTO v_row FROM public.accounting_dispute_assignments AS a WHERE a.dispute_id = _dispute_id;
  END IF;
  IF FOUND THEN
    -- Already assigned (this request again, or another one): nothing is added.
    RETURN (SELECT pg_catalog.jsonb_build_object('entry_id', e.id, 'entry_no', e.entry_no, 'period_id', e.period_id, 'created', false)
      FROM public.accounting_journal_entries AS e WHERE e.id = v_row.entry_id);
  END IF;
  SELECT d.* INTO v_dispute FROM public.stripe_disputes AS d WHERE d.id = _dispute_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  SELECT c.entry_date INTO v_confirmed FROM private.accounting_dispute_confirmed_account(_dispute_id) AS c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  v_cause := private.accounting_dispute_cause(v_dispute.reason);
  SELECT s.account_code INTO v_account FROM public.accounting_dispute_account_settings AS s WHERE s.reason = v_cause;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  v_balance := private.accounting_dispute_balance(_dispute_id, '1470', 'dispute_confirmed_unassigned');
  IF v_balance <= 0 THEN
    RAISE EXCEPTION 'ACCOUNTING_EVENT_NOT_POSTABLE' USING ERRCODE = '55000';
  END IF;
  v_period := private.accounting_period_for_event(v_confirmed.entry_date, _actor_id);
  v_result := private.accounting_post_journal_core(_actor_id, v_period, v_confirmed.entry_date, 'dispute_event',
    ARRAY[_dispute_id, 'assigned', '1'], c_label,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code', v_account, 'debit', v_balance, 'credit', 0, 'memo', 'dispute_reason:' || v_cause),
      pg_catalog.jsonb_build_object('account_code', '1470', 'debit', 0, 'credit', v_balance,
        'sub_account', 'dispute_confirmed_unassigned')),
    _source_table => 'stripe_disputes', _source_id => _dispute_id);
  INSERT INTO public.accounting_dispute_assignments (dispute_id, entry_id, assigned_by, request_key, request_hash)
  VALUES (_dispute_id, (v_result ->> 'entry_id')::uuid, _actor_id, _request_key, v_hash);
  RETURN v_result;
END;
$$;

-- 5. The reads (no raw payload, no evidence, no name or e-mail).
CREATE FUNCTION private.list_dispute_account_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object('settings', COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'reason', s.reason, 'account_code', s.account_code, 'version', s.version::text, 'updated_at', s.updated_at)
    ORDER BY s.reason), '[]'::jsonb))
  FROM public.accounting_dispute_account_settings AS s
$$;

-- One dispute as the list shows it.
CREATE FUNCTION private.accounting_dispute_json(_dispute_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'dispute_id', d.id, 'reason', d.reason, 'status', d.status, 'amount', d.amount,
    'order_id', private.accounting_dispute_order(d.id), 'stripe_created_at', d.stripe_created_at,
    'withdrawn_on', (SELECT pg_catalog.to_char(pg_catalog.min(private.accounting_jst_date(t.stripe_created_at)), 'YYYY-MM-DD')
      FROM public.stripe_balance_transactions AS t
      WHERE t.source_id = d.id AND t.reporting_category = 'dispute' AND t.amount < 0),
    'confirmed_on', (SELECT pg_catalog.to_char(c.entry_date, 'YYYY-MM-DD') FROM private.accounting_dispute_confirmed_account(d.id) AS c LIMIT 1),
    'assigned_account_code', (SELECT CASE WHEN c.account_code = '1470' THEN private.accounting_dispute_assigned_account(d.id)
        ELSE c.account_code END FROM private.accounting_dispute_confirmed_account(d.id) AS c LIMIT 1),
    'pending_reasons', COALESCE((SELECT pg_catalog.jsonb_agg(DISTINCT p.reason ORDER BY p.reason)
      FROM public.accounting_pending_events AS p
      WHERE p.event_kind = 'dispute_event' AND p.resolved_at IS NULL
        AND ((p.source_table = 'stripe_disputes' AND p.source_id = d.id)
          OR (p.source_table = 'stripe_balance_transactions' AND p.source_id IN (
            SELECT t.id FROM public.stripe_balance_transactions AS t WHERE t.source_id = d.id)))), '[]'::jsonb))
  FROM public.stripe_disputes AS d WHERE d.id = _dispute_id
$$;

-- Newest first by (stripe_created_at, id); the next page starts after the pair of the last row (both or none).
CREATE FUNCTION private.list_accounting_disputes(_limit integer DEFAULT 50, _after_at timestamptz DEFAULT NULL,
  _after_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ids text[];
  v_more boolean;
  v_rows jsonb;
  v_last_at timestamptz;
  v_last_id text;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 100 OR (_after_at IS NULL) <> (_after_id IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(q.id ORDER BY q.stripe_created_at DESC, q.id DESC) INTO v_ids FROM (
    SELECT d.id, d.stripe_created_at FROM public.stripe_disputes AS d
    WHERE _after_at IS NULL OR (d.stripe_created_at, d.id) < (_after_at, _after_id)
    ORDER BY d.stripe_created_at DESC, d.id DESC LIMIT _limit + 1) AS q;
  v_more := COALESCE(pg_catalog.cardinality(v_ids), 0) > _limit;
  IF v_more THEN
    v_ids := v_ids[1:_limit];
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(private.accounting_dispute_json(i.id) ORDER BY i.n), '[]'::jsonb)
  INTO v_rows FROM pg_catalog.unnest(COALESCE(v_ids, ARRAY[]::text[])) WITH ORDINALITY AS i(id, n);
  IF v_more THEN
    SELECT d.stripe_created_at, d.id INTO v_last_at, v_last_id FROM public.stripe_disputes AS d
    WHERE d.id = v_ids[pg_catalog.cardinality(v_ids)];
  END IF;
  RETURN pg_catalog.jsonb_build_object('disputes', v_rows, 'next_after_at', pg_catalog.to_jsonb(v_last_at),
    'next_after_id', pg_catalog.to_jsonb(v_last_id));
END;
$$;

-- The disputes that hold an order: the funds were taken and the dispute is neither lost, won nor closed (needs_response or
-- under_review, a withdrawal exists, no reversal exists). An early warning (warning_*) moves no funds and is not counted.
CREATE FUNCTION private.get_order_dispute_holds(_order_ids uuid[])
RETURNS TABLE(order_id uuid, dispute_id text, status text, amount bigint, since timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT o.id, d.id, d.status, w.total, w.since
  FROM public.stripe_disputes AS d
  CROSS JOIN LATERAL (SELECT private.accounting_dispute_order(d.id) AS id) AS o
  CROSS JOIN LATERAL (SELECT pg_catalog.sum(-t.amount)::bigint AS total, pg_catalog.min(t.stripe_created_at) AS since
    FROM public.stripe_balance_transactions AS t
    WHERE t.source_id = d.id AND t.reporting_category = 'dispute' AND t.amount < 0) AS w
  WHERE o.id = ANY (_order_ids) AND d.status IN ('needs_response', 'under_review') AND w.total IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.stripe_balance_transactions AS t
      WHERE t.source_id = d.id AND t.reporting_category = 'dispute_reversal' AND t.amount > 0)
  ORDER BY o.id, d.id
$$;

-- The orders of the lines of a draft shipment slip that a dispute holds.
CREATE FUNCTION private.get_slip_dispute_holds(_slip_id uuid) RETURNS TABLE(order_id uuid, dispute_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT h.order_id, h.dispute_id FROM private.get_order_dispute_holds(ARRAY(
    SELECT DISTINCT oi.order_id
    FROM public.shipment_slips AS s
    CROSS JOIN LATERAL pg_catalog.jsonb_to_recordset(CASE WHEN pg_catalog.jsonb_typeof(s.draft_lines) = 'array'
      THEN s.draft_lines ELSE '[]'::jsonb END) AS d("orderItemId" uuid)
    JOIN public.order_items AS oi ON oi.id = d."orderItemId"
    WHERE s.id = _slip_id AND s.stage = 'draft')) AS h
$$;

-- 6. The posting entry point.
CREATE FUNCTION private.accounting_run_posting(_limit integer) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_payments jsonb;
  v_shipments jsonb;
  v_stripe jsonb;
  v_disputes jsonb;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_payments := private.accounting_post_payment_events(_limit);
  v_shipments := private.accounting_post_shipment_events(_limit);
  v_stripe := private.accounting_post_stripe_events(_limit);
  v_disputes := private.accounting_post_dispute_events(_limit);
  RETURN pg_catalog.jsonb_build_object(
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
END;
$$;

-- 7. Public entries (same name, arguments and result; INVOKER; service_role only).
CREATE FUNCTION public.admin_set_dispute_account_setting(_actor_id uuid, _reason text, _account_code text,
  _expected_version bigint, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_set_dispute_account_setting(_actor_id, _reason, _account_code, _expected_version, _request_key) $$;

CREATE FUNCTION public.admin_assign_dispute_confirmed(_actor_id uuid, _dispute_id text, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_assign_dispute_confirmed(_actor_id, _dispute_id, _request_key) $$;

CREATE FUNCTION public.list_dispute_account_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_dispute_account_settings() $$;

CREATE FUNCTION public.list_accounting_disputes(_limit integer DEFAULT 50, _after_at timestamptz DEFAULT NULL,
  _after_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_accounting_disputes(_limit, _after_at, _after_id) $$;

CREATE FUNCTION public.get_order_dispute_holds(_order_ids uuid[])
RETURNS TABLE(order_id uuid, dispute_id text, status text, amount bigint, since timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT h.order_id, h.dispute_id, h.status, h.amount, h.since FROM private.get_order_dispute_holds(_order_ids) AS h $$;

CREATE FUNCTION public.get_slip_dispute_holds(_slip_id uuid) RETURNS TABLE(order_id uuid, dispute_id text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT h.order_id, h.dispute_id FROM private.get_slip_dispute_holds(_slip_id) AS h $$;

CREATE FUNCTION public.accounting_run_posting(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.accounting_run_posting(_limit) $$;

-- 8. Owners and EXECUTE. service_role: the writers, the reads and the entry point (private and public); the tools and the poster
--    are owner only.
ALTER FUNCTION private.accounting_dispute_cause(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_key(text,text,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_lost_at(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_settled(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_confirmed_done(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_order(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_balance(text,text,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_withdrawn_totals(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_withdrawn_all_posted(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_reversal_kind(text,timestamptz) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_split_withdrawn(uuid,bigint,bigint) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_split_reversal(text,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_confirmed_account(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_assigned_account(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_dispute_events(integer) OWNER TO postgres;
ALTER FUNCTION private.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_assign_dispute_confirmed(uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.list_dispute_account_settings() OWNER TO postgres;
ALTER FUNCTION private.accounting_dispute_json(text) OWNER TO postgres;
ALTER FUNCTION private.list_accounting_disputes(integer,timestamptz,text) OWNER TO postgres;
ALTER FUNCTION private.get_order_dispute_holds(uuid[]) OWNER TO postgres;
ALTER FUNCTION private.get_slip_dispute_holds(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_run_posting(integer) OWNER TO postgres;
ALTER FUNCTION public.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_assign_dispute_confirmed(uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.list_dispute_account_settings() OWNER TO postgres;
ALTER FUNCTION public.list_accounting_disputes(integer,timestamptz,text) OWNER TO postgres;
ALTER FUNCTION public.get_order_dispute_holds(uuid[]) OWNER TO postgres;
ALTER FUNCTION public.get_slip_dispute_holds(uuid) OWNER TO postgres;
ALTER FUNCTION public.accounting_run_posting(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_dispute_cause(text), private.accounting_dispute_key(text,text,text), private.accounting_dispute_lost_at(text),
  private.accounting_dispute_settled(text), private.accounting_dispute_confirmed_done(text), private.accounting_dispute_order(text),
  private.accounting_dispute_balance(text,text,text), private.accounting_dispute_withdrawn_totals(text),
  private.accounting_dispute_withdrawn_all_posted(text), private.accounting_dispute_reversal_kind(text,timestamptz), private.accounting_dispute_split_withdrawn(uuid,bigint,bigint),
  private.accounting_dispute_split_reversal(text,text), private.accounting_dispute_confirmed_account(text),
  private.accounting_dispute_assigned_account(text), private.accounting_post_dispute_events(integer),
  private.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid), private.admin_assign_dispute_confirmed(uuid,text,uuid),
  private.list_dispute_account_settings(), private.accounting_dispute_json(text),
  private.list_accounting_disputes(integer,timestamptz,text), private.get_order_dispute_holds(uuid[]),
  private.get_slip_dispute_holds(uuid), private.accounting_run_posting(integer),
  public.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid), public.admin_assign_dispute_confirmed(uuid,text,uuid),
  public.list_dispute_account_settings(), public.list_accounting_disputes(integer,timestamptz,text),
  public.get_order_dispute_holds(uuid[]), public.get_slip_dispute_holds(uuid), public.accounting_run_posting(integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid), private.admin_assign_dispute_confirmed(uuid,text,uuid),
  private.list_dispute_account_settings(), private.list_accounting_disputes(integer,timestamptz,text),
  private.get_order_dispute_holds(uuid[]), private.get_slip_dispute_holds(uuid), private.accounting_run_posting(integer),
  public.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid), public.admin_assign_dispute_confirmed(uuid,text,uuid),
  public.list_dispute_account_settings(), public.list_accounting_disputes(integer,timestamptz,text),
  public.get_order_dispute_holds(uuid[]), public.get_slip_dispute_holds(uuid), public.accounting_run_posting(integer)
TO service_role;
-- ACC_S11_BODY_END

-- ACC_S11_FINAL_ASSERT_BEGIN
-- Catalog meaning only (never ACL text). acc_s11_tables: the two tables (owner, columns, constraints, the append-only triggers).
-- acc_s11_rls_acl: RLS on, no policy, service_role holds SELECT only. acc_s11_functions: each function exists once and its text keeps
-- the rules of the plan (the first lock, no row lock, the accounts, the keys, the loss time tool, the splits, the failure helper,
-- the permissions). acc_s11_function_attrs: owner, SECURITY, volatility, language, result, arguments, search_path and EXECUTE
-- (nobody for the tools and the poster, service_role only for the writers, the reads and the entry point).
-- acc_s11_reads_stable: the reads are STABLE and write nothing, and name no raw payload, evidence or personal column.
-- acc_s11_run_posting: the entry point calls the four posters in order and computes has_more as the plan says.
-- acc_s11_existing_dml_allowlist: this migration wrote no row.
DO $acc_s11_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_oid oid;
  v_src text;
  v_baseline jsonb;
  v_tables text[] := ARRAY['accounting_dispute_account_settings', 'accounting_dispute_assignments'];
  p record;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s11_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s11_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s11_baseline) <> 1 THEN
    v_failed := 'acc_s11_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s11_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['entries', 'lines', 'pending_events', 'periods', 'settings', 'assignments']) AS k(name)
        WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s11_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s11_tables';
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM (VALUES
    ('accounting_dispute_account_settings', 'reason text not null, account_code text not null, version bigint not null default 1, updated_by uuid, updated_at timestamp with time zone not null default now(), admin_requests jsonb not null default ''{}''::jsonb',
      E'accounting_dispute_account_settings_account_code_fkey f true false FOREIGN KEY (account_code) REFERENCES public.accounting_accounts(code) ON DELETE RESTRICT\naccounting_dispute_account_settings_admin_requests_check c true false CHECK ((jsonb_typeof(admin_requests) = ''object''::text))\naccounting_dispute_account_settings_pkey p true false PRIMARY KEY (reason)\naccounting_dispute_account_settings_reason_check c true false CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 64)))\naccounting_dispute_account_settings_version_check c true false CHECK ((version >= 1))'),
    ('accounting_dispute_assignments', 'dispute_id text not null, entry_id uuid not null, assigned_by uuid, assigned_at timestamp with time zone not null default now(), request_key uuid not null, request_hash text not null',
      E'accounting_dispute_assignments_dispute_id_fkey f true false FOREIGN KEY (dispute_id) REFERENCES public.stripe_disputes(id) ON DELETE RESTRICT\naccounting_dispute_assignments_entry_id_fkey f true false FOREIGN KEY (entry_id) REFERENCES public.accounting_journal_entries(id) ON DELETE RESTRICT\naccounting_dispute_assignments_pkey p true false PRIMARY KEY (dispute_id)\naccounting_dispute_assignments_request_key_key u true false UNIQUE (request_key)')
    ) AS t(name, columns, constraints)
    LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> 'postgres'::regrole
      OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
            || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
            || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute AS a
          LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM t.columns
      OR (SELECT pg_catalog.string_agg(o.conname::text || ' ' || o.contype::text || ' ' || o.convalidated::text || ' '
            || o.condeferrable::text || ' ' || pg_catalog.pg_get_constraintdef(o.oid), E'\n' ORDER BY o.conname::text COLLATE "C")
          FROM pg_catalog.pg_constraint AS o WHERE o.conrelid = c.oid) IS DISTINCT FROM t.constraints) THEN
    v_failed := 'acc_s11_tables';
  END IF;
  -- The assignments table is append only for every role (also in replica mode); the settings table has no user trigger.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
      ('accounting_dispute_assignments_no_update_delete', 27),
      ('accounting_dispute_assignments_no_truncate', 34)
    ) AS x(name, kind)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS g
      WHERE g.tgrelid = 'public.accounting_dispute_assignments'::regclass AND g.tgname::text = x.name
        AND g.tgfoid = 'private.reject_accounting_mutation()'::regprocedure AND g.tgtype = x.kind AND g.tgenabled = 'A'
        AND NOT g.tgisinternal AND g.tgconstraint = 0 AND NOT g.tgdeferrable AND g.tgnargs = 0 AND g.tgqual IS NULL))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT pg_catalog.to_regclass('public.' || t) FROM pg_catalog.unnest(v_tables) AS t)) <> 2) THEN
    v_failed := 'acc_s11_tables';
  END IF;

  v_stage := 'acc_s11_rls_acl';
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(name)
    JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE NOT c.relrowsecurity
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = c.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee <> c.relowner AND (acl.grantee <> 'service_role'::regrole::oid OR acl.privilege_type <> 'SELECT'))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
        WHERE pg_catalog.has_table_privilege(r.role, c.oid, q.privilege))
      OR pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')) THEN
    v_failed := 'acc_s11_rls_acl';
  END IF;

  v_stage := 'acc_s11_functions';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_post_dispute_events(integer)', true, ARRAY[
        'PERFORM private.accounting_lock_all(NULL);', '''dispute_event''', '''1160''', '''2150''', '''1470''', '''dispute_pending''',
        '''dispute_confirmed_unassigned''', 'private.accounting_jst_date(v_bt.stripe_created_at)', 'private.accounting_jst_date(v_lost)',
        'private.accounting_period_for_event(v_date)', 'private.accounting_g_fact_seq_at(v_bt.stripe_created_at)',
        'private.accounting_dispute_split_withdrawn(', 'private.accounting_dispute_split_reversal(', 'private.accounting_dispute_withdrawn_all_posted(',
        'private.accounting_dispute_reversal_kind(', 'private.accounting_dispute_lost_at(', 'private.accounting_dispute_balance(',
        'dispute_shipment_pending', 'p.reason = ''before_cutover''', 'dispute_withdrawal_missing', 'dispute_account_unassigned', 'dispute_refund_overlap',
        'dispute_return_refund_pending', 'no_revenue', 'lost_on', 'dispute_reversal_kind:', 'dispute_lost_at:', 'dispute_reason:',
        'private.accounting_park_failure(''dispute_event'',', 'IF v_parked THEN', 'EXCEPTION WHEN OTHERS',
        '_source_recorded_at => LEAST(v_bt.synced_at, pg_catalog.clock_timestamp())',
        '_source_recorded_at => LEAST(v_recorded, pg_catalog.clock_timestamp())']),
      ('private.accounting_run_posting(integer)', false, ARRAY[
        'private.accounting_post_payment_events(_limit)', 'private.accounting_post_shipment_events(_limit)',
        'private.accounting_post_stripe_events(_limit)', 'private.accounting_post_dispute_events(_limit)']),
      ('private.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid)', false, ARRAY[
        'private.group_g_actor_has_permissions(_actor_id, ARRAY[''admin.accounting.settings.manage''])',
        'ACCOUNTING_DISPUTE_ACCOUNT_INVALID', 'ACCOUNTING_VERSION_CONFLICT', 'ACCOUNTING_REQUEST_KEY_CONFLICT',
        'private.accounting_request_hash(', 'PERFORM private.accounting_lock_all(NULL);', 'IN (''expense'', ''revenue'')']),
      ('private.admin_assign_dispute_confirmed(uuid,text,uuid)', false, ARRAY[
        'private.group_g_actor_has_permissions(_actor_id, ARRAY[''admin.accounting.entries.correct''])',
        'ACCOUNTING_EVENT_NOT_POSTABLE', 'ACCOUNTING_REQUEST_KEY_CONFLICT', 'private.accounting_request_hash(',
        'PERFORM private.accounting_lock_all(NULL);', '''dispute_confirmed_unassigned''', '''assigned''',
        'private.accounting_post_journal_core(_actor_id,', 'v_confirmed.entry_date']),
      ('private.accounting_dispute_lost_at(text)', false, ARRAY['stripe_event_created_at', 'occurred_at', '''lost''']),
      ('private.accounting_dispute_reversal_kind(text,timestamptz)', false, ARRAY[
        'private.accounting_dispute_settled(', 'private.accounting_dispute_confirmed_done(', 'private.accounting_dispute_lost_at(']),
      ('private.accounting_dispute_split_withdrawn(uuid,bigint,bigint)', false, ARRAY[
        'private.accounting_unit_values(', 'private.accounting_allocate_amount(']),
      ('private.accounting_dispute_split_reversal(text,text)', false, ARRAY[
        'pg_catalog.floor(v_s::numeric * v_bc / v_a)::bigint - pg_catalog.floor(v_s::numeric * v_bp / v_a)::bigint',
        'ORDER BY t.stripe_created_at, t.id']),
      ('private.accounting_dispute_balance(text,text,text)', false, ARRAY['reverses_entry_id']),
      ('private.accounting_dispute_settled(text)', false, ARRAY['''won'', ''lost'', ''warning_closed''']),
      ('private.accounting_dispute_cause(text)', false, ARRAY['''fraudulent''', '''other'''])
    ) AS x(signature, lane, needles)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      IF v_oid IS NULL THEN
        v_failed := 'acc_s11_functions';
        EXIT;
      END IF;
      IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
        WHERE o.pronamespace = 'private'::regnamespace AND o.proname = (SELECT f.proname FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid)) <> 1 THEN
        v_failed := 'acc_s11_functions';
        EXIT;
      END IF;
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF EXISTS (SELECT 1 FROM pg_catalog.unnest(e.needles) AS n(text) WHERE pg_catalog.strpos(v_src, n.text) = 0)
        OR (e.lane AND (v_src ~* 'FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)' OR v_src ~* 'PG_EXCEPTION_CONTEXT'
          OR v_src ~* '(raw_payload|evidence_details)'
          OR pg_catalog.strpos(v_src, 'PERFORM private.accounting_lock_all(NULL);') > COALESCE(NULLIF(pg_catalog.strpos(v_src, 'FOR v_job IN'), 0), 2147483647))) THEN
        v_failed := 'acc_s11_functions';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s11_function_attrs';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_dispute_cause(text)', 'text', false, '_reason', 0, 'i', 'sql', false),
      ('private.accounting_dispute_key(text,text,text)', 'text', false, '_dispute_id,_stage,_ref', 0, 'i', 'sql', false),
      ('private.accounting_dispute_lost_at(text)', 'timestamptz', false, '_dispute_id', 0, 's', 'sql', false),
      ('private.accounting_dispute_settled(text)', 'boolean', false, '_dispute_id', 0, 's', 'sql', false),
      ('private.accounting_dispute_confirmed_done(text)', 'boolean', false, '_dispute_id', 0, 's', 'sql', false),
      ('private.accounting_dispute_order(text)', 'uuid', false, '_dispute_id', 0, 's', 'sql', false),
      ('private.accounting_dispute_balance(text,text,text)', 'bigint', false, '_dispute_id,_account_code,_sub_account', 0, 's', 'sql', false),
      ('private.accounting_dispute_withdrawn_totals(text)', 'record', true, '_dispute_id', 0, 's', 'sql', false),
      ('private.accounting_dispute_withdrawn_all_posted(text)', 'boolean', false, '_dispute_id', 0, 's', 'sql', false),
      ('private.accounting_dispute_reversal_kind(text,timestamptz)', 'text', false, '_dispute_id,_created_at', 0, 's', 'plpgsql', false),
      ('private.accounting_dispute_split_withdrawn(uuid,bigint,bigint)', 'record', true, '_order_id,_amount,_as_of_seq', 0, 's', 'plpgsql', false),
      ('private.accounting_dispute_split_reversal(text,text)', 'record', true, '_dispute_id,_txn_id', 0, 's', 'plpgsql', false),
      ('private.accounting_dispute_confirmed_account(text)', 'record', true, '_dispute_id', 0, 's', 'sql', false),
      ('private.accounting_dispute_assigned_account(text)', 'text', false, '_dispute_id', 0, 's', 'sql', false),
      ('private.accounting_post_dispute_events(integer)', 'jsonb', false, '_limit', 1, 'v', 'plpgsql', false),
      ('private.accounting_dispute_json(text)', 'jsonb', false, '_dispute_id', 0, 's', 'sql', false),
      ('private.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid)', 'jsonb', false,
        '_actor_id,_reason,_account_code,_expected_version,_request_key', 0, 'v', 'plpgsql', true),
      ('public.admin_set_dispute_account_setting(uuid,text,text,bigint,uuid)', 'jsonb', false,
        '_actor_id,_reason,_account_code,_expected_version,_request_key', 0, 'v', 'sql', true),
      ('private.admin_assign_dispute_confirmed(uuid,text,uuid)', 'jsonb', false, '_actor_id,_dispute_id,_request_key', 0, 'v', 'plpgsql', true),
      ('public.admin_assign_dispute_confirmed(uuid,text,uuid)', 'jsonb', false, '_actor_id,_dispute_id,_request_key', 0, 'v', 'sql', true),
      ('private.list_dispute_account_settings()', 'jsonb', false, '', 0, 's', 'sql', true),
      ('public.list_dispute_account_settings()', 'jsonb', false, '', 0, 's', 'sql', true),
      ('private.list_accounting_disputes(integer,timestamptz,text)', 'jsonb', false, '_limit,_after_at,_after_id', 3, 's', 'plpgsql', true),
      ('public.list_accounting_disputes(integer,timestamptz,text)', 'jsonb', false, '_limit,_after_at,_after_id', 3, 's', 'sql', true),
      ('private.get_order_dispute_holds(uuid[])', 'record', true, '_order_ids', 0, 's', 'sql', true),
      ('public.get_order_dispute_holds(uuid[])', 'record', true, '_order_ids', 0, 's', 'sql', true),
      ('private.get_slip_dispute_holds(uuid)', 'record', true, '_slip_id', 0, 's', 'sql', true),
      ('public.get_slip_dispute_holds(uuid)', 'record', true, '_slip_id', 0, 's', 'sql', true),
      ('private.accounting_run_posting(integer)', 'jsonb', false, '_limit', 0, 'v', 'plpgsql', true),
      ('public.accounting_run_posting(integer)', 'jsonb', false, '_limit', 1, 'v', 'sql', true)
    ) AS x(signature, result_type, retset, arg_names, defaults, volatility, lang, service_exec)
    LOOP
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF p.oid IS NULL OR p.proowner <> 'postgres'::regrole
        OR p.prosecdef <> (e.signature LIKE 'private.%') OR p.provolatile::text <> e.volatility
        OR p.lanname <> e.lang OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset <> e.retset
        OR p.prokind <> 'f' OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames[1:p.pronargs], ','), '') <> e.arg_names
        OR p.pronargdefaults <> e.defaults
        OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') <> e.service_exec
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee <> p.proowner AND NOT (e.service_exec AND a.grantee = 'service_role'::regrole))
        OR (NOT e.service_exec AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = p.proname)) THEN
        v_failed := 'acc_s11_function_attrs';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s11_reads_stable';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.list_dispute_account_settings()'), ('public.list_dispute_account_settings()'),
      ('private.list_accounting_disputes(integer,timestamptz,text)'), ('public.list_accounting_disputes(integer,timestamptz,text)'),
      ('private.get_order_dispute_holds(uuid[])'), ('public.get_order_dispute_holds(uuid[])'),
      ('private.get_slip_dispute_holds(uuid)'), ('public.get_slip_dispute_holds(uuid)'),
      ('private.accounting_dispute_json(text)')
    ) AS x(signature)
    LOOP
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF p.oid IS NULL OR p.provolatile <> 's'
        OR p.prosrc ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)\M'
        OR p.prosrc ~* '(raw_payload|evidence_details|customer_email|shipping_email|shipping_full_name|ship_to_|shipping_phone|shipping_address)' THEN
        v_failed := 'acc_s11_reads_stable';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s11_run_posting';
  IF v_failed IS NULL THEN
    SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
    WHERE f.oid = pg_catalog.to_regprocedure('private.accounting_run_posting(integer)');
    IF NOT (pg_catalog.strpos(v_src, 'accounting_post_payment_events(_limit)') > 0
        AND pg_catalog.strpos(v_src, 'accounting_post_payment_events(_limit)') < pg_catalog.strpos(v_src, 'accounting_post_shipment_events(_limit)')
        AND pg_catalog.strpos(v_src, 'accounting_post_shipment_events(_limit)') < pg_catalog.strpos(v_src, 'accounting_post_stripe_events(_limit)')
        AND pg_catalog.strpos(v_src, 'accounting_post_stripe_events(_limit)') < pg_catalog.strpos(v_src, 'accounting_post_dispute_events(_limit)'))
      OR pg_catalog.strpos(v_src, '_limit < 1 OR _limit > 200') = 0 OR pg_catalog.strpos(v_src, '''ACCOUNTING_ARGUMENT_INVALID''') = 0
      OR pg_catalog.strpos(v_src, '''has_more''') = 0 OR pg_catalog.strpos(v_src, ') >= _limit)') = 0
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['v_payments', 'v_shipments', 'v_stripe', 'v_disputes']) AS n(poster)
        WHERE pg_catalog.strpos(pg_catalog.substr(v_src, pg_catalog.strpos(v_src, '''has_more''')), '(' || n.poster || ' ->> ''posted'')::integer') = 0
          OR pg_catalog.strpos(pg_catalog.substr(v_src, pg_catalog.strpos(v_src, '''has_more''')), '(' || n.poster || ' ->> ''parked_new'')::integer') = 0)
      OR pg_catalog.substr(v_src, pg_catalog.strpos(v_src, '''has_more''')) ~ '(reparked|resolved)'
      OR v_src ~* 'FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)' THEN
      v_failed := 'acc_s11_run_posting';
    ELSE
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('public.accounting_run_posting(integer)');
      IF pg_catalog.btrim(v_src) <> 'SELECT private.accounting_run_posting(_limit)' THEN
        v_failed := 'acc_s11_run_posting';
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s11_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline ->> 'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline ->> 'lines')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline ->> 'periods')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_dispute_account_settings) IS DISTINCT FROM (v_baseline ->> 'settings')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_dispute_assignments) IS DISTINCT FROM (v_baseline ->> 'assignments')::bigint) THEN
    v_failed := 'acc_s11_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s11_functions'), HINT = SQLSTATE;
END;
$acc_s11_final$;
-- ACC_S11_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
