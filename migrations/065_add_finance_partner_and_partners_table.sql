-- ============================================================
-- 065: Add 取引先 (business partner) to finance expenses
--      + global partner master table for the admin dashboard
-- ============================================================

BEGIN;

-- 取引先 column on expenses. Defaults to '' so existing rows stay valid.
ALTER TABLE public.admin_finance_expenses
  ADD COLUMN IF NOT EXISTS partner text NOT NULL DEFAULT '' CHECK (char_length(partner) <= 160);

-- Global (season-independent) master of registered business partners.
CREATE TABLE IF NOT EXISTS public.admin_finance_partners (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 160),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trigger_admin_finance_partners_updated_at ON public.admin_finance_partners;
CREATE TRIGGER trigger_admin_finance_partners_updated_at
  BEFORE UPDATE ON public.admin_finance_partners
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

ALTER TABLE public.admin_finance_partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance partners read" ON public.admin_finance_partners;
CREATE POLICY "admin finance partners read"
  ON public.admin_finance_partners
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance partners manage" ON public.admin_finance_partners;
CREATE POLICY "admin finance partners manage"
  ON public.admin_finance_partners
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

COMMIT;
