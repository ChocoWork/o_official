BEGIN;
-- Accounting plan 1 S1 (FREQ-553 AC-02/03/04, FREQ-559 AC-01/02): tighten the table privileges of the twelve
-- admin_finance_* tables and their eight owned sequences, keep the finance-receipts bucket in a migration, and give
-- every receipt an evidence kind.
--
-- Why: the base migration (20260901102912_remote_schema.sql:4060-4132) granted every privilege on these tables to
-- anon and authenticated, and SELECT, UPDATE, USAGE on their sequences (UPDATE lets a caller advance a sequence).
-- The read of production on 2026-11-04 found the same: all twelve tables still grant DELETE, INSERT, REFERENCES,
-- SELECT, TRIGGER, TRUNCATE, UPDATE to anon and authenticated, RLS is on everywhere, and the policy counts are one on
-- admin_finance_entry_revisions and four on each of the other eleven. The only readers and writers are three routes
-- (src/app/api/admin/kpi/cost-profit/route.ts, .../cost-profit/receipt/route.ts,
-- src/app/api/admin/accounting/product-costs/route.ts), and all of them use createServiceRoleClient only; no path reads
-- or writes these tables with the user JWT (grep -rn "admin_finance_" src scripts, 2026-11-07). So anon and
-- authenticated lose every table privilege, SELECT included, and every sequence privilege. service_role gets ALL on
-- the tables and USAGE, SELECT on the sequences stated explicitly, so a later REVOKE cannot silently drop them.
-- The existing RLS policies (read admin.finance.read, write admin.finance.manage) are not touched: they stay as the
-- second gate even though no table privilege reaches them any more. The trigger function
-- public.record_admin_finance_entry_revision() is SECURITY DEFINER (owner postgres) and keeps writing the history.
-- The twelve tables are listed by name, never picked up from pg_class, so a table added later is not swept in
-- silently; the final assert fails when the admin_finance_% tables (relkind r) differ from these twelve.
-- Out of scope: admin_costing_items and admin_expense_cost_allocations (authenticated already has SELECT only) and
-- admin_kpi_* (plan 2).
--
-- finance-receipts: production has a hand-made bucket; databases built from migrations had none. The upsert keeps
-- the values the receipt route enforces (private, 20 MiB, PDF / JPEG / PNG / WebP / HEIC). Objects already stored are
-- left alone. No policy on storage.objects is created; a policy that names the bucket stops this migration.
--
-- admin_finance_receipts.evidence_kind (electronic / paper / unconfirmed, default unconfirmed) and
-- paper_original_kept (NULL unless the kind is paper). Existing rows are not rewritten: they read as unconfirmed until
-- the owner confirms them. The routes never write unconfirmed.
--
-- BEFORE applying to production (read only; keep the result as the rollback values):
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'finance-receipts';
--   select policyname, qual, with_check from pg_policies where schemaname = 'storage' and tablename = 'objects';
--     -- a policy that names finance-receipts stops this migration at the final assert (intended)
--   select count(*), max((metadata->>'size')::bigint) from storage.objects where bucket_id = 'finance-receipts';
--     -- objects over 20971520 bytes or of another type stay as they are; only new uploads are refused
--   select c.relname, g.grantee, g.privilege_type from information_schema.role_table_grants g
--     join pg_class c on c.relname = g.table_name where g.table_schema = 'public' and g.table_name like 'admin_finance_%'
--     and g.grantee in ('anon', 'authenticated') order by 1, 2, 3;
--   select tablename, count(*) from pg_policies where schemaname = 'public' and tablename like 'admin_finance_%'
--     group by 1 order by 1;   -- expected: entry_revisions 1, the other eleven 4
--
-- ROLLBACK (read the production state first and match it):
--   GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE <the twelve tables below>
--     TO anon, authenticated;   -- production state on 2026-11-04; a fresh local database also had MAINTAIN
--   GRANT SELECT, UPDATE, USAGE ON SEQUENCE <the eight sequences below> TO anon, authenticated;
--   ALTER TABLE public.admin_finance_receipts DROP CONSTRAINT admin_finance_receipts_paper_original_kept_check,
--     DROP CONSTRAINT admin_finance_receipts_evidence_kind_check, DROP COLUMN paper_original_kept,
--     DROP COLUMN evidence_kind;   -- loses every kind recorded after this migration: export them first
--   finance-receipts: put back the row values read before applying. When the bucket did not exist before (a fresh
--   database), remove it through the Storage API only after it is empty. public is never reverted to true.

-- ACC_S1_BODY_BEGIN
REVOKE ALL ON TABLE
  public.admin_finance_entry_review_acks, public.admin_finance_entry_revisions,
  public.admin_finance_evidence_unavailable_records, public.admin_finance_expense_templates,
  public.admin_finance_expenses, public.admin_finance_fixed_assets, public.admin_finance_partners,
  public.admin_finance_receipts, public.admin_finance_seasons, public.admin_finance_summary_options,
  public.admin_finance_year_closings, public.admin_finance_years
FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE
  public.admin_finance_entry_review_acks, public.admin_finance_entry_revisions,
  public.admin_finance_evidence_unavailable_records, public.admin_finance_expense_templates,
  public.admin_finance_expenses, public.admin_finance_fixed_assets, public.admin_finance_partners,
  public.admin_finance_receipts, public.admin_finance_seasons, public.admin_finance_summary_options,
  public.admin_finance_year_closings, public.admin_finance_years
TO service_role;

-- The sequences owned by the twelve tables (pg_depend; remote_schema.sql:1053-1070). The other four tables have
-- natural keys and own no sequence. The final assert compares this list with pg_depend.
REVOKE ALL ON SEQUENCE
  public.admin_finance_entry_review_acks_id_seq, public.admin_finance_entry_revisions_id_seq,
  public.admin_finance_expense_templates_id_seq, public.admin_finance_expenses_id_seq,
  public.admin_finance_fixed_assets_id_seq, public.admin_finance_partners_id_seq,
  public.admin_finance_receipts_id_seq, public.admin_finance_summary_options_id_seq
FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE
  public.admin_finance_entry_review_acks_id_seq, public.admin_finance_entry_revisions_id_seq,
  public.admin_finance_expense_templates_id_seq, public.admin_finance_expenses_id_seq,
  public.admin_finance_fixed_assets_id_seq, public.admin_finance_partners_id_seq,
  public.admin_finance_receipts_id_seq, public.admin_finance_summary_options_id_seq
TO service_role;

ALTER TABLE public.admin_finance_receipts
  ADD COLUMN evidence_kind text NOT NULL DEFAULT 'unconfirmed',
  ADD COLUMN paper_original_kept boolean NULL,
  ADD CONSTRAINT admin_finance_receipts_evidence_kind_check
    CHECK (evidence_kind IN ('electronic', 'paper', 'unconfirmed')),
  ADD CONSTRAINT admin_finance_receipts_paper_original_kept_check
    CHECK (paper_original_kept IS NULL OR evidence_kind = 'paper');

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('finance-receipts', 'finance-receipts', false, 20971520,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 20971520,
  allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
-- ACC_S1_BODY_END

-- ACC_S1_FINAL_ASSERT_BEGIN
-- Compare catalog meaning (ACL entries, has_*_privilege, constraint definitions), never ACL text serialization.
DO $acc_s1_final$
DECLARE
  v_failed text;
  v_tables CONSTANT text[] := ARRAY[
    'admin_finance_entry_review_acks', 'admin_finance_entry_revisions', 'admin_finance_evidence_unavailable_records',
    'admin_finance_expense_templates', 'admin_finance_expenses', 'admin_finance_fixed_assets', 'admin_finance_partners',
    'admin_finance_receipts', 'admin_finance_seasons', 'admin_finance_summary_options', 'admin_finance_year_closings',
    'admin_finance_years'
  ];
  v_sequences CONSTANT text[] := ARRAY[
    'admin_finance_entry_review_acks_id_seq', 'admin_finance_entry_revisions_id_seq',
    'admin_finance_expense_templates_id_seq', 'admin_finance_expenses_id_seq', 'admin_finance_fixed_assets_id_seq',
    'admin_finance_partners_id_seq', 'admin_finance_receipts_id_seq', 'admin_finance_summary_options_id_seq'
  ];
  v_service_table CONSTANT text[] := ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_mime CONSTANT text[] := ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
BEGIN
  -- Exactly the twelve named tables match admin_finance_% (relkind r); each keeps RLS on, gives PUBLIC, anon and
  -- authenticated no table or column ACL entry and no effective privilege, and gives service_role the seven privileges.
  IF (SELECT pg_catalog.array_agg(c.relname::text ORDER BY c.relname::text COLLATE "C") FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'admin\_finance\_%')
      IS DISTINCT FROM (SELECT pg_catalog.array_agg(t ORDER BY t COLLATE "C") FROM pg_catalog.unnest(v_tables) AS t)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(name)
      JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
      WHERE NOT c.relrowsecurity
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS acl
          WHERE acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid))
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) AS acl
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
            AND acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid))
        OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']) AS r(role)
          CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(privilege)
          WHERE pg_catalog.has_table_privilege(r.role, c.oid, p.privilege))
        OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']) AS r(role)
          CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
          WHERE pg_catalog.has_any_column_privilege(r.role, c.oid, p.privilege))
        OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_service_table) AS p(privilege)
          WHERE NOT pg_catalog.has_table_privilege('service_role', c.oid, p.privilege)))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.unnest(v_tables) AS t(name)
      WHERE pg_catalog.to_regclass('public.' || t.name) IS NOT NULL) <> 12 THEN
    v_failed := 'acc_s1_finance_table_acl';
  END IF;

  -- The sequences owned by the twelve tables (pg_depend auto / internal) are exactly the eight named ones; each gives
  -- PUBLIC, anon and authenticated nothing and gives service_role USAGE and SELECT.
  IF v_failed IS NULL AND (
    (SELECT pg_catalog.array_agg(s.relname::text ORDER BY s.relname::text COLLATE "C") FROM pg_catalog.pg_depend AS d
      JOIN pg_catalog.pg_class AS s ON s.oid = d.objid AND s.relkind = 'S'
      WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass
        AND d.deptype IN ('a', 'i')
        AND d.refobjid IN (SELECT pg_catalog.to_regclass('public.' || t)::oid FROM pg_catalog.unnest(v_tables) AS t))
      IS DISTINCT FROM (SELECT pg_catalog.array_agg(q ORDER BY q COLLATE "C") FROM pg_catalog.unnest(v_sequences) AS q)
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_sequences) AS q(name)
      LEFT JOIN pg_catalog.pg_class AS s ON s.oid = pg_catalog.to_regclass('public.' || q.name) AND s.relkind = 'S'
      WHERE s.oid IS NULL
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(s.relacl, pg_catalog.acldefault('s', s.relowner))) AS acl
          WHERE acl.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid))
        OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']) AS r(role)
          CROSS JOIN pg_catalog.unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
          WHERE pg_catalog.has_sequence_privilege(r.role, s.oid, p.privilege))
        OR NOT pg_catalog.has_sequence_privilege('service_role', s.oid, 'USAGE')
        OR NOT pg_catalog.has_sequence_privilege('service_role', s.oid, 'SELECT'))) THEN
    v_failed := 'acc_s1_finance_seq_acl';
  END IF;

  -- finance-receipts is private, 20 MiB, exactly the five types, and no storage.objects policy names it.
  IF v_failed IS NULL AND (
    NOT EXISTS (SELECT 1 FROM storage.buckets AS b
      WHERE b.id = 'finance-receipts' AND b.public IS NOT TRUE AND b.file_size_limit = 20971520
        AND b.allowed_mime_types IS NOT NULL AND pg_catalog.cardinality(b.allowed_mime_types) = 5
        AND b.allowed_mime_types @> v_mime AND b.allowed_mime_types <@ v_mime)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_policies AS p
      WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
        AND (COALESCE(p.qual, '') LIKE '%finance-receipts%' OR COALESCE(p.with_check, '') LIKE '%finance-receipts%'))) THEN
    v_failed := 'acc_s1_bucket';
  END IF;

  -- The two receipt columns and their two validated checks, exactly as the body adds them.
  IF v_failed IS NULL AND (
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_attrdef AS d
        ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.admin_finance_receipts'::regclass AND a.attname = 'evidence_kind' AND NOT a.attisdropped
        AND a.atttypid = 'text'::regtype AND a.attnotnull
        AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '''unconfirmed''::text')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = 'public.admin_finance_receipts'::regclass AND a.attname = 'paper_original_kept'
        AND NOT a.attisdropped AND a.atttypid = 'boolean'::regtype AND NOT a.attnotnull AND NOT a.atthasdef)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.admin_finance_receipts'::regclass AND c.contype = 'c' AND c.convalidated
        AND (c.conname, pg_catalog.pg_get_constraintdef(c.oid)) IN (
          ('admin_finance_receipts_evidence_kind_check',
            'CHECK ((evidence_kind = ANY (ARRAY[''electronic''::text, ''paper''::text, ''unconfirmed''::text])))'),
          ('admin_finance_receipts_paper_original_kept_check',
            'CHECK (((paper_original_kept IS NULL) OR (evidence_kind = ''paper''::text)))'))) <> 2
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.admin_finance_receipts'::regclass AND c.contype = 'c'
        AND (pg_catalog.pg_get_constraintdef(c.oid) LIKE '%evidence_kind%'
          OR pg_catalog.pg_get_constraintdef(c.oid) LIKE '%paper_original_kept%')) <> 2) THEN
    v_failed := 'acc_s1_receipt_columns';
  END IF;

  -- The policies are untouched: one on entry_revisions and four on each of the other eleven, as before S1.
  IF v_failed IS NULL AND EXISTS (SELECT 1 FROM pg_catalog.unnest(v_tables) AS t(name)
    WHERE (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy AS p
      WHERE p.polrelid = pg_catalog.to_regclass('public.' || t.name))
      <> CASE WHEN t.name = 'admin_finance_entry_revisions' THEN 1 ELSE 4 END) THEN
    v_failed := 'acc_s1_policies_unchanged';
  END IF;

  IF v_failed IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000', DETAIL = v_failed;
  END IF;
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM = 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' THEN RAISE; END IF;
  -- An internal error still fails closed with a fixed DETAIL; the HINT carries only the SQLSTATE.
  RAISE EXCEPTION 'ACCOUNTING_MIGRATION_ASSERTION_FAILED' USING ERRCODE = '55000',
    DETAIL = COALESCE(v_failed, 'acc_s1_finance_table_acl'), HINT = SQLSTATE;
END;
$acc_s1_final$;
-- ACC_S1_FINAL_ASSERT_END
NOTIFY pgrst, 'reload schema';
COMMIT;
