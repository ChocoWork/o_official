-- Supabase advisor の性能 WARN 2種を直す（FREQ-382）。ほかの advisor の指摘には触れない。
--
-- 1. auth_rls_initplan（WARN・lint 0003）15件
--    auth.uid() と current_setting('app.session_id', true) を行ごとに評価していた。
--    (SELECT ...) で包み、文ごとに1回だけ評価させる（InitPlan）。どちらも1文の間は値が変わらないので、
--    見える行・書ける行は変わらない。ALTER POLICY で式だけ差し替え、名前・対象ロール・コマンドはそのまま。
--    式は包む以外、本番の定義（pg_policies）のまま写した。
-- 2. multiple_permissive_policies（WARN・lint 0006）3件
--    会計3表の manage が FOR ALL のため、SELECT で read と重なり、読むたびに両方を評価していた。
--    migration 075 がほかの会計表で行ったのと同じく、manage を INSERT / UPDATE / DELETE に分ける（条件は同じ）。
--    SELECT は read だけで判定する。本番で admin.finance.manage を持つのは admin ロールだけで、
--    admin は admin.finance.read も持つ（2026-09-19 確認）ため、読める範囲は変わらない。
--    アプリはこの3表を service role で読み書きしており（RLS を通らない）、アプリの動作は変わらない。

BEGIN;

-- 1. auth_rls_initplan

ALTER POLICY "Users can view their own wishlist" ON public.wishlist
  USING (
    ((SELECT auth.uid()) = user_id)
    OR ((user_id IS NULL) AND (session_id IS NOT NULL) AND (session_id = (SELECT current_setting('app.session_id', true))))
  );
ALTER POLICY "Users can insert items to their wishlist" ON public.wishlist
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
    OR ((user_id IS NULL) AND (session_id IS NOT NULL) AND (session_id = (SELECT current_setting('app.session_id', true))))
  );
ALTER POLICY "Users can delete from their wishlist" ON public.wishlist
  USING (
    ((SELECT auth.uid()) = user_id)
    OR ((user_id IS NULL) AND (session_id IS NOT NULL) AND (session_id = (SELECT current_setting('app.session_id', true))))
  );

ALTER POLICY "Users can view their own cart" ON public.carts
  USING (
    ((SELECT auth.uid()) = user_id)
    OR ((user_id IS NULL) AND (session_id = (SELECT current_setting('app.session_id', true))))
  );
ALTER POLICY "Users can insert their own cart items" ON public.carts
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
    OR ((user_id IS NULL) AND (session_id = (SELECT current_setting('app.session_id', true))))
  );
ALTER POLICY "Users can update their own cart items" ON public.carts
  USING (
    ((SELECT auth.uid()) = user_id)
    OR ((user_id IS NULL) AND (session_id = (SELECT current_setting('app.session_id', true))))
  )
  WITH CHECK (
    ((SELECT auth.uid()) = user_id)
    OR ((user_id IS NULL) AND (session_id = (SELECT current_setting('app.session_id', true))))
  );
ALTER POLICY "Users can delete their own cart items" ON public.carts
  USING (
    ((SELECT auth.uid()) = user_id)
    OR ((user_id IS NULL) AND (session_id = (SELECT current_setting('app.session_id', true))))
  );

ALTER POLICY "Users can view own profile" ON public.profiles
  USING ((SELECT auth.uid()) = user_id);
ALTER POLICY "Users can insert own profile" ON public.profiles
  WITH CHECK ((SELECT auth.uid()) = user_id);
ALTER POLICY "Users can update own profile" ON public.profiles
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
ALTER POLICY "Users can delete own profile" ON public.profiles
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can view their own orders" ON public.orders
  USING (session_id = (SELECT current_setting('app.session_id', true)));
ALTER POLICY "authenticated orders read" ON public.orders
  USING (
    public.has_permission('admin.orders.read')
    OR ((SELECT auth.uid()) = user_id)
    OR (session_id = (SELECT current_setting('app.session_id', true)))
  );

ALTER POLICY "Users can view their own order items" ON public.order_items
  USING (EXISTS (
    SELECT 1 FROM public.orders AS own_order
    WHERE own_order.id = order_items.order_id
      AND own_order.session_id = (SELECT current_setting('app.session_id', true))
  ));
ALTER POLICY "authenticated order items read" ON public.order_items
  USING (
    public.has_permission('admin.orders.read')
    OR EXISTS (
      SELECT 1 FROM public.orders AS own_order
      WHERE own_order.id = order_items.order_id
        AND (
          own_order.user_id = (SELECT auth.uid())
          OR own_order.session_id = (SELECT current_setting('app.session_id', true))
        )
    )
  );

-- 2. multiple_permissive_policies

DROP POLICY "admin finance entry review acks manage" ON public.admin_finance_entry_review_acks;
CREATE POLICY "admin finance entry review acks manage insert" ON public.admin_finance_entry_review_acks
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('admin.finance.manage'));
CREATE POLICY "admin finance entry review acks manage update" ON public.admin_finance_entry_review_acks
  FOR UPDATE TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));
CREATE POLICY "admin finance entry review acks manage delete" ON public.admin_finance_entry_review_acks
  FOR DELETE TO authenticated
  USING (public.has_permission('admin.finance.manage'));

DROP POLICY "admin finance evidence unavailable manage" ON public.admin_finance_evidence_unavailable_records;
CREATE POLICY "admin finance evidence unavailable manage insert" ON public.admin_finance_evidence_unavailable_records
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('admin.finance.manage'));
CREATE POLICY "admin finance evidence unavailable manage update" ON public.admin_finance_evidence_unavailable_records
  FOR UPDATE TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));
CREATE POLICY "admin finance evidence unavailable manage delete" ON public.admin_finance_evidence_unavailable_records
  FOR DELETE TO authenticated
  USING (public.has_permission('admin.finance.manage'));

DROP POLICY "admin finance summary options manage" ON public.admin_finance_summary_options;
CREATE POLICY "admin finance summary options manage insert" ON public.admin_finance_summary_options
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission('admin.finance.manage'));
CREATE POLICY "admin finance summary options manage update" ON public.admin_finance_summary_options
  FOR UPDATE TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));
CREATE POLICY "admin finance summary options manage delete" ON public.admin_finance_summary_options
  FOR DELETE TO authenticated
  USING (public.has_permission('admin.finance.manage'));

COMMIT;
