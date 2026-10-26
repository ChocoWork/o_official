-- Wave 2 / Task 4: tighten table, column and sequence privileges (R4: SEC-HOME-004/005/020, SEC-HOME-003 AC-02, SEC-AUTH-011).
--
-- Why: every public table was created with "anon, authenticated, postgres, service_role get all 8
-- privileges" (remote_schema.sql, no ALTER DEFAULT PRIVILEGES anywhere), so one wrong RLS policy
-- would open a table. Privileges are the first gate; RLS is the second.
--   1. items: anon / authenticated lose every table privilege and get SELECT on 21 columns only.
--      pattern_cost and mass_production_cost (cost) stay unreadable; product_note is customer-facing
--      and stays public (Q7). No INSERT / UPDATE / DELETE is granted back: admin writes go through
--      the service role.
--   2. item_cost_history: the PUBLIC "Allow all" policy goes away. Only authenticated gets SELECT, and
--      the RLS policy narrows it to admin.finance.read. Writes are service role only. Nothing in
--      src/ or scripts/ reads this table today (Task 4 report).
--   3. sessions, password_reset_tokens, rate_limit_counters, audit_logs, audit_logs_backups and the
--      sequence rate_limit_counters_id_seq: anon / authenticated get nothing. The RLS "deny" policies
--      stay as a second gate. Every caller already uses the service role or a SECURITY DEFINER function.
--   4. profiles: anon loses everything, authenticated loses TRUNCATE / REFERENCES / TRIGGER / MAINTAIN
--      (keeps SELECT / INSERT / UPDATE / DELETE, because /api/profile writes with the user's JWT).
--   5. legal_archive_runs, order_revisions, stripe_balance_transactions, stripe_payouts, stripe_refunds (and the
--      sequence order_revisions_id_seq, found through pg_depend): anon / authenticated lose INSERT, UPDATE, DELETE,
--      TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, and every privilege on the owned sequences (PUBLIC too). SELECT is
--      not touched (checked read-only against production through the Supabase MCP):
--        - the five tables: production already has no write-side privilege for anon / authenticated (authenticated has
--          SELECT only on legal_archive_runs and order_revisions; anon and authenticated have no grant at all on the
--          three stripe_* tables), so for them this only makes a fresh database (db reset, staging) match production;
--        - order_revisions_id_seq: production still has anon = authenticated = SELECT, UPDATE, USAGE (remote_schema.sql),
--          so for the sequence this is a real change in production, not only a fresh-database fix.
--      Read access is deliberately left alone: on a fresh database anon can still SELECT the five tables and
--      authenticated can still SELECT the three stripe_* tables, which production does not grant. Nothing in src/ uses
--      those grants, RLS is on, the stripe_* tables have no read policy and the two read policies (legal_archive_runs,
--      order_revisions) are for authenticated only, so no rows are exposed; revoking the extra reads is a separate decision.
--      Callers: legal_archive_runs is
--      read with the user JWT by /api/admin/legal-archive/status (authenticated keeps SELECT) and written by the
--      cron route with the service role; order_revisions is written only by the SECURITY DEFINER trigger
--      private.record_order_revision and read by the legal-archive export (service role); the three stripe_*
--      tables are read and written with the service role only. service_role keeps every grant it has.
--   service_role privileges are stated explicitly so a later REVOKE cannot silently remove them.
--
-- New columns on items are NOT visible to anon / authenticated until a migration grants them
-- (safe side). The self check below fails the migration when items has a column that is neither in
-- the grant list nor a cost column.
--
-- Idempotent: REVOKE / GRANT are repeatable, the policy is dropped before it is created.
--
-- ROLLBACK (Task 4; read the production state first and match it):
--   DROP POLICY IF EXISTS "admin item_cost_history read by finance permission" ON public.item_cost_history;
--   CREATE POLICY "Allow all" ON public.item_cost_history FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
--   REVOKE SELECT (id, name, description, price, category, image_url, image_urls, colors, sizes, product_details, status,
--     created_at, updated_at, material, origin, sewing_region, care, season, product_note, made_to_order_lead_days,
--     return_ineligible) ON TABLE public.items FROM anon, authenticated;
--   GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE
--     public.items, public.item_cost_history, public.sessions, public.password_reset_tokens,
--     public.rate_limit_counters, public.audit_logs, public.audit_logs_backups, public.profiles TO anon, authenticated;
--   GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.rate_limit_counters_id_seq TO anon, authenticated;
--   -- Section 5. The two table lines restore the state before this migration on a local / fresh database
--   -- (anon: all privileges on the five tables; authenticated: all on the three stripe_* tables, SELECT only on
--   -- legal_archive_runs and order_revisions). Production already has no write-side privilege on the tables:
--   -- do NOT run the two table lines there. The sequence line is production's own state before this migration.
--   GRANT DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON TABLE public.legal_archive_runs,
--     public.order_revisions, public.stripe_balance_transactions, public.stripe_payouts, public.stripe_refunds
--     TO anon;
--   GRANT DELETE, INSERT, MAINTAIN, REFERENCES, TRIGGER, TRUNCATE, UPDATE ON TABLE
--     public.stripe_balance_transactions, public.stripe_payouts, public.stripe_refunds TO authenticated;
--   GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.order_revisions_id_seq TO anon, authenticated;
BEGIN;

-- 1. items: column level SELECT, cost columns excluded
REVOKE ALL ON TABLE public.items FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, name, description, price, category, image_url, image_urls, colors, sizes, product_details,
              status, created_at, updated_at, material, origin, sewing_region, care, season, product_note,
              made_to_order_lead_days, return_ineligible)
  ON TABLE public.items TO anon, authenticated;
GRANT ALL ON TABLE public.items TO service_role;

-- 2. item_cost_history: administrators (admin.finance.read) may read; nobody else
DROP POLICY IF EXISTS "Allow all" ON public.item_cost_history;
REVOKE ALL ON TABLE public.item_cost_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.item_cost_history TO authenticated;
GRANT ALL ON TABLE public.item_cost_history TO service_role;
DROP POLICY IF EXISTS "admin item_cost_history read by finance permission" ON public.item_cost_history;
CREATE POLICY "admin item_cost_history read by finance permission" ON public.item_cost_history
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission('admin.finance.read'::text)));

-- 3. authentication tables and the counter sequence: service role only
REVOKE ALL ON TABLE public.sessions, public.password_reset_tokens, public.rate_limit_counters,
  public.audit_logs, public.audit_logs_backups FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.sessions, public.password_reset_tokens, public.rate_limit_counters,
  public.audit_logs, public.audit_logs_backups TO service_role;
REVOKE ALL ON SEQUENCE public.rate_limit_counters_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.rate_limit_counters_id_seq TO service_role;

-- 4. profiles: no anon access; authenticated keeps only the four row operations
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.profiles FROM authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;

-- 5. ledger and archive tables: Data API roles keep SELECT (where they had it) and lose every write-side privilege
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.legal_archive_runs,
  public.order_revisions, public.stripe_balance_transactions, public.stripe_payouts, public.stripe_refunds
  FROM anon, authenticated;
DO $sec_grants_hardening_owned_sequences$
DECLARE
  v_sequence regclass;
BEGIN
  FOR v_sequence IN
    SELECT s.oid::regclass
    FROM pg_depend AS d
    JOIN pg_class AS s ON s.oid = d.objid AND s.relkind = 'S'
    WHERE d.classid = 'pg_class'::regclass
      AND d.deptype IN ('a', 'i')
      AND d.refobjid = ANY (ARRAY[
        'public.legal_archive_runs'::regclass, 'public.order_revisions'::regclass,
        'public.stripe_balance_transactions'::regclass, 'public.stripe_payouts'::regclass,
        'public.stripe_refunds'::regclass
      ])
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', v_sequence);
  END LOOP;
END
$sec_grants_hardening_owned_sequences$;

-- 6. Self check: any failure rolls the whole migration back.
DO $sec_grants_hardening_assert$
DECLARE
  v_granted constant text[] := ARRAY[
    'id', 'name', 'description', 'price', 'category', 'image_url', 'image_urls', 'colors', 'sizes',
    'product_details', 'status', 'created_at', 'updated_at', 'material', 'origin', 'sewing_region',
    'care', 'season', 'product_note', 'made_to_order_lead_days', 'return_ineligible'
  ];
  v_cost constant text[] := ARRAY['pattern_cost', 'mass_production_cost'];
  v_all_privileges constant text[] :=
    ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  v_write_privileges constant text[] :=
    ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  v_auth_tables constant text[] := ARRAY[
    'public.sessions', 'public.password_reset_tokens', 'public.rate_limit_counters',
    'public.audit_logs', 'public.audit_logs_backups'
  ];
  v_service_tables constant text[] := ARRAY[
    'public.items', 'public.item_cost_history', 'public.sessions', 'public.password_reset_tokens',
    'public.rate_limit_counters', 'public.audit_logs', 'public.audit_logs_backups', 'public.profiles'
  ];
  v_ledger_tables constant text[] := ARRAY[
    'public.legal_archive_runs', 'public.order_revisions', 'public.stripe_balance_transactions',
    'public.stripe_payouts', 'public.stripe_refunds'
  ];
  v_role text;
  v_table text;
  v_privilege text;
  v_column text;
  v_sequence regclass;
BEGIN
  -- (a) no column of items is left out: every column is in the grant list or is a cost column,
  --     and every listed column really exists
  IF EXISTS (
    SELECT 1
    FROM pg_attribute AS a
    WHERE a.attrelid = 'public.items'::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND NOT (a.attname = ANY (v_granted))
      AND NOT (a.attname = ANY (v_cost))
  ) OR EXISTS (
    SELECT 1
    FROM unnest(v_granted || v_cost) AS listed(column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_attribute AS a
      WHERE a.attrelid = 'public.items'::regclass
        AND a.attname = listed.column_name
        AND a.attnum > 0
        AND NOT a.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:items_columns';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- (b) cost columns unreadable, listed columns readable
    FOREACH v_column IN ARRAY v_cost LOOP
      IF has_column_privilege(v_role, 'public.items', v_column, 'SELECT') THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:items_cost_readable:' || v_role;
      END IF;
    END LOOP;
    FOREACH v_column IN ARRAY v_granted LOOP
      IF NOT has_column_privilege(v_role, 'public.items', v_column, 'SELECT') THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:items_column_missing:' || v_role;
      END IF;
    END LOOP;

    -- (c) items: SELECT is column level only; no write-side privilege at table or column level
    IF has_table_privilege(v_role, 'public.items', 'SELECT') THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:items_table_select:' || v_role;
    END IF;
    FOREACH v_privilege IN ARRAY v_write_privileges LOOP
      IF has_table_privilege(v_role, 'public.items', v_privilege) THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:items_write:' || v_role;
      END IF;
    END LOOP;
    IF has_any_column_privilege(v_role, 'public.items', 'INSERT')
       OR has_any_column_privilege(v_role, 'public.items', 'UPDATE')
       OR has_any_column_privilege(v_role, 'public.items', 'REFERENCES') THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:items_column_write:' || v_role;
    END IF;

    -- (d) authentication tables and the sequence: nothing
    FOREACH v_table IN ARRAY v_auth_tables LOOP
      FOREACH v_privilege IN ARRAY v_all_privileges LOOP
        IF has_table_privilege(v_role, v_table, v_privilege) THEN
          RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
            USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:auth_table:' || v_table || ':' || v_role;
        END IF;
      END LOOP;
    END LOOP;
    FOREACH v_privilege IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
      IF has_sequence_privilege(v_role, 'public.rate_limit_counters_id_seq', v_privilege) THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:sequence:' || v_role;
      END IF;
    END LOOP;
  END LOOP;

  -- (e) profiles
  FOREACH v_privilege IN ARRAY v_all_privileges LOOP
    IF has_table_privilege('anon', 'public.profiles', v_privilege) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:profiles_anon';
    END IF;
  END LOOP;
  FOREACH v_privilege IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
    IF has_table_privilege('authenticated', 'public.profiles', v_privilege) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:profiles_authenticated_extra';
    END IF;
  END LOOP;
  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('authenticated', 'public.profiles', v_privilege) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:profiles_authenticated_missing';
    END IF;
  END LOOP;

  -- (f) item_cost_history: anon nothing, authenticated SELECT only, one finance policy, no "Allow all"
  FOREACH v_privilege IN ARRAY v_all_privileges LOOP
    IF has_table_privilege('anon', 'public.item_cost_history', v_privilege) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:cost_history_anon';
    END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.item_cost_history', 'SELECT') THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:cost_history_select_missing';
  END IF;
  FOREACH v_privilege IN ARRAY v_write_privileges LOOP
    IF has_table_privilege('authenticated', 'public.item_cost_history', v_privilege) THEN
      RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
        USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:cost_history_authenticated_write';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_cost_history' AND policyname = 'Allow all'
  ) OR (
    SELECT count(*) FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'item_cost_history'
      AND policyname = 'admin item_cost_history read by finance permission'
      AND cmd = 'SELECT' AND roles = ARRAY['authenticated']::name[]
  ) <> 1 THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:cost_history_policy';
  END IF;

  -- (h) ledger and archive tables: no write-side privilege (table or column level) for anon / authenticated,
  --     and nothing on the sequences they own
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_table IN ARRAY v_ledger_tables LOOP
      FOREACH v_privilege IN ARRAY v_write_privileges LOOP
        IF has_table_privilege(v_role, v_table, v_privilege) THEN
          RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
            USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:ledger_write:' || v_table || ':' || v_role;
        END IF;
      END LOOP;
      IF has_any_column_privilege(v_role, v_table, 'INSERT')
         OR has_any_column_privilege(v_role, v_table, 'UPDATE')
         OR has_any_column_privilege(v_role, v_table, 'REFERENCES') THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:ledger_column_write:' || v_table || ':' || v_role;
      END IF;
    END LOOP;
    FOR v_sequence IN
      SELECT s.oid::regclass
      FROM pg_depend AS d
      JOIN pg_class AS s ON s.oid = d.objid AND s.relkind = 'S'
      WHERE d.classid = 'pg_class'::regclass
        AND d.deptype IN ('a', 'i')
        AND d.refobjid = ANY (SELECT t::regclass::oid FROM unnest(v_ledger_tables) AS t)
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
        IF has_sequence_privilege(v_role, v_sequence, v_privilege) THEN
          RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
            USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:ledger_sequence:' || v_sequence || ':' || v_role;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  -- legal_archive_runs is read with the user JWT (finance policy): authenticated keeps SELECT
  IF NOT has_table_privilege('authenticated', 'public.legal_archive_runs', 'SELECT') THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:legal_archive_runs_select_missing';
  END IF;

  -- (g) service_role keeps the four row operations on all 8 tables and the sequence
  FOREACH v_table IN ARRAY v_service_tables LOOP
    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_table, v_privilege) THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:service_role:' || v_table;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT (
    has_sequence_privilege('service_role', 'public.rate_limit_counters_id_seq', 'USAGE')
    AND has_sequence_privilege('service_role', 'public.rate_limit_counters_id_seq', 'SELECT')
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_grants_hardening:service_role_sequence';
  END IF;
END
$sec_grants_hardening_assert$;

NOTIFY pgrst, 'reload schema';
COMMIT;
