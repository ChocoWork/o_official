-- Passkey stage 4 / Task 32 (migration J): the access token hook starts rejecting customer password logins
-- (SR-AUTH-030, FR-AUTH-055, DATA-AUTH-013, SEC-AUTH-060, THR-AUTH-058, ADR-0476).
-- It only turns the flag on: private.passkey_staff_config.reject_customer_password = true. The hook function (migration B) already
-- returns "[customer-password-disabled]" for a customer whose authentication_method is 'password' while the flag is true.
-- Staff are not affected (their password login was already rejected with the staff marker). The column DEFAULT stays false.
--
-- ROLLBACK: UPDATE private.passkey_staff_config SET reject_customer_password = false WHERE id;
--
-- BEFORE applying to production (read only): this migration is NOT applied to production until the production domain is decided.
-- Order: after A-I and after the app deploy; K comes after J.
--   select count(*) from private.passkey_staff_config;                       -- expect 1 (migration A)
--   select to_regprocedure('public.passkey_access_token_hook(jsonb)');       -- expect not null (migration B)

BEGIN;

DO $$
DECLARE
  v_rows bigint;
  v_has_key boolean;
BEGIN
  -- nested IFs: an OR in one IF is planned as a whole and would fail with 42P01 / 42883 when A or B is missing
  IF to_regclass('private.passkey_staff_config') IS NULL
     OR to_regprocedure('public.passkey_access_token_hook(jsonb)') IS NULL
     OR to_regprocedure('private.passkey_staff_settings()') IS NULL THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_reject_customer_password_precheck';
  END IF;
  EXECUTE 'SELECT count(*) FROM private.passkey_staff_config' INTO v_rows;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_reject_customer_password_precheck';
  END IF;
  EXECUTE 'SELECT private.passkey_staff_settings() ? ''reject_customer_password''' INTO v_has_key;
  IF v_has_key IS NOT TRUE THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_PRECHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_reject_customer_password_precheck';
  END IF;
END
$$;

UPDATE private.passkey_staff_config SET reject_customer_password = true WHERE id;

DO $$
BEGIN
  IF (SELECT count(*) FROM private.passkey_staff_config WHERE reject_customer_password IS TRUE) <> 1 THEN
    RAISE EXCEPTION 'PASSKEY_MIGRATION_POSTCHECK_FAILED' USING ERRCODE = '55000', DETAIL = 'passkey_reject_customer_password_postcheck';
  END IF;
END
$$;

COMMIT;
