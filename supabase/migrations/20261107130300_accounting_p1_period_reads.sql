BEGIN;
-- Accounting plan 1 S3 (FREQ-555 AC-01..AC-04, AC-06..AC-09; FREQ-561-AC-03; FREQ-554-AC-04): the settings, the
-- accounting periods, the opening balances and the read functions.
--
-- Objects (all owned by postgres):
--   public.accounting_settings          one row (id = 1): the opening day, the cutover day, the current business type
--                                       and the end day of the sole business with its append-only change record
--   public.accounting_opening_balances  stored opening balances (append only; plan 6 adds rows, plan 1 never does)
--   triggers on public.accounting_periods: the deferred layout check (overlap / gap / length, and the end day of the
--     sole business), the immediate UPDATE guard (dates and business type only through the shorten entry), and the
--     DELETE / TRUNCATE refusal; on public.accounting_settings: the immediate UPDATE guard (the change record is append
--     only and moves together with the end day), the deferred end-day check and the DELETE / TRUNCATE refusal.
-- Writers (private body, admin.accounting.settings.manage, plus a public LANGUAGE sql SECURITY INVOKER entry of the
-- same name for service_role): admin_create_accounting_period, admin_shorten_final_sole_period,
-- admin_update_accounting_settings, admin_update_accounting_period_filing.
-- Reads (STABLE, service_role only, no actor; the service-only accounting boundary of list_shipment_accounting_inputs):
--   get_accounting_settings, list_accounting_periods, get_accounting_opening, list_accounting_journal,
--   get_accounting_trial_balance.
-- Private tools: accounting_period_for_event (the only rule for choosing the period of an event),
--   accounting_ensure_individual_periods (calendar-year sole periods), accounting_opening_balances (the opening
--   computation), accounting_store_opening (service_role; plan 6 stores the closed opening).
-- The reversal core keeps its S2 body (S2 resolves a missing sole period with accounting_ensure_individual_periods).
-- Lock order of every writer: (190521,1) -> (190525,0) -> (190525, hashtext(period_id)) (private.accounting_lock_all).
-- The period name (U& below) is the same string as formatPeriodName in src/lib/accounting/period.ts.
--
-- ROLLBACK (only while no period, setting change or opening row exists that must be kept):
--   DROP FUNCTION the public and private admin_create_accounting_period, admin_shorten_final_sole_period,
--     admin_update_accounting_settings, admin_update_accounting_period_filing, get_accounting_settings,
--     list_accounting_periods, get_accounting_opening, list_accounting_journal, get_accounting_trial_balance;
--   DROP TRIGGER accounting_periods_layout, accounting_periods_guard_update, accounting_periods_no_delete,
--     accounting_periods_no_truncate ON public.accounting_periods;
--   DROP TABLE public.accounting_opening_balances, public.accounting_settings;
--   then drop the remaining private.accounting_* functions of this file.

-- ACC_S3_BODY_BEGIN

-- 0. The baseline the final assert compares with: at apply time the settings row is the fresh one this file inserts
--    (settings = null) and no opening row exists. A replay of the assert (tests) pins the current state here first
--    (pinAccountingS3Baseline).
CREATE TEMP TABLE accounting_s3_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s3_baseline(payload)
VALUES ('{"settings": null, "opening_rows": 0}'::jsonb);

-- 1. Tables.
CREATE TABLE public.accounting_settings (
  id smallint NOT NULL,
  business_start_date date NULL,
  cutover_on date NOT NULL,
  current_business_type text NOT NULL DEFAULT 'soleProprietor',
  sole_business_ended_on date NULL,
  sole_end_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  updated_by uuid NULL,
  updated_at timestamptz NULL,
  admin_requests jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT accounting_settings_pkey PRIMARY KEY (id),
  CONSTRAINT accounting_settings_id_check CHECK (id = 1),
  CONSTRAINT accounting_settings_current_business_type_check
    CHECK (current_business_type IN ('soleProprietor', 'corporation')),
  CONSTRAINT accounting_settings_sole_end_changes_check CHECK (pg_catalog.jsonb_typeof(sole_end_changes) = 'array'),
  CONSTRAINT accounting_settings_admin_requests_check CHECK (pg_catalog.jsonb_typeof(admin_requests) = 'object'),
  CONSTRAINT accounting_settings_version_check CHECK (version >= 1)
);

-- Append only: plan 6 adds the opening of a closed version (closing_version); plan 1 adds no row.
CREATE TABLE public.accounting_opening_balances (
  period_id uuid NOT NULL,
  account_code text NOT NULL,
  signed_amount bigint NOT NULL,
  closing_version integer NOT NULL DEFAULT 1,
  source text NOT NULL,
  source_period_id uuid NULL,
  CONSTRAINT accounting_opening_balances_pkey PRIMARY KEY (period_id, closing_version, account_code),
  CONSTRAINT accounting_opening_balances_period_id_fkey FOREIGN KEY (period_id)
    REFERENCES public.accounting_periods (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balances_account_code_fkey FOREIGN KEY (account_code)
    REFERENCES public.accounting_accounts (code) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balances_source_period_id_fkey FOREIGN KEY (source_period_id)
    REFERENCES public.accounting_periods (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_opening_balances_closing_version_check CHECK (closing_version >= 1),
  CONSTRAINT accounting_opening_balances_source_check CHECK (source IN ('initial', 'closing_carryover'))
);

ALTER TABLE public.accounting_settings OWNER TO postgres;
ALTER TABLE public.accounting_opening_balances OWNER TO postgres;
ALTER TABLE public.accounting_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_opening_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.accounting_settings, public.accounting_opening_balances
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.accounting_settings, public.accounting_opening_balances TO service_role;

-- 2. Small helpers (owner only).
-- The hash of a request (the operation and its arguments), kept with the request key.
CREATE FUNCTION private.accounting_request_hash(_body jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(_body::text, 'UTF8')), 'hex') $$;

-- One period as the read functions return it.
CREATE FUNCTION private.accounting_period_json(_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object('id', p.id, 'business_type', p.business_type, 'name', p.name,
    'starts_on', pg_catalog.to_char(p.starts_on, 'YYYY-MM-DD'), 'ends_on', pg_catalog.to_char(p.ends_on, 'YYYY-MM-DD'),
    'corporate_tax_extension_months', p.corporate_tax_extension_months,
    'consumption_tax_extension_months', p.consumption_tax_extension_months,
    'consumption_tax_status', p.consumption_tax_status,
    'consumption_taxable_from', pg_catalog.to_char(p.consumption_taxable_from, 'YYYY-MM-DD'),
    'version', p.version::text, 'legacy_fiscal_year', p.legacy_fiscal_year)
  FROM public.accounting_periods AS p WHERE p.id = _id
$$;

-- A request key seen before: the same hash returns the first result (a created period returns its current row), a
-- different hash is ACCOUNTING_REQUEST_KEY_CONFLICT; NULL when the key is new. Keys live in the period's
-- creation_request_key, the periods' admin_requests and the settings' admin_requests.
CREATE FUNCTION private.accounting_request_replay(_request_key uuid, _hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_hash text;
  v_prior jsonb;
BEGIN
  IF _request_key IS NULL OR _hash IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT p.id, p.creation_request_hash INTO v_id, v_hash
  FROM public.accounting_periods AS p WHERE p.creation_request_key = _request_key;
  IF FOUND THEN
    IF v_hash IS DISTINCT FROM _hash THEN
      RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN private.accounting_period_json(v_id);
  END IF;
  SELECT p.admin_requests -> (_request_key::text) INTO v_prior
  FROM public.accounting_periods AS p WHERE p.admin_requests ? (_request_key::text) LIMIT 1;
  IF v_prior IS NULL THEN
    SELECT s.admin_requests -> (_request_key::text) INTO v_prior
    FROM public.accounting_settings AS s WHERE s.admin_requests ? (_request_key::text);
  END IF;
  IF v_prior IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_prior ->> 'hash' IS DISTINCT FROM _hash THEN
    RAISE EXCEPTION 'ACCOUNTING_REQUEST_KEY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN v_prior -> 'result';
END;
$$;

-- The default name: "<year>nen (kojin)" for a sole period, "dai <n> ki" for the n-th corporation period in start order
-- (the same strings as formatPeriodName in src/lib/accounting/period.ts).
CREATE FUNCTION private.accounting_default_period_name(_business_type text, _starts_on date) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN _business_type = 'soleProprietor'
    THEN EXTRACT(year FROM _starts_on)::integer::text || U&'\5E74\FF08\500B\4EBA\FF09'
    ELSE U&'\7B2C' || ((SELECT pg_catalog.count(*) FROM public.accounting_periods AS p
      WHERE p.business_type = 'corporation' AND p.starts_on < _starts_on) + 1)::text || U&'\671F' END
$$;

-- The end day of the sole business is NULL or the ends_on of the last sole period (ACCOUNTING_PERIOD_SHORTEN_BLOCKED).
CREATE FUNCTION private.accounting_assert_sole_end() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ended_on date;
BEGIN
  SELECT s.sole_business_ended_on INTO v_ended_on FROM public.accounting_settings AS s WHERE s.id = 1;
  IF v_ended_on IS NOT NULL AND v_ended_on IS DISTINCT FROM (SELECT p.ends_on FROM public.accounting_periods AS p
      WHERE p.business_type = 'soleProprietor' ORDER BY p.starts_on DESC LIMIT 1) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_SHORTEN_BLOCKED' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- 3. Triggers on the periods.
-- Deferred (COMMIT or SET CONSTRAINTS ALL IMMEDIATE), once per inserted row, so a transaction that creates several
-- periods (A8) is checked at the end: the layout of S2 (TOO_LONG -> OVERLAP -> GAP) and, for a sole period, the end
-- day of the sole business.
CREATE FUNCTION private.accounting_check_period_layout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.accounting_assert_period_layout(NEW.business_type);
  IF NEW.business_type = 'soleProprietor' THEN
    PERFORM private.accounting_assert_sole_end();
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER accounting_periods_layout AFTER INSERT ON public.accounting_periods
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.accounting_check_period_layout();

-- Immediate, per row: the dates and the business type cannot be written directly (ACCOUNTING_HISTORY_IMMUTABLE).
-- Only ends_on of the last sole period may move, and only as admin_shorten_final_sole_period moves it: no entry after
-- the new end when it comes earlier, and the settings already carry the new day as sole_business_ended_on and as the
-- newEndedOn of the last change record (ACCOUNTING_PERIOD_SHORTEN_BLOCKED otherwise; no flag can bypass it).
CREATE FUNCTION private.accounting_guard_period_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_settings public.accounting_settings%ROWTYPE;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.business_type IS DISTINCT FROM OLD.business_type
    OR NEW.starts_on IS DISTINCT FROM OLD.starts_on OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.creation_request_key IS DISTINCT FROM OLD.creation_request_key
    OR NEW.creation_request_hash IS DISTINCT FROM OLD.creation_request_hash
    OR NEW.legacy_fiscal_year IS DISTINCT FROM OLD.legacy_fiscal_year THEN
    RAISE EXCEPTION 'ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.ends_on IS DISTINCT FROM OLD.ends_on THEN
    SELECT * INTO v_settings FROM public.accounting_settings AS s WHERE s.id = 1;
    IF OLD.business_type <> 'soleProprietor'
      OR EXISTS (SELECT 1 FROM public.accounting_periods AS p
        WHERE p.business_type = 'soleProprietor' AND p.starts_on > OLD.starts_on)
      OR (NEW.ends_on < OLD.ends_on AND EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
        WHERE e.period_id = OLD.id AND e.entry_date > NEW.ends_on))
      OR v_settings.sole_business_ended_on IS DISTINCT FROM NEW.ends_on
      OR (v_settings.sole_end_changes -> -1 ->> 'newEndedOn') IS DISTINCT FROM pg_catalog.to_char(NEW.ends_on, 'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'ACCOUNTING_PERIOD_SHORTEN_BLOCKED' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_periods_guard_update BEFORE UPDATE ON public.accounting_periods
  FOR EACH ROW EXECUTE FUNCTION private.accounting_guard_period_update();
CREATE TRIGGER accounting_periods_no_delete BEFORE DELETE ON public.accounting_periods
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_periods_no_truncate BEFORE TRUNCATE ON public.accounting_periods
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();

-- 4. Triggers on the settings.
-- Immediate, per row: id and cutover_on never change; a business_start_date once set is ACCOUNTING_SETTINGS_LOCKED;
-- sole_end_changes only grows by at most one record, the old records stay as they are, a record is added exactly when
-- sole_business_ended_on changes (never back to NULL), and the added record has the six keys with previousEndedOn and
-- newEndedOn equal to the end day before and after (ACCOUNTING_HISTORY_IMMUTABLE otherwise).
CREATE FUNCTION private.accounting_guard_settings_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_old integer := pg_catalog.jsonb_array_length(OLD.sole_end_changes);
  v_new integer := pg_catalog.jsonb_array_length(NEW.sole_end_changes);
  v_added jsonb;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.cutover_on IS DISTINCT FROM OLD.cutover_on THEN
    RAISE EXCEPTION 'ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.business_start_date IS NOT NULL AND NEW.business_start_date IS DISTINCT FROM OLD.business_start_date THEN
    RAISE EXCEPTION 'ACCOUNTING_SETTINGS_LOCKED' USING ERRCODE = '55000';
  END IF;
  IF v_new - v_old NOT IN (0, 1)
    OR COALESCE((SELECT pg_catalog.jsonb_agg(c.value ORDER BY c.n)
        FROM pg_catalog.jsonb_array_elements(NEW.sole_end_changes) WITH ORDINALITY AS c(value, n) WHERE c.n <= v_old),
      '[]'::jsonb) IS DISTINCT FROM OLD.sole_end_changes
    OR (v_new > v_old) <> (NEW.sole_business_ended_on IS DISTINCT FROM OLD.sole_business_ended_on)
    OR (OLD.sole_business_ended_on IS NOT NULL AND NEW.sole_business_ended_on IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF v_new > v_old THEN
    v_added := NEW.sole_end_changes -> -1;
    IF pg_catalog.jsonb_typeof(v_added) IS DISTINCT FROM 'object'
      OR ARRAY(SELECT k.name FROM pg_catalog.jsonb_object_keys(v_added) AS k(name) ORDER BY k.name COLLATE "C")
        IS DISTINCT FROM ARRAY['changedAt', 'changedBy', 'newEndedOn', 'previousEndedOn', 'reason', 'requestKey']
      OR v_added -> 'previousEndedOn' IS DISTINCT FROM
        COALESCE(pg_catalog.to_jsonb(pg_catalog.to_char(OLD.sole_business_ended_on, 'YYYY-MM-DD')), 'null'::jsonb)
      OR v_added ->> 'newEndedOn' IS DISTINCT FROM pg_catalog.to_char(NEW.sole_business_ended_on, 'YYYY-MM-DD') THEN
      RAISE EXCEPTION 'ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_settings_guard_update BEFORE UPDATE ON public.accounting_settings
  FOR EACH ROW EXECUTE FUNCTION private.accounting_guard_settings_update();
CREATE TRIGGER accounting_settings_no_delete BEFORE DELETE ON public.accounting_settings
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_settings_no_truncate BEFORE TRUNCATE ON public.accounting_settings
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();

-- Deferred, per row: at COMMIT the end day of the sole business is NULL or the ends_on of the last sole period, so an
-- UPDATE that writes the end day and one record directly without moving the period is refused
-- (ACCOUNTING_PERIOD_SHORTEN_BLOCKED). The shorten entry writes the settings first and the period second, which this
-- check sees only at the end.
CREATE FUNCTION private.accounting_check_sole_end_matches_period() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM private.accounting_assert_sole_end();
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER accounting_settings_sole_end AFTER INSERT OR UPDATE ON public.accounting_settings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.accounting_check_sole_end_matches_period();

-- 5. The opening balances are append only.
CREATE TRIGGER accounting_opening_balances_no_update_delete BEFORE UPDATE OR DELETE ON public.accounting_opening_balances
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_opening_balances_no_truncate BEFORE TRUNCATE ON public.accounting_opening_balances
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();

-- The guards fire ALWAYS (also under session_replication_role = replica); the deferred checks stay ordinary, as in S2.
ALTER TABLE public.accounting_periods ENABLE ALWAYS TRIGGER accounting_periods_guard_update;
ALTER TABLE public.accounting_periods ENABLE ALWAYS TRIGGER accounting_periods_no_delete;
ALTER TABLE public.accounting_periods ENABLE ALWAYS TRIGGER accounting_periods_no_truncate;
ALTER TABLE public.accounting_settings ENABLE ALWAYS TRIGGER accounting_settings_guard_update;
ALTER TABLE public.accounting_settings ENABLE ALWAYS TRIGGER accounting_settings_no_delete;
ALTER TABLE public.accounting_settings ENABLE ALWAYS TRIGGER accounting_settings_no_truncate;
ALTER TABLE public.accounting_opening_balances ENABLE ALWAYS TRIGGER accounting_opening_balances_no_update_delete;
ALTER TABLE public.accounting_opening_balances ENABLE ALWAYS TRIGGER accounting_opening_balances_no_truncate;

-- 6. The settings row. cutover_on is the day in Japan this migration is applied.
INSERT INTO public.accounting_settings (id, cutover_on) VALUES (1, private.accounting_jst_date(pg_catalog.now()));

-- 7. Reads (STABLE). get_accounting_settings is also the internal settings reader.
CREATE FUNCTION private.get_accounting_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'business_start_date', pg_catalog.to_char(s.business_start_date, 'YYYY-MM-DD'),
    'cutover_on', pg_catalog.to_char(s.cutover_on, 'YYYY-MM-DD'),
    'current_business_type', s.current_business_type,
    'sole_business_ended_on', pg_catalog.to_char(s.sole_business_ended_on, 'YYYY-MM-DD'),
    'version', s.version::text,
    'sole_end_changes', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'previousEndedOn', c.value -> 'previousEndedOn', 'newEndedOn', c.value -> 'newEndedOn',
        'reason', c.value -> 'reason', 'changedAt', c.value -> 'changedAt') ORDER BY c.n)
      FROM pg_catalog.jsonb_array_elements(s.sole_end_changes) WITH ORDINALITY AS c(value, n)), '[]'::jsonb))
  FROM public.accounting_settings AS s WHERE s.id = 1
$$;

-- Every period in start order (then business type, then id).
CREATE FUNCTION private.list_accounting_periods() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT private.accounting_period_json(p.id) FROM public.accounting_periods AS p
  ORDER BY p.starts_on, p.business_type COLLATE "C", p.id
$$;

-- The opening balances of a period (signed = debit - credit; zero rows = basis none):
--   1. stored rows: the largest closing_version for a sole period, closing_version 1 for a corporation (basis stored);
--   2. otherwise the previous period of the same business type (ends_on = starts_on - 1); none -> no row (the first
--      period of the business and the first corporation term start at zero; another business type is never searched);
--   3. otherwise carryover: the previous opening (recursively) plus the previous entries, with revenue and expense,
--      owner draw and owner contribution folded into 2910 for a sole proprietor (2910 = 2910 + income before the
--      deduction + owner contribution - owner draw, design 3-e), and revenue and expense folded into 3040 for a
--      corporation. The capital row (2910 / 3040) is always returned; other zero rows are left out. The total is zero.
CREATE FUNCTION private.accounting_opening_balances(_period_id uuid)
RETURNS TABLE(account_code text, signed_amount bigint, basis text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_period public.accounting_periods%ROWTYPE;
  v_version integer;
  v_previous uuid;
  v_capital text;
  v_folded text[];
BEGIN
  SELECT * INTO v_period FROM public.accounting_periods AS p WHERE p.id = _period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_version := CASE WHEN v_period.business_type = 'soleProprietor'
    THEN (SELECT pg_catalog.max(o.closing_version) FROM public.accounting_opening_balances AS o WHERE o.period_id = _period_id)
    ELSE 1 END;
  IF EXISTS (SELECT 1 FROM public.accounting_opening_balances AS o
    WHERE o.period_id = _period_id AND o.closing_version = v_version) THEN
    RETURN QUERY SELECT o.account_code, o.signed_amount, 'stored'::text FROM public.accounting_opening_balances AS o
      WHERE o.period_id = _period_id AND o.closing_version = v_version ORDER BY o.account_code COLLATE "C";
    RETURN;
  END IF;
  SELECT p.id INTO v_previous FROM public.accounting_periods AS p
  WHERE p.business_type = v_period.business_type AND p.ends_on = v_period.starts_on - 1;
  IF v_previous IS NULL THEN
    RETURN;
  END IF;
  IF v_period.business_type = 'soleProprietor' THEN
    v_capital := '2910';
    v_folded := ARRAY['capital_sole', 'owner_draw', 'owner_contribution', 'pl_zero'];
  ELSE
    v_capital := '3040';
    v_folded := ARRAY['retained_corp', 'pl_zero'];
  END IF;
  RETURN QUERY
  SELECT m.code, pg_catalog.sum(m.amount)::bigint, 'carryover'::text
  FROM (
    SELECT CASE WHEN a.carryover_role = ANY (v_folded) THEN v_capital ELSE c.code END AS code, c.amount
    FROM (
      SELECT b.account_code AS code, b.signed_amount::numeric AS amount
      FROM private.accounting_opening_balances(v_previous) AS b
      UNION ALL
      SELECT l.account_code, (l.debit - l.credit)::numeric
      FROM public.accounting_journal_entries AS e JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id
      WHERE e.period_id = v_previous
    ) AS c JOIN public.accounting_accounts AS a ON a.code = c.code
    UNION ALL
    SELECT v_capital, 0::numeric
  ) AS m
  GROUP BY m.code
  HAVING pg_catalog.sum(m.amount) <> 0 OR m.code = v_capital
  ORDER BY m.code COLLATE "C";
END;
$$;

CREATE FUNCTION private.get_accounting_opening(_period_id uuid)
RETURNS TABLE(account_code text, signed_amount bigint, basis text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT o.account_code, o.signed_amount, o.basis FROM private.accounting_opening_balances(_period_id) AS o $$;

-- The saved entries of a period in entry-date order, then entry number (12-b), at most 200 per page. The next page
-- starts after the (entry_date, entry_no) pair of the last row; both are given together or not at all. A manual or
-- migrated entry (source_table admin_finance_expenses) also carries the counts of its old revisions and receipts.
CREATE FUNCTION private.list_accounting_journal(_period_id uuid, _from date DEFAULT NULL, _to date DEFAULT NULL,
  _limit integer DEFAULT 100, _after_entry_date date DEFAULT NULL, _after_entry_no bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_entry public.accounting_journal_entries%ROWTYPE;
  v_entries jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_more boolean := false;
  v_last_date date;
  v_last_no bigint;
BEGIN
  IF _period_id IS NULL OR _limit IS NULL OR _limit < 1 OR _limit > 200 OR _from > _to
    OR (_after_entry_date IS NULL) <> (_after_entry_no IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounting_periods AS p WHERE p.id = _period_id) THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  FOR v_entry IN SELECT * FROM public.accounting_journal_entries AS e
    WHERE e.period_id = _period_id AND (_from IS NULL OR e.entry_date >= _from) AND (_to IS NULL OR e.entry_date <= _to)
      AND (_after_entry_date IS NULL OR (e.entry_date, e.entry_no) > (_after_entry_date, _after_entry_no))
    ORDER BY e.entry_date, e.entry_no LIMIT _limit + 1
  LOOP
    v_count := v_count + 1;
    IF v_count > _limit THEN
      v_more := true;
      EXIT;
    END IF;
    v_entries := v_entries || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'id', v_entry.id, 'period_id', v_entry.period_id, 'entry_no', v_entry.entry_no,
      'entry_date', pg_catalog.to_char(v_entry.entry_date, 'YYYY-MM-DD'), 'event_kind', v_entry.event_kind,
      'dedupe_key', v_entry.dedupe_key, 'description', v_entry.description, 'recorded_at', v_entry.recorded_at,
      'recorded_by', v_entry.recorded_by, 'is_late', v_entry.is_late, 'reverses_entry_id', v_entry.reverses_entry_id,
      'reason', v_entry.reason, 'source_table', v_entry.source_table, 'source_id', v_entry.source_id,
      'migrated_from', v_entry.migrated_from, 'migrated_at', v_entry.migrated_at,
      'source_recorded_at', v_entry.source_recorded_at,
      'lines', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('line_no', l.line_no,
          'account_code', l.account_code, 'debit', l.debit, 'credit', l.credit, 'sub_account', l.sub_account,
          'counterparty', l.counterparty, 'order_id', l.order_id, 'memo', l.memo) ORDER BY l.line_no)
        FROM public.accounting_journal_lines AS l WHERE l.entry_id = v_entry.id))
      || CASE WHEN v_entry.source_table = 'admin_finance_expenses' THEN pg_catalog.jsonb_build_object('legacy',
        pg_catalog.jsonb_build_object(
          'revision_count', (SELECT pg_catalog.count(*) FROM public.admin_finance_entry_revisions AS r
            WHERE r.entry_id::text = v_entry.source_id),
          'receipt_count', (SELECT pg_catalog.count(*) FROM public.admin_finance_receipts AS r
            WHERE r.entry_id::text = v_entry.source_id)))
        ELSE '{}'::jsonb END);
    v_last_date := v_entry.entry_date;
    v_last_no := v_entry.entry_no;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('entries', v_entries,
    'next_after_date', CASE WHEN v_more THEN pg_catalog.to_char(v_last_date, 'YYYY-MM-DD') END,
    'next_after_no', CASE WHEN v_more THEN v_last_no END);
END;
$$;

-- Debit and credit totals of a period up to a day (the whole period when NULL), with the opening balance (signed).
CREATE FUNCTION private.get_accounting_trial_balance(_period_id uuid, _through date DEFAULT NULL)
RETURNS TABLE(account_code text, debit_total bigint, credit_total bigint, opening_signed bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT x.code, pg_catalog.sum(x.debit)::bigint, pg_catalog.sum(x.credit)::bigint, pg_catalog.sum(x.opening)::bigint
  FROM (
    SELECT o.account_code AS code, 0::numeric AS debit, 0::numeric AS credit, o.signed_amount::numeric AS opening
    FROM private.accounting_opening_balances(_period_id) AS o
    UNION ALL
    SELECT l.account_code, l.debit::numeric, l.credit::numeric, 0::numeric
    FROM public.accounting_journal_entries AS e JOIN public.accounting_journal_lines AS l ON l.entry_id = e.id
    WHERE e.period_id = _period_id AND (_through IS NULL OR e.entry_date <= _through)
  ) AS x
  GROUP BY x.code
  ORDER BY x.code COLLATE "C"
$$;

-- 8. Calendar-year sole periods (no entry point). The years from the opening day's year (2025 when not set) to this
--    year in Japan + 1 may be created; outside is ACCOUNTING_ARGUMENT_INVALID. A year after the end day of the sole
--    business is ACCOUNTING_PERIOD_MISSING. Missing years between the existing sole periods and _year are created too
--    (no gap), with legacy_fiscal_year; an existing year (even the shortened last one) is reused and not extended.
--    Returns the ids it created.
CREATE FUNCTION private.accounting_ensure_individual_periods(_year integer, _actor_id uuid) RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_settings public.accounting_settings%ROWTYPE;
  v_low integer;
  v_high integer;
  v_first integer;
  v_last integer;
  v_from integer;
  v_to integer;
  v_year integer;
  v_id uuid;
BEGIN
  IF _year IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  SELECT * INTO v_settings FROM public.accounting_settings AS s WHERE s.id = 1;
  v_low := COALESCE(EXTRACT(year FROM v_settings.business_start_date)::integer, 2025);
  v_high := EXTRACT(year FROM private.accounting_jst_date(pg_catalog.now()))::integer + 1;
  IF _year < v_low OR _year > v_high THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_settings.sole_business_ended_on IS NOT NULL AND _year > EXTRACT(year FROM v_settings.sole_business_ended_on) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_MISSING' USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.min(EXTRACT(year FROM p.starts_on))::integer, pg_catalog.max(EXTRACT(year FROM p.starts_on))::integer
  INTO v_first, v_last FROM public.accounting_periods AS p WHERE p.business_type = 'soleProprietor';
  IF v_first IS NULL THEN
    v_from := _year;
    v_to := _year;
  ELSIF _year < v_first THEN
    v_from := _year;
    v_to := v_first - 1;
  ELSIF _year > v_last THEN
    v_from := v_last + 1;
    v_to := _year;
  ELSE
    RETURN;
  END IF;
  FOR v_year IN v_from .. v_to LOOP
    INSERT INTO public.accounting_periods (business_type, name, starts_on, ends_on, created_by, legacy_fiscal_year)
    VALUES ('soleProprietor', private.accounting_default_period_name('soleProprietor', pg_catalog.make_date(v_year, 1, 1)),
      pg_catalog.make_date(v_year, 1, 1), pg_catalog.make_date(v_year, 12, 31), _actor_id, v_year)
    RETURNING id INTO v_id;
    RETURN NEXT v_id;
  END LOOP;
  PERFORM private.accounting_assert_period_layout('soleProprietor');
  RETURN;
END;
$$;

-- 9. The period of an event on a day (no entry point; the manual-entry trigger and the plan 2-6 runners call it; the
--    reversal does not). The only rule for choosing a period:
--    (3) after a registered end day of the sole business no sole period is chosen or created: with current_business_type
--        corporation the corporation period of the day, with soleProprietor ACCOUNTING_PERIOD_MISSING (DETAIL
--        sole_ended_not_switched), and no corporation period is ACCOUNTING_PERIOD_MISSING;
--    (1) one period contains the day: that one; (2) a sole and a corporation period: the one of current_business_type;
--    (4) none and current_business_type soleProprietor: the calendar-year sole period is created
--        (accounting_ensure_individual_periods, created_by = _actor_id); (5) none for a corporation: PERIOD_MISSING.
CREATE FUNCTION private.accounting_period_for_event(_date date, _actor_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_settings public.accounting_settings%ROWTYPE;
  v_sole uuid[];
  v_corporation uuid[];
BEGIN
  IF _date IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_settings FROM public.accounting_settings AS s WHERE s.id = 1;
  SELECT pg_catalog.array_agg(p.id) FILTER (WHERE p.business_type = 'soleProprietor'),
    pg_catalog.array_agg(p.id) FILTER (WHERE p.business_type = 'corporation')
  INTO v_sole, v_corporation FROM public.accounting_periods AS p WHERE _date BETWEEN p.starts_on AND p.ends_on;
  IF pg_catalog.cardinality(v_sole) > 1 OR pg_catalog.cardinality(v_corporation) > 1 THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_OVERLAP' USING ERRCODE = '23514';
  END IF;
  IF v_settings.sole_business_ended_on IS NOT NULL AND _date > v_settings.sole_business_ended_on THEN
    IF v_settings.current_business_type = 'soleProprietor' THEN
      RAISE EXCEPTION 'ACCOUNTING_PERIOD_MISSING' USING ERRCODE = '55000', DETAIL = 'sole_ended_not_switched';
    END IF;
    IF v_corporation IS NULL THEN
      RAISE EXCEPTION 'ACCOUNTING_PERIOD_MISSING' USING ERRCODE = '55000';
    END IF;
    RETURN v_corporation[1];
  END IF;
  IF v_sole IS NOT NULL AND v_corporation IS NOT NULL THEN
    RETURN CASE WHEN v_settings.current_business_type = 'corporation' THEN v_corporation[1] ELSE v_sole[1] END;
  END IF;
  IF v_sole IS NOT NULL THEN
    RETURN v_sole[1];
  END IF;
  IF v_corporation IS NOT NULL THEN
    RETURN v_corporation[1];
  END IF;
  IF v_settings.current_business_type = 'corporation' THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_MISSING' USING ERRCODE = '55000';
  END IF;
  PERFORM private.accounting_ensure_individual_periods(EXTRACT(year FROM _date)::integer, _actor_id);
  RETURN private.accounting_period_for(_date, 'soleProprietor');
END;
$$;

-- 10. Writers. Each checks admin.accounting.settings.manage, checks its arguments, takes the locks, then answers a
--     repeated request key (same content: the first result, before the version check; other content:
--     ACCOUNTING_REQUEST_KEY_CONFLICT), then compares versions (ACCOUNTING_VERSION_CONFLICT).
-- A new period. _name NULL takes the default name. The length is checked first (ACCOUNTING_PERIOD_TOO_LONG), then
-- start > end and a sole period that is not one calendar year are ACCOUNTING_ARGUMENT_INVALID, as is a sole period
-- ending after the end day of the sole business; an overlap or a gap in the same business type is refused at once.
CREATE FUNCTION private.admin_create_accounting_period(_actor_id uuid, _business_type text, _starts_on date,
  _ends_on date, _name text, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior jsonb;
  v_ended_on date;
  v_id uuid;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.settings.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _business_type IS NULL OR _business_type NOT IN ('soleProprietor', 'corporation') OR _starts_on IS NULL
    OR _ends_on IS NULL OR _request_key IS NULL OR _starts_on > _ends_on
    OR pg_catalog.char_length(pg_catalog.btrim(_name)) = 0 OR pg_catalog.char_length(_name) > 60 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT private.accounting_period_length_ok(_starts_on, _ends_on) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_TOO_LONG' USING ERRCODE = '23514';
  END IF;
  IF _business_type = 'soleProprietor' AND (EXTRACT(month FROM _starts_on) <> 1 OR EXTRACT(day FROM _starts_on) <> 1
    OR EXTRACT(year FROM _ends_on) <> EXTRACT(year FROM _starts_on)) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'create_period', 'actor', _actor_id,
    'business_type', _business_type, 'starts_on', pg_catalog.to_char(_starts_on, 'YYYY-MM-DD'),
    'ends_on', pg_catalog.to_char(_ends_on, 'YYYY-MM-DD'), 'name', _name));
  v_prior := private.accounting_request_replay(_request_key, v_hash);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;
  SELECT s.sole_business_ended_on INTO v_ended_on FROM public.accounting_settings AS s WHERE s.id = 1;
  IF _business_type = 'soleProprietor' AND v_ended_on IS NOT NULL AND _ends_on > v_ended_on THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_periods AS p WHERE p.business_type = _business_type
    AND p.starts_on <= _ends_on AND _starts_on <= p.ends_on) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_OVERLAP' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.accounting_periods (business_type, name, starts_on, ends_on, created_by, creation_request_key,
    creation_request_hash, legacy_fiscal_year)
  VALUES (_business_type, COALESCE(_name, private.accounting_default_period_name(_business_type, _starts_on)),
    _starts_on, _ends_on, _actor_id, _request_key, v_hash,
    CASE WHEN _business_type = 'soleProprietor' THEN EXTRACT(year FROM _starts_on)::integer END)
  RETURNING id INTO v_id;
  PERFORM private.accounting_assert_period_layout(_business_type);
  RETURN private.accounting_period_json(v_id);
END;
$$;

-- Register or re-select the end day of the sole business on the last sole period (11-b). _reason may be NULL only for
-- the first registration; a re-selection needs 1-500 characters. The day lies between starts_on and 31 December of
-- the same year (ACCOUNTING_ARGUMENT_INVALID), the period is the last sole one and, when the day comes earlier, no
-- entry (an original or a reversal) lies after it (ACCOUNTING_PERIOD_SHORTEN_BLOCKED). The day already registered is a
-- no-op that returns the period. Writes (1) the settings: the end day, version + 1 and one change record, then
-- (2) the period: ends_on, version + 1 (the period guard reads the settings' last record). The request key is kept
-- in the period's admin_requests.
CREATE FUNCTION private.admin_shorten_final_sole_period(_actor_id uuid, _period_id uuid, _ended_on date,
  _expected_period_version bigint, _expected_settings_version bigint, _reason text, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior jsonb;
  v_period public.accounting_periods%ROWTYPE;
  v_settings public.accounting_settings%ROWTYPE;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.settings.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _period_id IS NULL OR _ended_on IS NULL OR _expected_period_version IS NULL OR _expected_settings_version IS NULL
    OR _request_key IS NULL OR pg_catalog.char_length(pg_catalog.btrim(_reason)) = 0
    OR pg_catalog.char_length(_reason) > 500 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(_period_id);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'shorten_final_sole_period',
    'actor', _actor_id, 'period_id', _period_id, 'ended_on', pg_catalog.to_char(_ended_on, 'YYYY-MM-DD'),
    'period_version', _expected_period_version::text, 'settings_version', _expected_settings_version::text,
    'reason', _reason));
  v_prior := private.accounting_request_replay(_request_key, v_hash);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;
  SELECT * INTO v_period FROM public.accounting_periods AS p WHERE p.id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_period.business_type <> 'soleProprietor' OR _ended_on < v_period.starts_on
    OR _ended_on > pg_catalog.make_date(EXTRACT(year FROM v_period.starts_on)::integer, 12, 31) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_settings FROM public.accounting_settings AS s WHERE s.id = 1 FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.accounting_periods AS p
    WHERE p.business_type = 'soleProprietor' AND p.starts_on > v_period.starts_on) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_SHORTEN_BLOCKED' USING ERRCODE = '55000';
  END IF;
  IF v_settings.sole_business_ended_on IS NOT DISTINCT FROM _ended_on AND v_period.ends_on = _ended_on THEN
    v_result := private.accounting_period_json(_period_id);
    UPDATE public.accounting_periods AS p SET admin_requests = p.admin_requests || pg_catalog.jsonb_build_object(
      _request_key::text, pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result)) WHERE p.id = _period_id;
    RETURN v_result;
  END IF;
  IF v_period.version <> _expected_period_version OR v_settings.version <> _expected_settings_version THEN
    RAISE EXCEPTION 'ACCOUNTING_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF (v_settings.sole_business_ended_on IS NOT NULL AND _reason IS NULL)
    OR v_period.consumption_taxable_from > _ended_on THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF _ended_on < v_period.ends_on AND EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e
    WHERE e.period_id = _period_id AND e.entry_date > _ended_on) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_SHORTEN_BLOCKED' USING ERRCODE = '55000';
  END IF;
  UPDATE public.accounting_settings AS s SET sole_business_ended_on = _ended_on, version = s.version + 1,
    sole_end_changes = s.sole_end_changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'previousEndedOn', pg_catalog.to_char(v_settings.sole_business_ended_on, 'YYYY-MM-DD'),
      'newEndedOn', pg_catalog.to_char(_ended_on, 'YYYY-MM-DD'), 'reason', _reason, 'changedBy', _actor_id,
      'changedAt', pg_catalog.now(), 'requestKey', _request_key)),
    updated_by = _actor_id, updated_at = pg_catalog.now()
  WHERE s.id = 1;
  UPDATE public.accounting_periods AS p SET ends_on = _ended_on, version = p.version + 1, updated_by = _actor_id,
    updated_at = pg_catalog.now()
  WHERE p.id = _period_id;
  v_result := private.accounting_period_json(_period_id);
  UPDATE public.accounting_periods AS p SET admin_requests = p.admin_requests || pg_catalog.jsonb_build_object(
    _request_key::text, pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result)) WHERE p.id = _period_id;
  RETURN v_result;
END;
$$;

-- The opening day (once; another value later is ACCOUNTING_SETTINGS_LOCKED, the same value passes, 11-k; it lies
-- between 2000-01-01 and today in Japan + 1 year, else ACCOUNTING_ARGUMENT_INVALID) and the current business type.
-- The end day of the sole business is not an argument here.
CREATE FUNCTION private.admin_update_accounting_settings(_actor_id uuid, _business_start_date date,
  _current_business_type text, _expected_version bigint, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior jsonb;
  v_settings public.accounting_settings%ROWTYPE;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.settings.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  -- The opening day can never be re-selected, so a typo is refused: 2000-01-01 .. today in Japan + 1 year.
  IF _current_business_type IS NULL OR _current_business_type NOT IN ('soleProprietor', 'corporation')
    OR _expected_version IS NULL OR _request_key IS NULL OR _business_start_date < DATE '2000-01-01'
    OR _business_start_date > (private.accounting_jst_date(pg_catalog.now()) + interval '1 year')::date THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'update_settings', 'actor', _actor_id,
    'business_start_date', pg_catalog.to_char(_business_start_date, 'YYYY-MM-DD'),
    'current_business_type', _current_business_type, 'version', _expected_version::text));
  v_prior := private.accounting_request_replay(_request_key, v_hash);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;
  SELECT * INTO v_settings FROM public.accounting_settings AS s WHERE s.id = 1 FOR UPDATE;
  IF v_settings.business_start_date IS NOT NULL AND _business_start_date IS DISTINCT FROM v_settings.business_start_date THEN
    RAISE EXCEPTION 'ACCOUNTING_SETTINGS_LOCKED' USING ERRCODE = '55000';
  END IF;
  IF v_settings.version <> _expected_version THEN
    RAISE EXCEPTION 'ACCOUNTING_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF _business_start_date IS DISTINCT FROM v_settings.business_start_date
    OR _current_business_type <> v_settings.current_business_type THEN
    UPDATE public.accounting_settings AS s SET business_start_date = _business_start_date,
      current_business_type = _current_business_type, version = s.version + 1, updated_by = _actor_id,
      updated_at = pg_catalog.now()
    WHERE s.id = 1;
  END IF;
  v_result := private.get_accounting_settings();
  UPDATE public.accounting_settings AS s SET admin_requests = s.admin_requests || pg_catalog.jsonb_build_object(
    _request_key::text, pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result)) WHERE s.id = 1;
  RETURN v_result;
END;
$$;

-- The filing settings of a period (11-h, 5-j, 15-c2): the extensions (corporation only; the consumption tax extension
-- needs the corporate tax one), exempt (no day) or taxable (a day inside the period). The request key is kept in the
-- period's admin_requests.
CREATE FUNCTION private.admin_update_accounting_period_filing(_actor_id uuid, _period_id uuid,
  _corporate_tax_extension_months smallint, _consumption_tax_extension_months smallint, _consumption_tax_status text,
  _consumption_taxable_from date, _expected_version bigint, _request_key uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_hash text;
  v_prior jsonb;
  v_period public.accounting_periods%ROWTYPE;
  v_result jsonb;
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.accounting.settings.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _period_id IS NULL OR _corporate_tax_extension_months IS NULL OR _consumption_tax_extension_months IS NULL
    OR _consumption_tax_status IS NULL OR _expected_version IS NULL OR _request_key IS NULL
    OR _corporate_tax_extension_months NOT BETWEEN 0 AND 1 OR _consumption_tax_extension_months NOT BETWEEN 0 AND 1
    OR _consumption_tax_extension_months > _corporate_tax_extension_months
    OR _consumption_tax_status NOT IN ('exempt', 'taxable')
    OR (_consumption_tax_status = 'exempt') <> (_consumption_taxable_from IS NULL) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(_period_id);
  v_hash := private.accounting_request_hash(pg_catalog.jsonb_build_object('op', 'update_period_filing',
    'actor', _actor_id, 'period_id', _period_id, 'corporate', _corporate_tax_extension_months,
    'consumption', _consumption_tax_extension_months, 'status', _consumption_tax_status,
    'taxable_from', pg_catalog.to_char(_consumption_taxable_from, 'YYYY-MM-DD'), 'version', _expected_version::text));
  v_prior := private.accounting_request_replay(_request_key, v_hash);
  IF v_prior IS NOT NULL THEN
    RETURN v_prior;
  END IF;
  SELECT * INTO v_period FROM public.accounting_periods AS p WHERE p.id = _period_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF (v_period.business_type = 'soleProprietor' AND _corporate_tax_extension_months <> 0)
    OR _consumption_taxable_from < v_period.starts_on OR _consumption_taxable_from > v_period.ends_on THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF v_period.version <> _expected_version THEN
    RAISE EXCEPTION 'ACCOUNTING_VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF (v_period.corporate_tax_extension_months, v_period.consumption_tax_extension_months, v_period.consumption_tax_status,
      v_period.consumption_taxable_from) IS DISTINCT FROM (_corporate_tax_extension_months,
      _consumption_tax_extension_months, _consumption_tax_status, _consumption_taxable_from) THEN
    UPDATE public.accounting_periods AS p SET corporate_tax_extension_months = _corporate_tax_extension_months,
      consumption_tax_extension_months = _consumption_tax_extension_months,
      consumption_tax_status = _consumption_tax_status, consumption_taxable_from = _consumption_taxable_from,
      version = p.version + 1, updated_by = _actor_id, updated_at = pg_catalog.now()
    WHERE p.id = _period_id;
  END IF;
  v_result := private.accounting_period_json(_period_id);
  UPDATE public.accounting_periods AS p SET admin_requests = p.admin_requests || pg_catalog.jsonb_build_object(
    _request_key::text, pg_catalog.jsonb_build_object('hash', v_hash, 'result', v_result)) WHERE p.id = _period_id;
  RETURN v_result;
END;
$$;

-- 11. Stored openings (service_role; plan 6 calls it, plan 1 has no route). _rows: [{"account_code":"1040",
--     "signed_amount":120000}] (signed = debit - credit, JSON integers, one row per account). initial has no source
--     period; closing_carryover names the immediately preceding period of the same business type (ends_on =
--     starts_on - 1; ACCOUNTING_OPENING_TYPE_MISMATCH otherwise, also for the first corporation term). The
--     first corporation term (no previous corporation period) takes no non-zero initial row (also TYPE_MISMATCH,
--     3-c). The rows total zero and revenue, expense, owner draw and owner contribution are zero (3-f,
--     ACCOUNTING_OPENING_UNBALANCED). Returns the number of rows stored.
CREATE FUNCTION private.accounting_store_opening(_actor_id uuid, _period_id uuid, _rows jsonb, _closing_version integer,
  _source text, _source_period_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_period public.accounting_periods%ROWTYPE;
  v_source_type text;
  v_source_ends_on date;
  v_row jsonb;
  v_codes text[] := ARRAY[]::text[];
  v_total numeric := 0;
  v_count integer;
BEGIN
  IF _period_id IS NULL OR _closing_version IS NULL OR _closing_version < 1 OR _source IS NULL
    OR _source NOT IN ('initial', 'closing_carryover') OR (_source = 'initial') <> (_source_period_id IS NULL)
    OR _rows IS NULL OR pg_catalog.jsonb_typeof(_rows) <> 'array' OR pg_catalog.jsonb_array_length(_rows) = 0 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_row IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_rows) AS e(value) LOOP
    IF pg_catalog.jsonb_typeof(v_row) <> 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(v_row) AS k(name)
        WHERE k.name <> ALL (ARRAY['account_code', 'signed_amount']))
      OR pg_catalog.jsonb_typeof(v_row -> 'account_code') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_row -> 'signed_amount') IS DISTINCT FROM 'number'
      OR NOT EXISTS (SELECT 1 FROM public.accounting_accounts AS a WHERE a.code = v_row ->> 'account_code')
      OR (v_row ->> 'account_code') = ANY (v_codes) THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF (v_row ->> 'signed_amount')::numeric <> pg_catalog.trunc((v_row ->> 'signed_amount')::numeric)
      OR pg_catalog.abs((v_row ->> 'signed_amount')::numeric) > 9007199254740991 THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_codes := v_codes || (v_row ->> 'account_code');
    v_total := v_total + (v_row ->> 'signed_amount')::numeric;
  END LOOP;
  PERFORM private.accounting_lock_all(_period_id);
  SELECT * INTO v_period FROM public.accounting_periods AS p WHERE p.id = _period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _source_period_id IS NOT NULL THEN
    SELECT p.business_type, p.ends_on INTO v_source_type, v_source_ends_on
    FROM public.accounting_periods AS p WHERE p.id = _source_period_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    -- Only the immediately preceding period of the same business type (so never the period itself, a later one, or
    -- anything into the first corporation term, which has no previous period).
    IF v_source_type <> v_period.business_type OR v_source_ends_on <> v_period.starts_on - 1 THEN
      RAISE EXCEPTION 'ACCOUNTING_OPENING_TYPE_MISMATCH' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF _source = 'initial' AND v_period.business_type = 'corporation'
    AND NOT EXISTS (SELECT 1 FROM public.accounting_periods AS p
      WHERE p.business_type = 'corporation' AND p.ends_on = v_period.starts_on - 1)
    AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(_rows) AS e(value)
      WHERE (e.value ->> 'signed_amount')::numeric <> 0) THEN
    RAISE EXCEPTION 'ACCOUNTING_OPENING_TYPE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF v_total <> 0 OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(_rows) AS e(value)
      JOIN public.accounting_accounts AS a ON a.code = e.value ->> 'account_code'
    WHERE a.carryover_role IN ('pl_zero', 'owner_draw', 'owner_contribution')
      AND (e.value ->> 'signed_amount')::numeric <> 0) THEN
    RAISE EXCEPTION 'ACCOUNTING_OPENING_UNBALANCED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_opening_balances AS o
    WHERE o.period_id = _period_id AND o.closing_version = _closing_version) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.accounting_opening_balances (period_id, account_code, signed_amount, closing_version, source,
    source_period_id)
  SELECT _period_id, e.value ->> 'account_code', (e.value ->> 'signed_amount')::bigint, _closing_version, _source,
    _source_period_id
  FROM pg_catalog.jsonb_array_elements(_rows) AS e(value);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 12. Public entries (same name, arguments and result; LANGUAGE sql SECURITY INVOKER; service_role only).
CREATE FUNCTION public.admin_create_accounting_period(_actor_id uuid, _business_type text, _starts_on date,
  _ends_on date, _name text, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_create_accounting_period(_actor_id, _business_type, _starts_on, _ends_on, _name, _request_key) $$;

CREATE FUNCTION public.admin_shorten_final_sole_period(_actor_id uuid, _period_id uuid, _ended_on date,
  _expected_period_version bigint, _expected_settings_version bigint, _reason text, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_shorten_final_sole_period(_actor_id, _period_id, _ended_on, _expected_period_version,
  _expected_settings_version, _reason, _request_key) $$;

CREATE FUNCTION public.admin_update_accounting_settings(_actor_id uuid, _business_start_date date,
  _current_business_type text, _expected_version bigint, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_update_accounting_settings(_actor_id, _business_start_date, _current_business_type,
  _expected_version, _request_key) $$;

CREATE FUNCTION public.admin_update_accounting_period_filing(_actor_id uuid, _period_id uuid,
  _corporate_tax_extension_months smallint, _consumption_tax_extension_months smallint, _consumption_tax_status text,
  _consumption_taxable_from date, _expected_version bigint, _request_key uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_update_accounting_period_filing(_actor_id, _period_id, _corporate_tax_extension_months,
  _consumption_tax_extension_months, _consumption_tax_status, _consumption_taxable_from, _expected_version,
  _request_key) $$;

CREATE FUNCTION public.get_accounting_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.get_accounting_settings() $$;

CREATE FUNCTION public.list_accounting_periods() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_accounting_periods() $$;

CREATE FUNCTION public.get_accounting_opening(_period_id uuid)
RETURNS TABLE(account_code text, signed_amount bigint, basis text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.get_accounting_opening(_period_id) $$;

CREATE FUNCTION public.list_accounting_journal(_period_id uuid, _from date DEFAULT NULL, _to date DEFAULT NULL,
  _limit integer DEFAULT 100, _after_entry_date date DEFAULT NULL, _after_entry_no bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.list_accounting_journal(_period_id, _from, _to, _limit, _after_entry_date, _after_entry_no) $$;

CREATE FUNCTION public.get_accounting_trial_balance(_period_id uuid, _through date DEFAULT NULL)
RETURNS TABLE(account_code text, debit_total bigint, credit_total bigint, opening_signed bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.get_accounting_trial_balance(_period_id, _through) $$;

-- 13. Owners and EXECUTE. service_role: the four writers and five reads (private and public) and
--     private.accounting_store_opening; everything else is owner only.
ALTER FUNCTION private.accounting_request_hash(jsonb) OWNER TO postgres;
ALTER FUNCTION private.accounting_period_json(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_request_replay(uuid,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_default_period_name(text,date) OWNER TO postgres;
ALTER FUNCTION private.accounting_assert_sole_end() OWNER TO postgres;
ALTER FUNCTION private.accounting_check_period_layout() OWNER TO postgres;
ALTER FUNCTION private.accounting_guard_period_update() OWNER TO postgres;
ALTER FUNCTION private.accounting_guard_settings_update() OWNER TO postgres;
ALTER FUNCTION private.accounting_check_sole_end_matches_period() OWNER TO postgres;
ALTER FUNCTION private.accounting_opening_balances(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_ensure_individual_periods(integer,uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_period_for_event(date,uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_store_opening(uuid,uuid,jsonb,integer,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_create_accounting_period(uuid,text,date,date,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_update_accounting_settings(uuid,date,text,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION private.admin_update_accounting_period_filing(uuid,uuid,smallint,smallint,text,date,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION private.get_accounting_settings() OWNER TO postgres;
ALTER FUNCTION private.list_accounting_periods() OWNER TO postgres;
ALTER FUNCTION private.get_accounting_opening(uuid) OWNER TO postgres;
ALTER FUNCTION private.list_accounting_journal(uuid,date,date,integer,date,bigint) OWNER TO postgres;
ALTER FUNCTION private.get_accounting_trial_balance(uuid,date) OWNER TO postgres;
ALTER FUNCTION public.admin_create_accounting_period(uuid,text,date,date,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_update_accounting_settings(uuid,date,text,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.admin_update_accounting_period_filing(uuid,uuid,smallint,smallint,text,date,bigint,uuid) OWNER TO postgres;
ALTER FUNCTION public.get_accounting_settings() OWNER TO postgres;
ALTER FUNCTION public.list_accounting_periods() OWNER TO postgres;
ALTER FUNCTION public.get_accounting_opening(uuid) OWNER TO postgres;
ALTER FUNCTION public.list_accounting_journal(uuid,date,date,integer,date,bigint) OWNER TO postgres;
ALTER FUNCTION public.get_accounting_trial_balance(uuid,date) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_request_hash(jsonb), private.accounting_period_json(uuid),
  private.accounting_request_replay(uuid,text), private.accounting_default_period_name(text,date),
  private.accounting_assert_sole_end(), private.accounting_check_period_layout(),
  private.accounting_guard_period_update(), private.accounting_guard_settings_update(),
  private.accounting_check_sole_end_matches_period(), private.accounting_opening_balances(uuid),
  private.accounting_ensure_individual_periods(integer,uuid), private.accounting_period_for_event(date,uuid),
  private.accounting_store_opening(uuid,uuid,jsonb,integer,text,uuid),
  private.admin_create_accounting_period(uuid,text,date,date,text,uuid),
  private.admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid),
  private.admin_update_accounting_settings(uuid,date,text,bigint,uuid),
  private.admin_update_accounting_period_filing(uuid,uuid,smallint,smallint,text,date,bigint,uuid),
  private.get_accounting_settings(), private.list_accounting_periods(), private.get_accounting_opening(uuid),
  private.list_accounting_journal(uuid,date,date,integer,date,bigint), private.get_accounting_trial_balance(uuid,date),
  public.admin_create_accounting_period(uuid,text,date,date,text,uuid),
  public.admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid),
  public.admin_update_accounting_settings(uuid,date,text,bigint,uuid),
  public.admin_update_accounting_period_filing(uuid,uuid,smallint,smallint,text,date,bigint,uuid),
  public.get_accounting_settings(), public.list_accounting_periods(), public.get_accounting_opening(uuid),
  public.list_accounting_journal(uuid,date,date,integer,date,bigint), public.get_accounting_trial_balance(uuid,date)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.accounting_store_opening(uuid,uuid,jsonb,integer,text,uuid),
  private.admin_create_accounting_period(uuid,text,date,date,text,uuid),
  private.admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid),
  private.admin_update_accounting_settings(uuid,date,text,bigint,uuid),
  private.admin_update_accounting_period_filing(uuid,uuid,smallint,smallint,text,date,bigint,uuid),
  private.get_accounting_settings(), private.list_accounting_periods(), private.get_accounting_opening(uuid),
  private.list_accounting_journal(uuid,date,date,integer,date,bigint), private.get_accounting_trial_balance(uuid,date),
  public.admin_create_accounting_period(uuid,text,date,date,text,uuid),
  public.admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid),
  public.admin_update_accounting_settings(uuid,date,text,bigint,uuid),
  public.admin_update_accounting_period_filing(uuid,uuid,smallint,smallint,text,date,bigint,uuid),
  public.get_accounting_settings(), public.list_accounting_periods(), public.get_accounting_opening(uuid),
  public.list_accounting_journal(uuid,date,date,integer,date,bigint), public.get_accounting_trial_balance(uuid,date)
TO service_role;
-- ACC_S3_BODY_END

-- ACC_S3_FINAL_ASSERT_BEGIN
-- Compare catalog meaning (columns, constraint definitions, triggers, ACL entries, has_*_privilege, function
-- attributes), never ACL text serialization.
DO $acc_s3_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_baseline jsonb;
  v_tables CONSTANT text[] := ARRAY['accounting_settings', 'accounting_opening_balances'];
  e record;
  p record;
  v_oid oid;
BEGIN
  -- Catalog text (pg_get_expr, pg_get_constraintdef, format_type) depends on the caller's search_path: with
  -- extensions ahead of pg_catalog (the Supabase default) a built-in such as gen_random_uuid() prints as
  -- pg_catalog.gen_random_uuid(). Pin an empty search_path for this block (transaction local); it is put back below,
  -- and an error rolls it back with the block.
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s3_settings_row';
  -- acc_s3_settings_row: the two tables (owner, columns, constraints: exactly these CHECK / PRIMARY KEY / FOREIGN KEY,
  -- validated, not deferrable), exactly one settings row (the fresh one at apply time, the pinned one on a replay) and
  -- the opening rows of the baseline (none at apply time).
  IF EXISTS (SELECT 1 FROM (VALUES
    ('accounting_settings', 'id smallint not null, business_start_date date, cutover_on date not null, current_business_type text not null default ''soleProprietor''::text, sole_business_ended_on date, sole_end_changes jsonb not null default ''[]''::jsonb, version bigint not null default 1, updated_by uuid, updated_at timestamp with time zone, admin_requests jsonb not null default ''{}''::jsonb'),
    ('accounting_opening_balances', 'period_id uuid not null, account_code text not null, signed_amount bigint not null, closing_version integer not null default 1, source text not null, source_period_id uuid')
  ) AS t(name, columns)
  LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
  WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> 'postgres'::regrole
    OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
          || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM t.columns) THEN
    v_failed := 'acc_s3_settings_row';
  END IF;
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
      ('accounting_settings', 'accounting_settings_admin_requests_check', 'c', 'CHECK ((jsonb_typeof(admin_requests) = ''object''::text))'),
      ('accounting_settings', 'accounting_settings_current_business_type_check', 'c', 'CHECK ((current_business_type = ANY (ARRAY[''soleProprietor''::text, ''corporation''::text])))'),
      ('accounting_settings', 'accounting_settings_id_check', 'c', 'CHECK ((id = 1))'),
      ('accounting_settings', 'accounting_settings_pkey', 'p', 'id'),
      ('accounting_settings', 'accounting_settings_sole_end_changes_check', 'c', 'CHECK ((jsonb_typeof(sole_end_changes) = ''array''::text))'),
      ('accounting_settings', 'accounting_settings_version_check', 'c', 'CHECK ((version >= 1))'),
      ('accounting_opening_balances', 'accounting_opening_balances_account_code_fkey', 'f', 'account_code>public.accounting_accounts(code)ras'),
      ('accounting_opening_balances', 'accounting_opening_balances_closing_version_check', 'c', 'CHECK ((closing_version >= 1))'),
      ('accounting_opening_balances', 'accounting_opening_balances_period_id_fkey', 'f', 'period_id>public.accounting_periods(id)ras'),
      ('accounting_opening_balances', 'accounting_opening_balances_pkey', 'p', 'period_id,closing_version,account_code'),
      ('accounting_opening_balances', 'accounting_opening_balances_source_check', 'c', 'CHECK ((source = ANY (ARRAY[''initial''::text, ''closing_carryover''::text])))'),
      ('accounting_opening_balances', 'accounting_opening_balances_source_period_id_fkey', 'f', 'source_period_id>public.accounting_periods(id)ras')
      ) AS x(table_name, name, kind, definition)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
        WHERE c.conrelid = pg_catalog.to_regclass('public.' || x.table_name) AND c.conname = x.name
          AND c.contype = x.kind::"char" AND c.convalidated AND NOT c.condeferrable
          AND CASE WHEN c.contype = 'c' THEN pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
            ELSE (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
                FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
                JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.num)
              || CASE WHEN c.contype = 'f' THEN '>'
                || (SELECT n.nspname::text || '.' || r.relname::text FROM pg_catalog.pg_class AS r
                  JOIN pg_catalog.pg_namespace AS n ON n.oid = r.relnamespace WHERE r.oid = c.confrelid)
                || '(' || (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
                  FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
                  JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.confrelid AND a.attnum = k.num) || ')'
                || c.confdeltype::text || c.confupdtype::text || c.confmatchtype::text
              ELSE '' END
            END = x.definition))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid IN (SELECT pg_catalog.to_regclass('public.' || t) FROM pg_catalog.unnest(v_tables) AS t)
        AND c.contype IN ('c', 'p', 'u', 'f', 'x')) <> 12) THEN
    v_failed := 'acc_s3_settings_row';
  END IF;
  IF v_failed IS NULL THEN
    IF pg_catalog.to_regclass('pg_temp.accounting_s3_baseline') IS NULL
      OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s3_baseline) <> 1 THEN
      v_failed := 'acc_s3_settings_row';
    ELSE
      SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s3_baseline AS b;
      IF (SELECT pg_catalog.count(*) FROM public.accounting_settings) <> 1
        OR (v_baseline -> 'settings' = 'null'::jsonb AND NOT EXISTS (SELECT 1 FROM public.accounting_settings AS s
          WHERE s.id = 1 AND s.business_start_date IS NULL
            AND s.cutover_on = private.accounting_jst_date(pg_catalog.now())
            AND s.current_business_type = 'soleProprietor' AND s.sole_business_ended_on IS NULL
            AND s.sole_end_changes = '[]'::jsonb AND s.version = 1 AND s.updated_by IS NULL AND s.updated_at IS NULL
            AND s.admin_requests = '{}'::jsonb))
        OR (v_baseline -> 'settings' IS DISTINCT FROM 'null'::jsonb
          AND (SELECT pg_catalog.to_jsonb(s) FROM public.accounting_settings AS s) IS DISTINCT FROM v_baseline -> 'settings')
        OR (SELECT pg_catalog.count(*) FROM public.accounting_opening_balances)
          IS DISTINCT FROM (v_baseline ->> 'opening_rows')::bigint THEN
        v_failed := 'acc_s3_settings_row';
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s3_period_layout_trigger';
  -- acc_s3_period_layout_trigger: exactly these triggers on the periods, the settings and the opening balances (the
  -- deferred checks ordinary, the guards and refusals ALWAYS), the layout check calls the S2 layout and the end-day
  -- check, the two guard bodies have the fingerprints below, and the trigger functions are SECURITY DEFINER.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM (VALUES
      ('accounting_periods', 'accounting_periods_layout', 'private.accounting_check_period_layout()', 5, 'O', true),
      ('accounting_periods', 'accounting_periods_guard_update', 'private.accounting_guard_period_update()', 19, 'A', false),
      ('accounting_periods', 'accounting_periods_no_delete', 'private.reject_accounting_mutation()', 11, 'A', false),
      ('accounting_periods', 'accounting_periods_no_truncate', 'private.reject_accounting_mutation()', 34, 'A', false),
      ('accounting_settings', 'accounting_settings_sole_end', 'private.accounting_check_sole_end_matches_period()', 21, 'O', true),
      ('accounting_settings', 'accounting_settings_guard_update', 'private.accounting_guard_settings_update()', 19, 'A', false),
      ('accounting_settings', 'accounting_settings_no_delete', 'private.reject_accounting_mutation()', 11, 'A', false),
      ('accounting_settings', 'accounting_settings_no_truncate', 'private.reject_accounting_mutation()', 34, 'A', false),
      ('accounting_opening_balances', 'accounting_opening_balances_no_update_delete', 'private.reject_accounting_mutation()', 27, 'A', false),
      ('accounting_opening_balances', 'accounting_opening_balances_no_truncate', 'private.reject_accounting_mutation()', 34, 'A', false)
      ) AS x(table_name, name, fn, kind, enabled, deferred)
      JOIN pg_catalog.pg_trigger AS g ON g.tgrelid = pg_catalog.to_regclass('public.' || x.table_name)
        AND g.tgname::text = x.name AND g.tgfoid = pg_catalog.to_regprocedure(x.fn) AND g.tgtype = x.kind
        AND g.tgenabled = x.enabled::"char" AND NOT g.tgisinternal AND (g.tgconstraint <> 0) = x.deferred
        AND g.tgdeferrable = x.deferred AND g.tginitdeferred = x.deferred AND g.tgnargs = 0 AND g.tgqual IS NULL
        AND pg_catalog.cardinality(g.tgattr::int2[]) = 0) <> 10
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g WHERE NOT g.tgisinternal
      AND g.tgrelid IN ('public.accounting_periods'::regclass, 'public.accounting_settings'::regclass,
        'public.accounting_opening_balances'::regclass)) <> 10
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = 'private.accounting_check_period_layout()'::regprocedure
        AND pg_catalog.strpos(f.prosrc, 'PERFORM private.accounting_assert_period_layout(NEW.business_type);') > 0
        AND pg_catalog.strpos(f.prosrc, 'PERFORM private.accounting_assert_sole_end();') > 0)
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = 'private.accounting_check_sole_end_matches_period()'::regprocedure
        AND pg_catalog.strpos(f.prosrc, 'PERFORM private.accounting_assert_sole_end();') > 0)
    -- The two guard bodies are fingerprinted (md5 of the body with CR removed, as S0 does).
    OR (SELECT pg_catalog.count(*) FROM (VALUES
        ('private.accounting_guard_period_update()', '1c9a9f8b0bf9df4661b22a739ece9a90'),
        ('private.accounting_guard_settings_update()', '61e9299c4c7c27a1ce37d18cf7aa8bf1')
      ) AS b(fn, body_md5) JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(b.fn)
      WHERE pg_catalog.md5(pg_catalog.replace(f.prosrc, E'\r', '')) = b.body_md5) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['private.accounting_check_period_layout()',
        'private.accounting_guard_period_update()', 'private.accounting_guard_settings_update()',
        'private.accounting_check_sole_end_matches_period()']) AS t(fn)
      JOIN pg_catalog.pg_proc AS f ON f.oid = pg_catalog.to_regprocedure(t.fn)
      WHERE NOT f.prosecdef OR f.proowner <> 'postgres'::regrole OR f.prorettype <> 'trigger'::regtype
        OR f.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[])
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.unnest(ARRAY['private.accounting_check_period_layout()',
        'private.accounting_guard_period_update()', 'private.accounting_guard_settings_update()',
        'private.accounting_check_sole_end_matches_period()']) AS t(fn)
      WHERE pg_catalog.to_regprocedure(t.fn) IS NOT NULL) <> 4) THEN
    v_failed := 'acc_s3_period_layout_trigger';
  END IF;

  v_stage := 'acc_s3_rls_acl';
  -- acc_s3_rls_acl: RLS on and no policy; PUBLIC, anon and authenticated hold nothing (table or column);
  -- service_role holds SELECT and nothing else.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(name)
    JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
    WHERE NOT c.relrowsecurity
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = c.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
          OR (acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type <> 'SELECT'))
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
        WHERE acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type = 'SELECT')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
        WHERE pg_catalog.has_table_privilege(r.role, c.oid, q.privilege))
      OR pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
      OR pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
      OR NOT pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')) THEN
    v_failed := 'acc_s3_rls_acl';
  END IF;

  -- acc_s3_functions (writers, tools, helpers) and acc_s3_reads_stable (the five reads): owner, SECURITY,
  -- volatility, language, result, set-returning, argument names and defaults, search_path, EXECUTE (service_role only
  -- where marked), one function per name, and each public entry delegates to the private body of the same name.
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('acc_s3_functions', 'private', 'accounting_request_hash(jsonb)', true, 'i', 'sql', 'text', false, '_body', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_period_json(uuid)', true, 's', 'sql', 'jsonb', false, '_id', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_request_replay(uuid,text)', true, 's', 'plpgsql', 'jsonb', false, '_request_key,_hash', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_default_period_name(text,date)', true, 's', 'sql', 'text', false, '_business_type,_starts_on', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_assert_sole_end()', true, 'v', 'plpgsql', 'void', false, '', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_check_period_layout()', true, 'v', 'plpgsql', 'trigger', false, '', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_guard_period_update()', true, 'v', 'plpgsql', 'trigger', false, '', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_guard_settings_update()', true, 'v', 'plpgsql', 'trigger', false, '', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_check_sole_end_matches_period()', true, 'v', 'plpgsql', 'trigger', false, '', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_ensure_individual_periods(integer,uuid)', true, 'v', 'plpgsql', 'uuid', true, '_year,_actor_id', '', 0, false),
      ('acc_s3_functions', 'private', 'accounting_period_for_event(date,uuid)', true, 'v', 'plpgsql', 'uuid', false, '_date,_actor_id', '', 1, false),
      ('acc_s3_functions', 'private', 'accounting_store_opening(uuid,uuid,jsonb,integer,text,uuid)', true, 'v', 'plpgsql', 'integer', false,
        '_actor_id,_period_id,_rows,_closing_version,_source,_source_period_id', '', 0, true),
      ('acc_s3_functions', 'private', 'admin_create_accounting_period(uuid,text,date,date,text,uuid)', true, 'v', 'plpgsql', 'jsonb', false,
        '_actor_id,_business_type,_starts_on,_ends_on,_name,_request_key', '', 0, true),
      ('acc_s3_functions', 'private', 'admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid)', true, 'v', 'plpgsql', 'jsonb', false,
        '_actor_id,_period_id,_ended_on,_expected_period_version,_expected_settings_version,_reason,_request_key', '', 0, true),
      ('acc_s3_functions', 'private', 'admin_update_accounting_settings(uuid,date,text,bigint,uuid)', true, 'v', 'plpgsql', 'jsonb', false,
        '_actor_id,_business_start_date,_current_business_type,_expected_version,_request_key', '', 0, true),
      ('acc_s3_functions', 'private', 'admin_update_accounting_period_filing(uuid,uuid,smallint,smallint,text,date,bigint,uuid)', true, 'v', 'plpgsql', 'jsonb', false,
        '_actor_id,_period_id,_corporate_tax_extension_months,_consumption_tax_extension_months,_consumption_tax_status,_consumption_taxable_from,_expected_version,_request_key', '', 0, true),
      ('acc_s3_functions', 'public', 'admin_create_accounting_period(uuid,text,date,date,text,uuid)', false, 'v', 'sql', 'jsonb', false,
        '_actor_id,_business_type,_starts_on,_ends_on,_name,_request_key', 'select', 0, true),
      ('acc_s3_functions', 'public', 'admin_shorten_final_sole_period(uuid,uuid,date,bigint,bigint,text,uuid)', false, 'v', 'sql', 'jsonb', false,
        '_actor_id,_period_id,_ended_on,_expected_period_version,_expected_settings_version,_reason,_request_key', 'select', 0, true),
      ('acc_s3_functions', 'public', 'admin_update_accounting_settings(uuid,date,text,bigint,uuid)', false, 'v', 'sql', 'jsonb', false,
        '_actor_id,_business_start_date,_current_business_type,_expected_version,_request_key', 'select', 0, true),
      ('acc_s3_functions', 'public', 'admin_update_accounting_period_filing(uuid,uuid,smallint,smallint,text,date,bigint,uuid)', false, 'v', 'sql', 'jsonb', false,
        '_actor_id,_period_id,_corporate_tax_extension_months,_consumption_tax_extension_months,_consumption_tax_status,_consumption_taxable_from,_expected_version,_request_key', 'select', 0, true),
      ('acc_s3_reads_stable', 'private', 'accounting_opening_balances(uuid)', true, 's', 'plpgsql', 'record', true, '_period_id,account_code,signed_amount,basis', '', 0, false),
      ('acc_s3_reads_stable', 'private', 'get_accounting_settings()', true, 's', 'sql', 'jsonb', false, '', '', 0, true),
      ('acc_s3_reads_stable', 'private', 'list_accounting_periods()', true, 's', 'sql', 'jsonb', true, '', '', 0, true),
      ('acc_s3_reads_stable', 'private', 'get_accounting_opening(uuid)', true, 's', 'sql', 'record', true, '_period_id,account_code,signed_amount,basis', '', 0, true),
      ('acc_s3_reads_stable', 'private', 'list_accounting_journal(uuid,date,date,integer,date,bigint)', true, 's', 'plpgsql', 'jsonb', false,
        '_period_id,_from,_to,_limit,_after_entry_date,_after_entry_no', '', 5, true),
      ('acc_s3_reads_stable', 'private', 'get_accounting_trial_balance(uuid,date)', true, 's', 'sql', 'record', true,
        '_period_id,_through,account_code,debit_total,credit_total,opening_signed', '', 1, true),
      ('acc_s3_reads_stable', 'public', 'get_accounting_settings()', false, 's', 'sql', 'jsonb', false, '', 'select', 0, true),
      ('acc_s3_reads_stable', 'public', 'list_accounting_periods()', false, 's', 'sql', 'jsonb', true, '', 'select', 0, true),
      ('acc_s3_reads_stable', 'public', 'get_accounting_opening(uuid)', false, 's', 'sql', 'record', true, '_period_id,account_code,signed_amount,basis', 'select*from', 0, true),
      ('acc_s3_reads_stable', 'public', 'list_accounting_journal(uuid,date,date,integer,date,bigint)', false, 's', 'sql', 'jsonb', false,
        '_period_id,_from,_to,_limit,_after_entry_date,_after_entry_no', 'select', 5, true),
      ('acc_s3_reads_stable', 'public', 'get_accounting_trial_balance(uuid,date)', false, 's', 'sql', 'record', true,
        '_period_id,_through,account_code,debit_total,credit_total,opening_signed', 'select*from', 1, true)
    ) AS x(detail, schema_name, signature, definer, volatility, language, result_type, retset, arg_names, delegate, defaults, service)
    LOOP
      v_stage := e.detail;
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      IF v_oid IS NULL THEN v_failed := e.detail; EXIT; END IF;
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = v_oid;
      IF p.proowner <> 'postgres'::regrole OR p.prosecdef IS DISTINCT FROM e.definer
        OR p.provolatile <> e.volatility::"char" OR p.lanname <> e.language
        OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset IS DISTINCT FROM e.retset
        OR p.prokind <> 'f' OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames, ','), '') <> e.arg_names
        OR p.pronargdefaults <> e.defaults
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) <> 1
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') IS DISTINCT FROM e.service
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        OR (e.schema_name = 'public' AND pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:];]', '', 'g')
          <> e.delegate || 'private.' || p.proname::text || '('
            || COALESCE(pg_catalog.array_to_string(p.proargnames[1:p.pronargs], ','), '') || ')') THEN
        v_failed := e.detail; EXIT;
      END IF;
    END LOOP;
  END IF;
  v_stage := 'acc_s3_functions';
  -- The reversal core (S2 body) is still one function and finds a missing sole period with
  -- accounting_ensure_individual_periods, never with accounting_period_for_event; nothing named accounting_* is public.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS f
      WHERE f.pronamespace = 'private'::regnamespace AND f.proname = 'accounting_reverse_journal_core') <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = pg_catalog.to_regprocedure('private.accounting_reverse_journal_core(uuid,uuid,text,date,timestamptz)')
        AND pg_catalog.strpos(f.prosrc, 'v_period_id := private.accounting_period_for(v_date, v_business_type);') > 0
        AND pg_catalog.strpos(f.prosrc, 'PERFORM private.accounting_ensure_individual_periods(') > 0
        AND pg_catalog.strpos(f.prosrc, 'accounting_period_for_event') = 0)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.pronamespace = 'public'::regnamespace AND f.proname LIKE 'accounting\_%')) THEN
    v_failed := 'acc_s3_functions';
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
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s3_settings_row'), HINT = SQLSTATE;
END;
$acc_s3_final$;
-- ACC_S3_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
