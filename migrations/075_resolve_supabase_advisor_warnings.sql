-- Resolve Supabase Advisor findings without broadening Data API access.
BEGIN;

-- These tables are intentionally accessed only through the service role.
-- Explicit deny policies document that boundary and avoid an ambiguous RLS state.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'admin_kpi_targets',
    'audit_logs_backups',
    'checkout_drafts',
    'postal_code_cache',
    'refresh_token_history',
    'stripe_webhook_events'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'deny direct client access',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      'deny direct client access',
      table_name
    );
  END LOOP;
END;
$$;

-- A management FOR ALL policy overlaps the read policy on SELECT. Preserve the
-- same write checks while splitting management access by write operation.
DO $$
DECLARE
  policy_row record;
BEGIN
  FOR policy_row IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd = 'ALL'
      AND roles = ARRAY['authenticated']::name[]
      AND policyname IN (
        'admin finance expense templates manage',
        'admin finance expenses manage',
        'admin finance fixed assets manage',
        'admin finance partners manage',
        'admin finance receipts manage',
        'admin finance seasons manage',
        'admin finance year closings manage',
        'admin finance years manage',
        'admin product costs manage',
        'admin item_color_presets manage by permission',
        'admin items manage by permission',
        'admin look_items manage by permission',
        'admin looks manage by permission',
        'admin news manage by permission',
        'admin order items manage by permission',
        'admin orders manage by permission',
        'admin stockists manage by permission',
        'acl user_roles managed'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON %I.%I',
      policy_row.policyname,
      policy_row.schemaname,
      policy_row.tablename
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR INSERT TO authenticated WITH CHECK (%s)',
      policy_row.policyname || ' insert',
      policy_row.schemaname,
      policy_row.tablename,
      policy_row.with_check
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
      policy_row.policyname || ' update',
      policy_row.schemaname,
      policy_row.tablename,
      policy_row.qual,
      policy_row.with_check
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR DELETE TO authenticated USING (%s)',
      policy_row.policyname || ' delete',
      policy_row.schemaname,
      policy_row.tablename,
      policy_row.qual
    );
  END LOOP;
END;
$$;

-- Public rows remain available to anonymous users. Authenticated users use one
-- combined policy, avoiding duplicate permissive SELECT evaluation.
DROP POLICY IF EXISTS "Anyone can view published items" ON public.items;
CREATE POLICY "Anyone can view published items"
  ON public.items FOR SELECT TO anon
  USING (status = 'published');
DROP POLICY IF EXISTS "admin items read by permission" ON public.items;
CREATE POLICY "authenticated items read"
  ON public.items FOR SELECT TO authenticated
  USING (status = 'published' OR public.has_permission('admin.items.read'));

DROP POLICY IF EXISTS "Anyone can view published looks" ON public.looks;
CREATE POLICY "Anyone can view published looks"
  ON public.looks FOR SELECT TO anon
  USING (status = 'published');
DROP POLICY IF EXISTS "admin looks read by permission" ON public.looks;
CREATE POLICY "authenticated looks read"
  ON public.looks FOR SELECT TO authenticated
  USING (status = 'published' OR public.has_permission('admin.looks.read'));

DROP POLICY IF EXISTS "Anyone can view look items for published looks" ON public.look_items;
CREATE POLICY "Anyone can view look items for published looks"
  ON public.look_items FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.looks
    WHERE looks.id = look_items.look_id AND looks.status = 'published'
  ));
DROP POLICY IF EXISTS "admin look_items read by permission" ON public.look_items;
CREATE POLICY "authenticated look items read"
  ON public.look_items FOR SELECT TO authenticated
  USING (
    public.has_permission('admin.looks.read')
    OR EXISTS (
      SELECT 1 FROM public.looks
      WHERE looks.id = look_items.look_id AND looks.status = 'published'
    )
  );

DROP POLICY IF EXISTS "Anyone can view published news articles" ON public.news_articles;
CREATE POLICY "Anyone can view published news articles"
  ON public.news_articles FOR SELECT TO anon
  USING (status = 'published');
DROP POLICY IF EXISTS "admin news read by permission" ON public.news_articles;
CREATE POLICY "authenticated news read"
  ON public.news_articles FOR SELECT TO authenticated
  USING (status = 'published' OR public.has_permission('admin.news.read'));

DROP POLICY IF EXISTS "public stockists read published" ON public.stockists;
CREATE POLICY "public stockists read published"
  ON public.stockists FOR SELECT TO anon
  USING (status = 'published');
DROP POLICY IF EXISTS "admin stockists read by permission" ON public.stockists;
CREATE POLICY "authenticated stockists read"
  ON public.stockists FOR SELECT TO authenticated
  USING (status = 'published' OR public.has_permission('admin.stockists.read'));

DROP POLICY IF EXISTS "Users can view their own orders" ON public.orders;
CREATE POLICY "Users can view their own orders"
  ON public.orders FOR SELECT TO anon
  USING (session_id = current_setting('app.session_id', true));
DROP POLICY IF EXISTS "admin orders read by permission" ON public.orders;
CREATE POLICY "authenticated orders read"
  ON public.orders FOR SELECT TO authenticated
  USING (
    public.has_permission('admin.orders.read')
    OR (SELECT auth.uid()) = user_id
    OR session_id = current_setting('app.session_id', true)
  );

DROP POLICY IF EXISTS "Users can view their own order items" ON public.order_items;
CREATE POLICY "Users can view their own order items"
  ON public.order_items FOR SELECT TO anon
  USING (EXISTS (
    SELECT 1 FROM public.orders AS own_order
    WHERE own_order.id = order_items.order_id
      AND own_order.session_id = current_setting('app.session_id', true)
  ));
DROP POLICY IF EXISTS "admin order items read by permission" ON public.order_items;
CREATE POLICY "authenticated order items read"
  ON public.order_items FOR SELECT TO authenticated
  USING (
    public.has_permission('admin.orders.read')
    OR EXISTS (
      SELECT 1 FROM public.orders AS own_order
      WHERE own_order.id = order_items.order_id
        AND (
          own_order.user_id = (SELECT auth.uid())
          OR own_order.session_id = current_setting('app.session_id', true)
        )
    )
  );

-- Fix function name resolution to trusted schemas only. Existing function
-- bodies remain unchanged and retain their current execution semantics.
DO $$
DECLARE
  function_row record;
BEGIN
  FOR function_row IN
    SELECT
      namespace.nspname AS schema_name,
      procedure.oid::regprocedure AS function_identity
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE (namespace.nspname, procedure.proname) IN (
      ('public', 'set_news_articles_updated_at'),
      ('security', 'count_recent_events'),
      ('public', 'current_app_role'),
      ('public', 'update_admin_kpi_targets_updated_at'),
      ('public', 'create_profile_for_new_auth_user'),
      ('public', 'update_admin_finance_updated_at'),
      ('public', 'set_items_updated_at'),
      ('public', 'update_stockists_updated_at'),
      ('public', 'set_looks_updated_at'),
      ('public', 'update_orders_updated_at'),
      ('public', 'search_looks'),
      ('public', 'search_news'),
      ('public', 'search_items'),
      ('public', 'get_popular_items')
    )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path TO %I, public, pg_temp',
      function_row.function_identity,
      function_row.schema_name
    );
  END LOOP;
END;
$$;

COMMIT;
