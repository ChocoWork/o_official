-- ============================================================
-- 037: Add admin RLS policies for orders and order_items
-- ============================================================

BEGIN;

-- Orders: allow authenticated admins/supporters with permission to read orders
DROP POLICY IF EXISTS "admin orders read by permission" ON public.orders;
CREATE POLICY "admin orders read by permission" ON public.orders
  FOR SELECT
  TO authenticated
  USING (
    public.has_permission('admin.orders.read')
    OR (
      (auth.uid() IS NOT NULL AND auth.uid() = user_id)
      OR session_id = current_setting('app.session_id', true)
    )
  );

-- Orders: allow authenticated admins/supporters with manage permission to modify orders
DROP POLICY IF EXISTS "admin orders manage by permission" ON public.orders;
CREATE POLICY "admin orders manage by permission" ON public.orders
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.orders.manage'))
  WITH CHECK (public.has_permission('admin.orders.manage'));

-- Order items: allow authenticated admins/supporters with order read permission, or the owning customer via parent order access
DROP POLICY IF EXISTS "admin order items read by permission" ON public.order_items;
CREATE POLICY "admin order items read by permission" ON public.order_items
  FOR SELECT
  TO authenticated
  USING (
    public.has_permission('admin.orders.read')
    OR EXISTS (
      SELECT 1
      FROM public.orders o
      WHERE o.id = order_id
        AND (
          (auth.uid() IS NOT NULL AND auth.uid() = o.user_id)
          OR o.session_id = current_setting('app.session_id', true)
        )
    )
  );

-- Order items: allow authenticated admins/supporters with manage permission to modify order items
DROP POLICY IF EXISTS "admin order items manage by permission" ON public.order_items;
CREATE POLICY "admin order items manage by permission" ON public.order_items
  FOR ALL
  TO authenticated
  USING (public.has_permission('admin.orders.manage'))
  WITH CHECK (public.has_permission('admin.orders.manage'));

COMMIT;
