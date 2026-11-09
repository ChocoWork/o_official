BEGIN;
-- Accounting plan 2 S9 (FREQ-565 AC-01..AC-06, FREQ-566 AC-01..AC-03, FREQ-569 AC-01/AC-06): the Stripe posting. One Stripe
-- balance transaction becomes at most one fee entry (kind stripe_fee, key stripe:fee:<transaction>) and, for a tax
-- adjustment, one entry (kind stripe_tax_adjustment, key <transaction>); a payout, its bank arrival and the return of a
-- failed payout become one entry each (payout_started / bank_arrived keyed by the payout, payout_failed keyed by the return
-- transaction). A balance top-up is typed in by a person (balance_topup keyed by the bank or the Stripe number). Two reads
-- compare the fees (Japan month, UTC month, invoice) and the Stripe balance with the books. The group G tables and
-- functions and every returns / refund object are not touched.
--
-- private.accounting_stripe_category_kind(type, reporting_category) is the one map of balance transaction types to the way a
-- lane treats them (output of scripts/accounting/emit-stripe-categories.ts; a test compares the text with
-- src/lib/accounting/stripe-categories.ts). A type the map does not know is parked as unknown_category, never dropped.
--
-- private.accounting_post_stripe_events(_limit integer DEFAULT 50) RETURNS jsonb calls five lane functions in this order
-- (the payout lane before the bank and failure lanes, so a payout and its return can go in during one call):
--   accounting_post_stripe_fee_events, accounting_post_stripe_tax_adjustment_events, accounting_post_stripe_payout_events,
--   accounting_post_stripe_bank_events, accounting_post_stripe_payout_failure_events.
--   Each returns {posted, parked_new, reparked, resolved}; the runner adds the four and the per-lane counts of posted
--   entries (fees, tax_adjustments, payouts, bank_arrivals, payout_failures), which are counted inside posted too.
--   No entry point: the runner of a later task (public.accounting_run_posting) is the only caller; PUBLIC, anon,
--   authenticated and service_role hold no EXECUTE.
--   * First statement after the argument check: private.accounting_lock_all(NULL). No row lock anywhere (the Stripe tables
--     and the group G tables are only read).
--   * New events are chosen by an SQL condition (rows a lane skips never take a place), oldest first, at most _limit; then, in
--     the same call, at most 10 still-open parked rows of the lane, oldest last_detected_at first. The two groups cannot overlap.
--   * Each event, from the day check to the parking or the posting, is one BEGIN ... EXCEPTION block: a failure undoes that one
--     event and is parked through private.accounting_park_failure (period_missing with entry_date, else posting_error with
--     SQLSTATE and a fixed code); the count goes up only when the helper returns true.
--   * The entry's source time is LEAST(<the row's own stored time>, clock_timestamp()): synced_at for a transaction or a
--     payout, bank_confirmed_at for an arrival.
--   * fee lane: the fee of a transaction is the signed amount fee_amount (private.accounting_stripe_fee_amount: -net for a
--     stand-alone fee type, 0 for a tax adjustment, else fee). A positive fee debits 6280 (and 1480 in a taxable period) and
--     credits 1160; a negative one is the reverse. Taxable = the period of the day is taxable and the day is not before
--     consumption_taxable_from; then the tax is the sum of the fee_details elements of type tax, or 10 percent of the total
--     when there is none (the memo gets tax_default_10). Not taxable: one tax-included 6280 line. The unknown_category lane
--     is part of this function: a known row cannot be dropped by both this lane and the principal lanes.
--   * a parked unknown_category row whose type became known is posted at once when it has a fee, else closed with no entry.
--   * failure lane: only when the payout's own entry (payout_started:<payout>) exists. A failed or canceled payout with no
--     paid_at never gets that entry; its payout transaction, its return and the payout itself get resolved payout_mismatch rows
--     (payout_state payout_net_zero) and no entry. Any other payout without its entry parks the return (payout_not_posted).
--
-- admin_record_balance_topup (private + public, admin.finance.manage): 1160 debit / 1040 credit for the amount of a top-up
--   Stripe took from the bank. The key is the bank number, else the Stripe transaction number (^[A-Za-z0-9_.-]{1,128}$); the
--   same key with the same content answers the first entry (created false), another content is DEDUPE_CONTENT_MISMATCH. A day
--   before the cutover day or after today (Japan) is ACCOUNTING_ARGUMENT_INVALID. The request key is required but the event
--   key is what stops a duplicate.
-- accounting_stripe_invoice_records + admin_set_stripe_invoice_record (private + public, admin.finance.manage): the total, the
--   tax and a reference text of the qualified invoice of a UTC month. Version checked, request key replayed.
-- Reads (STABLE, service_role): get_stripe_fee_reconciliation(month) and get_stripe_balance_reconciliation(through).
--   DEPENDENCY: get_stripe_balance_reconciliation calls private.accounting_dispute_key, which S11 (the dispute posting) defines
--   later. It is plpgsql, so the name is looked up when the read runs; dropping S11's function breaks the read.
--
-- Labels: ACCOUNTING_LABELS.stripeJapan, feePayment, feeDispute, feeFx, taxAdjustment, payoutStarted, bankArrived,
-- payoutFailed and balanceTopup, pasted from scripts/accounting/emit-labels.ts:
--   stripeJapan: U&'\30B9\30C8\30E9\30A4\30D7\30B8\30E3\30D1\30F3\682A\5F0F\4F1A\793E'
--   feePayment: U&'\6C7A\6E08\306E\624B\6570\6599'
--   feeDispute: U&'\53D6\308A\6D88\3057\306E\624B\6570\6599'
--   feeFx: U&'\70BA\66FF\306E\624B\6570\6599'
--   taxAdjustment: U&'\6D88\8CBB\7A0E\306E\8ABF\6574'
--   payoutStarted: U&'\9280\884C\3078\306E\5165\91D1\306E\958B\59CB'
--   bankArrived: U&'\9280\884C\3078\306E\7740\91D1'
--   payoutFailed: U&'\5165\91D1\306E\5931\6557'
--   balanceTopup: U&'\6B8B\9AD8\306E\88DC\5145'
--
-- ROLLBACK (only while no entry of kind stripe_fee, stripe_tax_adjustment, payout_started, bank_arrived, payout_failed or
-- balance_topup exists and the invoice table is empty):
--   DROP FUNCTION public.get_stripe_balance_reconciliation(date), public.get_stripe_fee_reconciliation(text),
--     public.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid),
--     public.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid),
--     private.get_stripe_balance_reconciliation(date), private.get_stripe_fee_reconciliation(text),
--     private.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid),
--     private.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid), private.accounting_post_stripe_events(integer),
--     private.accounting_post_stripe_payout_failure_events(integer), private.accounting_post_stripe_bank_events(integer),
--     private.accounting_post_stripe_payout_events(integer), private.accounting_post_stripe_tax_adjustment_events(integer),
--     private.accounting_post_stripe_fee_events(integer), private.accounting_entry_live(text,text),
--     private.accounting_period_taxable(uuid,date), private.accounting_stripe_fee_amount(text,integer,integer),
--     private.accounting_stripe_category_kind(text,text);
--   DROP TABLE public.accounting_stripe_invoice_records;

-- ACC_S9_BODY_BEGIN
-- 1. The invoice record table (service_role reads it; only the writer below changes it).
CREATE TABLE public.accounting_stripe_invoice_records (
  invoice_month text NOT NULL,
  invoice_total bigint NOT NULL,
  invoice_tax bigint NOT NULL DEFAULT 0,
  document_ref text NULL,
  entered_by uuid NULL,
  entered_at timestamptz NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1,
  admin_requests jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_stripe_invoice_records_pkey PRIMARY KEY (invoice_month),
  CONSTRAINT accounting_stripe_invoice_records_invoice_month_check CHECK (invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT accounting_stripe_invoice_records_invoice_total_check CHECK (invoice_total >= 0),
  CONSTRAINT accounting_stripe_invoice_records_invoice_tax_check CHECK (invoice_tax >= 0),
  CONSTRAINT accounting_stripe_invoice_records_document_ref_check CHECK (char_length(document_ref) <= 200),
  CONSTRAINT accounting_stripe_invoice_records_version_check CHECK (version >= 1),
  CONSTRAINT accounting_stripe_invoice_records_admin_requests_check CHECK (jsonb_typeof(admin_requests) = 'object')
);
ALTER TABLE public.accounting_stripe_invoice_records OWNER TO postgres;
ALTER TABLE public.accounting_stripe_invoice_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_stripe_invoice_records FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.accounting_stripe_invoice_records TO service_role;

-- The baseline the final assert compares with: no migration step writes an entry, a line, a parked row, a period or an
-- invoice record. A replay of the assert (tests) pins the current state here first (pinAccountingS9Baseline).
CREATE TEMP TABLE accounting_s9_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s9_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
  'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods),
  'invoice_records', (SELECT pg_catalog.count(*) FROM public.accounting_stripe_invoice_records));

-- 2. The map of types to the treatment of a lane (generated; do not edit by hand).
-- ACC_S9_CATEGORY_MAP_BEGIN
CREATE FUNCTION private.accounting_stripe_category_kind(_type text, _reporting_category text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN _type IN ('charge', 'payment') AND _reporting_category IN ('charge') THEN 'sale'
    WHEN _type IN ('refund', 'payment_refund', 'refund_failure') THEN 'refund_principal'
    WHEN _type IN ('stripe_fee', 'stripe_fx_fee') THEN 'fee_only'
    WHEN _type IN ('tax_fee') THEN 'tax_adjustment'
    WHEN _type IN ('payout') THEN 'payout'
    WHEN _type IN ('payout_failure', 'payout_cancel') THEN 'payout_failure'
    WHEN _type IN ('adjustment') AND _reporting_category IN ('dispute', 'dispute_reversal') THEN 'dispute'
    WHEN _type IN ('topup', 'topup_reversal') THEN 'manual_topup'
    ELSE NULL
  END
$$;
-- ACC_S9_CATEGORY_MAP_END

-- The signed fee a transaction carries for the fee lane: -net for a stand-alone fee type (its cost is the amount, fee can be 0),
-- 0 for a row the fee lane does not treat (a tax adjustment has its own lane; an unknown type has none), else the fee column.
CREATE FUNCTION private.accounting_stripe_fee_amount(_kind text, _fee integer, _net integer) RETURNS integer
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN _kind IS NULL OR _kind = 'tax_adjustment' THEN 0 WHEN _kind = 'fee_only' THEN -_net ELSE _fee END
$$;

-- Taxable from the day consumption_taxable_from on, in a period whose status is taxable (design 5-j).
CREATE FUNCTION private.accounting_period_taxable(_period_id uuid, _date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((SELECT p.consumption_tax_status = 'taxable' AND _date >= p.consumption_taxable_from
    FROM public.accounting_periods AS p WHERE p.id = _period_id), false)
$$;

-- An entry of this kind and one key part exists and has not been reversed (reads only; the balance reconciliation and the
-- bank lane use it). The key is built by private.accounting_event_key; a part the key cannot hold is never live.
CREATE FUNCTION private.accounting_entry_live(_kind text, _part text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(CASE WHEN _part ~ '^[A-Za-z0-9_.-]{1,128}$' THEN EXISTS (
    SELECT 1 FROM public.accounting_journal_entries AS e WHERE e.dedupe_key = private.accounting_event_key(_kind, ARRAY[_part])
      AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)) END, false)
$$;

-- 3. The fee lane (and the unknown_category lane).
CREATE FUNCTION private.accounting_post_stripe_fee_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_counterparty CONSTANT text := U&'\30B9\30C8\30E9\30A4\30D7\30B8\30E3\30D1\30F3\682A\5F0F\4F1A\793E';
  v_tx record;
  v_cutover date;
  v_kind text;
  v_fee integer;
  v_abs bigint;
  v_tax bigint;
  v_body bigint;
  v_taxable boolean;
  v_label text;
  v_memo text;
  v_date date;
  v_period uuid;
  v_reason text;
  v_expense_side text;
  v_cash_side text;
  v_expense jsonb;
  v_cash jsonb;
  v_lines jsonb;
  v_result jsonb;
  v_entry_id uuid;
  v_sqlstate text;
  v_pg_detail text;
  v_parked boolean;
  v_posted integer := 0;
  v_parked_new integer := 0;
  v_reparked integer := 0;
  v_resolved integer := 0;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_cutover := private.accounting_cutover_on();

  FOR v_tx IN
    SELECT s.id, s.type, s.reporting_category, s.fee, s.net, s.fee_details, s.stripe_created_at, s.synced_at, s.lane FROM (
      (SELECT t.id, t.type, t.reporting_category, t.fee, t.net, t.fee_details, t.stripe_created_at, t.synced_at, 0 AS lane,
         t.stripe_created_at AS sort_at
        FROM public.stripe_balance_transactions AS t
        CROSS JOIN LATERAL (SELECT private.accounting_stripe_category_kind(t.type, t.reporting_category) AS kind) AS k
        WHERE (k.kind IS NULL OR (k.kind <> 'tax_adjustment' AND private.accounting_stripe_fee_amount(k.kind, t.fee, t.net) <> 0))
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = CASE WHEN t.id ~ '^[A-Za-z0-9_.-]{1,128}$'
              THEN private.accounting_event_key('stripe_fee', ARRAY[t.id]) END)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'stripe_fee' AND p.source_table = 'stripe_balance_transactions' AND p.source_id = t.id)
        ORDER BY t.stripe_created_at, t.id
        LIMIT _limit)
      UNION ALL
      (SELECT t.id, t.type, t.reporting_category, t.fee, t.net, t.fee_details, t.stripe_created_at, t.synced_at, 1 AS lane,
         p.last_detected_at AS sort_at
        FROM public.accounting_pending_events AS p
        JOIN public.stripe_balance_transactions AS t ON t.id = p.source_id
        WHERE p.event_kind = 'stripe_fee' AND p.source_table = 'stripe_balance_transactions' AND p.resolved_at IS NULL
        ORDER BY p.last_detected_at, p.id
        LIMIT 10)
    ) AS s
    ORDER BY s.lane, s.sort_at, s.id
  LOOP
    v_reason := NULL;
    v_period := NULL;
    v_kind := private.accounting_stripe_category_kind(v_tx.type, v_tx.reporting_category);
    v_date := private.accounting_jst_date(v_tx.stripe_created_at);
    BEGIN
      v_fee := private.accounting_stripe_fee_amount(v_kind, v_tx.fee, v_tx.net);
      IF v_kind IS NOT NULL AND v_fee = 0 THEN
        -- Only an open parked row gets here: its type is known now and it has no fee for this lane (a tax adjustment has its
        -- own lane). It closes with no entry.
        IF v_tx.lane = 1 THEN
          PERFORM private.accounting_unpark_event('stripe_fee', 'stripe_balance_transactions', v_tx.id, NULL);
          v_resolved := v_resolved + 1;
        END IF;
        CONTINUE;
      END IF;
      IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
        v_reason := 'before_cutover';
      ELSIF v_kind IS NULL THEN
        v_reason := 'unknown_category';
      ELSE
        v_period := private.accounting_period_for_event(v_date);
      END IF;

      IF v_reason IS NOT NULL THEN
        PERFORM private.accounting_park_event('stripe_fee', 'stripe_balance_transactions', v_tx.id, NULL, v_reason, '{}'::jsonb);
        IF v_tx.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      ELSE
        v_abs := pg_catalog.abs(v_fee)::bigint;
        v_taxable := private.accounting_period_taxable(v_period, v_date);
        v_label := CASE WHEN v_tx.type = 'stripe_fx_fee' THEN U&'\70BA\66FF\306E\624B\6570\6599'
          WHEN v_kind = 'dispute' THEN U&'\53D6\308A\6D88\3057\306E\624B\6570\6599'
          ELSE U&'\6C7A\6E08\306E\624B\6570\6599' END;
        v_memo := v_label;
        v_tax := 0;
        IF v_taxable THEN
          IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(v_tx.fee_details) = 'array'
              THEN v_tx.fee_details ELSE '[]'::jsonb END) AS d(value) WHERE d.value ->> 'type' = 'tax') THEN
            SELECT LEAST(pg_catalog.abs(COALESCE(pg_catalog.sum(CASE WHEN pg_catalog.jsonb_typeof(d.value -> 'amount') = 'number'
                THEN (d.value ->> 'amount')::numeric END), 0)), v_abs::numeric)::bigint INTO v_tax
            FROM pg_catalog.jsonb_array_elements(CASE WHEN pg_catalog.jsonb_typeof(v_tx.fee_details) = 'array'
              THEN v_tx.fee_details ELSE '[]'::jsonb END) AS d(value) WHERE d.value ->> 'type' = 'tax';
          ELSE
            v_tax := v_abs - pg_catalog.round(v_abs::numeric / 1.1)::bigint;
            v_memo := v_label || ' tax_default_10';
          END IF;
        END IF;
        v_body := v_abs - v_tax;
        v_expense_side := CASE WHEN v_fee > 0 THEN 'debit' ELSE 'credit' END;
        v_cash_side := CASE WHEN v_fee > 0 THEN 'credit' ELSE 'debit' END;
        v_expense := '[]'::jsonb;
        IF v_body > 0 THEN
          v_expense := v_expense || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '6280',
            v_expense_side, v_body, v_cash_side, 0, 'counterparty', c_counterparty, 'memo', v_memo));
        END IF;
        IF v_tax > 0 THEN
          v_expense := v_expense || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1480',
            v_expense_side, v_tax, v_cash_side, 0, 'counterparty', c_counterparty, 'memo', v_memo));
        END IF;
        v_cash := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('account_code', '1160',
          v_cash_side, v_abs, v_expense_side, 0, 'counterparty', c_counterparty, 'memo', v_memo));
        v_lines := CASE WHEN v_fee > 0 THEN v_expense || v_cash ELSE v_cash || v_expense END;
        v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'stripe_fee', ARRAY[v_tx.id], v_label, v_lines,
          _source_table => 'stripe_balance_transactions', _source_id => v_tx.id,
          _source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp()));
        v_entry_id := (v_result ->> 'entry_id')::uuid;
        IF (v_result ->> 'created')::boolean THEN
          v_posted := v_posted + 1;
        END IF;
        IF v_tx.lane = 1 THEN
          PERFORM private.accounting_unpark_event('stripe_fee', 'stripe_balance_transactions', v_tx.id, v_entry_id);
          v_resolved := v_resolved + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- The rows and the entry number of this one event are undone with the block. Only the SQLSTATE and a fixed code
      -- are kept; the text of the exception is never stored.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure('stripe_fee', 'stripe_balance_transactions', v_tx.id, NULL,
        v_sqlstate, SQLERRM, v_pg_detail, v_date);
      -- false: nothing could be parked; the event is counted nowhere and is taken again as a new event next run.
      IF v_parked THEN
        IF v_tx.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved);
END;
$$;

-- 4. The tax adjustment lane (JCT tax adjustment: a balance transaction of its own, dated the day Stripe moved the balance).
CREATE FUNCTION private.accounting_post_stripe_tax_adjustment_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_counterparty CONSTANT text := U&'\30B9\30C8\30E9\30A4\30D7\30B8\30E3\30D1\30F3\682A\5F0F\4F1A\793E';
  c_label CONSTANT text := U&'\6D88\8CBB\7A0E\306E\8ABF\6574';
  v_tx record;
  v_cutover date;
  v_date date;
  v_period uuid;
  v_reason text;
  v_account text;
  v_abs bigint;
  v_lines jsonb;
  v_result jsonb;
  v_entry_id uuid;
  v_sqlstate text;
  v_pg_detail text;
  v_parked boolean;
  v_posted integer := 0;
  v_parked_new integer := 0;
  v_reparked integer := 0;
  v_resolved integer := 0;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_cutover := private.accounting_cutover_on();

  FOR v_tx IN
    SELECT s.id, s.net, s.stripe_created_at, s.synced_at, s.lane FROM (
      (SELECT t.id, t.net, t.stripe_created_at, t.synced_at, 0 AS lane, t.stripe_created_at AS sort_at
        FROM public.stripe_balance_transactions AS t
        WHERE private.accounting_stripe_category_kind(t.type, t.reporting_category) = 'tax_adjustment' AND t.net <> 0
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = CASE WHEN t.id ~ '^[A-Za-z0-9_.-]{1,128}$'
              THEN private.accounting_event_key('stripe_tax_adjustment', ARRAY[t.id]) END)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'stripe_tax_adjustment' AND p.source_table = 'stripe_balance_transactions' AND p.source_id = t.id)
        ORDER BY t.stripe_created_at, t.id
        LIMIT _limit)
      UNION ALL
      (SELECT t.id, t.net, t.stripe_created_at, t.synced_at, 1 AS lane, p.last_detected_at AS sort_at
        FROM public.accounting_pending_events AS p
        JOIN public.stripe_balance_transactions AS t ON t.id = p.source_id
        WHERE p.event_kind = 'stripe_tax_adjustment' AND p.source_table = 'stripe_balance_transactions' AND p.resolved_at IS NULL
        ORDER BY p.last_detected_at, p.id
        LIMIT 10)
    ) AS s
    ORDER BY s.lane, s.sort_at, s.id
  LOOP
    v_reason := NULL;
    v_period := NULL;
    v_date := private.accounting_jst_date(v_tx.stripe_created_at);
    BEGIN
      IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
        v_reason := 'before_cutover';
      ELSE
        v_period := private.accounting_period_for_event(v_date);
      END IF;

      IF v_reason IS NOT NULL THEN
        PERFORM private.accounting_park_event('stripe_tax_adjustment', 'stripe_balance_transactions', v_tx.id, NULL, v_reason,
          '{}'::jsonb);
        IF v_tx.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      ELSE
        -- A tax-included expense when the period is exempt, the input consumption tax 1480 when it is taxable. The signed cost
        -- is -net: a negative net is a cost (debit the expense, credit 1160), a positive net the reverse.
        v_account := CASE WHEN private.accounting_period_taxable(v_period, v_date) THEN '1480' ELSE '6280' END;
        v_abs := pg_catalog.abs(v_tx.net)::bigint;
        IF v_tx.net < 0 THEN
          v_lines := pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('account_code', v_account, 'debit', v_abs, 'credit', 0, 'counterparty', c_counterparty,
              'memo', c_label),
            pg_catalog.jsonb_build_object('account_code', '1160', 'debit', 0, 'credit', v_abs, 'counterparty', c_counterparty,
              'memo', c_label));
        ELSE
          v_lines := pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('account_code', '1160', 'debit', v_abs, 'credit', 0, 'counterparty', c_counterparty,
              'memo', c_label),
            pg_catalog.jsonb_build_object('account_code', v_account, 'debit', 0, 'credit', v_abs, 'counterparty', c_counterparty,
              'memo', c_label));
        END IF;
        v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'stripe_tax_adjustment', ARRAY[v_tx.id], c_label,
          v_lines, _source_table => 'stripe_balance_transactions', _source_id => v_tx.id,
          _source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp()));
        v_entry_id := (v_result ->> 'entry_id')::uuid;
        IF (v_result ->> 'created')::boolean THEN
          v_posted := v_posted + 1;
        END IF;
        IF v_tx.lane = 1 THEN
          PERFORM private.accounting_unpark_event('stripe_tax_adjustment', 'stripe_balance_transactions', v_tx.id, v_entry_id);
          v_resolved := v_resolved + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure('stripe_tax_adjustment', 'stripe_balance_transactions', v_tx.id, NULL,
        v_sqlstate, SQLERRM, v_pg_detail, v_date);
      IF v_parked THEN
        IF v_tx.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved);
END;
$$;

-- 5. The payout lane: a payout whose contents add up to its amount (reconciliation matched) and that has a payment day.
CREATE FUNCTION private.accounting_post_stripe_payout_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_label CONSTANT text := U&'\9280\884C\3078\306E\5165\91D1\306E\958B\59CB';
  v_row record;
  v_cutover date;
  v_date date;
  v_period uuid;
  v_reason text;
  v_result jsonb;
  v_entry_id uuid;
  v_sqlstate text;
  v_pg_detail text;
  v_parked boolean;
  v_posted integer := 0;
  v_parked_new integer := 0;
  v_reparked integer := 0;
  v_resolved integer := 0;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_cutover := private.accounting_cutover_on();

  FOR v_row IN
    SELECT s.id, s.amount, s.paid_at, s.reconciliation_status, s.synced_at, s.lane FROM (
      (SELECT o.id, o.amount, o.paid_at, o.reconciliation_status, o.synced_at, 0 AS lane, o.paid_at AS sort_at
        FROM public.stripe_payouts AS o
        WHERE o.paid_at IS NOT NULL AND o.reconciliation_status IN ('matched', 'mismatch')
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = CASE WHEN o.id ~ '^[A-Za-z0-9_.-]{1,128}$'
              THEN private.accounting_event_key('payout_started', ARRAY[o.id]) END)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'payout_started' AND p.source_table = 'stripe_payouts' AND p.source_id = o.id)
        ORDER BY o.paid_at, o.id
        LIMIT _limit)
      UNION ALL
      (SELECT o.id, o.amount, o.paid_at, o.reconciliation_status, o.synced_at, 1 AS lane, p.last_detected_at AS sort_at
        FROM public.accounting_pending_events AS p
        JOIN public.stripe_payouts AS o ON o.id = p.source_id
        WHERE p.event_kind = 'payout_started' AND p.source_table = 'stripe_payouts' AND p.resolved_at IS NULL
        ORDER BY p.last_detected_at, p.id
        LIMIT 10)
    ) AS s
    ORDER BY s.lane, s.sort_at, s.id
  LOOP
    v_reason := NULL;
    v_period := NULL;
    v_date := private.accounting_jst_date(v_row.paid_at);
    BEGIN
      IF v_row.reconciliation_status = 'pending' THEN
        -- Waiting for the reconciliation only: a parked row of this payout stays as it is.
        CONTINUE;
      END IF;
      IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
        v_reason := 'before_cutover';
      ELSE
        v_period := private.accounting_period_for_event(v_date);
        IF v_row.reconciliation_status <> 'matched' THEN
          v_reason := 'payout_mismatch';
        END IF;
      END IF;

      IF v_reason IS NOT NULL THEN
        PERFORM private.accounting_park_event('payout_started', 'stripe_payouts', v_row.id, NULL, v_reason, '{}'::jsonb);
        IF v_row.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      ELSE
        v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'payout_started', ARRAY[v_row.id], c_label,
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('account_code', '1150', 'debit', v_row.amount, 'credit', 0),
            pg_catalog.jsonb_build_object('account_code', '1160', 'debit', 0, 'credit', v_row.amount)),
          _source_table => 'stripe_payouts', _source_id => v_row.id,
          _source_recorded_at => LEAST(v_row.synced_at, pg_catalog.clock_timestamp()));
        v_entry_id := (v_result ->> 'entry_id')::uuid;
        IF (v_result ->> 'created')::boolean THEN
          v_posted := v_posted + 1;
        END IF;
        IF v_row.lane = 1 THEN
          PERFORM private.accounting_unpark_event('payout_started', 'stripe_payouts', v_row.id, v_entry_id);
          v_resolved := v_resolved + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure('payout_started', 'stripe_payouts', v_row.id, NULL,
        v_sqlstate, SQLERRM, v_pg_detail, v_date);
      IF v_parked THEN
        IF v_row.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved);
END;
$$;

-- 6. The bank arrival lane: the day the person confirmed the money reached the bank, only after the payout's own entry exists.
CREATE FUNCTION private.accounting_post_stripe_bank_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_label CONSTANT text := U&'\9280\884C\3078\306E\7740\91D1';
  v_row record;
  v_cutover date;
  v_date date;
  v_period uuid;
  v_reason text;
  v_result jsonb;
  v_entry_id uuid;
  v_sqlstate text;
  v_pg_detail text;
  v_parked boolean;
  v_posted integer := 0;
  v_parked_new integer := 0;
  v_reparked integer := 0;
  v_resolved integer := 0;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_cutover := private.accounting_cutover_on();

  FOR v_row IN
    SELECT s.id, s.amount, s.bank_arrival_date, s.bank_confirmed_at, s.lane FROM (
      (SELECT o.id, o.amount, o.bank_arrival_date, o.bank_confirmed_at, 0 AS lane, o.bank_arrival_date::timestamptz AS sort_at
        FROM public.stripe_payouts AS o
        WHERE o.bank_arrival_date IS NOT NULL AND o.bank_confirmed_at IS NOT NULL
          AND private.accounting_entry_live('payout_started', o.id)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = CASE WHEN o.id ~ '^[A-Za-z0-9_.-]{1,128}$'
              THEN private.accounting_event_key('bank_arrived', ARRAY[o.id]) END)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'bank_arrived' AND p.source_table = 'stripe_payouts' AND p.source_id = o.id)
        ORDER BY o.bank_arrival_date, o.id
        LIMIT _limit)
      UNION ALL
      (SELECT o.id, o.amount, o.bank_arrival_date, o.bank_confirmed_at, 1 AS lane, p.last_detected_at AS sort_at
        FROM public.accounting_pending_events AS p
        JOIN public.stripe_payouts AS o ON o.id = p.source_id
        WHERE p.event_kind = 'bank_arrived' AND p.source_table = 'stripe_payouts' AND p.resolved_at IS NULL
        ORDER BY p.last_detected_at, p.id
        LIMIT 10)
    ) AS s
    ORDER BY s.lane, s.sort_at, s.id
  LOOP
    v_reason := NULL;
    v_period := NULL;
    v_date := v_row.bank_arrival_date;
    BEGIN
      IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
        v_reason := 'before_cutover';
      ELSE
        v_period := private.accounting_period_for_event(v_date);
      END IF;

      IF v_reason IS NOT NULL THEN
        PERFORM private.accounting_park_event('bank_arrived', 'stripe_payouts', v_row.id, NULL, v_reason, '{}'::jsonb);
        IF v_row.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      ELSE
        v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'bank_arrived', ARRAY[v_row.id], c_label,
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('account_code', '1040', 'debit', v_row.amount, 'credit', 0),
            pg_catalog.jsonb_build_object('account_code', '1150', 'debit', 0, 'credit', v_row.amount)),
          _source_table => 'stripe_payouts', _source_id => v_row.id,
          _source_recorded_at => LEAST(v_row.bank_confirmed_at, pg_catalog.clock_timestamp()));
        v_entry_id := (v_result ->> 'entry_id')::uuid;
        IF (v_result ->> 'created')::boolean THEN
          v_posted := v_posted + 1;
        END IF;
        IF v_row.lane = 1 THEN
          PERFORM private.accounting_unpark_event('bank_arrived', 'stripe_payouts', v_row.id, v_entry_id);
          v_resolved := v_resolved + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure('bank_arrived', 'stripe_payouts', v_row.id, NULL,
        v_sqlstate, SQLERRM, v_pg_detail, v_date);
      IF v_parked THEN
        IF v_row.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved);
END;
$$;

-- 7. The payout failure lane: the return transaction of a failed or canceled payout, only when the payout's own entry exists.
CREATE FUNCTION private.accounting_post_stripe_payout_failure_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  c_label CONSTANT text := U&'\5165\91D1\306E\5931\6557';
  v_tx record;
  v_pt record;
  v_cutover date;
  v_date date;
  v_period uuid;
  v_reason text;
  v_detail jsonb;
  v_started uuid;
  v_zero boolean;
  v_abs bigint;
  v_memo text;
  v_retried text;
  v_result jsonb;
  v_entry_id uuid;
  v_sqlstate text;
  v_pg_detail text;
  v_parked boolean;
  v_posted integer := 0;
  v_parked_new integer := 0;
  v_reparked integer := 0;
  v_resolved integer := 0;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_cutover := private.accounting_cutover_on();

  FOR v_tx IN
    SELECT s.id, s.source_id, s.amount, s.raw_payload, s.stripe_created_at, s.synced_at, s.lane FROM (
      (SELECT t.id, t.source_id, t.amount, t.raw_payload, t.stripe_created_at, t.synced_at, 0 AS lane, t.stripe_created_at AS sort_at
        FROM public.stripe_balance_transactions AS t
        WHERE private.accounting_stripe_category_kind(t.type, t.reporting_category) = 'payout_failure' AND t.amount <> 0
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = CASE WHEN t.id ~ '^[A-Za-z0-9_.-]{1,128}$'
              THEN private.accounting_event_key('payout_failed', ARRAY[t.id]) END)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'payout_failed' AND p.source_table = 'stripe_balance_transactions' AND p.source_id = t.id)
        ORDER BY t.stripe_created_at, t.id
        LIMIT _limit)
      UNION ALL
      (SELECT t.id, t.source_id, t.amount, t.raw_payload, t.stripe_created_at, t.synced_at, 1 AS lane, p.last_detected_at AS sort_at
        FROM public.accounting_pending_events AS p
        JOIN public.stripe_balance_transactions AS t ON t.id = p.source_id
        WHERE p.event_kind = 'payout_failed' AND p.source_table = 'stripe_balance_transactions' AND p.resolved_at IS NULL
        ORDER BY p.last_detected_at, p.id
        LIMIT 10)
    ) AS s
    ORDER BY s.lane, s.sort_at, s.id
  LOOP
    v_reason := NULL;
    v_detail := '{}'::jsonb;
    v_period := NULL;
    v_started := NULL;
    v_zero := false;
    v_date := private.accounting_jst_date(v_tx.stripe_created_at);
    BEGIN
      IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
        v_reason := 'before_cutover';
      ELSE
        v_period := private.accounting_period_for_event(v_date);
        SELECT e.id INTO v_started FROM public.accounting_journal_entries AS e
        WHERE e.dedupe_key = CASE WHEN v_tx.source_id ~ '^[A-Za-z0-9_.-]{1,128}$'
          THEN private.accounting_event_key('payout_started', ARRAY[v_tx.source_id]) END;
        IF v_started IS NULL THEN
          -- A payout that failed or was canceled before it had a payment day never gets its own entry: its payout transaction
          -- and this return cancel each other. Any other payout (still to be reconciled, a mismatch, a missing period) is
          -- waited for, so 1150 can never go negative.
          IF EXISTS (SELECT 1 FROM public.stripe_payouts AS o WHERE o.id = v_tx.source_id AND o.status IN ('failed', 'canceled')
              AND o.paid_at IS NULL) THEN
            v_zero := true;
          ELSE
            v_reason := 'payout_mismatch';
            v_detail := pg_catalog.jsonb_build_object('payout_state', 'payout_not_posted');
          END IF;
        END IF;
      END IF;

      IF v_zero THEN
        FOR v_pt IN SELECT t2.id FROM public.stripe_balance_transactions AS t2
          WHERE t2.type = 'payout' AND t2.source_id = v_tx.source_id ORDER BY t2.id
        LOOP
          PERFORM private.accounting_park_event('payout_started', 'stripe_balance_transactions', v_pt.id, NULL, 'payout_mismatch',
            pg_catalog.jsonb_build_object('payout_state', 'payout_net_zero'));
          PERFORM private.accounting_unpark_event('payout_started', 'stripe_balance_transactions', v_pt.id, NULL);
        END LOOP;
        PERFORM private.accounting_park_event('payout_started', 'stripe_payouts', v_tx.source_id, NULL, 'payout_mismatch',
          pg_catalog.jsonb_build_object('payout_state', 'payout_net_zero'));
        PERFORM private.accounting_unpark_event('payout_started', 'stripe_payouts', v_tx.source_id, NULL);
        PERFORM private.accounting_park_event('payout_failed', 'stripe_balance_transactions', v_tx.id, NULL, 'payout_mismatch',
          pg_catalog.jsonb_build_object('payout_state', 'payout_net_zero'));
        PERFORM private.accounting_unpark_event('payout_failed', 'stripe_balance_transactions', v_tx.id, NULL);
        v_resolved := v_resolved + 1;
      ELSIF v_reason IS NOT NULL THEN
        PERFORM private.accounting_park_event('payout_failed', 'stripe_balance_transactions', v_tx.id, NULL, v_reason, v_detail);
        IF v_tx.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      ELSE
        -- The return posts the amount (the principal of the transaction); a fee on it belongs to the fee lane.
        v_abs := pg_catalog.abs(v_tx.amount)::bigint;
        v_memo := 'payout:' || v_tx.source_id;
        v_retried := v_tx.raw_payload ->> 'retried_payout_id';
        IF v_retried ~ '^[A-Za-z0-9_.-]{1,128}$' THEN
          v_memo := v_memo || ' retried:' || v_retried;
        END IF;
        v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'payout_failed', ARRAY[v_tx.id], c_label,
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('account_code', '1160', 'debit', v_abs, 'credit', 0, 'memo', v_memo),
            pg_catalog.jsonb_build_object('account_code', '1150', 'debit', 0, 'credit', v_abs, 'memo', v_memo)),
          _source_table => 'stripe_balance_transactions', _source_id => v_tx.id,
          _source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp()));
        v_entry_id := (v_result ->> 'entry_id')::uuid;
        IF (v_result ->> 'created')::boolean THEN
          v_posted := v_posted + 1;
        END IF;
        IF v_tx.lane = 1 THEN
          PERFORM private.accounting_unpark_event('payout_failed', 'stripe_balance_transactions', v_tx.id, v_entry_id);
          v_resolved := v_resolved + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      v_parked := private.accounting_park_failure('payout_failed', 'stripe_balance_transactions', v_tx.id, NULL,
        v_sqlstate, SQLERRM, v_pg_detail, v_date);
      IF v_parked THEN
        IF v_tx.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved);
END;
$$;

-- 8. The runner of the five lanes.
CREATE FUNCTION private.accounting_post_stripe_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_fee jsonb;
  v_tax jsonb;
  v_payout jsonb;
  v_bank jsonb;
  v_failure jsonb;
BEGIN
  IF _limit IS NULL OR _limit < 1 OR _limit > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_fee := private.accounting_post_stripe_fee_events(_limit);
  v_tax := private.accounting_post_stripe_tax_adjustment_events(_limit);
  v_payout := private.accounting_post_stripe_payout_events(_limit);
  v_bank := private.accounting_post_stripe_bank_events(_limit);
  v_failure := private.accounting_post_stripe_payout_failure_events(_limit);
  RETURN pg_catalog.jsonb_build_object(
    'posted', (v_fee ->> 'posted')::integer + (v_tax ->> 'posted')::integer + (v_payout ->> 'posted')::integer
      + (v_bank ->> 'posted')::integer + (v_failure ->> 'posted')::integer,
    'parked_new', (v_fee ->> 'parked_new')::integer + (v_tax ->> 'parked_new')::integer + (v_payout ->> 'parked_new')::integer
      + (v_bank ->> 'parked_new')::integer + (v_failure ->> 'parked_new')::integer,
    'reparked', (v_fee ->> 'reparked')::integer + (v_tax ->> 'reparked')::integer + (v_payout ->> 'reparked')::integer
      + (v_bank ->> 'reparked')::integer + (v_failure ->> 'reparked')::integer,
    'resolved', (v_fee ->> 'resolved')::integer + (v_tax ->> 'resolved')::integer + (v_payout ->> 'resolved')::integer
      + (v_bank ->> 'resolved')::integer + (v_failure ->> 'resolved')::integer,
    'fees', (v_fee ->> 'posted')::integer, 'tax_adjustments', (v_tax ->> 'posted')::integer,
    'payouts', (v_payout ->> 'posted')::integer, 'bank_arrivals', (v_bank ->> 'posted')::integer,
    'payout_failures', (v_failure ->> 'posted')::integer);
END;
$$;

-- 9. The balance top-up (design 1-a14, 4-h): Stripe's balance was negative and the bank paid it.
CREATE FUNCTION private.admin_record_balance_topup(_actor_id uuid, _amount bigint, _bank_date date, _bank_txn_no text,
  _stripe_txn_id text, _note text, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_bank text;
  v_stripe text;
  v_ref text;
  v_cutover date;
  v_period uuid;
  v_label CONSTANT text := U&'\6B8B\9AD8\306E\88DC\5145';
  v_note text;
  v_other public.accounting_journal_entries%ROWTYPE;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.finance.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_bank := NULLIF(pg_catalog.btrim(_bank_txn_no), '');
  v_stripe := NULLIF(pg_catalog.btrim(_stripe_txn_id), '');
  v_ref := COALESCE(v_bank, v_stripe);
  v_note := NULLIF(pg_catalog.btrim(_note), '');
  IF _amount IS NULL OR _amount < 1 OR _amount > 9007199254740991 OR _bank_date IS NULL OR _request_key IS NULL
    OR v_ref IS NULL OR v_ref !~ '^[A-Za-z0-9_.-]{1,128}$'
    OR (v_stripe IS NOT NULL AND v_stripe !~ '^[A-Za-z0-9_.-]{1,128}$')
    OR pg_catalog.char_length(v_note) > 400
    OR _bank_date > private.accounting_jst_date(pg_catalog.clock_timestamp()) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_cutover := private.accounting_cutover_on();
  IF v_cutover IS NOT NULL AND _bank_date < v_cutover THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_period := private.accounting_period_for_event(_bank_date, _actor_id);
  -- Bound to the Stripe-side record: a live top-up entry that already has this Stripe transaction under another key is the
  -- same top-up. The same content answers that entry; any other content is refused.
  IF v_stripe IS NOT NULL THEN
    SELECT e.* INTO v_other FROM public.accounting_journal_entries AS e
    WHERE e.event_kind = 'balance_topup' AND e.source_table = 'stripe_balance_transactions' AND e.source_id = v_stripe
      AND e.dedupe_key <> private.accounting_event_key('balance_topup', ARRAY[v_ref])
      AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS r WHERE r.reverses_entry_id = e.id)
    ORDER BY e.recorded_at, e.id LIMIT 1;
    IF FOUND THEN
      IF v_other.entry_date = _bank_date AND EXISTS (SELECT 1 FROM public.accounting_journal_lines AS l
          WHERE l.entry_id = v_other.id AND l.account_code = '1160' AND l.debit = _amount) THEN
        RETURN pg_catalog.jsonb_build_object('entry_id', v_other.id, 'entry_no', v_other.entry_no,
          'period_id', v_other.period_id, 'created', false);
      END IF;
      RAISE EXCEPTION 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN private.accounting_post_journal_core(_actor_id, v_period, _bank_date, 'balance_topup', ARRAY[v_ref],
    CASE WHEN v_note IS NULL THEN v_label ELSE v_label || ' / ' || v_note END,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('account_code', '1160', 'debit', _amount, 'credit', 0, 'memo', v_stripe),
      pg_catalog.jsonb_build_object('account_code', '1040', 'debit', 0, 'credit', _amount, 'memo', v_stripe)),
    _source_table => CASE WHEN v_stripe IS NULL THEN NULL ELSE 'stripe_balance_transactions' END, _source_id => v_stripe);
END;
$$;

-- 10. The invoice record (the total, the tax and a reference text of the invoice of a UTC month).
CREATE FUNCTION private.admin_set_stripe_invoice_record(_actor_id uuid, _invoice_month text, _invoice_total bigint,
  _invoice_tax bigint, _document_ref text, _expected_version bigint, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior jsonb;
  v_row public.accounting_stripe_invoice_records%ROWTYPE;
  v_ref text;
  v_version bigint;
  v_entered_at timestamptz;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.finance.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_ref := NULLIF(pg_catalog.btrim(_document_ref), '');
  IF _invoice_month IS NULL OR _invoice_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' OR _invoice_total IS NULL OR _invoice_total < 0
    OR _invoice_tax IS NULL OR _invoice_tax < 0 OR pg_catalog.char_length(v_ref) > 200 OR _request_key IS NULL
    OR (_expected_version IS NOT NULL AND _expected_version < 1) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'set_stripe_invoice_record', 'actor', _actor_id,
    'month', _invoice_month, 'total', _invoice_total, 'tax', _invoice_tax, 'ref', _document_ref,
    'version', _expected_version::text));
  SELECT r.admin_requests -> (_request_key::text) INTO v_prior
  FROM public.accounting_stripe_invoice_records AS r WHERE r.admin_requests ? (_request_key::text);
  IF v_prior IS NOT NULL THEN
    IF v_prior ->> 'hash' IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior -> 'result';
  END IF;
  SELECT * INTO v_row FROM public.accounting_stripe_invoice_records AS r WHERE r.invoice_month = _invoice_month FOR UPDATE;
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
  v_entered_at := pg_catalog.now();
  v_result := pg_catalog.jsonb_build_object('invoice_month', _invoice_month, 'invoice_total', _invoice_total,
    'invoice_tax', _invoice_tax, 'document_ref', v_ref, 'version', v_version::text, 'entered_at', v_entered_at);
  IF _expected_version IS NULL THEN
    INSERT INTO public.accounting_stripe_invoice_records (invoice_month, invoice_total, invoice_tax, document_ref, entered_by,
      entered_at, version, admin_requests)
    VALUES (_invoice_month, _invoice_total, _invoice_tax, v_ref, _actor_id, v_entered_at, v_version,
      pg_catalog.jsonb_build_object(_request_key::text, pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result)));
  ELSE
    UPDATE public.accounting_stripe_invoice_records AS r
    SET invoice_total = _invoice_total, invoice_tax = _invoice_tax, document_ref = v_ref, entered_by = _actor_id,
      entered_at = v_entered_at, version = v_version,
      admin_requests = r.admin_requests || pg_catalog.jsonb_build_object(_request_key::text,
        pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result))
    WHERE r.invoice_month = _invoice_month;
  END IF;
  RETURN v_result;
END;
$$;

-- 11. The fee reconciliation of one Japan month (design 4-c): the total by the Japan month and by the UTC month of the same
--     fee_amount, the transactions at the edge that explain the difference, the invoice of that UTC month and the tax
--     adjustments of the next month. The books are compared apart (journal_vs_txn_diff).
CREATE FUNCTION private.get_stripe_fee_reconciliation(_month text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_start date;
  v_next date;
  v_after date;
  v_jst_total bigint;
  v_utc_total bigint;
  v_in jsonb;
  v_in_sum bigint;
  v_out jsonb;
  v_out_sum bigint;
  v_adjustments jsonb;
  v_adjustments_sum bigint;
  v_invoice bigint;
  v_has_invoice boolean;
  v_journal bigint;
  v_diff bigint;
  v_explained bigint;
BEGIN
  IF _month IS NULL OR _month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_start := (_month || '-01')::date;
  v_next := (v_start + interval '1 month')::date;
  v_after := (v_start + interval '2 months')::date;
  WITH f AS (
    SELECT t.id, t.stripe_created_at, private.accounting_stripe_fee_amount(k.kind, t.fee, t.net) AS amount,
      private.accounting_jst_date(t.stripe_created_at) AS jst_date,
      (t.stripe_created_at AT TIME ZONE 'UTC')::date AS utc_date
    FROM public.stripe_balance_transactions AS t
    CROSS JOIN LATERAL (SELECT private.accounting_stripe_category_kind(t.type, t.reporting_category) AS kind) AS k
    WHERE k.kind IS NOT NULL AND k.kind <> 'tax_adjustment')
  SELECT
    COALESCE(pg_catalog.sum(f.amount) FILTER (WHERE f.jst_date >= v_start AND f.jst_date < v_next), 0),
    COALESCE(pg_catalog.sum(f.amount) FILTER (WHERE f.utc_date >= v_start AND f.utc_date < v_next), 0),
    COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('txn_id', f.id, 'jst_date', pg_catalog.to_char(f.jst_date, 'YYYY-MM-DD'),
      'utc_date', pg_catalog.to_char(f.utc_date, 'YYYY-MM-DD'), 'fee', f.amount) ORDER BY f.stripe_created_at, f.id)
      FILTER (WHERE f.jst_date >= v_start AND f.jst_date < v_next AND f.utc_date < v_start), '[]'::jsonb),
    COALESCE(pg_catalog.sum(f.amount) FILTER (WHERE f.jst_date >= v_start AND f.jst_date < v_next AND f.utc_date < v_start), 0),
    COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('txn_id', f.id, 'jst_date', pg_catalog.to_char(f.jst_date, 'YYYY-MM-DD'),
      'utc_date', pg_catalog.to_char(f.utc_date, 'YYYY-MM-DD'), 'fee', f.amount) ORDER BY f.stripe_created_at, f.id)
      FILTER (WHERE f.utc_date >= v_start AND f.utc_date < v_next AND f.jst_date >= v_next), '[]'::jsonb),
    COALESCE(pg_catalog.sum(f.amount) FILTER (WHERE f.utc_date >= v_start AND f.utc_date < v_next AND f.jst_date >= v_next), 0)
  INTO v_jst_total, v_utc_total, v_in, v_in_sum, v_out, v_out_sum
  FROM f WHERE f.amount <> 0;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('txn_id', t.id,
      'jst_date', pg_catalog.to_char(d.jst_date, 'YYYY-MM-DD'), 'amount', -t.net) ORDER BY t.stripe_created_at, t.id), '[]'::jsonb),
    COALESCE(pg_catalog.sum(-t.net), 0)
  INTO v_adjustments, v_adjustments_sum
  FROM public.stripe_balance_transactions AS t
  CROSS JOIN LATERAL (SELECT private.accounting_jst_date(t.stripe_created_at) AS jst_date) AS d
  WHERE private.accounting_stripe_category_kind(t.type, t.reporting_category) = 'tax_adjustment' AND t.net <> 0
    AND d.jst_date >= v_next AND d.jst_date < v_after;

  SELECT r.invoice_total INTO v_invoice FROM public.accounting_stripe_invoice_records AS r WHERE r.invoice_month = _month;
  v_has_invoice := FOUND;

  SELECT COALESCE(pg_catalog.sum(l.debit - l.credit), 0) INTO v_journal
  FROM public.accounting_journal_lines AS l
  JOIN public.accounting_journal_entries AS e ON e.id = l.entry_id
  LEFT JOIN public.accounting_journal_entries AS o ON o.id = e.reverses_entry_id
  WHERE (e.event_kind = 'stripe_fee' OR (e.event_kind = 'reversal' AND o.event_kind = 'stripe_fee'))
    AND e.entry_date >= v_start AND e.entry_date < v_next AND l.account_code IN ('6280', '1480');

  v_diff := v_jst_total - v_utc_total;
  v_explained := v_in_sum - v_out_sum;
  RETURN pg_catalog.jsonb_build_object(
    'jst_total', v_jst_total, 'utc_total', v_utc_total, 'invoice_total', v_invoice,
    'boundary_in', v_in, 'boundary_out', v_out, 'next_month_adjustments', v_adjustments,
    'diff_jst_utc', v_diff, 'explained_boundary', v_explained, 'unexplained_jst_utc', v_diff - v_explained,
    'diff_utc_invoice', CASE WHEN v_has_invoice THEN v_utc_total - v_invoice END,
    'explained_adjustments', CASE WHEN v_has_invoice THEN v_adjustments_sum END,
    -- The adjustment of the next month moves the balance so that invoice = utc_total + adjustment cost (cost = -net),
    -- so the difference is explained when (utc_total - invoice) + cost is 0. THE SIGN AWAITS CONFIRMATION against a real
    -- invoice and its adjustment (plan 2 Task 16 step 4); if it is the other way, flip this one sign.
    'unexplained_utc_invoice', CASE WHEN v_has_invoice THEN (v_utc_total - v_invoice) + v_adjustments_sum END,
    'journal_vs_txn_diff', v_jst_total - v_journal);
END;
$$;

-- 12. The balance reconciliation (design 7-i5): the Stripe balance against 1160 and the Stripe part of 1130, and what the
--     difference is made of. Every transaction has up to two parts that reach 1160: the principal (the amount; the net for a tax
--     adjustment; none for a stand-alone fee) and the fee (-fee_amount). A part that is on the books (an entry of its key that
--     has not been reversed) is journaled; the rest is named by its kind. 1150 is shown apart and never added.
--     A dispute transaction counts as journaled when its dispute_event entry of S11 exists (private.accounting_dispute_key, called
--     when this function runs: S11 is applied after this file, so the call is late-bound).
--     ledger_1160 sums every entry dated up to the day, so an entry and its reversal cancel (the entry no longer counts as
--     journaled in the parts above). A manual top-up is not a part of a transaction: its bucket is the top-up transactions minus
--     the top-up entries on the books, so an entered top-up is explained once, never twice.
CREATE FUNCTION private.get_stripe_balance_reconciliation(_through date) RETURNS jsonb
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

-- 13. Public entries (same name, arguments and result; LANGUAGE sql SECURITY INVOKER; service_role only).
CREATE FUNCTION public.admin_record_balance_topup(_actor_id uuid, _amount bigint, _bank_date date, _bank_txn_no text,
  _stripe_txn_id text, _note text, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_record_balance_topup(_actor_id, _amount, _bank_date, _bank_txn_no, _stripe_txn_id, _note, _request_key) $$;

CREATE FUNCTION public.admin_set_stripe_invoice_record(_actor_id uuid, _invoice_month text, _invoice_total bigint,
  _invoice_tax bigint, _document_ref text, _expected_version bigint, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_set_stripe_invoice_record(_actor_id, _invoice_month, _invoice_total, _invoice_tax, _document_ref,
  _expected_version, _request_key) $$;

CREATE FUNCTION public.get_stripe_fee_reconciliation(_month text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_stripe_fee_reconciliation(_month) $$;

CREATE FUNCTION public.get_stripe_balance_reconciliation(_through date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_stripe_balance_reconciliation(_through) $$;

-- 14. Owners and EXECUTE. service_role: the two writers and the two reads (private and public); everything else is owner only.
ALTER FUNCTION private.accounting_stripe_category_kind(text,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_stripe_fee_amount(text,integer,integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_period_taxable(uuid,date) OWNER TO postgres;
ALTER FUNCTION private.accounting_entry_live(text,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_stripe_fee_events(integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_stripe_tax_adjustment_events(integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_stripe_payout_events(integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_stripe_bank_events(integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_stripe_payout_failure_events(integer) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_stripe_events(integer) OWNER TO postgres;
ALTER FUNCTION private.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION private.get_stripe_fee_reconciliation(text) OWNER TO postgres;
ALTER FUNCTION private.get_stripe_balance_reconciliation(date) OWNER TO postgres;
ALTER FUNCTION public.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_stripe_fee_reconciliation(text) OWNER TO postgres;
ALTER FUNCTION public.get_stripe_balance_reconciliation(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_stripe_category_kind(text,text), private.accounting_stripe_fee_amount(text,integer,integer),
  private.accounting_period_taxable(uuid,date), private.accounting_entry_live(text,text),
  private.accounting_post_stripe_fee_events(integer), private.accounting_post_stripe_tax_adjustment_events(integer),
  private.accounting_post_stripe_payout_events(integer), private.accounting_post_stripe_bank_events(integer),
  private.accounting_post_stripe_payout_failure_events(integer), private.accounting_post_stripe_events(integer),
  private.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid),
  private.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid),
  private.get_stripe_fee_reconciliation(text), private.get_stripe_balance_reconciliation(date),
  public.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid),
  public.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid),
  public.get_stripe_fee_reconciliation(text), public.get_stripe_balance_reconciliation(date)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid),
  private.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid),
  private.get_stripe_fee_reconciliation(text), private.get_stripe_balance_reconciliation(date),
  public.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid),
  public.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid),
  public.get_stripe_fee_reconciliation(text), public.get_stripe_balance_reconciliation(date)
TO service_role;
-- ACC_S9_BODY_END

-- ACC_S9_FINAL_ASSERT_BEGIN
-- Catalog meaning only (never ACL text). acc_s9_tables: the invoice record table (owner, columns, constraints).
-- acc_s9_rls_acl: RLS on, no policy, service_role holds SELECT only. acc_s9_functions: each function exists once and its text keeps
-- the rules of the plan (the first lock, no row lock in a lane, the accounts, the keys through the core, the source time, the
-- failure helper, the permission). acc_s9_function_attrs: owner, SECURITY, volatility, language, result, arguments, search_path
-- and EXECUTE (nobody for the lanes and helpers, service_role only for the two writers and two reads), no public function of
-- the same name for a private-only one. acc_s9_reads_stable: the reads are STABLE and write nothing. acc_s9_category_map: the map
-- is IMMUTABLE and answers every pair of the plan as written. acc_s9_existing_dml_allowlist: this migration wrote no row.
DO $acc_s9_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_oid oid;
  v_src text;
  v_baseline jsonb;
  p record;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s9_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s9_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s9_baseline) <> 1 THEN
    v_failed := 'acc_s9_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s9_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['entries', 'lines', 'pending_events', 'periods', 'invoice_records']) AS k(name)
        WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s9_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s9_tables';
  IF v_failed IS NULL THEN
    SELECT c.* INTO p FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass('public.accounting_stripe_invoice_records');
    IF p.oid IS NULL OR p.relkind <> 'r' OR p.relowner <> 'postgres'::regrole
      OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
            || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
            || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute AS a
          LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = p.oid AND a.attnum > 0 AND NOT a.attisdropped)
        IS DISTINCT FROM 'invoice_month text not null, invoice_total bigint not null, invoice_tax bigint not null default 0, document_ref text, entered_by uuid, entered_at timestamp with time zone default now(), version bigint not null default 1, admin_requests jsonb not null default ''{}''::jsonb'
      OR (SELECT pg_catalog.string_agg(o.conname::text || ' ' || o.contype::text || ' ' || o.convalidated::text || ' ' || o.condeferrable::text
            || ' ' || pg_catalog.pg_get_constraintdef(o.oid), E'\n' ORDER BY o.conname::text COLLATE "C")
          FROM pg_catalog.pg_constraint AS o WHERE o.conrelid = p.oid)
        IS DISTINCT FROM E'accounting_stripe_invoice_records_admin_requests_check c true false CHECK ((jsonb_typeof(admin_requests) = ''object''::text))\naccounting_stripe_invoice_records_document_ref_check c true false CHECK ((char_length(document_ref) <= 200))\naccounting_stripe_invoice_records_invoice_month_check c true false CHECK ((invoice_month ~ ''^[0-9]{4}-(0[1-9]|1[0-2])$''::text))\naccounting_stripe_invoice_records_invoice_tax_check c true false CHECK ((invoice_tax >= 0))\naccounting_stripe_invoice_records_invoice_total_check c true false CHECK ((invoice_total >= 0))\naccounting_stripe_invoice_records_pkey p true false PRIMARY KEY (invoice_month)\naccounting_stripe_invoice_records_version_check c true false CHECK ((version >= 1))' THEN
      v_failed := 'acc_s9_tables';
    END IF;
  END IF;

  v_stage := 'acc_s9_rls_acl';
  IF v_failed IS NULL THEN
    SELECT c.* INTO p FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass('public.accounting_stripe_invoice_records');
    IF NOT p.relrowsecurity
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = p.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']) AS r(name), pg_catalog.unnest(
          ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS g(priv)
        WHERE pg_catalog.has_table_privilege(r.name, p.oid, g.priv))
      OR NOT pg_catalog.has_table_privilege('service_role', p.oid, 'SELECT')
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS g(priv)
        WHERE pg_catalog.has_table_privilege('service_role', p.oid, g.priv))
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.relacl, pg_catalog.acldefault('r', p.relowner))) AS a
        WHERE a.grantee <> p.relowner AND a.grantee <> 'service_role'::regrole) THEN
      v_failed := 'acc_s9_rls_acl';
    END IF;
  END IF;

  v_stage := 'acc_s9_functions';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_post_stripe_fee_events(integer)', true, ARRAY[
        'PERFORM private.accounting_lock_all(NULL);', 'private.accounting_stripe_category_kind(', 'private.accounting_stripe_fee_amount(',
        '''6280''', '''1480''', '''1160''', '''stripe_fee''', 'private.accounting_jst_date(v_tx.stripe_created_at)',
        'private.accounting_period_for_event(v_date)', 'private.accounting_period_taxable(', 'tax_default_10', 'unknown_category',
        'private.accounting_park_failure(''stripe_fee'',', 'IF v_parked THEN', 'EXCEPTION WHEN OTHERS',
        '_source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp())',
        'private.accounting_event_key(''stripe_fee'', ARRAY[t.id])']),
      ('private.accounting_post_stripe_tax_adjustment_events(integer)', true, ARRAY[
        'PERFORM private.accounting_lock_all(NULL);', '''tax_adjustment''', '''6280''', '''1480''', '''1160''', '''stripe_tax_adjustment''',
        'private.accounting_period_for_event(v_date)', 'private.accounting_period_taxable(',
        'private.accounting_park_failure(''stripe_tax_adjustment'',', 'IF v_parked THEN', 'EXCEPTION WHEN OTHERS',
        '_source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp())',
        'private.accounting_event_key(''stripe_tax_adjustment'', ARRAY[t.id])']),
      ('private.accounting_post_stripe_payout_events(integer)', true, ARRAY[
        'PERFORM private.accounting_lock_all(NULL);', '''1150''', '''1160''', '''payout_started''', 'private.accounting_jst_date(v_row.paid_at)',
        'private.accounting_period_for_event(v_date)', '''matched''', 'payout_mismatch',
        'private.accounting_park_failure(''payout_started'',', 'IF v_parked THEN', 'EXCEPTION WHEN OTHERS',
        '_source_recorded_at => LEAST(v_row.synced_at, pg_catalog.clock_timestamp())',
        'private.accounting_event_key(''payout_started'', ARRAY[o.id])']),
      ('private.accounting_post_stripe_bank_events(integer)', true, ARRAY[
        'PERFORM private.accounting_lock_all(NULL);', '''1040''', '''1150''', '''bank_arrived''', 'v_date := v_row.bank_arrival_date;',
        'private.accounting_period_for_event(v_date)', 'private.accounting_entry_live(''payout_started'', o.id)',
        'private.accounting_park_failure(''bank_arrived'',', 'IF v_parked THEN', 'EXCEPTION WHEN OTHERS',
        '_source_recorded_at => LEAST(v_row.bank_confirmed_at, pg_catalog.clock_timestamp())']),
      ('private.accounting_post_stripe_payout_failure_events(integer)', true, ARRAY[
        'PERFORM private.accounting_lock_all(NULL);', '''1160''', '''1150''', '''payout_failed''', 'payout_not_posted', 'payout_net_zero',
        'private.accounting_jst_date(v_tx.stripe_created_at)', 'private.accounting_period_for_event(v_date)',
        'private.accounting_event_key(''payout_started'', ARRAY[v_tx.source_id])',
        'private.accounting_park_failure(''payout_failed'',', 'IF v_parked THEN', 'EXCEPTION WHEN OTHERS',
        '_source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp())']),
      ('private.accounting_post_stripe_events(integer)', true, ARRAY[
        'PERFORM private.accounting_lock_all(NULL);', 'private.accounting_post_stripe_fee_events(_limit)',
        'private.accounting_post_stripe_tax_adjustment_events(_limit)', 'private.accounting_post_stripe_payout_events(_limit)',
        'private.accounting_post_stripe_bank_events(_limit)', 'private.accounting_post_stripe_payout_failure_events(_limit)']),
      ('private.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid)', false, ARRAY[
        'private.group_g_actor_has_permissions(_actor_id, ARRAY[''admin.finance.manage''])', '''1160''', '''1040''', '''balance_topup''',
        'private.accounting_post_journal_core(_actor_id,', '^[A-Za-z0-9_.-]{1,128}$', 'private.accounting_period_for_event(_bank_date, _actor_id)',
        'private.accounting_cutover_on()']),
      ('private.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid)', false, ARRAY[
        'private.group_g_actor_has_permissions(_actor_id, ARRAY[''admin.finance.manage''])', 'ACCOUNTING_VERSION_CONFLICT',
        'ACCOUNTING_REQUEST_KEY_CONFLICT', 'private.accounting_request_hash(', 'PERFORM private.accounting_lock_all(NULL);']),
      ('private.get_stripe_fee_reconciliation(text)', false, ARRAY[
        'private.accounting_stripe_fee_amount(', 'private.accounting_stripe_category_kind(', 'unexplained_jst_utc',
        'unexplained_utc_invoice', 'journal_vs_txn_diff']),
      ('private.get_stripe_balance_reconciliation(date)', false, ARRAY[
        'private.accounting_entry_live(', 'private.accounting_dispute_key(', '''planned_p3''', '''payout_unposted''', '''manual_topup''', 'payout_in_transit_1150',
        'processor:stripe', 'payout_net_zero']),
      ('private.accounting_entry_live(text,text)', false, ARRAY['reverses_entry_id']),
      ('private.accounting_period_taxable(uuid,date)', false, ARRAY['consumption_taxable_from']),
      ('private.accounting_stripe_fee_amount(text,integer,integer)', false, ARRAY['''tax_adjustment''', '''fee_only'''])
    ) AS x(signature, lane, needles)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.signature);
      IF v_oid IS NULL THEN
        v_failed := 'acc_s9_functions';
        EXIT;
      END IF;
      IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
        WHERE o.pronamespace = 'private'::regnamespace AND o.proname = (SELECT f.proname FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid)) <> 1 THEN
        v_failed := 'acc_s9_functions';
        EXIT;
      END IF;
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF EXISTS (SELECT 1 FROM pg_catalog.unnest(e.needles) AS n(text) WHERE pg_catalog.strpos(v_src, n.text) = 0)
        OR (e.lane AND (v_src ~* 'FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)'
          OR pg_catalog.strpos(v_src, 'PERFORM private.accounting_lock_all(NULL);') > COALESCE(NULLIF(pg_catalog.strpos(v_src, 'FOR v_'), 0), 2147483647)
          OR pg_catalog.strpos(v_src, 'PERFORM private.accounting_lock_all(NULL);') > COALESCE(NULLIF(pg_catalog.strpos(v_src, 'v_fee := private.accounting_post_stripe_fee_events('), 0), 2147483647)))
        OR (e.lane AND e.signature <> 'private.accounting_post_stripe_events(integer)' AND v_src ~* 'PG_EXCEPTION_CONTEXT') THEN
        v_failed := 'acc_s9_functions';
        EXIT;
      END IF;
    END LOOP;
    -- The runner calls the lanes in the order of the plan (the payout before its arrival and its return).
    IF v_failed IS NULL THEN
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.accounting_post_stripe_events(integer)');
      IF NOT (pg_catalog.strpos(v_src, 'accounting_post_stripe_fee_events(_limit)') < pg_catalog.strpos(v_src, 'accounting_post_stripe_tax_adjustment_events(_limit)')
        AND pg_catalog.strpos(v_src, 'accounting_post_stripe_tax_adjustment_events(_limit)') < pg_catalog.strpos(v_src, 'accounting_post_stripe_payout_events(_limit)')
        AND pg_catalog.strpos(v_src, 'accounting_post_stripe_payout_events(_limit)') < pg_catalog.strpos(v_src, 'accounting_post_stripe_bank_events(_limit)')
        AND pg_catalog.strpos(v_src, 'accounting_post_stripe_bank_events(_limit)') < pg_catalog.strpos(v_src, 'accounting_post_stripe_payout_failure_events(_limit)')) THEN
        v_failed := 'acc_s9_functions';
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s9_function_attrs';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_stripe_category_kind(text,text)', 'text', '_type,_reporting_category', 0, 'i', true, 'sql', false),
      ('private.accounting_stripe_fee_amount(text,integer,integer)', 'integer', '_kind,_fee,_net', 0, 'i', true, 'sql', false),
      ('private.accounting_period_taxable(uuid,date)', 'boolean', '_period_id,_date', 0, 's', true, 'sql', false),
      ('private.accounting_entry_live(text,text)', 'boolean', '_kind,_part', 0, 's', true, 'sql', false),
      ('private.accounting_post_stripe_fee_events(integer)', 'jsonb', '_limit', 1, 'v', true, 'plpgsql', false),
      ('private.accounting_post_stripe_tax_adjustment_events(integer)', 'jsonb', '_limit', 1, 'v', true, 'plpgsql', false),
      ('private.accounting_post_stripe_payout_events(integer)', 'jsonb', '_limit', 1, 'v', true, 'plpgsql', false),
      ('private.accounting_post_stripe_bank_events(integer)', 'jsonb', '_limit', 1, 'v', true, 'plpgsql', false),
      ('private.accounting_post_stripe_payout_failure_events(integer)', 'jsonb', '_limit', 1, 'v', true, 'plpgsql', false),
      ('private.accounting_post_stripe_events(integer)', 'jsonb', '_limit', 1, 'v', true, 'plpgsql', false),
      ('private.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid)', 'jsonb',
        '_actor_id,_amount,_bank_date,_bank_txn_no,_stripe_txn_id,_note,_request_key', 0, 'v', true, 'plpgsql', true),
      ('public.admin_record_balance_topup(uuid,bigint,date,text,text,text,uuid)', 'jsonb',
        '_actor_id,_amount,_bank_date,_bank_txn_no,_stripe_txn_id,_note,_request_key', 0, 'v', false, 'sql', true),
      ('private.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid)', 'jsonb',
        '_actor_id,_invoice_month,_invoice_total,_invoice_tax,_document_ref,_expected_version,_request_key', 0, 'v', true, 'plpgsql', true),
      ('public.admin_set_stripe_invoice_record(uuid,text,bigint,bigint,text,bigint,uuid)', 'jsonb',
        '_actor_id,_invoice_month,_invoice_total,_invoice_tax,_document_ref,_expected_version,_request_key', 0, 'v', false, 'sql', true),
      ('private.get_stripe_fee_reconciliation(text)', 'jsonb', '_month', 0, 's', true, 'plpgsql', true),
      ('public.get_stripe_fee_reconciliation(text)', 'jsonb', '_month', 0, 's', false, 'sql', true),
      ('private.get_stripe_balance_reconciliation(date)', 'jsonb', '_through', 0, 's', true, 'plpgsql', true),
      ('public.get_stripe_balance_reconciliation(date)', 'jsonb', '_through', 0, 's', false, 'sql', true)
    ) AS x(signature, result_type, arg_names, defaults, volatility, definer, lang, service_exec)
    LOOP
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF p.oid IS NULL OR p.proowner <> 'postgres'::regrole OR p.prosecdef <> e.definer OR p.provolatile::text <> e.volatility
        OR p.lanname <> e.lang OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset OR p.prokind <> 'f'
        OR p.proisstrict OR p.proleakproof
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
        v_failed := 'acc_s9_function_attrs';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s9_reads_stable';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.get_stripe_fee_reconciliation(text)'), ('public.get_stripe_fee_reconciliation(text)'),
      ('private.get_stripe_balance_reconciliation(date)'), ('public.get_stripe_balance_reconciliation(date)'),
      ('private.accounting_entry_live(text,text)'), ('private.accounting_period_taxable(uuid,date)')
    ) AS x(signature)
    LOOP
      SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF p.oid IS NULL OR p.provolatile <> 's'
        OR p.prosrc ~* '(INSERT|UPDATE|DELETE|TRUNCATE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)|PERFORM|EXECUTE)' THEN
        v_failed := 'acc_s9_reads_stable';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s9_category_map';
  IF v_failed IS NULL THEN
    SELECT f.* INTO p FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure('private.accounting_stripe_category_kind(text,text)');
    IF p.oid IS NULL OR p.provolatile <> 'i' THEN
      v_failed := 'acc_s9_category_map';
    ELSIF EXISTS (SELECT 1 FROM (VALUES
      ('charge', 'charge', 'sale'), ('payment', 'charge', 'sale'), ('charge', 'other', NULL), ('payment', 'network_cost', NULL),
      ('refund', 'refund', 'refund_principal'), ('payment_refund', 'refund', 'refund_principal'),
      ('refund_failure', 'refund_failure', 'refund_principal'), ('refund', 'anything', 'refund_principal'),
      ('stripe_fee', 'fee', 'fee_only'), ('stripe_fx_fee', 'fee', 'fee_only'), ('stripe_fee', 'anything', 'fee_only'),
      ('tax_fee', 'tax', 'tax_adjustment'), ('payout', 'payout', 'payout'),
      ('payout_failure', 'payout_reversal', 'payout_failure'), ('payout_cancel', 'payout_reversal', 'payout_failure'),
      ('payout_failure', 'anything', 'payout_failure'),
      ('adjustment', 'dispute', 'dispute'), ('adjustment', 'dispute_reversal', 'dispute'), ('adjustment', 'other', NULL),
      ('topup', 'topup', 'manual_topup'), ('topup_reversal', 'topup', 'manual_topup'),
      ('advance', 'advance', NULL), ('', '', NULL)
    ) AS x(t, c, k) WHERE private.accounting_stripe_category_kind(x.t, x.c) IS DISTINCT FROM x.k) THEN
      v_failed := 'acc_s9_category_map';
    END IF;
  END IF;

  v_stage := 'acc_s9_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline ->> 'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline ->> 'lines')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline ->> 'periods')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_stripe_invoice_records) IS DISTINCT FROM (v_baseline ->> 'invoice_records')::bigint) THEN
    v_failed := 'acc_s9_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the
  -- SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s9_functions'), HINT = SQLSTATE;
END;
$acc_s9_final$;
-- ACC_S9_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
