-- ============================================================
-- 062: Cost & Profit accounting data for the admin dashboard
-- ============================================================

BEGIN;

-- Finance permissions are admin-only.
INSERT INTO public.permissions(code, name)
VALUES
  ('admin.finance.read', 'Read finance and accounting data'),
  ('admin.finance.manage', 'Manage finance and accounting data')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.role_permissions(role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.code IN ('admin.finance.read', 'admin.finance.manage')
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.admin_finance_seasons (
  season_key text PRIMARY KEY CHECK (season_key ~ '^[0-9]{4}(SS|AW)$'),
  sales_revenue bigint NOT NULL DEFAULT 0 CHECK (sales_revenue >= 0),
  opening_cash bigint NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  accounts_receivable bigint NOT NULL DEFAULT 0 CHECK (accounts_receivable >= 0),
  fixed_assets bigint NOT NULL DEFAULT 0 CHECK (fixed_assets >= 0),
  accounts_payable bigint NOT NULL DEFAULT 0 CHECK (accounts_payable >= 0),
  opening_capital bigint NOT NULL DEFAULT 0 CHECK (opening_capital >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_finance_expenses (
  id bigserial PRIMARY KEY,
  season_key text NOT NULL REFERENCES public.admin_finance_seasons(season_key) ON DELETE CASCADE,
  expense_date date NOT NULL,
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 80),
  item_name text NOT NULL CHECK (char_length(item_name) BETWEEN 1 AND 160),
  amount bigint NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (char_length(payment_method) BETWEEN 1 AND 80),
  memo text NOT NULL DEFAULT '' CHECK (char_length(memo) <= 500),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_finance_expenses_season_date
  ON public.admin_finance_expenses(season_key, expense_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.admin_product_costs (
  season_key text NOT NULL REFERENCES public.admin_finance_seasons(season_key) ON DELETE CASCADE,
  sku text NOT NULL CHECK (char_length(sku) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 80),
  production_method text NOT NULL CHECK (char_length(production_method) BETWEEN 1 AND 80),
  planned_quantity integer NOT NULL DEFAULT 0 CHECK (planned_quantity >= 0),
  selling_price bigint NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  material_cost bigint NOT NULL DEFAULT 0 CHECK (material_cost >= 0),
  sewing_cost bigint NOT NULL DEFAULT 0 CHECK (sewing_cost >= 0),
  pattern_cost bigint NOT NULL DEFAULT 0 CHECK (pattern_cost >= 0),
  accessories_cost bigint NOT NULL DEFAULT 0 CHECK (accessories_cost >= 0),
  processing_cost bigint NOT NULL DEFAULT 0 CHECK (processing_cost >= 0),
  finishing_cost bigint NOT NULL DEFAULT 0 CHECK (finishing_cost >= 0),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season_key, sku)
);

CREATE INDEX IF NOT EXISTS idx_admin_product_costs_season
  ON public.admin_product_costs(season_key);

CREATE OR REPLACE FUNCTION public.update_admin_finance_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_admin_finance_seasons_updated_at ON public.admin_finance_seasons;
CREATE TRIGGER trigger_admin_finance_seasons_updated_at
  BEFORE UPDATE ON public.admin_finance_seasons
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

DROP TRIGGER IF EXISTS trigger_admin_finance_expenses_updated_at ON public.admin_finance_expenses;
CREATE TRIGGER trigger_admin_finance_expenses_updated_at
  BEFORE UPDATE ON public.admin_finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

DROP TRIGGER IF EXISTS trigger_admin_product_costs_updated_at ON public.admin_product_costs;
CREATE TRIGGER trigger_admin_product_costs_updated_at
  BEFORE UPDATE ON public.admin_product_costs
  FOR EACH ROW EXECUTE FUNCTION public.update_admin_finance_updated_at();

ALTER TABLE public.admin_finance_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_finance_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_product_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin finance seasons read" ON public.admin_finance_seasons;
CREATE POLICY "admin finance seasons read"
  ON public.admin_finance_seasons
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance seasons manage" ON public.admin_finance_seasons;
CREATE POLICY "admin finance seasons manage"
  ON public.admin_finance_seasons
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

DROP POLICY IF EXISTS "admin finance expenses read" ON public.admin_finance_expenses;
CREATE POLICY "admin finance expenses read"
  ON public.admin_finance_expenses
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin finance expenses manage" ON public.admin_finance_expenses;
CREATE POLICY "admin finance expenses manage"
  ON public.admin_finance_expenses
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

DROP POLICY IF EXISTS "admin product costs read" ON public.admin_product_costs;
CREATE POLICY "admin product costs read"
  ON public.admin_product_costs
  FOR SELECT TO authenticated
  USING (public.has_permission('admin.finance.read'));

DROP POLICY IF EXISTS "admin product costs manage" ON public.admin_product_costs;
CREATE POLICY "admin product costs manage"
  ON public.admin_product_costs
  FOR ALL TO authenticated
  USING (public.has_permission('admin.finance.manage'))
  WITH CHECK (public.has_permission('admin.finance.manage'));

COMMIT;
