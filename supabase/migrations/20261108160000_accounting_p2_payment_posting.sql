BEGIN;
-- Accounting plan 2 S7 (FREQ-562 AC-01..AC-05, FREQ-569 AC-01/AC-06): the payment posting. One Stripe balance
-- transaction of a charge (type charge / payment, reporting category charge, with a payment intent) becomes one
-- entry "Stripe receivable 1160 / deferred revenue 2150" for the whole amount before fees, with the order on both lines.
--
-- private.accounting_post_payment_events(_limit integer DEFAULT 50) RETURNS jsonb
--   {posted, parked_new, reparked, resolved}. No entry point: the runner of a later task (public.accounting_run_posting)
--   is the only caller; PUBLIC, anon, authenticated and service_role hold no EXECUTE.
--   * First statement: private.accounting_lock_all(NULL) (locks 1 and 2 of the plan-1 order; the core takes the period
--     lock). It takes no row lock: the group G tables and admin_finance_expenses are only read (no FOR SHARE / UPDATE).
--   * New events (no entry with the key payment_confirmed:<payment intent>, no parked row of any state), oldest first by
--     (stripe_created_at, id), at most _limit. Then, in the same call, at most 10 still-open parked payments are looked at
--     again, oldest last_detected_at first. The two groups cannot overlap (a parked row excludes the first group).
--   * The day is the Japanese day of the transaction time (private.accounting_jst_date(stripe_created_at)); orders.paid_at is
--     never used. A day before accounting_settings.cutover_on is parked as before_cutover.
--   * An event that cannot be posted is parked (accounting_park_event) with the reason: no_order, before_cutover,
--     period_missing, amount_mismatch (stripe_amount / order_total), order_not_postable (reason: shipping, units_missing,
--     units_sum). Only the units of order_items.line_kind = 'order' count. A posted event resolves its open parked row.
--   * Each event, from the period lookup to the parking or the posting, is one BEGIN ... EXCEPTION block: a failure undoes
--     that one event (rows and entry number), is parked as period_missing (ACCOUNTING_PERIOD_MISSING) or posting_error
--     (SQLSTATE and a fixed code only, never the exception text), and the next event goes on.
--   * The entry's source time (_source_recorded_at) is LEAST(stripe_balance_transactions.synced_at, clock_timestamp()): the time
--     the shop stored the Stripe row, so a payment parked for months is not marked late (is_late) when it finally posts. The
--     adapter overwrites synced_at on each upsert, so it is the last sync time and can only lean toward late.
-- private.accounting_park_failure(...) maps the exception of one event to its parked row (period_missing with the
--   event day and the fixed cause word, else posting_error with SQLSTATE and a fixed code). Tasks 3, 4 and 6 reuse it.
-- Labels: ACCOUNTING_LABELS.paymentReceived, pasted from scripts/accounting/emit-labels.ts:
--   paymentReceived: U&'\652F\6255\3044\306E\53D7\3051\53D6\308A\FF08\524D\53D7\91D1\FF09'
--
-- ROLLBACK (only while no entry of kind payment_confirmed exists):
--   DROP FUNCTION private.accounting_post_payment_events(integer);
--   DROP FUNCTION private.accounting_park_failure(text,text,text,uuid,text,text,text,date);

-- ACC_S7_BODY_BEGIN
CREATE TEMP TABLE accounting_s7_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s7_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
  'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods));

-- The mapping of one failed event to its parked row. IT MUST NOT RAISE: it runs in the exception handler of the
-- caller, outside any sub-block, so an error here would abort the whole batch and undo every event already posted.
-- Any failure inside it falls back to a fixed posting_error row, and if even that fails nothing is parked (the event
-- has no parked row, so the next run takes it again as a new event). The text of the exception and of its detail is only
-- compared, never stored. _entry_date is the day of the event when it is known.
CREATE FUNCTION private.accounting_park_failure(_kind text, _source_table text, _source_id text, _order_id uuid,
  _sqlstate text, _message text, _pg_detail text, _entry_date date) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_reason text;
  v_detail jsonb;
BEGIN
  BEGIN
    IF _message = 'ACCOUNTING_PERIOD_MISSING' AND _entry_date IS NOT NULL THEN
      v_reason := 'period_missing';
      v_detail := pg_catalog.jsonb_build_object('entry_date', pg_catalog.to_char(_entry_date, 'YYYY-MM-DD'));
      IF _pg_detail = 'sole_ended_not_switched' THEN
        v_detail := v_detail || pg_catalog.jsonb_build_object('cause', 'sole_ended_not_switched');
      END IF;
    ELSE
      v_reason := 'posting_error';
      v_detail := pg_catalog.jsonb_build_object('error_sqlstate', _sqlstate,
        'error_code', CASE WHEN _message ~ '^(ACCOUNTING|GROUP_G|GROUP_H)_[A-Z0-9_]{1,80}$' THEN _message
          ELSE 'unexpected_error' END);
      IF _entry_date IS NOT NULL THEN
        v_detail := v_detail || pg_catalog.jsonb_build_object('entry_date', pg_catalog.to_char(_entry_date, 'YYYY-MM-DD'));
      END IF;
    END IF;
    PERFORM private.accounting_park_event(_kind, _source_table, _source_id, _order_id, v_reason, v_detail);
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      PERFORM private.accounting_park_event(_kind, _source_table, _source_id, NULL, 'posting_error',
        pg_catalog.jsonb_build_object('error_sqlstate', 'XX000', 'error_code', 'unexpected_error'));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;
END;
$$;

CREATE FUNCTION private.accounting_post_payment_events(_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_tx record;
  v_cutover date;
  v_order_id uuid;
  v_total integer;
  v_shipping integer;
  v_date date;
  v_period uuid;
  v_unit_count bigint;
  v_unit_sum bigint;
  v_reason text;
  v_detail jsonb;
  v_result jsonb;
  v_entry_id uuid;
  v_sqlstate text;
  v_pg_detail text;
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
    SELECT s.id, s.payment_intent_id, s.order_id, s.amount, s.stripe_created_at, s.synced_at, s.lane FROM (
      (SELECT t.id, t.payment_intent_id, t.order_id, t.amount, t.stripe_created_at, t.synced_at, 0 AS lane, t.stripe_created_at AS sort_at
        FROM public.stripe_balance_transactions AS t
        WHERE t.type IN ('charge', 'payment') AND t.reporting_category = 'charge' AND t.payment_intent_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
            WHERE e.dedupe_key = CASE WHEN t.payment_intent_id ~ '^[A-Za-z0-9_.-]{1,128}$'
              THEN private.accounting_event_key('payment_confirmed', ARRAY[t.payment_intent_id]) END)
          AND NOT EXISTS (SELECT 1 FROM public.accounting_pending_events AS p
            WHERE p.event_kind = 'payment_confirmed' AND p.source_table = 'stripe_balance_transactions' AND p.source_id = t.id)
        ORDER BY t.stripe_created_at, t.id
        LIMIT _limit)
      UNION ALL
      (SELECT t.id, t.payment_intent_id, t.order_id, t.amount, t.stripe_created_at, t.synced_at, 1 AS lane, p.last_detected_at AS sort_at
        FROM public.accounting_pending_events AS p
        JOIN public.stripe_balance_transactions AS t ON t.id = p.source_id
        WHERE p.event_kind = 'payment_confirmed' AND p.source_table = 'stripe_balance_transactions' AND p.resolved_at IS NULL
          AND t.type IN ('charge', 'payment') AND t.reporting_category = 'charge' AND t.payment_intent_id IS NOT NULL
        ORDER BY p.last_detected_at, p.id
        LIMIT 10)
    ) AS s
    ORDER BY s.lane, s.sort_at, s.id
  LOOP
    v_reason := NULL;
    v_detail := '{}'::jsonb;
    v_order_id := NULL;
    v_date := NULL;
    v_period := NULL;
    BEGIN
      -- The order: by the payment intent (unique), else by the order the transaction was linked to.
      SELECT o.id, o.total_amount, o.shipping_amount INTO v_order_id, v_total, v_shipping
      FROM public.orders AS o WHERE o.payment_intent_id = v_tx.payment_intent_id;
      IF NOT FOUND AND v_tx.order_id IS NOT NULL THEN
        SELECT o.id, o.total_amount, o.shipping_amount INTO v_order_id, v_total, v_shipping
        FROM public.orders AS o WHERE o.id = v_tx.order_id;
      END IF;
      IF NOT FOUND THEN
        v_order_id := NULL;
        v_reason := 'no_order';
      ELSE
        v_date := private.accounting_jst_date(v_tx.stripe_created_at);
        IF v_cutover IS NOT NULL AND v_date < v_cutover THEN
          v_reason := 'before_cutover';
        ELSE
          -- The period is resolved before the 2-c checks on purpose: period_missing (the owner must act) shows first, and a
          -- sole calendar-year period that this creates for an event parked right after is harmless (the same day's fee
          -- entry needs it anyway, and every review resolves the period again).
          v_period := private.accounting_period_for_event(v_date);
          IF v_tx.amount <> v_total THEN
            v_reason := 'amount_mismatch';
            v_detail := pg_catalog.jsonb_build_object('stripe_amount', v_tx.amount, 'order_total', v_total);
          ELSIF v_shipping <> 0 THEN
            v_reason := 'order_not_postable';
            v_detail := pg_catalog.jsonb_build_object('reason', 'shipping');
          ELSE
            SELECT pg_catalog.count(*), COALESCE(pg_catalog.sum(u.paid_amount), 0) INTO v_unit_count, v_unit_sum
            FROM public.order_line_unit_amounts AS u
            JOIN public.order_items AS oi ON oi.id = u.order_item_id
            WHERE u.order_id = v_order_id AND oi.line_kind = 'order';
            IF v_unit_count = 0 THEN
              v_reason := 'order_not_postable';
              v_detail := pg_catalog.jsonb_build_object('reason', 'units_missing');
            ELSIF v_unit_sum <> v_total THEN
              v_reason := 'order_not_postable';
              v_detail := pg_catalog.jsonb_build_object('reason', 'units_sum');
            END IF;
          END IF;
        END IF;
      END IF;

      IF v_reason IS NOT NULL THEN
        PERFORM private.accounting_park_event('payment_confirmed', 'stripe_balance_transactions', v_tx.id, v_order_id,
          v_reason, v_detail);
        IF v_tx.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
      ELSE
        v_result := private.accounting_post_journal_core(NULL, v_period, v_date, 'payment_confirmed',
          ARRAY[v_tx.payment_intent_id],
          U&'\652F\6255\3044\306E\53D7\3051\53D6\308A\FF08\524D\53D7\91D1\FF09',
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('account_code', '1160', 'debit', v_tx.amount, 'credit', 0,
              'order_id', v_order_id::text),
            pg_catalog.jsonb_build_object('account_code', '2150', 'debit', 0, 'credit', v_tx.amount,
              'order_id', v_order_id::text)),
          _source_table => 'stripe_balance_transactions', _source_id => v_tx.id,
          _source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp()));
        v_entry_id := (v_result ->> 'entry_id')::uuid;
        IF (v_result ->> 'created')::boolean THEN
          v_posted := v_posted + 1;
        END IF;
        IF v_tx.lane = 1 THEN
          PERFORM private.accounting_unpark_event('payment_confirmed', 'stripe_balance_transactions', v_tx.id, v_entry_id);
          v_resolved := v_resolved + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- The rows and the entry number of this one event are undone with the block. Only the SQLSTATE and a fixed code
      -- are kept; the text of the exception is never stored.
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_pg_detail = PG_EXCEPTION_DETAIL;
      PERFORM private.accounting_park_failure('payment_confirmed', 'stripe_balance_transactions', v_tx.id, v_order_id,
        v_sqlstate, SQLERRM, v_pg_detail, v_date);
      IF v_tx.lane = 0 THEN v_parked_new := v_parked_new + 1; ELSE v_reparked := v_reparked + 1; END IF;
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('posted', v_posted, 'parked_new', v_parked_new, 'reparked', v_reparked,
    'resolved', v_resolved);
END;
$$;

ALTER FUNCTION private.accounting_park_failure(text,text,text,uuid,text,text,text,date) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_payment_events(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.accounting_park_failure(text,text,text,uuid,text,text,text,date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.accounting_post_payment_events(integer) FROM PUBLIC, anon, authenticated, service_role;
-- ACC_S7_BODY_END

-- ACC_S7_FINAL_ASSERT_BEGIN
-- Catalog meaning only (never ACL text). acc_s7_functions: the two functions exist once each, and their text keeps the
-- rules of the plan (the first lock, no row lock, no orders.paid_at, the two accounts, the key through the core, the
-- source time, the failure helper that cannot raise).
-- acc_s7_function_attrs: owner, SECURITY DEFINER, volatility, language, result, argument, search_path, EXECUTE for nobody,
-- and no public function of the same name. acc_s7_existing_dml_allowlist: this migration wrote no row (entries, lines,
-- parked events and periods are what the baseline counted).
DO $acc_s7_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_oid oid;
  v_oid2 oid;
  v_src text;
  v_baseline jsonb;
  p record;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s7_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s7_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s7_baseline) <> 1 THEN
    v_failed := 'acc_s7_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s7_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['entries', 'lines', 'pending_events', 'periods']) AS k(name)
        WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s7_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s7_functions';
  v_oid := pg_catalog.to_regprocedure('private.accounting_post_payment_events(integer)');
  IF v_failed IS NULL THEN
    IF v_oid IS NULL
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
        WHERE o.pronamespace = 'private'::regnamespace AND o.proname = 'accounting_post_payment_events') <> 1 THEN
      v_failed := 'acc_s7_functions';
    ELSE
      SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid;
      IF pg_catalog.strpos(v_src, 'PERFORM private.accounting_lock_all(NULL);') = 0
        OR pg_catalog.strpos(v_src, 'PERFORM private.accounting_lock_all(NULL);') > pg_catalog.strpos(v_src, 'FOR v_tx IN')
        OR pg_catalog.strpos(v_src, 'private.accounting_post_journal_core(NULL, v_period, v_date, ''payment_confirmed'',') = 0
        OR pg_catalog.strpos(v_src, 'ARRAY[v_tx.payment_intent_id]') = 0
        OR pg_catalog.strpos(v_src, '''1160''') = 0 OR pg_catalog.strpos(v_src, '''2150''') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_jst_date(v_tx.stripe_created_at)') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_period_for_event(v_date)') = 0
        OR pg_catalog.strpos(v_src, 'EXCEPTION WHEN OTHERS') = 0
        OR pg_catalog.strpos(v_src, '_source_recorded_at => LEAST(v_tx.synced_at, pg_catalog.clock_timestamp())') = 0
        OR pg_catalog.strpos(v_src, 'private.accounting_event_key(''payment_confirmed'', ARRAY[t.payment_intent_id])') = 0
        OR pg_catalog.strpos(v_src, 'PERFORM private.accounting_park_failure(''payment_confirmed'',') = 0
        OR v_src ~* 'paid_at' OR v_src ~* 'FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE)' THEN
        v_failed := 'acc_s7_functions';
      END IF;
    END IF;
    -- The failure helper: one function, a fixed mapping, no way to raise, nothing of the exception text kept.
    IF v_failed IS NULL THEN
      v_oid2 := pg_catalog.to_regprocedure('private.accounting_park_failure(text,text,text,uuid,text,text,text,date)');
      IF v_oid2 IS NULL
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = 'private'::regnamespace AND o.proname = 'accounting_park_failure') <> 1 THEN
        v_failed := 'acc_s7_functions';
      ELSE
        SELECT f.prosrc INTO v_src FROM pg_catalog.pg_proc AS f WHERE f.oid = v_oid2;
        IF pg_catalog.strpos(v_src, 'PERFORM private.accounting_park_event(') = 0
          OR pg_catalog.strpos(v_src, 'sole_ended_not_switched') = 0
          OR pg_catalog.strpos(v_src, 'EXCEPTION WHEN OTHERS') = 0
          OR v_src ~* 'RAISE' OR v_src ~* 'SQLERRM' OR v_src ~* 'PG_EXCEPTION_CONTEXT' OR v_src ~* 'paid_at' THEN
          v_failed := 'acc_s7_functions';
        END IF;
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s7_function_attrs';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.accounting_post_payment_events(integer)', 'jsonb', '_limit', 1),
      ('private.accounting_park_failure(text,text,text,uuid,text,text,text,date)', 'void',
        '_kind,_source_table,_source_id,_order_id,_sqlstate,_message,_pg_detail,_entry_date', 0)
    ) AS x(signature, result_type, arg_names, defaults)
    LOOP
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = pg_catalog.to_regprocedure(e.signature);
      IF p.proowner <> 'postgres'::regrole OR NOT p.prosecdef OR p.provolatile <> 'v' OR p.lanname <> 'plpgsql'
        OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset OR p.prokind <> 'f' OR p.proisstrict
        OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames[1:p.pronargs], ','), '') <> e.arg_names
        OR p.pronargdefaults <> e.defaults
        OR pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee <> p.proowner)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = p.proname) THEN
        v_failed := 'acc_s7_function_attrs';
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_stage := 'acc_s7_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline ->> 'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline ->> 'lines')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline ->> 'periods')::bigint) THEN
    v_failed := 'acc_s7_existing_dml_allowlist';
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
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s7_functions'), HINT = SQLSTATE;
END;
$acc_s7_final$;
-- ACC_S7_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
