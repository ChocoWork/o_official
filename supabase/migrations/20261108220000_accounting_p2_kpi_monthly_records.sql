BEGIN;
-- Accounting plan 2 S13 (FREQ-573 AC-01, AC-02, AC-03): the monthly KPI table admin_kpi_monthly_records, and the functions that write and read it.
-- The table was made once by hand (migrations/063_create_admin_kpi_monthly_records.sql, run in the Supabase SQL Editor) and was never in
-- supabase/migrations, so a database built from the migrations did not have it and the monthly record screen answered 503. This file puts
-- it in the migrations with the rules of the new tables of plan 1: RLS on and no policy, PUBLIC / anon / authenticated hold nothing,
-- service_role can only SELECT, and the writes go through functions (no direct path).
--
-- NOT guarded with IF NOT EXISTS on purpose: if the table is already there (somebody ran 063 by hand), this migration stops, and the
-- read of the production state before applying shows it. KPI months stay calendar months (design 11-g); this file changes no KPI rule.
--
-- Functions (public.<name> calls private.<name>; SECURITY INVOKER entries for service_role only):
--   admin_set_kpi_monthly_records(_actor_id uuid, _updates jsonb) -> integer: the monthly record screen. First checks
--     admin.orders.read of the actor (ACCOUNTING_FORBIDDEN / 42501); the owner-only check (role admin) stays in the route.
--     _updates = [{"month_key":"2026-07","metric_key":"kpi:sales","value":123.4}], 1..200 entries (0 entries writes nothing);
--     "value" null (or missing) deletes the row. The same month and metric twice in a list: the last one counts. Returns the number of
--     different (month, metric) pairs written or deleted. A bad list is refused as a whole (ACCOUNTING_ARGUMENT_INVALID / 22023).
--   system_upsert_kpi_monthly_records(_rows jsonb) -> integer: the Meta sync cron. No actor and no permission check (only service_role
--     can call it); upsert only (a null value is refused); at most 200 entries.
--   list_kpi_monthly_records(_month_keys text[]) -> TABLE(month_key, metric_key, value): STABLE; at most 24 months.
--   Both writers use the private tool kpi_monthly_records_apply (owner only), which takes the rows in (month, metric) order so two
--   saves that touch the same cells cannot wait for each other.
--
-- ROLLBACK (the table has no row yet when this is applied): DROP FUNCTION public.list_kpi_monthly_records(text[]),
--   public.system_upsert_kpi_monthly_records(jsonb), public.admin_set_kpi_monthly_records(uuid,jsonb),
--   private.list_kpi_monthly_records(text[]), private.system_upsert_kpi_monthly_records(jsonb),
--   private.admin_set_kpi_monthly_records(uuid,jsonb), private.kpi_monthly_records_apply(jsonb,boolean);
--   DROP TABLE public.admin_kpi_monthly_records; DROP FUNCTION private.admin_kpi_monthly_records_touch();

-- ACC_S13_BODY_BEGIN
-- 0. The baseline the final assert compares with: this file writes no entry, line, parked row or period. A replay of the assert (tests)
--    pins the current state here first (pinAccountingS13Baseline).
CREATE TEMP TABLE accounting_s13_baseline(payload jsonb) ON COMMIT DROP;
INSERT INTO pg_temp.accounting_s13_baseline(payload)
SELECT pg_catalog.jsonb_build_object(
  'entries', (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries),
  'lines', (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines),
  'pending_events', (SELECT pg_catalog.count(*) FROM public.accounting_pending_events),
  'periods', (SELECT pg_catalog.count(*) FROM public.accounting_periods));

-- 1. The table. metric_key is the name space of the screen: 'src:<source key>' (a source figure) or 'kpi:<kpi key>' (an override).
CREATE TABLE public.admin_kpi_monthly_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  month_key text NOT NULL CONSTRAINT admin_kpi_monthly_records_month_key_check CHECK (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  metric_key text NOT NULL CONSTRAINT admin_kpi_monthly_records_metric_key_check CHECK (metric_key ~ '^(src|kpi):[A-Za-z0-9_]{1,64}$'),
  value numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_kpi_monthly_records_month_key_metric_key_key UNIQUE (month_key, metric_key)
);
CREATE INDEX admin_kpi_monthly_records_month_key_idx ON public.admin_kpi_monthly_records (month_key);
ALTER TABLE public.admin_kpi_monthly_records OWNER TO postgres;
ALTER TABLE public.admin_kpi_monthly_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_kpi_monthly_records FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_kpi_monthly_records TO service_role;
REVOKE ALL ON SEQUENCE public.admin_kpi_monthly_records_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- 2. The update time moves on every update (clock_timestamp: it also moves inside one transaction).
CREATE FUNCTION private.admin_kpi_monthly_records_touch() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_kpi_monthly_records_touch BEFORE UPDATE ON public.admin_kpi_monthly_records
  FOR EACH ROW EXECUTE FUNCTION private.admin_kpi_monthly_records_touch();

-- 3. The tool both writers use (owner only). Checks the whole list first, then writes in (month, metric) order.
CREATE FUNCTION private.kpi_monthly_records_apply(_updates jsonb, _allow_delete boolean) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_written integer := 0;
  r record;
BEGIN
  IF _updates IS NULL OR pg_catalog.jsonb_typeof(_updates) <> 'array' OR pg_catalog.jsonb_array_length(_updates) > 200 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(_updates) AS u(entry)
    WHERE pg_catalog.jsonb_typeof(u.entry) <> 'object'
      OR pg_catalog.jsonb_typeof(u.entry -> 'month_key') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(u.entry -> 'metric_key') IS DISTINCT FROM 'string'
      OR (u.entry ->> 'month_key') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      OR (u.entry ->> 'metric_key') !~ '^(src|kpi):[A-Za-z0-9_]{1,64}$'
      OR COALESCE(pg_catalog.jsonb_typeof(u.entry -> 'value'), 'null') NOT IN ('number', 'null')
      OR (NOT _allow_delete AND COALESCE(pg_catalog.jsonb_typeof(u.entry -> 'value'), 'null') <> 'number')) THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT DISTINCT ON (x.month_key, x.metric_key) x.month_key, x.metric_key, x.amount
    FROM (SELECT u.entry ->> 'month_key' AS month_key, u.entry ->> 'metric_key' AS metric_key, u.entry -> 'value' AS amount, u.ord
      FROM pg_catalog.jsonb_array_elements(_updates) WITH ORDINALITY AS u(entry, ord)) AS x
    ORDER BY x.month_key, x.metric_key, x.ord DESC
  LOOP
    IF r.amount IS NULL OR pg_catalog.jsonb_typeof(r.amount) = 'null' THEN
      DELETE FROM public.admin_kpi_monthly_records AS t WHERE t.month_key = r.month_key AND t.metric_key = r.metric_key;
    ELSE
      INSERT INTO public.admin_kpi_monthly_records AS t (month_key, metric_key, value)
      VALUES (r.month_key, r.metric_key, (r.amount #>> '{}')::numeric)
      ON CONFLICT (month_key, metric_key) DO UPDATE SET value = EXCLUDED.value;
    END IF;
    v_written := v_written + 1;
  END LOOP;
  RETURN v_written;
END;
$$;

-- 4. The writers and the reader (private body + public INVOKER entry).
CREATE FUNCTION private.admin_set_kpi_monthly_records(_actor_id uuid, _updates jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT private.group_g_actor_has_permissions(_actor_id, ARRAY['admin.orders.read']) THEN
    RAISE EXCEPTION 'ACCOUNTING_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN private.kpi_monthly_records_apply(_updates, true);
END;
$$;

CREATE FUNCTION private.system_upsert_kpi_monthly_records(_rows jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN private.kpi_monthly_records_apply(_rows, false);
END;
$$;

CREATE FUNCTION private.list_kpi_monthly_records(_month_keys text[])
RETURNS TABLE(month_key text, metric_key text, value numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF _month_keys IS NULL OR pg_catalog.cardinality(_month_keys) > 24 THEN
    RAISE EXCEPTION 'ACCOUNTING_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT r.month_key, r.metric_key, r.value
  FROM public.admin_kpi_monthly_records AS r
  WHERE r.month_key = ANY (_month_keys)
  ORDER BY r.month_key, r.metric_key;
END;
$$;

CREATE FUNCTION public.admin_set_kpi_monthly_records(_actor_id uuid, _updates jsonb) RETURNS integer
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.admin_set_kpi_monthly_records(_actor_id, _updates) $$;

CREATE FUNCTION public.system_upsert_kpi_monthly_records(_rows jsonb) RETURNS integer
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$ SELECT private.system_upsert_kpi_monthly_records(_rows) $$;

CREATE FUNCTION public.list_kpi_monthly_records(_month_keys text[])
RETURNS TABLE(month_key text, metric_key text, value numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT * FROM private.list_kpi_monthly_records(_month_keys) $$;

-- 5. Owners and EXECUTE. service_role: the three writers / reader (private and public). The update-time trigger function and the
--    tool are owner only.
ALTER FUNCTION private.admin_kpi_monthly_records_touch() OWNER TO postgres;
ALTER FUNCTION private.kpi_monthly_records_apply(jsonb,boolean) OWNER TO postgres;
ALTER FUNCTION private.admin_set_kpi_monthly_records(uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION private.system_upsert_kpi_monthly_records(jsonb) OWNER TO postgres;
ALTER FUNCTION private.list_kpi_monthly_records(text[]) OWNER TO postgres;
ALTER FUNCTION public.admin_set_kpi_monthly_records(uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.system_upsert_kpi_monthly_records(jsonb) OWNER TO postgres;
ALTER FUNCTION public.list_kpi_monthly_records(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  private.admin_kpi_monthly_records_touch(), private.kpi_monthly_records_apply(jsonb,boolean),
  private.admin_set_kpi_monthly_records(uuid,jsonb), private.system_upsert_kpi_monthly_records(jsonb),
  private.list_kpi_monthly_records(text[]),
  public.admin_set_kpi_monthly_records(uuid,jsonb), public.system_upsert_kpi_monthly_records(jsonb),
  public.list_kpi_monthly_records(text[])
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.admin_set_kpi_monthly_records(uuid,jsonb), private.system_upsert_kpi_monthly_records(jsonb),
  private.list_kpi_monthly_records(text[]),
  public.admin_set_kpi_monthly_records(uuid,jsonb), public.system_upsert_kpi_monthly_records(jsonb),
  public.list_kpi_monthly_records(text[])
TO service_role;
-- ACC_S13_BODY_END

-- ACC_S13_FINAL_ASSERT_BEGIN
-- Catalog meaning only (never ACL text). acc_s13_table: the table, its columns in order, its owner. acc_s13_constraints: the
-- constraints, the indexes and the update-time trigger, and nothing else. acc_s13_rls_acl: RLS on, no policy, nothing for PUBLIC / anon /
-- authenticated, SELECT only for service_role (the table and the identity sequence). acc_s13_function_attrs: owner, SECURITY,
-- volatility, language, result, arguments, search_path and EXECUTE, and the text rules (permission check first, 200 and 24 entries,
-- upsert on the pair, delete on null). acc_s13_existing_dml_allowlist: this migration wrote no row, the new table is empty.
DO $acc_s13_final$
DECLARE
  v_failed text;
  v_search_path text;
  v_stage text;
  v_oid oid;
  v_table oid;
  v_seq oid;
  v_src text;
  v_baseline jsonb;
  p record;
  e record;
BEGIN
  v_search_path := pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path', '', true);
  v_stage := 'acc_s13_existing_dml_allowlist';
  IF pg_catalog.to_regclass('pg_temp.accounting_s13_baseline') IS NULL
    OR (SELECT pg_catalog.count(*) FROM pg_temp.accounting_s13_baseline) <> 1 THEN
    v_failed := 'acc_s13_existing_dml_allowlist';
  ELSE
    SELECT b.payload INTO v_baseline FROM pg_temp.accounting_s13_baseline AS b;
    IF pg_catalog.jsonb_typeof(v_baseline) IS DISTINCT FROM 'object'
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['entries', 'lines', 'pending_events', 'periods']) AS k(name)
        WHERE NOT (v_baseline ? k.name)) THEN
      v_failed := 'acc_s13_existing_dml_allowlist';
    END IF;
  END IF;

  v_stage := 'acc_s13_table';
  v_table := pg_catalog.to_regclass('public.admin_kpi_monthly_records');
  IF v_failed IS NULL AND (
    v_table IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
      WHERE c.oid = v_table AND c.relkind = 'r' AND c.relpersistence = 'p' AND c.relowner = 'postgres'::regrole
        AND NOT c.relispartition AND NOT c.relhassubclass)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits AS i WHERE i.inhrelid = v_table)
    OR (SELECT pg_catalog.string_agg(a.attname::text || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
          || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
          || CASE WHEN a.attidentity <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
          || COALESCE(' default ' || pg_catalog.pg_get_expr(d.adbin, d.adrelid), ''), ', ' ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = v_table AND a.attnum > 0 AND NOT a.attisdropped)
      IS DISTINCT FROM 'id bigint not null identity a, month_key text not null, metric_key text not null, value numeric not null, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now()') THEN
    v_failed := 'acc_s13_table';
  END IF;

  v_stage := 'acc_s13_constraints';
  IF v_failed IS NULL AND (
    EXISTS (SELECT 1 FROM (VALUES
      ('admin_kpi_monthly_records_pkey', 'p', 'id'),
      ('admin_kpi_monthly_records_month_key_metric_key_key', 'u', 'month_key,metric_key'),
      ('admin_kpi_monthly_records_month_key_check', 'c', 'CHECK ((month_key ~ ''^[0-9]{4}-(0[1-9]|1[0-2])$''::text))'),
      ('admin_kpi_monthly_records_metric_key_check', 'c', 'CHECK ((metric_key ~ ''^(src|kpi):[A-Za-z0-9_]{1,64}$''::text))')
    ) AS x(name, kind, definition)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = v_table AND c.conname = x.name AND c.contype = x.kind::"char" AND c.convalidated AND NOT c.condeferrable
        AND CASE WHEN c.contype = 'c'
          THEN pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\s+', ' ', 'g')
          ELSE (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
            FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
            JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = k.num) END = x.definition))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = v_table AND c.contype IN ('c', 'p', 'u', 'f', 'x')) <> 4
    -- The indexes: the two that belong to the constraints and the reading index on the month.
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i WHERE i.indrelid = v_table) <> 3
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS x ON x.oid = i.indexrelid
      JOIN pg_catalog.pg_am AS am ON am.oid = x.relam
      WHERE i.indrelid = v_table AND x.relname = 'admin_kpi_monthly_records_month_key_idx' AND NOT i.indisunique
        AND i.indisvalid AND i.indisready AND i.indexprs IS NULL AND i.indpred IS NULL AND am.amname = 'btree'
        AND (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
          FROM pg_catalog.unnest(i.indkey::int2[]) WITH ORDINALITY AS k(num, ord)
          JOIN pg_catalog.pg_attribute AS a ON a.attrelid = i.indrelid AND a.attnum = k.num) = 'month_key') <> 1
    -- The update-time trigger (BEFORE UPDATE, row, enabled) and no other user trigger.
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE g.tgrelid = v_table AND g.tgname = 'admin_kpi_monthly_records_touch'
        AND g.tgfoid = 'private.admin_kpi_monthly_records_touch()'::regprocedure AND g.tgtype = 19
        AND g.tgenabled = 'O' AND NOT g.tgisinternal AND g.tgconstraint = 0 AND NOT g.tgdeferrable
        AND g.tgnargs = 0 AND g.tgqual IS NULL) <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
      WHERE g.tgrelid = v_table AND NOT g.tgisinternal) <> 1) THEN
    v_failed := 'acc_s13_constraints';
  END IF;

  v_stage := 'acc_s13_rls_acl';
  IF v_failed IS NULL THEN
    v_seq := pg_catalog.pg_get_serial_sequence('public.admin_kpi_monthly_records', 'id')::regclass::oid;
  END IF;
  IF v_failed IS NULL AND (
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c WHERE c.oid = v_table AND c.relrowsecurity)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy AS pol WHERE pol.polrelid = v_table)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
      WHERE c.oid = v_table AND (acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
        OR (acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type <> 'SELECT')))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
      WHERE c.oid = v_table AND acl.grantee = 'service_role'::regrole::oid AND acl.privilege_type = 'SELECT')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = v_table AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
      CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS q(privilege)
      WHERE pg_catalog.has_table_privilege(r.role, v_table, q.privilege))
    OR pg_catalog.has_table_privilege('anon', v_table, 'SELECT')
    OR pg_catalog.has_table_privilege('authenticated', v_table, 'SELECT')
    OR NOT pg_catalog.has_table_privilege('service_role', v_table, 'SELECT')
    OR v_seq IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
      CROSS JOIN pg_catalog.unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS q(privilege)
      WHERE pg_catalog.has_sequence_privilege(r.role, v_seq, q.privilege))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class AS s
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(s.relacl, pg_catalog.acldefault('S', s.relowner))) AS acl
      WHERE s.oid = v_seq AND acl.grantee = 0)) THEN
    v_failed := 'acc_s13_rls_acl';
  END IF;

  v_stage := 'acc_s13_function_attrs';
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private', 'admin_kpi_monthly_records_touch()', true, 'v', 'plpgsql', 'trigger', '', false, false, ''),
      ('private', 'kpi_monthly_records_apply(jsonb,boolean)', true, 'v', 'plpgsql', 'integer', '_updates,_allow_delete', false, false, ''),
      ('private', 'admin_set_kpi_monthly_records(uuid,jsonb)', true, 'v', 'plpgsql', 'integer', '_actor_id,_updates', true, false, ''),
      ('private', 'system_upsert_kpi_monthly_records(jsonb)', true, 'v', 'plpgsql', 'integer', '_rows', true, false, ''),
      ('private', 'list_kpi_monthly_records(text[])', true, 's', 'plpgsql', 'record', '_month_keys', true, true, ''),
      ('public', 'admin_set_kpi_monthly_records(uuid,jsonb)', false, 'v', 'sql', 'integer', '_actor_id,_updates', true, false,
        'selectprivate.admin_set_kpi_monthly_records(_actor_id,_updates)'),
      ('public', 'system_upsert_kpi_monthly_records(jsonb)', false, 'v', 'sql', 'integer', '_rows', true, false,
        'selectprivate.system_upsert_kpi_monthly_records(_rows)'),
      ('public', 'list_kpi_monthly_records(text[])', false, 's', 'sql', 'record', '_month_keys', true, true,
        'select*fromprivate.list_kpi_monthly_records(_month_keys)')
    ) AS x(schema_name, signature, definer, volatility, language, result_type, arg_names, service, retset, public_body)
    LOOP
      v_oid := pg_catalog.to_regprocedure(e.schema_name || '.' || e.signature);
      IF v_oid IS NULL THEN v_failed := 'acc_s13_function_attrs'; EXIT; END IF;
      SELECT f.*, l.lanname INTO p FROM pg_catalog.pg_proc AS f JOIN pg_catalog.pg_language AS l ON l.oid = f.prolang
      WHERE f.oid = v_oid;
      IF p.proowner <> 'postgres'::regrole OR p.prosecdef IS DISTINCT FROM e.definer
        OR p.provolatile <> e.volatility::"char" OR p.lanname <> e.language
        OR p.prorettype <> pg_catalog.to_regtype(e.result_type) OR p.proretset IS DISTINCT FROM e.retset
        OR p.prokind <> 'f' OR p.proisstrict OR p.proleakproof
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
        OR COALESCE(pg_catalog.array_to_string(p.proargnames[1:p.pronargs], ','), '') <> e.arg_names
        OR p.pronargdefaults <> 0
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS o
          WHERE o.pronamespace = p.pronamespace AND o.proname = p.proname) <> 1
        OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') IS DISTINCT FROM e.service
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        OR (e.schema_name = 'public' AND pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '[[:space:];]', '', 'g') <> e.public_body) THEN
        v_failed := 'acc_s13_function_attrs'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- The text rules of the private bodies (each text sits on one line of the body).
  IF v_failed IS NULL THEN
    FOR e IN SELECT * FROM (VALUES
      ('private.kpi_monthly_records_apply(jsonb,boolean)', ARRAY[
        '''^[0-9]{4}-(0[1-9]|1[0-2])$''', '''^(src|kpi):[A-Za-z0-9_]{1,64}$''', 'jsonb_array_length(_updates) > 200', 'NOT IN (''number'', ''null'')',
        'NOT _allow_delete', 'ORDER BY x.month_key, x.metric_key, x.ord DESC', 'DELETE FROM public.admin_kpi_monthly_records',
        'ON CONFLICT (month_key, metric_key) DO UPDATE SET value = EXCLUDED.value', '''22023''']),
      ('private.admin_set_kpi_monthly_records(uuid,jsonb)', ARRAY[
        'private.group_g_actor_has_permissions(_actor_id, ARRAY[''admin.orders.read''])', '''ACCOUNTING_FORBIDDEN''', '''42501''',
        'private.kpi_monthly_records_apply(_updates, true)']),
      ('private.system_upsert_kpi_monthly_records(jsonb)', ARRAY['private.kpi_monthly_records_apply(_rows, false)']),
      ('private.list_kpi_monthly_records(text[])', ARRAY['cardinality(_month_keys) > 24', '''22023''', 'ORDER BY r.month_key, r.metric_key']),
      ('private.admin_kpi_monthly_records_touch()', ARRAY['NEW.updated_at := pg_catalog.clock_timestamp()'])
    ) AS x(signature, needles)
    LOOP
      v_src := (SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = pg_catalog.to_regprocedure(e.signature));
      IF v_src IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.unnest(e.needles) AS n(needle) WHERE pg_catalog.strpos(v_src, n.needle) = 0) THEN
        v_failed := 'acc_s13_function_attrs'; EXIT;
      END IF;
    END LOOP;
  END IF;
  -- The permission check comes first; the system writer has none; the reader writes nothing.
  IF v_failed IS NULL THEN
    v_src := (SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = 'private.admin_set_kpi_monthly_records(uuid,jsonb)'::regprocedure);
    IF pg_catalog.strpos(v_src, 'group_g_actor_has_permissions') = 0
      OR pg_catalog.strpos(v_src, 'group_g_actor_has_permissions') > pg_catalog.strpos(v_src, 'kpi_monthly_records_apply') THEN
      v_failed := 'acc_s13_function_attrs';
    END IF;
    v_src := (SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = 'private.system_upsert_kpi_monthly_records(jsonb)'::regprocedure);
    IF v_failed IS NULL AND v_src ~ 'group_g_actor_has_permissions' THEN
      v_failed := 'acc_s13_function_attrs';
    END IF;
    v_src := (SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = 'private.list_kpi_monthly_records(text[])'::regprocedure);
    IF v_failed IS NULL AND v_src ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE|PERFORM|EXECUTE|FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE))\M' THEN
      v_failed := 'acc_s13_function_attrs';
    END IF;
  END IF;

  v_stage := 'acc_s13_existing_dml_allowlist';
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.count(*) FROM public.accounting_journal_entries) IS DISTINCT FROM (v_baseline ->> 'entries')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_journal_lines) IS DISTINCT FROM (v_baseline ->> 'lines')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_pending_events) IS DISTINCT FROM (v_baseline ->> 'pending_events')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.accounting_periods) IS DISTINCT FROM (v_baseline ->> 'periods')::bigint
    OR (SELECT pg_catalog.count(*) FROM public.admin_kpi_monthly_records) <> 0) THEN
    v_failed := 'acc_s13_existing_dml_allowlist';
  END IF;

  PERFORM pg_catalog.set_config('search_path', v_search_path, true);
  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with the DETAIL of the check that was running; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, v_stage, 'acc_s13_table'), HINT = SQLSTATE;
END;
$acc_s13_final$;
-- ACC_S13_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
