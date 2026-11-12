BEGIN;
-- Accounting plan 3 S16 (FREQ-578 AC-05): hold the fixed return fees at 0 until their journal rules are designed.
--
-- The fixed fees are the return shipping fee of a shop label (shop_return_settings.shop_label_fee,
-- order_returns.return_shipping_fee), the exchange fee and the exchange shipping fee (exchange_fees_enabled,
-- exchange_fee, exchange_shipping_fee). The percentage restocking fee (restocking_fee_enabled, restocking_fee_percent)
-- stays as it is.
-- Constraints (a refusal is 23514 with the constraint name):
--   shop_return_settings  acc_p3_fee_lock_settings  validated: the one settings row must already hold 0 / false, else
--                                                   ADD CONSTRAINT fails and the migration stops (intended).
--   order_returns         acc_p3_fee_lock_returns   NOT VALID: existing rows are not checked; new rows and every update
--                                                   of a row are.
-- No function body changes and no row is written. The settings route refuses non-zero values with zod (400) and the
-- settings screen disables the inputs.
-- When the shop decides to use these fees, first add their journal rules to the design, then drop the two constraints.
--
-- ROLLBACK:
--   ALTER TABLE public.order_returns DROP CONSTRAINT acc_p3_fee_lock_returns;
--   ALTER TABLE public.shop_return_settings DROP CONSTRAINT acc_p3_fee_lock_settings;

-- ACC_S16_BODY_BEGIN
ALTER TABLE public.shop_return_settings
  ADD CONSTRAINT acc_p3_fee_lock_settings CHECK (
    shop_label_fee = 0 AND exchange_fees_enabled = false AND exchange_fee = 0 AND exchange_shipping_fee = 0);

ALTER TABLE public.order_returns
  ADD CONSTRAINT acc_p3_fee_lock_returns CHECK (
    return_shipping_fee = 0 AND exchange_fee = 0 AND exchange_shipping_fee = 0) NOT VALID;
-- ACC_S16_BODY_END

-- ACC_S16_FINAL_ASSERT_BEGIN
-- Compare catalog meaning (constraint kind, definition, validation, deferral), never ACL text serialization. The
-- result does not depend on the caller's search_path.
DO $acc_s16_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);

  v_stage := 'acc_s16_settings_checks';
  -- acc_s16_settings_checks: the settings lock is a validated, not deferrable CHECK on the four fixed-fee columns, and
  -- the percentage restocking fee keeps only its own range check.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.shop_return_settings'::regclass AND c.conname = 'acc_p3_fee_lock_settings'
        AND c.contype = 'c' AND c.convalidated AND NOT c.condeferrable
        AND pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
          = 'CHECK (((shop_label_fee = 0) AND (exchange_fees_enabled = false) AND (exchange_fee = 0) AND (exchange_shipping_fee = 0)))') <> 1
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.shop_return_settings'::regclass AND c.contype = 'c'
        AND c.conname <> 'shop_return_settings_restocking_fee_percent_check'
        AND pg_catalog.strpos(pg_catalog.pg_get_constraintdef(c.oid), 'restocking_fee') > 0) THEN
    v_failed := 'acc_s16_settings_checks';
  END IF;

  v_stage := 'acc_s16_returns_checks';
  -- acc_s16_returns_checks: the return lock is a not deferrable CHECK on the three fixed-fee columns (added NOT VALID;
  -- a later VALIDATE is stricter and still accepted), and no other acc_p3_fee_lock_ constraint exists.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.order_returns'::regclass AND c.conname = 'acc_p3_fee_lock_returns'
        AND c.contype = 'c' AND NOT c.condeferrable
        AND pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+(NOT VALID)?$', '')
          = 'CHECK (((return_shipping_fee = 0) AND (exchange_fee = 0) AND (exchange_shipping_fee = 0)))') <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c WHERE c.conname LIKE 'acc\_p3\_fee\_lock\_%') <> 2) THEN
    v_failed := 'acc_s16_returns_checks';
  END IF;

  v_stage := 'acc_s16_existing_dml_allowlist';
  -- acc_s16_existing_dml_allowlist: this migration writes no row; the one settings row is still there.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.shop_return_settings) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.shop_return_settings AS s WHERE s.id = 1)) THEN
    v_failed := 'acc_s16_existing_dml_allowlist';
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
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s16_settings_checks'), HINT = SQLSTATE;
END;
$acc_s16_final$;
-- ACC_S16_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
