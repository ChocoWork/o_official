BEGIN;
-- Accounting plan 1 S5 (FREQ-560 AC-01..AC-03, design 2-j / A8): the manual transactions that exist before S4
-- (public.admin_finance_expenses, deleted_at IS NULL) become saved journal entries of kind migrated_entry. S4 and S5
-- are applied together (no path applies S4 alone), so no transaction has an entry yet when this runs.
--
-- Data rules:
--   admin_finance_expenses, admin_finance_entry_revisions, admin_finance_receipts, admin_finance_years and
--   admin_finance_year_closings are only read (SELECT). The only writes are the accounting rows the S3 / S2 tools add
--   (private.accounting_ensure_individual_periods, private.accounting_period_for_event,
--   private.accounting_post_journal_core) and the temporary baseline of this file. No trigger is disabled.
--   No new table keeps the old history: the entry's source_table / source_id lead to admin_finance_entry_revisions
--   (entry_id = source_id) and admin_finance_receipts (entry_id = source_id); list_accounting_journal (S3) adds their
--   counts as legacy. The receipts keep evidence_kind unconfirmed (S1 default); the owner sets it later in the screen.
--
-- Steps (one transaction):
--   1. Locks (190521,1) -> (190525,0) (the period locks come with the core). Preconditions: the accounting tables and
--      the S4 journal trigger exist, the history trigger trigger_admin_finance_entry_revisions exists.
--   2. Stop (ACCOUNTING_MIGRATION_ASSERTION_FAILED / 55000) when admin_finance_years has a corporation year
--      (a8_corporation_year), any opening column (opening_cash, accounts_receivable, fixed_assets, accounts_payable,
--      opening_capital) is not 0 (a8_legacy_opening_nonzero: the design maps no opening column to an account; ask the
--      owner), admin_finance_year_closings has a row (a8_closings_exist), or any entry of admin_finance_expenses or of
--      kind manual_entry / migrated_entry already exists (acc_s5_counts: a second run, or a manual entry written
--      between S4 and S5; never a second open entry for one row).
--   3. The baseline: the live rows (id, expense_date, created_at, created_by in (expense_date, id) order), the counts of
--      deleted rows, all rows, revisions and receipts, and tgenabled of the history trigger.
--   4. Calendar-year sole periods from the year of the first to the year of the last live expense_date, without a
--      gap (private.accounting_ensure_individual_periods; the opening year .. this year in Japan + 1 window applies).
--   5. Each live row in (expense_date, id) order: period private.accounting_period_for_event(expense_date, created_by);
--      lines by the S4 rules (the same statements as private.accounting_manual_entry_after_write: counter account
--      from the category map else 9999, funds account from the method map of the period's business type else the
--      category map of the method text else 9999, 9999 lines keep the text in memo; expense debit counter / credit
--      funds, income the other way; partner as counterparty, NULL when empty); then
--      private.accounting_post_journal_core(created_by, period, expense_date, 'migrated_entry', [id], item_name, lines,
--      source admin_finance_expenses / id, _recorded_at created_at, _migrated_from 'admin_finance_expenses').
--      No permission is checked; a recorder who lost the role or was deleted does not stop it. The date stays the
--      transaction date (its own year). A row whose counter or funds account would be 1810 (startup costs) stops the
--      migration (a8_startup_cost_category; nothing is posted, the owner decides). Numbers follow the per-period
--      sequence in date order.
--      Logically deleted rows are not moved.
--   6. Final assert (DETAIL acc_s5_counts, acc_s5_revisions_unchanged, acc_s5_receipts_unchanged, acc_s5_numbering,
--      acc_s5_triggers_unchanged); a NOTICE reports the moved and the skipped (deleted) counts.
-- After S5 the first edit of a moved row is manual_entry:<id>:0 and reverses the migrated entry (S4 counts manual_entry
-- only).
--
-- ROLLBACK: none. Journal entries and periods cannot be removed once committed; a wrong entry is corrected with a
-- reversal and a correct entry (1-c).

-- ACC_S5_BODY_BEGIN
CREATE TEMP TABLE accounting_s5_baseline(payload jsonb) ON COMMIT DROP;

DO $acc_s5_migrate$
DECLARE
  v_search_path text;
  v_row public.admin_finance_expenses%ROWTYPE;
  v_first integer;
  v_last integer;
  v_period_id uuid;
  v_business_type text;
  v_counter text;
  v_funds text;
  v_counter_line jsonb;
  v_funds_line jsonb;
  v_lines jsonb;
  v_result jsonb;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  -- 1. Locks, then the preconditions.
  PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);
  PERFORM pg_catalog.pg_advisory_xact_lock(190525, 0);
  IF pg_catalog.to_regclass('public.accounting_journal_entries') IS NULL
    OR pg_catalog.to_regclass('public.accounting_settings') IS NULL
    OR pg_catalog.to_regclass('public.accounting_manual_category_map') IS NULL
    OR pg_catalog.to_regclass('public.accounting_manual_method_map') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.admin_finance_expenses'::regclass AND t.tgname = 'accounting_manual_entry_journal'
        AND t.tgenabled = 'O' AND t.tgfoid = pg_catalog.to_regprocedure('private.accounting_manual_entry_after_write()'))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.admin_finance_expenses'::regclass AND t.tgname = 'trigger_admin_finance_entry_revisions') THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'acc_s5_triggers_unchanged';
  END IF;

  -- 2. Stops.
  IF EXISTS (SELECT 1 FROM public.admin_finance_years AS y WHERE y.business_type = 'corporation') THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'a8_corporation_year';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_finance_years AS y
    WHERE y.opening_cash <> 0 OR y.accounts_receivable <> 0 OR y.fixed_assets <> 0 OR y.accounts_payable <> 0
      OR y.opening_capital <> 0) THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'a8_legacy_opening_nonzero';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_finance_year_closings) THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'a8_closings_exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
    WHERE e.source_table = 'admin_finance_expenses' OR e.event_kind IN ('manual_entry', 'migrated_entry')) THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'acc_s5_counts';
  END IF;

  -- 3. The baseline the final assert compares with.
  INSERT INTO pg_temp.accounting_s5_baseline(payload)
  SELECT pg_catalog.jsonb_build_object(
    'live', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', x.id::text,
        'date', pg_catalog.to_char(x.expense_date, 'YYYY-MM-DD'), 'recorded_at', x.created_at, 'by', x.created_by)
        ORDER BY x.expense_date, x.id)
      FROM public.admin_finance_expenses AS x WHERE x.deleted_at IS NULL), '[]'::jsonb),
    'deleted', (SELECT pg_catalog.count(*) FROM public.admin_finance_expenses AS x WHERE x.deleted_at IS NOT NULL),
    'expenses', (SELECT pg_catalog.count(*) FROM public.admin_finance_expenses),
    'revisions', (SELECT pg_catalog.count(*) FROM public.admin_finance_entry_revisions),
    'receipts', (SELECT pg_catalog.count(*) FROM public.admin_finance_receipts),
    'history_trigger', (SELECT t.tgenabled::text FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.admin_finance_expenses'::regclass AND t.tgname = 'trigger_admin_finance_entry_revisions'));

  -- 4. The calendar-year periods, without a gap.
  SELECT pg_catalog.min(EXTRACT(year FROM x.expense_date))::integer, pg_catalog.max(EXTRACT(year FROM x.expense_date))::integer
  INTO v_first, v_last FROM public.admin_finance_expenses AS x WHERE x.deleted_at IS NULL;
  IF v_first IS NOT NULL THEN
    PERFORM private.accounting_ensure_individual_periods(v_first, NULL);
    PERFORM private.accounting_ensure_individual_periods(v_last, NULL);
  END IF;

  -- 5. The entries, in (expense_date, id) order.
  FOR v_row IN SELECT * FROM public.admin_finance_expenses AS x WHERE x.deleted_at IS NULL ORDER BY x.expense_date, x.id
  LOOP
    v_period_id := private.accounting_period_for_event(v_row.expense_date, v_row.created_by);
    PERFORM private.accounting_lock_all(v_period_id);
    SELECT p.business_type INTO v_business_type FROM public.accounting_periods AS p WHERE p.id = v_period_id;

    -- ACC_S5_LINES_BEGIN
    v_counter := COALESCE((SELECT m.account_code FROM public.accounting_manual_category_map AS m
      WHERE m.source_text = v_row.category), '9999');
    v_funds := COALESCE((SELECT m.account_code FROM public.accounting_manual_method_map AS m
        WHERE m.source_text = v_row.payment_method AND m.direction = v_row.entry_type AND m.business_type = v_business_type),
      (SELECT m.account_code FROM public.accounting_manual_category_map AS m WHERE m.source_text = v_row.payment_method),
      '9999');
    v_counter_line := pg_catalog.jsonb_build_object('account_code', v_counter,
      'debit', CASE WHEN v_row.entry_type = 'expense' THEN v_row.amount ELSE 0 END,
      'credit', CASE WHEN v_row.entry_type = 'expense' THEN 0 ELSE v_row.amount END,
      'sub_account', NULL, 'counterparty', NULLIF(v_row.partner, ''), 'order_id', NULL,
      'memo', CASE WHEN v_counter = '9999' THEN v_row.category END);
    v_funds_line := pg_catalog.jsonb_build_object('account_code', v_funds,
      'debit', CASE WHEN v_row.entry_type = 'expense' THEN 0 ELSE v_row.amount END,
      'credit', CASE WHEN v_row.entry_type = 'expense' THEN v_row.amount ELSE 0 END,
      'sub_account', NULL, 'counterparty', NULLIF(v_row.partner, ''), 'order_id', NULL,
      'memo', CASE WHEN v_funds = '9999' THEN v_row.payment_method END);
    v_lines := CASE WHEN v_row.entry_type = 'expense' THEN pg_catalog.jsonb_build_array(v_counter_line, v_funds_line)
      ELSE pg_catalog.jsonb_build_array(v_funds_line, v_counter_line) END;
    -- ACC_S5_LINES_END
    -- A8 never posts to 1810 (startup costs, design 2-j): a row the S4 rules would put there stops the migration and
    -- the owner decides before it is applied.
    IF '1810' IN (v_counter, v_funds) THEN
      RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'a8_startup_cost_category';
    END IF;

    v_result := private.accounting_post_journal_core(v_row.created_by, v_period_id, v_row.expense_date, 'migrated_entry',
      ARRAY[v_row.id::text], v_row.item_name, v_lines, NULL, NULL, 'admin_finance_expenses', v_row.id::text,
      v_row.created_at, 'admin_finance_expenses', NULL);
    IF (v_result->>'created')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = 'acc_s5_counts';
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
END;
$acc_s5_migrate$;
-- ACC_S5_BODY_END

-- ACC_S5_FINAL_ASSERT_BEGIN
-- Compares with the baseline of step 3 (a replay in the tests pins the same shape from the current state first).
DO $acc_s5_final$
DECLARE
  v_failed text;
  v_stage text;
  v_search_path text;
  v_baseline jsonb;
BEGIN
  -- Pin an empty search_path for this block (transaction local); it is put back below, and an error rolls it back
  -- with the block.
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);

  v_stage := 'acc_s5_counts';
  -- acc_s5_counts: exactly one baseline row; one migrated entry per live row of the baseline and no other migrated
  -- entry, each with the row's id as key and source, the transaction date, the recorder and the creation time of the
  -- row, the migrated mark and time, not late, two lines that balance; the transaction rows (all and deleted) as
  -- counted before.
  IF (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s5_baseline) <> 1 THEN
    v_failed := 'acc_s5_counts';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s5_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline->'live') IS DISTINCT FROM 'array'
      OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries AS e
        WHERE e.event_kind = 'migrated_entry' OR e.migrated_from IS NOT NULL)
        <> pg_catalog.jsonb_array_length(v_baseline->'live')
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_baseline->'live') AS b(item)
        WHERE NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
          WHERE e.dedupe_key = 'migrated_entry:' || (b.item->>'id') AND e.event_kind = 'migrated_entry'
            AND e.source_table = 'admin_finance_expenses' AND e.source_id = b.item->>'id'
            AND e.migrated_from = 'admin_finance_expenses' AND e.migrated_at IS NOT NULL AND NOT e.is_late
            AND e.reverses_entry_id IS NULL AND e.source_recorded_at IS NULL
            AND e.entry_date = (b.item->>'date')::date
            AND e.recorded_at = (b.item->>'recorded_at')::timestamptz
            AND e.recorded_by IS NOT DISTINCT FROM (b.item->>'by')::uuid
            AND (SELECT pg_catalog.count(*) = 2 AND pg_catalog.sum(l.debit) = pg_catalog.sum(l.credit)
                AND pg_catalog.sum(l.debit) > 0
              FROM public.accounting_journal_lines AS l WHERE l.entry_id = e.id)))
      OR (SELECT pg_catalog.count(*) FROM public.admin_finance_expenses) IS DISTINCT FROM (v_baseline->>'expenses')::bigint
      OR (SELECT pg_catalog.count(*) FROM public.admin_finance_expenses AS x WHERE x.deleted_at IS NOT NULL)
        IS DISTINCT FROM (v_baseline->>'deleted')::bigint THEN
      v_failed := 'acc_s5_counts';
    END IF;
  END IF;

  v_stage := 'acc_s5_numbering';
  -- acc_s5_numbering: in every period the migrated entries are numbered 1, 2, ... without a gap in
  -- (entry_date, transaction id) order.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM (
      SELECT e.entry_no, pg_catalog.row_number() OVER (PARTITION BY e.period_id
          ORDER BY e.entry_date, CASE WHEN e.source_id ~ '^[0-9]{1,18}$' THEN e.source_id::bigint END) AS n,
        e.source_id ~ '^[0-9]{1,18}$' AS numeric_id
      FROM public.accounting_journal_entries AS e WHERE e.event_kind = 'migrated_entry') AS s
    WHERE s.entry_no <> s.n OR NOT s.numeric_id) THEN
    v_failed := 'acc_s5_numbering';
  END IF;

  v_stage := 'acc_s5_revisions_unchanged';
  -- acc_s5_revisions_unchanged: the revision history has the rows it had before.
  IF v_failed IS NULL AND (SELECT pg_catalog.count(*) FROM public.admin_finance_entry_revisions)
      IS DISTINCT FROM (v_baseline->>'revisions')::bigint THEN
    v_failed := 'acc_s5_revisions_unchanged';
  END IF;

  v_stage := 'acc_s5_receipts_unchanged';
  -- acc_s5_receipts_unchanged: the receipts have the rows they had before.
  IF v_failed IS NULL AND (SELECT pg_catalog.count(*) FROM public.admin_finance_receipts)
      IS DISTINCT FROM (v_baseline->>'receipts')::bigint THEN
    v_failed := 'acc_s5_receipts_unchanged';
  END IF;

  v_stage := 'acc_s5_triggers_unchanged';
  -- acc_s5_triggers_unchanged: the history trigger keeps its enabled mode, and the S4 journal trigger is in place.
  IF v_failed IS NULL AND (
    v_baseline->>'history_trigger' IS NULL
    OR (SELECT t.tgenabled::text FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.admin_finance_expenses'::regclass AND t.tgname = 'trigger_admin_finance_entry_revisions')
      IS DISTINCT FROM v_baseline->>'history_trigger'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = 'public.admin_finance_expenses'::regclass AND t.tgname = 'accounting_manual_entry_journal'
        AND t.tgenabled = 'O' AND t.tgfoid = pg_catalog.to_regprocedure('private.accounting_manual_entry_after_write()'))) THEN
    v_failed := 'acc_s5_triggers_unchanged';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
  RAISE NOTICE 'acc_s5_counts moved=% deleted_not_moved=% revisions=% receipts=%',
    pg_catalog.jsonb_array_length(v_baseline->'live'), v_baseline->>'deleted', v_baseline->>'revisions',
    v_baseline->>'receipts';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the
  -- SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s5_counts'), HINT = SQLSTATE;
END;
$acc_s5_final$;
-- ACC_S5_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
