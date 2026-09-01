-- スキーマの正規化スナップショット。
--
-- 本番（Supabase MCP 経由）とローカル（pg 経由）の双方で同じ SQL を流し、
-- 出力テキストを突き合わせて差分ゼロを確認するために使う。
-- 「ダンプが本番を再現できているか」を機械的に判定するのが目的。
--
-- kind / name / def の 3 列を決定的な順序で返す。
SELECT kind, name, def FROM (
  -- 拡張
  SELECT 'extension' AS kind, e.extname AS name,
         e.extname || ' @ ' || n.nspname AS def
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace

  UNION ALL
  -- 列（型・NOT NULL・既定値）
  SELECT 'column', c.table_name || '.' || c.column_name,
         c.data_type
           || coalesce('(' || c.character_maximum_length || ')', '')
           || ' null=' || c.is_nullable
           || ' default=' || coalesce(c.column_default, '-')
    FROM information_schema.columns c
   WHERE c.table_schema = 'public'

  UNION ALL
  -- 制約（PK / UNIQUE / FK / CHECK）
  SELECT 'constraint', rel.relname || '.' || con.conname,
         pg_get_constraintdef(con.oid)
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = con.connamespace
   WHERE n.nspname = 'public'

  UNION ALL
  -- 索引
  SELECT 'index', i.tablename || '.' || i.indexname, i.indexdef
    FROM pg_indexes i
   WHERE i.schemaname = 'public'

  UNION ALL
  -- 関数・プロシージャ（本体込み）
  SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')

  UNION ALL
  -- トリガー
  SELECT 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal

  UNION ALL
  -- RLS の有効/無効
  SELECT 'rls', c.relname, CASE WHEN c.relrowsecurity THEN 'enabled' ELSE 'disabled' END
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'

  UNION ALL
  -- RLS ポリシー
  SELECT 'policy', p.tablename || '.' || p.policyname,
         p.cmd || ' roles=' || array_to_string(p.roles, ',')
           || ' using=' || coalesce(p.qual, '-')
           || ' check=' || coalesce(p.with_check, '-')
    FROM pg_policies p
   WHERE p.schemaname = 'public'

  UNION ALL
  -- 関数の実行権限（091 / 092 で service_role 限定にした箇所の検証に要る）
  SELECT 'function_acl', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         coalesce(array_to_string(p.proacl::text[], ' | '), 'default')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')

  UNION ALL
  -- 列挙型
  SELECT 'enum', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE n.nspname = 'public'
   GROUP BY t.typname
) s
ORDER BY kind, name, def;
