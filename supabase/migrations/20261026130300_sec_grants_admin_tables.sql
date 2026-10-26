-- Wave 2 / Task 5: tables that only administrators write keep SELECT for the Data API roles and nothing else
-- (R4-4: SEC-LOOK-003 AC-02 / 004, SEC-NEWS-002 AC-02 / 022, SEC-STOCKIST-003 AC-02 / AC-03 / 008, SEC-ADMIN-002 AC-01).
--
-- Why: looks, look_items, news_articles, stockists and item_color_presets were created with "anon,
-- authenticated, postgres, service_role get all 8 privileges" (remote_schema.sql, no ALTER DEFAULT
-- PRIVILEGES anywhere). The only thing between a logged-in browser and a direct PostgREST write was one
-- RLS policy per statement. Privileges are the first gate; the RLS policies stay as the second.
--   * looks, look_items, news_articles, stockists: anon and authenticated keep SELECT only (the public
--     read policies and the "authenticated ... read" policies still decide which rows are visible).
--   * item_color_presets: authenticated keeps SELECT only. anon gets nothing: the only read policy is
--     "admin item_color_presets read by permission" for authenticated, so anon never saw a row (P5).
--   * stockists_id_seq: anon / authenticated lose USAGE / SELECT / UPDATE; service_role loses UPDATE and keeps USAGE / SELECT
--     (an INSERT through the service role needs nextval).
--   * looks_id_seq, news_articles_id_seq, item_color_presets_id_seq (the identity sequences of looks, news_articles
--     and item_color_presets): anon / authenticated / PUBLIC lose every privilege. An INSERT into an identity column
--     does not check privileges on the sequence, so writes by the service role (or any role holding INSERT) are
--     unaffected; the revoke only stops a direct nextval() / setval() / currval() through the Data API. service_role
--     keeps its grants.
--   * service_role privileges are stated explicitly so a later REVOKE cannot silently remove them.
--   * The "admin ... manage by permission insert / update / delete" policies are NOT dropped (P6): they do
--     not work without the privilege today, and they are a second gate if someone grants it back.
--
-- Order of rollout: the admin routes for stockists and news must already write with the service role
-- (Task 3), because they used the caller's JWT before. Apply this migration after they are deployed.
--
-- Idempotent: REVOKE / GRANT are repeatable.
--
-- ROLLBACK (Task 5; read the production state first and match it):
--   GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE
--     public.looks, public.look_items, public.news_articles, public.stockists, public.item_color_presets TO anon, authenticated;
--   GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.stockists_id_seq TO anon, authenticated;
--   GRANT UPDATE ON SEQUENCE public.stockists_id_seq TO service_role;
--   GRANT SELECT, UPDATE, USAGE ON SEQUENCE public.looks_id_seq, public.news_articles_id_seq,
--     public.item_color_presets_id_seq TO anon, authenticated;
BEGIN;

REVOKE ALL ON TABLE public.looks, public.look_items, public.news_articles, public.stockists,
  public.item_color_presets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.looks, public.look_items, public.news_articles, public.stockists TO anon, authenticated;
GRANT SELECT ON TABLE public.item_color_presets TO authenticated;
GRANT ALL ON TABLE public.looks, public.look_items, public.news_articles, public.stockists,
  public.item_color_presets TO service_role;

REVOKE ALL ON SEQUENCE public.stockists_id_seq FROM PUBLIC, anon, authenticated;
-- remote_schema.sql also gave service_role SELECT, UPDATE, USAGE; UPDATE (setval) is not needed, so drop it.
REVOKE ALL ON SEQUENCE public.stockists_id_seq FROM service_role;
GRANT USAGE, SELECT ON SEQUENCE public.stockists_id_seq TO service_role;

-- Identity sequences: an identity default needs no sequence privilege to insert, so nothing is granted back.
REVOKE ALL ON SEQUENCE public.looks_id_seq, public.news_articles_id_seq, public.item_color_presets_id_seq
  FROM PUBLIC, anon, authenticated;

-- Self check: any failure rolls the whole migration back.
DO $sec_grants_admin_tables_assert$
DECLARE
  v_tables constant text[] := ARRAY[
    'public.looks', 'public.look_items', 'public.news_articles', 'public.stockists', 'public.item_color_presets'
  ];
  v_write_privileges constant text[] :=
    ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
  v_sequences constant text[] := ARRAY[
    'public.stockists_id_seq', 'public.looks_id_seq', 'public.news_articles_id_seq', 'public.item_color_presets_id_seq'
  ];
  v_sequence text;
  v_role text;
  v_table text;
  v_privilege text;
  v_expect_select boolean;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_table IN ARRAY v_tables LOOP
      -- (a) no write-side privilege at table or column level
      FOREACH v_privilege IN ARRAY v_write_privileges LOOP
        IF has_table_privilege(v_role, v_table, v_privilege) THEN
          RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
            USING ERRCODE = '55000', DETAIL = 'sec_grants_admin_tables:write:' || v_table || ':' || v_role;
        END IF;
      END LOOP;
      IF has_any_column_privilege(v_role, v_table, 'INSERT')
         OR has_any_column_privilege(v_role, v_table, 'UPDATE')
         OR has_any_column_privilege(v_role, v_table, 'REFERENCES') THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_admin_tables:column_write:' || v_table || ':' || v_role;
      END IF;

      -- (b) SELECT: everywhere for the four public tables, authenticated only for item_color_presets
      v_expect_select := v_table <> 'public.item_color_presets' OR v_role = 'authenticated';
      IF has_table_privilege(v_role, v_table, 'SELECT') IS DISTINCT FROM v_expect_select THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_admin_tables:select:' || v_table || ':' || v_role;
      END IF;
    END LOOP;

    -- (c) the sequences (stockists and the three identity sequences): nothing
    FOREACH v_sequence IN ARRAY v_sequences LOOP
      FOREACH v_privilege IN ARRAY ARRAY['USAGE', 'SELECT', 'UPDATE'] LOOP
        IF has_sequence_privilege(v_role, v_sequence, v_privilege) THEN
          RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
            USING ERRCODE = '55000', DETAIL = 'sec_grants_admin_tables:sequence:' || v_sequence || ':' || v_role;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- (d) service_role keeps the four row operations on the five tables and the sequence
  FOREACH v_table IN ARRAY v_tables LOOP
    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_table, v_privilege) THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_admin_tables:service_role:' || v_table;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT (
    has_sequence_privilege('service_role', 'public.stockists_id_seq', 'USAGE')
    AND has_sequence_privilege('service_role', 'public.stockists_id_seq', 'SELECT')
    AND NOT has_sequence_privilege('service_role', 'public.stockists_id_seq', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
      USING ERRCODE = '55000', DETAIL = 'sec_grants_admin_tables:service_role_sequence';
  END IF;

  -- (e) the RLS write policies stay (second gate): insert, update and delete for each table
  FOREACH v_table IN ARRAY v_tables LOOP
    FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = split_part(v_table, '.', 2)
          AND cmd = v_privilege
          AND policyname LIKE 'admin % manage by permission %'
      ) THEN
        RAISE EXCEPTION 'SEC_WAVE2_MIGRATION_ASSERTION_FAILED'
          USING ERRCODE = '55000', DETAIL = 'sec_grants_admin_tables:policy:' || v_table || ':' || v_privilege;
      END IF;
    END LOOP;
  END LOOP;
END
$sec_grants_admin_tables_assert$;

NOTIFY pgrst, 'reload schema';
COMMIT;
