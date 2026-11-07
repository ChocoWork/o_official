BEGIN;
-- Accounting plan 1 S2 (FREQ-554 AC-01..AC-10): the saved journal. One function writes the header and its lines in
-- one go; the database keeps every entry balanced, one-sided, positive and integral; an event key and a reversal
-- happen once; a saved entry is never rewritten.
--
-- Objects (all owned by postgres):
--   public.accounting_accounts          account codes (names stay in src/lib/finance/accounts.ts, the source of truth)
--   public.accounting_periods           accounting periods (overlap / gap / length are checked by
--                                       private.accounting_assert_period_layout; S3 adds the deferred trigger)
--   public.accounting_period_sequences  the last entry number of each period (only the numbering updates it)
--   public.accounting_journal_entries   saved headers (append only)
--   public.accounting_journal_lines     saved lines (append only)
-- Every table has RLS on and no policy; PUBLIC, anon and authenticated hold nothing; service_role holds SELECT only.
-- Writes go through private functions:
--   private.accounting_post_journal_core      the single writer (no permission check, no entry point)
--   private.admin_post_accounting_journal     admin.finance.manage, then the core; public entry of the same name
--   private.accounting_reverse_journal_core   swaps debit and credit of the original and calls the core
--   private.admin_reverse_accounting_journal  admin.finance.manage, then the reversal core; public entry too
-- Lock order of every writer: (190521,1) -> (190525,0) -> (190525, hashtext(period_id)) -> rows
-- (private.accounting_lock_all). The accounting namespace is 190525 (the number below it is the group H discount lock).
-- The core checks the balance and the period layout before it returns, so a caller can catch the failure inside its
-- own exception block; the deferred constraint triggers on the two journal tables stay as the second gate.
-- The account rows between ACC_ACCOUNTS_BEGIN/END are the output of scripts/accounting/emit-accounts-seed.ts.
--
-- ROLLBACK (only while no entry exists; entries cannot be deleted once written):
--   DROP FUNCTION public.admin_reverse_accounting_journal(uuid,uuid,text,date),
--     public.admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text),
--     private.admin_reverse_accounting_journal(uuid,uuid,text,date),
--     private.accounting_reverse_journal_core(uuid,uuid,text,date,timestamptz),
--     private.admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text),
--     private.accounting_post_journal_core(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text,timestamptz,text,timestamptz);
--   DROP TABLE public.accounting_journal_lines, public.accounting_journal_entries, public.accounting_period_sequences,
--     public.accounting_periods, public.accounting_accounts;
--   then drop the remaining private.accounting_* helpers and private.reject_accounting_mutation().

-- ACC_S2_BODY_BEGIN

-- 0. The baseline the final assert compares with: before this migration nothing exists, so no period, number, entry
--    or line and no account other than the S2 seed. A replay of the assert (tests) pins the current state here first
--    (withAccountingS2Baseline), so later migrations that add accounts or entries do not break it.
CREATE TEMP TABLE accounting_s2_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s2_baseline(payload)
VALUES ('{"periods": 0, "sequences": 0, "entries": 0, "lines": 0, "other_accounts": []}'::jsonb);

-- 1. Event kinds, arity and event keys. The same 27 kinds, arity and key strings as
--    src/lib/accounting/event-kinds.ts and event-key.ts (tests compare the two texts).
CREATE FUNCTION private.accounting_event_kinds() RETURNS text[]
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT ARRAY[
    'payment_confirmed',
    'shipment_confirmed',
    'shipment_redated',
    'pre_shipment_refund',
    'return_arrived',
    'return_amount_decided',
    'return_refund',
    'refund_failed',
    'refund_abandoned',
    'stripe_fee',
    'stripe_tax_adjustment',
    'payout_started',
    'bank_arrived',
    'payout_failed',
    'balance_topup',
    'dispute_event',
    'dispute_withdrawn_late',
    'exchange_movement',
    'owner_use',
    'personal_discount',
    'compensation_received',
    'manual_entry',
    'migrated_entry',
    'period_closing_entry',
    'closed_year_correction',
    'return_arrival_redated',
    'reversal'
  ]::text[]
$$;

-- The number of key parts of each kind; NULL for an unknown kind.
CREATE FUNCTION private.accounting_event_arity(_kind text) RETURNS integer
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT a.arity FROM (VALUES
    ('payment_confirmed', 1),
    ('shipment_confirmed', 1),
    ('shipment_redated', 1),
    ('pre_shipment_refund', 1),
    ('return_arrived', 1),
    ('return_amount_decided', 1),
    ('return_refund', 1),
    ('refund_failed', 2),
    ('refund_abandoned', 2),
    ('stripe_fee', 1),
    ('stripe_tax_adjustment', 1),
    ('payout_started', 1),
    ('bank_arrived', 1),
    ('payout_failed', 1),
    ('balance_topup', 1),
    ('dispute_event', 3),
    ('dispute_withdrawn_late', 2),
    ('exchange_movement', 1),
    ('owner_use', 1),
    ('personal_discount', 2),
    ('compensation_received', 1),
    ('manual_entry', 2),
    ('migrated_entry', 1),
    ('period_closing_entry', 3),
    ('closed_year_correction', 3),
    ('return_arrival_redated', 1),
    ('reversal', 1)
  ) AS a(kind, arity)
  WHERE a.kind = _kind
$$;

-- <prefix>:<part>[:<part>...]; the prefix is the kind, except stripe_fee which is stripe:fee (design 1-a10).
-- Each part matches ^[A-Za-z0-9_.-]{1,128}$ (no ':'), and the number of parts is the arity of the kind.
CREATE FUNCTION private.accounting_event_key(_kind text, _parts text[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_arity integer := private.accounting_event_arity(_kind);
BEGIN
  IF v_arity IS NULL OR _parts IS NULL OR pg_catalog.array_ndims(_parts) IS DISTINCT FROM 1
    OR pg_catalog.cardinality(_parts) <> v_arity
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(_parts) AS p(part)
      WHERE p.part IS NULL OR p.part !~ '^[A-Za-z0-9_.-]{1,128}$') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN (CASE WHEN _kind = 'stripe_fee' THEN 'stripe:fee' ELSE _kind END) || ':'
    || pg_catalog.array_to_string(_parts, ':');
END;
$$;

-- The one-year rule of src/lib/accounting/period.ts (validateNewPeriod): ends_on < starts_on + 1 year; a period that
-- starts on 29 February may also end on 28 February of the next year. The period CHECK, the layout check below and the
-- S3 deferred trigger all call this one function.
CREATE FUNCTION private.accounting_period_length_ok(_starts_on date, _ends_on date) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT _ends_on < (_starts_on + interval '1 year')::date
    OR (EXTRACT(month FROM _starts_on) = 2 AND EXTRACT(day FROM _starts_on) = 29
      AND _ends_on = (_starts_on + interval '1 year')::date)
$$;

-- The calendar day in Japan of an instant (design 1-e; the same day as toJstDate in src/lib/accounting/jst-date.ts).
CREATE FUNCTION private.accounting_jst_date(_at timestamptz) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT (_at AT TIME ZONE 'Asia/Tokyo')::date
$$;

-- 2. Tables.
CREATE TABLE public.accounting_accounts (
  code text NOT NULL,
  account_type text NOT NULL,
  normal_side text NOT NULL,
  scope text NOT NULL,
  carryover_role text NOT NULL,
  CONSTRAINT accounting_accounts_pkey PRIMARY KEY (code),
  CONSTRAINT accounting_accounts_code_check CHECK (code ~ '^[0-9]{4}$'),
  CONSTRAINT accounting_accounts_account_type_check
    CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  CONSTRAINT accounting_accounts_normal_side_check CHECK (normal_side IN ('debit', 'credit')),
  CONSTRAINT accounting_accounts_scope_check CHECK (scope IN ('common', 'soleProprietor', 'corporation')),
  CONSTRAINT accounting_accounts_carryover_role_check
    CHECK (carryover_role IN ('carry', 'capital_sole', 'owner_draw', 'owner_contribution', 'retained_corp', 'pl_zero'))
);

CREATE TABLE public.accounting_periods (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  business_type text NOT NULL,
  name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  corporate_tax_extension_months smallint NOT NULL DEFAULT 0,
  consumption_tax_extension_months smallint NOT NULL DEFAULT 0,
  consumption_tax_status text NOT NULL DEFAULT 'exempt',
  consumption_taxable_from date NULL,
  version bigint NOT NULL DEFAULT 1,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL,
  updated_at timestamptz NULL,
  creation_request_key uuid NULL,
  creation_request_hash text NULL,
  admin_requests jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy_fiscal_year integer NULL,
  CONSTRAINT accounting_periods_pkey PRIMARY KEY (id),
  CONSTRAINT accounting_periods_creation_request_key_key UNIQUE (creation_request_key),
  CONSTRAINT accounting_periods_legacy_fiscal_year_key UNIQUE (legacy_fiscal_year),
  CONSTRAINT accounting_periods_business_type_check CHECK (business_type IN ('soleProprietor', 'corporation')),
  CONSTRAINT accounting_periods_name_check CHECK (char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT accounting_periods_range_check CHECK (starts_on <= ends_on),
  CONSTRAINT accounting_periods_length_check CHECK (private.accounting_period_length_ok(starts_on, ends_on)),
  CONSTRAINT accounting_periods_sole_calendar_check CHECK (business_type <> 'soleProprietor'
    OR (EXTRACT(month FROM starts_on) = 1 AND EXTRACT(day FROM starts_on) = 1
      AND EXTRACT(year FROM ends_on) = EXTRACT(year FROM starts_on))),
  CONSTRAINT accounting_periods_corporate_tax_extension_check CHECK (corporate_tax_extension_months BETWEEN 0 AND 1),
  CONSTRAINT accounting_periods_consumption_tax_extension_check CHECK (consumption_tax_extension_months BETWEEN 0 AND 1),
  CONSTRAINT accounting_periods_consumption_extension_check
    CHECK (consumption_tax_extension_months <= corporate_tax_extension_months),
  CONSTRAINT accounting_periods_consumption_tax_status_check CHECK (consumption_tax_status IN ('exempt', 'taxable')),
  CONSTRAINT accounting_periods_taxable_from_presence_check
    CHECK ((consumption_tax_status = 'exempt') = (consumption_taxable_from IS NULL)),
  CONSTRAINT accounting_periods_taxable_from_range_check CHECK (consumption_taxable_from BETWEEN starts_on AND ends_on)
);

CREATE TABLE public.accounting_period_sequences (
  period_id uuid NOT NULL,
  last_entry_no bigint NOT NULL DEFAULT 0,
  CONSTRAINT accounting_period_sequences_pkey PRIMARY KEY (period_id),
  CONSTRAINT accounting_period_sequences_period_id_fkey FOREIGN KEY (period_id)
    REFERENCES public.accounting_periods (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_period_sequences_last_entry_no_check CHECK (last_entry_no >= 0)
);

-- recorded_at, entry_no and is_late are decided by the core only (no entry point takes them).
CREATE TABLE public.accounting_journal_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL,
  entry_no bigint NOT NULL,
  entry_date date NOT NULL,
  event_kind text NOT NULL,
  dedupe_key text NOT NULL,
  content_hash text NOT NULL,
  description text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source_recorded_at timestamptz NULL,
  recorded_by uuid NULL,
  is_late boolean NOT NULL DEFAULT false,
  reverses_entry_id uuid NULL,
  reason text NULL,
  source_table text NULL,
  source_id text NULL,
  migrated_from text NULL,
  migrated_at timestamptz NULL,
  CONSTRAINT accounting_journal_entries_pkey PRIMARY KEY (id),
  CONSTRAINT accounting_journal_entries_period_id_fkey FOREIGN KEY (period_id)
    REFERENCES public.accounting_periods (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_entries_period_entry_no_key UNIQUE (period_id, entry_no),
  CONSTRAINT accounting_journal_entries_dedupe_key_key UNIQUE (dedupe_key),
  CONSTRAINT accounting_journal_entries_reverses_entry_id_key UNIQUE (reverses_entry_id),
  CONSTRAINT accounting_journal_entries_reverses_entry_id_fkey FOREIGN KEY (reverses_entry_id)
    REFERENCES public.accounting_journal_entries (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_entries_entry_no_check CHECK (entry_no >= 1),
  CONSTRAINT accounting_journal_entries_event_kind_check CHECK (event_kind = ANY (private.accounting_event_kinds())),
  CONSTRAINT accounting_journal_entries_description_check CHECK (char_length(description) <= 500),
  CONSTRAINT accounting_journal_entries_source_recorded_at_check
    CHECK (source_recorded_at IS NULL OR source_recorded_at <= recorded_at),
  CONSTRAINT accounting_journal_entries_reversal_check CHECK (CASE WHEN event_kind = 'reversal'
    THEN reverses_entry_id IS NOT NULL AND reason IS NOT NULL
    ELSE reverses_entry_id IS NULL AND reason IS NULL END)
);
CREATE INDEX accounting_journal_entries_period_date_no_idx
  ON public.accounting_journal_entries (period_id, entry_date, entry_no);
CREATE INDEX accounting_journal_entries_source_idx ON public.accounting_journal_entries (source_table, source_id);

CREATE TABLE public.accounting_journal_lines (
  entry_id uuid NOT NULL,
  line_no smallint NOT NULL,
  account_code text NOT NULL,
  debit bigint NOT NULL DEFAULT 0,
  credit bigint NOT NULL DEFAULT 0,
  sub_account text NULL,
  counterparty text NULL,
  order_id uuid NULL,
  memo text NULL,
  CONSTRAINT accounting_journal_lines_pkey PRIMARY KEY (entry_id, line_no),
  CONSTRAINT accounting_journal_lines_entry_id_fkey FOREIGN KEY (entry_id)
    REFERENCES public.accounting_journal_entries (id) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_lines_account_code_fkey FOREIGN KEY (account_code)
    REFERENCES public.accounting_accounts (code) ON DELETE RESTRICT,
  CONSTRAINT accounting_journal_lines_line_no_check CHECK (line_no BETWEEN 1 AND 200),
  CONSTRAINT accounting_journal_lines_debit_check CHECK (debit >= 0),
  CONSTRAINT accounting_journal_lines_credit_check CHECK (credit >= 0),
  CONSTRAINT accounting_journal_lines_sub_account_check CHECK (sub_account ~ '^[a-z0-9_:.-]{1,64}$')
);

ALTER TABLE public.accounting_accounts OWNER TO postgres;
ALTER TABLE public.accounting_periods OWNER TO postgres;
ALTER TABLE public.accounting_period_sequences OWNER TO postgres;
ALTER TABLE public.accounting_journal_entries OWNER TO postgres;
ALTER TABLE public.accounting_journal_lines OWNER TO postgres;
ALTER TABLE public.accounting_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_period_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_journal_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.accounting_accounts, public.accounting_periods, public.accounting_period_sequences,
  public.accounting_journal_entries, public.accounting_journal_lines
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
  public.accounting_accounts, public.accounting_periods, public.accounting_period_sequences,
  public.accounting_journal_entries, public.accounting_journal_lines
TO service_role;

-- 3. The account list (FREQ-554-AC-06): 162 accounts of ACCOUNTS plus the fallback 9999. Later migrations only add.
-- ACC_ACCOUNTS_BEGIN
INSERT INTO public.accounting_accounts (code,account_type,normal_side,scope,carryover_role) VALUES
  ('1010','asset','debit','common','carry'),
  ('1020','asset','debit','common','carry'),
  ('1030','asset','debit','common','carry'),
  ('1040','asset','debit','common','carry'),
  ('1050','asset','debit','common','carry'),
  ('1060','asset','debit','common','carry'),
  ('1070','asset','debit','common','carry'),
  ('1080','asset','debit','common','carry'),
  ('1110','asset','debit','common','carry'),
  ('1120','asset','debit','common','carry'),
  ('1130','asset','debit','common','carry'),
  ('1140','asset','debit','common','carry'),
  ('1150','asset','debit','common','carry'),
  ('1160','asset','debit','common','carry'),
  ('1210','asset','debit','common','carry'),
  ('1310','asset','debit','common','carry'),
  ('1320','asset','debit','common','carry'),
  ('1330','asset','debit','common','carry'),
  ('1340','asset','debit','common','carry'),
  ('1350','asset','debit','common','carry'),
  ('1410','asset','debit','common','carry'),
  ('1420','asset','debit','common','carry'),
  ('1430','asset','debit','common','carry'),
  ('1440','asset','debit','common','carry'),
  ('1450','asset','debit','common','carry'),
  ('1460','asset','debit','common','carry'),
  ('1470','asset','debit','common','carry'),
  ('1480','asset','debit','common','carry'),
  ('1490','asset','debit','corporation','carry'),
  ('1510','asset','debit','common','carry'),
  ('1515','asset','debit','common','carry'),
  ('1520','asset','debit','common','carry'),
  ('1525','asset','debit','common','carry'),
  ('1530','asset','debit','common','carry'),
  ('1535','asset','debit','common','carry'),
  ('1540','asset','debit','common','carry'),
  ('1545','asset','debit','common','carry'),
  ('1550','asset','debit','common','carry'),
  ('1555','asset','debit','common','carry'),
  ('1560','asset','debit','common','carry'),
  ('1570','asset','debit','common','carry'),
  ('1590','asset','credit','common','carry'),
  ('1610','asset','debit','common','carry'),
  ('1615','asset','debit','common','carry'),
  ('1620','asset','debit','common','carry'),
  ('1625','asset','debit','common','carry'),
  ('1630','asset','debit','common','carry'),
  ('1635','asset','debit','common','carry'),
  ('1640','asset','debit','corporation','carry'),
  ('1650','asset','debit','common','carry'),
  ('1660','asset','debit','common','carry'),
  ('1670','asset','debit','common','carry'),
  ('1680','asset','debit','common','carry'),
  ('1710','asset','debit','common','carry'),
  ('1715','asset','debit','common','carry'),
  ('1720','asset','debit','common','carry'),
  ('1730','asset','debit','common','carry'),
  ('1740','asset','debit','common','carry'),
  ('1750','asset','debit','common','carry'),
  ('1760','asset','debit','common','carry'),
  ('1770','asset','debit','corporation','carry'),
  ('1810','asset','debit','common','carry'),
  ('1820','asset','debit','corporation','carry'),
  ('1830','asset','debit','common','carry'),
  ('1840','asset','debit','corporation','carry'),
  ('1910','asset','debit','soleProprietor','owner_draw'),
  ('1920','asset','debit','soleProprietor','owner_draw'),
  ('1990','asset','debit','common','carry'),
  ('2010','liability','credit','common','carry'),
  ('2020','liability','credit','common','carry'),
  ('2030','liability','credit','common','carry'),
  ('2110','liability','credit','common','carry'),
  ('2120','liability','credit','corporation','carry'),
  ('2130','liability','credit','common','carry'),
  ('2140','liability','credit','common','carry'),
  ('2150','liability','credit','common','carry'),
  ('2160','liability','credit','common','carry'),
  ('2170','liability','credit','common','carry'),
  ('2180','liability','credit','common','carry'),
  ('2190','liability','credit','common','carry'),
  ('2200','liability','credit','corporation','carry'),
  ('2210','liability','credit','corporation','carry'),
  ('2220','liability','credit','common','carry'),
  ('2230','liability','credit','common','carry'),
  ('2240','liability','credit','common','carry'),
  ('2250','liability','credit','corporation','carry'),
  ('2260','liability','credit','common','carry'),
  ('2510','liability','credit','common','carry'),
  ('2520','liability','credit','corporation','carry'),
  ('2530','liability','credit','corporation','carry'),
  ('2540','liability','credit','common','carry'),
  ('2910','equity','credit','soleProprietor','capital_sole'),
  ('2920','equity','credit','soleProprietor','owner_contribution'),
  ('3010','equity','credit','corporation','carry'),
  ('3020','equity','credit','corporation','carry'),
  ('3030','equity','credit','corporation','carry'),
  ('3040','equity','credit','corporation','retained_corp'),
  ('3050','equity','debit','corporation','carry'),
  ('4010','revenue','credit','common','pl_zero'),
  ('4020','revenue','debit','common','pl_zero'),
  ('4030','revenue','credit','soleProprietor','pl_zero'),
  ('4040','revenue','credit','common','pl_zero'),
  ('4050','revenue','credit','common','pl_zero'),
  ('5010','expense','debit','common','pl_zero'),
  ('5015','expense','debit','common','pl_zero'),
  ('5020','expense','debit','common','pl_zero'),
  ('5030','expense','credit','common','pl_zero'),
  ('5040','expense','credit','common','pl_zero'),
  ('5045','expense','credit','common','pl_zero'),
  ('5050','expense','debit','corporation','pl_zero'),
  ('6010','expense','debit','common','pl_zero'),
  ('6020','expense','debit','common','pl_zero'),
  ('6030','expense','debit','common','pl_zero'),
  ('6040','expense','debit','common','pl_zero'),
  ('6050','expense','debit','common','pl_zero'),
  ('6060','expense','debit','common','pl_zero'),
  ('6070','expense','debit','common','pl_zero'),
  ('6080','expense','debit','common','pl_zero'),
  ('6090','expense','debit','common','pl_zero'),
  ('6100','expense','debit','common','pl_zero'),
  ('6110','expense','debit','common','pl_zero'),
  ('6120','expense','debit','common','pl_zero'),
  ('6130','expense','debit','common','pl_zero'),
  ('6140','expense','debit','common','pl_zero'),
  ('6150','expense','debit','common','pl_zero'),
  ('6160','expense','debit','common','pl_zero'),
  ('6170','expense','debit','common','pl_zero'),
  ('6180','expense','debit','common','pl_zero'),
  ('6190','expense','debit','corporation','pl_zero'),
  ('6200','expense','debit','corporation','pl_zero'),
  ('6210','expense','debit','common','pl_zero'),
  ('6220','expense','debit','soleProprietor','pl_zero'),
  ('6230','expense','debit','common','pl_zero'),
  ('6240','expense','debit','soleProprietor','pl_zero'),
  ('6250','expense','debit','common','pl_zero'),
  ('6260','expense','debit','common','pl_zero'),
  ('6270','expense','debit','common','pl_zero'),
  ('6280','expense','debit','common','pl_zero'),
  ('6290','expense','debit','common','pl_zero'),
  ('6300','expense','debit','common','pl_zero'),
  ('6310','expense','debit','common','pl_zero'),
  ('6320','expense','debit','common','pl_zero'),
  ('6330','expense','debit','common','pl_zero'),
  ('6340','expense','debit','common','pl_zero'),
  ('7010','revenue','credit','corporation','pl_zero'),
  ('7020','revenue','credit','corporation','pl_zero'),
  ('7030','revenue','credit','common','pl_zero'),
  ('7040','revenue','credit','common','pl_zero'),
  ('7050','revenue','credit','common','pl_zero'),
  ('7060','revenue','credit','common','pl_zero'),
  ('7510','expense','debit','corporation','pl_zero'),
  ('7520','expense','debit','common','pl_zero'),
  ('7530','expense','debit','common','pl_zero'),
  ('8010','revenue','credit','corporation','pl_zero'),
  ('8020','expense','debit','corporation','pl_zero'),
  ('8030','expense','debit','common','pl_zero'),
  ('8040','expense','debit','common','pl_zero'),
  ('9010','expense','debit','soleProprietor','pl_zero'),
  ('9020','expense','debit','common','pl_zero'),
  ('9030','expense','debit','common','pl_zero'),
  ('9040','expense','debit','soleProprietor','pl_zero'),
  ('9510','expense','debit','corporation','pl_zero'),
  ('9999','expense','debit','common','pl_zero');
-- ACC_ACCOUNTS_END

-- 4. Append only: UPDATE, DELETE and TRUNCATE are refused for every role, the owner included.
CREATE FUNCTION private.reject_accounting_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'ACCOUNTING_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER accounting_accounts_no_update_delete BEFORE UPDATE OR DELETE ON public.accounting_accounts
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_accounts_no_truncate BEFORE TRUNCATE ON public.accounting_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_journal_entries_no_update_delete BEFORE UPDATE OR DELETE ON public.accounting_journal_entries
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_journal_entries_no_truncate BEFORE TRUNCATE ON public.accounting_journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_journal_lines_no_update_delete BEFORE UPDATE OR DELETE ON public.accounting_journal_lines
  FOR EACH ROW EXECUTE FUNCTION private.reject_accounting_mutation();
CREATE TRIGGER accounting_journal_lines_no_truncate BEFORE TRUNCATE ON public.accounting_journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION private.reject_accounting_mutation();
-- ALWAYS: the six reject triggers fire even under session_replication_role = replica (a restore only inserts, so it
-- is not affected). The deferred balance triggers below stay ordinary (fire on origin only): a data-only restore in
-- replica mode may load headers and lines in separate statements or transactions, and the core already checks every
-- entry it writes.
ALTER TABLE public.accounting_accounts ENABLE ALWAYS TRIGGER accounting_accounts_no_update_delete;
ALTER TABLE public.accounting_accounts ENABLE ALWAYS TRIGGER accounting_accounts_no_truncate;
ALTER TABLE public.accounting_journal_entries ENABLE ALWAYS TRIGGER accounting_journal_entries_no_update_delete;
ALTER TABLE public.accounting_journal_entries ENABLE ALWAYS TRIGGER accounting_journal_entries_no_truncate;
ALTER TABLE public.accounting_journal_lines ENABLE ALWAYS TRIGGER accounting_journal_lines_no_update_delete;
ALTER TABLE public.accounting_journal_lines ENABLE ALWAYS TRIGGER accounting_journal_lines_no_truncate;

-- 5. Immediate checks. The core calls both before it returns; the deferred triggers below call the first again.
-- One entry: at least two lines (min_lines), every amount positive (sign), one side per line (one_sided), and the
-- debit total equal to the credit total (balance).
CREATE FUNCTION private.accounting_assert_journal(_entry_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_lines integer;
  v_bad_sign integer;
  v_two_sided integer;
  v_debit numeric;
  v_credit numeric;
BEGIN
  IF _entry_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e WHERE e.id = _entry_id) THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT pg_catalog.count(*)::integer,
    (pg_catalog.count(*) FILTER (WHERE l.debit < 0 OR l.credit < 0 OR (l.debit = 0 AND l.credit = 0)))::integer,
    (pg_catalog.count(*) FILTER (WHERE l.debit > 0 AND l.credit > 0))::integer,
    COALESCE(pg_catalog.sum(l.debit), 0), COALESCE(pg_catalog.sum(l.credit), 0)
  INTO v_lines, v_bad_sign, v_two_sided, v_debit, v_credit
  FROM public.accounting_journal_lines AS l WHERE l.entry_id = _entry_id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'min_lines';
  ELSIF v_bad_sign > 0 THEN
    RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'sign';
  ELSIF v_two_sided > 0 THEN
    RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'one_sided';
  ELSIF v_debit <> v_credit THEN
    RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'balance';
  END IF;
END;
$$;

-- The periods of one business type: every period within the length rule, no two overlapping, and each next period
-- starting the day after the previous one ends (the rules of validateNewPeriod in src/lib/accounting/period.ts).
CREATE FUNCTION private.accounting_assert_period_layout(_business_type text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _business_type IS NULL OR _business_type NOT IN ('soleProprietor', 'corporation') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_periods AS p WHERE p.business_type = _business_type
    AND (p.starts_on > p.ends_on OR NOT private.accounting_period_length_ok(p.starts_on, p.ends_on))) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_TOO_LONG' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_periods AS a JOIN public.accounting_periods AS b
      ON b.business_type = a.business_type AND a.id < b.id AND a.starts_on <= b.ends_on AND b.starts_on <= a.ends_on
    WHERE a.business_type = _business_type) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_OVERLAP' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM (SELECT p.ends_on, pg_catalog.lead(p.starts_on) OVER (ORDER BY p.starts_on) AS next_starts_on
      FROM public.accounting_periods AS p WHERE p.business_type = _business_type) AS s
    WHERE s.next_starts_on IS NOT NULL AND s.next_starts_on <> s.ends_on + 1) THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_GAP' USING ERRCODE = '23514';
  END IF;
END;
$$;

-- The deferred second gate: every inserted header and line re-checks its entry at COMMIT (or SET CONSTRAINTS ALL
-- IMMEDIATE). A header without any line fails here with min_lines.
CREATE FUNCTION private.accounting_check_journal_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'accounting_journal_lines' THEN
    PERFORM private.accounting_assert_journal(NEW.entry_id);
  ELSE
    PERFORM private.accounting_assert_journal(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER accounting_journal_entries_balance AFTER INSERT ON public.accounting_journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.accounting_check_journal_entry();
CREATE CONSTRAINT TRIGGER accounting_journal_lines_balance AFTER INSERT ON public.accounting_journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.accounting_check_journal_entry();

-- 6. Locks and lookups.
-- (1) the group G common lock, (2) the accounting lock, (3) the period lock when a period is given.
CREATE FUNCTION private.accounting_lock_all(_period_id uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(190521, 1);
  PERFORM pg_catalog.pg_advisory_xact_lock(190525, 0);
  IF _period_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(190525, pg_catalog.hashtext(_period_id::text));
  END IF;
END;
$$;

-- The period of the given business type that contains the day (read only; S3 adds the event lookup
-- private.accounting_period_for_event).
CREATE FUNCTION private.accounting_period_for(_date date, _business_type text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF _date IS NULL OR _business_type IS NULL OR _business_type NOT IN ('soleProprietor', 'corporation') THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT pg_catalog.array_agg(p.id) INTO v_ids FROM public.accounting_periods AS p
  WHERE p.business_type = _business_type AND _date BETWEEN p.starts_on AND p.ends_on;
  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_MISSING' USING ERRCODE = '55000';
  ELSIF pg_catalog.cardinality(v_ids) > 1 THEN
    RAISE EXCEPTION 'ACCOUNTING_PERIOD_OVERLAP' USING ERRCODE = '23514';
  END IF;
  RETURN v_ids[1];
END;
$$;

-- 7. The single writer. No permission check and no entry point: the admin entry below, the manual-entry trigger
-- (Task 9), A8 (S5) and the private functions of later plans call it. _recorded_at and _migrated_from belong to
-- migrated_entry only. _source_recorded_at (the time the event itself was recorded) exists only here, so no route can
-- clear the late mark by sending an old time; recorded_at stays the insert time and least(_source_recorded_at,
-- recorded_at) decides is_late and is kept in source_recorded_at.
-- _lines: [{"account_code":"1160","debit":18750,"credit":0,"sub_account":null,"counterparty":null,"order_id":null,
-- "memo":null}], 2..200 lines. Returns {"entry_id","entry_no","period_id","created"}.
CREATE FUNCTION private.accounting_post_journal_core(
  _actor_id uuid, _period_id uuid, _entry_date date, _event_kind text, _event_parts text[], _description text,
  _lines jsonb, _reverses_entry_id uuid DEFAULT NULL, _reason text DEFAULT NULL, _source_table text DEFAULT NULL,
  _source_id text DEFAULT NULL, _recorded_at timestamptz DEFAULT NULL, _migrated_from text DEFAULT NULL,
  _source_recorded_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_line jsonb;
  v_amount jsonb;
  v_value numeric;
  v_debit bigint;
  v_credit bigint;
  v_text jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
  v_period public.accounting_periods%ROWTYPE;
  v_original public.accounting_journal_entries%ROWTYPE;
  v_existing public.accounting_journal_entries%ROWTYPE;
  v_key text;
  v_hash text;
  v_recorded_at timestamptz;
  v_source_recorded_at timestamptz;
  v_is_late boolean;
  v_entry_id uuid;
  v_entry_no bigint;
  v_constraint text;
BEGIN
  -- Order: steps 1-2 check the input only (plus the append-only account list) and run before lock_all, which keeps the
  -- lock short; every check that reads mutable state (period, original, existing key, numbering) runs after it.
  -- The key and reversal decisions assume READ COMMITTED (the default; PostgREST and the plan 2 runner use it): after
  -- the lock each statement sees a writer that committed while this one waited. Under REPEATABLE READ a concurrent
  -- duplicate would surface as DEDUPE_CONTENT_MISMATCH / ALREADY_REVERSED instead of created = false.
  -- 1. Arguments.
  IF _period_id IS NULL OR _entry_date IS NULL OR _event_kind IS NULL OR _description IS NULL
    OR NOT (_event_kind = ANY (private.accounting_event_kinds()))
    OR pg_catalog.char_length(_description) > 500
    OR ((_recorded_at IS NOT NULL OR _migrated_from IS NOT NULL) AND _event_kind <> 'migrated_entry')
    OR _recorded_at > pg_catalog.clock_timestamp()
    OR _source_recorded_at > pg_catalog.clock_timestamp()
    OR (_event_kind = 'reversal') <> (_reverses_entry_id IS NOT NULL)
    OR (_event_kind = 'reversal') <> (_reason IS NOT NULL)
    OR pg_catalog.char_length(pg_catalog.btrim(_reason)) = 0
    OR pg_catalog.char_length(_reason) > 500
    OR (_event_kind = 'reversal' AND _event_parts IS DISTINCT FROM ARRAY[_reverses_entry_id::text])
    OR _lines IS NULL OR pg_catalog.jsonb_typeof(_lines) <> 'array'
    OR pg_catalog.jsonb_array_length(_lines) > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_array_length(_lines) < 2 THEN
    RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'min_lines';
  END IF;

  -- 2. Lines. Amounts are JSON numbers (missing or null = 0); a string is ARGUMENT_INVALID, a negative, fractional,
  --    unsafe or all-zero amount is sign, so no bigint cast error (22P02) reaches the caller.
  FOR v_line IN SELECT e.value FROM pg_catalog.jsonb_array_elements(_lines) WITH ORDINALITY AS e(value, n) ORDER BY e.n
  LOOP
    IF pg_catalog.jsonb_typeof(v_line) <> 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(v_line) AS k(name)
        WHERE k.name <> ALL (ARRAY['account_code', 'debit', 'credit', 'sub_account', 'counterparty', 'order_id', 'memo']))
      OR pg_catalog.jsonb_typeof(v_line->'account_code') IS DISTINCT FROM 'string'
      OR NOT EXISTS (SELECT 1 FROM public.accounting_accounts AS a WHERE a.code = v_line->>'account_code') THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    FOREACH v_text IN ARRAY ARRAY[v_line->'sub_account', v_line->'counterparty', v_line->'order_id', v_line->'memo']
    LOOP
      IF COALESCE(pg_catalog.jsonb_typeof(v_text), 'null') NOT IN ('null', 'string') THEN
        RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF v_line->>'sub_account' !~ '^[a-z0-9_:.-]{1,64}$'
      OR v_line->>'order_id' !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    v_debit := NULL;
    v_credit := NULL;
    FOREACH v_amount IN ARRAY ARRAY[v_line->'debit', v_line->'credit']
    LOOP
      IF v_amount IS NULL OR v_amount = 'null'::jsonb THEN
        v_amount := '0'::jsonb;
      END IF;
      IF pg_catalog.jsonb_typeof(v_amount) <> 'number' THEN
        RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
      END IF;
      v_value := (v_amount #>> '{}')::numeric;
      IF v_value < 0 OR v_value <> pg_catalog.trunc(v_value) OR v_value > 9007199254740991 THEN
        RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'sign';
      END IF;
      IF v_debit IS NULL THEN v_debit := v_value::bigint; ELSE v_credit := v_value::bigint; END IF;
    END LOOP;
    IF v_debit = 0 AND v_credit = 0 THEN
      RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'sign';
    ELSIF v_debit > 0 AND v_credit > 0 THEN
      RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'one_sided';
    END IF;
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'account_code', v_line->>'account_code', 'debit', v_debit, 'credit', v_credit,
      'sub_account', v_line->>'sub_account', 'counterparty', v_line->>'counterparty',
      'order_id', ((v_line->>'order_id')::uuid)::text, 'memo', v_line->>'memo'));
  END LOOP;
  IF v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'ACCOUNTING_ENTRY_UNBALANCED' USING ERRCODE = '23514', DETAIL = 'balance';
  END IF;

  -- 3. Locks (1) -> (2) -> (3), then the period. The caller passes the period; the date only has to fall inside it.
  PERFORM private.accounting_lock_all(_period_id);
  SELECT * INTO v_period FROM public.accounting_periods AS p WHERE p.id = _period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF _entry_date < v_period.starts_on OR _entry_date > v_period.ends_on THEN
    RAISE EXCEPTION 'ACCOUNTING_DATE_OUT_OF_PERIOD' USING ERRCODE = '22023';
  END IF;

  -- The content of an event: period, kind, date and the lines (the description is left out, so a reworded resend
  -- is the same event).
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
    _period_id::text, _event_kind, pg_catalog.to_char(_entry_date, 'YYYY-MM-DD'),
    (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(l.value->'account_code', l.value->'debit',
        l.value->'credit', l.value->'sub_account', l.value->'counterparty', l.value->'order_id') ORDER BY l.n)
      FROM pg_catalog.jsonb_array_elements(v_lines) WITH ORDINALITY AS l(value, n)))::text, 'UTF8')), 'hex');

  IF _reverses_entry_id IS NOT NULL THEN
    -- 4. A reversal: the original exists, is not a reversal itself, and the lines are its lines with debit and
    --    credit swapped. The same reversal sent again returns the first result; any other one is ALREADY_REVERSED.
    SELECT * INTO v_original FROM public.accounting_journal_entries AS e WHERE e.id = _reverses_entry_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_original.event_kind = 'reversal' OR v_lines IS DISTINCT FROM (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('account_code', l.account_code, 'debit', l.credit,
        'credit', l.debit, 'sub_account', l.sub_account, 'counterparty', l.counterparty,
        'order_id', l.order_id::text, 'memo', l.memo) ORDER BY l.line_no)
      FROM public.accounting_journal_lines AS l WHERE l.entry_id = _reverses_entry_id) THEN
      RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_existing FROM public.accounting_journal_entries AS e WHERE e.reverses_entry_id = _reverses_entry_id;
    IF FOUND THEN
      IF v_existing.reason = _reason AND v_existing.entry_date = _entry_date AND v_existing.period_id = _period_id THEN
        RETURN pg_catalog.jsonb_build_object('entry_id', v_existing.id, 'entry_no', v_existing.entry_no,
          'period_id', v_existing.period_id, 'created', false);
      END IF;
      RAISE EXCEPTION 'ACCOUNTING_ALREADY_REVERSED' USING ERRCODE = '23505';
    END IF;
    v_key := private.accounting_event_key('reversal', ARRAY[_reverses_entry_id::text]);
  ELSE
    -- 5. Any other event: the same key with the same content returns the first result, another content is refused.
    --    This runs inside the locks and before the numbering, so a refused input takes no number.
    v_key := private.accounting_event_key(_event_kind, _event_parts);
    SELECT * INTO v_existing FROM public.accounting_journal_entries AS e WHERE e.dedupe_key = v_key;
    IF FOUND THEN
      IF v_existing.content_hash = v_hash THEN
        RETURN pg_catalog.jsonb_build_object('entry_id', v_existing.id, 'entry_no', v_existing.entry_no,
          'period_id', v_existing.period_id, 'created', false);
      END IF;
      RAISE EXCEPTION 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' USING ERRCODE = '23505';
    END IF;
  END IF;

  -- 6./7. The number, the header and the lines. A migrated entry is never late; otherwise an entry recorded more than
  --    two months after its date (in Japan) is late.
  v_recorded_at := COALESCE(_recorded_at, pg_catalog.now());
  v_source_recorded_at := CASE WHEN _source_recorded_at IS NULL THEN NULL
    ELSE LEAST(_source_recorded_at, v_recorded_at) END;
  v_is_late := _migrated_from IS NULL
    AND private.accounting_jst_date(COALESCE(v_source_recorded_at, v_recorded_at)) > (_entry_date + interval '2 months')::date;
  BEGIN
    INSERT INTO public.accounting_period_sequences AS s (period_id) VALUES (_period_id) ON CONFLICT (period_id) DO NOTHING;
    UPDATE public.accounting_period_sequences AS s SET last_entry_no = s.last_entry_no + 1
    WHERE s.period_id = _period_id RETURNING s.last_entry_no INTO v_entry_no;
    INSERT INTO public.accounting_journal_entries (period_id, entry_no, entry_date, event_kind, dedupe_key, content_hash,
      description, recorded_at, source_recorded_at, recorded_by, is_late, reverses_entry_id, reason, source_table,
      source_id, migrated_from, migrated_at)
    VALUES (_period_id, v_entry_no, _entry_date, _event_kind, v_key, v_hash, _description, v_recorded_at,
      v_source_recorded_at, _actor_id, v_is_late, _reverses_entry_id, _reason, _source_table, _source_id,
      _migrated_from, CASE WHEN _migrated_from IS NULL THEN NULL ELSE pg_catalog.now() END)
    RETURNING id INTO v_entry_id;
    INSERT INTO public.accounting_journal_lines (entry_id, line_no, account_code, debit, credit, sub_account,
      counterparty, order_id, memo)
    SELECT v_entry_id, l.n::smallint, l.value->>'account_code', (l.value->>'debit')::bigint,
      (l.value->>'credit')::bigint, l.value->>'sub_account', l.value->>'counterparty', (l.value->>'order_id')::uuid,
      l.value->>'memo'
    FROM pg_catalog.jsonb_array_elements(v_lines) WITH ORDINALITY AS l(value, n);
  EXCEPTION WHEN unique_violation THEN
    -- 8. The locks serialize every writer, so this is only a safety net: decide again as in 4 / 5. The number taken
    --    inside this block is rolled back with it.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint NOT IN ('accounting_journal_entries_reverses_entry_id_key',
      'accounting_journal_entries_dedupe_key_key') THEN
      RAISE;
    END IF;
    IF _reverses_entry_id IS NOT NULL THEN
      SELECT * INTO v_existing FROM public.accounting_journal_entries AS e WHERE e.reverses_entry_id = _reverses_entry_id;
      IF FOUND AND v_existing.reason = _reason AND v_existing.entry_date = _entry_date
        AND v_existing.period_id = _period_id THEN
        RETURN pg_catalog.jsonb_build_object('entry_id', v_existing.id, 'entry_no', v_existing.entry_no,
          'period_id', v_existing.period_id, 'created', false);
      END IF;
      RAISE EXCEPTION 'ACCOUNTING_ALREADY_REVERSED' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_existing FROM public.accounting_journal_entries AS e WHERE e.dedupe_key = v_key;
    IF FOUND AND v_existing.content_hash = v_hash THEN
      RETURN pg_catalog.jsonb_build_object('entry_id', v_existing.id, 'entry_no', v_existing.entry_no,
        'period_id', v_existing.period_id, 'created', false);
    END IF;
    RAISE EXCEPTION 'ACCOUNTING_DEDUPE_CONTENT_MISMATCH' USING ERRCODE = '23505';
  END;

  -- Checked before returning, so the caller can catch it; the deferred triggers stay as the second gate.
  PERFORM private.accounting_assert_journal(v_entry_id);
  PERFORM private.accounting_assert_period_layout(v_period.business_type);
  RETURN pg_catalog.jsonb_build_object('entry_id', v_entry_id, 'entry_no', v_entry_no, 'period_id', _period_id,
    'created', true);
END;
$$;

-- 8. The general entry: admin.finance.manage first, then the kinds that have their own tool are refused (reversal,
--    manual_entry, migrated_entry, period_closing_entry, closed_year_correction), as are a reversal target, a reason
--    and the manual-entry source. It has no time arguments. Plan 1 has no route that calls it (plan 2 does).
CREATE FUNCTION private.admin_post_accounting_journal(
  _actor_id uuid, _period_id uuid, _entry_date date, _event_kind text, _event_parts text[], _description text,
  _lines jsonb, _reverses_entry_id uuid DEFAULT NULL, _reason text DEFAULT NULL, _source_table text DEFAULT NULL,
  _source_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.finance.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF _event_kind IN ('reversal', 'manual_entry', 'migrated_entry', 'period_closing_entry', 'closed_year_correction')
    OR _reverses_entry_id IS NOT NULL OR _reason IS NOT NULL OR _source_table = 'admin_finance_expenses' THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN private.accounting_post_journal_core(_actor_id, _period_id, _entry_date, _event_kind, _event_parts,
    _description, _lines, NULL, NULL, _source_table, _source_id, NULL, NULL, NULL);
END;
$$;

-- 9. The reversal core: the lines of the original with debit and credit swapped, on the original day unless a day is
--    given, in the period of that day with the business type of the original period. The period is found in three
--    steps: (1) accounting_period_for(day, business type of the original); (2) when that is missing and the original
--    is a sole proprietor entry, private.accounting_ensure_individual_periods (S3; it never creates a year after the
--    end day of the sole business) creates the calendar-year period and (1) runs again; (3) still missing is
--    ACCOUNTING_PERIOD_MISSING. A corporation period is never created here, and accounting_period_for_event (S3) is not
--    used, so a reversal never moves to the other business type. No permission check and no entry point.
CREATE FUNCTION private.accounting_reverse_journal_core(
  _actor_id uuid, _entry_id uuid, _reason text, _entry_date date DEFAULT NULL, _source_recorded_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_original public.accounting_journal_entries%ROWTYPE;
  v_business_type text;
  v_date date;
  v_lines jsonb;
  v_period_id uuid;
BEGIN
  IF _entry_id IS NULL OR _reason IS NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM private.accounting_lock_all(NULL);
  SELECT * INTO v_original FROM public.accounting_journal_entries AS e WHERE e.id = _entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNTING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_original.event_kind = 'reversal' THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT p.business_type INTO v_business_type FROM public.accounting_periods AS p WHERE p.id = v_original.period_id;
  v_date := COALESCE(_entry_date, v_original.entry_date);
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('account_code', l.account_code, 'debit', l.credit,
    'credit', l.debit, 'sub_account', l.sub_account, 'counterparty', l.counterparty, 'order_id', l.order_id,
    'memo', l.memo) ORDER BY l.line_no)
  INTO v_lines FROM public.accounting_journal_lines AS l WHERE l.entry_id = _entry_id;
  BEGIN
    v_period_id := private.accounting_period_for(v_date, v_business_type);
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM <> 'ACCOUNTING_PERIOD_MISSING' OR v_business_type <> 'soleProprietor' THEN
      RAISE;
    END IF;
    PERFORM private.accounting_ensure_individual_periods(EXTRACT(year FROM v_date)::integer, _actor_id);
    v_period_id := private.accounting_period_for(v_date, v_business_type);
  END;
  RETURN private.accounting_post_journal_core(_actor_id, v_period_id, v_date,
    'reversal', ARRAY[_entry_id::text], v_original.description, v_lines, _entry_id, _reason,
    v_original.source_table, v_original.source_id, NULL, NULL, _source_recorded_at);
END;
$$;

-- The general reversal entry (manual reversal: admin.finance.manage). It has no time argument. Reversals that need
-- admin.accounting.entries.correct come from later plans, which check that permission and call the core.
-- It reverses only what the general post entry could have written: an original of a kind with its own tool
-- (reversal, manual_entry, migrated_entry, period_closing_entry, closed_year_correction) or from the manual-entry
-- source is ARGUMENT_INVALID (manual entries are reversed by the Task 9 trigger through the core). The originals are
-- append only, so reading one before the core takes the locks is safe; an unknown id is NOT_FOUND from the core.
CREATE FUNCTION private.admin_reverse_accounting_journal(
  _actor_id uuid, _entry_id uuid, _reason text, _entry_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.finance.manage']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_journal_entries AS e WHERE e.id = _entry_id
    AND (e.event_kind IN ('reversal', 'manual_entry', 'migrated_entry', 'period_closing_entry', 'closed_year_correction')
      OR e.source_table IS NOT DISTINCT FROM 'admin_finance_expenses')) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN private.accounting_reverse_journal_core(_actor_id, _entry_id, _reason, _entry_date, NULL);
END;
$$;

CREATE FUNCTION public.admin_post_accounting_journal(
  _actor_id uuid, _period_id uuid, _entry_date date, _event_kind text, _event_parts text[], _description text,
  _lines jsonb, _reverses_entry_id uuid DEFAULT NULL, _reason text DEFAULT NULL, _source_table text DEFAULT NULL,
  _source_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_post_accounting_journal(_actor_id, _period_id, _entry_date, _event_kind, _event_parts,
  _description, _lines, _reverses_entry_id, _reason, _source_table, _source_id) $$;

CREATE FUNCTION public.admin_reverse_accounting_journal(
  _actor_id uuid, _entry_id uuid, _reason text, _entry_date date DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_reverse_accounting_journal(_actor_id, _entry_id, _reason, _entry_date) $$;

-- 10. Owners and EXECUTE. Only the two admin entries (private and public) are executable by service_role.
ALTER FUNCTION private.accounting_event_kinds() OWNER TO postgres;
ALTER FUNCTION private.accounting_event_arity(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_event_key(text,text[]) OWNER TO postgres;
ALTER FUNCTION private.accounting_period_length_ok(date,date) OWNER TO postgres;
ALTER FUNCTION private.accounting_jst_date(timestamptz) OWNER TO postgres;
ALTER FUNCTION private.reject_accounting_mutation() OWNER TO postgres;
ALTER FUNCTION private.accounting_assert_journal(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_assert_period_layout(text) OWNER TO postgres;
ALTER FUNCTION private.accounting_check_journal_entry() OWNER TO postgres;
ALTER FUNCTION private.accounting_lock_all(uuid) OWNER TO postgres;
ALTER FUNCTION private.accounting_period_for(date,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_post_journal_core(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text,timestamptz,text,timestamptz) OWNER TO postgres;
ALTER FUNCTION private.admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text) OWNER TO postgres;
ALTER FUNCTION private.accounting_reverse_journal_core(uuid,uuid,text,date,timestamptz) OWNER TO postgres;
ALTER FUNCTION private.admin_reverse_accounting_journal(uuid,uuid,text,date) OWNER TO postgres;
ALTER FUNCTION public.admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text) OWNER TO postgres;
ALTER FUNCTION public.admin_reverse_accounting_journal(uuid,uuid,text,date) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.accounting_event_kinds(), private.accounting_event_arity(text), private.accounting_event_key(text,text[]),
  private.accounting_period_length_ok(date,date), private.accounting_jst_date(timestamptz),
  private.reject_accounting_mutation(), private.accounting_assert_journal(uuid),
  private.accounting_assert_period_layout(text), private.accounting_check_journal_entry(),
  private.accounting_lock_all(uuid), private.accounting_period_for(date,text),
  private.accounting_post_journal_core(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text,timestamptz,text,timestamptz),
  private.admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text),
  private.accounting_reverse_journal_core(uuid,uuid,text,date,timestamptz),
  private.admin_reverse_accounting_journal(uuid,uuid,text,date),
  public.admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text),
  public.admin_reverse_accounting_journal(uuid,uuid,text,date)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text),
  private.admin_reverse_accounting_journal(uuid,uuid,text,date),
  public.admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text),
  public.admin_reverse_accounting_journal(uuid,uuid,text,date)
TO service_role;
-- ACC_S2_BODY_END

-- ACC_S2_FINAL_ASSERT_BEGIN
-- Compare catalog meaning (columns, constraint definitions, triggers, ACL entries, has_*_privilege, function
-- attributes), never ACL text serialization. Foreign keys are compared by column and table names, so the result does
-- not depend on the caller's search_path.
DO $acc_s2_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_tables CONSTANT text[] := ARRAY['accounting_accounts', 'accounting_periods', 'accounting_period_sequences',
    'accounting_journal_entries', 'accounting_journal_lines'];
  v_append_only CONSTANT text[] := ARRAY['accounting_accounts', 'accounting_journal_entries', 'accounting_journal_lines'];
  e record;
  p record;
  v_oid oid;
  v_stage text;
  v_baseline jsonb;
  v_other_codes text[];
BEGIN
  -- Catalog text (pg_get_expr, pg_get_constraintdef, format_type) depends on the caller's search_path: with
  -- extensions ahead of pg_catalog (the Supabase default) a built-in such as gen_random_uuid() prints as
  -- pg_catalog.gen_random_uuid(). Pin an empty search_path for this block (transaction local); it is put back below,
  -- and an error rolls it back with the block.
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s2_tables';
  -- acc_s2_tables: the five tables exist in public, are ordinary tables owned by postgres, and have exactly these
  -- columns (name, type, NOT NULL, default) in this order.
  IF EXISTS (SELECT 1 FROM (VALUES
    ('accounting_accounts', 'code text not null, account_type text not null, normal_side text not null, scope text not null, carryover_role text not null'),
    ('accounting_periods', 'id uuid not null default gen_random_uuid(), business_type text not null, name text not null, starts_on date not null, ends_on date not null, corporate_tax_extension_months smallint not null default 0, consumption_tax_extension_months smallint not null default 0, consumption_tax_status text not null default ''exempt''::text, consumption_taxable_from date, version bigint not null default 1, created_by uuid, created_at timestamp with time zone not null default now(), updated_by uuid, updated_at timestamp with time zone, creation_request_key uuid, creation_request_hash text, admin_requests jsonb not null default ''{}''::jsonb, legacy_fiscal_year integer'),
    ('accounting_period_sequences', 'period_id uuid not null, last_entry_no bigint not null default 0'),
    ('accounting_journal_entries', 'id uuid not null default gen_random_uuid(), period_id uuid not null, entry_no bigint not null, entry_date date not null, event_kind text not null, dedupe_key text not null, content_hash text not null, description text not null, recorded_at timestamp with time zone not null default now(), source_recorded_at timestamp with time zone, recorded_by uuid, is_late boolean not null default false, reverses_entry_id uuid, reason text, source_table text, source_id text, migrated_from text, migrated_at timestamp with time zone'),
    ('accounting_journal_lines', 'entry_id uuid not null, line_no smallint not null, account_code text not null, debit bigint not null default 0, credit bigint not null default 0, sub_account text, counterparty text, order_id uuid, memo text')
  ) AS t(name, columns)
  LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
  WHERE c.oid IS NULL OR c.relkind <> 'r' OR c.relowner <> 'postgres'::regrole
    OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
          || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM t.columns) THEN
    v_failed := 'acc_s2_tables';
  END IF;

  v_stage := 'acc_s2_constraints';
  -- acc_s2_constraints: every CHECK / PRIMARY KEY / UNIQUE / FOREIGN KEY below exists, is validated and is not
  -- deferrable; the four append-only and numbering tables have no other one (accounting_periods may gain more in S3);
  -- and the two reading indexes exist.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
    ('accounting_accounts', 'accounting_accounts_account_type_check', 'c', 'CHECK ((account_type = ANY (ARRAY[''asset''::text, ''liability''::text, ''equity''::text, ''revenue''::text, ''expense''::text])))'),
    ('accounting_accounts', 'accounting_accounts_carryover_role_check', 'c', 'CHECK ((carryover_role = ANY (ARRAY[''carry''::text, ''capital_sole''::text, ''owner_draw''::text, ''owner_contribution''::text, ''retained_corp''::text, ''pl_zero''::text])))'),
    ('accounting_accounts', 'accounting_accounts_code_check', 'c', 'CHECK ((code ~ ''^[0-9]{4}$''::text))'),
    ('accounting_accounts', 'accounting_accounts_normal_side_check', 'c', 'CHECK ((normal_side = ANY (ARRAY[''debit''::text, ''credit''::text])))'),
    ('accounting_accounts', 'accounting_accounts_pkey', 'p', 'code'),
    ('accounting_accounts', 'accounting_accounts_scope_check', 'c', 'CHECK ((scope = ANY (ARRAY[''common''::text, ''soleProprietor''::text, ''corporation''::text])))'),
    ('accounting_journal_entries', 'accounting_journal_entries_dedupe_key_key', 'u', 'dedupe_key'),
    ('accounting_journal_entries', 'accounting_journal_entries_description_check', 'c', 'CHECK ((char_length(description) <= 500))'),
    ('accounting_journal_entries', 'accounting_journal_entries_entry_no_check', 'c', 'CHECK ((entry_no >= 1))'),
    ('accounting_journal_entries', 'accounting_journal_entries_event_kind_check', 'c', 'CHECK ((event_kind = ANY (private.accounting_event_kinds())))'),
    ('accounting_journal_entries', 'accounting_journal_entries_period_entry_no_key', 'u', 'period_id,entry_no'),
    ('accounting_journal_entries', 'accounting_journal_entries_period_id_fkey', 'f', 'period_id>public.accounting_periods(id)ras'),
    ('accounting_journal_entries', 'accounting_journal_entries_pkey', 'p', 'id'),
    ('accounting_journal_entries', 'accounting_journal_entries_reversal_check', 'c', 'CHECK ( CASE WHEN (event_kind = ''reversal''::text) THEN ((reverses_entry_id IS NOT NULL) AND (reason IS NOT NULL)) ELSE ((reverses_entry_id IS NULL) AND (reason IS NULL)) END)'),
    ('accounting_journal_entries', 'accounting_journal_entries_reverses_entry_id_fkey', 'f', 'reverses_entry_id>public.accounting_journal_entries(id)ras'),
    ('accounting_journal_entries', 'accounting_journal_entries_reverses_entry_id_key', 'u', 'reverses_entry_id'),
    ('accounting_journal_entries', 'accounting_journal_entries_source_recorded_at_check', 'c', 'CHECK (((source_recorded_at IS NULL) OR (source_recorded_at <= recorded_at)))'),
    ('accounting_journal_lines', 'accounting_journal_lines_account_code_fkey', 'f', 'account_code>public.accounting_accounts(code)ras'),
    ('accounting_journal_lines', 'accounting_journal_lines_credit_check', 'c', 'CHECK ((credit >= 0))'),
    ('accounting_journal_lines', 'accounting_journal_lines_debit_check', 'c', 'CHECK ((debit >= 0))'),
    ('accounting_journal_lines', 'accounting_journal_lines_entry_id_fkey', 'f', 'entry_id>public.accounting_journal_entries(id)ras'),
    ('accounting_journal_lines', 'accounting_journal_lines_line_no_check', 'c', 'CHECK (((line_no >= 1) AND (line_no <= 200)))'),
    ('accounting_journal_lines', 'accounting_journal_lines_pkey', 'p', 'entry_id,line_no'),
    ('accounting_journal_lines', 'accounting_journal_lines_sub_account_check', 'c', 'CHECK ((sub_account ~ ''^[a-z0-9_:.-]{1,64}$''::text))'),
    ('accounting_period_sequences', 'accounting_period_sequences_last_entry_no_check', 'c', 'CHECK ((last_entry_no >= 0))'),
    ('accounting_period_sequences', 'accounting_period_sequences_period_id_fkey', 'f', 'period_id>public.accounting_periods(id)ras'),
    ('accounting_period_sequences', 'accounting_period_sequences_pkey', 'p', 'period_id'),
    ('accounting_periods', 'accounting_periods_business_type_check', 'c', 'CHECK ((business_type = ANY (ARRAY[''soleProprietor''::text, ''corporation''::text])))'),
    ('accounting_periods', 'accounting_periods_consumption_extension_check', 'c', 'CHECK ((consumption_tax_extension_months <= corporate_tax_extension_months))'),
    ('accounting_periods', 'accounting_periods_consumption_tax_extension_check', 'c', 'CHECK (((consumption_tax_extension_months >= 0) AND (consumption_tax_extension_months <= 1)))'),
    ('accounting_periods', 'accounting_periods_consumption_tax_status_check', 'c', 'CHECK ((consumption_tax_status = ANY (ARRAY[''exempt''::text, ''taxable''::text])))'),
    ('accounting_periods', 'accounting_periods_corporate_tax_extension_check', 'c', 'CHECK (((corporate_tax_extension_months >= 0) AND (corporate_tax_extension_months <= 1)))'),
    ('accounting_periods', 'accounting_periods_creation_request_key_key', 'u', 'creation_request_key'),
    ('accounting_periods', 'accounting_periods_legacy_fiscal_year_key', 'u', 'legacy_fiscal_year'),
    ('accounting_periods', 'accounting_periods_length_check', 'c', 'CHECK (private.accounting_period_length_ok(starts_on, ends_on))'),
    ('accounting_periods', 'accounting_periods_name_check', 'c', 'CHECK (((char_length(name) >= 1) AND (char_length(name) <= 60)))'),
    ('accounting_periods', 'accounting_periods_pkey', 'p', 'id'),
    ('accounting_periods', 'accounting_periods_range_check', 'c', 'CHECK ((starts_on <= ends_on))'),
    ('accounting_periods', 'accounting_periods_sole_calendar_check', 'c', 'CHECK (((business_type <> ''soleProprietor''::text) OR ((EXTRACT(month FROM starts_on) = (1)::numeric) AND (EXTRACT(day FROM starts_on) = (1)::numeric) AND (EXTRACT(year FROM ends_on) = EXTRACT(year FROM starts_on)))))'),
    ('accounting_periods', 'accounting_periods_taxable_from_presence_check', 'c', 'CHECK (((consumption_tax_status = ''exempt''::text) = (consumption_taxable_from IS NULL)))'),
    ('accounting_periods', 'accounting_periods_taxable_from_range_check', 'c', 'CHECK (((consumption_taxable_from >= starts_on) AND (consumption_taxable_from <= ends_on)))')
    ) AS x(table_name, name, kind, definition)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = pg_catalog.to_regclass('public.' || x.table_name) AND c.conname = x.name
        AND c.contype = x.kind::"char" AND c.convalidated AND NOT c.condeferrable
        AND CASE WHEN c.contype = 'c'
          THEN pg_catalog.replace(pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g'),
            'private.', '')
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
          END = CASE WHEN x.kind = 'c' THEN pg_catalog.replace(x.definition, 'private.', '') ELSE x.definition END))
    -- The two CHECKs that call a function (printed without its schema when private is on the search_path) depend on
    -- exactly the private function.
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_depend AS d JOIN pg_catalog.pg_constraint AS c ON c.oid = d.objid
      WHERE d.classid = 'pg_catalog.pg_constraint'::regclass AND d.refclassid = 'pg_catalog.pg_proc'::regclass
        AND (c.conname, d.refobjid) IN (
          ('accounting_journal_entries_event_kind_check', 'private.accounting_event_kinds()'::regprocedure::oid),
          ('accounting_periods_length_check', 'private.accounting_period_length_ok(date,date)'::regprocedure::oid))) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid IN (SELECT pg_catalog.to_regclass('public.' || t) FROM pg_catalog.unnest(ARRAY['accounting_accounts',
        'accounting_period_sequences', 'accounting_journal_entries', 'accounting_journal_lines']) AS t)
        AND c.contype <> 't') <> 27
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS x ON x.oid = i.indexrelid
      JOIN pg_catalog.pg_am AS am ON am.oid = x.relam
      WHERE i.indrelid = 'public.accounting_journal_entries'::regclass AND NOT i.indisunique AND i.indisvalid
        AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname = 'btree'
        AND (x.relname::text, (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
          FROM pg_catalog.unnest(i.indkey::int2[]) WITH ORDINALITY AS k(num, ord)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.num)) IN (
          ('accounting_journal_entries_period_date_no_idx', 'period_id,entry_date,entry_no'),
          ('accounting_journal_entries_source_idx', 'source_table,source_id'))) <> 2) THEN
    v_failed := 'acc_s2_constraints';
  END IF;

  v_stage := 'acc_s2_triggers';
  -- acc_s2_triggers: the deferred balance check on both journal tables (AFTER INSERT, row, DEFERRABLE INITIALLY
  -- DEFERRED, enabled) and its SECURITY DEFINER function.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS t
      WHERE (t.tgrelid, t.tgname::text) IN (
          ('public.accounting_journal_entries'::regclass, 'accounting_journal_entries_balance'),
          ('public.accounting_journal_lines'::regclass, 'accounting_journal_lines_balance'))
        AND t.tgfoid = 'private.accounting_check_journal_entry()'::regprocedure AND t.tgtype = 5 AND t.tgenabled = 'O'
        AND NOT t.tgisinternal AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred AND t.tgnargs = 0
        AND t.tgqual IS NULL AND pg_catalog.cardinality(t.tgattr::int2[]) = 0) <> 2
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f
      WHERE f.oid = 'private.accounting_check_journal_entry()'::regprocedure AND f.prosecdef
        AND pg_catalog.strpos(f.prosrc, 'PERFORM private.accounting_assert_journal(NEW.entry_id);') > 0
        AND pg_catalog.strpos(f.prosrc, 'PERFORM private.accounting_assert_journal(NEW.id);') > 0)) THEN
    v_failed := 'acc_s2_triggers';
  END IF;

  v_stage := 'acc_s2_rls_acl';
  -- acc_s2_rls_acl: RLS on and no policy; PUBLIC, anon and authenticated hold nothing (table or column);
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
    v_failed := 'acc_s2_rls_acl';
  END IF;

  v_stage := 'acc_s2_immutable';
  -- acc_s2_immutable: BEFORE UPDATE OR DELETE (row) and BEFORE TRUNCATE (statement) on the three append-only tables,
  -- enabled ALWAYS (also under session_replication_role = replica), calling the reject function, and no other user
  -- trigger on them.
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM pg_catalog.unnest(v_append_only) AS t(name)
      CROSS JOIN (VALUES ('_no_update_delete', 27), ('_no_truncate', 34)) AS k(suffix, kind)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS g
        WHERE g.tgrelid = pg_catalog.to_regclass('public.' || t.name) AND g.tgname::text = t.name || k.suffix
          AND g.tgfoid = 'private.reject_accounting_mutation()'::regprocedure AND g.tgtype = k.kind
          AND g.tgenabled = 'A' AND NOT g.tgisinternal AND g.tgconstraint = 0 AND NOT g.tgdeferrable
          AND g.tgnargs = 0 AND g.tgqual IS NULL))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT pg_catalog.to_regclass('public.' || t)
        FROM pg_catalog.unnest(v_append_only) AS t)) <> 8
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = 'private.reject_accounting_mutation()'::regprocedure AND f.proowner = 'postgres'::regrole
        AND NOT f.prosecdef AND l.lanname = 'plpgsql' AND f.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
        AND pg_catalog.regexp_replace(f.prosrc, '\s+', ' ', 'g')
          = ' BEGIN RAISE EXCEPTION ''ACCOUNTING_HISTORY_IMMUTABLE'' USING ERRCODE = ''55000''; END; ')) THEN
    v_failed := 'acc_s2_immutable';
  END IF;

  v_stage := 'acc_s2_event_kinds';
  -- acc_s2_event_kinds: the 27 kinds and their arity, and the key strings (stripe_fee is stripe:fee:<part>).
  IF v_failed IS NULL AND (
    private.accounting_event_kinds() IS DISTINCT FROM ARRAY['payment_confirmed', 'shipment_confirmed',
      'shipment_redated', 'pre_shipment_refund', 'return_arrived', 'return_amount_decided', 'return_refund',
      'refund_failed', 'refund_abandoned', 'stripe_fee', 'stripe_tax_adjustment', 'payout_started', 'bank_arrived',
      'payout_failed', 'balance_topup', 'dispute_event', 'dispute_withdrawn_late', 'exchange_movement', 'owner_use',
      'personal_discount', 'compensation_received', 'manual_entry', 'migrated_entry', 'period_closing_entry',
      'closed_year_correction', 'return_arrival_redated', 'reversal']::text[]
    OR ARRAY(SELECT private.accounting_event_arity(k.kind) FROM pg_catalog.unnest(private.accounting_event_kinds())
      WITH ORDINALITY AS k(kind, ord) ORDER BY k.ord)
      IS DISTINCT FROM ARRAY[1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1, 3, 2, 1, 1, 2, 1, 2, 1, 3, 3, 1, 1]
    OR private.accounting_event_arity('unknown_kind') IS NOT NULL
    OR private.accounting_event_key('stripe_fee', ARRAY['txn_1']) IS DISTINCT FROM 'stripe:fee:txn_1'
    OR private.accounting_event_key('dispute_event', ARRAY['dp_1', 'lost', '1'])
      IS DISTINCT FROM 'dispute_event:dp_1:lost:1') THEN
    v_failed := 'acc_s2_event_kinds';
  END IF;

  v_stage := 'acc_s2_accounts_seed';
  -- acc_s2_accounts_seed: the 163 rows of scripts/accounting/emit-accounts-seed.ts (code, type, side, scope, role) are
  -- present, and every other account equals the baseline (none at apply time; a replay pins the later ones).
  -- The baseline itself must exist with one well-formed row (else acc_s2_existing_dml_allowlist).
  IF v_failed IS NULL THEN
    IF pg_catalog.to_regclass('pg_temp.accounting_s2_baseline') IS NULL THEN
      v_failed := 'acc_s2_existing_dml_allowlist';
    ELSIF (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s2_baseline) <> 1 THEN
      v_failed := 'acc_s2_existing_dml_allowlist';
    ELSE
      SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s2_baseline AS b;
      IF pg_catalog.jsonb_typeof(v_baseline->'other_accounts') IS DISTINCT FROM 'array' THEN
        v_failed := 'acc_s2_existing_dml_allowlist';
      ELSE
        v_other_codes := ARRAY(SELECT o.value->>'code' FROM pg_catalog.jsonb_array_elements(v_baseline->'other_accounts') AS o);
        IF (SELECT pg_catalog.count(*) FROM public.accounting_accounts AS a WHERE NOT (a.code = ANY (v_other_codes))) <> 163
          OR (SELECT pg_catalog.md5(pg_catalog.string_agg(a.code || ',' || a.account_type || ',' || a.normal_side || ','
              || a.scope || ',' || a.carryover_role, ';' ORDER BY a.code COLLATE "C"))
            FROM public.accounting_accounts AS a WHERE NOT (a.code = ANY (v_other_codes)))
            IS DISTINCT FROM '9267159e6a646a2f7b5fcd81a725235f'
          OR NOT EXISTS (SELECT 1 FROM public.accounting_accounts AS a WHERE a.code = '9999' AND a.account_type = 'expense'
            AND a.normal_side = 'debit' AND a.scope = 'common' AND a.carryover_role = 'pl_zero')
          OR COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.code COLLATE "C")
              FROM public.accounting_accounts AS a WHERE a.code = ANY (v_other_codes)), '[]'::jsonb)
            IS DISTINCT FROM COALESCE((SELECT pg_catalog.jsonb_agg(o.value ORDER BY (o.value->>'code') COLLATE "C")
              FROM pg_catalog.jsonb_array_elements(v_baseline->'other_accounts') AS o), '[]'::jsonb) THEN
          v_failed := 'acc_s2_accounts_seed';
        END IF;
      END IF;
    END IF;
  END IF;

  v_stage := 'acc_s2_function_attrs';
  -- acc_s2_function_attrs: owner, SECURITY, volatility, language, result, argument names and defaults, search_path,
  -- EXECUTE (only the two admin entries for service_role), one function per name, and the public entries delegate.
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private', 'accounting_event_kinds()', true, 'i', 'sql', 'text[]', '', 0, false),
      ('private', 'accounting_event_arity(text)', true, 'i', 'sql', 'integer', '_kind', 0, false),
      ('private', 'accounting_event_key(text,text[])', true, 'i', 'plpgsql', 'text', '_kind,_parts', 0, false),
      ('private', 'accounting_period_length_ok(date,date)', true, 'i', 'sql', 'boolean', '_starts_on,_ends_on', 0, false),
      ('private', 'accounting_jst_date(timestamptz)', true, 's', 'sql', 'date', '_at', 0, false),
      ('private', 'reject_accounting_mutation()', false, 'v', 'plpgsql', 'trigger', '', 0, false),
      ('private', 'accounting_assert_journal(uuid)', true, 'v', 'plpgsql', 'void', '_entry_id', 0, false),
      ('private', 'accounting_assert_period_layout(text)', true, 'v', 'plpgsql', 'void', '_business_type', 0, false),
      ('private', 'accounting_check_journal_entry()', true, 'v', 'plpgsql', 'trigger', '', 0, false),
      ('private', 'accounting_lock_all(uuid)', true, 'v', 'plpgsql', 'void', '_period_id', 1, false),
      ('private', 'accounting_period_for(date,text)', true, 's', 'plpgsql', 'uuid', '_date,_business_type', 0, false),
      ('private', 'accounting_post_journal_core(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text,timestamptz,text,timestamptz)',
        true, 'v', 'plpgsql', 'jsonb',
        '_actor_id,_period_id,_entry_date,_event_kind,_event_parts,_description,_lines,_reverses_entry_id,_reason,_source_table,_source_id,_recorded_at,_migrated_from,_source_recorded_at',
        7, false),
      ('private', 'admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text)',
        true, 'v', 'plpgsql', 'jsonb',
        '_actor_id,_period_id,_entry_date,_event_kind,_event_parts,_description,_lines,_reverses_entry_id,_reason,_source_table,_source_id',
        4, true),
      ('private', 'accounting_reverse_journal_core(uuid,uuid,text,date,timestamptz)', true, 'v', 'plpgsql', 'jsonb',
        '_actor_id,_entry_id,_reason,_entry_date,_source_recorded_at', 2, false),
      ('private', 'admin_reverse_accounting_journal(uuid,uuid,text,date)', true, 'v', 'plpgsql', 'jsonb',
        '_actor_id,_entry_id,_reason,_entry_date', 1, true),
      ('public', 'admin_post_accounting_journal(uuid,uuid,date,text,text[],text,jsonb,uuid,text,text,text)',
        false, 'v', 'sql', 'jsonb',
        '_actor_id,_period_id,_entry_date,_event_kind,_event_parts,_description,_lines,_reverses_entry_id,_reason,_source_table,_source_id',
        4, true),
      ('public', 'admin_reverse_accounting_journal(uuid,uuid,text,date)', false, 'v', 'sql', 'jsonb',
        '_actor_id,_entry_id,_reason,_entry_date', 1, true)
    ) AS x(schema_name, signature, definer, volatility, language, result_type, arg_names, defaults, service)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      IF v_oid IS NULL THEN v_failed := 'acc_s2_function_attrs'; EXIT; END IF;
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = v_oid;
      IF p.proowner <> 'postgres'::regrole OR p.prosecdef IS DISTINCT FROM e.definer
        OR p.provolatile <> e.volatility::"char" OR p.lanname <> e.language
        OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset
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
          <> 'selectprivate.' || p.proname::text || '(' || e.arg_names || ')') THEN
        v_failed := 'acc_s2_function_attrs'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- Nothing named accounting_* (the core, the reversal core and the helpers) has a public entry.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_namespace AS n
      ON n.oid = f.pronamespace
    WHERE n.nspname = 'public' AND (f.proname LIKE 'accounting\_%' OR f.proname = 'reject_accounting_mutation')) THEN
    v_failed := 'acc_s2_function_attrs';
  END IF;

  v_stage := 'acc_s2_existing_dml_allowlist';
  -- acc_s2_existing_dml_allowlist: the only DML of this migration is the account seed; the periods, numbers, entries
  -- and lines equal the baseline (zero at apply time, so none may exist yet).
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline->>'periods')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_period_sequences) IS DISTINCT FROM (v_baseline->>'sequences')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline->>'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline->>'lines')::bigint) THEN
    v_failed := 'acc_s2_existing_dml_allowlist';
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
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s2_tables'), HINT = SQLSTATE;
END;
$acc_s2_final$;
-- ACC_S2_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
